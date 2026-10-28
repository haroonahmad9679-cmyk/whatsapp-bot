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
const cron = require('node-cron');

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(bodyParser.json());

// Track real human visitors to the dashboard (filtering out automated bots/crawlers)
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/dashboard') {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const ua = req.headers['user-agent'] || 'Unknown';
    const isBot = /bot|crawl|spider|slurp|censys|shodan|headless|curl|wget|python|go-http|scanner|bytespider|gptbot|semrush|ahrefs|uptime|health|ping/i.test(ua);
    if (!isBot && pool) {
       pool.query(`INSERT INTO visitors (ip_address, user_agent) VALUES ($1, $2)`, [ip, ua]).catch(() => {});
    }
  }
  next();
});

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
    try { await pool.query(`ALTER TABLE contacts ADD COLUMN bot_active BOOLEAN DEFAULT true`); } catch(e){}
    try { await pool.query(`ALTER TABLE contacts ADD COLUMN followup_sent INTEGER DEFAULT 0`); } catch(e){}
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

    await pool.query(`CREATE TABLE IF NOT EXISTS visitors (id SERIAL PRIMARY KEY, ip_address TEXT, user_agent TEXT, visited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);

    // Enable Row Level Security (RLS) on all tables to secure them in Supabase
    // This prevents anonymous access via the Supabase Data API, but allows our backend (using postgres role) to still read/write data.
    const tables = ['accounts', 'messages', 'contacts', 'appointments', 'settings', 'visitors'];
    for (const table of tables) {
      await pool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    }

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

async function getWhatsAppCredentials(accountId) {
  let token = process.env.WHATSAPP_TOKEN || '';
  let phoneId = process.env.PHONE_NUMBER_ID || "1162096826996318";
  let defaultTemplate = "hello_world";
  let defaultLang = "en_US";
  let metaAppId = process.env.META_APP_ID || "";

  try {
    const res = await pool.query(
      `SELECT key, value FROM settings WHERE account_id = $1 AND key IN ('whatsapp_token', 'whatsapp_phone_id', 'default_template_name', 'default_template_lang', 'meta_app_id')`,
      [accountId]
    );
    res.rows.forEach(r => {
      if (r.key === 'whatsapp_token' && r.value && r.value.trim() !== '') token = r.value.trim();
      if (r.key === 'whatsapp_phone_id' && r.value && r.value.trim() !== '') phoneId = r.value.trim();
      if (r.key === 'default_template_name' && r.value && r.value.trim() !== '') defaultTemplate = r.value.trim();
      if (r.key === 'default_template_lang' && r.value && r.value.trim() !== '') defaultLang = r.value.trim();
      if (r.key === 'meta_app_id' && r.value && r.value.trim() !== '') metaAppId = r.value.trim();
    });

    if (!phoneId) {
      const acc = await pool.query(`SELECT whatsapp_phone_id FROM accounts WHERE id = $1`, [accountId]);
      if (acc.rows.length > 0 && acc.rows[0].whatsapp_phone_id) {
        phoneId = acc.rows[0].whatsapp_phone_id;
      }
    }
  } catch (e) {
    console.error("Error fetching WhatsApp credentials:", e.message);
  }

  return { token, phoneNumberId: phoneId, defaultTemplate, defaultLang, metaAppId };
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
  // Public registration is disabled on this private system for security
  res.status(403).json({ error: "Public registration is disabled on this private system." });
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
    const result = await pool.query(`SELECT c.phone_number, c.name, c.lead_score, c.bot_active, (SELECT message FROM messages WHERE phone_number = c.phone_number AND account_id = $1 ORDER BY timestamp DESC LIMIT 1) as last_message FROM contacts c WHERE c.account_id = $1 ORDER BY c.created_at DESC`, [accountId]);
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
  if (!to || !message) return res.status(400).json({ error: "Missing recipient or message" });
  try {
    const creds = await getWhatsAppCredentials(accountId);
    if (!creds.token) return res.status(400).json({ error: "WhatsApp Access Token is not configured. Please add it in Settings." });
    
    await axios({ 
      method: 'POST', 
      url: `https://graph.facebook.com/v21.0/${creds.phoneNumberId}/messages`, 
      headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' }, 
      data: { messaging_product: 'whatsapp', to: to, type: 'text', text: { body: message } } 
    });
    await logMessage(accountId, to, 'manual', message);
    res.json({ success: true });
  } catch (err) {
    const fbError = err.response?.data?.error;
    if (fbError && (fbError.code === 131047 || fbError.error_subcode === 131047 || (fbError.message && fbError.message.includes('24 hours')))) {
      return res.status(400).json({ 
        error: "24-hour customer window has expired. WhatsApp blocks free-form text. Please use 'Send Template' to re-open the conversation.",
        code: 131047,
        is_window_expired: true
      });
    }
    const errMsg = fbError?.message || err.message;
    res.status(500).json({ error: errMsg });
  }
});

// Send Meta Approved Template
app.post('/api/send-template', authenticateJWT, async (req, res) => {
  const accountId = req.user.accountId;
  const { to, template_name, language_code, body_variable } = req.body;
  if (!to || !template_name) return res.status(400).json({ error: "Recipient phone number and template name are required." });

  try {
    const creds = await getWhatsAppCredentials(accountId);
    if (!creds.token) return res.status(400).json({ error: "WhatsApp Access Token is not configured. Please add it in Settings." });

    const lang = language_code || creds.defaultLang || "en_US";
    const payload = {
      messaging_product: "whatsapp",
      to: to,
      type: "template",
      template: {
        name: template_name,
        language: { code: lang }
      }
    };

    if (body_variable && body_variable.trim() !== '') {
      payload.template.components = [
        {
          type: "body",
          parameters: [{ type: "text", text: body_variable.trim() }]
        }
      ];
    }

    const response = await axios({
      method: 'POST',
      url: `https://graph.facebook.com/v21.0/${creds.phoneNumberId}/messages`,
      headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
      data: payload
    });

    const logText = body_variable ? `[Template: ${template_name}] Variable: ${body_variable}` : `[Template: ${template_name}]`;
    await logMessage(accountId, to, 'manual', logText);
    res.json({ success: true, messageId: response.data.messages?.[0]?.id });
  } catch (err) {
    const errObj = err.response?.data?.error || err.response?.data || err.message;
    const msg = typeof errObj === 'object' ? (errObj.message || JSON.stringify(errObj)) : errObj;
    res.status(500).json({ error: msg });
  }
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

app.post('/api/contacts/:phone/toggle-ai', authenticateJWT, async (req, res) => {
  const accountId = req.user.accountId;
  const phone = req.params.phone;
  const { bot_active } = req.body;
  try {
    await pool.query(`UPDATE contacts SET bot_active = $1 WHERE phone_number = $2 AND account_id = $3`, [bot_active, phone, accountId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({error: err.message}); }
});

app.get('/api/analytics', authenticateJWT, async (req, res) => {
  const accountId = req.user.accountId;
  try {
    const msgCountRes = await pool.query(`SELECT COUNT(*) FROM messages WHERE account_id = $1`, [accountId]);
    const leadCountRes = await pool.query(`SELECT COUNT(*) FROM contacts WHERE account_id = $1 AND lead_score = 'Hot'`, [accountId]);
    const visitorCountRes = await pool.query(`
      SELECT COUNT(*) FROM visitors 
      WHERE user_agent NOT ILIKE '%bot%' 
        AND user_agent NOT ILIKE '%crawl%' 
        AND user_agent NOT ILIKE '%censys%' 
        AND user_agent NOT ILIKE '%shodan%' 
        AND user_agent NOT ILIKE '%python%' 
        AND user_agent NOT ILIKE '%curl%'
    `);
    const recentMsgs = await pool.query(`
      SELECT DATE(timestamp) as date, COUNT(*) as count 
      FROM messages 
      WHERE account_id = $1 AND timestamp >= NOW() - INTERVAL '7 days' 
      GROUP BY DATE(timestamp) 
      ORDER BY DATE(timestamp) ASC
    `, [accountId]);
    
    res.json({
      totalMessages: parseInt(msgCountRes.rows[0].count),
      hotLeads: parseInt(leadCountRes.rows[0].count),
      totalVisitors: parseInt(visitorCountRes.rows[0].count),
      activity: recentMsgs.rows
    });
  } catch(err) { res.status(500).json({error: err.message}); }
});

app.get('/api/analytics/date', authenticateJWT, async (req, res) => {
  const accountId = req.user.accountId;
  const date = req.query.date;
  try {
    const result = await pool.query(`
      SELECT m.phone_number, m.direction, m.message, m.timestamp, c.name, c.lead_score
      FROM messages m
      LEFT JOIN contacts c ON m.phone_number = c.phone_number AND m.account_id = c.account_id
      WHERE m.account_id = $1 AND DATE(m.timestamp) = $2
      ORDER BY m.timestamp DESC
    `, [accountId, date]);
    res.json(result.rows);
  } catch(err) { res.status(500).json({error: err.message}); }
});

app.get('/api/visitors', authenticateJWT, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM visitors 
      WHERE user_agent NOT ILIKE '%bot%' 
        AND user_agent NOT ILIKE '%crawl%' 
        AND user_agent NOT ILIKE '%censys%' 
        AND user_agent NOT ILIKE '%shodan%' 
        AND user_agent NOT ILIKE '%python%' 
        AND user_agent NOT ILIKE '%curl%'
      ORDER BY visited_at DESC 
      LIMIT 100
    `);
    res.json(result.rows);
  } catch(err) { res.status(500).json({error: err.message}); }
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
  const creds = await getWhatsAppCredentials(accountId);
  res.json({ 
    system_prompt: prompt,
    whatsapp_token: creds.token,
    whatsapp_phone_id: creds.phoneNumberId,
    default_template_name: creds.defaultTemplate,
    default_template_lang: creds.defaultLang,
    meta_app_id: creds.metaAppId
  });
});

app.post('/api/settings', authenticateJWT, async (req, res) => {
  const accountId = req.user.accountId;
  const { system_prompt, whatsapp_token, whatsapp_phone_id, default_template_name, default_template_lang, meta_app_id } = req.body;
  try {
    if (system_prompt !== undefined) {
      await pool.query(`INSERT INTO settings (key, account_id, value) VALUES ('system_prompt', $1, $2) ON CONFLICT (key, account_id) DO UPDATE SET value = EXCLUDED.value`, [accountId, system_prompt]);
    }
    if (whatsapp_token !== undefined) {
      await pool.query(`INSERT INTO settings (key, account_id, value) VALUES ('whatsapp_token', $1, $2) ON CONFLICT (key, account_id) DO UPDATE SET value = EXCLUDED.value`, [accountId, whatsapp_token.trim()]);
    }
    if (whatsapp_phone_id !== undefined) {
      await pool.query(`INSERT INTO settings (key, account_id, value) VALUES ('whatsapp_phone_id', $1, $2) ON CONFLICT (key, account_id) DO UPDATE SET value = EXCLUDED.value`, [accountId, whatsapp_phone_id.trim()]);
      await pool.query(`UPDATE accounts SET whatsapp_phone_id = $1 WHERE id = $2`, [whatsapp_phone_id.trim(), accountId]);
    }
    if (default_template_name !== undefined) {
      await pool.query(`INSERT INTO settings (key, account_id, value) VALUES ('default_template_name', $1, $2) ON CONFLICT (key, account_id) DO UPDATE SET value = EXCLUDED.value`, [accountId, default_template_name.trim()]);
    }
    if (default_template_lang !== undefined) {
      await pool.query(`INSERT INTO settings (key, account_id, value) VALUES ('default_template_lang', $1, $2) ON CONFLICT (key, account_id) DO UPDATE SET value = EXCLUDED.value`, [accountId, default_template_lang.trim()]);
    }
    if (meta_app_id !== undefined) {
      await pool.query(`INSERT INTO settings (key, account_id, value) VALUES ('meta_app_id', $1, $2) ON CONFLICT (key, account_id) DO UPDATE SET value = EXCLUDED.value`, [accountId, meta_app_id.trim()]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Coexistence Onboarding Save Endpoint
app.post('/api/onboarding/save-coexistence', authenticateJWT, async (req, res) => {
  const accountId = req.user.accountId;
  const { phone_number_id, meta_app_id, token } = req.body;
  try {
    if (phone_number_id) {
      await pool.query(`INSERT INTO settings (key, account_id, value) VALUES ('whatsapp_phone_id', $1, $2) ON CONFLICT (key, account_id) DO UPDATE SET value = EXCLUDED.value`, [accountId, phone_number_id.trim()]);
      await pool.query(`UPDATE accounts SET whatsapp_phone_id = $1 WHERE id = $2`, [phone_number_id.trim(), accountId]);
    }
    if (meta_app_id) {
      await pool.query(`INSERT INTO settings (key, account_id, value) VALUES ('meta_app_id', $1, $2) ON CONFLICT (key, account_id) DO UPDATE SET value = EXCLUDED.value`, [accountId, meta_app_id.trim()]);
    }
    if (token) {
      await pool.query(`INSERT INTO settings (key, account_id, value) VALUES ('whatsapp_token', $1, $2) ON CONFLICT (key, account_id) DO UPDATE SET value = EXCLUDED.value`, [accountId, token.trim()]);
    }
    res.json({ success: true, message: "Coexistence settings linked successfully!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test Meta WhatsApp Token Endpoint
app.post('/api/test-token', authenticateJWT, async (req, res) => {
  const accountId = req.user.accountId;
  const { token, phone_id } = req.body;
  try {
    const creds = await getWhatsAppCredentials(accountId);
    const testToken = (token && token.trim() !== '') ? token.trim() : creds.token;
    const testPhoneId = (phone_id && phone_id.trim() !== '') ? phone_id.trim() : creds.phoneNumberId;

    if (!testToken) return res.status(400).json({ valid: false, error: "No WhatsApp token provided or saved." });
    if (!testPhoneId) return res.status(400).json({ valid: false, error: "No Phone Number ID provided or saved." });

    const metaRes = await axios.get(`https://graph.facebook.com/v21.0/${testPhoneId}`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });

    res.json({
      valid: true,
      display_phone_number: metaRes.data.display_phone_number || testPhoneId,
      verified_name: metaRes.data.verified_name || "Verified WhatsApp Business",
      quality_rating: metaRes.data.quality_rating || "GREEN / GOOD",
      id: metaRes.data.id
    });
  } catch (err) {
    const fbError = err.response?.data?.error;
    const errMsg = fbError?.message || err.message;
    res.status(400).json({ valid: false, error: errMsg });
  }
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
    if (body.entry && body.entry[0].changes && body.entry[0].changes[0]) {
      const changeVal = body.entry[0].changes[0].value;
      const phoneNumberId = changeVal.metadata ? changeVal.metadata.phone_number_id : null;

      // Handle mobile app message echoes (Coexistence mode)
      const echoes = changeVal.message_echoes || changeVal.smb_message_echoes;
      if (echoes && echoes.length > 0) {
        res.sendStatus(200);
        try {
          const accResult = await pool.query(`SELECT id FROM accounts WHERE whatsapp_phone_id = $1`, [phoneNumberId]);
          const accountId = accResult.rows.length > 0 ? accResult.rows[0].id : 1;
          for (const echo of echoes) {
            const to = echo.to;
            let echoText = echo.text ? echo.text.body : "[Media from mobile]";
            if (echo.type === 'image') echoText = "📷 [Image sent from mobile app]";
            if (echo.type === 'audio' || echo.type === 'voice') echoText = "🎤 [Voice note sent from mobile app]";
            await logMessage(accountId, to, 'manual', `📱 [Mobile App] ${echoText}`);
          }
        } catch(err) {
          console.error("Echo log error:", err.message);
        }
        return;
      }

      // Handle regular inbound messages from customer
      if (changeVal.messages && changeVal.messages[0]) {
        const from = changeVal.messages[0].from; 
        const msgObj = changeVal.messages[0];
        let msgBody = "Received a non-text message";
        let aiInput = null;

        if (msgObj.type === 'text') {
          msgBody = msgObj.text.body;
        } else if (msgObj.type === 'interactive' && msgObj.interactive.type === 'button_reply') {
          msgBody = msgObj.interactive.button_reply.title;
        } else if (msgObj.type === 'audio' || msgObj.type === 'voice') {
          msgBody = "🎤 [Voice Note Received]";
        } else if (msgObj.type === 'image') {
          msgBody = "📷 [Image Received]";
        }

        res.sendStatus(200); 

        try {
          // Resolve Account based on incoming phone_number_id
          const accResult = await pool.query(`SELECT id FROM accounts WHERE whatsapp_phone_id = $1`, [phoneNumberId]);
          const accountId = accResult.rows.length > 0 ? accResult.rows[0].id : 1;
          const creds = await getWhatsAppCredentials(accountId);

          await logMessage(accountId, from, 'inbound', msgBody);

        const contactCheck = await pool.query(`SELECT bot_active FROM contacts WHERE phone_number = $1 AND account_id = $2`, [from, accountId]);
        const botActive = contactCheck.rows.length > 0 ? contactCheck.rows[0].bot_active : true;
        
        if (botActive === false) {
           return; // Exit early, human is taking over
        }

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
        if (msgObj.type === 'audio' || msgObj.type === 'voice' || msgObj.type === 'image') {
          try {
            const mediaObj = msgObj.type === 'image' ? msgObj.image : (msgObj.type === 'voice' ? msgObj.voice : msgObj.audio);
            const mediaRes = await axios.get(`https://graph.facebook.com/v21.0/${mediaObj.id}`, { headers: { Authorization: `Bearer ${creds.token}` } });
            const mediaUrl = mediaRes.data.url;
            
            const mediaDataRes = await axios.get(mediaUrl, { responseType: 'arraybuffer', headers: { Authorization: `Bearer ${creds.token}` } });
            const base64Media = Buffer.from(mediaDataRes.data, 'binary').toString('base64');
            
            const promptText = msgObj.type === 'image' 
               ? "Examine the following image sent by the user and respond appropriately:" 
               : "Listen to the following voice note from the user and respond appropriately:";
               
            aiInput = [
              { text: promptText },
              { inlineData: { data: base64Media, mimeType: mediaObj.mime_type || (msgObj.type === 'image' ? "image/jpeg" : "audio/ogg") } }
            ];
          } catch (mediaErr) {
             console.error("Media download failed:", mediaErr.message);
             aiInput = "The user sent a media file, but I failed to download it. Ask them to type it instead.";
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

        await axios({ method: 'POST', url: `https://graph.facebook.com/v21.0/${creds.phoneNumberId}/messages`, headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' }, data: payloadData });
        await logMessage(accountId, from, 'outbound', aiResponse); // aiResponse retains the unmodified text (except LEAD:HOT was removed)
      } catch (error) {
        console.error('Error processing AI:', error.message);
      }
      return; 
    }
  }
  res.sendStatus(200);
} else {
  res.sendStatus(404);
}
});

// -----------------------------------------
// AUTOMATED FOLLOW-UP DRIP CAMPAIGN (CRON)
// -----------------------------------------
cron.schedule('0 * * * *', async () => {
  console.log("Running hourly check for Hot Leads follow-ups...");
  try {
    // Find Hot leads whose last message was between 20 and 23 hours ago.
    // This ensures our automated follow-up arrives safely BEFORE the strict 24-hour customer window closes!
    const leads = await pool.query(`
      SELECT c.phone_number, c.account_id, c.name, a.whatsapp_phone_id
      FROM contacts c
      JOIN accounts a ON c.account_id = a.id
      WHERE c.lead_score = 'Hot' 
        AND c.bot_active = true 
        AND c.followup_sent = 0
        AND EXISTS (
          SELECT 1 FROM messages m 
          WHERE m.phone_number = c.phone_number 
            AND m.account_id = c.account_id 
            AND m.timestamp <= NOW() - INTERVAL '20 hours'
            AND m.timestamp >= NOW() - INTERVAL '23 hours'
        )
    `);

    for (const lead of leads.rows) {
      try {
        const creds = await getWhatsAppCredentials(lead.account_id);
        if (!creds.token) continue;

        const sysPrompt = await getSystemPrompt(lead.account_id);
        const prompt = sysPrompt + "\n\nCRITICAL INSTRUCTION: Generate a very short, friendly check-in message for this user. DO NOT offer any discounts or deals unless explicitly told to. Just ask if they have any more questions about the products they were looking at.";
        
        const modelsToTry = await getValidModelsList();
        let aiResponse = null;
        for (const modelName of modelsToTry) {
           try {
             const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
             const model = genAI.getGenerativeModel({ model: modelName });
             const chat = model.startChat({ history: [{ role: 'user', parts: [{ text: prompt }] }] });
             const result = await chat.sendMessage("Write a quick friendly follow-up message to check in on my interest.");
             aiResponse = result.response.text();
             break;
           } catch(e) {}
        }
        
        if (aiResponse) {
          await axios({ 
            method: 'POST', 
            url: `https://graph.facebook.com/v21.0/${creds.phoneNumberId}/messages`, 
            headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' }, 
            data: { messaging_product: 'whatsapp', to: lead.phone_number, type: 'text', text: { body: aiResponse } } 
          });
          await logMessage(lead.account_id, lead.phone_number, 'outbound', aiResponse);
          await pool.query(`UPDATE contacts SET followup_sent = 1 WHERE phone_number = $1 AND account_id = $2`, [lead.phone_number, lead.account_id]);
          console.log(`Sent automated follow-up to ${lead.phone_number}`);
        }
      } catch (err) {
        console.error("Follow-up error for lead", lead.phone_number, err.message);
      }
    }
  } catch (err) {
    console.error("Cron Job Error:", err);
  }
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
