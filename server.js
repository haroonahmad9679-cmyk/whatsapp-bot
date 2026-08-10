require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'my_super_secret_token';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// System prompt for the AI persona
const systemInstruction = `You are a professional, helpful, and friendly sales assistant for an individual business. 
Your goal is to answer customer queries accurately, generate sales presence, and be as helpful as possible. 
You can communicate fluently in any language the customer uses. Keep your answers concise, engaging, and suitable for a WhatsApp conversation (use emojis appropriately).`;

// Webhook verification (GET endpoint)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.status(400).send('Missing mode or token');
  }
});

// Receiving messages (POST endpoint)
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object) {
    if (
      body.entry &&
      body.entry[0].changes &&
      body.entry[0].changes[0] &&
      body.entry[0].changes[0].value.messages &&
      body.entry[0].changes[0].value.messages[0]
    ) {
      const phoneNumberId = body.entry[0].changes[0].value.metadata.phone_number_id;
      const from = body.entry[0].changes[0].value.messages[0].from; // sender's phone number
      const msgBody = body.entry[0].changes[0].value.messages[0].text.body; // text content

      console.log(`Received message: "${msgBody}" from ${from}`);

      // Acknowledge receipt immediately to Meta to prevent timeouts
      res.sendStatus(200);

      try {
        // 1. Send the message to Gemini AI
        console.log('Thinking...');
        const chat = model.startChat({
          history: [
            {
              role: "user",
              parts: [{ text: systemInstruction }],
            },
            {
              role: "model",
              parts: [{ text: "Understood. I will act as the sales assistant." }],
            },
          ]
        });
        
        const result = await chat.sendMessage(msgBody);
        const aiResponse = result.response.text();
        console.log(`AI Response: ${aiResponse}`);

        // 2. Send the AI response back to the user via WhatsApp API
        await axios({
          method: 'POST',
          url: `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
          headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json',
          },
          data: {
            messaging_product: 'whatsapp',
            to: from,
            type: 'text',
            text: {
              body: aiResponse,
            },
          },
        });
        
        console.log('Reply sent successfully!');

      } catch (error) {
        console.error('Error processing AI response or sending message:', error.message);
      }
      return; // already sent status 200
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
