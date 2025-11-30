// utils/clinicsConfig.js
'use strict';

function loadClinicsFromEnv() {
  const raw = process.env.CLINICS_JSON || '[]';
  let clinics = [];
  try {
    clinics = JSON.parse(raw);
    if (!Array.isArray(clinics)) {
      console.error('⚠️ CLINICS_JSON is not an array — falling back to [].');
      clinics = [];
    }
  } catch (err) {
    console.error('⚠️ CLINICS_JSON parse error. Ensure valid JSON array in env.', err.message);
    clinics = [];
  }

  // Normalize and validate entries
  const normalized = [];
  clinics.forEach((c, i) => {
    if (!c || typeof c !== 'object') {
      console.warn(`⚠️ clinicsConfig: skipping invalid clinic entry at index ${i}`);
      return;
    }

    const clinicId = c.clinicId != null ? String(c.clinicId).trim() : '';
    const clinicName = c.clinicName != null ? String(c.clinicName).trim() : '';
    const phoneNumberId = c.phoneNumberId != null ? String(c.phoneNumberId).trim() : '';
    const contactNumber = c.contactNumber != null ? String(c.contactNumber).trim() : '';

    if (!clinicId || !clinicName || !phoneNumberId) {
      console.warn(`⚠️ clinicsConfig: clinic at index ${i} missing required fields (clinicId, clinicName, phoneNumberId). Skipping.`);
      return;
    }

    normalized.push({
      clinicId,
      clinicName,
      phoneNumberId,
      contactNumber
    });
  });

  return normalized;
}

let clinics = loadClinicsFromEnv();

/**
 * Reload clinics from process.env.CLINICS_JSON at runtime.
 * Useful in dev/testing when you want to change env without restarting the server.
 */
function reloadClinics() {
  clinics = loadClinicsFromEnv();
  return clinics;
}

function findClinicByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  return clinics.find(c => String(c.phoneNumberId) === String(phoneNumberId)) || null;
}

function findClinicById(clinicId) {
  if (!clinicId) return null;
  return clinics.find(c => c.clinicId === String(clinicId)) || null;
}

/**
 * Find by the publicly-visible contact number (e.g. +919888844411)
 */
function findClinicByContactNumber(contactNumber) {
  if (!contactNumber) return null;
  const normalized = String(contactNumber).replace(/\s+/g, '').replace(/^\+/, '');
  return clinics.find(c => {
    if (!c.contactNumber) return false;
    const cNorm = String(c.contactNumber).replace(/\s+/g, '').replace(/^\+/, '');
    return cNorm === normalized;
  }) || null;
}

function getAllClinics() {
  return clinics.slice(); // return shallow copy
}

module.exports = {
  findClinicByPhoneNumberId,
  findClinicById,
  findClinicByContactNumber,
  getAllClinics,
  reloadClinics
};
