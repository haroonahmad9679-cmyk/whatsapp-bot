require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(bodyParser.json());

// Serve the frontend dashboard (files are in root)
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/style.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'style.css'));
});
app.get('/script.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'script.js'));
});

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'my_super_secret_token';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Initialize SQLite Database
const db = new sqlite3.Database('./chatbot.db', (err) => {
  if (err) {
    console.error('Error opening database', err.message);
  } else {
    console.log('Connected to the SQLite database.');
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT,
      direction TEXT,
      message TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
});

// Helper function to log messages to the database
function logMessage(phone_number, direction, message) {
  db.run(`INSERT INTO messages (phone_number, direction, message) VALUES (?, ?, ?)`, 
    [phone_number, direction, message], function(err) {
      if (err) console.error("DB Error:", err.message);
  });
}

// System prompt for the AI persona
const systemInstruction = `You are a professional, helpful, and friendly sales assistant for an individual business. 
Your goal is to answer customer queries accurately, generate sales presence, and be as helpful as possible. 
You can communicate fluently in any language the customer uses. Keep your answers concise, engaging, and suitable for a WhatsApp conversation (use emojis appropriately).`;

let cachedModels = [];

async function getValidModelsList() {
  if (cachedModels.length > 0) return cachedModels;
  try {
    const response = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
    const models = response.data.models;
    const valid = models.filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'));
    cachedModels = valid.map(m => m.name.replace('models/', '')).sort((a, b) => {
      if (a.includes('flash') && !b.includes('flash')) return -1;
      if (!a.includes('flash') && b.includes('flash')) return 1;
      return 0;
    });
    return cachedModels;
  } catch (err) {
    return ["gemini-1.5-flash", "gemini-pro"]; 
  }
}

// -----------------------------------------
// DASHBOARD API ENDPOINTS
// -----------------------------------------

// Get list of all phone numbers that have messaged us
app.get('/api/chats', (req, res) => {
  db.all(`SELECT DISTINCT phone_number FROM messages ORDER BY timestamp DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Get chat history for a specific number
app.get('/api/chats/:number', (req, res) => {
  db.all(`SELECT * FROM messages WHERE phone_number = ? ORDER BY timestamp ASC`, [req.params.number], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Manually send a message from the dashboard
app.post('/api/send', async (req, res) => {
  const { to, message } = req.body;
  
  if (!to || !message) return res.status(400).json({ error: "Missing to or message" });

  try {
    // Note: We need a valid Phone Number ID. For now, we assume the bot uses a single Phone Number ID 
    // that we can either get from env or hardcode from the previous tests.
    const phoneNumberId = process.env.PHONE_NUMBER_ID || "1162096826996318";

    await axios({
      method: 'POST',
      url: `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      data: {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: message },
      },
    });

    logMessage(to, 'manual', message);
    res.json({ success: true });
  } catch (err) {
    console.error("Dashboard send error:", err.message);
    res.status(500).json({ error: err.message });
  }
});


// -----------------------------------------
// WHATSAPP WEBHOOK ENDPOINTS
// -----------------------------------------

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.status(400).send('Missing mode or token');
  }
});

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

      res.sendStatus(200); 
      logMessage(from, 'inbound', msgBody);

      try {
        const modelsToTry = await getValidModelsList();
        let aiResponse = null;

        for (const modelName of modelsToTry) {
          try {
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
            break; 
          } catch (e) {
            // Try next model
          }
        }

        if (!aiResponse) {
          throw new Error("All available Gemini models failed.");
        }

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
        
        logMessage(from, 'outbound', aiResponse);

      } catch (error) {
        console.error('Error processing AI:', error.message);
      }
      return; 
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// Force-Test Endpoint
app.get('/force-test', async (req, res) => {
  const targetPhone = req.query.phone;
  if (!targetPhone) {
    return res.send("Error: Please add your phone number to the URL like this: /force-test?phone=1234567890");
  }
  
  const phoneNumberId = process.env.PHONE_NUMBER_ID || "1162096826996318"; 
  const msgBody = "Hello! Introduce yourself briefly as my new AI assistant.";
  
  try {
    const modelsToTry = await getValidModelsList();
    let aiResponse = null;

    for (const modelName of modelsToTry) {
      try {
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
        break; 
      } catch (e) {}
    }

    if (!aiResponse) throw new Error("All AI models failed.");
    
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
    
    logMessage(targetPhone, 'outbound', aiResponse);
    res.send(`<h1>Success!</h1><p>I just forced the AI to send a message to ${targetPhone}.</p>`);
  } catch (err) {
    res.send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
