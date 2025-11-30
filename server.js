// server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const chatlogic = require('./chatlogic');
const clinicsConfig = require('./utils/clinicsConfig');
const Record = require('./models/Record');
const whatsappModule = require('./modules/whatsapp');

const app = express();

// Basic middleware
app.use(cors()); // allow cross-origin requests (adjust in prod)
app.use(express.json({ limit: '100kb' })); // modern replacement for bodyParser.json
app.use(express.urlencoded({ extended: true }));

// Required env checks
if (!process.env.MONGO_URI) {
  console.error('❌ MONGO_URI is not defined in environment — please set MONGO_URI');
  process.exit(1);
}

const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'your_verify_token';

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
  .then(() => console.log('🗄️  MongoDB connected'))
  .catch(err => {
    console.error('❌ MongoDB connection error', err);
    process.exit(1);
  });

// --- Webhook verification (Meta) ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Meta usually sends mode === 'subscribe' for verification
  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('🔐 Webhook verified');
    return res.status(200).send(challenge);
  }

  console.warn('⚠️ Webhook verification failed', { mode, tokenProvided: !!token });
  return res.sendStatus(403);
});

// --- Incoming webhook receiver (shared for all clinics) ---
app.post('/webhook', async (req, res) => {
  try {
    // Meta's webhook shape contains entry -> changes -> value -> messages
    const entry = Array.isArray(req.body.entry) ? req.body.entry[0] : req.body.entry;
    const changes = entry?.changes?.[0];
    const value = changes?.value || req.body;
    const messages = value?.messages || [];

    // detect Meta phone_number_id (different fields used in different payloads)
    const phoneNumberId = value?.metadata?.phone_number_id || value?.metadata?.phone_id || value?.phone_number_id;

    const clinic = phoneNumberId ? clinicsConfig.findClinicByPhoneNumberId(phoneNumberId) : null;

    if (!clinic) {
      console.warn('⚠️ Incoming message for unknown clinic phone_number_id:', phoneNumberId);
      // Keep processing — chatlogic will attempt to resolve single-clinic fallback if available
    }

    // messages may be empty or single object
    if (messages && messages.length) {
      // process sequentially to preserve session order
      for (const message of messages) {
        try {
          await chatlogic.handleIncomingMessage(message, value, clinic);
        } catch (err) {
          console.error('❌ Error handling individual message', err);
        }
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('❌ Webhook handling error', err);
    return res.sendStatus(500);
  }
});

// --- Health + quick info ---
app.get('/', (req, res) => {
  const clinics = (typeof clinicsConfig.getAllClinics === 'function')
    ? clinicsConfig.getAllClinics().map(c => `${c.clinicId}:${c.clinicName}`).join(', ')
    : 'none';
  res.send(`🦷 Lumonex Chatbot running — Clinics: ${clinics}`);
});

/**
 * CRM endpoints (no auth by default — add auth in production)
 */

// list patient profiles for clinic (profile marker: either date or appointmentDate is null)
app.get('/crm/:clinicId/patients', async (req, res) => {
  try {
    const { clinicId } = req.params;
    const rawLimit = req.query.limit || '500';
    const limit = Math.min(1000, Math.max(1, Number(rawLimit) || 500));
    const q = req.query.q;

    // accept profiles where profile marker is null (older code used date:null; other code used appointmentDate:null)
    const query = {
      clinicId,
      $or: [
        { date: null },
        { appointmentDate: null },
        { date: { $exists: false } },
        { appointmentDate: { $exists: false } }
      ]
    };

    if (q) {
      query.$and = [{
        $or: [
          { patientName: { $regex: q, $options: 'i' } },
          { phone: { $regex: q, $options: 'i' } }
        ]
      }];
    }

    const patients = await Record.find(query).sort({ updatedAt: -1 }).limit(limit);
    return res.json({ success: true, data: patients });
  } catch (err) {
    console.error('Error fetching patient profiles:', err);
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
    console.error('Error fetching record:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// create record manually (staff)
app.post('/crm/:clinicId/record', async (req, res) => {
  try {
    const { clinicId } = req.params;
    const clinic = clinicsConfig.findClinicById(clinicId);
    if (!clinic) return res.status(400).json({ success: false, error: 'Invalid clinicId' });

    // Support both shapes: appointmentDate OR date
    const incomingDate = req.body.appointmentDate || req.body.date || req.body.dateISO;
    const parsedDate = incomingDate ? new Date(incomingDate) : null;

    const payload = {
      clinicId,
      clinicName: clinic.clinicName,
      patientName: req.body.patientName || '',
      phone: req.body.phone,
      email: req.body.email || '',
      service: req.body.service || '',
      price: Number(req.body.price || process.env.DEFAULT_PRICE || 0),
      // store both for compatibility
      appointmentDate: parsedDate,
      date: parsedDate,
      timeSlot: req.body.timeSlot || req.body.time || '',
      time: req.body.time || req.body.timeSlot || '',
      status: req.body.status || 'booked',
      source: req.body.source || 'manual',
      metadata: req.body.metadata || {},
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const rec = await Record.create(payload);

    // notify clinic staff via WhatsApp to contactNumber (if available)
    try {
      const contactMsg = `📣 New appointment created manually:
🦷 ${rec.service}
👤 ${rec.patientName} (${rec.phone})
📅 ${rec.appointmentDate ? rec.appointmentDate.toISOString().slice(0, 10) : 'N/A'} ${rec.timeSlot || rec.time}
🔖 Record ID: ${rec._id}`;
      if (clinic.phoneNumberId && clinic.contactNumber) {
        await whatsappModule.sendText(clinic.phoneNumberId, clinic.contactNumber, contactMsg);
      } else {
        console.log('ℹ️ Clinic contact not configured, skipping WhatsApp notification', clinicId);
      }
    } catch (err) {
      console.error('Failed to notify clinic staff', err);
    }

    return res.json({ success: true, data: rec });
  } catch (err) {
    console.error('Error creating record:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// update a record (partial update) — scoped to clinicId
app.put('/crm/:clinicId/record/:id', async (req, res) => {
  try {
    const { clinicId, id } = req.params;
    const update = { ...req.body, updatedAt: new Date() };

    // if update contains appointmentDate or date strings, convert to Date object
    if (update.appointmentDate && typeof update.appointmentDate === 'string') update.appointmentDate = new Date(update.appointmentDate);
    if (update.date && typeof update.date === 'string') update.date = new Date(update.date);

    const rec = await Record.findOneAndUpdate({ _id: id, clinicId }, update, { new: true });
    if (!rec) return res.status(404).json({ success: false, error: 'Not found' });
    return res.json({ success: true, data: rec });
  } catch (err) {
    console.error('Error updating record:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
