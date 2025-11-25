// models/Session.js
const mongoose = require('mongoose');

// store minimal session state to continue flows across restarts
const SessionSchema = new mongoose.Schema({
  whatsapp_id: { type: String, required: true, unique: true }, // e.g., 'whatsapp:+9198...'
  state: { type: String, default: 'MENU' },
  data: { type: Object, default: {} },
  updated_at: { type: Date, default: Date.now }
});

SessionSchema.pre('save', function(next) {
  this.updated_at = Date.now();
  next();
});

module.exports = mongoose.model('Session', SessionSchema);
