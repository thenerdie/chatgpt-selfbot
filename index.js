require('dotenv').config()

const { Client } = require('discord.js-selfbot-v13');
const client = new Client({
	// See other options here
	// https://discordjs-self-v13.netlify.app/#/docs/docs/main/typedef/ClientOptions
	// All partials are loaded automatically
});

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

        let systemMessage = `You are a being used as part of a Discord bot. Here is the user's Discord information in JSON format: ${JSON.stringify(message.author.toJSON())}. When embedding formatted code blocks, specify the file extension of language used after the "\`\`\`". For instance, if you're embedding JavaScript, you would format the code block like \`\`\`js.`

        if (!conversation) {
            conversation = [ { role: "system", content: systemMessage }, { role: "user", content: message.content } ]
            ongoingConversations[message.author.id] = conversation
        } else {
            conversation.push({ role: "user", content: message.content })
        }

        const completion = await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: conversation,
        });

        const reply = completion.data.choices[0].message

        conversation.push({ role: "assistant", content: reply.content })

        message.reply(reply)
    }
})

client.login(process.env.DISCORD_TOKEN);