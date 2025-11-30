//modules/whatsapp.js
const axios = require('axios');
const Record = require('../models/Record'); // ensure path is correct for your project

const API_BASE = 'https://graph.facebook.com';

// --- WhatsApp sending helpers (kept from your original file) ---
async function sendText(clinicPhoneNumberId, to, text) {
  const url = `${API_BASE}/v16.0/${clinicPhoneNumberId}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text }
  };
  return callWhatsAppAPI(url, body);
}

async function sendInteractive(clinicPhoneNumberId, to, header, bodyText, buttons = []) {
  const url = `${API_BASE}/v16.0/${clinicPhoneNumberId}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      header: header ? { type: "text", text: header } : undefined,
      action: { buttons: buttons.map((b, i) => ({ type: "reply", reply: { id: b.id ?? `btn_${i}`, title: b.title } })) }
    }
  };
  return callWhatsAppAPI(url, body);
}

async function callWhatsAppAPI(url, body) {
  try {
    const res = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    });
    return res.data;
  } catch (err) {
    console.error('WhatsApp API error', err.response?.data || err.message);
    throw err;
  }
}

// --- Utility helpers for mapping / parsing / state ---
const userState = {}; // ephemeral per-phone in-memory state (optional)

function normalizePhone(raw) {
  if (!raw) return '';
  return String(raw).replace(/\s+/g, '').replace(/^\+/, '');
}

/**
 * Try to parse common date formats into a Date object.
 * Returns a Date object on success or null on failure.
 */
function parseDate(dateInput) {
  if (!dateInput) return null;
  // If already a Date instance and valid:
  if (dateInput instanceof Date && !isNaN(dateInput)) return dateInput;

  // Try direct ISO parse
  const iso = new Date(dateInput);
  if (!isNaN(iso)) return iso;

  const s = String(dateInput).trim();

  // Try common formats: DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD, YYYY/MM/DD
  const dmyMatch = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmyMatch) {
    const dd = Number(dmyMatch[1]), mm = Number(dmyMatch[2]), yyyy = Number(dmyMatch[3]);
    const d = new Date(yyyy, mm - 1, dd);
    if (!isNaN(d)) return d;
  }

  const ymdMatch = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (ymdMatch) {
    const yyyy = Number(ymdMatch[1]), mm = Number(ymdMatch[2]), dd = Number(ymdMatch[3]);
    const d = new Date(yyyy, mm - 1, dd);
    if (!isNaN(d)) return d;
  }

  // fallback: try Date.parse again with slashes replaced
  const alt = new Date(s.replace(/-/g, '/'));
  if (!isNaN(alt)) return alt;

  return null;
}

/**
 * Main webhook handler — maps incoming payload to the new flat Record model.
 * Expects payload to contain at least clinicId and phone information.
 *
 * @param {Object} payload - incoming webhook payload from your system
 * @returns {Object} - { ok: true, data: cleanJSON } or { ok: false, error: ... }
 */
async function handleWebhook(payload = {}) {
  try {
    // map clinic fields (adapt keys if your webhook uses different names)
    const clinicId = String(payload.clinicId || payload.clinic_id || (payload.clinic && payload.clinic._id) || '');
    const clinicName = payload.clinicName || payload.clinic_name || (payload.clinic && payload.clinic.name) || '';

    // phone mapping (various possible positions)
    const rawPhone = payload.phone || (payload.profile && payload.profile.wa_id) || (payload.from && payload.from.phone) || '';
    const phone = normalizePhone(rawPhone);
    if (!phone || !clinicId) {
      return { ok: false, error: 'missing_required_fields', message: 'clinicId and phone are required' };
    }

    // patient info mapping
    const patientName = payload.patientName || (payload.profile && (payload.profile.patientName || payload.profile.name)) || '';
    const email = payload.email || (payload.profile && payload.profile.email) || '';

    // service/price mapping
    const service = payload.service || (payload.metadata && payload.metadata.service) || (payload.profile && payload.profile.service) || '';
    const price = (typeof payload.price === 'number') ? payload.price :
                  (payload.price ? Number(payload.price) : ((payload.profile && payload.profile.price) ? Number(payload.profile.price) : Number(process.env.DEFAULT_PRICE || 0)));

    // date/time mapping — accept legacy keys appointmentDate / timeSlot too
    const dateRaw = payload.appointmentDate || payload.date || (payload.profile && payload.profile.appointmentDate) || null;
    const timeRaw = payload.timeSlot || payload.time || (payload.profile && payload.profile.timeSlot) || '';

    const date = parseDate(dateRaw); // Date or null
    const time = timeRaw || '';

    // If a date is present -> treat as an appointment creation/update
    if (date) {
      // check duplicates: same clinicId + same date (day) + same time
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);

      const duplicateQuery = {
        clinicId,
        date: { $gte: startOfDay, $lte: endOfDay },
        time: time
      };

      const existing = await Record.findOne(duplicateQuery).lean();
      if (existing && normalizePhone(existing.phone) !== phone) {
        // timeslot already taken by another patient
        return {
          ok: false,
          error: 'timeslot_unavailable',
          message: `The slot ${time || '[no time specified]'} on ${date.toISOString().split('T')[0]} is already booked.`
        };
      }

      // build appointment doc
      const appointmentDoc = {
        clinicId,
        clinicName: clinicName || '',
        patientName: patientName || '',
        phone,
        email: email || '',
        price: typeof price === 'number' ? price : Number(price || 0),
        service: service || '',
        status: 'booked', // adjust to 'confirmed' depending on flow
        date,
        time,
        source: payload.source || 'whatsapp',
        metadata: payload.metadata || {}
      };

      // Create appointment record. If a profile doc exists for same clinic+phone and has status profile,
      // we intentionally create a separate appointment record (profile docs are appointment-less).
      const created = await Record.create(appointmentDoc);
      return { ok: true, data: created.toCleanJSON(), raw: created };
    }

    // No date => create or update profile document (profile-only)
    const query = { clinicId, phone };
    const update = {
      clinicId,
      clinicName: clinicName || '',
      // only set fields if provided to avoid overwriting existing values with empty strings unintentionally
      ...(patientName ? { patientName } : {}),
      ...(email ? { email } : {}),
      ...(typeof price === 'number' ? { price } : {}),
      ...(service ? { service } : {}),
      status: 'profile',
      source: payload.source || 'whatsapp',
      metadata: payload.metadata || {}
    };

    // upsert profile
    const opts = { upsert: true, new: true, setDefaultsOnInsert: true };
    const profile = await Record.findOneAndUpdate(query, update, opts);
    return { ok: true, data: profile.toCleanJSON(), raw: profile };

  } catch (err) {
    console.error('WhatsApp webhook handler error:', err);
    return { ok: false, error: 'server_error', details: err.message || String(err) };
  }
}

// Export everything
module.exports = {
  // sending helpers (existing)
  sendText,
  sendInteractive,
  // webhook + utilities (new)
  handleWebhook,
  normalizePhone,
  parseDate,
  userState
};
