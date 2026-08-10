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

// System prompt for the AI persona
const systemInstruction = `You are a professional, helpful, and friendly sales assistant for an individual business. 
Your goal is to answer customer queries accurately, generate sales presence, and be as helpful as possible. 
You can communicate fluently in any language the customer uses. Keep your answers concise, engaging, and suitable for a WhatsApp conversation (use emojis appropriately).`;

let activeModelName = null;

async function getBestModelName() {
  if (activeModelName) return activeModelName;
  try {
    // Dynamically fetch the list of available models for this specific API key
    const response = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
    const models = response.data.models;
    
    // Find the first model that supports generateContent (preferring flash or pro)
    let bestModel = models.find(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent') && m.name.includes('flash'));
    if (!bestModel) {
      bestModel = models.find(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent') && m.name.includes('pro'));
    }
    if (!bestModel && models.length > 0) {
       bestModel = models.find(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'));
    }
    
    activeModelName = bestModel.name.replace('models/', '');
    console.log("Dynamically selected Gemini Model:", activeModelName);
    return activeModelName;
  } catch (err) {
    console.error("Failed to fetch models list. Is your API key valid? Error:", err.message);
    return "gemini-1.5-flash";
  }
}

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
      const from = body.entry[0].changes[0].value.messages[0].from; 
      const msgBody = body.entry[0].changes[0].value.messages[0].text ? body.entry[0].changes[0].value.messages[0].text.body : "Received a non-text message";

      console.log(`Received message: "${msgBody}" from ${from}`);
      res.sendStatus(200); // Acknowledge receipt immediately to Meta

      try {
        console.log('Thinking...');
        
        const modelName = await getBestModelName();
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: modelName });

        const chat = model.startChat({
          history: [
            { role: "user", parts: [{ text: systemInstruction }] },
            { role: "model", parts: [{ text: "Understood." }] },
          ]
        });
        
        const result = await chat.sendMessage(msgBody);
        const aiResponse = result.response.text();
        console.log(`AI Response: ${aiResponse}`);

        await axios({
          method: 'POST',
          url: `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
          headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json',
          },
          data: {
            messaging_product: 'whatsapp',
            to: from,
            type: 'text',
            text: { body: aiResponse },
          },
        });
        console.log('Reply sent successfully!');
      } catch (error) {
        console.error('Error processing AI response or sending message:', error.message);
      }
      return; 
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
