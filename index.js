require('dotenv').config()

const { Client } = require('discord.js-selfbot-v13');
const client = new Client({
	// See other options here
	// https://discordjs-self-v13.netlify.app/#/docs/docs/main/typedef/ClientOptions
	// All partials are loaded automatically
});

// Imports the Google Cloud client library
const vision = require('@google-cloud/vision');

const projectId = "chatgpt-selfbot"
// Creates a client
const imageAnnotatorClient = new vision.ImageAnnotatorClient({ projectId });

async function annotateImage(url) {
    // Performs label detection on the image file
    let [ result ] = await imageAnnotatorClient.batchAnnotateImages({
        requests: [
            {
                image: {
                    source: { imageUri: url }
                },
                features: [
                    {
                        "type": "TEXT_DETECTION"
                    },
                    {
                        "type": "IMAGE_PROPERTIES"
                    },
                    {
                        "type": "LABEL_DETECTION",
                        "maxResults": 6
                    },
                    {
                        "type": "WEB_DETECTION",
                        "maxResults": 2
                    }
                ]
            }
        ]
    });

    result = result.responses[0]
    
    delete result.cropHintsAnnotation
    delete result.fullTextAnnotation

    for (let label of result.labelAnnotations) {
        delete label.boundingPoly
    }

    for (let label of result.textAnnotations) {
        delete label.boundingPoly
    }

    result.textAnnotations = result.textAnnotations ? result.textAnnotations[0] : undefined

    console.log(JSON.stringify(result))

    return result
}

annotateImage("https://cdn.discordapp.com/attachments/799034034377719849/1090156523159826442/IMG_20221219_172651_172.png")

const { Configuration, OpenAIApi } = require("openai");

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});

const openai = new OpenAIApi(configuration);

let ongoingConversations = {}

client.on('ready', async () => {
  console.log(`${client.user.username} is ready!`);
})

client.on("message", async message => {
    if (message.channel.type == "DM" && message.author.id != client.user.id) {
        message.channel.sendTyping()

        let conversation = ongoingConversations[message.author.id]

        let systemMessage = `You are a being used as part of a Discord bot. Here is the user's (the person you are talking to) Discord information in JSON format: ${JSON.stringify(message.author.toJSON())}. When embedding formatted code blocks, specify the file extension of language used after the "\`\`\`". For instance, if you're embedding JavaScript, you would format the code block like \`\`\`js. ` +
            `This is the JSON info of the Discord account you are running on: ${JSON.stringify(client.user.toJSON())}.\n` +
            "The user can upload files, and information about such files will be given to you. When describing an attachment, do not directly refer to the JSON annotations, or the API that was used to generate such annotations. Do not refer to the user in third-person, or as \"the user\"."

        let messageContent = message.content

        const attachments = message.attachments

        if (attachments.size > 0) {
            messageContent += "\n\n***SYSTEM MESSAGE*** " +
                `The user has attached files. Information about each of the files is listed below:\n`

            let fileCount = 0
            
            for (key of attachments.keys()) {
                fileCount++

                const attachment = attachments.get(key)

                let annotation

                try {
                    annotation = await annotateImage(attachment.url)
                } catch (e) {
                    console.log(`Error annotating image ${attachment.url}! ${e}`)
                }

                messageContent += `File #${fileCount}: Here is JSON data describing the file: ${JSON.stringify(attachment.toJSON())}. Here is annotated information about the image: ${JSON.stringify(annotation)}.`
            }
        }

        console.log(`${message.author.tag}: ${messageContent}`)

        if (!conversation) {
            conversation = [ { role: "system", content: systemMessage }, { role: "user", content: messageContent } ]
            ongoingConversations[message.author.id] = conversation
        } else {
            conversation.push({ role: "user", content: messageContent })
        }

        const completion = await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: conversation,
        });

        const reply = completion.data.choices[0].message

        console.log(`${client.user.tag}: ${reply.content}`)

        conversation.push({ role: "assistant", content: reply.content })

        message.reply(reply)
    }
})

client.login(process.env.DISCORD_TOKEN);