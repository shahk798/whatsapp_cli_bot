// models/Session.js
const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema({
  clinicId: { type: String, index: true },
  phone: { type: String, index: true },
  state: { type: String, default: 'idle' }, // e.g., idle, booking_name, booking_service, booking_date, booking_time, booking_confirm
  data: { type: Object, default: {} },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

SessionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Session', SessionSchema);
