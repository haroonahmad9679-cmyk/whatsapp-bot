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

// Initialize SQLite Database with New Tables
const db = new sqlite3.Database('./chatbot.db', (err) => {
  if (err) {
    console.error('Error opening database', err.message);
  } else {
    console.log('Connected to the SQLite database.');
    db.serialize(() => {
      // 1. Messages Table
      db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_number TEXT,
        direction TEXT,
        message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      
      // 2. Contacts Table
      db.run(`CREATE TABLE IF NOT EXISTS contacts (
        phone_number TEXT PRIMARY KEY,
        name TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      
      // 3. Appointments Table
      db.run(`CREATE TABLE IF NOT EXISTS appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_number TEXT,
        appointment_date DATETIME,
        reason TEXT,
        reminder_sent INTEGER DEFAULT 0
      )`);
      
      // 4. Settings Table
      db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )`);
      
      // Insert default system prompt if it doesn't exist
      const defaultPrompt = `You are a professional, helpful, and friendly sales assistant for an individual business. 
Your goal is to answer customer queries accurately, generate sales presence, and be as helpful as possible. 
You can communicate fluently in any language the customer uses. Keep your answers concise, engaging, and suitable for a WhatsApp conversation (use emojis appropriately).`;
      db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('system_prompt', ?)`, [defaultPrompt]);
    });
  }
});

// Helper functions
function logMessage(phone_number, direction, message) {
  db.run(`INSERT INTO messages (phone_number, direction, message) VALUES (?, ?, ?)`, 
    [phone_number, direction, message]);
  // Also ensure contact exists
  db.run(`INSERT OR IGNORE INTO contacts (phone_number, name, notes) VALUES (?, '', '')`, [phone_number]);
}

function getSystemPrompt() {
  return new Promise((resolve, reject) => {
    db.get(`SELECT value FROM settings WHERE key = 'system_prompt'`, (err, row) => {
      if (err || !row) resolve("You are a helpful AI assistant.");
      else resolve(row.value);
    });
  });
}

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
// DASHBOARD API ENDPOINTS (5 TABS)
// -----------------------------------------

// Tab 1: Analytics
app.get('/api/stats', (req, res) => {
  const stats = {};
  db.get(`SELECT COUNT(*) as count FROM messages`, (err, row) => {
    stats.total_messages = row ? row.count : 0;
    db.get(`SELECT COUNT(*) as count FROM contacts`, (err, row) => {
      stats.total_contacts = row ? row.count : 0;
      db.get(`SELECT COUNT(*) as count FROM appointments`, (err, row) => {
        stats.total_appointments = row ? row.count : 0;
        res.json(stats);
      });
    });
  });
});

// Tab 2: Inbox (Chats)
app.get('/api/chats', (req, res) => {
  db.all(`SELECT c.phone_number, c.name, (SELECT message FROM messages WHERE phone_number = c.phone_number ORDER BY timestamp DESC LIMIT 1) as last_message FROM contacts c ORDER BY c.created_at DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/chats/:number', (req, res) => {
  db.all(`SELECT * FROM messages WHERE phone_number = ? ORDER BY timestamp ASC`, [req.params.number], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/send', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: "Missing to or message" });

  try {
    const phoneNumberId = process.env.PHONE_NUMBER_ID || "1162096826996318";
    await axios({
      method: 'POST',
      url: `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      data: { messaging_product: 'whatsapp', to: to, type: 'text', text: { body: message } },
    });
    logMessage(to, 'manual', message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tab 3: Contacts CRM
app.get('/api/contacts', (req, res) => {
  db.all(`SELECT * FROM contacts ORDER BY created_at DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/contacts', (req, res) => {
  const { phone_number, name, notes } = req.body;
  if (!phone_number) return res.status(400).json({ error: "Missing phone number" });
  
  db.run(`INSERT INTO contacts (phone_number, name, notes) VALUES (?, ?, ?)
          ON CONFLICT(phone_number) DO UPDATE SET name=excluded.name, notes=excluded.notes`, 
          [phone_number, name || '', notes || ''], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
  });
});

// Tab 4: Appointments
app.get('/api/appointments', (req, res) => {
  db.all(`SELECT * FROM appointments ORDER BY appointment_date ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/appointments', (req, res) => {
  const { phone_number, appointment_date, reason } = req.body;
  if (!phone_number || !appointment_date) return res.status(400).json({ error: "Missing data" });
  
  db.run(`INSERT INTO appointments (phone_number, appointment_date, reason) VALUES (?, ?, ?)`, 
          [phone_number, appointment_date, reason || ''], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
  });
});

// Tab 5: Settings
app.get('/api/settings', (req, res) => {
  getSystemPrompt().then(prompt => res.json({ system_prompt: prompt }));
});

app.post('/api/settings', (req, res) => {
  const { system_prompt } = req.body;
  if (!system_prompt) return res.status(400).json({ error: "Missing prompt" });
  db.run(`UPDATE settings SET value = ? WHERE key = 'system_prompt'`, [system_prompt], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});


// -----------------------------------------
// AUTOMATED APPOINTMENT REMINDERS (CRON)
// -----------------------------------------
setInterval(async () => {
  // Check for appointments in the next 24 hours where reminder hasn't been sent
  const twentyFourHoursFromNow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  
  db.all(`SELECT * FROM appointments WHERE appointment_date > ? AND appointment_date <= ? AND reminder_sent = 0`, 
    [now, twentyFourHoursFromNow], async (err, rows) => {
      if (err || !rows) return;
      
      for (const appt of rows) {
        try {
           const modelsToTry = await getValidModelsList();
           let reminderText = null;
           for (const modelName of modelsToTry) {
             try {
               const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
               const model = genAI.getGenerativeModel({ model: modelName });
               const prompt = `You are a helpful assistant. Generate a short, polite appointment reminder for the customer. 
The appointment is for: ${appt.reason}. The time is: ${appt.appointment_date}. 
Write the message in the language the customer usually speaks. Be very brief and friendly.`;
               
               const result = await model.generateContent(prompt);
               reminderText = result.response.text();
               break;
             } catch (e) {}
           }
           
           if (reminderText) {
             const phoneNumberId = process.env.PHONE_NUMBER_ID || "1162096826996318";
             await axios({
                method: 'POST',
                url: `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
                headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
                data: { messaging_product: 'whatsapp', to: appt.phone_number, type: 'text', text: { body: reminderText } },
             });
             logMessage(appt.phone_number, 'outbound', reminderText);
             
             // Mark as sent
             db.run(`UPDATE appointments SET reminder_sent = 1 WHERE id = ?`, [appt.id]);
             console.log(`Sent reminder to ${appt.phone_number}`);
           }
        } catch (e) {
           console.error("Failed to send reminder:", e.message);
        }
      }
  });
}, 60000); // Check every 1 minute


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
    if (body.entry && body.entry[0].changes && body.entry[0].changes[0] && 
        body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
      
      const phoneNumberId = body.entry[0].changes[0].value.metadata.phone_number_id;
      const from = body.entry[0].changes[0].value.messages[0].from; 
      const msgObj = body.entry[0].changes[0].value.messages[0];
      let msgBody = "Received a non-text message";
      if (msgObj.type === 'text') {
        msgBody = msgObj.text.body;
      } else if (msgObj.type === 'interactive' && msgObj.interactive.type === 'button_reply') {
        msgBody = msgObj.interactive.button_reply.title;
      }

      res.sendStatus(200); 
      logMessage(from, 'inbound', msgBody);

      try {
        const sysPrompt = await getSystemPrompt();
        const finalPrompt = sysPrompt + "\n\nCRITICAL INSTRUCTION: If you want to offer the user clickable buttons (maximum 3), append them to the end of your message in this exact format: [BUTTON: Option 1] [BUTTON: Option 2]. Button text MUST be 20 characters or less.";
        
        const modelsToTry = await getValidModelsList();
        let aiResponse = null;

        for (const modelName of modelsToTry) {
          try {
            const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
            const model = genAI.getGenerativeModel({ model: modelName });
            const chat = model.startChat({
              history: [
                { role: "user", parts: [{ text: finalPrompt }] },
                { role: "model", parts: [{ text: "Understood." }] },
              ]
            });
            const result = await chat.sendMessage(msgBody);
            aiResponse = result.response.text();
            break; 
          } catch (e) {}
        }

        if (!aiResponse) throw new Error("All available Gemini models failed.");

        // Parse buttons from aiResponse
        const buttons = [];
        let cleanedResponse = aiResponse;
        const buttonRegex = /\[BUTTON:\s*(.+?)\]/g;
        let match;
        
        while ((match = buttonRegex.exec(aiResponse)) !== null) {
          if (buttons.length < 3) {
            let btnText = match[1].trim().substring(0, 20);
            buttons.push({
              type: "reply",
              reply: { id: "btn_" + buttons.length, title: btnText }
            });
          }
        }
        
        cleanedResponse = cleanedResponse.replace(buttonRegex, '').trim();
        
        let payloadData;
        if (buttons.length > 0) {
          payloadData = {
            messaging_product: 'whatsapp',
            to: from,
            type: 'interactive',
            interactive: {
              type: 'button',
              body: { text: cleanedResponse || "Please select an option:" },
              action: { buttons: buttons }
            }
          };
        } else {
          payloadData = {
            messaging_product: 'whatsapp',
            to: from,
            type: 'text',
            text: { body: cleanedResponse }
          };
        }

        await axios({
          method: 'POST',
          url: `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
          headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
          data: payloadData,
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
  if (!targetPhone) return res.send("Error: Add ?phone=YOURNUMBER");
  
  const phoneNumberId = process.env.PHONE_NUMBER_ID || "1162096826996318"; 
  const msgBody = "Hello! Introduce yourself briefly as my new AI assistant.";
  
  try {
    const sysPrompt = await getSystemPrompt();
    const modelsToTry = await getValidModelsList();
    let aiResponse = null;

    for (const modelName of modelsToTry) {
      try {
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: modelName });
        const chat = model.startChat({
           history: [
             { role: "user", parts: [{ text: sysPrompt }] },
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
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      data: { messaging_product: 'whatsapp', to: targetPhone, type: 'text', text: { body: aiResponse } },
    });
    
    logMessage(targetPhone, 'outbound', aiResponse);
    res.send(`<h1>Success!</h1><p>Forced message to ${targetPhone}.</p>`);
  } catch (err) {
    res.send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
