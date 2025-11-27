// models/Session.js
const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema({
<<<<<<< HEAD
  clinicId: { type: String, index: true },
  phone: { type: String, index: true },
  state: { type: String, default: 'idle' }, // e.g., idle, booking_name, booking_service, booking_date, booking_time, booking_confirm
  data: { type: Object, default: {} },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

SessionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
=======
  clinic_key: { type: String, required: true },   // phone_number_id
  whatsapp_id: { type: String, required: true },  // 'whatsapp:+91...'
  state: { type: String, default: 'MENU' },
  data: { type: Object, default: {} },
  updated_at: { type: Date, default: Date.now }
});

SessionSchema.index({ clinic_key: 1, whatsapp_id: 1 }, { unique: true });

SessionSchema.pre('save', function(next) {
  this.updated_at = Date.now();
>>>>>>> e20e93a863e53ba526b09c50f43bee7ce030954e
  next();
});

module.exports = mongoose.model('Session', SessionSchema);
