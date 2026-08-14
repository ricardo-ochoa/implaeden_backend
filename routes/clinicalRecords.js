// routes/clinicalRecords.js
// ---------------------------------------------------------------------------
// Expediente clínico odontológico capturado en la app (tabla `clinical_records`).
// Montado en /api/pacientes/:patientId/expediente (hereda patientId con mergeParams).
//
// Es el complemento digital de /api/clinical-histories, que sigue guardando los
// archivos escaneados. Un paciente puede tener varios expedientes, cada uno con
// su fecha; se capturan por pasos, así que nacen como 'borrador' y se marcan
// 'completado' al terminar.
//
// El formulario vive en `form_data` (JSON). Aquí solo se valida la envoltura
// (fecha, estado, que form_data sea un objeto); la forma de los campos la valida
// el front con zod, y el JSON se guarda tal cual para no tener que migrar la BD
// cada vez que se agrega un campo al formato.
// ---------------------------------------------------------------------------
const express = require('express');
const router = express.Router({ mergeParams: true });
const db = require('../config/db');
const { construirExpedienteClinicoPdf } = require('../services/expedienteClinicoPdf');
const { soloFecha } = require('./../services/pdfComun');

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const STATUSES = ['borrador', 'completado'];

const isYMD = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// mysql2 ya devuelve las columnas JSON parseadas, pero según la versión del
// driver/servidor pueden llegar como string. Normalizamos en un solo lugar.
const parseFormData = (value) => {
  if (isPlainObject(value)) return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return {};
};

// Valida el body compartido por POST y PUT. Devuelve { error } o los valores.
const readBody = (body, { requireDate }) => {
  const { record_date, status, form_data } = body || {};

  if (record_date !== undefined && !isYMD(record_date)) {
    return { error: 'record_date debe tener formato YYYY-MM-DD.' };
  }
  if (requireDate && !record_date) {
    return { error: 'record_date es obligatorio.' };
  }
  if (status !== undefined && !STATUSES.includes(status)) {
    return { error: `status debe ser uno de: ${STATUSES.join(', ')}.` };
  }
  if (form_data !== undefined && !isPlainObject(form_data)) {
    return { error: 'form_data debe ser un objeto.' };
  }

  return { record_date, status, form_data };
};

// Confirma que el paciente existe antes de tocar sus expedientes.
const patientExists = async (patientId) => {
  const [rows] = await db.query('SELECT id FROM pacientes WHERE id = ?', [patientId]);
  return rows.length > 0;
};

// GET /  -> lista de expedientes del paciente.
// Incluye `form_data` completo porque la lista muestra cuántos pasos van
// contestados, y esa regla vive en el front (components/expediente-clinico/
// completitud.js). Calcularla aquí obligaría a mantener la misma lógica en dos
// lenguajes; el costo es bajo: son pocos expedientes por paciente y el JSON
// pesa unos cuantos KB. `motivo_consulta` y `diagnostico` se conservan
// extraídos para no cambiar lo que ya consume la tarjeta.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params;

    const [rows] = await db.query(
      `SELECT
         id,
         patient_id,
         record_date,
         status,
         created_at,
         updated_at,
         form_data,
         JSON_UNQUOTE(JSON_EXTRACT(form_data, '$.motivoConsulta')) AS motivo_consulta,
         JSON_UNQUOTE(JSON_EXTRACT(form_data, '$.diagnostico'))    AS diagnostico
       FROM clinical_records
       WHERE patient_id = ?
       ORDER BY record_date DESC, id DESC`,
      [patientId]
    );

    res.json(rows.map((row) => ({ ...row, form_data: parseFormData(row.form_data) })));
  })
);

// GET /:id/pdf -> el formato FO-CD-00003 capturado, como PDF imprimible.
// Va antes de GET /:id porque Express resuelve por orden de declaración.
router.get(
  '/:id/pdf',
  asyncHandler(async (req, res) => {
    const { patientId, id } = req.params;

    const [pacientes] = await db.query('SELECT * FROM pacientes WHERE id = ?', [patientId]);
    if (pacientes.length === 0) {
      return res.status(404).json({ error: 'Paciente no encontrado.' });
    }

    const [rows] = await db.query(
      'SELECT * FROM clinical_records WHERE id = ? AND patient_id = ?',
      [id, patientId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Expediente clínico no encontrado.' });
    }

    const expediente = { ...rows[0], form_data: parseFormData(rows[0].form_data) };

    const buffer = await construirExpedienteClinicoPdf({
      paciente: pacientes[0],
      expediente,
    });

    const apellido = String(pacientes[0].apellidos || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();

    // mysql2 devuelve DATE como objeto Date; `soloFecha` lo normaliza a
    // YYYY-MM-DD (un String(date).split('T') daría cadena vacía por el "Thu").
    const fecha = soloFecha(expediente.record_date);
    const nombreDescarga = `expediente-clinico-${apellido || patientId}-${fecha}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreDescarga}"`);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    res.send(buffer);
  })
);

// GET /:id -> expediente completo (incluye form_data)
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { patientId, id } = req.params;

    const [rows] = await db.query(
      'SELECT * FROM clinical_records WHERE id = ? AND patient_id = ?',
      [id, patientId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Expediente clínico no encontrado.' });
    }

    res.json({ ...rows[0], form_data: parseFormData(rows[0].form_data) });
  })
);

// POST / -> crea un expediente (normalmente un borrador vacío que el wizard
// va llenando paso a paso con PUT).
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params;
    const parsed = readBody(req.body, { requireDate: true });
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    if (!(await patientExists(patientId))) {
      return res.status(404).json({ error: 'Paciente no encontrado.' });
    }

    const formData = parsed.form_data || {};
    const status = parsed.status || 'borrador';

    const [result] = await db.query(
      `INSERT INTO clinical_records
         (patient_id, record_date, status, form_data, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, CAST(? AS JSON), ?, ?, NOW(), NOW())`,
      [
        patientId,
        parsed.record_date,
        status,
        JSON.stringify(formData),
        req.user?.id || null,
        req.user?.id || null,
      ]
    );

    res.status(201).json({
      id: result.insertId,
      patient_id: Number(patientId),
      record_date: parsed.record_date,
      status,
      form_data: formData,
    });
  })
);

// PUT /:id -> actualiza fecha, estado y/o el JSON del formulario.
// El wizard guarda el formulario completo en cada paso, así que form_data se
// reemplaza entero (no hay merge parcial).
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { patientId, id } = req.params;
    const parsed = readBody(req.body, { requireDate: false });
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const fields = [];
    const values = [];

    if (parsed.record_date !== undefined) {
      fields.push('record_date = ?');
      values.push(parsed.record_date);
    }
    if (parsed.status !== undefined) {
      fields.push('status = ?');
      values.push(parsed.status);
    }
    if (parsed.form_data !== undefined) {
      fields.push('form_data = CAST(? AS JSON)');
      values.push(JSON.stringify(parsed.form_data));
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No hay nada que actualizar.' });
    }

    fields.push('updated_by = ?');
    values.push(req.user?.id || null);
    fields.push('updated_at = NOW()');

    const [result] = await db.query(
      `UPDATE clinical_records SET ${fields.join(', ')} WHERE id = ? AND patient_id = ?`,
      [...values, id, patientId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Expediente clínico no encontrado.' });
    }

    res.json({ message: 'Expediente clínico actualizado exitosamente.' });
  })
);

// DELETE /:id
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { patientId, id } = req.params;

    const [result] = await db.query(
      'DELETE FROM clinical_records WHERE id = ? AND patient_id = ?',
      [id, patientId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Expediente clínico no encontrado.' });
    }

    res.json({ message: 'Expediente clínico eliminado exitosamente.' });
  })
);

module.exports = router;
