// services/reconcile.js
// ---------------------------------------------------------------------------
// Reconciliación de citas de Confirmafy/manuales con pacientes de Implaedén.
// Usa Knex sobre patient_phones (muchos-a-muchos) + búsqueda por nombre.
// ---------------------------------------------------------------------------
const db = require('../db/knex');

// Normaliza a últimos 10 dígitos (formato local MX), igual que el backfill.
function normPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

// Pacientes que tienen ese teléfono (puede haber varios: p. ej. padre + hijo).
async function patientsByPhone(phone) {
  const p = normPhone(phone);
  if (!p) return [];
  return db('patient_phones as pp')
    .join('pacientes as pa', 'pa.id', 'pp.patient_id')
    .where('pp.phone', p)
    .select('pa.id', 'pa.nombre', 'pa.apellidos', 'pa.telefono');
}

// Pacientes cuyo nombre/apellidos se parecen (best-effort, para "sugerir").
async function patientsByName(name) {
  const n = String(name || '').trim();
  if (n.length < 3) return [];
  const like = `%${n}%`;
  return db('pacientes')
    .where('nombre', 'like', like)
    .orWhereRaw("CONCAT(nombre, ' ', COALESCE(apellidos, '')) LIKE ?", [like])
    .select('id', 'nombre', 'apellidos', 'telefono')
    .limit(5);
}

// Dada una cita (con contactPhone/contactName), calcula la SUGERENCIA:
//  - auto        : 1 paciente por teléfono → vincular directo
//  - disambiguate: 2+ pacientes con ese teléfono → elegir cuál
//  - by_name     : sin match de teléfono pero el nombre coincide → sugerir (+ agregar teléfono al confirmar)
//  - new         : sin nada → crear paciente rápido
async function suggestForEvent(appt) {
  const byPhone = await patientsByPhone(appt.contactPhone);
  if (byPhone.length === 1) return { type: 'auto', candidates: byPhone };
  if (byPhone.length > 1) return { type: 'disambiguate', candidates: byPhone };

  const byName = await patientsByName(appt.contactName);
  if (byName.length >= 1) return { type: 'by_name', candidates: byName };

  return { type: 'new', candidates: [] };
}

// Agrega un teléfono a un paciente (idempotente por UNIQUE(patient_id, phone)).
async function addPhoneToPatient(patientId, phone, label = null) {
  const p = normPhone(phone);
  if (!p) return false;
  await db('patient_phones')
    .insert({ patient_id: patientId, phone: p, label })
    .onConflict()
    .ignore();
  return true;
}

// Crea un paciente "rápido" (solo nombre + teléfono) para citas de gente no registrada.
async function quickCreatePatient({ nombre, telefono }) {
  if (!nombre || !telefono) {
    const err = new Error('nombre y telefono son obligatorios');
    err.code = 'QUICK_MISSING';
    throw err;
  }
  const [id] = await db('pacientes').insert({
    nombre: String(nombre).trim(),
    telefono: String(telefono).trim(),
    registro_incompleto: 1,
  });
  await addPhoneToPatient(id, telefono, 'principal');
  return id;
}

module.exports = {
  normPhone,
  patientsByPhone,
  patientsByName,
  suggestForEvent,
  addPhoneToPatient,
  quickCreatePatient,
};
