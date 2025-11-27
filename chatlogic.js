// chatlogic.js
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
