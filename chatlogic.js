// chatlogic.js
<<<<<<< HEAD
const Record = require('./models/Record');
const Session = require('./models/Session');
const clinicsConfig = require('./utils/clinicsConfig');
const whatsapp = require('./modules/whatsapp');
const dayjs = require('dayjs');

const MAIN_MENU_TEXT = `👋 Welcome to our dental clinic!
Please choose:
1️⃣ Book Appointment
2️⃣ Treatments & Pricing
3️⃣ Clinic Address & Timings
4️⃣ Speak to Receptionist
Reply with the number (1-4) or type "book".`;

function textFromMessage(message) {
  if (!message) return '';
  if (message.text?.body) return message.text.body.trim();
  if (message.button) return message.button?.payload || message.button?.text;
  if (message.interactive?.type === 'button_reply') return message.interactive?.button_reply?.title || message.interactive?.button_reply?.id;
  if (message.interactive?.type === 'list_reply') return message.interactive?.list_reply?.title;
  return '';
}

async function handleIncomingMessage(message, value, clinic) {
  const from = message.from; // user's WA number
  const text = textFromMessage(message);
  console.log(`📩 Incoming from ${from} (clinic=${clinic?.clinicId || 'unknown'}):`, text);

  // detect clinic info (by phone_number_id) or fallback to single clinic
  let clinicId = clinic?.clinicId || null;
  let clinicName = clinic?.clinicName || 'Clinic';
  let clinicPhoneNumberId = clinic?.phoneNumberId || null;

  if (!clinicId && value?.metadata?.phone_number_id) {
    const c = clinicsConfig.findClinicByPhoneNumberId(value.metadata.phone_number_id);
    if (c) {
      clinicId = c.clinicId;
      clinicName = c.clinicName;
      clinicPhoneNumberId = c.phoneNumberId;
    }
  }

  // fallback to single clinic if only one configured
  if (!clinicId) {
    const all = clinicsConfig.getAllClinics();
    if (all.length === 1) {
      clinicId = all[0].clinicId;
      clinicName = all[0].clinicName;
      clinicPhoneNumberId = all[0].phoneNumberId;
    }
  }

  // create/find session for this phone + clinic
  let session = await Session.findOne({ phone: from, clinicId });
  if (!session) {
    session = await Session.create({ phone: from, clinicId, data: { clinicId, clinicName } });
  }

  // reset on greeting
  if (/^(hi|hello|menu|start|hey)$/i.test(text)) {
    session.state = 'idle';
    session.data = { clinicId, clinicName };
    await session.save();
    await whatsapp.sendText(clinicPhoneNumberId, from, MAIN_MENU_TEXT);
    return;
  }

  // quick commands
  if (/^cancel\b/i.test(text)) {
    await handleCancel(from, session, clinicPhoneNumberId, clinicId);
    return;
  }
  if (/^reschedule\b/i.test(text)) {
    await whatsapp.sendText(clinicPhoneNumberId, from, '🔁 To reschedule, please call reception or reply with a new preferred date (DD-MM-YYYY) and time (HH:MM).');
    return;
  }
  if (/^status\b/i.test(text)) {
    await handleStatus(from, session, clinicPhoneNumberId, clinicId);
    return;
  }

  // route by session state
  switch (session.state) {
    case 'idle':
      await handleIdle(from, text, session, clinicPhoneNumberId, clinicId, clinicName);
      break;
    case 'booking_name':
    case 'booking_service':
    case 'booking_date':
    case 'booking_time':
    case 'booking_confirm':
      await handleBookingFlow(from, text, session, clinicPhoneNumberId, clinicId, clinicName);
      break;
    default:
      session.state = 'idle';
      session.data = { clinicId, clinicName };
      await session.save();
      await whatsapp.sendText(clinicPhoneNumberId, from, MAIN_MENU_TEXT);
      break;
  }
}

async function handleIdle(from, text, session, clinicPhoneNumberId, clinicId, clinicName) {
  if (/^[1-4]$/.test(text)) {
    const opt = text;
    if (opt === '1') {
      session.state = 'booking_name';
      session.data = { clinicId, clinicName };
      await session.save();
      return whatsapp.sendText(clinicPhoneNumberId, from, '📝 Great — what is the *patient full name*?');
    }
    if (opt === '2') {
      return whatsapp.sendText(clinicPhoneNumberId, from, "🦷 *Treatments:* Cleaning, Whitening, Braces, RCT, Implants. Reply '1' to book.");
    }
    if (opt === '3') {
      return whatsapp.sendText(clinicPhoneNumberId, from, `📍 Address & Timings for ${clinicName}: Mon-Sat 9AM - 7PM\nReply '1' to book.`);
    }
    if (opt === '4') {
      const clinic = clinicsConfig.findClinicById(session.data?.clinicId);
      return whatsapp.sendText(clinicPhoneNumberId, from, `☎️ Call reception: ${clinic?.contactNumber || 'Not provided'}`);
    }
  }

  if (/book|appointment|slot|visit/i.test(text)) {
    session.state = 'booking_name';
    session.data = { clinicId, clinicName };
    await session.save();
    return whatsapp.sendText(clinicPhoneNumberId, from, '📝 Sure — please share the *patient full name*.');
  }

  return whatsapp.sendText(clinicPhoneNumberId, from, MAIN_MENU_TEXT);
}

async function handleBookingFlow(from, text, session, clinicPhoneNumberId, clinicId, clinicName) {
  // booking_name -> ask service
  if (session.state === 'booking_name') {
    session.data.name = text;
    session.state = 'booking_service';
    await session.save();
    return whatsapp.sendText(clinicPhoneNumberId, from, 'Which service do you want? (Cleaning / Whitening / RCT / Braces / Implant) 🦷');
  }

  // booking_service -> ask date
  if (session.state === 'booking_service') {
    session.data.service = text;
    session.state = 'booking_date';
    await session.save();
    return whatsapp.sendText(clinicPhoneNumberId, from, 'Please share preferred date (DD-MM-YYYY) 📅');
  }

  // booking_date -> ask time
  if (session.state === 'booking_date') {
    const parsed = parseDate(text);
    if (!parsed) return whatsapp.sendText(clinicPhoneNumberId, from, '❗ Invalid date. Send like *25-12-2025* (DD-MM-YYYY).');
    session.data.date = parsed.toISOString();
    session.state = 'booking_time';
    await session.save();
    return whatsapp.sendText(clinicPhoneNumberId, from, 'Choose a time slot (e.g. 10:00, 11:30, 15:00) ⏰');
  }

  // booking_time -> confirm
  if (session.state === 'booking_time') {
    session.data.time = text;
    session.state = 'booking_confirm';
    await session.save();

    const confirmMsg = `✅ *Confirm appointment:*
👤 ${session.data.name}
🦷 ${session.data.service}
📅 ${formatDate(session.data.date)}
⏰ ${session.data.time}
💰 Price: ${session.data.price || process.env.DEFAULT_PRICE || 0}

Reply *yes* to confirm or *no* to cancel.`;
    return whatsapp.sendText(clinicPhoneNumberId, from, confirmMsg);
  }

  // booking_confirm -> save record and notify clinic
  if (session.state === 'booking_confirm') {
    if (/^y(es)?$/i.test(text)) {
      // prepare record
      const recPayload = {
        clinicId: session.data.clinicId || clinicId,
        clinicName: session.data.clinicName || clinicName,
        patientName: session.data.name,
        phone: from,
        email: session.data.email || '',
        service: session.data.service,
        price: Number(session.data.price || process.env.DEFAULT_PRICE || 0),
        appointmentDate: new Date(session.data.date),
        timeSlot: session.data.time,
        status: 'booked',
        source: 'whatsapp',
        metadata: session.data.metadata || {}
      };

      const rec = await Record.create(recPayload);

      // notify clinic staff
      const clinic = clinicsConfig.findClinicById(rec.clinicId);
      if (clinic && clinic.contactNumber) {
        const contactMsg = `📣 New appointment booked:
🦷 ${rec.service}
👤 ${rec.patientName} (${rec.phone})
📅 ${dayjs(rec.appointmentDate).format('DD MMM YYYY')}
⏰ ${rec.timeSlot}
🔖 ID: ${rec._id}`;
        try {
          await whatsapp.sendText(clinic.phoneNumberId, clinic.contactNumber, contactMsg);
        } catch (err) {
          console.error('Failed to notify clinic staff via WhatsApp', err);
        }
      }

      // reset session and confirm to user
      session.state = 'idle';
      session.data = { clinicId: rec.clinicId, clinicName: rec.clinicName };
      await session.save();

      await whatsapp.sendText(clinic?.phoneNumberId || clinicPhoneNumberId, from, `🎉 Your appointment is confirmed for *${formatDate(rec.appointmentDate)}* at *${rec.timeSlot}*. See you soon! 👋`);
      return;
    } else {
      session.state = 'idle';
      session.data = { clinicId, clinicName };
      await session.save();
      return whatsapp.sendText(clinicPhoneNumberId, from, '❌ Booking cancelled. Reply *menu* to see options again.');
    }
  }
}

// cancel latest upcoming
async function handleCancel(from, session, clinicPhoneNumberId, clinicId) {
  const rec = await Record.findOne({ phone: from, clinicId, status: { $in: ['booked','confirmed'] } }).sort({ appointmentDate: 1 });
  if (!rec) {
    return whatsapp.sendText(clinicPhoneNumberId, from, 'ℹ️ No upcoming appointment found to cancel.');
  }
  rec.status = 'cancelled';
  await rec.save();
  session.state = 'idle';
  session.data = { clinicId: rec.clinicId, clinicName: rec.clinicName };
  await session.save();
  return whatsapp.sendText(clinicPhoneNumberId, from, `✅ Your appointment on ${formatDate(rec.appointmentDate)} at ${rec.timeSlot} has been cancelled.`);
}

async function handleStatus(from, session, clinicPhoneNumberId, clinicId) {
  const rec = await Record.findOne({ phone: from, clinicId }).sort({ appointmentDate: -1 });
  if (!rec) return whatsapp.sendText(clinicPhoneNumberId, from, 'ℹ️ No appointments found yet. Reply *1* to book.');
  return whatsapp.sendText(clinicPhoneNumberId, from, `📌 Latest appointment:
🦷 ${rec.service}
📅 ${formatDate(rec.appointmentDate)}
⏰ ${rec.timeSlot}
🛠 Status: ${rec.status}`);
}

function parseDate(text) {
  const m = text.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) return null;
  const [_, dd, mm, yyyy] = m;
  const d = dayjs(`${yyyy}-${mm}-${dd}`);
  if (!d.isValid()) return null;
  return d;
}
function formatDate(date) {
  return dayjs(date).format('DD MMM YYYY');
}

module.exports = { handleIncomingMessage };
=======
// Clinic-aware chat flow. Step-by-step, emoji-friendly, saves appointments with clinic_key & clinic_name.

const SERVICES = [
  { name: "Dental Cleaning", price: "₹500", emoji: "🦷" },
  { name: "Teeth Whitening", price: "₹1,500", emoji: "✨" },
  { name: "Tooth Extraction", price: "₹800", emoji: "🔧" },
  { name: "Consultation", price: "₹300", emoji: "💬" }
];

function getMainMenuText(clinic) {
  const header = clinic && clinic.name ? `👋 Welcome to ${clinic.name}! Choose an option:` :
    "👋 Welcome! Choose an option:";
  const menu = [
    header,
    "1️⃣  Services & Prices",
    "2️⃣  Book Appointment",
    "3️⃣  Clinic Hours",
    "4️⃣  Clinic Address",
    "5️⃣  FAQs",
    "ℹ️  Type 'menu' anytime to return here."
  ];
  return menu.join('\n');
}

function getServicesListText() {
  let txt = "📋 Our Services & Prices:\n";
  SERVICES.forEach((s, i) => txt += `${i+1}. ${s.emoji} ${s.name} — ${s.price}\n`);
  txt += "\nTo book, type '2' or reply with the service number (e.g., '1').";
  return txt;
}

function getFaqsText() {
  return [
    "❓ Frequently Asked Questions",
    "Q: What are your clinic hours?",
    "A: Check 'Clinic Hours' in the main menu or contact the clinic directly.",
    "",
    "Q: Do you accept walk-ins?",
    "A: Walk-ins are sometimes accepted. We recommend booking to avoid waiting.",
    "",
    "Q: Payment methods?",
    "A: Cash, UPI, and card payments (varies by clinic).",
    "",
    "🙏 Type 'menu' to return to the main menu."
  ].join('\n');
}

function formatClinicHours(clinic) {
  if (clinic && clinic.business_info && clinic.business_info.hours) return `⏰ ${clinic.business_info.hours}`;
  return "⏰ Clinic hours not set. Please contact the clinic for exact timings.";
}

function formatClinicAddress(clinic) {
  if (clinic && clinic.business_info && clinic.business_info.address) return `📍 ${clinic.business_info.address}`;
  if (clinic && clinic.display_phone) return `📞 ${clinic.display_phone}`;
  return "📍 Address not provided.";
}

/**
 * handleIncomingMessage (clinic-aware)
 * - clinic - object from env
 * - session - mongoose doc
 * - incomingText - string
 * - fromNumber - '9198xxxxx'
 * - sendTextMessage - async function (to, text)
 * - updateSession - async function (waId, updates)
 * - resetSession - async function (waId)
 * - Appointment - Mongoose model passed from server
 * - waFrom - 'whatsapp:9198...'
 */
async function handleIncomingMessage({
  clinic,
  session,
  incomingText,
  fromNumber,
  sendTextMessage,
  updateSession,
  resetSession,
  Appointment,
  waFrom
}) {
  const text = (incomingText || '').trim();
  const lower = text.toLowerCase();

  // Universal quick commands
  if (lower === 'menu' || lower === 'help') {
    await updateSession(waFrom, { state: 'MENU', data: session.data || {} });
    await sendTextMessage(fromNumber, getMainMenuText(clinic)).catch(e => console.error('send error', e?.response?.data || e?.message));
    return;
  }

  // Greeting detection: begin friendly greeting flow
  if (['hi', 'hello', 'hey', 'hii', 'hey there'].includes(lower)) {
    await updateSession(waFrom, { state: 'ASK_NAME_GREETING', data: session.data || {} });
    const greet = clinic && clinic.name
      ? `👋 Hello! Welcome to *${clinic.name}*. May I have your full name, please?`
      : `👋 Hello! May I have your full name, please?`;
    await sendTextMessage(fromNumber, greet).catch(e => console.error('send error', e?.response?.data || e?.message));
    return;
  }

  const state = session.state || 'MENU';

  switch (state) {
    // ---------------- MAIN MENU ----------------
    case 'MENU': {
      if (lower === '1' || text.includes('service') || text.includes('price')) {
        await sendTextMessage(fromNumber, getServicesListText()).catch(e => console.error('send error', e?.response?.data || e?.message));
      } else if (lower === '2' || text.includes('book')) {
        // Start booking: show services if not already
        await updateSession(waFrom, { state: 'ASK_SERVICE', data: session.data || {} });
        let options = "📌 Which service would you like? Reply with the number:\n";
        SERVICES.forEach((s, i) => options += `${i+1}. ${s.emoji} ${s.name} — ${s.price}\n`);
        await sendTextMessage(fromNumber, options).catch(e => console.error('send error', e?.response?.data || e?.message));
      } else if (lower === '3' || text.includes('hour')) {
        await sendTextMessage(fromNumber, formatClinicHours(clinic) + "\n\nℹ️ Type 'menu' to return.").catch(e => console.error('send error', e?.response?.data || e?.message));
      } else if (lower === '4' || text.includes('address')) {
        await sendTextMessage(fromNumber, formatClinicAddress(clinic) + "\n\nℹ️ Type 'menu' to return.").catch(e => console.error('send error', e?.response?.data || e?.message));
      } else if (lower === '5' || text.includes('faq')) {
        await sendTextMessage(fromNumber, getFaqsText()).catch(e => console.error('send error', e?.response?.data || e?.message));
      } else if (/^\d+$/.test(text)) {
        const num = parseInt(text, 10);
        if (num >= 1 && num <= 5) {
          // re-dispatch as if user selected the menu option
          if (num === 1) {
            await sendTextMessage(fromNumber, getServicesListText()).catch(e => console.error('send error', e?.response?.data || e?.message));
          } else if (num === 2) {
            await updateSession(waFrom, { state: 'ASK_SERVICE', data: session.data || {} });
            let options = "📌 Which service would you like? Reply with the number:\n";
            SERVICES.forEach((s, i) => options += `${i+1}. ${s.emoji} ${s.name} — ${s.price}\n`);
            await sendTextMessage(fromNumber, options).catch(e => console.error('send error', e?.response?.data || e?.message));
          } else if (num === 3) {
            await sendTextMessage(fromNumber, formatClinicHours(clinic) + "\n\nℹ️ Type 'menu' to return.").catch(e => console.error('send error', e?.response?.data || e?.message));
          } else if (num === 4) {
            await sendTextMessage(fromNumber, formatClinicAddress(clinic) + "\n\nℹ️ Type 'menu' to return.").catch(e => console.error('send error', e?.response?.data || e?.message));
          } else {
            await sendTextMessage(fromNumber, getFaqsText()).catch(e => console.error('send error', e?.response?.data || e?.message));
          }
        } else {
          await sendTextMessage(fromNumber, "❗ That number isn't a valid menu option. " + getMainMenuText(clinic)).catch(e => console.error('send error', e?.response?.data || e?.message));
        }
      } else {
        await sendTextMessage(fromNumber, "❗ Sorry, I didn't understand. " + getMainMenuText(clinic)).catch(e => console.error('send error', e?.response?.data || e?.message));
      }
      break;
    }

    // ---------------- ASK SERVICE ----------------
    case 'ASK_SERVICE': {
      const idx = parseInt(text);
      if (!isNaN(idx) && idx >= 1 && idx <= SERVICES.length) {
        const service = SERVICES[idx - 1];
        session.data = session.data || {};
        session.data.service = service.name;
        // If name known, continue; else ask name for booking flow
        if (session.data.name) {
          await updateSession(waFrom, { state: 'ASK_PHONE', data: session.data });
          await sendTextMessage(fromNumber, `📞 Got it — *${service.name}*. Please provide a phone number we can contact (e.g., +9198xxxxxxx).`).catch(e => console.error('send error', e?.response?.data || e?.message));
        } else {
          await updateSession(waFrom, { state: 'ASK_NAME_BOOK', data: session.data });
          await sendTextMessage(fromNumber, `📝 Great — you chose *${service.name}*. Please tell me your full name.`).catch(e => console.error('send error', e?.response?.data || e?.message));
        }
      } else {
        await sendTextMessage(fromNumber, "❗ Please reply with the service number from the list (e.g., '1').").catch(e => console.error('send error', e?.response?.data || e?.message));
      }
      break;
    }

    // ---------------- GREETING -> ASK NAME ----------------
    case 'ASK_NAME_GREETING': {
      session.data = session.data || {};
      session.data.name = text;
      await updateSession(waFrom, { state: 'MENU', data: session.data });
      await sendTextMessage(fromNumber, `🙏 Thanks ${session.data.name}! ` + getMainMenuText(clinic)).catch(e => console.error('send error', e?.response?.data || e?.message));
      break;
    }

    // ---------------- ASK NAME DURING BOOKING ----------------
    case 'ASK_NAME_BOOK': {
      session.data = session.data || {};
      session.data.name = text;
      await updateSession(waFrom, { state: 'ASK_PHONE', data: session.data });
      await sendTextMessage(fromNumber, `📞 Thanks ${session.data.name}. Please provide a phone number (e.g., +9198xxxxxxx).`).catch(e => console.error('send error', e?.response?.data || e?.message));
      break;
    }

    // ---------------- GENERAL ASK NAME (fallback) ----------------
    case 'ASK_NAME': {
      session.data = session.data || {};
      session.data.name = text;
      await updateSession(waFrom, { state: 'MENU', data: session.data });
      await sendTextMessage(fromNumber, `Thanks ${session.data.name}. ` + getMainMenuText(clinic)).catch(e => console.error('send error', e?.response?.data || e?.message));
      break;
    }

    // ---------------- PHONE ----------------
    case 'ASK_PHONE': {
      session.data = session.data || {};
      session.data.phone = text;
      await updateSession(waFrom, { state: 'ASK_DATE', data: session.data });
      await sendTextMessage(fromNumber, "📅 Please provide preferred appointment date in YYYY-MM-DD format (e.g., 2025-12-01).").catch(e => console.error('send error', e?.response?.data || e?.message));
      break;
    }

    // ---------------- DATE ----------------
    case 'ASK_DATE': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        await sendTextMessage(fromNumber, "❗ Invalid date format. Please send date as YYYY-MM-DD (e.g., 2025-12-01).").catch(e => console.error('send error', e?.response?.data || e?.message));
      } else {
        session.data = session.data || {};
        session.data.appointment_date = text;
        await updateSession(waFrom, { state: 'ASK_TIME', data: session.data });
        await sendTextMessage(fromNumber, "⏱️ What time do you prefer? (e.g., 10:30 AM or 14:30)").catch(e => console.error('send error', e?.response?.data || e?.message));
      }
      break;
    }

    // ---------------- TIME & SAVE ----------------
    case 'ASK_TIME': {
      session.data = session.data || {};
      session.data.appointment_time = text;

      try {
        const appointmentDoc = new Appointment({
          clinic_key: clinic.phone_number_id,
          clinic_name: clinic.name,
          whatsapp_number: waFrom,
          name: session.data.name || null,
          phone: session.data.phone || null,
          service: session.data.service || null,
          appointment_date: session.data.appointment_date || null,
          appointment_time: session.data.appointment_time || null
        });
        await appointmentDoc.save();

        const confirmText = [
          `✅ *Appointment Confirmed!*`,
          `🏥 Clinic: ${clinic.name}`,
          `👤 Name: ${session.data.name}`,
          `🦷 Service: ${session.data.service}`,
          `📅 Date: ${session.data.appointment_date}`,
          `⏰ Time: ${session.data.appointment_time}`,
          `📞 Contact: ${session.data.phone}`,
          "",
          "If you need to change or cancel, type 'menu' and choose the option or contact the clinic.",
          "🙏 Thank you!"
        ].join('\n');

        await sendTextMessage(fromNumber, confirmText).catch(e => console.error('send error', e?.response?.data || e?.message));
      } catch (err) {
        console.error('DB save error', err);
        await sendTextMessage(fromNumber, "❗ Sorry, I couldn't save your appointment due to a server error. Please try again later.").catch(e => console.error('send error', e?.response?.data || e?.message));
      }

      await resetSession(waFrom);
      break;
    }

    // ---------------- DEFAULT / FALLBACK ----------------
    default:
      await updateSession(waFrom, { state: 'MENU', data: session.data || {} });
      await sendTextMessage(fromNumber, getMainMenuText(clinic)).catch(e => console.error('send error', e?.response?.data || e?.message));
      break;
  }
}

module.exports = { SERVICES, getMainMenuText, handleIncomingMessage };
>>>>>>> e20e93a863e53ba526b09c50f43bee7ce030954e
