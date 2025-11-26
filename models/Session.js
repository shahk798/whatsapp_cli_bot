// models/Session.js
const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema({
  clinic_key: { type: String, required: true },   // phone_number_id
  whatsapp_id: { type: String, required: true },  // 'whatsapp:+91...'
  state: { type: String, default: 'MENU' },
  data: { type: Object, default: {} },
  updated_at: { type: Date, default: Date.now }
});

SessionSchema.index({ clinic_key: 1, whatsapp_id: 1 }, { unique: true });

SessionSchema.pre('save', function(next) {
  this.updated_at = Date.now();
  next();
});

module.exports = mongoose.model('Session', SessionSchema);
