// chatlogic.js
// Professional, polished chat flow for WhatsApp clinic assistant
// Flow: greeting -> ask patient name -> main menu (services/prices, book, hours, address, FAQs)
// Booking collects: phone number, email, service, appointment date, time -> confirm -> create appointment
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

// Services list (editable) - you asked to add more services
const SERVICES = [
  { key: 'cleaning', name: 'Cleaning', price: 500 },
  { key: 'scaling', name: 'Scaling & Polishing', price: 800 },
  { key: 'whitening', name: 'Whitening', price: 2000 },
  { key: 'braces', name: 'Braces', price: 35000 },
  { key: 'rct', name: 'RCT', price: 3000 },
  { key: 'implant', name: 'Implant', price: 25000 },
  { key: 'filling', name: 'Filling', price: 1500 },
  { key: 'extraction', name: 'Extraction', price: 1200 },
  { key: 'veneers', name: 'Veneers', price: 18000 },
  { key: 'dentures', name: 'Dentures', price: 12000 },
  { key: 'pediatric', name: 'Pediatric Dentistry', price: 1000 }
];

// Frequently Asked Questions (editable)
const FAQS = [
  { q: "What services do you offer?", a: "We offer Cleaning, Scaling & Polishing, Whitening, Braces, RCT, Implants, Fillings, Extractions, Veneers, Dentures, Pediatric Dentistry and more. Reply with the number to learn more." },
  { q: "What are your clinic hours?", a: "Our clinic operates Monday to Saturday, 10:00 AM — 8:00 PM. We are closed on Sundays. For urgent care please call the clinic." },
  { q: "Where is your clinic located?", a: "We are located at: [Add Clinic Address Here]. You can share your current location and we will guide you with directions." },
  { q: "How can I book an appointment?", a: "You can book via this WhatsApp assistant — choose Book Appointment from the menu, select service, date & time and confirm. You will receive a confirmation message with your appointment ID." },
  { q: "What payment methods do you accept?", a: "We accept Cash, UPI, Debit/Credit Cards and Online Payments." },
  { q: "Do you provide emergency dental care?", a: "Yes — we handle urgent cases like severe pain, bleeding or trauma. Call the clinic for priority assistance." },
  { q: "Do you treat children?", a: "Yes — we provide pediatric dental care with a child-friendly environment." },
  { q: "Is teeth whitening safe?", a: "Professional whitening is safe when performed by a dentist using clinically approved products. We assess tooth sensitivity first." },
  { q: "How often should I visit the dentist?", a: "Routine check-ups every 6 months are recommended for most patients. Some treatments require more frequent follow-ups." },
  { q: "Do you offer follow-up or warranty for treatments?", a: "Yes — many restorative treatments include follow-up care. Specific warranty terms depend on the treatment and will be discussed during consultation." }
];

// Polished Main menu (professional tone, aligned spacing)
const MAIN_MENU_TEXT = [
  '📋 *Main Menu*',
  'Please reply with a number or keyword:',
  '1 — 🩺 Services & Pricing ',
  '2 — 🗓️ Book Appointment    ',
  '3 — ⏳ Clinic Hours         ',
  '4 — 📍 Clinic Address       ',
  '5 — ❔ FAQs                ',
  '',
  'Type *menu* anytime to return here.'
].join('\n');

// ----------------- Utility helpers -----------------
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
  let cleaned = p.replace(/[\s+\-()]/g, '');
  if (!/^\d+$/.test(cleaned)) return null;
  return cleaned;
}
function validPhoneNumber(p) {
  if (!p) return false;
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

  // ---------- Friendly & professional greeting ----------
  if (/^(hi|hello|hey|start|menu)$/i.test(textLower)) {
    // friendly branded greeting that asks for name and sets expectations
    if (!profile.patientName || profile.patientName.trim() === '') {
      session.state = 'asking_name';
      session.data = { clinicId, clinicName };
      await saveSession(profile._id, session);

      const greetMsg = [
        `Hello! 👋`,
        `Welcome to *${clinicName}*. I'm the clinic assistant how can i help you .`,
        '',
        `May I know your full name, please?`,
        '',
        `_Tip: reply with your name (e.g. John Doe)._`
      ].join('\n');

      return safeSendText(clinicPhoneNumberId, from, greetMsg);
    } else {
      session.state = 'idle';
      session.data = { clinicId, clinicName };
      await saveSession(profile._id, session);

      const welcome = [
        `Welcome back, *${profile.patientName}* 👋`,
        `You're chatting with *${clinicName}*'s assistant. How can I help you today?`,
        '',
        MAIN_MENU_TEXT
      ].join('\n');

      return safeSendText(clinicPhoneNumberId, from, welcome);
    }
  }

  // allow 'menu' anytime (polished)
  if (textLower === 'menu') {
    session.state = 'idle';
    session.data = { clinicId, clinicName };
    await saveSession(profile._id, session);
    return safeSendText(clinicPhoneNumberId, from, MAIN_MENU_TEXT);
  }

  // If asking_name state: save name and continue with polished confirmation
  if (session.state === 'asking_name') {
    const name = text;
    if (!name || name.length < 2) {
      return safeSendText(clinicPhoneNumberId, from, '❗ Please send your full name (at least 2 characters).');
    }
    try {
      await Record.findByIdAndUpdate(profile._id, { $set: { patientName: name, updatedAt: new Date() } });
    } catch (err) {
      console.error('Failed to save patientName:', err);
    }
    session.state = 'idle';
    session.data = { clinicId: session.data?.clinicId || clinicId, clinicName: session.data?.clinicName || clinicName };
    await saveSession(profile._id, session);

    const thanks = [`Thanks *${name}*! ✅`, '', MAIN_MENU_TEXT].join('\n');
    return safeSendText(clinicPhoneNumberId, from, thanks);
  }

  // Map number selection or keywords to menu options (robust)
  const numberMatch = text.match(/^[1-5]$/);
  if (numberMatch) {
    return routeMenu(numberMatch[0], profile, session, clinicPhoneNumberId);
  }
  if (/book|appointment|slot/i.test(text)) return routeMenu('2', profile, session, clinicPhoneNumberId);
  if (/service|services|price|pricing/i.test(text)) return routeMenu('1', profile, session, clinicPhoneNumberId);
  if (/hour|time|timings|opening|open/i.test(text)) return routeMenu('3', profile, session, clinicPhoneNumberId);
  if (/address|location|where/i.test(text)) return routeMenu('4', profile, session, clinicPhoneNumberId);
  if (/faq|help|question/i.test(text)) return routeMenu('5', profile, session, clinicPhoneNumberId);

  // Booking & FAQ flow continuation
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
    case 'faq_select':
      return handleFaqSelectionInput(profile, session, text, clinicPhoneNumberId);
    default:
      return safeSendText(clinicPhoneNumberId, from, `I didn't understand that.\n\n${MAIN_MENU_TEXT}`);
  }
}

// ---------- Menu routing (polished responses) ----------
async function routeMenu(opt, profile, session, clinicPhoneNumberId) {
  const from = profile.phone;
  switch (opt) {
    case '1': {
      session.state = 'idle';
      session.data = session.data || {};
      await saveSession(profile._id, session);
      const msg = [`🦷 *Services & Pricing*`, '', servicesListText(), '', 'Reply with the service name or number to start booking.'].join('\n');
      return safeSendText(clinicPhoneNumberId, from, msg);
    }
    case '2': {
      session.state = 'booking_phone';
      session.data = session.data || {};
      if (profile.patientName) session.data.name = profile.patientName;
      await saveSession(profile._id, session);
      const defaultPhone = profile.phone || '';
      const prompt = defaultPhone
        ? `📞 We have *${formatPhoneForPrompt(defaultPhone)}* on file for you. Reply with a different number to change it, or type *ok* to use this number.`
        : '📞 Please provide the patient phone number (include country code). Example: 919812345678';
      return safeSendText(clinicPhoneNumberId, from, prompt);
    }
    case '3': {
      session.state = 'idle';
      await saveSession(profile._id, session);
      const clinicObj = clinicsConfig.findClinicById(profile.clinicId) || {};
      const hours = clinicObj.hours || 'Mon–Sat 9:00 AM – 7:00 PM';
      return safeSendText(clinicPhoneNumberId, from, `⏰ *Clinic Hours*: ${hours}`);
    }
    case '4': {
      session.state = 'idle';
      await saveSession(profile._id, session);
      const clinicObj = clinicsConfig.findClinicById(profile.clinicId) || {};
      const address = clinicObj.address || 'Address not available. Please contact reception.';
      return safeSendText(clinicPhoneNumberId, from, `📍 *Clinic Address*: ${address}`);
    }
    case '5': {
      // show numbered FAQ list and move session to faq_select
      session.state = 'faq_select';
      session.data = session.data || {};
      await saveSession(profile._id, session);

      // Format the FAQs as numbered list
      const faqList = FAQS.map((f, i) => `${i+1}. ${f.q}`).join('\n\n');
      const faqMsg = [
        '❓ *Frequently Asked Questions*',
        '',
        faqList,
        '',
        'Reply with the *number* of the question you want the answer to (for example: 2).',
        'Type *menu* to return to the main menu.'
      ].join('\n');

      return safeSendText(clinicPhoneNumberId, profile.phone, faqMsg);
    }
    default:
      session.state = 'idle';
      await saveSession(profile._id, session);
      return safeSendText(clinicPhoneNumberId, profile.phone, MAIN_MENU_TEXT);
  }
}

// ---------- Booking handlers (polished prompts) ----------
async function handleBookingPhoneInput(profile, session, text, clinicPhoneNumberId) {
  const from = profile.phone;
  const trimmed = text.toLowerCase();
  if (trimmed === 'ok' || trimmed === 'use' || trimmed === '' || trimmed === 'yes') {
    const phone = profile.phone;
    session.data.phone = phone;
    session.state = 'booking_email';
    await saveSession(profile._id, session);
    return safeSendText(clinicPhoneNumberId, from, '✉️ Please provide an email address for confirmation (or type "skip").');
  }
  const cleaned = normalizePhone(text);
  if (!cleaned || !validPhoneNumber(cleaned)) {
    return safeSendText(clinicPhoneNumberId, from, '❗ Please send a valid phone number (digits only, include country code). Example: 919812345678');
  }
  session.data.phone = cleaned;
  session.state = 'booking_email';
  await saveSession(profile._id, session);
  return safeSendText(clinicPhoneNumberId, from, '✉️ Please provide an email address for confirmation (or type "skip").');
}

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

async function handleBookingServiceInput(profile, session, text, clinicPhoneNumberId) {
  const from = profile.phone;
  const t = text.trim();
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
  const chosen = SERVICES.find(s => s.name.toLowerCase() === t.toLowerCase() || s.key === t.toLowerCase());
  if (chosen) {
    session.data.service = chosen.name;
    session.data.price = chosen.price;
    session.state = 'booking_date';
    await saveSession(profile._id, session);
    return safeSendText(clinicPhoneNumberId, from, '📅 Please provide preferred appointment date (DD-MM-YYYY).');
  }
  return safeSendText(clinicPhoneNumberId, from, `❗ I didn't recognize that service. Please reply with the service name or number:\n\n${servicesListText()}`);
}

async function handleBookingDateInput(profile, session, text, clinicPhoneNumberId) {
  const from = profile.phone;
  const parsed = parseDateStrict(text.trim());
  if (!parsed || !parsed.isValid()) {
    return safeSendText(clinicPhoneNumberId, from, '❗ Invalid date. Send like *28-11-2025* (DD-MM-YYYY).');
  }
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

  // Polished confirmation summary
  const name = session.data.name || profile.patientName || '—';
  const service = session.data.service || '—';
  const price = session.data.price !== undefined ? `₹${Number(session.data.price).toLocaleString()}` : `₹${DEFAULT_PRICE}`;
  const dateText = session.data.date ? dayjs(session.data.date).format('DD MMM YYYY') : '—';
  const timeText = session.data.time || '—';
  const phoneText = session.data.phone || profile.phone || '—';
  const emailText = session.data.email || '—';

  const confirmMsg = [
    '🔔 *Please confirm your appointment*',
    '',
    `👤 *Patient:* ${name}`,
    `📞 *Phone:* ${phoneText}`,
    `✉️ *Email:* ${emailText}`,
    `🦷 *Service:* ${service}`,
    `📅 *Date:* ${dateText}`,
    `⏰ *Time:* ${timeText}`,
    `💰 *Price:* ${price}`,
    '',
    'Reply *yes* to confirm and book, or *no* to cancel.'
  ].join('\n');

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
        // friendly, actionable message when the chosen slot is already taken
        const slotDate = dayjs(apptPayload.appointmentDate).format('DD MMM YYYY');
        const slotTime = apptPayload.timeSlot;
        // keep the session so user can pick a different time — set state back to booking_time
        session.state = 'booking_time';
        await saveSession(profile._id, session);
        return safeSendText(clinicPhoneNumberId, from, `😕 The slot *${slotDate}* at *${slotTime}* is already booked. Please try another time — reply with a different time (e.g. 11:00 or 2 PM).`);
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
        const notify = [
          '📣 *New appointment booked*',
          `🦷 ${apptRec.service}`,
          `👤 ${apptRec.patientName} (${apptRec.phone})`,
          `📅 ${dayjs(apptRec.appointmentDate).format('DD MMM YYYY')}`,
          `⏰ ${apptRec.timeSlot}`,
          `🆔 ${apptRec._id}`
        ].join('\n');
        await safeSendText(clinicObj.phoneNumberId, clinicObj.contactNumber, notify);
      }
    } catch (err) {
      console.error('Failed to notify clinic staff:', err);
    }

    // Confirm to user
    const confText = [
      '🎉 *Appointment Confirmed!*',
      `Your appointment is scheduled for *${dayjs(apptRec.appointmentDate).format('DD MMM YYYY')}* at *${apptRec.timeSlot}*.`,
      `Appointment ID: ${apptRec._id}`,
      '',
      'We look forward to seeing you — if you need to reschedule, reply *menu* and choose Booking.'
    ].join('\n');

    return safeSendText(clinicPhoneNumberId, from, confText);
  }

  // If not clearly yes/no
  return safeSendText(clinicPhoneNumberId, from, 'Please reply with *yes* to confirm or *no* to cancel.');
}

// ---------- FAQ handlers ----------
async function handleFaqSelectionInput(profile, session, text, clinicPhoneNumberId) {
  const from = profile.phone;
  const t = text.trim().toLowerCase();

  // allow returning to menu
  if (t === 'menu' || t === 'back' || t === '0') {
    session.state = 'idle';
    session.data = { clinicId: session.data?.clinicId || profile.clinicId, clinicName: session.data?.clinicName || profile.clinicName };
    await saveSession(profile._id, session);
    return safeSendText(clinicPhoneNumberId, from, MAIN_MENU_TEXT);
  }

  // accept numeric choice
  const numMatch = t.match(/^(\d{1,2})$/); // supports up to 99 FAQs
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (idx >= 0 && idx < FAQS.length) {
      const faq = FAQS[idx];
      // reply with answer and offer next steps
      const reply = [
        `❓ *Q:* ${faq.q}`,
        '',
        `💡 *A:* ${faq.a}`,
        '',
        'Reply with another FAQ number to read more, or type *menu* to go back to the main menu.'
      ].join('\n');
      // keep session in faq_select so user can choose again
      session.state = 'faq_select';
      await saveSession(profile._id, session);
      return safeSendText(clinicPhoneNumberId, from, reply);
    } else {
      return safeSendText(clinicPhoneNumberId, from, `❗ Invalid selection. Please reply with a number between 1 and ${FAQS.length}, or type *menu* to return to the main menu.`);
    }
  }

  // if text includes keywords try to match to a FAQ
  for (let i = 0; i < FAQS.length; i++) {
    const q = FAQS[i].q.toLowerCase();
    if (t.includes('hour') && q.includes('hours')) return handleFaqSelectionInput(profile, session, String(i+1), clinicPhoneNumberId);
    if (t.includes('where') && q.includes('located')) return handleFaqSelectionInput(profile, session, String(i+1), clinicPhoneNumberId);
    if (t.includes('book') && q.includes('book')) return handleFaqSelectionInput(profile, session, String(i+1), clinicPhoneNumberId);
  }

  // fallback
  return safeSendText(clinicPhoneNumberId, from, `I didn't understand that. Reply with a FAQ number (1-${FAQS.length}) or type *menu* to return to the main menu.`);
}

// ---------- Helper: format phone for prompts ----------
function formatPhoneForPrompt(p) {
  if (!p) return '';
  const cleaned = normalizePhone(p) || p;
  if (cleaned.length > 10) return `+${cleaned}`;
  return cleaned;
}

module.exports = { handleIncomingMessage };
