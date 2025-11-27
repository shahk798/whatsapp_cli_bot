// utils/clinicsConfig.js
function loadClinics() {
  const raw = process.env.CLINICS_JSON || '[]';
  let clinics = [];
  try {
    clinics = JSON.parse(raw);
    if (!Array.isArray(clinics)) clinics = [];
  } catch (err) {
    console.error('⚠️ CLINICS_JSON parse error. Ensure valid JSON array in env.');
    clinics = [];
  }
  clinics = clinics.map(c => ({
    clinicId: c.clinicId,
    clinicName: c.clinicName,
    phoneNumberId: String(c.phoneNumberId),
    contactNumber: c.contactNumber
  }));
  return clinics;
}

const clinics = loadClinics();

function findClinicByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  return clinics.find(c => String(c.phoneNumberId) === String(phoneNumberId)) || null;
}

function findClinicById(clinicId) {
  return clinics.find(c => c.clinicId === clinicId) || null;
}

function getAllClinics() {
  return clinics;
}

module.exports = { findClinicByPhoneNumberId, findClinicById, getAllClinics };
