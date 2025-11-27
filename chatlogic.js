// chatlogic.js
const Record = require('./models/Record');
const clinicsConfig = require('./utils/clinicsConfig');
const whatsapp = require('./modules/whatsapp');
const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
dayjs.extend(customParseFormat);

const SESSION_TTL_MIN = 20; // minutes - treat sessions older than this as expired

const MAIN_MENU_TEXT = `👋 Welcome to our dental clinic!
Please choose:
1️⃣ Book Appointment
2️⃣ Treatments & Pricing
3️⃣ Clinic Address & Timings
4️⃣ Speak to Receptionist
Reply with the number (1-4) or type "book".`;

// helper to normalize message text
function textFromMessage(message) {
  if (!message) return '';
  if (message.text?.body) return message.text.body.trim();
  if (message.button) return message.button?.payload || message.button?.text;
  if (message.interactive?.type === 'button_reply') return message.interactive?.button_reply?.title || message.interactive?.button_reply?.id;
  if (message.interactive?.type === 'list_reply') return message.interactive?.list_reply?.title;
  return '';
}

function formatDate(date) {
  if (!date) return '';
  return dayjs(date).format('DD MMM YYYY');
}

function robustParseDate(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.trim();
  const formats = ['DD-MM-YYYY', 'D-M-YYYY', 'DD/MM/YYYY', 'D/M/YYYY', 'YYYY-MM-DD'];
  for (const f of formats) {
    const d = dayjs(clean, f, true);
    if (d.isValid()) return d;
  }
  const loose = dayjs(clean);
  return loose.isValid() ? loose : null;
}

// session helpers operate on the profile document's session subdoc
async function loadOrCreateProfile(clinicId, clinicName, phone, metadata = {}) {
  // find profile doc (appointmentDate: null)
  let profile = await Record.findOne({ clinicId, phone, appointmentDate: null });
  if (!profile) {
    const payload = {
      clinicId,
      clinicName,
      phone,
      patientName: '',
      appointmentDate: null,
      status: 'profile',
      source: 'whatsapp',
      metadata
    };
    profile = await Record.create(payload);
  }
  return profile;
}

function sessionIsExpired(session) {
  if (!session) return true;
  if (!session.updatedAt) return true;
  const ageMin = (Date.now() - new Date(session.updatedAt).getTime()) / (1000 * 60);
  return ageMin > SESSION_TTL_MIN;
}

async function saveSessionOnProfile(profileId, sessionObj) {
  // sessionObj = { state, data } ; we will set updatedAt and optional expiresAt
  const updated = {
    'session.state': sessionObj.state,
    'session.data': sessionObj.data,
    'session.updatedAt': new Date(),
    'session.expiresAt': new Date(Date.now() + SESSION_TTL_MIN * 60 * 1000)
  };
  return await Record.findByIdAndUpdate(profileId, { $set: updated }, { new: true });
}

async function clearSessionOnProfile(profileId) {
  return await Record.findByIdAndUpdate(profileId, { $unset: { session: '' } }, { new: true });
}

// safe send wrapper
async function safeSendText(phoneNumberId, to, text) {
  try {
    await whatsapp.sendText(phoneNumberId, to, text);
  } catch (err) {
    console.error('WhatsApp send error:', err?.response?.data || err.message || err);
  }
}

async function handleIncomingMessage(message, value, clinic) {
  const from = message.from;
  const text = textFromMessage(message);
  console.log(`📩 Incoming from ${from} (clinic=${clinic?.clinicId || 'unknown'}):`, text);

  // resolve clinic
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
  if (!clinicId) {
    const all = clinicsConfig.getAllClinics();
    if (all.length === 1) {
      clinicId = all[0].clinicId;
      clinicName = all[0].clinicName;
      clinicPhoneNumberId = all[0].phoneNumberId;
    }
  }

  // ensure profile exists
  let profile;
  try {
    profile = await loadOrCreateProfile(clinicId, clinicName, from, value?.contacts?.[0] || value?.metadata || {});
  } catch (err) {
    console.error('Error loading/creating profile:', err);
    await safeSendText(clinicPhoneNumberId, from, '❌ Internal error. Please try again later.');
    return;
  }

  // load session from profile (or start new)
  let session = profile.session || { state: 'idle', data: {}, updatedAt: new Date() };
  // if expired, reset
  if (sessionIsExpired(session)) {
    session = { state: 'idle', data: {}, updatedAt: new Date() };
    // persist the cleared session to the profile
    await saveSessionOnProfile(profile._id, session);
  }

  // If greeting / reset
  if (/^(hi|hello|menu|start|hey)$/i.test(text)) {
    session = { state: 'idle', data: { clinicId, clinicName }, updatedAt: new Date() };
    await saveSessionOnProfile(profile._id, session);
    await safeSendText(clinicPhoneNumberId, from, MAIN_MENU_TEXT);
    return;
  }

  // quick commands
  if (/^cancel\b/i.test(text)) {
    await handleCancel(profile, clinicPhoneNumberId, from);
    return;
  }
  if (/^status\b/i.test(text)) {
    await handleStatus(profile, clinicPhoneNumberId, from);
    return;
  }

  // routing by session state
  switch (session.state) {
    case 'idle':
      await handleIdle(profile, session, text, clinicPhoneNumberId, clinicId, clinicName);
      break;
    case 'booking_name':
    case 'booking_service':
    case 'booking_date':
    case 'booking_time':
    case 'booking_confirm':
      await handleBookingFlow(profile, session, text, clinicPhoneNumberId, clinicId, clinicName);
      break;
    default:
      // reset and show menu
      session = { state: 'idle', data: { clinicId, clinicName }, updatedAt: new Date() };
      await saveSessionOnProfile(profile._id, session);
      await safeSendText(clinicPhoneNumberId, from, MAIN_MENU_TEXT);
      break;
  }
}

// handlers

async function handleIdle(profile, session, text, clinicPhoneNumberId, clinicId, clinicName) {
  const from = profile.phone;

  if (/^[1-4]$/.test(text)) {
    const opt = text;
    if (opt === '1') {
      session.state = 'booking_name';
      session.data = { clinicId, clinicName };
      await saveSessionOnProfile(profile._id, session);
      return safeSendText(clinicPhoneNumberId, from, '📝 Great — what is the *patient full name*?');
    }
    if (opt === '2') {
      return safeSendText(clinicPhoneNumberId, from, "🦷 *Treatments:* Cleaning, Whitening, Braces, RCT, Implants. Reply '1' to book.");
    }
    if (opt === '3') {
      return safeSendText(clinicPhoneNumberId, from, `📍 Address & Timings for ${clinicName}: Mon-Sat 9AM - 7PM\nReply '1' to book.`);
    }
    if (opt === '4') {
      const clinicObj = clinicsConfig.findClinicById(session.data?.clinicId);
      return safeSendText(clinicPhoneNumberId, from, `☎️ Call reception: ${clinicObj?.contactNumber || 'Not provided'}`);
    }
  }

  if (/book|appointment|slot|visit/i.test(text)) {
    session.state = 'booking_name';
    session.data = { clinicId, clinicName };
    await saveSessionOnProfile(profile._id, session);
    return safeSendText(clinicPhoneNumberId, from, '📝 Sure — please share the *patient full name*.');
  }

  return safeSendText(clinicPhoneNumberId, from, MAIN_MENU_TEXT);
}

async function handleBookingFlow(profile, session, text, clinicPhoneNumberId, clinicId, clinicName) {
  const from = profile.phone;

  // booking_name -> ask service
  if (session.state === 'booking_name') {
    session.data.name = text;
    session.state = 'booking_service';
    await saveSessionOnProfile(profile._id, session);

    // update profile patientName immediately
    try {
      await Record.findByIdAndUpdate(profile._id, { $set: { patientName: text, updatedAt: new Date() } });
    } catch (err) {
      console.error('Failed to update profile name:', err);
    }
    return safeSendText(clinicPhoneNumberId, from, 'Which service do you want? (Cleaning / Whitening / RCT / Braces / Implant) 🦷');
  }

  // booking_service -> ask date
  if (session.state === 'booking_service') {
    session.data.service = text;
    session.state = 'booking_date';
    await saveSessionOnProfile(profile._id, session);
    return safeSendText(clinicPhoneNumberId, from, 'Please share preferred date (DD-MM-YYYY) 📅');
  }

  // booking_date -> ask time (validate date)
  if (session.state === 'booking_date') {
    const parsed = robustParseDate(text);
    if (!parsed) {
      return safeSendText(clinicPhoneNumberId, from, '❗ Invalid date. Send like *28-11-2025* (DD-MM-YYYY).');
    }
    session.data.date = parsed.toISOString();
    session.state = 'booking_time';
    await saveSessionOnProfile(profile._id, session);
    return safeSendText(clinicPhoneNumberId, from, 'Choose a time slot (e.g. 10:00, 11:30, 15:00) ⏰');
  }

  // booking_time -> confirm
  if (session.state === 'booking_time') {
    const timeNormalized = text.replace(/\./g, ':').trim();
    session.data.time = timeNormalized;
    session.state = 'booking_confirm';
    await saveSessionOnProfile(profile._id, session);

    const confirmMsg = `✅ *Confirm appointment:*
👤 ${session.data.name}
🦷 ${session.data.service}
📅 ${formatDate(session.data.date)}
⏰ ${session.data.time}
💰 Price: ${session.data.price || process.env.DEFAULT_PRICE || 0}

Reply *yes* to confirm or *no* to cancel.`;
    return safeSendText(clinicPhoneNumberId, from, confirmMsg);
  }

  // booking_confirm -> save appointment and clear session
  if (session.state === 'booking_confirm') {
    if (/^y(es)?$/i.test(text)) {
      // re-validate date strictly
      const parsed = robustParseDate(session.data.date || session.data.date);
      if (!parsed || !parsed.isValid()) {
        session.state = 'booking_date';
        await saveSessionOnProfile(profile._id, session);
        return safeSendText(clinicPhoneNumberId, from, '❗ The date you provided looks invalid. Please send date like *28-11-2025* (DD-MM-YYYY).');
      }
      const apptDate = parsed.toDate();

      // create appointment record (separate doc)
      const apptPayload = {
        clinicId: session.data.clinicId || clinicId,
        clinicName: session.data.clinicName || clinicName,
        patientName: session.data.name || profile.patientName || '',
        phone: profile.phone,
        email: session.data.email || profile.email || '',
        service: session.data.service,
        price: Number(session.data.price || process.env.DEFAULT_PRICE || 0),
        appointmentDate: apptDate,
        timeSlot: session.data.time,
        status: 'booked',
        source: 'whatsapp',
        metadata: session.data.metadata || {}
      };

      let apptRec;
      try {
        apptRec = await Record.create(apptPayload);
      } catch (err) {
        console.error('Failed to create appointment record:', err);
        await safeSendText(clinicPhoneNumberId, from, '❌ Something went wrong while booking. Please try again later.');
        // keep session so user can retry
        return;
      }

      // update profile with latest info and clear its session
      try {
        await Record.findByIdAndUpdate(profile._id, {
          $set: {
            patientName: apptRec.patientName,
            email: apptRec.email,
            updatedAt: new Date()
          },
          $unset: { session: '' }
        });
      } catch (err) {
        console.error('Failed to update/clear profile after booking:', err);
      }

      // notify clinic staff (if configured)
      const clinicObj = clinicsConfig.findClinicById(apptRec.clinicId);
      if (clinicObj && clinicObj.contactNumber) {
        const contactMsg = `📣 New appointment booked:
🦷 ${apptRec.service}
👤 ${apptRec.patientName} (${apptRec.phone})
📅 ${dayjs(apptRec.appointmentDate).format('DD MMM YYYY')}
⏰ ${apptRec.timeSlot}
🔖 ID: ${apptRec._id}`;
        try {
          await safeSendText(clinicObj.phoneNumberId, clinicObj.contactNumber, contactMsg);
        } catch (err) {
          console.error('Failed to notify clinic staff via WhatsApp', err);
        }
      }

      // confirm to user
      await safeSendText(clinicObj?.phoneNumberId || clinicPhoneNumberId, profile.phone, `🎉 Your appointment is confirmed for *${formatDate(apptRec.appointmentDate)}* at *${apptRec.timeSlot}*. See you soon! 👋`);
      return;
    } else {
      // user canceled at confirm step - clear session
      await clearSessionOnProfile(profile._id);
      return safeSendText(clinicPhoneNumberId, profile.phone, '❌ Booking cancelled. Reply *menu* to see options again.');
    }
  }
}

async function handleCancel(profile, clinicPhoneNumberId, from) {
  try {
    const rec = await Record.findOne({ phone: profile.phone, clinicId: profile.clinicId, status: { $in: ['booked','confirmed'] } }).sort({ appointmentDate: 1 });
    if (!rec) {
      return safeSendText(clinicPhoneNumberId, from, 'ℹ️ No upcoming appointment found to cancel.');
    }
    rec.status = 'cancelled';
    await rec.save();
    // also clear session on profile
    await clearSessionOnProfile(profile._id);
    return safeSendText(clinicPhoneNumberId, from, `✅ Your appointment on ${formatDate(rec.appointmentDate)} at ${rec.timeSlot} has been cancelled.`);
  } catch (err) {
    console.error('Error in handleCancel:', err);
    return safeSendText(clinicPhoneNumberId, from, '❌ Unable to cancel appointment right now.');
  }
}

async function handleStatus(profile, clinicPhoneNumberId, from) {
  try {
    const rec = await Record.findOne({ phone: profile.phone, clinicId: profile.clinicId }).sort({ appointmentDate: -1 });
    if (!rec) return safeSendText(clinicPhoneNumberId, from, 'ℹ️ No appointments found yet. Reply *1* to book.');
    return safeSendText(clinicPhoneNumberId, from, `📌 Latest appointment:
🦷 ${rec.service}
📅 ${formatDate(rec.appointmentDate)}
⏰ ${rec.timeSlot}
🛠 Status: ${rec.status}`);
  } catch (err) {
    console.error('Error in handleStatus:', err);
    return safeSendText(clinicPhoneNumberId, from, '❌ Unable to fetch status right now.');
  }
}

module.exports = { handleIncomingMessage };
