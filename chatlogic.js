// chatlogic.js
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
