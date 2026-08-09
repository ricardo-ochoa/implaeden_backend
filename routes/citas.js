// routes/citas.js
// ---------------------------------------------------------------------------
// Citas de un paciente, respaldadas por GOOGLE CALENDAR (fuente de verdad).
// Montado en /api/pacientes/:patientId/citas (hereda patientId con mergeParams).
//
// Fase 1: listar (GET /) y crear (POST /). Editar/eliminar y reconciliación
// de Confirmafy llegan en la Fase 2.
//
// NOTA: la tabla MySQL `citas` queda como LEGACY (ya no se usa desde aquí).
// ---------------------------------------------------------------------------
const express = require('express');
const router = express.Router({ mergeParams: true });

const gcal = require('../services/googleCalendar');
const { getService, getPatientContact } = require('../services/lookups');

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// Traduce errores de configuración de GCal a respuestas HTTP claras.
// Devuelve true si ya respondió; false si el error debe propagarse.
function respondGcalConfigError(res, err) {
  if (err.code === 'GCAL_NOT_CONFIGURED') {
    res.status(503).json({ error: 'Google Calendar no está configurado en el servidor.' });
    return true;
  }
  if (err.code === 'GCAL_BAD_KEY') {
    res.status(500).json({ error: 'Credenciales de Google Calendar inválidas.' });
    return true;
  }
  return false;
}

// GET /api/pacientes/:patientId/citas  -> citas del paciente (desde GCal)
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params;
    const { from, to } = req.query; // opcionales, RFC3339
    try {
      const appts = await gcal.listByPatient(patientId, { timeMin: from, timeMax: to });
      res.json(appts);
    } catch (err) {
      if (respondGcalConfigError(res, err)) return;
      throw err;
    }
  })
);

// POST /api/pacientes/:patientId/citas  -> crea cita en GCal
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params;
    const { start, end, serviceId, serviceName: serviceNameIn, observaciones, status } = req.body;

    if (!start || !end) {
      return res.status(400).json({ error: 'start y end son obligatorios (RFC3339).' });
    }
    // El paciente debe existir; el tratamiento es OPCIONAL.
    const pac = await getPatientContact(patientId);
    if (!pac) return res.status(404).json({ error: 'El paciente no existe.' });
    let serviceName = null;
    if (serviceId) {
      const svc = await getService(serviceId);
      if (!svc) return res.status(400).json({ error: 'El servicio indicado no existe.' });
      serviceName = svc.name;
    } else if (serviceNameIn) {
      serviceName = String(serviceNameIn); // p. ej. "Chequeo General" por defecto
    }

    try {
      const contactName = `${pac.nombre || ''} ${pac.apellidos || ''}`.trim() || undefined;
      const contactPhone = String(pac.telefono || '').replace(/\D/g, '') || undefined;
      const created = await gcal.create({
        patientId,
        start,
        end,
        serviceId,
        serviceName,
        contactName,   // para el título legible
        contactPhone,  // para que Confirmafy recuerde por WhatsApp
        observations: observaciones,
        status,
      });
      res.status(201).json(created);
    } catch (err) {
      if (respondGcalConfigError(res, err)) return;
      throw err;
    }
  })
);

module.exports = router;
