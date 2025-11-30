// models/Record.js
const mongoose = require('mongoose');

const RecordSchema = new mongoose.Schema({
  // clinic info
  clinicId: { type: String, required: true, index: true },
  clinicName: { type: String, required: true },

  // patient/profile info
  patientName: { type: String, default: '' },
  phone: { type: String, required: true, index: true },
  email: { type: String, default: '' },

  // appointment/service info
  service: { type: String, default: '' },
  price: { type: Number, default: Number(process.env.DEFAULT_PRICE || 0) },

  // appointment date/time (flat)
  // use Date for date so you can query by date range. We expose a string in toCleanJSON().
  date: { type: Date, default: null },
  time: { type: String, default: '' },

  // status
  status: {
    type: String,
    enum: ['booked', 'confirmed', 'completed', 'cancelled', 'no-show', 'profile'],
    default: 'profile'
  },

  // optional: keep for integrations / debugging. Remove if not needed.
  source: { type: String, default: 'whatsapp' },
  metadata: { type: Object, default: {} }

}, {
  timestamps: true // createdAt, updatedAt
});

// Instance helper to return the clean JSON shape your frontend / API expects
RecordSchema.methods.toCleanJSON = function() {
  return {
    clinicId: this.clinicId || '',
    clinicName: this.clinicName || '',
    patientName: this.patientName || '',
    phone: this.phone || '',
    email: this.email || '',
    price: typeof this.price === 'number' ? this.price : Number(this.price || 0),
    service: this.service || '',
    status: this.status || 'profile',
    // expose date as ISO string (YYYY-MM-DD) or empty string if null
    date: this.date ? this.date.toISOString().split('T')[0] : '',
    // keep time as provided (e.g. "15:30" or "3:30 PM - 4:00 PM")
    time: this.time || ''
  };
};

// Static helper to create/update using old document shape (optional)
// Useful during migration: pass an old doc and transform to the new flat fields
RecordSchema.statics.fromLegacy = function(oldDoc = {}) {
  const rec = {
    clinicId: oldDoc.clinicId || (oldDoc.clinic && oldDoc.clinic._id) || '',
    clinicName: oldDoc.clinicName || (oldDoc.clinic && oldDoc.clinic.name) || '',
    patientName: oldDoc.patientName || (oldDoc.profile && (oldDoc.profile.patientName || oldDoc.profile.name)) || '',
    phone: oldDoc.phone || (oldDoc.profile && oldDoc.profile.wa_id) || '',
    email: oldDoc.email || (oldDoc.profile && oldDoc.profile.email) || '',
    price: typeof oldDoc.price === 'number' ? oldDoc.price : (oldDoc.profile && oldDoc.profile.price) || Number(process.env.DEFAULT_PRICE || 0),
    service: oldDoc.service || (oldDoc.metadata && oldDoc.metadata.service) || '',
    status: oldDoc.status || 'profile',
    date: oldDoc.appointmentDate || oldDoc.date || null,
    time: oldDoc.timeSlot || oldDoc.time || ''
  };
  return rec;
};

module.exports = mongoose.model('Record', RecordSchema);
