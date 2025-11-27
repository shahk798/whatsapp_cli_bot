// chatlogic.js
// Professional chat flow:
// greeting -> ask patient name -> main menu (services/prices, book, hours, address, FAQs)
// booking collects: phone number, email, service, appointment date, time -> confirm -> create appointment
// Session stored on profile document (Record.session). Appointment created as separate Record (appointmentDate != null).

const Record = require('./models/Record');
const clinicsConfig = require('./utils/clinicsConfig');
const whatsapp = require('./modules/whatsapp');
const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
const utc = require('dayjs/plugin/utc');
dayjs.extend(customParseFormat);
dayjs.extend(utc);

const SESSION_TTL_MIN = 30;            // session expiry (minutes)
const DEFAULT_PRICE = Number(process.env.DEFAULT_PRICE || 0);

// Services list (editable)
const SERVICES = [
  { key: 'cleaning', name: 'Cleaning', price: 500 },
  { key: 'whitening', name: 'Whitening', price: 2000 },
  { key: 'braces', name: 'Braces', price: 35000 },
  { key: 'rct', name: 'RCT', price: 3000 },
  { key: 'implant', name: 'Implant', price: 25000 }
];

// Main menu (professional + numbers + keywords)
const MAIN_MENU_TEXT = `📋 *Main Menu* — reply with a number or keyword:
1️⃣ *Services & Pricing*  — (reply "1" or "services" / "price")
2️⃣ *Book Appointment*    — (reply "2" or "book" / "appointment")
3️⃣ *Clinic Hours*        — (reply "3" or "hours" / "timings")
4️⃣ *Clinic Address*      — (reply "4" or "address" / "location")
5️⃣ *FAQs*                — (reply "5" or "faq" / "help")
You can type *menu* anytime to return here.`;

function textFromMessage(message) {
  if (!message) return '';
  if (message.text?.body) return message.text.body.trim();
  if (message.button) return message.button?.payload || message.button?.text;
  if (message.interactive?.type === 'button_reply') return message.interactive?.button_reply?.title || message.interactive?.button_reply?.id;
  if (message.interactive?.type === 'list_reply') return message.interactive?.list_reply?.title;
  return '';
}
function normalize(text) {
  return (text || '').toString().trim();
}
function normalizeForRouting(text) {
  return normalize(text).toLowerCase();
}

// Date/time parsing & normalization
function parseDateStrict(text) {
  if (!text) return null;
  const formats = ['DD-MM-YYYY', 'D-M-YYYY', 'DD/MM/YYYY', 'D/M/YYYY', 'YYYY-MM-DD'];
  for (const f of formats) {
    const d = dayjs(text, f, true);
    if (d.isValid()) return d;
  }
  const loose = dayjs(text);
  return loose.isValid() ? loose : null;
}
function normalizeTime(text) {
  if (!text) return null;
  let t = text.replace(/\./g, ':').trim();
  // try strict formats first
  const parsed = dayjs(t, ['H:mm', 'HH:mm', 'h:mm A', 'h A', 'ha', 'H'], true);
  if (parsed.isValid()) return parsed.format('HH:mm');
  const loose = dayjs(t);
  return loose.isValid() ? loose.format('HH:mm') : null;
}

// Simple email & phone validation (basic)
function validEmail(email) {
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function normalizePhone(p) {
  if (!p) return null;
  // remove spaces, +, hyphens, parentheses
  let cleaned = p.replace(/[\s+\-()]/g, '');
  // if starts with 0 or country code, accept common lengths
  if (!/^\d+$/.test(cleaned)) return null;
  return cleaned;
}
function validPhoneNumber(p) {
  if (!p) return false;
  // accept 10-15 digits (common)
  return /^\d{10,15}$/.test(p);
}

async function loadOrCreateProfile(clinicId, clinicName, phone, metadata = {}) {
  let profile = await Record.findOne({ clinicId, phone, appointmentDate: null });
  if (!profile) {
    profile = await Record.create({
      clinicId,
      clinicName,
      phone,
      patientName: '',
      appointmentDate: null,
      status: 'profile',
      source: 'whatsapp',
      metadata
    });
  }
  return profile;
}

function sessionExpired(session) {
  if (!session) return true;
  if (!session.updatedAt) return true;
  const ageMin = (Date.now() - new Date(session.updatedAt).getTime()) / (1000 * 60);
  return ageMin > SESSION_TTL_MIN;
}

async function saveSession(profileId, sessionObj) {
  const update = {
    'session.state': sessionObj.state,
    'session.data': sessionObj.data,
    'session.updatedAt': new Date(),
    'session.expiresAt': new Date(Date.now() + SESSION_TTL_MIN * 60 * 1000)
  };
  return Record.findByIdAndUpdate(profileId, { $set: update }, { new: true });
}
async function clearSession(profileId) {
  return Record.findByIdAndUpdate(profileId, { $unset: { session: '' } }, { new: true });
}

async function safeSendText(phoneNumberId, to, text) {
  try {
    await whatsapp.sendText(phoneNumberId, to, text);
  } catch (err) {
    console.error('WhatsApp send error:', err?.response?.data || err.message || err);
  }
}

function servicesListText() {
  return SERVICES.map((s, i) => `${i+1}. ${s.name} — ₹${s.price.toLocaleString()}`).join('\n');
}

function resolveClinic(value, clinicFromCaller) {
  if (clinicFromCaller) return clinicFromCaller;
  if (value?.metadata?.phone_number_id) {
    return clinicsConfig.findClinicByPhoneNumberId(value.metadata.phone_number_id) || null;
  }
  const all = clinicsConfig.getAllClinics();
  return all.length === 1 ? all[0] : null;
}

// ---------- Main handler ----------
async function handleIncomingMessage(message, value, clinicFromCaller) {
  const from = message.from;
  const raw = textFromMessage(message);
  const text = normalize(raw);
  const textLower = normalizeForRouting(raw);

  const clinic = resolveClinic(value, clinicFromCaller);
  const clinicId = clinic?.clinicId || (clinicFromCaller && clinicFromCaller.clinicId) || 'default';
  const clinicName = clinic?.clinicName || 'Clinic';
  const clinicPhoneNumberId = clinic?.phoneNumberId || clinicFromCaller?.phoneNumberId || null;

  console.log(`📩 Incoming from ${from} (clinic=${clinicId}):`, raw);

  let profile;
  try {
    profile = await loadOrCreateProfile(clinicId, clinicName, from, value?.contacts?.[0] || value?.metadata || {});
  } catch (err) {
    console.error('Failed to load/create profile:', err);
    await safeSendText(clinicPhoneNumberId, from, '❌ Internal error. Please try again later.');
    return;
  }

  // load session or initialize
  let session = profile.session || { state: 'idle', data: {}, updatedAt: new Date() };
  if (sessionExpired(session)) {
    session = { state: 'idle', data: { clinicId, clinicName }, updatedAt: new Date() };
    await saveSession(profile._id, session);
  }

  // greet / ask name flow (priority)
  if (/^(hi|hello|hey|start|menu)$/i.test(textLower)) {
    // if we don't have a patientName for this profile, ask it
    if (!profile.patientName || profile.patientName.trim() === '') {
      session.state = 'asking_name';
      session.data = { clinicId, clinicName };
      await saveSession(profile._id, session);
      return safeSendText(clinicPhoneNumberId, from, '👋 Hello — may I have the *patient full name* please?');
    } else {
      session.state = 'idle';
      session.data = { clinicId, clinicName };
      await saveSession(profile._id, session);
      return safeSendText(clinicPhoneNumberId, from, `Hi *${profile.patientName}* 👋\n` + MAIN_MENU_TEXT);
    }
  }

  // allow 'menu' anytime
  if (textLower === 'menu') {
    session.state = 'idle';
    session.data = { clinicId, clinicName };
    await saveSession(profile._id, session);
    return safeSendText(clinicPhoneNumberId, from, MAIN_MENU_TEXT);
  }

  // If asking_name state
  if (session.state === 'asking_name') {
    const name = text;
    if (!name || name.length < 2) {
      return safeSendText(clinicPhoneNumberId, from, '❗ Please send the full patient name (at least 2 characters).');
    }
    // save to profile
    try {
      await Record.findByIdAndUpdate(profile._id, { $set: { patientName: name, updatedAt: new Date() } });
    } catch (err) {
      console.error('Failed to save patientName:', err);
    }
    session.state = 'idle';
    session.data = { clinicId, clinicName };
    await saveSession(profile._id, session);
    return safeSendText(clinicPhoneNumberId, from, `Thanks *${name}* —\n` + MAIN_MENU_TEXT);
  }

  // Map number selection or keywords to menu options
  const numberMatch = text.match(/^[1-5]$/);
  if (numberMatch) {
    return routeMenu(numberMatch[0], profile, session, clinicPhoneNumberId);
  }
  // keyword routing (book/services/hours/address/faqs)
  if (/book|appointment|slot/i.test(text)) return routeMenu('2', profile, session, clinicPhoneNumberId);
  if (/service|services|price|pricing/i.test(text)) return routeMenu('1', profile, session, clinicPhoneNumberId);
  if (/hour|time|timings|opening|open/i.test(text)) return routeMenu('3', profile, session, clinicPhoneNumberId);
  if (/address|location|where/i.test(text)) return routeMenu('4', profile, session, clinicPhoneNumberId);
  if (/faq|help|question/i.test(text)) return routeMenu('5', profile, session, clinicPhoneNumberId);

  // If we are in booking flow states, continue accordingly
  switch (session.state) {
    case 'booking_service':
      return handleBookingServiceInput(profile, session, text, clinicPhoneNumberId);
    case 'booking_phone':
      return handleBookingPhoneInput(profile, session, text, clinicPhoneNumberId);
    case 'booking_email':
      return handleBookingEmailInput(profile, session, text, clinicPhoneNumberId);
    case 'booking_date':
      return handleBookingDateInput(profile, session, text, clinicPhoneNumberId);
    case 'booking_time':
      return handleBookingTimeInput(profile, session, text, clinicPhoneNumberId);
    case 'booking_confirm':
      return handleBookingConfirmInput(profile, session, text, clinicPhoneNumberId);
    default:
      // Not a menu number, not in a booking state — guide the user
      return safeSendText(clinicPhoneNumberId, from, `I didn't understand that. ${MAIN_MENU_TEXT}`);
  }
}

// ---------- Menu routing ----------
async function routeMenu(opt, profile, session, clinicPhoneNumberId) {
  const from = profile.phone;
  switch (opt) {
    case '1': { // Services & Pricing
      session.state = 'idle';
      session.data = session.data || {};
      await saveSession(profile._id, session);
      const msg = `🦷 *Services & Pricing*\n\n${servicesListText()}\n\nReply with the service name or number to start booking.`;
      return safeSendText(clinicPhoneNumberId, from, msg);
    }
    case '2': { // Book Appointment
      // start booking: prefer existing profile.patientName
      session.state = 'booking_phone'; // we will ask phone first (or confirm)
      session.data = session.data || {};
      // prefill name if exists
      if (profile.patientName) session.data.name = profile.patientName;
      await saveSession(profile._id, session);
      // Prompt: use WA number by default, give option to enter alternative phone
      const defaultPhone = profile.phone || '';
      const prompt = defaultPhone
        ? `📞 We have *${formatPhoneForPrompt(defaultPhone)}* as your contact number. Reply with a different phone number to use it for this booking, or type *ok* to use the shown number.`
        : '📞 Please provide the patient phone number (digits only, include country code).';
      return safeSendText(clinicPhoneNumberId, from, prompt);
    }
    case '3': { // Clinic Hours
      session.state = 'idle';
      await saveSession(profile._id, session);
      const clinicObj = clinicsConfig.findClinicById(profile.clinicId) || {};
      const hours = clinicObj.hours || 'Mon–Sat 9:00 AM – 7:00 PM';
      return safeSendText(clinicPhoneNumberId, from, `⏰ *Clinic Hours*: ${hours}`);
    }
    case '4': { // Clinic Address
      session.state = 'idle';
      await saveSession(profile._id, session);
      const clinicObj = clinicsConfig.findClinicById(profile.clinicId) || {};
      const address = clinicObj.address || 'Address not available. Please contact reception.';
      return safeSendText(clinicPhoneNumberId, from, `📍 *Clinic Address*: ${address}`);
    }
    case '5': { // FAQs
      session.state = 'idle';
      await saveSession(profile._id, session);
      const faqs = [
        '*How do I book?* — Reply "book" or press 2.',
        '*What are your hours?* — Reply "hours" or press 3.',
        '*Do you accept insurance?* — Please call reception to confirm.',
        '*How long is a cleaning?* — Usually 30–45 minutes.'
      ].join('\n\n');
      return safeSendText(clinicPhoneNumberId, profile.phone, `❓ *FAQs*\n\n${faqs}`);
    }
    default:
      session.state = 'idle';
      await saveSession(profile._id, session);
      return safeSendText(clinicPhoneNumberId, profile.phone, MAIN_MENU_TEXT);
  }
}

// ---------- Booking handlers ----------
// booking_phone: ask or confirm phone to use for booking
async function handleBookingPhoneInput(profile, session, text, clinicPhoneNumberId) {
  const from = profile.phone;
  const trimmed = text.toLowerCase();
  // if user replied 'ok' or 'use' or blank -> accept default profile phone
  if (trimmed === 'ok' || trimmed === 'use' || trimmed === '' || trimmed === 'yes') {
    const phone = profile.phone;
    session.data.phone = phone;
    session.state = 'booking_email';
    await saveSession(profile._id, session);
    return safeSendText(clinicPhoneNumberId, from, '✉️ Please provide an email address for confirmation (or type "skip").');
  }
  // else, expect a phone number
  const cleaned = normalizePhone(text);
  if (!cleaned || !validPhoneNumber(cleaned)) {
    return safeSendText(clinicPhoneNumberId, from, '❗ Please send a valid phone number (digits only, include country code). Example: 919812345678');
  }
  session.data.phone = cleaned;
  session.state = 'booking_email';
  await saveSession(profile._id, session);
  return safeSendText(clinicPhoneNumberId, from, '✉️ Please provide an email address for confirmation (or type "skip").');
}

// booking_email: collect email (optional)
async function handleBookingEmailInput(profile, session, text, clinicPhoneNumberId) {
  const from = profile.phone;
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === 'skip') {
    session.data.email = '';
    session.state = 'booking_service';
    await saveSession(profile._id, session);
    return presentServiceOptions(profile, session, clinicPhoneNumberId);
  }
  if (!validEmail(trimmed)) {
    return safeSendText(clinicPhoneNumberId, from, '❗ Please send a valid email address (example: name@example.com) or type "skip".');
  }
  session.data.email = trimmed;
  session.state = 'booking_service';
  await saveSession(profile._id, session);
  return presentServiceOptions(profile, session, clinicPhoneNumberId);
}

async function presentServiceOptions(profile, session, clinicPhoneNumberId) {
  const from = profile.phone;
  const list = servicesListText();
  session.state = 'booking_service';
  await saveSession(profile._id, session);
  return safeSendText(clinicPhoneNumberId, from, `🦷 *Select a service*:\n\n${list}\n\nReply with the service name or number (e.g. "Braces" or "3").`);
}

function servicesListText() {
  return SERVICES.map((s, i) => `${i+1}. ${s.name} — ₹${s.price.toLocaleString()}`).join('\n');
}

async function handleBookingServiceInput(profile, session, text, clinicPhoneNumberId) {
  const from = profile.phone;
  const t = text.trim();
  // number selection?
  const num = t.match(/^\d+$/);
  if (num) {
    const idx = parseInt(num[0], 10) - 1;
    if (idx >= 0 && idx < SERVICES.length) {
      session.data.service = SERVICES[idx].name;
      session.data.price = SERVICES[idx].price;
      session.state = 'booking_date';
      await saveSession(profile._id, session);
      return safeSendText(clinicPhoneNumberId, from, '📅 Please provide preferred appointment date (DD-MM-YYYY).');
    }
  }
  // match by name (loose)
  const chosen = SERVICES.find(s => s.name.toLowerCase() === t.toLowerCase() || s.key === t.toLowerCase());
  if (chosen) {
    session.data.service = chosen.name;
    session.data.price = chosen.price;
    session.state = 'booking_date';
    await saveSession(profile._id, session);
    return safeSendText(clinicPhoneNumberId, from, '📅 Please provide preferred appointment date (DD-MM-YYYY).');
  }
  // not recognized -> ask again
  return safeSendText(clinicPhoneNumberId, from, `❗ I didn't recognize that service. Please reply with the service name or number:\n\n${servicesListText()}`);
}

async function handleBookingDateInput(profile, session, text, clinicPhoneNumberId) {
  const from = profile.phone;
  const parsed = parseDateStrict(text.trim());
  if (!parsed || !parsed.isValid()) {
    return safeSendText(clinicPhoneNumberId, from, '❗ Invalid date. Send like *28-11-2025* (DD-MM-YYYY).');
  }
  // store ISO date (midnight)
  session.data.date = parsed.startOf('day').toISOString();
  session.state = 'booking_time';
  await saveSession(profile._id, session);
  return safeSendText(clinicPhoneNumberId, from, '⏰ Please provide preferred time (e.g. 10:00 or 10.30 or 10 AM).');
}

async function handleBookingTimeInput(profile, session, text, clinicPhoneNumberId) {
  const from = profile.phone;
  const normalized = normalizeTime(text.trim());
  if (!normalized) {
    return safeSendText(clinicPhoneNumberId, from, '❗ Invalid time. Try formats like 10:00, 10.30, 10 AM.');
  }
  session.data.time = normalized;
  session.state = 'booking_confirm';
  await saveSession(profile._id, session);

  // Build confirmation summary
  const name = session.data.name || profile.patientName || '—';
  const service = session.data.service || '—';
  const price = session.data.price !== undefined ? `₹${Number(session.data.price).toLocaleString()}` : `₹${DEFAULT_PRICE}`;
  const dateText = session.data.date ? dayjs(session.data.date).format('DD MMM YYYY') : '—';
  const timeText = session.data.time || '—';
  const phoneText = session.data.phone || profile.phone || '—';
  const emailText = session.data.email || '—';

  const confirmMsg =
`✅ *Confirm Appointment*
👤 Patient: ${name}
📞 Phone: ${phoneText}
✉️ Email: ${emailText}
🦷 Service: ${service}
📅 Date: ${dateText}
⏰ Time: ${timeText}
💰 Price: ${price}

Reply *yes* to confirm and book, or *no* to cancel.`;
  return safeSendText(clinicPhoneNumberId, from, confirmMsg);
}

async function handleBookingConfirmInput(profile, session, text, clinicPhoneNumberId) {
  const from = profile.phone;
  const t = text.trim().toLowerCase();
  if (t === 'no' || t === 'cancel' || t === 'n') {
    await clearSession(profile._id);
    return safeSendText(clinicPhoneNumberId, from, '❌ Booking cancelled. Type *menu* to see options or *book* to start again.');
  }
  if (t === 'yes' || t === 'y') {
    // Final validation
    const parsed = parseDateStrict(session.data.date);
    if (!parsed || !parsed.isValid()) {
      session.state = 'booking_date';
      await saveSession(profile._id, session);
      return safeSendText(clinicPhoneNumberId, from, '❗ The date looks invalid. Please resend date like 28-11-2025.');
    }
    const apptDate = parsed.toDate();
    const timeNorm = normalizeTime(session.data.time || '');
    if (!timeNorm) {
      session.state = 'booking_time';
      await saveSession(profile._id, session);
      return safeSendText(clinicPhoneNumberId, from, '❗ The time looks invalid. Please send time like 10:00 or 10 AM.');
    }

    // Build appointment record payload
    const apptPayload = {
      clinicId: profile.clinicId,
      clinicName: profile.clinicName,
      patientName: session.data.name || profile.patientName || '',
      phone: session.data.phone || profile.phone,
      email: session.data.email || profile.email || '',
      service: session.data.service || '',
      price: Number(session.data.price || DEFAULT_PRICE),
      appointmentDate: apptDate,
      timeSlot: timeNorm,
      status: 'booked',
      source: 'whatsapp',
      metadata: {}
    };

    // Prevent duplicate booking for same phone/date/time (basic check)
    try {
      const existing = await Record.findOne({
        phone: apptPayload.phone,
        clinicId: apptPayload.clinicId,
        appointmentDate: apptPayload.appointmentDate,
        timeSlot: apptPayload.timeSlot,
        status: { $in: ['booked', 'confirmed'] }
      });
      if (existing) {
        await clearSession(profile._id);
        return safeSendText(clinicPhoneNumberId, from, `ℹ️ You already have a booking at that date/time. Appointment ID: ${existing._id}\nType *menu* for options.`);
      }
    } catch (err) {
      console.error('Duplicate check error:', err);
    }

    // Create appointment record
    let apptRec;
    try {
      apptRec = await Record.create(apptPayload);
    } catch (err) {
      console.error('Failed to create appointment:', err);
      return safeSendText(clinicPhoneNumberId, from, '❌ Something went wrong while saving your appointment. Please try again later.');
    }

    // Update profile: set patientName/email and clear session
    try {
      await Record.findByIdAndUpdate(profile._id, {
        $set: { patientName: apptPayload.patientName, email: apptPayload.email, updatedAt: new Date() },
        $unset: { session: '' }
      });
    } catch (err) {
      console.error('Failed to update/clear profile after booking:', err);
    }

    // Notify clinic staff (if contactNumber configured)
    try {
      const clinicObj = clinicsConfig.findClinicById(apptRec.clinicId);
      if (clinicObj && clinicObj.contactNumber) {
        const notify = `📣 *New appointment booked*
🦷 ${apptRec.service}
👤 ${apptRec.patientName} (${apptRec.phone})
📅 ${dayjs(apptRec.appointmentDate).format('DD MMM YYYY')}
⏰ ${apptRec.timeSlot}
🆔 ${apptRec._id}`;
        await safeSendText(clinicObj.phoneNumberId, clinicObj.contactNumber, notify);
      }
    } catch (err) {
      console.error('Failed to notify clinic staff:', err);
    }

    // Confirm to user
    const confText = `🎉 Your appointment is confirmed for *${dayjs(apptRec.appointmentDate).format('DD MMM YYYY')}* at *${apptRec.timeSlot}*.\nAppointment ID: ${apptRec._id}\nWe look forward to seeing you!`;
    return safeSendText(clinicPhoneNumberId, from, confText);
  }

  // If not clearly yes/no
  return safeSendText(clinicPhoneNumberId, from, 'Please reply with *yes* to confirm or *no* to cancel.');
}

function formatPhoneForPrompt(p) {
  if (!p) return '';
  // show last 10 digits for privacy if longer
  const cleaned = normalizePhone(p) || p;
  if (cleaned.length > 10) return `+${cleaned}`;
  return cleaned;
}

module.exports = { handleIncomingMessage };
