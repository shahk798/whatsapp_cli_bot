// models/Record.js
const mongoose = require('mongoose');

const SessionSubSchema = new mongoose.Schema({
  state: { type: String, default: 'idle' },
  data: { type: Object, default: {} },
  updatedAt: { type: Date, default: Date.now },
  // expiresAt is optional — used by app logic to treat sessions as expired after a TTL
  expiresAt: { type: Date, default: null }
}, { _id: false });

const RecordSchema = new mongoose.Schema({
  // clinic info
  clinicId: { type: String, index: true, required: true },
  clinicName: { type: String, required: true },

  // patient/profile info (profile docs have appointmentDate == null)
  patientName: { type: String, default: '' },
  phone: { type: String, required: true, index: true },
  email: { type: String, default: '' },

  // appointment/service info - for appointment docs (appointmentDate != null)
  service: { type: String, default: '' },
  price: { type: Number, default: Number(process.env.DEFAULT_PRICE || 0) },

  // appointmentDate null => profile-only doc; otherwise an appointment doc
  appointmentDate: { type: Date, default: null },
  timeSlot: { type: String, default: '' },

  status: { type: String, enum: ['booked','confirmed','completed','cancelled','no-show','profile'], default: 'profile' },

  // session subdocument lives on the profile doc only (appointment docs generally won't have session)
  session: { type: SessionSubSchema, default: null },

  source: { type: String, default: 'whatsapp' },
  metadata: { type: Object, default: {} },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// keep updatedAt fresh
RecordSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Record', RecordSchema);
