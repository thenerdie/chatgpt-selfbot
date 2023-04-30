require('dotenv').config()

const axios = require("axios")
const fs = require("fs")
const { v4: uuidv4 } = require('uuid');

// list of valid content types to embed when the user provides a link
const VALID_CONTENT_TYPES = [
    "application/json",
    "application/xml",
    "text/plain"
]

const { Client } = require('discord.js-selfbot-v13');
const client = new Client({
    // See other options here
	// https://discordjs-self-v13.netlify.app/#/docs/docs/main/typedef/ClientOptions
	// All partials are loaded automatically
});

// Imports the Google Cloud client library
const vision = require('@google-cloud/vision');
const speech = require('@google-cloud/speech');
const { Storage } = require('@google-cloud/storage');

const projectId = "chatgpt-selfbot"
// Creates a client
const imageAnnotatorClient = new vision.ImageAnnotatorClient({ projectId });
const speechClient = new speech.SpeechClient();
const storageClient = new Storage({ projectId: process.env.STORAGE_PROJECT_ID })

function pipeToWriteStream(data, filePath) {
    return new Promise(resolve => {
        data.pipe(fs.createWriteStream(filePath)).on("finish", _ => {
            resolve()
        })
    })
}

async function downloadFile(fileUrl) {
    const fileName = `${uuidv4()}.ogg`
    const filePath = `tmp/${fileName}`

    const { data } = await axios({
        method: 'get',
        url: fileUrl,
        responseType: 'stream', // Set the response type to 'stream'
    })

    await pipeToWriteStream(data, filePath)

    console.log(`File downloaded to ${filePath}`);

    return [ fileName, filePath ]
}

async function uploadRemoteFileToBucket(uri, bucketName) {
    const [ fileName, localFilePath ] = await downloadFile(uri)

    await storageClient.bucket(bucketName).upload(localFilePath, {
        metadata: {
            cacheControl: 'public, max-age=31536000',
        },
    });

    console.log(`${localFilePath} uploaded to ${bucketName}.`);

    fs.rmSync(localFilePath)

    return `gs://${process.env.STORAGE_BUCKET_NAME}/${fileName}`;
}

async function summarizeImage(url) {
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

    const summary = await createChatCompletion([ { role: "user", content: "Summarize this image:\n\n" + JSON.stringify(result) } ])

    return summary.data.choices[0].message.content
}

async function getTextFromAudio(uri) {
    const gcsPath = await uploadRemoteFileToBucket(uri, process.env.STORAGE_BUCKET_NAME)

    // The audio file's encoding, sample rate in hertz, and BCP-47 language code
    const audio = {
        uri: gcsPath
    };

    const config = {
        encoding: "OGG_OPUS",
        sampleRateHertz: 48000,
        languageCode: 'en-US',
    }
    const request = {
        audio: audio,
        config: config,
    };

    // Detects speech in the audio file
    const [ response ] = await speechClient.recognize(request);
    const transcription = response.results
        .map(result => result.alternatives[0].transcript)
        .join('\n');

    console.log(`Transcription: ${transcription}`);

    return transcription
}

async function createChatCompletion(conversation) {
    try {
        return await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: conversation,
        })
    } catch {
        throw new Error("Completion failed!")
    }
}

const { Configuration, OpenAIApi } = require("openai");

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});

const openai = new OpenAIApi(configuration);

let ongoingConversations = {}

client.on('ready', async () => {
  console.log(`${client.user.username} is ready!`);
})

let lastTokens = 0

function splitStringIntoChunks(str, chunkSize) {
    const chunks = [];
  
    for (let i = 0; i < str.length; i += chunkSize) {
        const chunk = str.substring(i, chunkSize * (i + 1));
        chunks.push(chunk);
    }
  
    return chunks;
}

client.on("messageCreate", async message => {    
    if (message.channel.type == "DM" && message.author.id != client.user.id) {
        message.channel.sendTyping()

        let conversation = ongoingConversations[message.author.id]

        let baseSystemMessage = `You are a being used as part of a Discord bot. You are an assistant who talks to the user. Here is the user's (the person you are talking to) Discord information in JSON format: ${JSON.stringify(message.author.toJSON())}. When embedding formatted code blocks, specify the file extension of language used after the "\`\`\`". For instance, if you're embedding JavaScript, you would format the code block like \`\`\`js. ` +
            `This is the JSON info of the Discord account you are running on: ${JSON.stringify(client.user.toJSON())}.\n` +
            "The user can upload files, and information about such files will be given to you." +
            "When describing an attachment, do not directly refer to the annotations themselves, or the API that was used to generate such annotations." +
            "Summarize the image like a human would, describing recognizable objects in the image, main colors, and any other relevant information." +
            "Do not refer to the user in third-person, or as \"the user\"." +
            "Talk to the user in a text-message fashion, using informal language." +
            "Any message beginning with |SYSTEM| is a system message."

        let messageContent = message.content

        const links = messageContent.matchAll(/(gm)?\bhttps?:\S+/g)

        for (const match of links) {
            try {
                const link = match[0]
                const { data, headers } = await axios.get(link)

                console.log(headers)

                let valid = false

                let contentType = headers["content-type"] || headers["Content-Type"]

                for (const type of VALID_CONTENT_TYPES) {
                    if (contentType.startsWith(type)) {
                        valid = true
                        break
                    }
                }

                if (valid)
                    messageContent = `|SYSTEM|The user has embedded a link (url=${link}). The content is as follows:\n\n` + messageContent.replace(link, JSON.stringify(data) || data.toString())
            } catch {
                console.log("Could not embed link: " + match[0])
            }
        }

        const attachments = message.attachments

        if (attachments.size > 0) {
            messageContent += "\n\n|SYSTEM|The user has attached files. Information about each of the files is listed below:\n\n"

            let fileCount = 0
            
            for await (key of attachments.keys()) {
                fileCount++

                const attachment = attachments.get(key)

                let annotation

                try {
                    if (attachment.name === "voice-message.ogg") {
                        const transcription = await getTextFromAudio(attachment.url)

                        // if we hit a voice message, we just send the content of the voice message to the AI and disregard everything else
                        messageContent = transcription
                        break
                    } else {
                        annotation = await summarizeImage(attachment.url)
                    }
                } catch (e) {
                    console.log(`Error annotating image ${attachment.url}! ${e}`)
                }

                messageContent += `File #${fileCount}: Here is JSON data describing the file: ${JSON.stringify(attachment.toJSON())}. Here is a summary of the contents of the file: ${JSON.stringify(annotation)}.`
            }
        }

        console.log(`${message.author.tag}: ${messageContent}`)

        let systemMessage = baseSystemMessage

        // now we want to summarize the conversation to keep the message history under the token limit, if needed
        if (lastTokens > 3700) {
            console.log("CONVERSATION IS BEING SUMMARIZED!")

            // conversation.pop()

            let serializedConversation = ""

            for (let message of conversation) {
                serializedConversation += `${message.role}: ${message.content}\n`
            }

            const summary = await createChatCompletion([ { role: "user", content: "Summarize this conversation in as much detail as possible without exceeding 5 paragraphs, including any information the user requested in the last message:\n\n" + serializedConversation } ])

            console.log(summary)

            systemMessage += "\n\nThis is a summary of the conversation thus far:\n\n" +
                summary.data.choices[0].message.content

            console.log("SUMMARY:\n\n" + systemMessage)

            conversation = null
        }

        if (!conversation) {
            conversation = [ { role: "system", content: systemMessage }, { role: "user", content: messageContent } ]
            ongoingConversations[message.author.id] = conversation
        } else {
            conversation.push({ role: "user", content: messageContent })
        }

        try {
            const completion = await createChatCompletion(conversation);
            const reply = completion.data.choices[0].message

            console.log(`${client.user.tag}: ${reply.content}`)

            conversation.push({ role: "assistant", content: reply.content })

            for (let chunk of splitStringIntoChunks(reply.content, 2000)) {
                await message.channel.send(chunk)
            }

            lastTokens = completion.data.usage.total_tokens

            console.log(`CURRENT TOKENS: ${lastTokens}`)
        } catch(e) {
            console.log(`ERROR: ${e}`)

            message.channel.send("`Whoops... There was an error generating a response to that. Sorry!`")
        }
    }
})

client.login(process.env.DISCORD_TOKEN);