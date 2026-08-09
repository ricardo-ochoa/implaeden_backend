// services/lookups.js
// ---------------------------------------------------------------------------
// Lecturas puntuales a la BD usando Knex (primer uso del query builder).
// Se usan para validar/enriquecer datos al crear citas contra Google Calendar
// (que es la fuente de verdad de la agenda, pero paciente/servicio viven en MySQL).
// ---------------------------------------------------------------------------
const db = require('../db/knex');

// ¿Existe el paciente?
async function patientExists(patientId) {
  const row = await db('pacientes').select('id').where({ id: patientId }).first();
  return Boolean(row);
}

// Devuelve { id, name } del servicio, o null si no existe.
async function getService(serviceId) {
  const row = await db('services').select('id', 'name').where({ id: serviceId }).first();
  return row || null;
}

// Datos de contacto del paciente (para poner nombre+teléfono en el título del evento).
async function getPatientContact(patientId) {
  const row = await db('pacientes')
    .select('id', 'nombre', 'apellidos', 'telefono')
    .where({ id: patientId })
    .first();
  return row || null;
}

module.exports = { patientExists, getService, getPatientContact };
