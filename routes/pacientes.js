const express = require('express');
const router = express.Router();
const db = require('../config/db');
const pool = require('../config/db');
const AWS = require('aws-sdk');
const multer = require('multer');
const { getPatientSummary } = require("../services/patientSummaryService");

router.get("/:patientId/summary", async (req, res) => {
  try {
    const patientId = Number(req.params.patientId);
    if (!patientId) return res.status(400).json({ error: "patientId inválido" });

    const summary = await getPatientSummary(patientId);
    return res.json(summary);
  } catch (err) {
    console.error("Error en /api/pacientes/:patientId/summary:", err);
    return res.status(500).json({ error: "Error interno generando resumen de paciente" });
  }
})


// Middleware para manejar errores
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Configurar AWS S3
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: 'us-east-2',
});

const s3 = new AWS.S3();

// Configuración de Multer para manejar archivos
const upload = multer({ storage: multer.memoryStorage() });

// Función para subir un archivo a S3
const uploadFileToS3 = async (file) => {
    const fileName = `profile_photos/${Date.now()}_${file.originalname}`;
    const params = {
      Bucket: 'implaeden',
      Key: fileName,
      Body: file.buffer,
      ContentType: file.mimetype,
    };
  
    try {
      const uploadResult = await s3.upload(params).promise();
  
      // Construir manualmente la URL base
      const fileUrl = `https://${params.Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
      return fileUrl;
    } catch (error) {
      console.error('Error al subir a S3:', error);
      throw new Error('Error al subir el archivo a S3.');
    }
  };
  
// Obtener todos los pacientes o buscar pacientes
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { search = '', page = 1, limit = 20 } = req.query; // Definir valores por defecto para la búsqueda y paginación
    const offset = (page - 1) * limit;

    const query = `
      SELECT * FROM pacientes
      WHERE nombre LIKE ? OR apellidos LIKE ? OR telefono LIKE ? OR email LIKE ?
      LIMIT ? OFFSET ?
    `;
    
    const values = [`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, limit, offset];
    
    const [rows] = await db.query(query, values);

    const totalResultsQuery = `
      SELECT COUNT(*) AS total FROM pacientes
      WHERE nombre LIKE ? OR apellidos LIKE ? OR telefono LIKE ? OR email LIKE ?
    `;
    const [totalCount] = await db.query(totalResultsQuery, values.slice(0, 4));

    const totalPages = Math.ceil(totalCount[0].total / limit);

    res.json({ patients: rows, totalPages });
  })
);

// Obtener un paciente por ID
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const [rows] = await db.query('SELECT * FROM pacientes WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Paciente no encontrado' });
    }
    res.json(rows[0]);
  })
);

// Crear un nuevo paciente
router.post(
  '/',
  upload.single('foto'),
  asyncHandler(async (req, res) => {
    const { nombre, apellidos, telefono, fecha_nacimiento, email, direccion } = req.body;
  
    if (!nombre || !apellidos || !telefono || !fecha_nacimiento || !email || !direccion) {
      return res.status(400).json({ error: 'Todos los campos son obligatorios.' });
    }
  
    let fotoPerfilUrl = null;
    if (req.file) {
      try {
        fotoPerfilUrl = await uploadFileToS3(req.file);
      } catch (error) {
        return res.status(500).json({ error: 'Error al subir el archivo.' });
      }
    }
  
    const [result] = await db.query(
      'INSERT INTO pacientes (nombre, apellidos, telefono, fecha_nacimiento, email, direccion, foto_perfil_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
      [nombre, apellidos, telefono, fecha_nacimiento, email, direccion, fotoPerfilUrl]
    );
  
    res.status(201).json({ id: result.insertId, message: 'Paciente agregado exitosamente.' });
  })
);

// Actualizar un paciente
router.put(
    '/:id',
    upload.single('foto'),
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const {
        nombre,
        apellidos,
        telefono,
        fecha_nacimiento,
        email,
        direccion,
        eliminarFoto, // Campo para eliminar la imagen
      } = req.body;
      let fotoPerfilUrl = null;
  
      if (req.file) {
        // Subir una nueva imagen si se proporciona
        fotoPerfilUrl = await uploadFileToS3(req.file);
      } else if (eliminarFoto === 'true') {
        // Si se solicita explícitamente eliminar la imagen
        fotoPerfilUrl = null;
      } else {
        // Mantener la URL existente si no se proporciona un nuevo archivo ni se solicita eliminar
        const [existingPatient] = await db.query('SELECT foto_perfil_url FROM pacientes WHERE id = ?', [id]);
        fotoPerfilUrl = existingPatient[0]?.foto_perfil_url || null;
      }
  
      const [result] = await db.query(
        'UPDATE pacientes SET nombre = ?, apellidos = ?, telefono = ?, fecha_nacimiento = ?, email = ?, direccion = ?, foto_perfil_url = ? WHERE id = ?',
        [nombre, apellidos, telefono, fecha_nacimiento, email, direccion, fotoPerfilUrl, id]
      );
  
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Paciente no encontrado' });
      }
  
      res.json({ message: 'Paciente actualizado exitosamente.' });
    })
  );

// Eliminar un paciente
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const [result] = await db.query('DELETE FROM pacientes WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Paciente no encontrado' });
    }

    res.json({ message: 'Paciente eliminado exitosamente.' });
  })
);

router.get(
  '/:id/tratamientos',
  asyncHandler(async (req, res) => {
    const { id } = req.params
    const query = `
      SELECT 
        ps.id AS treatment_id, 
        ps.service_date, 
        ps.status,
        ps.total_cost AS total_cost,
        s.name AS service_name,
        sc.name AS service_category,
        sc.id   AS service_category_id
      FROM patient_services ps
      JOIN services s ON ps.service_id = s.id
      JOIN service_categories sc ON sc.id = s.category_id
      WHERE ps.patient_id = ?
      ORDER BY ps.service_date DESC
    `
    const [rows] = await db.query(query, [id])
    res.json(rows)
  })
)


router.get('/:patientId/summary', async (req, res) => {
  const patientId = Number(req.params.patientId);

  if (!patientId) {
    return res.status(400).json({ error: 'patientId inválido' });
  }

  try {
    const conn = await pool.getConnection();

    try {
      // 1) Info básica del paciente
      const [patientRows] = await conn.query(
        `
        SELECT 
          id, nombre, apellidos, telefono, email, fecha_nacimiento
        FROM pacientes
        WHERE id = ?
        `,
        [patientId]
      );
      const patient = patientRows[0] || null;

      // 2) Último servicio realizado
      const [serviceRows] = await conn.query(
        `
       SELECT 
            ps.id,
            ps.service_date,
            ps.notes,
            ps.status,
            ps.total_cost,
            s.name AS service_name,
            c.name AS service_category,
            c.id   AS service_category_id
          FROM patient_services ps
          JOIN services s ON s.id = ps.service_id
          JOIN service_categories c ON c.id = s.category_id
          WHERE ps.patient_id = ?
          ORDER BY ps.service_date DESC
          LIMIT 1
        `,
        [patientId]
      );
      const lastService = serviceRows[0] || null;

      // 3) Próxima cita (hoy en adelante)
      const [appointmentRows] = await conn.query(
        `
        SELECT 
          c.id,
          c.appointment_at,
          c.observaciones,
          s.name AS service_name,
          sc.name AS service_category,
          sc.id   AS service_category_id
        FROM citas c
        JOIN services s ON s.id = c.service_id
        JOIN service_categories sc ON sc.id = s.category_id
        WHERE c.patient_id = ?
          AND c.appointment_at >= NOW()
        ORDER BY c.appointment_at ASC
        LIMIT 1
        `,
        [patientId]
      );
      const nextAppointment = appointmentRows[0] || null;

      // 4) Último pago
      const [paymentRows] = await conn.query(
        `
        SELECT 
          pp.id,
          pp.fecha,
          pp.tratamiento,
          pp.monto,
          pm.name AS payment_method,
          ps2.name AS payment_status
        FROM patient_payments AS pp
        LEFT JOIN payment_methods   AS pm  ON pm.id  = pp.payment_method_id
        LEFT JOIN payment_statuses  AS ps2 ON ps2.id = pp.payment_status_id
        WHERE pp.patient_id = ?
        ORDER BY pp.fecha DESC
        LIMIT 1
        `,
        [patientId]
      );
      const lastPayment = paymentRows[0] || null;

      conn.release();

      return res.json({
        patient,
        lastService,
        nextAppointment,
        lastPayment,
      });
    } catch (err) {
      conn.release();
      console.error('Error en /api/pacientes/:patientId/summary:', err);
      return res
        .status(500)
        .json({ error: 'Error interno generando resumen de paciente' });
    }
  } catch (err) {
    console.error('Error de conexión a la BD:', err);
    return res
      .status(500)
      .json({ error: 'No se pudo conectar a la base de datos' });
  }
});

// Obtener pacientes recientes por created_at (ej. últimos N días)
router.get(
  '/recent',
  asyncHandler(async (req, res) => {
    const days = Number(req.query.days || 30);

    const query = `
      SELECT *
      FROM pacientes
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      ORDER BY created_at DESC
    `;

    const [rows] = await db.query(query, [days]);

    res.json({
      days,
      total: rows.length,
      patients: rows,
    });
  })
);


module.exports = router;
