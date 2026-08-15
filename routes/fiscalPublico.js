// routes/fiscalPublico.js
// ---------------------------------------------------------------------------
// Subida de la Constancia de Situación Fiscal por parte del PACIENTE, con un
// link privado que le comparte la clínica. Esta ruta NO lleva autenticación:
// el token del path es la única credencial.
//
// Por eso el endpoint es deliberadamente parco:
//   - devuelve el nombre de pila del paciente y nada más (nada clínico, ni
//     correo ni teléfono), lo justo para que sepa que el link es suyo;
//   - responde igual (404 genérico) para token inexistente, revocado o vencido,
//     para no confirmar qué tokens existen;
//   - el archivo pasa por la misma validación de tipo/tamaño que el resto.
// ---------------------------------------------------------------------------
const express = require('express');
const multer = require('multer');
const router = express.Router();

const db = require('../config/db');
const { guardarConstancia, validarArchivo, manejarErrorDeSubida, MAX_BYTES } = require('../services/fiscalDocs');

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

// Formato del token: 32 bytes en hex. Filtrar por formato evita ir a la BD con
// cualquier basura que llegue por la URL.
const FORMATO_TOKEN = /^[a-f0-9]{64}$/;

const buscarTokenVigente = async (token) => {
  if (!FORMATO_TOKEN.test(String(token || ''))) return null;

  const [rows] = await db.query(
    `SELECT t.*, p.nombre, p.apellidos
     FROM patient_fiscal_tokens t
     JOIN pacientes p ON p.id = t.patient_id
     WHERE t.token = ? AND t.revoked_at IS NULL AND t.expires_at > NOW()
     LIMIT 1`,
    [token]
  );

  return rows[0] || null;
};

// GET /:token -> valida el link y dice a nombre de quién va
router.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const fila = await buscarTokenVigente(req.params.token);
    if (!fila) {
      return res.status(404).json({ error: 'Este link no es válido o ya venció.' });
    }

    const [[{ total }]] = await db.query(
      'SELECT COUNT(*) AS total FROM patient_fiscal_documents WHERE patient_id = ?',
      [fila.patient_id]
    );

    res.json({
      // Solo el nombre de pila: basta para dar confianza sin exponer al paciente
      // si el link se reenvía por error.
      paciente: String(fila.nombre || '').split(' ')[0] || 'Paciente',
      ya_tiene_documento: total > 0,
      expires_at: fila.expires_at,
    });
  })
);

// POST /:token -> el paciente sube su constancia
router.post(
  '/:token',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const fila = await buscarTokenVigente(req.params.token);
    if (!fila) {
      return res.status(404).json({ error: 'Este link no es válido o ya venció.' });
    }

    const doc = await guardarConstancia({
      patientId: fila.patient_id,
      file: req.file,
      origen: 'paciente',
      uploadedBy: null,
    });

    await db.query(
      'UPDATE patient_fiscal_tokens SET used_count = used_count + 1, last_used_at = NOW() WHERE id = ?',
      [fila.id]
    );

    // No se devuelve la URL del archivo: el paciente no necesita el enlace
    // directo al bucket y así no se filtra la ruta interna.
    res.status(201).json({
      message: 'Constancia recibida.',
      file_name: doc.file_name,
      created_at: doc.created_at,
    });
  })
);

router.use(manejarErrorDeSubida);

module.exports = router;
