<<<<<<< HEAD
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const chatlogic = require('./chatlogic');
const clinicsConfig = require('./utils/clinicsConfig');
=======
// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const mongoose = require('mongoose');

const chatlogic = require('./chatlogic');
const Appointment = require('./models/Appointment');
const Session = require('./models/Session');
>>>>>>> e20e93a863e53ba526b09c50f43bee7ce030954e

const app = express();
app.use(bodyParser.json());

<<<<<<< HEAD
// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true, useUnifiedTopology: true
}).then(() => console.log('🗄️  MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error', err));

// Webhook verification (Meta)
app.get('/webhook', (req, res) => {
  const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN || 'your_verify_token';
=======
// ---------------- CONFIG ----------------
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v20.0';
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'verify_token';
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_RELOAD_TOKEN = process.env.ADMIN_RELOAD_TOKEN || '';
const PORT = process.env.PORT || 3000;

if (!MONGODB_URI) {
  console.error('❌ FATAL: MONGODB_URI env var not set. Add it and restart.');
  process.exit(1);
}

// ---------------- CLINIC ENV PARSER ----------------
// Expect per-clinic env vars:
// CLINIC_COUNT=N
// CLINIC_1_NAME, CLINIC_1_PHONE_NUMBER_ID, CLINIC_1_ACCESS_TOKEN, CLINIC_1_DISPLAY_PHONE
// CLINIC_2_NAME, ...
let clinics = [];
const clinicsByPhoneId = new Map();
const clinicsByName = new Map();

function loadClinicsFromEnvByCount() {
  clinics = [];
  clinicsByPhoneId.clear();
  clinicsByName.clear();

  const rawCount = process.env.CLINIC_COUNT || '0';
  const count = Number(rawCount) || 0;

  for (let i = 1; i <= count; i++) {
    const prefix = `CLINIC_${i}_`;
    const name = process.env[`${prefix}NAME`];
    const phoneId = process.env[`${prefix}PHONE_NUMBER_ID`];
    const token = process.env[`${prefix}ACCESS_TOKEN`];
    const displayPhone = process.env[`${prefix}DISPLAY_PHONE`];

    if (!name || !phoneId || !token) {
      console.warn(`CLINIC_${i} incomplete — skipping. Need NAME, PHONE_NUMBER_ID, ACCESS_TOKEN.`);
      continue;
    }

    const clinic = {
      name: String(name),
      phone_number_id: String(phoneId),
      access_token: String(token),
      display_phone: displayPhone ? String(displayPhone) : null
    };

    clinics.push(clinic);
    clinicsByPhoneId.set(String(clinic.phone_number_id), clinic);
    if (clinic.name) clinicsByName.set(String(clinic.name).toLowerCase(), clinic);
  }

  console.log(`Loaded ${clinics.length} clinic(s) from env (CLINIC_COUNT=${count})`);
}
loadClinicsFromEnvByCount();

// ---------------- MONGO CONNECT ----------------
async function connectDb() {
  try {
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ Connected to MongoDB');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err?.message || err);
    process.exit(1);
  }
}
connectDb();

// ---------------- HELPERS ----------------
function findClinicForChange(change) {
  const value = (change && change.value) ? change.value : {};
  const metadata = value.metadata || {};

  // primary: phone_number_id (recommended)
  const phoneId = metadata.phone_number_id || metadata.phone_number;
  if (phoneId && clinicsByPhoneId.has(String(phoneId))) {
    return clinicsByPhoneId.get(String(phoneId));
  }

  // fallback: display phone
  const displayPhone = metadata.display_phone_number || metadata.display_phone;
  if (displayPhone) {
    for (const c of clinics) {
      if (c.display_phone && String(c.display_phone) === String(displayPhone)) return c;
    }
  }

  // fallback: contact profile name
  const businessName = (value.contacts && value.contacts[0] && value.contacts[0].profile && value.contacts[0].profile.name) || null;
  if (businessName && clinicsByName.has(String(businessName).toLowerCase())) {
    return clinicsByName.get(String(businessName).toLowerCase());
  }

  return null;
}

async function sendTextMessageForClinic(clinic, toPhone, text) {
  if (!clinic || !clinic.phone_number_id || !clinic.access_token) {
    const errMsg = 'Missing clinic credentials (phone_number_id or access_token)';
    console.error('sendTextMessageForClinic error:', errMsg);
    throw new Error(errMsg);
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${clinic.phone_number_id}/messages`;
  const toNormalized = String(toPhone).replace(/^whatsapp:/, '').replace(/^\+/, '');

  const payload = {
    messaging_product: "whatsapp",
    to: toNormalized,
    type: "text",
    text: { body: text }
  };

  const headers = {
    Authorization: `Bearer ${clinic.access_token}`,
    'Content-Type': 'application/json'
  };

  try {
    const resp = await axios.post(url, payload, { headers });
    return resp.data;
  } catch (err) {
    console.error('sendTextMessageForClinic axios error:', err?.response?.data || err?.message);
    throw err;
  }
}

// Session helpers (scoped by clinic_key and whatsapp_id)
async function getSessionForClinicKey(clinicKey, waId) {
  let session = await Session.findOne({ clinic_key: clinicKey, whatsapp_id: waId }).exec();
  if (!session) {
    session = new Session({ clinic_key: clinicKey, whatsapp_id: waId, state: 'MENU', data: {} });
    await session.save();
  }
  return session;
}

async function updateSessionForClinicKey(clinicKey, waId, updates) {
  const opts = { upsert: true, new: true, setDefaultsOnInsert: true };
  const session = await Session.findOneAndUpdate(
    { clinic_key: clinicKey, whatsapp_id: waId },
    { $set: { ...updates, updated_at: Date.now() } },
    opts
  ).exec();
  return session;
}

async function resetSessionForClinicKey(clinicKey, waId) {
  await Session.findOneAndDelete({ clinic_key: clinicKey, whatsapp_id: waId }).exec();
}

// ---------------- ROUTES ----------------
app.get('/health', (req, res) => res.json({ status: 'ok', clinicsLoaded: clinics.length }));

// Admin: reload from process.env (protected by ADMIN_RELOAD_TOKEN)
app.post('/admin/reload-clinics', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (!ADMIN_RELOAD_TOKEN || token !== ADMIN_RELOAD_TOKEN) return res.status(403).json({ error: 'forbidden' });
  loadClinicsFromEnvByCount();
  return res.json({ ok: true, clinicsLoaded: clinics.length });
});

// Webhook verification GET
app.get('/webhook', (req, res) => {
>>>>>>> e20e93a863e53ba526b09c50f43bee7ce030954e
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

<<<<<<< HEAD
  if (mode && token === verifyToken) {
    console.log('🔐 Webhook verified');
    return res.status(200).send(challenge);
  }
  console.log('⚠️ Webhook verification failed');
  return res.sendStatus(403);
});

// Incoming webhook receiver (shared for all clinics)
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value || req.body;
    const messages = value?.messages;

    // detect Meta phone_number_id to map to clinic config
    const phoneNumberId = value?.metadata?.phone_number_id || value?.metadata?.phone_id;

    const clinic = clinicsConfig.findClinicByPhoneNumberId(phoneNumberId);

    if (!clinic) {
      console.warn('⚠️ Incoming message for unknown clinic phone_number_id:', phoneNumberId);
      // still pass clinic=null — chatlogic will fallback if single clinic exists
    }

    if (messages && messages.length) {
      for (const message of messages) {
        await chatlogic.handleIncomingMessage(message, value, clinic);
      }
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error('❌ Webhook handling error', err);
    return res.sendStatus(500);
  }
});

// Health + quick info
app.get('/', (req, res) => {
  const clinics = clinicsConfig.getAllClinics().map(c => `${c.clinicId}:${c.clinicName}`).join(', ');
  res.send(`🦷 Lumonex Chatbot running — Clinics: ${clinics}`);
});

/**
 * CRM endpoints (no auth by default — add auth in production)
 * - List records for clinic
 * - Get / Create / Update record (single collection)
 */
const Record = require('./models/Record');

// list records for clinic (query filters supported)
app.get('/crm/:clinicId/records', async (req, res) => {
  try {
    const { clinicId } = req.params;
    const { status, phone, from, to, limit = 500 } = req.query;
    const q = { clinicId };
    if (status) q.status = status;
    if (phone) q.phone = phone;
    if (from || to) {
      q.appointmentDate = {};
      if (from) q.appointmentDate.$gte = new Date(from);
      if (to) q.appointmentDate.$lte = new Date(to);
    }
    const records = await Record.find(q).sort({ appointmentDate: -1 }).limit(Number(limit));
    return res.json({ success: true, data: records });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// get single record
app.get('/crm/:clinicId/record/:id', async (req, res) => {
  try {
    const { clinicId, id } = req.params;
    const rec = await Record.findOne({ _id: id, clinicId });
    if (!rec) return res.status(404).json({ success: false, error: 'Not found' });
    return res.json({ success: true, data: rec });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// create record manually (staff)
app.post('/crm/:clinicId/record', async (req, res) => {
  try {
    const { clinicId } = req.params;
    const clinics = clinicsConfig.getAllClinics();
    const clinic = clinicsConfig.findClinicById(clinicId);
    if (!clinic) return res.status(400).json({ success: false, error: 'Invalid clinicId' });

    const payload = {
      clinicId,
      clinicName: clinic.clinicName,
      patientName: req.body.patientName || '',
      phone: req.body.phone,
      email: req.body.email || '',
      service: req.body.service || '',
      price: Number(req.body.price || process.env.DEFAULT_PRICE || 0),
      appointmentDate: new Date(req.body.appointmentDate),
      timeSlot: req.body.timeSlot || '',
      status: req.body.status || 'booked',
      source: req.body.source || 'manual',
      metadata: req.body.metadata || {}
    };

    const rec = await Record.create(payload);

    // notify clinic staff via WhatsApp to contactNumber
    const whatsapp = require('./modules/whatsapp');
    const contactMsg = `📣 New appointment created manually:
🦷 ${rec.service}
👤 ${rec.patientName} (${rec.phone})
📅 ${rec.appointmentDate.toISOString().slice(0,10)} ${rec.timeSlot}
🔖 Record ID: ${rec._id}`;
    try {
      await whatsapp.sendText(clinic.phoneNumberId, clinic.contactNumber, contactMsg);
    } catch (err) {
      console.error('Failed to notify clinic staff', err);
    }

    return res.json({ success: true, data: rec });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// update a record (partial update) — scoped to clinicId
app.put('/crm/:clinicId/record/:id', async (req, res) => {
  try {
    const { clinicId, id } = req.params;
    const update = req.body;
    const rec = await Record.findOneAndUpdate({ _id: id, clinicId }, update, { new: true });
    if (!rec) return res.status(404).json({ success: false, error: 'Not found' });
    return res.json({ success: true, data: rec });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
=======
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

// Webhook POST — incoming
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // ack early

  try {
    const body = req.body;
    if (!body || !Array.isArray(body.entry)) return;

    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        const clinic = findClinicForChange(change);
        if (!clinic) {
          console.warn('No clinic matched for incoming change. Metadata:', JSON.stringify((change.value && change.value.metadata) || {}));
          continue;
        }

        const value = change.value || {};
        const messages = value.messages || [];
        if (!messages.length) continue;

        for (const msg of messages) {
          const fromNumber = msg.from; // e.g., '9198...'
          const waFrom = `whatsapp:${fromNumber}`;
          const incomingText = (msg.text && msg.text.body) ? msg.text.body.trim() : '';

          const clinicKey = String(clinic.phone_number_id);
          const session = await getSessionForClinicKey(clinicKey, waFrom);

          await chatlogic.handleIncomingMessage({
            clinic,
            session,
            incomingText,
            fromNumber,
            // bind send/update/reset to clinic
            sendTextMessage: (to, text) => sendTextMessageForClinic(clinic, to, text),
            updateSession: (waId, updates) => updateSessionForClinicKey(clinicKey, waId, updates),
            resetSession: (waId) => resetSessionForClinicKey(clinicKey, waId),
            Appointment,
            waFrom
          });
        }
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err?.response?.data || err?.message || err);
  }
});

// ---------------- START ----------------
app.listen(PORT, () => {
  console.log(`WhatsApp Cloud single-webhook multi-clinic bot listening on port ${PORT}`);
});
>>>>>>> e20e93a863e53ba526b09c50f43bee7ce030954e
