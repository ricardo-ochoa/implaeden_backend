// routes/appointments.js
// ---------------------------------------------------------------------------
// Vista GLOBAL de la agenda de la clínica (todas las citas en un rango),
// respaldada por Google Calendar. Montado en /api/appointments.
//
// Fase 1: GET /calendar?from=&to=  (rango). En Fase 2 se agregan:
//   GET /unassigned (bandeja Confirmafy) · POST /:eventId/link · PATCH · DELETE
// ---------------------------------------------------------------------------
const express = require('express');
const router = express.Router();

const gcal = require('../services/googleCalendar');
const reconcile = require('../services/reconcile');
const { getService } = require('../services/lookups');

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function respondGcalConfigError(res, err) {
  if (err.code === 'GCAL_NOT_CONFIGURED') {
    res.status(503).json({ error: 'Google Calendar no está configurado en el servidor.' });
    return true;
  }
  if (err.code === 'GCAL_BAD_KEY') {
    res.status(500).json({ error: 'Credenciales de Google Calendar inválidas.' });
    return true;
  }

  // `invalid_grant` = el GOOGLE_OAUTH_REFRESH_TOKEN dejó de servir (revocado,
  // caducado, o la pantalla de consentimiento sigue en modo "Testing", donde
  // Google mata los refresh tokens cada 7 días).
  //
  // Sin esto se iba al handler genérico y la agenda respondía 500
  // "Ocurrió un error en el servidor / invalid_grant": ni el usuario entiende
  // qué pasó ni queda claro que la app está bien y lo que falta es reconectar.
  const mensaje = String(err?.message || '');
  const respuesta = String(err?.response?.data?.error || '');

  if (mensaje.includes('invalid_grant') || respuesta === 'invalid_grant') {
    res.status(503).json({
      error:
        'La conexión con Google Calendar caducó. Hay que volver a autorizar la cuenta para ver la agenda.',
      code: 'GCAL_REAUTH_REQUIRED',
    });
    return true;
  }

  return false;
}

// GET /api/appointments/calendar?from=&to=  -> todas las citas del rango
router.get(
  '/calendar',
  asyncHandler(async (req, res) => {
    const { from, to } = req.query; // RFC3339 recomendado
    try {
      const appts = await gcal.listRange({ timeMin: from, timeMax: to });
      res.json(appts);
    } catch (err) {
      if (respondGcalConfigError(res, err)) return;
      throw err;
    }
  })
);

// POST /api/appointments  -> crear cita rápida por nombre + teléfono (estilo GCal)
// body: { start, end, nombre, telefono, serviceName?, observaciones? }
// Auto-vincula si el teléfono coincide EXACTAMENTE con 1 paciente.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { start, end, nombre, telefono, serviceName, observaciones, patientId } = req.body || {};
    if (!start || !end) return res.status(400).json({ error: 'start y end son obligatorios.' });
    if (!nombre && !telefono) return res.status(400).json({ error: 'nombre o teléfono es obligatorio.' });
    try {
      const digits = String(telefono || '').replace(/\D/g, ''); // completo, para el título (Confirmafy)
      const phone = reconcile.normPhone(telefono);               // últimos 10, para el match
      const created = await gcal.create({
        start,
        end,
        contactName: nombre,
        contactPhone: digits,
        serviceName: serviceName || undefined,
        observations: observaciones,
        status: 'scheduled',
      });
      // 1) Vinculación explícita a un paciente elegido en el modal
      if (patientId) {
        const linked = await gcal.linkToPatient(created.eventId, Number(patientId));
        if (phone) await reconcile.addPhoneToPatient(Number(patientId), phone);
        return res.status(201).json({ ...linked, linkedTo: Number(patientId) });
      }
      // 2) Auto-vinculación si el teléfono coincide con 1 paciente
      if (phone) {
        const matches = await reconcile.patientsByPhone(phone);
        if (matches.length === 1) {
          const linked = await gcal.linkToPatient(created.eventId, matches[0].id);
          return res.status(201).json({ ...linked, autoLinkedTo: matches[0] });
        }
      }
      res.status(201).json(created);
    } catch (err) {
      if (respondGcalConfigError(res, err)) return;
      throw err;
    }
  })
);

// GET /api/appointments/suggest?phone=&name=  -> sugerencia de paciente (para vincular en un modal)
router.get(
  '/suggest',
  asyncHandler(async (req, res) => {
    const { phone, name } = req.query;
    const suggestion = await reconcile.suggestForEvent({ contactPhone: phone, contactName: name });
    res.json(suggestion);
  })
);

// GET /api/appointments/unassigned?from=&to=  -> citas sin vincular + sugerencia
router.get(
  '/unassigned',
  asyncHandler(async (req, res) => {
    const { from, to } = req.query;
    try {
      const appts = await gcal.listUnassigned({ timeMin: from, timeMax: to });
      const enriched = [];
      for (const a of appts) {
        const suggestion = await reconcile.suggestForEvent(a);
        const { raw, ...rest } = a; // no mandamos el evento crudo
        enriched.push({ ...rest, suggestion });
      }
      res.json(enriched);
    } catch (err) {
      if (respondGcalConfigError(res, err)) return;
      throw err;
    }
  })
);

// POST /api/appointments/:eventId/link  -> vincular a paciente
// body: { patientId } | { newPatient:{nombre,telefono} } | { patientId, addPhone }
router.post(
  '/:eventId/link',
  asyncHandler(async (req, res) => {
    const { patientId, newPatient, addPhone } = req.body || {};
    try {
      let pid = patientId;
      if (newPatient) {
        pid = await reconcile.quickCreatePatient(newPatient);
      } else if (!pid) {
        return res.status(400).json({ error: 'patientId o newPatient es obligatorio' });
      } else if (addPhone) {
        await reconcile.addPhoneToPatient(pid, addPhone);
      }
      const linked = await gcal.linkToPatient(req.params.eventId, pid);
      res.status(200).json(linked);
    } catch (err) {
      if (respondGcalConfigError(res, err)) return;
      if (err.code === 'QUICK_MISSING') return res.status(400).json({ error: err.message });
      throw err;
    }
  })
);

// PATCH /api/appointments/:eventId  -> editar cita
router.patch(
  '/:eventId',
  asyncHandler(async (req, res) => {
    const { start, end, serviceId, observaciones, status, nombre, telefono } = req.body || {};
    const changes = {};
    if (start) changes.start = start;
    if (end) changes.end = end;
    if (status !== undefined) changes.status = status;
    if (observaciones !== undefined) changes.observations = observaciones;
    if (nombre !== undefined) changes.contactName = nombre;
    if (telefono !== undefined) changes.contactPhone = String(telefono).replace(/\D/g, '');
    if (serviceId) {
      const svc = await getService(serviceId);
      if (!svc) return res.status(400).json({ error: 'El servicio indicado no existe.' });
      changes.serviceId = serviceId;
      changes.serviceName = svc.name;
    }
    try {
      const updated = await gcal.update(req.params.eventId, changes);
      res.json(updated);
    } catch (err) {
      if (respondGcalConfigError(res, err)) return;
      throw err;
    }
  })
);

// DELETE /api/appointments/:eventId  -> eliminar cita
router.delete(
  '/:eventId',
  asyncHandler(async (req, res) => {
    try {
      res.json(await gcal.remove(req.params.eventId));
    } catch (err) {
      if (respondGcalConfigError(res, err)) return;
      throw err;
    }
  })
);

module.exports = router;
