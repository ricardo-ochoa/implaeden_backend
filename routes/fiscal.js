// routes/fiscal.js
// ---------------------------------------------------------------------------
// Datos fiscales del paciente: Constancia de Situación Fiscal y los campos que
// se transcriben de ella para facturar.
//
// Montado en /api/pacientes/:patientId/fiscal (mergeParams), con auth.
// La contraparte pública, donde el paciente sube su propia constancia con un
// link privado, vive en routes/fiscalPublico.js.
// ---------------------------------------------------------------------------
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const router = express.Router({ mergeParams: true });

const db = require('../config/db');
const { s3, S3_BUCKET } = require('../config/s3');
const { guardarConstancia, validarArchivo, manejarErrorDeSubida, MAX_BYTES } = require('../services/fiscalDocs');

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

const DIAS_VIGENCIA_TOKEN = 30;

const limpiar = (v) => {
  const s = String(v ?? '').trim();
  return s || null;
};

const patientExists = async (patientId) => {
  const [rows] = await db.query('SELECT id FROM pacientes WHERE id = ?', [patientId]);
  return rows.length > 0;
};

// El token nunca se devuelve solo: el front necesita la URL completa para
// copiarla, y esa base depende del entorno.
const urlDelToken = (token) => {
  const base = (process.env.APP_PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/constancia/${token}`;
};

// GET / -> perfil fiscal + documentos + link activo
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params;

    if (!(await patientExists(patientId))) {
      return res.status(404).json({ error: 'Paciente no encontrado.' });
    }

    const [[perfil]] = await db.query(
      'SELECT * FROM patient_fiscal_profiles WHERE patient_id = ?',
      [patientId]
    );

    const [documentos] = await db.query(
      `SELECT * FROM patient_fiscal_documents
       WHERE patient_id = ?
       ORDER BY vigente DESC, created_at DESC`,
      [patientId]
    );

    const [[token]] = await db.query(
      `SELECT * FROM patient_fiscal_tokens
       WHERE patient_id = ? AND revoked_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [patientId]
    );

    res.json({
      perfil: perfil || null,
      documentos,
      link: token ? { url: urlDelToken(token.token), expires_at: token.expires_at } : null,
    });
  })
);

// PUT /perfil -> datos fiscales (todos opcionales)
router.put(
  '/perfil',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params;

    if (!(await patientExists(patientId))) {
      return res.status(404).json({ error: 'Paciente no encontrado.' });
    }

    const rfc = limpiar(req.body?.rfc)?.toUpperCase() || null;
    // El RFC mexicano es 12 (moral) o 13 (física) caracteres. Se valida solo si
    // viene: la constancia puede guardarse antes de transcribir los datos.
    if (rfc && !/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfc)) {
      return res.status(400).json({ error: 'El RFC no tiene un formato válido.' });
    }

    const cp = limpiar(req.body?.codigo_postal);
    if (cp && !/^\d{5}$/.test(cp)) {
      return res.status(400).json({ error: 'El código postal debe tener 5 dígitos.' });
    }

    const razon = limpiar(req.body?.razon_social);
    const regimen = limpiar(req.body?.regimen_fiscal);

    await db.query(
      `INSERT INTO patient_fiscal_profiles
         (patient_id, rfc, razon_social, regimen_fiscal, codigo_postal, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         rfc = VALUES(rfc),
         razon_social = VALUES(razon_social),
         regimen_fiscal = VALUES(regimen_fiscal),
         codigo_postal = VALUES(codigo_postal),
         updated_by = VALUES(updated_by),
         updated_at = NOW()`,
      [patientId, rfc, razon, regimen, cp, req.user?.id || null]
    );

    const [[perfil]] = await db.query(
      'SELECT * FROM patient_fiscal_profiles WHERE patient_id = ?',
      [patientId]
    );

    res.json(perfil);
  })
);

// POST /documentos -> sube una constancia (queda como vigente)
router.post(
  '/documentos',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const { patientId } = req.params;

    if (!(await patientExists(patientId))) {
      return res.status(404).json({ error: 'Paciente no encontrado.' });
    }

    const validacion = validarArchivo(req.file);
    if (validacion.error) return res.status(400).json({ error: validacion.error });

    const doc = await guardarConstancia({
      patientId: Number(patientId),
      file: req.file,
      origen: 'clinica',
      uploadedBy: req.user?.id || null,
    });

    res.status(201).json(doc);
  })
);

// PATCH /documentos/:id/vigente -> marca una versión anterior como la vigente
router.patch(
  '/documentos/:id/vigente',
  asyncHandler(async (req, res) => {
    const { patientId, id } = req.params;

    const [rows] = await db.query(
      'SELECT id FROM patient_fiscal_documents WHERE id = ? AND patient_id = ?',
      [id, patientId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Documento no encontrado.' });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        'UPDATE patient_fiscal_documents SET vigente = 0 WHERE patient_id = ?',
        [patientId]
      );
      await conn.query(
        'UPDATE patient_fiscal_documents SET vigente = 1, updated_at = NOW() WHERE id = ?',
        [id]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.json({ message: 'Documento marcado como vigente.' });
  })
);

// DELETE /documentos/:id -> borra el objeto del bucket y la fila
router.delete(
  '/documentos/:id',
  asyncHandler(async (req, res) => {
    const { patientId, id } = req.params;

    const [rows] = await db.query(
      'SELECT * FROM patient_fiscal_documents WHERE id = ? AND patient_id = ?',
      [id, patientId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Documento no encontrado.' });
    }

    const doc = rows[0];

    try {
      await s3.deleteObject({ Bucket: S3_BUCKET, Key: doc.file_key }).promise();
    } catch (err) {
      // Si el objeto ya no está, igual hay que quitar la fila.
      console.warn(`[fiscal] no se pudo borrar ${doc.file_key}: ${err.message}`);
    }

    await db.query('DELETE FROM patient_fiscal_documents WHERE id = ?', [id]);

    // Si se borró el vigente, el más reciente que quede toma su lugar.
    if (doc.vigente) {
      await db.query(
        `UPDATE patient_fiscal_documents SET vigente = 1
         WHERE patient_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
        [patientId]
      );
    }

    res.json({ message: 'Documento eliminado.' });
  })
);

// POST /link -> genera (o regenera) el link privado del paciente
router.post(
  '/link',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params;

    if (!(await patientExists(patientId))) {
      return res.status(404).json({ error: 'Paciente no encontrado.' });
    }

    const dias = Number(req.body?.dias) || DIAS_VIGENCIA_TOKEN;
    if (dias < 1 || dias > 365) {
      return res.status(400).json({ error: 'La vigencia debe estar entre 1 y 365 días.' });
    }

    // Se revoca el anterior: dos links vivos para el mismo paciente solo
    // confunden al staff sobre cuál mandó.
    await db.query(
      'UPDATE patient_fiscal_tokens SET revoked_at = NOW() WHERE patient_id = ? AND revoked_at IS NULL',
      [patientId]
    );

    const token = crypto.randomBytes(32).toString('hex');

    await db.query(
      `INSERT INTO patient_fiscal_tokens
         (patient_id, token, expires_at, created_by, created_at)
       VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), ?, NOW())`,
      [patientId, token, dias, req.user?.id || null]
    );

    const [[fila]] = await db.query(
      'SELECT * FROM patient_fiscal_tokens WHERE token = ?',
      [token]
    );

    res.status(201).json({ url: urlDelToken(token), expires_at: fila.expires_at });
  })
);

// DELETE /link -> revoca el link vigente
router.delete(
  '/link',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params;

    const [result] = await db.query(
      'UPDATE patient_fiscal_tokens SET revoked_at = NOW() WHERE patient_id = ? AND revoked_at IS NULL',
      [patientId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'No hay ningún link activo.' });
    }

    res.json({ message: 'Link revocado.' });
  })
);

router.use(manejarErrorDeSubida);

module.exports = router;
