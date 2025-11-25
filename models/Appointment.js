// models/Appointment.js
const mongoose = require('mongoose');

const AppointmentSchema = new mongoose.Schema({
  whatsapp_number: { type: String, required: true }, // format: whatsapp:+9198....
  name: { type: String },
  phone: { type: String },
  service: { type: String },
  appointment_date: { type: String }, // store as YYYY-MM-DD string for simplicity
  appointment_time: { type: String },
  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Appointment', AppointmentSchema);
