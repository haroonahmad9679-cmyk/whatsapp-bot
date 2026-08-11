require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cheerio = require('cheerio');
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
  return ["gemini-3.6-flash"];
}

// -----------------------------------------
// PHASE 8: OPENSOOQ AI SCRAPER
// -----------------------------------------
async function searchOpenSooq(query) {
  try {
    console.log("AI triggered OpenSooq search for:", query);
    const url = `https://kw.opensooq.com/en/find?term=${encodeURIComponent(query)}`;
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36' }
    });
    
    const results = [];
    const $ = cheerio.load(data);
    const nextDataStr = $('#__NEXT_DATA__').html();
    
    if (nextDataStr) {
      try {
        const nextData = JSON.parse(nextDataStr);
        let posts = nextData.props?.pageProps?.initialState?.search?.posts;
        if (!posts) {
          const queries = nextData.props?.pageProps?.dehydratedState?.queries || [];
          const searchQ = queries.find(q => q.queryKey && JSON.stringify(q.queryKey).includes('search'));
          if (searchQ) posts = searchQ.state?.data?.items;
        }
        if (posts && posts.length > 0) {
          posts.slice(0, 5).forEach(p => {
             results.push(`Item: ${p.title} | Price: ${p.price} ${p.currency || 'KWD'} | Link: kw.opensooq.com/en/post/${p.id || p.post_id || ''}`);
          });
        }
      } catch(err) { console.error("JSON parse error:", err.message); }
    }
    
    if (results.length === 0) {
      // Fallback regex if __NEXT_DATA__ structure changed
      const rawHtml = data.toString();
      const comboRegex = /"title":"([^"]+)".{0,150}?"price":([0-9]+)/g;
      
      let match;
      let limit = 0;
      while ((match = comboRegex.exec(rawHtml)) !== null && limit < 5) {
        const title = match[1];
        const price = match[2];
        if (title.length > 10 && title.toLowerCase().includes(query.toLowerCase().split(' ')[0])) {
           results.push(`Item Found: ${title} | Price: ${price} KWD`);
           limit++;
        }
      }
      
      // Absolute fallback if everything fails
      if (results.length === 0) {
        const titleRegex = /"title":"([^"]+)"/g;
        let tMatch;
        while ((tMatch = titleRegex.exec(rawHtml)) !== null && limit < 5) {
          if (tMatch[1].length > 10 && tMatch[1].toLowerCase().includes(query.toLowerCase().split(' ')[0])) {
             results.push(`Item Found: ${tMatch[1]}`);
             limit++;
          }
        }
      }
    }
    
    if (results.length > 0) {
      return JSON.stringify({ success: true, items: results, notice: "Send the user the direct links if they are interested." });
    } else {
      return JSON.stringify({ success: false, message: "Could not find any items right now or the marketplace blocked the bot." });
    }
  } catch(e) {
    console.error("OpenSooq Error:", e.message);
    return JSON.stringify({ success: false, message: "Marketplace server is currently down." });
  }
}

const aiTools = [
  {
    functionDeclarations: [
      {
        name: "search_opensooq",
        description: "Search the OpenSooq Kuwait marketplace for live items (like used phones, laptops, cars).",
        parameters: {
          type: "OBJECT",
          properties: {
            query: {
              type: "STRING",
              description: "The short search term (e.g., 'iPhone 13', 'Macbook Pro')"
            }
          },
          required: ["query"]
        }
      }
    ]
  }
];

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
        const finalPrompt = sysPrompt + "\n\nCRITICAL INSTRUCTION: If you want to offer the user clickable buttons (maximum 3), append them to the end of your message in this exact format: [BUTTON: Option 1] [BUTTON: Option 2]. Button text MUST be 20 characters or less. You also have access to a tool to search OpenSooq for items. If the user asks to buy or find an item, USE THE TOOL.";
        
        const modelsToTry = await getValidModelsList();
        let aiResponse = null;

        for (const modelName of modelsToTry) {
          try {
            console.log("TRYING MODEL:", modelName);
            const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
            const model = genAI.getGenerativeModel({ model: modelName });
            
            // PHASE 8: Init Chat with Tools
            const chat = model.startChat({
              tools: aiTools,
              history: [
                { role: "user", parts: [{ text: finalPrompt }] },
                { role: "model", parts: [{ text: "Understood." }] },
              ]
            });
            
            console.log("SENDING MESSAGE TO AI:", msgBody);
            const result = await chat.sendMessage(msgBody);
            const responseData = result.response;
            console.log("AI RAW RESPONSE:", JSON.stringify(responseData));
            
            // Check if AI decided to call a function by parsing the raw JSON
            let rawParts = [];
            try {
               rawParts = responseData.candidates[0].content.parts || [];
            } catch(err) {}
            
            const functionCallPart = rawParts.find(p => p.functionCall);
            
            if (functionCallPart) {
              const call = functionCallPart.functionCall;
              console.log("AI TRIGGERED FUNCTION:", call.name, "WITH ARGS:", call.args);
              
              if (call.name === "search_opensooq") {
                const apiResult = await searchOpenSooq(call.args.query || msgBody);
                console.log("SCRAPER RESULT:", apiResult);
                
                // Send API result back to Gemini as standard text to bypass the broken 'function' role in the SDK
                const secondResult = await chat.sendMessage(
                  `SYSTEM: The function '${call.name}' was executed successfully. Here is the JSON result:\n${apiResult}\n\n` +
                  `Please continue the conversation and formulate a helpful, natural reply to the user based on this data.`
                );
                aiResponse = secondResult.response.text();
              } else {
                aiResponse = "I got confused and tried to use a tool that doesn't exist: " + call.name;
              }
            } else {
              aiResponse = responseData.text();
              if (!aiResponse) aiResponse = "Sorry, I couldn't process that request properly.";
            }
            break; 
          } catch (e) { 
             console.log("AI LOOP EXCEPTION:", e.stack || e.message || e);
          }
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
