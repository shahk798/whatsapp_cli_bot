// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const mongoose = require('mongoose');

const Appointment = require('./models/Appointment');
const Session = require('./models/Session');

const app = express();
app.use(bodyParser.json());

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v18.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'verify_token';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp_bot_db';

const SERVICES = ["Dental Cleaning", "Teeth Whitening", "Tooth Extraction", "Consultation"];

async function connectDb() {
  await mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });
  console.log('Connected to MongoDB');
}
connectDb().catch(err => {
  console.error('MongoDB connection error', err);
  process.exit(1);
});

// Helper to send text message via Cloud API
async function sendTextMessage(toPhone, text) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: toPhone, // expect bare phone number string like '9198xxxxxxx' or include '+' as allowed
    type: "text",
    text: { body: text }
  };
  const headers = {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  };
  return axios.post(url, payload, { headers });
}

// Session helpers using Mongo
async function getSession(waId) {
  // waId expected to be 'whatsapp:+9198...'
  let session = await Session.findOne({ whatsapp_id: waId }).exec();
  if (!session) {
    session = new Session({ whatsapp_id: waId, state: 'MENU', data: {} });
    await session.save();
  }
  return session;
}
async function updateSession(waId, updates) {
  const opts = { upsert: true, new: true, setDefaultsOnInsert: true };
  const session = await Session.findOneAndUpdate(
    { whatsapp_id: waId },
    { $set: { ...updates, updated_at: Date.now() } },
    opts
  ).exec();
  return session;
}
async function resetSession(waId) {
  await Session.findOneAndDelete({ whatsapp_id: waId }).exec();
}

// Main menu text
function getMainMenuText() {
  return [
    "Welcome to Lumonex! Please choose an option by typing the number:",
    "1. Book Appointment",
    "2. Services",
    "3. Contact Info",
    "Type 'menu' anytime to return here."
  ].join('\n');
}

// Webhook GET for verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  res.sendStatus(400);
});

// Webhook POST: process incoming messages
app.post('/webhook', async (req, res) => {
  // Immediately reply 200 to Meta
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body || !Array.isArray(body.entry)) return;

    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const messages = value.messages || [];
        if (!messages.length) continue;

        for (const msg of messages) {
          // msg.from is phone number string like '9170xxxxxxx'
          const fromNumber = msg.from; // e.g., '9170xxxxxxx' (no 'whatsapp:' prefix)
          const waFrom = `whatsapp:${fromNumber}`;

          const incomingText = (msg.text && msg.text.body) ? msg.text.body.trim() : '';

          // ensure session exists
          let session = await getSession(waFrom);

          // allow menu/help
          const lower = (incomingText || '').toLowerCase();
          if (lower === 'menu' || lower === 'help') {
            await updateSession(waFrom, { state: 'MENU', data: {} });
            await sendTextMessage(fromNumber, getMainMenuText()).catch(err => console.error('send error', err?.response?.data || err.message));
            continue;
          }

          // route by session.state
          const state = session.state || 'MENU';

          switch (state) {
            case 'MENU':
              if (lower === '1' || incomingText.includes('book')) {
                await updateSession(waFrom, { state: 'ASK_SERVICE', data: {} });
                let options = "Which service would you like? Reply with the number:\n";
                SERVICES.forEach((s, i) => options += `${i+1}. ${s}\n`);
                await sendTextMessage(fromNumber, options).catch(err => console.error('send error', err?.response?.data || err.message));
              } else if (lower === '2' || incomingText.includes('service')) {
                let list = "Our Services:\n";
                SERVICES.forEach((s, i) => list += `${i+1}. ${s}\n`);
                list += "\nType 1 to Book an Appointment.";
                await sendTextMessage(fromNumber, list).catch(err => console.error('send error', err?.response?.data || err.message));
              } else if (lower === '3' || incomingText.includes('contact')) {
                await sendTextMessage(fromNumber, "Contact Lumonex:\nPhone: +91-98765-43210\nEmail: hello@lumonex.example\nType 1 to Book an Appointment.").catch(err => console.error('send error', err?.response?.data || err.message));
              } else {
                await sendTextMessage(fromNumber, "Sorry, I didn't understand. " + getMainMenuText()).catch(err => console.error('send error', err?.response?.data || err.message));
              }
              break;

            case 'ASK_SERVICE': {
              const idx = parseInt(incomingText);
              if (!isNaN(idx) && idx >= 1 && idx <= SERVICES.length) {
                const service = SERVICES[idx - 1];
                await updateSession(waFrom, { state: 'ASK_NAME', data: { service } });
                await sendTextMessage(fromNumber, `Great — you chose ${service}. Please tell me your full name.`).catch(err => console.error('send error', err?.response?.data || err.message));
              } else {
                await sendTextMessage(fromNumber, "Please reply with the number of the service from the list.").catch(err => console.error('send error', err?.response?.data || err.message));
              }
              break;
            }

            case 'ASK_NAME':
              session.data.name = incomingText;
              await updateSession(waFrom, { state: 'ASK_PHONE', data: session.data });
              await sendTextMessage(fromNumber, "Thanks. Please provide a phone number we can contact (e.g., +9198xxxx...).").catch(err => console.error('send error', err?.response?.data || err.message));
              break;

            case 'ASK_PHONE':
              session.data.phone = incomingText;
              await updateSession(waFrom, { state: 'ASK_DATE', data: session.data });
              await sendTextMessage(fromNumber, "Please provide preferred appointment date in YYYY-MM-DD format (e.g., 2025-12-01).").catch(err => console.error('send error', err?.response?.data || err.message));
              break;

            case 'ASK_DATE':
              if (!/^\d{4}-\d{2}-\d{2}$/.test(incomingText)) {
                await sendTextMessage(fromNumber, "Invalid format. Please provide date as YYYY-MM-DD (e.g., 2025-12-01).").catch(err => console.error('send error', err?.response?.data || err.message));
              } else {
                session.data.appointment_date = incomingText;
                await updateSession(waFrom, { state: 'ASK_TIME', data: session.data });
                await sendTextMessage(fromNumber, "Got it. What time do you prefer? (e.g., 10:30 AM or 14:30)").catch(err => console.error('send error', err?.response?.data || err.message));
              }
              break;

            case 'ASK_TIME':
              session.data.appointment_time = incomingText;
              // save appointment to MongoDB
              try {
                const appt = new Appointment({
                  whatsapp_number: waFrom,
                  name: session.data.name || null,
                  phone: session.data.phone || null,
                  service: session.data.service || null,
                  appointment_date: session.data.appointment_date || null,
                  appointment_time: session.data.appointment_time || null
                });
                await appt.save();

                const confirmText = `✅ Appointment confirmed!\n\nName: ${session.data.name}\nService: ${session.data.service}\nDate: ${session.data.appointment_date}\nTime: ${session.data.appointment_time}\n\nWe will contact you at ${session.data.phone} if needed.\n\nType 'menu' to go back to the main menu.`;
                await sendTextMessage(fromNumber, confirmText).catch(err => console.error('send error', err?.response?.data || err.message));
              } catch (err) {
                console.error('DB save error', err);
                await sendTextMessage(fromNumber, "Sorry, I couldn't save your appointment due to a server error. Please try again later.").catch(err => console.error('send error', err?.response?.data || err.message));
              }
              await resetSession(waFrom);
              break;

            default:
              await updateSession(waFrom, { state: 'MENU', data: {} });
              await sendTextMessage(fromNumber, getMainMenuText()).catch(err => console.error('send error', err?.response?.data || err.message));
              break;
          } // switch
        } // messages loop
      } // changes loop
    } // entry loop
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`WhatsApp Cloud bot (MongoDB) listening on port ${port}`));
