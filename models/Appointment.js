// models/Appointment.js
const mongoose = require('mongoose');

const AppointmentSchema = new mongoose.Schema({
  clinic_key: { type: String, required: true },     // phone_number_id
  clinic_name: { type: String, required: true },
  whatsapp_number: { type: String, required: true },// 'whatsapp:+91...'
  name: { type: String },
  phone: { type: String },
  service: { type: String },
  appointment_date: { type: String }, // YYYY-MM-DD
  appointment_time: { type: String },
  created_at: { type: Date, default: Date.now }
});

AppointmentSchema.index({ clinic_key: 1, created_at: -1 });

module.exports = mongoose.model('Appointment', AppointmentSchema);
