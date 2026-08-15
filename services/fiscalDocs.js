// services/fiscalDocs.js
// ---------------------------------------------------------------------------
// Lógica compartida de la Constancia de Situación Fiscal: subida al bucket y
// alta en `patient_fiscal_documents`.
//
// La usan dos rutas con permisos muy distintos: la del staff (autenticada) y la
// pública por token, donde el paciente sube su propio documento. Por eso la
// validación de tipo y tamaño vive aquí y no en cada ruta.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const db = require('../config/db');
const { s3, S3_BUCKET, publicUrl } = require('../config/s3');

// Lo que el SAT entrega y lo que la gente manda por WhatsApp: PDF o foto.
const MIMES_PERMITIDOS = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
]);

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

const EXT_POR_MIME = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/webp': 'webp',
};

// El tipo se decide SOLO por los bytes. Nunca se cae al mime declarado por el
// cliente: este mismo validador atiende la subida pública por token, y ahí
// confiar en la cabecera permitiría colar cualquier archivo diciendo que es un
// PDF. Si los bytes no identifican un tipo permitido, devuelve null y se
// rechaza.
const detectarTipo = (buf) => {
  if (!buf || buf.length < 12) return null;

  if (buf.toString('ascii', 0, 4) === '%PDF') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';

  // HEIC/HEIF: caja 'ftyp' con marca variable según el dispositivo.
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const marca = buf.toString('ascii', 8, 12).toLowerCase();
    if (/^(heic|heix|heim|heis|hevc|hevx|mif1|msf1)$/.test(marca)) return 'image/heic';
  }

  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }

  return null;
};

const limpiarNombre = (nombre) =>
  String(nombre || 'constancia')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'constancia';

/**
 * Valida el archivo recibido. Devuelve { error } o { mime, ext }.
 */
function validarArchivo(file) {
  if (!file || !file.buffer?.length) return { error: 'No se recibió ningún archivo.' };
  if (file.size > MAX_BYTES) {
    return { error: `El archivo supera el máximo de ${Math.round(MAX_BYTES / 1024 / 1024)} MB.` };
  }

  const mime = detectarTipo(file.buffer);
  if (!mime || !MIMES_PERMITIDOS.has(mime)) {
    return { error: 'Formato no admitido. Sube la constancia en PDF o como imagen (JPG, PNG o HEIC).' };
  }

  return { mime, ext: EXT_POR_MIME[mime] || 'bin' };
}

/**
 * Sube el archivo al bucket y lo registra como documento vigente del paciente.
 * Marca los anteriores como historial dentro de la misma transacción, para que
 * nunca queden dos vigentes.
 *
 * @param {object} opts
 * @param {number} opts.patientId
 * @param {object} opts.file        archivo de multer (memoryStorage)
 * @param {string} opts.origen      'clinica' | 'paciente' | 'import'
 * @param {number} [opts.uploadedBy]
 * @returns {Promise<object>} la fila creada
 */
async function guardarConstancia({ patientId, file, origen = 'clinica', uploadedBy = null }) {
  // Red de seguridad: las rutas ya validan antes para poder responder un 400
  // con el mensaje al usuario (el handler global de app.js lee `err.status`).
  const validacion = validarArchivo(file);
  if (validacion.error) {
    const err = new Error(validacion.error);
    err.status = 400;
    throw err;
  }

  const { mime, ext } = validacion;
  const base = limpiarNombre(file.originalname?.replace(/\.[^.]+$/, ''));
  // El sufijo aleatorio evita colisiones y que la key sea adivinable.
  const key = `fiscal/${patientId}/${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${base}.${ext}`;

  await s3
    .upload({ Bucket: S3_BUCKET, Key: key, Body: file.buffer, ContentType: mime })
    .promise();

  const url = publicUrl(key);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      'UPDATE patient_fiscal_documents SET vigente = 0 WHERE patient_id = ? AND vigente = 1',
      [patientId]
    );

    const [result] = await conn.query(
      `INSERT INTO patient_fiscal_documents
         (patient_id, file_url, file_key, file_name, mime_type, size_bytes, vigente, origen, uploaded_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NOW(), NOW())`,
      [patientId, url, key, file.originalname || null, mime, file.size || null, origen, uploadedBy]
    );

    await conn.commit();

    const [rows] = await db.query('SELECT * FROM patient_fiscal_documents WHERE id = ?', [
      result.insertId,
    ]);
    return rows[0];
  } catch (err) {
    await conn.rollback();
    // El objeto ya subió pero la fila no quedó: se borra para no dejar basura.
    try {
      await s3.deleteObject({ Bucket: S3_BUCKET, Key: key }).promise();
    } catch {
      /* si falla el borrado, queda un objeto huérfano; no vale tumbar la petición */
    }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Traduce el error de límite de tamaño de multer a un 400 con mensaje legible.
 * Se monta como middleware de error en los routers que aceptan archivos.
 */
const manejarErrorDeSubida = (err, _req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res
      .status(400)
      .json({ error: `El archivo supera el máximo de ${Math.round(MAX_BYTES / 1024 / 1024)} MB.` });
  }
  return next(err);
};

module.exports = {
  guardarConstancia,
  validarArchivo,
  manejarErrorDeSubida,
  MIMES_PERMITIDOS,
  MAX_BYTES,
};
