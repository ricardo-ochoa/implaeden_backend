const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { s3, S3_BUCKET, publicUrl } = require('../config/s3'); // MinIO (dev) o AWS S3 (prod)
const multer = require('multer');
const { construirExpedientePdf } = require('../services/expedientePdf');

// Middleware para manejar errores
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Cliente S3/MinIO: importado arriba (config/s3)

// Configuración de Multer para manejar archivos
const upload = multer({ storage: multer.memoryStorage() });

// Función para subir archivos a S3
const uploadFileToS3 = async (file) => {
    const fileName = `clinical_histories/${Date.now()}_${file.originalname}`;
    const params = {
      Bucket: S3_BUCKET,
      Key: fileName,
      Body: file.buffer,
      ContentType: file.mimetype,
    };

    try {
      await s3.upload(params).promise();
      const fileUrl = publicUrl(fileName); // MinIO en dev, S3 en prod
      console.log('Archivo subido a S3/MinIO:', fileUrl);
      return fileUrl;
    } catch (error) {
      console.error('Error al subir a S3:', error);
      if (error.code === 'AccessControlListNotSupported') {
        console.error('El bucket no soporta ACLs. Verifica la configuración del bucket.');
      }
      throw new Error('Error al subir el archivo a S3.');
    }
  };  

// Obtener todos los historiales clínicos de un paciente
router.get(
  '/:patientId',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params;
    const [rows] = await db.query('SELECT * FROM clinical_histories WHERE patient_id = ?', [patientId]);
    res.json(rows);
  })
);

// Descargar los archivos escaneados como un solo PDF.
//   GET /:patientId/pdf                     -> todo el historial
//   GET /:patientId/pdf?date=YYYY-MM-DD     -> solo ese registro
// El orden es cronológico ascendente (del más viejo al más nuevo), como se
// archiva el expediente en papel; dentro de una fecha, por orden de subida.
router.get(
  '/:patientId/pdf',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params;
    const { date } = req.query;

    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date debe tener formato YYYY-MM-DD.' });
    }

    const [pacientes] = await db.query('SELECT * FROM pacientes WHERE id = ?', [patientId]);
    if (pacientes.length === 0) {
      return res.status(404).json({ error: 'Paciente no encontrado.' });
    }

    const [registros] = await db.query(
      `SELECT id, record_date, file_url
       FROM clinical_histories
       WHERE patient_id = ?${date ? ' AND record_date = ?' : ''}
       ORDER BY record_date ASC, id ASC`,
      date ? [patientId, date] : [patientId]
    );

    if (registros.length === 0) {
      return res.status(404).json({ error: 'No hay archivos que descargar.' });
    }

    const { buffer, incluidos, omitidos } = await construirExpedientePdf({
      paciente: pacientes[0],
      registros,
      fechaUnica: date,
    });

    const apellido = String(pacientes[0].apellidos || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();

    const nombreDescarga = `expediente-${apellido || patientId}-${date || 'completo'}.pdf`;

    // Los omitidos también van en la cabecera: el front avisa al usuario sin
    // tener que abrir el PDF hasta la última página.
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreDescarga}"`);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('X-Archivos-Incluidos', String(incluidos));
    res.setHeader('X-Archivos-Omitidos', String(omitidos.length));
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Archivos-Incluidos, X-Archivos-Omitidos');

    res.send(buffer);
  })
);

// Crear un nuevo historial clínico
router.post(
    '/:patientId',
    upload.array('files', 10),
    asyncHandler(async (req, res) => {
      console.log('Body:', req.body); // Depuración
      console.log('Files:', req.files); // Depuración
  
      const { patientId } = req.params;
      const { record_date } = req.body;
  
      if (!record_date || !req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'La fecha de registro y al menos un archivo son obligatorios.' });
      }
  
      const fileUrls = await Promise.all(req.files.map(uploadFileToS3));
  
      await Promise.all(
        fileUrls.map((url) =>
          db.query(
            'INSERT INTO clinical_histories (patient_id, record_date, file_url, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
            [patientId, record_date, url]
          )
        )
      );
  
      res.status(201).json({ message: 'Historial clínico creado exitosamente.' });
    })
  );  
  
// Actualizar un historial clínico
router.put(
  '/:id',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { record_date } = req.body;

    let fileUrl = null;
    if (req.file) {
      fileUrl = await uploadFileToS3(req.file);
    }

    const [result] = await db.query(
      'UPDATE clinical_histories SET record_date = ?, file_url = ?, updated_at = NOW() WHERE id = ?',
      [record_date, fileUrl, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Historial clínico no encontrado.' });
    }

    res.json({ message: 'Historial clínico actualizado exitosamente.' });
  })
);

// Eliminar un historial clínico
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const [result] = await db.query('DELETE FROM clinical_histories WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Historial clínico no encontrado.' });
    }
    res.json({ message: 'Historial clínico eliminado exitosamente.' });
  })
);

module.exports = router;
