// modules/whatsapp.js
const axios = require('axios');

const API_BASE = 'https://graph.facebook.com';

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

module.exports = { sendText, sendInteractive };
