const express = require('express');
const multer = require('multer');
const router = express.Router();
// Cliente S3 compartido: MinIO en dev (S3_ENDPOINT) o AWS S3 en prod.
const { s3, S3_BUCKET, publicUrl } = require('../config/s3');

// Configurar Multer para manejar la carga de archivos
const upload = multer({ storage: multer.memoryStorage() });

router.post('/upload', upload.single('foto'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se proporcionó una foto.' });
    }

    // Configurar parámetros de carga
    const key = `profile_photos/${Date.now()}_${req.file.originalname}`;
    const params = {
      Bucket: S3_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      // Nota: sin ACL por objeto. En dev el bucket MinIO es de lectura pública;
      // en prod el acceso se controla por política de bucket.
    };

    // Subir y devolver la URL PÚBLICA (no la interna del endpoint)
    await s3.upload(params).promise();
    res.status(200).json({ url: publicUrl(key) });
  } catch (error) {
    console.error('Error al subir la foto:', error);
    res.status(500).json({ error: 'Error al subir la foto a S3.' });
  }
});

module.exports = router;
