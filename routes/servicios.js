// routes/servicios.js
const express = require('express')
const router = express.Router()

const multer = require('multer')
const AWS = require('aws-sdk')
const db = require('../config/db')

// Configuración de AWS S3
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
})

const s3 = new AWS.S3()
const upload = multer({ storage: multer.memoryStorage() })

/**
 * Middleware para manejar errores
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next)
}

/**
 * Helpers
 */
function normalizeText(v) {
  return String(v ?? '')
    .trim()
    .replace(/\s+/g, ' ')
}

async function resolveCategoryId({ category_id, category }) {
  if (category_id) return Number(category_id)

  const catName = normalizeText(category)
  if (!catName) return null

  const [rows] = await db.query(
    'SELECT id FROM service_categories WHERE name = ? LIMIT 1',
    [catName]
  )
  if (rows.length === 0) return null
  return rows[0].id
}

// Función para subir archivos a S3 (documentos de tratamientos)
const uploadFileToS3 = async (file) => {
  const fileName = `clinical_histories/${Date.now()}_${file.originalname}`
  const params = {
    Bucket: 'implaeden',
    Key: fileName,
    Body: file.buffer,
    ContentType: file.mimetype,
  }

  try {
    const uploadResult = await s3.upload(params).promise()
    return uploadResult.Location
  } catch (error) {
    console.error('Error al subir archivo a S3:', error)
    throw new Error('Error al subir archivo a S3.')
  }
}

/**
 * ==============================
 * CRUD PARA `service_categories`
 * ==============================
 */

// Listar categorías
router.get(
  '/patient/:patientId',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params

    const [rows] = await db.query(
      `
      SELECT 
        ps.id         AS treatment_id,
        ps.group_id,
        g.title       AS group_title,
        g.start_date  AS group_start_date,
        ps.service_date,
        ps.notes,
        ps.total_cost,
        ps.status,
        s.name        AS service_name,
        c.name        AS service_category,
        c.id          AS service_category_id
      FROM patient_services ps
      LEFT JOIN patient_service_groups g ON g.id = ps.group_id
      JOIN services s ON ps.service_id = s.id
      JOIN service_categories c ON c.id = s.category_id
      WHERE ps.patient_id = ?
      ORDER BY COALESCE(g.start_date, ps.service_date) DESC, ps.service_date DESC
      `,
      [patientId]
    )

    res.json(rows)
  })
)

// Crear categoría
router.post(
  '/categories',
  asyncHandler(async (req, res) => {
    const finalName = normalizeText(req.body?.name)
    if (!finalName) return res.status(400).json({ error: 'name es obligatorio' })

    const [dup] = await db.query(
      'SELECT id FROM service_categories WHERE name = ? LIMIT 1',
      [finalName]
    )
    if (dup.length) return res.status(409).json({ error: 'La categoría ya existe.' })

    let sortOrder = req.body?.sort_order
    if (sortOrder === undefined || sortOrder === null || sortOrder === '') {
      const [mx] = await db.query(
        'SELECT COALESCE(MAX(sort_order), 0) AS mx FROM service_categories'
      )
      sortOrder = Number(mx?.[0]?.mx || 0) + 1
    } else {
      sortOrder = Number(sortOrder)
      if (!Number.isFinite(sortOrder)) {
        return res.status(400).json({ error: 'sort_order inválido' })
      }
    }

    const [result] = await db.query(
      `
      INSERT INTO service_categories (name, sort_order, created_at, updated_at)
      VALUES (?, ?, NOW(), NOW())
      `,
      [finalName, sortOrder]
    )

    res.status(201).json({ message: 'Categoría creada.', id: result.insertId })
  })
)

// Reordenar categorías (bulk)
// Body: { order: [{ id: 1, sort_order: 1 }, ...] }
router.put(
  '/categories/reorder',
  asyncHandler(async (req, res) => {
    const order = req.body?.order
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({ error: 'order debe ser un array' })
    }

    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()

      for (const item of order) {
        const cid = Number(item?.id)
        const so = Number(item?.sort_order)

        if (!Number.isFinite(cid) || !Number.isFinite(so)) {
          await conn.rollback()
          return res.status(400).json({ error: 'order contiene valores inválidos' })
        }

        await conn.query(
          'UPDATE service_categories SET sort_order = ?, updated_at = NOW() WHERE id = ?',
          [so, cid]
        )
      }

      await conn.commit()
      res.json({ message: 'Orden actualizado.' })
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }
  })
)

// Actualizar categoría (nombre / sort_order)
router.put(
  '/categories/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params

    const finalNameRaw = req.body?.name
    const finalName = finalNameRaw !== undefined ? normalizeText(finalNameRaw) : undefined
    const sortOrderRaw = req.body?.sort_order

    if (finalName === undefined && sortOrderRaw === undefined) {
      return res.status(400).json({ error: 'Envía name y/o sort_order' })
    }

    if (finalName !== undefined) {
      if (!finalName) return res.status(400).json({ error: 'name inválido' })

      const [dup] = await db.query(
        'SELECT id FROM service_categories WHERE name = ? AND id <> ? LIMIT 1',
        [finalName, id]
      )
      if (dup.length) {
        return res.status(409).json({ error: 'Ya existe otra categoría con ese nombre.' })
      }
    }

    const setParts = []
    const values = []

    if (finalName !== undefined) {
      setParts.push('name = ?')
      values.push(finalName)
    }

    if (sortOrderRaw !== undefined) {
      const sortOrder = Number(sortOrderRaw)
      if (!Number.isFinite(sortOrder)) {
        return res.status(400).json({ error: 'sort_order inválido' })
      }
      setParts.push('sort_order = ?')
      values.push(sortOrder)
    }

    setParts.push('updated_at = NOW()')
    values.push(id)

    const [result] = await db.query(
      `UPDATE service_categories SET ${setParts.join(', ')} WHERE id = ?`,
      values
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Categoría no encontrada.' })
    }

    res.json({ message: 'Categoría actualizada.' })
  })
)

// Eliminar categoría (bloquea si tiene services)
router.delete(
  '/categories/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params

    const [used] = await db.query(
      'SELECT id FROM services WHERE category_id = ? LIMIT 1',
      [id]
    )
    if (used.length) {
      return res.status(409).json({
        error: 'No puedes borrar esta categoría porque hay servicios que la usan. Reasigna primero.',
      })
    }

    const [result] = await db.query(
      'DELETE FROM service_categories WHERE id = ?',
      [id]
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Categoría no encontrada.' })
    }

    res.json({ message: 'Categoría eliminada.' })
  })
)

/**
 * ===========================
 * CRUD PARA `services`
 * ===========================
 */

// Obtener todos los servicios (normalizado)
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const [rows] = await db.query(`
      SELECT
        s.id,
        s.name,
        s.description,
        s.created_at,
        s.updated_at,
        c.id   AS category_id,
        c.name AS category,
        c.sort_order
      FROM services s
      JOIN service_categories c ON c.id = s.category_id
      ORDER BY c.sort_order ASC, c.name ASC, s.name ASC
    `)
    res.json(rows)
  })
)

// Crear un nuevo servicio
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name, category_id, category, description } = req.body

    const finalName = normalizeText(name)
    const finalCategoryId = await resolveCategoryId({ category_id, category })

    if (!finalName || !finalCategoryId) {
      return res.status(400).json({
        error: 'El nombre y la categoría son obligatorios (category_id o category).',
      })
    }

    const [dup] = await db.query(
      'SELECT id FROM services WHERE name = ? AND category_id = ? LIMIT 1',
      [finalName, finalCategoryId]
    )
    if (dup.length) {
      return res.status(409).json({
        error: 'Ya existe un servicio con ese nombre y categoría.',
      })
    }

    const [result] = await db.query(
      `
      INSERT INTO services (name, category_id, description, created_at, updated_at)
      VALUES (?, ?, ?, NOW(), NOW())
      `,
      [finalName, finalCategoryId, description || null]
    )

    res.status(201).json({ message: 'Servicio creado exitosamente.', id: result.insertId })
  })
)

// Actualizar un servicio
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params
    const { name, category_id, category, description } = req.body

    const finalName = normalizeText(name)
    const finalCategoryId = await resolveCategoryId({ category_id, category })

    if (!finalName || !finalCategoryId) {
      return res.status(400).json({
        error: 'El nombre y la categoría son obligatorios (category_id o category).',
      })
    }

    const [dup] = await db.query(
      'SELECT id FROM services WHERE name = ? AND category_id = ? AND id <> ? LIMIT 1',
      [finalName, finalCategoryId, id]
    )
    if (dup.length) {
      return res.status(409).json({
        error: 'Ya existe otro servicio con ese nombre y categoría.',
      })
    }

    const [result] = await db.query(
      `
      UPDATE services
      SET name = ?, category_id = ?, description = ?, updated_at = NOW()
      WHERE id = ?
      `,
      [finalName, finalCategoryId, description || null, id]
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Servicio no encontrado.' })
    }

    res.json({ message: 'Servicio actualizado exitosamente.' })
  })
)

// Eliminar un servicio
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params

    const [result] = await db.query('DELETE FROM services WHERE id = ?', [id])
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Servicio no encontrado.' })
    }

    res.json({ message: 'Servicio eliminado exitosamente.' })
  })
)

/**
 * ==============================
 * patient_services (relación paciente-servicios)
 * ==============================
 */

router.get(
  '/patient/:patientId',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params
    // ... dentro de router.get('/patient/:patientId', ...)
const [rows] = await db.query(
  `
  SELECT 
    ps.id AS treatment_id,
    ps.group_id,
    g.title     AS group_title,
    g.start_date AS group_start_date,

    ps.service_id,
    ps.service_date,
    ps.notes,
    ps.status,
    ps.total_cost,

    s.name AS service_name,
    c.name AS service_category,
    c.id   AS service_category_id
  FROM patient_services ps
  LEFT JOIN patient_service_groups g ON g.id = ps.group_id
  JOIN services s ON s.id = ps.service_id
  JOIN service_categories c ON c.id = s.category_id
  WHERE ps.patient_id = ?
  ORDER BY COALESCE(g.start_date, ps.service_date) DESC, ps.service_date DESC, ps.id DESC
  `,
  [patientId]
)
res.json(rows)

  })
)

router.get(
  '/:id/tratamientos',
  asyncHandler(async (req, res) => {
    const { id } = req.params

    // ... dentro de router.get('/patient/:patientId', ...)
const [rows] = await db.query(
  `
  SELECT 
    ps.id AS treatment_id,
    ps.group_id,
    g.title     AS group_title,
    g.start_date AS group_start_date,

    ps.service_id,
    ps.service_date,
    ps.notes,
    ps.status,
    ps.total_cost,

    s.name AS service_name,
    c.name AS service_category,
    c.id   AS service_category_id
  FROM patient_services ps
  LEFT JOIN patient_service_groups g ON g.id = ps.group_id
  JOIN services s ON s.id = ps.service_id
  JOIN service_categories c ON c.id = s.category_id
  WHERE ps.patient_id = ?
  ORDER BY COALESCE(g.start_date, ps.service_date) DESC, ps.service_date DESC, ps.id DESC
  `,
  [patientId]
)
res.json(rows)

  })
)

router.post(
  '/patient/:patientId',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params
    const { service_id, service_date, notes, total_cost } = req.body

    if (!service_id || !service_date || total_cost == null) {
      return res.status(400).json({
        error: 'El ID del servicio y la fecha son obligatorios.',
      })
    }

    const [result] = await db.query(
      `
      INSERT INTO patient_services
        (patient_id, service_id, service_date, notes, total_cost, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NOW(), NOW())
      `,
      [patientId, service_id, service_date, notes, parseFloat(total_cost)]
    )

    res.status(201).json({
      message: 'Servicio asignado al paciente exitosamente.',
      id: result.insertId,
    })
  })
)

/**
 * ==============================
 * Documentos de tratamientos
 * ==============================
 */

router.get(
  '/tratamientos/:treatmentId/documentos',
  asyncHandler(async (req, res) => {
    const { treatmentId } = req.params
    const [rows] = await db.query(
      `
      SELECT id, document_type, file_url, created_at, updated_at
      FROM service_documents
      WHERE patient_service_id = ?
      `,
      [treatmentId]
    )
    res.json(rows)
  })
)

router.post(
  '/tratamientos/:treatmentId/documentos',
  upload.array('file', 10),
  asyncHandler(async (req, res) => {
    const { treatmentId } = req.params
    const { document_type, created_at } = req.body

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No se ha subido ningún archivo.' })
    }

    try {
      const fileUrls = await Promise.all(req.files.map(uploadFileToS3))

      const queries = fileUrls.map((fileUrl) =>
        db.query(
          `
          INSERT INTO service_documents (patient_service_id, document_type, file_url, created_at, updated_at)
          VALUES (?, ?, ?, ?, NOW())
          `,
          [treatmentId, document_type, fileUrl, created_at]
        )
      )

      await Promise.all(queries)
      res.status(201).json({ message: 'Documentos guardados exitosamente.' })
    } catch (error) {
      console.error('Error al guardar documentos:', error)
      res.status(500).json({ error: error.message || 'Error al guardar los documentos.' })
    }
  })
)

router.delete(
  '/documentos/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params

    const [rows] = await db.query(
      'SELECT file_url FROM service_documents WHERE id = ?',
      [id]
    )
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Documento no encontrado.' })
    }

    const fileUrl = rows[0].file_url
    const fileName = fileUrl.split('/').pop()

    try {
      await s3
        .deleteObject({
          Bucket: 'implaeden',
          Key: `clinical_histories/${fileName}`,
        })
        .promise()

      const [result] = await db.query('DELETE FROM service_documents WHERE id = ?', [id])
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Documento no encontrado.' })
      }

      res.json({ message: 'Documento eliminado exitosamente.' })
    } catch (error) {
      console.error('Error al eliminar el documento:', error)
      res.status(500).json({ error: 'Error al eliminar el documento.' })
    }
  })
)

router.post(
  '/patient/:patientId/group',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params
    const { title, start_date, status, notes, items } = req.body

    if (!title || !start_date || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'title, start_date e items[] son obligatorios' })
    }

    // valida items
    for (const it of items) {
      if (!it?.service_id || it?.total_cost == null) {
        return res.status(400).json({ error: 'Cada item requiere service_id y total_cost' })
      }
      const c = Number(it.total_cost)
      if (!Number.isFinite(c) || c < 0) {
        return res.status(400).json({ error: 'total_cost inválido en items' })
      }
    }

    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()

      // 1) crear grupo (paquete)
      const [g] = await conn.query(
        `
        INSERT INTO patient_service_groups
          (patient_id, title, start_date, status, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NOW(), NOW())
        `,
        [patientId, title, start_date, status || 'Por iniciar', notes || null]
      )
      const groupId = g.insertId

      // 2) crear servicios individuales ligados al grupo
      for (const it of items) {
        await conn.query(
          `
          INSERT INTO patient_services
            (patient_id, group_id, service_id, service_date, notes, status, total_cost, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
          `,
          [
            patientId,
            groupId,
            it.service_id,
            start_date,
            it.notes || null,
            it.status || 'Por iniciar',
            Number(it.total_cost),
          ]
        )
      }

      await conn.commit()

      res.status(201).json({ message: 'Paquete creado', group_id: groupId })
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }
  })
)


module.exports = router
