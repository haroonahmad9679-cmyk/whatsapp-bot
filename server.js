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

const systemInstruction = `You are a professional, helpful, and friendly sales assistant for an individual business. 
Your goal is to answer customer queries accurately, generate sales presence, and be as helpful as possible. 
You can communicate fluently in any language the customer uses. Keep your answers concise, engaging, and suitable for a WhatsApp conversation (use emojis appropriately).`;

let cachedModels = [];

async function getValidModelsList() {
  if (cachedModels.length > 0) return cachedModels;
  try {
    const response = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
    const models = response.data.models;
    
    // Filter for models that support text generation
    const valid = models.filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'));
    
    // Extract names and prioritize "flash" models as they are fastest
    cachedModels = valid.map(m => m.name.replace('models/', '')).sort((a, b) => {
      if (a.includes('flash') && !b.includes('flash')) return -1;
      if (!a.includes('flash') && b.includes('flash')) return 1;
      return 0;
    });
    
    console.log("Found these potential AI models to try:", cachedModels);
    return cachedModels;
  } catch (err) {
    console.error("Failed to fetch models list.", err.message);
    return ["gemini-1.5-flash", "gemini-pro"]; // basic fallbacks
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
        
        const modelsToTry = await getValidModelsList();
        let aiResponse = null;

        // Try every single model until one works
        for (const modelName of modelsToTry) {
          try {
            console.log(`Attempting to use model: ${modelName}`);
            const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
            const model = genAI.getGenerativeModel({ model: modelName });

            const chat = model.startChat({
              history: [
                { role: "user", parts: [{ text: systemInstruction }] },
                { role: "model", parts: [{ text: "Understood." }] },
              ]
            });
            
            const result = await chat.sendMessage(msgBody);
            aiResponse = result.response.text();
            console.log(`Success! Working model found: ${modelName}`);
            break; // Stop looping once we get a successful response
          } catch (e) {
            console.log(`Model ${modelName} rejected the request. Trying the next one...`);
          }
        }

        if (!aiResponse) {
          throw new Error("All available Gemini models failed to process the request.");
        }

        console.log(`AI Response: ${aiResponse}`);

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
            text: { body: aiResponse },
          },
        });
        console.log('Reply sent successfully!');
      } catch (error) {
        console.error('Error processing AI response or sending message:', error.message);
        if (error.response && error.response.data) {
          console.error('Meta API Error Details:', JSON.stringify(error.response.data, null, 2));
        }
      }
      return; 
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// Force-Test Endpoint to bypass broken inbound webhooks
app.get('/force-test', async (req, res) => {
  const targetPhone = req.query.phone;
  if (!targetPhone) {
    return res.send("Error: Please add your phone number to the URL like this: /force-test?phone=1234567890 (include country code, no plus sign)");
  }
  
  // Use the Phone Number ID from your Meta screenshot
  const phoneNumberId = "1162096826996318"; 
  const msgBody = "Hello! Introduce yourself briefly as my new AI assistant.";
  
  try {
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
    
    await axios({
      method: 'POST',
      url: `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      data: {
        messaging_product: 'whatsapp',
        to: targetPhone,
        type: 'text',
        text: { body: aiResponse },
      },
    });
    
    res.send(`<h1>Success!</h1><p>I just forced the AI to send a message to ${targetPhone}. Check your WhatsApp!</p>`);
  } catch (err) {
    if (err.response && err.response.data) {
       res.send(`<h1>Meta API Error</h1><pre>${JSON.stringify(err.response.data, null, 2)}</pre>`);
    } else {
       res.send(`<h1>Error</h1><p>${err.message}</p>`);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
