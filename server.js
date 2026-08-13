require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Pool } = require('pg');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const pdfParse = require('pdf-parse');

const upload = multer({ storage: multer.memoryStorage() });

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
const JWT_SECRET = process.env.JWT_SECRET || 'my_super_secret_jwt_key';

// Initialize PostgreSQL Pool (Supabase)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  if (!process.env.DATABASE_URL) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS accounts (id SERIAL PRIMARY KEY, company_name TEXT, email TEXT UNIQUE, password_hash TEXT, whatsapp_phone_id TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    
    const accCount = await pool.query(`SELECT count(*) FROM accounts`);
    if (parseInt(accCount.rows[0].count) === 0) {
       const hash = await bcrypt.hash('password123', 10);
       await pool.query(`INSERT INTO accounts (company_name, email, password_hash, whatsapp_phone_id) VALUES ('Default Admin', 'admin@harry.com', $1, $2)`, [hash, process.env.PHONE_NUMBER_ID || '1162096826996318']);
    }

    await pool.query(`CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, account_id INTEGER REFERENCES accounts(id), phone_number TEXT, direction TEXT, message TEXT, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    try { await pool.query(`ALTER TABLE messages ADD COLUMN account_id INTEGER REFERENCES accounts(id)`); } catch(e){}
    await pool.query(`UPDATE messages SET account_id = 1 WHERE account_id IS NULL`);

    await pool.query(`CREATE TABLE IF NOT EXISTS contacts (phone_number TEXT, account_id INTEGER REFERENCES accounts(id), name TEXT, notes TEXT, lead_score TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    try { await pool.query(`ALTER TABLE contacts ADD COLUMN account_id INTEGER REFERENCES accounts(id)`); } catch(e){}
    try { await pool.query(`ALTER TABLE contacts ADD COLUMN lead_score TEXT DEFAULT 'Cold'`); } catch(e){}
    await pool.query(`UPDATE contacts SET account_id = 1 WHERE account_id IS NULL`);
    try { await pool.query(`ALTER TABLE contacts DROP CONSTRAINT contacts_pkey CASCADE`); } catch(e){}
    try { await pool.query(`ALTER TABLE contacts ADD CONSTRAINT contacts_pkey PRIMARY KEY (phone_number, account_id)`); } catch(e){}

    await pool.query(`CREATE TABLE IF NOT EXISTS appointments (id SERIAL PRIMARY KEY, account_id INTEGER REFERENCES accounts(id), phone_number TEXT, appointment_date TIMESTAMP, reason TEXT, reminder_sent INTEGER DEFAULT 0)`);
    try { await pool.query(`ALTER TABLE appointments ADD COLUMN account_id INTEGER REFERENCES accounts(id)`); } catch(e){}
    await pool.query(`UPDATE appointments SET account_id = 1 WHERE account_id IS NULL`);

    await pool.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT, account_id INTEGER REFERENCES accounts(id), value TEXT)`);
    try { await pool.query(`ALTER TABLE settings ADD COLUMN account_id INTEGER REFERENCES accounts(id)`); } catch(e){}
    await pool.query(`UPDATE settings SET account_id = 1 WHERE account_id IS NULL`);
    try { await pool.query(`ALTER TABLE settings DROP CONSTRAINT settings_pkey CASCADE`); } catch(e){}
    try { await pool.query(`ALTER TABLE settings ADD CONSTRAINT settings_pkey PRIMARY KEY (key, account_id)`); } catch(e){}

  } catch (err) { console.error("DB Init Error:", err); }
}
initDB();

async function logMessage(accountId, phone_number, direction, message) {
  try {
    await pool.query(`INSERT INTO messages (account_id, phone_number, direction, message) VALUES ($1, $2, $3, $4)`, [accountId, phone_number, direction, message]);
    await pool.query(`INSERT INTO contacts (account_id, phone_number, name, notes, lead_score) VALUES ($1, $2, '', '', 'Cold') ON CONFLICT DO NOTHING`, [accountId, phone_number]);
  } catch (err) {}
}

async function getSystemPrompt(accountId) {
  try {
    const res = await pool.query(`SELECT value FROM settings WHERE key = 'system_prompt' AND account_id = $1`, [accountId]);
    let basePrompt = res.rows.length > 0 ? res.rows[0].value : "You are a helpful AI assistant.";
    
    const kbRes = await pool.query(`SELECT value FROM settings WHERE key = 'pdf_knowledge' AND account_id = $1`, [accountId]);
    if (kbRes.rows.length > 0 && kbRes.rows[0].value) {
       basePrompt += "\n\nCRITICAL KNOWLEDGE BASE: Use the following information to answer customer questions accurately:\n" + kbRes.rows[0].value;
    }
    return basePrompt;
  } catch (err) { return "You are a helpful AI assistant."; }
}

let cachedModels = [];
async function getValidModelsList() {
  if (cachedModels.length > 0) return cachedModels;
  try {
    const response = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
    const models = response.data.models;
    let valid = models.filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'));
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
// DASHBOARD AUTH MIDDLEWARE
// -----------------------------------------
const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.split(' ')[1];
    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) return res.sendStatus(403);
      req.user = user;
      next();
    });
  } else {
    res.sendStatus(401);
  }
};

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const userResult = await pool.query(`SELECT * FROM accounts WHERE email = $1`, [email]);
    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      const match = await bcrypt.compare(password, user.password_hash);
      if (match) {
        const token = jwt.sign({ accountId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
        return res.json({ token });
      }
    }
    res.status(401).json({ error: "Invalid credentials" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/register', async (req, res) => {
  const { company_name, email, password } = req.body;
  if (!company_name || !email || !password) return res.status(400).json({ error: "Missing fields" });
  try {
    const hash = await bcrypt.hash(password, 10);
    // For phase 10, default to the server's master phone ID if they don't provide one right away
    const defaultPhoneId = process.env.PHONE_NUMBER_ID || "1162096826996318";
    
    const result = await pool.query(
      `INSERT INTO accounts (company_name, email, password_hash, whatsapp_phone_id) VALUES ($1, $2, $3, $4) RETURNING id, email`,
      [company_name, email, hash, defaultPhoneId]
    );
    
    const user = result.rows[0];
    const token = jwt.sign({ accountId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token });
  } catch (err) {
    if (err.code === '23505') { // Postgres unique violation
      return res.status(409).json({ error: "Email already exists" });
    }
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------
// DASHBOARD API ENDPOINTS
// -----------------------------------------
app.get('/api/stats', authenticateJWT, async (req, res) => {
  const accountId = req.user.accountId;
  try {
    const messages = await pool.query(`SELECT COUNT(*) as count FROM messages WHERE account_id = $1`, [accountId]);
    const contacts = await pool.query(`SELECT COUNT(*) as count FROM contacts WHERE account_id = $1`, [accountId]);
    const appointments = await pool.query(`SELECT COUNT(*) as count FROM appointments WHERE account_id = $1`, [accountId]);
    res.json({ total_messages: parseInt(messages.rows[0].count), total_contacts: parseInt(contacts.rows[0].count), total_appointments: parseInt(appointments.rows[0].count) });
  } catch (err) { res.status(500).json({error: err.message}); }
});

app.get('/api/chats', authenticateJWT, async (req, res) => {
  const accountId = req.user.accountId;
  try {
    const result = await pool.query(`SELECT c.phone_number, c.name, c.lead_score, (SELECT message FROM messages WHERE phone_number = c.phone_number AND account_id = $1 ORDER BY timestamp DESC LIMIT 1) as last_message FROM contacts c WHERE c.account_id = $1 ORDER BY c.created_at DESC`, [accountId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/chats/:number', authenticateJWT, async (req, res) => {
  const accountId = req.user.accountId;
  try {
    const result = await pool.query(`SELECT * FROM messages WHERE phone_number = $1 AND account_id = $2 ORDER BY timestamp ASC`, [req.params.number, accountId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/send', authenticateJWT, async (req, res) => {
  const accountId = req.user.accountId;
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: "Missing data" });
  try {
    const accResult = await pool.query(`SELECT whatsapp_phone_id FROM accounts WHERE id = $1`, [accountId]);
    const phoneNumberId = accResult.rows[0].whatsapp_phone_id || process.env.PHONE_NUMBER_ID || "1162096826996318";
    
    await axios({ method: 'POST', url: `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }, data: { messaging_product: 'whatsapp', to: to, type: 'text', text: { body: message } } });
    await logMessage(accountId, to, 'manual', message);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/contacts', authenticateJWT, async (req, res) => {
  const accountId = req.user.accountId;
  try {
    const result = await pool.query(`SELECT * FROM contacts WHERE account_id = $1 ORDER BY created_at DESC`, [accountId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contacts', authenticateJWT, async (req, res) => {
  const accountId = req.user.accountId;
  const { phone_number, name, notes, lead_score } = req.body;
  try {
    await pool.query(`INSERT INTO contacts (account_id, phone_number, name, notes, lead_score) VALUES ($1, $2, $3, $4, $5) ON CONFLICT(phone_number, account_id) DO UPDATE SET name=EXCLUDED.name, notes=EXCLUDED.notes, lead_score=EXCLUDED.lead_score`, [accountId, phone_number, name || '', notes || '', lead_score || 'Cold']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/appointments', authenticateJWT, async (req, res) => {
  const accountId = req.user.accountId;
  try {
    const result = await pool.query(`SELECT * FROM appointments WHERE account_id = $1 ORDER BY appointment_date ASC`, [accountId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/appointments', authenticateJWT, async (req, res) => {
  const accountId = req.user.accountId;
  const { phone_number, appointment_date, reason } = req.body;
  try {
    await pool.query(`INSERT INTO appointments (account_id, phone_number, appointment_date, reason) VALUES ($1, $2, $3, $4)`, [accountId, phone_number, appointment_date, reason || '']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/settings', authenticateJWT, async (req, res) => {
  const accountId = req.user.accountId;
  const prompt = await getSystemPrompt(accountId);
  res.json({ system_prompt: prompt });
});

app.post('/api/settings', authenticateJWT, async (req, res) => {
  const accountId = req.user.accountId;
  const { system_prompt } = req.body;
  try {
    await pool.query(`INSERT INTO settings (key, account_id, value) VALUES ('system_prompt', $1, $2) ON CONFLICT (key, account_id) DO UPDATE SET value = EXCLUDED.value`, [accountId, system_prompt]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PDF Knowledge Base Upload Endpoint
app.post('/api/upload-pdf', authenticateJWT, upload.single('pdfFile'), async (req, res) => {
  const accountId = req.user.accountId;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  
  try {
    const pdfData = await pdfParse(req.file.buffer);
    const extractedText = pdfData.text.substring(0, 50000); // Limit to 50k chars just to be safe for DB
    
    await pool.query(`INSERT INTO settings (key, account_id, value) VALUES ('pdf_knowledge', $1, $2) ON CONFLICT (key, account_id) DO UPDATE SET value = EXCLUDED.value`, [accountId, extractedText]);
    res.json({ success: true, textLength: extractedText.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to parse PDF: ' + err.message });
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
      let aiInput = null;

      if (msgObj.type === 'text') {
        msgBody = msgObj.text.body;
      } else if (msgObj.type === 'interactive' && msgObj.interactive.type === 'button_reply') {
        msgBody = msgObj.interactive.button_reply.title;
      } else if (msgObj.type === 'audio' || msgObj.type === 'voice') {
        msgBody = "🎤 [Voice Note Received]";
      }

      res.sendStatus(200); 

      try {
        // Resolve Account based on incoming phone_number_id
        const accResult = await pool.query(`SELECT id FROM accounts WHERE whatsapp_phone_id = $1`, [phoneNumberId]);
        const accountId = accResult.rows.length > 0 ? accResult.rows[0].id : 1;

        await logMessage(accountId, from, 'inbound', msgBody);

        const sysPrompt = await getSystemPrompt(accountId);
        const finalPrompt = sysPrompt + "\n\nCRITICAL INSTRUCTION: You may offer clickable buttons (maximum 3) by appending them to the end of your message in this exact format: [BUTTON: Option 1] [BUTTON: Option 2]. ONLY do this when initially welcoming the user or explicitly presenting a menu. DO NOT append buttons to every conversational reply.\n\nLEAD SCORING: If the user shows high buying intent (e.g. asking for prices, wanting to purchase), you MUST append [LEAD: HOT] to the end of your message so the system can notify sales.";
        
        const recentMsgs = await pool.query(`SELECT direction, message FROM messages WHERE phone_number = $1 AND account_id = $2 ORDER BY timestamp DESC LIMIT 15`, [from, accountId]);
        const orderedMsgs = recentMsgs.rows.reverse(); 
        
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
        
        if (mergedHistory.length > 0 && mergedHistory[mergedHistory.length - 1].role === 'user') {
            mergedHistory.push({ role: 'model', parts: [{ text: "Noted." }] });
        }

        const chatHistory = [
          { role: "user", parts: [{ text: finalPrompt }] },
          { role: "model", parts: [{ text: "Understood." }] },
          ...mergedHistory
        ];
        
        // If it's an audio or voice message, fetch the binary data from Meta and build a multimodal payload
        if (msgObj.type === 'audio' || msgObj.type === 'voice') {
          try {
            const mediaObj = msgObj.type === 'voice' ? msgObj.voice : msgObj.audio;
            const mediaRes = await axios.get(`https://graph.facebook.com/v19.0/${mediaObj.id}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
            const mediaUrl = mediaRes.data.url;
            
            const audioDataRes = await axios.get(mediaUrl, { responseType: 'arraybuffer', headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
            const base64Audio = Buffer.from(audioDataRes.data, 'binary').toString('base64');
            
            aiInput = [
              { text: "Listen to the following voice note from the user and respond appropriately:" },
              { inlineData: { data: base64Audio, mimeType: mediaObj.mime_type || "audio/ogg" } }
            ];
          } catch (audioErr) {
             console.error("Audio download failed:", audioErr.message);
             aiInput = "The user sent a voice note, but I failed to download it. Ask them to type it instead.";
          }
        }

        const modelsToTry = await getValidModelsList();
        let aiResponse = null;

        for (const modelName of modelsToTry) {
          try {
            const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
            const model = genAI.getGenerativeModel({ model: modelName });
            const chat = model.startChat({ history: chatHistory });
            const result = await chat.sendMessage(aiInput || msgBody);
            aiResponse = result.response.text();
            break; 

          } catch (e) { 
             // Silently fallback
          }
        }

        if (!aiResponse) throw new Error("All available Gemini models failed.");

        // Smart Lead Scoring Check
        if (aiResponse.includes("[LEAD: HOT]")) {
           aiResponse = aiResponse.replace("[LEAD: HOT]", "").trim();
           await pool.query(`UPDATE contacts SET lead_score = 'Hot' WHERE phone_number = $1 AND account_id = $2`, [from, accountId]);
        }

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
        await logMessage(accountId, from, 'outbound', aiResponse); // aiResponse retains the unmodified text (except LEAD:HOT was removed)
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
