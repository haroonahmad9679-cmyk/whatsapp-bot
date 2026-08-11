require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(bodyParser.json());

// Serve the frontend dashboard
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/script.js', (req, res) => res.sendFile(path.join(__dirname, 'script.js')));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'my_super_secret_token';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Initialize PostgreSQL Pool (Supabase)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.warn("WARNING: DATABASE_URL is not set. The server will crash on DB operations.");
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        phone_number TEXT,
        direction TEXT,
        message TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        phone_number TEXT PRIMARY KEY,
        name TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id SERIAL PRIMARY KEY,
        phone_number TEXT,
        appointment_date TIMESTAMP,
        reason TEXT,
        reminder_sent INTEGER DEFAULT 0
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    const defaultPrompt = `You are a professional, helpful, and friendly sales assistant for an individual business. 
Your goal is to answer customer queries accurately, generate sales presence, and be as helpful as possible. 
You can communicate fluently in any language the customer uses. Keep your answers concise, engaging, and suitable for a WhatsApp conversation (use emojis appropriately).`;
    
    await pool.query(`
      INSERT INTO settings (key, value) VALUES ('system_prompt', $1)
      ON CONFLICT(key) DO NOTHING
    `, [defaultPrompt]);
    
    console.log('Connected to PostgreSQL (Supabase) database and initialized tables.');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}
initDB();

// Helper functions
async function logMessage(phone_number, direction, message) {
  try {
    await pool.query(`INSERT INTO messages (phone_number, direction, message) VALUES ($1, $2, $3)`, 
      [phone_number, direction, message]);
    await pool.query(`
      INSERT INTO contacts (phone_number, name, notes) VALUES ($1, '', '')
      ON CONFLICT (phone_number) DO NOTHING
    `, [phone_number]);
  } catch (err) {
    console.error("logMessage Error: ", err);
  }
}

async function getSystemPrompt() {
  try {
    const res = await pool.query(`SELECT value FROM settings WHERE key = 'system_prompt'`);
    if (res.rows.length > 0) return res.rows[0].value;
    return "You are a helpful AI assistant.";
  } catch (err) {
    return "You are a helpful AI assistant.";
  }
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
app.get('/api/stats', async (req, res) => {
  try {
    const messages = await pool.query(`SELECT COUNT(*) as count FROM messages`);
    const contacts = await pool.query(`SELECT COUNT(*) as count FROM contacts`);
    const appointments = await pool.query(`SELECT COUNT(*) as count FROM appointments`);
    res.json({
      total_messages: parseInt(messages.rows[0].count),
      total_contacts: parseInt(contacts.rows[0].count),
      total_appointments: parseInt(appointments.rows[0].count)
    });
  } catch (err) { res.status(500).json({error: err.message}); }
});

// Tab 2: Inbox (Chats)
app.get('/api/chats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.phone_number, c.name, 
      (SELECT message FROM messages WHERE phone_number = c.phone_number ORDER BY timestamp DESC LIMIT 1) as last_message 
      FROM contacts c ORDER BY c.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/chats/:number', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM messages WHERE phone_number = $1 ORDER BY timestamp ASC`, [req.params.number]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    await logMessage(to, 'manual', message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tab 3: Contacts CRM
app.get('/api/contacts', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM contacts ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contacts', async (req, res) => {
  const { phone_number, name, notes } = req.body;
  if (!phone_number) return res.status(400).json({ error: "Missing phone number" });
  try {
    await pool.query(`
      INSERT INTO contacts (phone_number, name, notes) VALUES ($1, $2, $3)
      ON CONFLICT(phone_number) DO UPDATE SET name=EXCLUDED.name, notes=EXCLUDED.notes
    `, [phone_number, name || '', notes || '']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tab 4: Appointments
app.get('/api/appointments', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM appointments ORDER BY appointment_date ASC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/appointments', async (req, res) => {
  const { phone_number, appointment_date, reason } = req.body;
  if (!phone_number || !appointment_date) return res.status(400).json({ error: "Missing data" });
  try {
    await pool.query(`INSERT INTO appointments (phone_number, appointment_date, reason) VALUES ($1, $2, $3)`, 
      [phone_number, appointment_date, reason || '']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tab 5: Settings
app.get('/api/settings', async (req, res) => {
  const prompt = await getSystemPrompt();
  res.json({ system_prompt: prompt });
});

app.post('/api/settings', async (req, res) => {
  const { system_prompt } = req.body;
  if (!system_prompt) return res.status(400).json({ error: "Missing prompt" });
  try {
    await pool.query(`
      INSERT INTO settings (key, value) VALUES ('system_prompt', $1)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value
    `, [system_prompt]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// -----------------------------------------
// AUTOMATED APPOINTMENT REMINDERS (CRON)
// -----------------------------------------
setInterval(async () => {
  if (!process.env.DATABASE_URL) return;
  // Check for appointments in the next 24 hours where reminder hasn't been sent
  const twentyFourHoursFromNow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  
  try {
    const result = await pool.query(`SELECT * FROM appointments WHERE appointment_date > $1 AND appointment_date <= $2 AND reminder_sent = 0`, 
      [now, twentyFourHoursFromNow]);
      
    for (const appt of result.rows) {
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
              
              const resGen = await model.generateContent(prompt);
              reminderText = resGen.response.text();
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
            await logMessage(appt.phone_number, 'outbound', reminderText);
            
            // Mark as sent
            await pool.query(`UPDATE appointments SET reminder_sent = 1 WHERE id = $1`, [appt.id]);
            console.log(`Sent reminder to ${appt.phone_number}`);
          }
      } catch (e) {
          console.error("Failed to send reminder:", e.message);
      }
    }
  } catch (err) {
    console.error("Cron Database Error: ", err);
  }
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
      await logMessage(from, 'inbound', msgBody);

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
        
        await logMessage(from, 'outbound', aiResponse);
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
    
    await logMessage(targetPhone, 'outbound', aiResponse);
    res.send(`<h1>Success!</h1><p>Forced message to ${targetPhone}.</p>`);
  } catch (err) {
    res.send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
