const express = require('express');
const router = express.Router();
const multer = require('multer');
const AWS = require('aws-sdk');
const db = require('../config/db');

// Configuración de AWS S3
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

const s3 = new AWS.S3();

// Configuración de multer para manejar archivos en memoria
const upload = multer({ storage: multer.memoryStorage() });

// Middleware para manejar errores
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Función para subir archivos a S3
const uploadFileToS3 = async (file) => {  

    const fileName = `clinical_histories/${Date.now()}_${file.originalname}`;
    const params = {
        Bucket: 'implaeden',// Verifica que esta línea tiene un valor definido
      Key: fileName,
      Body: file.buffer,
      ContentType: file.mimetype,
    };
  
    try {
      console.log('Subiendo archivo a S3:', params);
      const uploadResult = await s3.upload(params).promise();
      console.log('Archivo subido con éxito:', uploadResult.Location);
      return uploadResult.Location;
    } catch (error) {
      console.error('Error al subir archivo a S3:', error);
      throw new Error('Error al subir archivo a S3.');
    }
  };  
  
// **CRUD PARA LA TABLA `services`**

// Obtener todos los servicios
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [rows] = await db.query('SELECT * FROM services ORDER BY created_at DESC');
    res.json(rows);
  })
);

// Crear un nuevo servicio
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name, category, description } = req.body;

    if (!name || !category) {
      return res.status(400).json({ error: 'El nombre y la categoría son obligatorios.' });
    }

    const [result] = await db.query(
      'INSERT INTO services (name, category, description, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
      [name, category, description]
    );

    res.status(201).json({ message: 'Servicio creado exitosamente.', id: result.insertId });
  })
);

// Actualizar un servicio
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { name, category, description } = req.body;

    const [result] = await db.query(
      'UPDATE services SET name = ?, category = ?, description = ?, updated_at = NOW() WHERE id = ?',
      [name, category, description, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Servicio no encontrado.' });
    }

    res.json({ message: 'Servicio actualizado exitosamente.' });
  })
);

// Eliminar un servicio
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const [result] = await db.query('DELETE FROM services WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Servicio no encontrado.' });
    }

    res.json({ message: 'Servicio eliminado exitosamente.' });
  })
);

// **OPERACIONES PARA `patient_services`**

// Obtener servicios relacionados con un paciente
router.get(
  '/patient/:patientId',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params;
    const [rows] = await db.query(
      `SELECT ps.id, ps.service_date, ps.notes, s.name, s.category 
       FROM patient_services ps 
       INNER JOIN services s ON ps.service_id = s.id 
       WHERE ps.patient_id = ? 
       ORDER BY ps.service_date DESC`,
      [patientId]
    );
    res.json(rows);
  })
);

// Obtener tratamientos relacionados con un paciente
router.get(
  '/:id/tratamientos',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const query = `
      SELECT 
        ps.id AS treatment_id, 
        ps.service_date,
        ps.status,
        s.name AS service_name, 
        s.category AS service_category
      FROM patient_services ps
      INNER JOIN services s ON ps.service_id = s.id
      WHERE ps.patient_id = ?
      ORDER BY ps.service_date DESC
    `;

    const [rows] = await db.query(query, [id]);
    res.json(rows);
  })
);

// Asignar un servicio a un paciente
router.post(
  '/patient/:patientId',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params;
    const { service_id, service_date, notes } = req.body;

    if (!service_id || !service_date) {
      return res.status(400).json({ error: 'El ID del servicio y la fecha son obligatorios.' });
    }

    const [result] = await db.query(
      'INSERT INTO patient_services (patient_id, service_id, service_date, notes, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
      [patientId, service_id, service_date, notes]
    );

    res.status(201).json({ message: 'Servicio asignado al paciente exitosamente.', id: result.insertId });
  })
);

// **OPERACIONES PARA DOCUMENTOS RELACIONADOS CON TRATAMIENTOS**

// Obtener documentos relacionados con un tratamiento específico
router.get('/tratamientos/:treatmentId/documentos', asyncHandler(async (req, res) => {
  const { treatmentId } = req.params;

  const [rows] = await db.query(
    'SELECT id, document_type, file_url, created_at, updated_at FROM service_documents WHERE patient_service_id = ?',
    [treatmentId]
  );

res.json(rows);
}));

// Crear un nuevo documento relacionado con un tratamiento
router.post(
    '/tratamientos/:treatmentId/documentos',
    upload.array('file', 10),
    asyncHandler(async (req, res) => {
      const { treatmentId } = req.params;
      const { document_type, created_at } = req.body;
  
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No se ha subido ningún archivo.' });
      }
  
      try {
        const fileUrls = await Promise.all(req.files.map(uploadFileToS3));
  
        const queries = fileUrls.map((fileUrl) =>
          db.query(
            `INSERT INTO service_documents (patient_service_id, document_type, file_url, created_at, updated_at)
             VALUES (?, ?, ?, ?, NOW())`,
            [treatmentId, document_type, fileUrl, created_at]
          )
        );
  
        await Promise.all(queries);
  
        res.status(201).json({ message: 'Documentos guardados exitosamente.' });
      } catch (error) {
        console.error('Error al guardar documentos:', error);
        res.status(500).json({ error: error.message || 'Error al guardar los documentos.' });
      }
    })
  );

  // Eliminar un tratamiento (registro de patient_services)
router.delete(
  '/tratamientos/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Verifica si existen documentos asociados primero (opcional: puedes borrarlos en cascada)
    const [docs] = await db.query(
      'SELECT id FROM service_documents WHERE patient_service_id = ?',
      [id]
    );

    if (docs.length > 0) {
      return res.status(400).json({ error: 'Este tratamiento tiene documentos asociados. Elimínalos primero.' });
    }

    const [result] = await db.query('DELETE FROM patient_services WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Tratamiento no encontrado.' });
    }

    res.json({ message: 'Tratamiento eliminado exitosamente.' });
  })
);

router.put('/tratamientos/:id/status', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['Por Iniciar', 'En proceso', 'Terminado'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Estado no válido.' });
  }

  const [result] = await db.query(
    'UPDATE patient_services SET status = ?, updated_at = NOW() WHERE id = ?',
    [status, id]
  );

  if (result.affectedRows === 0) {
    return res.status(404).json({ error: 'Tratamiento no encontrado.' });
  }

  res.json({ message: 'Estado actualizado exitosamente.' });
}));



  // Eliminar un documento relacionado con un tratamiento
router.delete('/documentos/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;
  
    // Consulta para verificar si el documento existe
    const [rows] = await db.query('SELECT file_url FROM service_documents WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Documento no encontrado.' });
    }
  
    const fileUrl = rows[0].file_url;
    const fileName = fileUrl.split('/').pop(); // Obtener el nombre del archivo desde la URL
  
    try {
      // Eliminar el archivo de S3
      const params = {
        Bucket: 'implaeden', // Asegúrate de que el nombre del bucket sea correcto
        Key: `clinical_histories/${fileName}`, // Ajusta el prefijo según tu lógica de nombres
      };
      await s3.deleteObject(params).promise();
      console.log('Archivo eliminado de S3:', fileName);
  
      // Eliminar el registro de la base de datos
      const [result] = await db.query('DELETE FROM service_documents WHERE id = ?', [id]);
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Documento no encontrado.' });
      }
  
      res.json({ message: 'Documento eliminado exitosamente.' });
    } catch (error) {
      console.error('Error al eliminar el documento:', error);
      res.status(500).json({ error: 'Error al eliminar el documento.' });
    }
  }));
  
  

module.exports = router;
