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
  if (!process.env.DATABASE_URL) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, phone_number TEXT, direction TEXT, message TEXT, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS contacts (phone_number TEXT PRIMARY KEY, name TEXT, notes TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS appointments (id SERIAL PRIMARY KEY, phone_number TEXT, appointment_date TIMESTAMP, reason TEXT, reminder_sent INTEGER DEFAULT 0)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
  } catch (err) { console.error(err); }
}
initDB();

async function logMessage(phone_number, direction, message) {
  try {
    await pool.query(`INSERT INTO messages (phone_number, direction, message) VALUES ($1, $2, $3)`, [phone_number, direction, message]);
    await pool.query(`INSERT INTO contacts (phone_number, name, notes) VALUES ($1, '', '') ON CONFLICT DO NOTHING`, [phone_number]);
  } catch (err) {}
}

async function getSystemPrompt() {
  try {
    const res = await pool.query(`SELECT value FROM settings WHERE key = 'system_prompt'`);
    if (res.rows.length > 0) return res.rows[0].value;
    return "You are a helpful AI assistant.";
  } catch (err) { return "You are a helpful AI assistant."; }
}

let cachedModels = [];
async function getValidModelsList() {
  if (cachedModels.length > 0) return cachedModels;
  try {
    const response = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
    const models = response.data.models;
    let valid = models.filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'));
    // Filter out TTS and Vision models as they don't support simple multi-turn chat text properly
    valid = valid.filter(m => !m.name.includes('tts') && !m.name.includes('vision') && !m.name.includes('embedding') && m.name.includes('gemini'));
    cachedModels = valid.map(m => m.name.replace('models/', '')).sort((a, b) => {
      if (a.includes('flash') && !b.includes('flash')) return -1;
      if (!a.includes('flash') && b.includes('flash')) return 1;
      return 0;
    });
    return cachedModels;
  } catch (err) { return ["gemini-1.5-flash", "gemini-pro"]; }
}

// -----------------------------------------
// DASHBOARD API ENDPOINTS
// -----------------------------------------
app.get('/api/stats', async (req, res) => {
  try {
    const messages = await pool.query(`SELECT COUNT(*) as count FROM messages`);
    const contacts = await pool.query(`SELECT COUNT(*) as count FROM contacts`);
    const appointments = await pool.query(`SELECT COUNT(*) as count FROM appointments`);
    res.json({ total_messages: parseInt(messages.rows[0].count), total_contacts: parseInt(contacts.rows[0].count), total_appointments: parseInt(appointments.rows[0].count) });
  } catch (err) { res.status(500).json({error: err.message}); }
});

app.get('/api/chats', async (req, res) => {
  try {
    const result = await pool.query(`SELECT c.phone_number, c.name, (SELECT message FROM messages WHERE phone_number = c.phone_number ORDER BY timestamp DESC LIMIT 1) as last_message FROM contacts c ORDER BY c.created_at DESC`);
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
  if (!to || !message) return res.status(400).json({ error: "Missing data" });
  try {
    const phoneNumberId = process.env.PHONE_NUMBER_ID || "1162096826996318";
    await axios({ method: 'POST', url: `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }, data: { messaging_product: 'whatsapp', to: to, type: 'text', text: { body: message } } });
    await logMessage(to, 'manual', message);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/contacts', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM contacts ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contacts', async (req, res) => {
  const { phone_number, name, notes } = req.body;
  try {
    await pool.query(`INSERT INTO contacts (phone_number, name, notes) VALUES ($1, $2, $3) ON CONFLICT(phone_number) DO UPDATE SET name=EXCLUDED.name, notes=EXCLUDED.notes`, [phone_number, name || '', notes || '']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/appointments', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM appointments ORDER BY appointment_date ASC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/appointments', async (req, res) => {
  const { phone_number, appointment_date, reason } = req.body;
  try {
    await pool.query(`INSERT INTO appointments (phone_number, appointment_date, reason) VALUES ($1, $2, $3)`, [phone_number, appointment_date, reason || '']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/settings', async (req, res) => {
  const prompt = await getSystemPrompt();
  res.json({ system_prompt: prompt });
});

app.post('/api/settings', async (req, res) => {
  const { system_prompt } = req.body;
  try {
    await pool.query(`INSERT INTO settings (key, value) VALUES ('system_prompt', $1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [system_prompt]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// -----------------------------------------
// WHATSAPP WEBHOOK ENDPOINTS
// -----------------------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) res.status(200).send(challenge);
    else res.sendStatus(403);
  } else res.status(400).send('Missing token');
});

app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object) {
    if (body.entry && body.entry[0].changes && body.entry[0].changes[0] && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
      
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
        const finalPrompt = sysPrompt + "\n\nCRITICAL INSTRUCTION: You may offer clickable buttons (maximum 3) by appending them to the end of your message in this exact format: [BUTTON: Option 1] [BUTTON: Option 2]. ONLY do this when initially welcoming the user or explicitly presenting a menu. DO NOT append buttons to every conversational reply. Keep the conversation natural.";
        
        // Fetch conversational history to provide continuity
        const recentMsgs = await pool.query(`SELECT direction, message FROM messages WHERE phone_number = $1 ORDER BY timestamp DESC LIMIT 15`, [from]);
        const orderedMsgs = recentMsgs.rows.reverse(); // oldest to newest
        
        let mergedHistory = [];
        let currentRole = null;
        let currentText = "";
        
        for (const row of orderedMsgs) {
           const role = row.direction === 'inbound' ? 'user' : 'model';
           if (role === currentRole) {
               currentText += "\n" + row.message;
           } else {
               if (currentRole !== null) {
                   mergedHistory.push({ role: currentRole, parts: [{ text: currentText }] });
               }
               currentRole = role;
               currentText = row.message;
           }
        }
        if (currentRole !== null) {
            mergedHistory.push({ role: currentRole, parts: [{ text: currentText }] });
        }
        
        // Gemini strict rule: history must alternate [user, model, user, model] and MUST end with a model response before we send the next user message
        if (mergedHistory.length > 0 && mergedHistory[mergedHistory.length - 1].role === 'user') {
            mergedHistory.push({ role: 'model', parts: [{ text: "Noted." }] });
        }

        const chatHistory = [
          { role: "user", parts: [{ text: finalPrompt }] },
          { role: "model", parts: [{ text: "Understood. I will follow those instructions and remember the context." }] },
          ...mergedHistory
        ];
        
        const modelsToTry = await getValidModelsList();
        let aiResponse = null;

        for (const modelName of modelsToTry) {
          try {
            const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
            const model = genAI.getGenerativeModel({ model: modelName });
            
            const chat = model.startChat({
              history: chatHistory
            });
            
            const result = await chat.sendMessage(msgBody);
            const responseData = result.response;
            aiResponse = responseData.text();
            
            break; 
          } catch (e) { console.log(e.message); }
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
            buttons.push({ type: "reply", reply: { id: "btn_" + buttons.length, title: btnText } });
          }
        }
        
        cleanedResponse = cleanedResponse.replace(buttonRegex, '').trim();
        
        let payloadData;
        if (buttons.length > 0) {
          payloadData = {
            messaging_product: 'whatsapp', to: from, type: 'interactive',
            interactive: { type: 'button', body: { text: cleanedResponse || "Please select an option:" }, action: { buttons: buttons } }
          };
        } else {
          payloadData = { messaging_product: 'whatsapp', to: from, type: 'text', text: { body: cleanedResponse } };
        }

        await axios({ method: 'POST', url: `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }, data: payloadData });
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

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
