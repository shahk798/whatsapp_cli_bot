require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const chatlogic = require('./chatlogic');
const clinicsConfig = require('./utils/clinicsConfig');

const app = express();
app.use(bodyParser.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true, useUnifiedTopology: true
}).then(() => console.log('🗄️  MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error', err));

// Webhook verification (Meta)
app.get('/webhook', (req, res) => {
  const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN || 'your_verify_token';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

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
// add near your other CRM endpoints in server.js
const Record = require('./models/Record');

// list patient profiles for clinic (appointmentDate == null)
app.get('/crm/:clinicId/patients', async (req, res) => {
  try {
    const { clinicId } = req.params;
    const { limit = 500, q } = req.query;

    const query = { clinicId, appointmentDate: null };
    // optional search by name or phone (q)
    if (q) {
      query.$or = [
        { patientName: { $regex: q, $options: 'i' } },
        { phone: { $regex: q, $options: 'i' } }
      ];
    }

    const patients = await Record.find(query).sort({ updatedAt: -1 }).limit(Number(limit));
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
