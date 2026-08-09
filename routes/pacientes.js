const express = require('express');
const router = express.Router();
const db = require('../config/db');
const pool = require('../config/db');
const { s3, S3_BUCKET, publicUrl } = require('../config/s3'); // MinIO (dev) o AWS S3 (prod)
const multer = require('multer');
const { getPatientSummary } = require("../services/patientSummaryService");
const reconcile = require("../services/reconcile");

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

// POST /api/pacientes/quick  -> registro rápido (solo nombre + teléfono)
// Para pacientes que se autoagendan (Confirmafy) y no existen aún en la BD.
router.post(
  '/quick',
  asyncHandler(async (req, res) => {
    const { nombre, telefono } = req.body || {};
    if (!nombre || !telefono) {
      return res.status(400).json({ error: 'nombre y telefono son obligatorios.' });
    }
    const id = await reconcile.quickCreatePatient({ nombre, telefono });
    res.status(201).json({ id, registro_incompleto: true, message: 'Paciente creado (registro rápido).' });
  })
);

// Cliente S3/MinIO: importado arriba (config/s3)

// Configuración de Multer para manejar archivos
const upload = multer({ storage: multer.memoryStorage() });

// Función para subir un archivo a S3
const uploadFileToS3 = async (file) => {
    const fileName = `profile_photos/${Date.now()}_${file.originalname}`;
    const params = {
      Bucket: S3_BUCKET,
      Key: fileName,
      Body: file.buffer,
      ContentType: file.mimetype,
    };

    try {
      await s3.upload(params).promise();
      // URL pública (MinIO en dev, S3 en prod)
      return publicUrl(fileName);
    } catch (error) {
      console.error('Error al subir a S3:', error);
      throw new Error('Error al subir el archivo a S3.');
    }
  };
  
// Obtener todos los pacientes o buscar pacientes
router.get(
  '/',
  asyncHandler(async (req, res) => {
    // page/limit llegan como texto en req.query; MySQL 8 rechaza LIMIT '20'
    // (con comillas), así que los forzamos a enteros.
    const search = req.query.search ?? '';
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Number(req.query.limit) || 20);
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
      const b = req.body || {};

      // Registro actual: hacemos MERGE para permitir guardado PARCIAL
      // (los pacientes creados con "registro rápido" no traen todos los datos).
      const [rows] = await db.query('SELECT * FROM pacientes WHERE id = ?', [id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Paciente no encontrado' });
      const cur = rows[0];

      // Foto
      let fotoPerfilUrl = cur.foto_perfil_url || null;
      if (req.file) fotoPerfilUrl = await uploadFileToS3(req.file);
      else if (b.eliminarFoto === 'true') fotoPerfilUrl = null;

      // '' / 'null' -> NULL en campos opcionales; undefined -> conservar el actual
      const clean = (v) => {
        if (v === undefined) return undefined;
        const s = String(v).trim();
        return s === '' || s === 'null' || s === 'undefined' ? null : v;
      };
      // nombre/telefono son NOT NULL: si llegan vacíos, se conserva el valor actual
      const keepReq = (v, curVal) => {
        const c = clean(v);
        return c === undefined || c === null ? curVal : c;
      };

      const next = {
        nombre: keepReq(b.nombre, cur.nombre),
        telefono: keepReq(b.telefono, cur.telefono),
        apellidos: b.apellidos !== undefined ? clean(b.apellidos) : cur.apellidos,
        fecha_nacimiento: b.fecha_nacimiento !== undefined ? clean(b.fecha_nacimiento) : cur.fecha_nacimiento,
        email: b.email !== undefined ? clean(b.email) : cur.email,
        direccion: b.direccion !== undefined ? clean(b.direccion) : cur.direccion,
      };

      // Auto-marca "completo" cuando ya tiene los 3 datos clave.
      const completo = Boolean(next.apellidos && next.email && next.fecha_nacimiento);
      const registro_incompleto = completo ? 0 : (cur.registro_incompleto ?? 0);

      await db.query(
        `UPDATE pacientes
           SET nombre=?, apellidos=?, telefono=?, fecha_nacimiento=?, email=?, direccion=?, foto_perfil_url=?, registro_incompleto=?
         WHERE id=?`,
        [next.nombre, next.apellidos, next.telefono, next.fecha_nacimiento, next.email, next.direccion, fotoPerfilUrl, registro_incompleto, id]
      );

      res.json({ message: 'Paciente actualizado exitosamente.', registro_incompleto });
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
        ps.id         AS treatment_id,
        ps.patient_id AS patient_id,
        ps.group_id   AS group_id,
        g.title       AS group_title,
        g.start_date  AS group_start_date,

        ps.service_id,
        ps.service_date,
        ps.notes,
        ps.status,
        ps.total_cost,
        ps.quantity,

        s.name        AS service_name,
        sc.id         AS service_category_id,
        sc.name       AS service_category,
        sc.sort_order AS service_category_sort_order
      FROM patient_services ps
      LEFT JOIN patient_service_groups g ON g.id = ps.group_id
      JOIN services s ON s.id = ps.service_id
      JOIN service_categories sc ON sc.id = s.category_id
      WHERE ps.patient_id = ?
      ORDER BY COALESCE(g.start_date, ps.service_date) DESC, ps.service_date DESC, ps.id DESC
    `

    const [rows] = await db.query(query, [id])
    res.json(rows)
  })
)

// router.patch(
//   '/:patientId/tratamientos/:treatmentId',
//   asyncHandler(async (req, res) => {
//     const patientId = Number(req.params.patientId)
//     const treatmentId = Number(req.params.treatmentId)

//     if (!Number.isFinite(patientId) || patientId <= 0) {
//       return res.status(400).json({ error: 'patientId inválido' })
//     }
//     if (!Number.isFinite(treatmentId) || treatmentId <= 0) {
//       return res.status(400).json({ error: 'treatmentId inválido' })
//     }

//     const hasCost = req.body?.total_cost !== undefined
//     const hasQty = req.body?.quantity !== undefined

//     if (!hasCost && !hasQty) {
//       return res.status(400).json({ error: 'Envía total_cost y/o quantity' })
//     }

//     const setParts = []
//     const values = []

//     if (hasCost) {
//       const costNum = Number(req.body.total_cost)
//       if (!Number.isFinite(costNum) || costNum < 0) {
//         return res.status(400).json({ error: 'total_cost inválido' })
//       }
//       setParts.push('total_cost = ?')
//       values.push(costNum)
//     }

//     if (hasQty) {
//       const qNum = Number(req.body.quantity)
//       const qty = Number.isFinite(qNum) ? Math.trunc(qNum) : NaN
//       if (!Number.isFinite(qty) || qty < 1) {
//         return res.status(400).json({ error: 'quantity inválida (entero >= 1)' })
//       }
//       setParts.push('quantity = ?')
//       values.push(qty)
//     }

//     setParts.push('updated_at = NOW()')
//     values.push(patientId, treatmentId)

//     const [result] = await db.query(
//       `
//       UPDATE patient_services
//       SET ${setParts.join(', ')}
//       WHERE patient_id = ? AND id = ?
//       `,
//       values
//     )

//     if (result.affectedRows === 0) {
//       return res
//         .status(404)
//         .json({ error: 'Tratamiento no encontrado para ese paciente' })
//     }

//     res.json({ message: 'Tratamiento actualizado.' })
//   })
// )

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
