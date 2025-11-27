// models/Record.js
const mongoose = require('mongoose');

const RecordSchema = new mongoose.Schema({
  clinicId: { type: String, index: true, required: true },
  clinicName: { type: String, required: true },

  // patient info
  patientName: { type: String, default: '' },
  phone: { type: String, required: true, index: true },
  email: { type: String, default: '' },

  // appointment/service info
  service: { type: String, default: '' },
  price: { type: Number, default: Number(process.env.DEFAULT_PRICE || 0) },

  // allow empty appointmentDate for profile-only records
  appointmentDate: { type: Date, default: null },
  timeSlot: { type: String, default: '' },

  // 'profile' used when the document is a patient profile (no appointment)
  status: { type: String, enum: ['booked','confirmed','completed','cancelled','no-show','profile'], default: 'profile' },

  source: { type: String, default: 'whatsapp' },
  metadata: { type: Object, default: {} },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

RecordSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Record', RecordSchema);
