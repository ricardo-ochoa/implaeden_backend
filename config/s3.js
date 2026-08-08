// config/s3.js
// ---------------------------------------------------------------------------
// Cliente S3 compartido (aws-sdk v2).
//
// - En DESARROLLO: si existe S3_ENDPOINT (p. ej. MinIO en el NAS), el cliente
//   apunta a ese endpoint con "path-style" (requisito de MinIO).
// - En PRODUCCIÓN: si NO hay S3_ENDPOINT, se comporta igual que antes y usa
//   AWS S3 con las credenciales AWS_*.
//
// Así el mismo código sirve para MinIO (local) y S3 (nube) según el entorno.
// ---------------------------------------------------------------------------
const AWS = require('aws-sdk');

const endpoint = process.env.S3_ENDPOINT || undefined;
const forcePathStyle =
  String(process.env.S3_FORCE_PATH_STYLE || '').toLowerCase() === 'true';

const config = {
  region: process.env.AWS_REGION || 'us-east-2',
  // Preferimos credenciales específicas de S3 (MinIO); si no, las de AWS.
  accessKeyId: process.env.S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY,
};

if (endpoint) {
  config.endpoint = endpoint;
  config.s3ForcePathStyle = forcePathStyle; // MinIO -> path-style obligatorio
  config.signatureVersion = 'v4';
}

const s3 = new AWS.S3(config);

const S3_BUCKET = process.env.S3_BUCKET_NAME || 'implaeden';

/**
 * Devuelve la URL pública de un objeto del bucket.
 * - Dev (MinIO): usa S3_PUBLIC_URL o el endpoint + path-style.
 * - Prod (S3):   https://<bucket>.s3.<region>.amazonaws.com/<key>
 */
function publicUrl(key) {
  if (process.env.S3_PUBLIC_URL) {
    return `${process.env.S3_PUBLIC_URL.replace(/\/+$/, '')}/${key}`;
  }
  if (endpoint) {
    const base = endpoint.replace(/\/+$/, '');
    return forcePathStyle ? `${base}/${S3_BUCKET}/${key}` : `${base}/${key}`;
  }
  const region = process.env.AWS_REGION || 'us-east-2';
  return `https://${S3_BUCKET}.s3.${region}.amazonaws.com/${key}`;
}

module.exports = { s3, S3_BUCKET, publicUrl, isMinio: Boolean(endpoint) };
