// routes/servicios.js
// ✅ SOLO CATÁLOGO: service_categories + services
// 🚫 Aquí NO van: patient_services, grupos, dientes, documentos, etc.

const express = require("express")
const router = express.Router()
const db = require("../config/db")

/**
 * Middleware para manejar errores
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next)

/**
 * Helpers
 */
function normalizeText(v) {
  return String(v ?? "").trim().replace(/\s+/g, " ")
}

async function resolveCategoryId({ category_id, category }) {
  if (category_id) return Number(category_id)

  const catName = normalizeText(category)
  if (!catName) return null

  const [rows] = await db.query(
    "SELECT id FROM service_categories WHERE name = ? LIMIT 1",
    [catName]
  )
  if (rows.length === 0) return null
  return rows[0].id
}

/**
 * ==============================
 * CRUD PARA `service_categories`
 * ==============================
 */

// ✅ Listar categorías
router.get(
  "/categories",
  asyncHandler(async (_req, res) => {
    const [rows] = await db.query(`
      SELECT id, name, sort_order, created_at, updated_at
      FROM service_categories
      ORDER BY sort_order ASC, name ASC
    `)
    res.json(rows)
  })
)

// ✅ Crear categoría
router.post(
  "/categories",
  asyncHandler(async (req, res) => {
    const finalName = normalizeText(req.body?.name)
    if (!finalName) return res.status(400).json({ error: "name es obligatorio" })

    const [dup] = await db.query(
      "SELECT id FROM service_categories WHERE name = ? LIMIT 1",
      [finalName]
    )
    if (dup.length) return res.status(409).json({ error: "La categoría ya existe." })

    let sortOrder = req.body?.sort_order
    if (sortOrder === undefined || sortOrder === null || sortOrder === "") {
      const [mx] = await db.query(
        "SELECT COALESCE(MAX(sort_order), 0) AS mx FROM service_categories"
      )
      sortOrder = Number(mx?.[0]?.mx || 0) + 1
    } else {
      sortOrder = Number(sortOrder)
      if (!Number.isFinite(sortOrder)) {
        return res.status(400).json({ error: "sort_order inválido" })
      }
    }

    const [result] = await db.query(
      `
      INSERT INTO service_categories (name, sort_order, created_at, updated_at)
      VALUES (?, ?, NOW(), NOW())
      `,
      [finalName, sortOrder]
    )

    res.status(201).json({ message: "Categoría creada.", id: result.insertId })
  })
)

// ✅ Reordenar categorías (bulk)
// Body: { order: [{ id: 1, sort_order: 1 }, ...] }
router.put(
  "/categories/reorder",
  asyncHandler(async (req, res) => {
    const order = req.body?.order
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({ error: "order debe ser un array" })
    }

    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()

      for (const item of order) {
        const cid = Number(item?.id)
        const so = Number(item?.sort_order)

        if (!Number.isFinite(cid) || !Number.isFinite(so)) {
          await conn.rollback()
          return res.status(400).json({ error: "order contiene valores inválidos" })
        }

        await conn.query(
          "UPDATE service_categories SET sort_order = ?, updated_at = NOW() WHERE id = ?",
          [so, cid]
        )
      }

      await conn.commit()
      res.json({ message: "Orden actualizado." })
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }
  })
)

// ✅ Actualizar categoría (name / sort_order)
router.put(
  "/categories/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params

    const finalNameRaw = req.body?.name
    const finalName =
      finalNameRaw !== undefined ? normalizeText(finalNameRaw) : undefined
    const sortOrderRaw = req.body?.sort_order

    if (finalName === undefined && sortOrderRaw === undefined) {
      return res.status(400).json({ error: "Envía name y/o sort_order" })
    }

    if (finalName !== undefined) {
      if (!finalName) return res.status(400).json({ error: "name inválido" })

      const [dup] = await db.query(
        "SELECT id FROM service_categories WHERE name = ? AND id <> ? LIMIT 1",
        [finalName, id]
      )
      if (dup.length) {
        return res
          .status(409)
          .json({ error: "Ya existe otra categoría con ese nombre." })
      }
    }

    const setParts = []
    const values = []

    if (finalName !== undefined) {
      setParts.push("name = ?")
      values.push(finalName)
    }

    if (sortOrderRaw !== undefined) {
      const sortOrder = Number(sortOrderRaw)
      if (!Number.isFinite(sortOrder)) {
        return res.status(400).json({ error: "sort_order inválido" })
      }
      setParts.push("sort_order = ?")
      values.push(sortOrder)
    }

    setParts.push("updated_at = NOW()")
    values.push(id)

    const [result] = await db.query(
      `UPDATE service_categories SET ${setParts.join(", ")} WHERE id = ?`,
      values
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Categoría no encontrada." })
    }

    res.json({ message: "Categoría actualizada." })
  })
)

// ✅ Eliminar categoría (bloquea si tiene services)
router.delete(
  "/categories/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params

    const [used] = await db.query(
      "SELECT id FROM services WHERE category_id = ? LIMIT 1",
      [id]
    )
    if (used.length) {
      return res.status(409).json({
        error:
          "No puedes borrar esta categoría porque hay servicios que la usan. Reasigna primero.",
      })
    }

    const [result] = await db.query("DELETE FROM service_categories WHERE id = ?", [
      id,
    ])

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Categoría no encontrada." })
    }

    res.json({ message: "Categoría eliminada." })
  })
)

/**
 * ===========================
 * CRUD PARA `services`
 * ===========================
 */

// ✅ Obtener todos los servicios (normalizado)
router.get(
  "/",
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

// ✅ Crear un nuevo servicio
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const { name, category_id, category, description } = req.body

    const finalName = normalizeText(name)
    const finalCategoryId = await resolveCategoryId({ category_id, category })

    if (!finalName || !finalCategoryId) {
      return res.status(400).json({
        error: "El nombre y la categoría son obligatorios (category_id o category).",
      })
    }

    const [dup] = await db.query(
      "SELECT id FROM services WHERE name = ? AND category_id = ? LIMIT 1",
      [finalName, finalCategoryId]
    )
    if (dup.length) {
      return res.status(409).json({
        error: "Ya existe un servicio con ese nombre y categoría.",
      })
    }

    const [result] = await db.query(
      `
      INSERT INTO services (name, category_id, description, created_at, updated_at)
      VALUES (?, ?, ?, NOW(), NOW())
      `,
      [finalName, finalCategoryId, description || null]
    )

    res.status(201).json({
      message: "Servicio creado exitosamente.",
      id: result.insertId,
    })
  })
)

// ✅ Actualizar un servicio
router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params
    const { name, category_id, category, description } = req.body

    const finalName = normalizeText(name)
    const finalCategoryId = await resolveCategoryId({ category_id, category })

    if (!finalName || !finalCategoryId) {
      return res.status(400).json({
        error: "El nombre y la categoría son obligatorios (category_id o category).",
      })
    }

    const [dup] = await db.query(
      "SELECT id FROM services WHERE name = ? AND category_id = ? AND id <> ? LIMIT 1",
      [finalName, finalCategoryId, id]
    )
    if (dup.length) {
      return res.status(409).json({
        error: "Ya existe otro servicio con ese nombre y categoría.",
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
      return res.status(404).json({ error: "Servicio no encontrado." })
    }

    res.json({ message: "Servicio actualizado exitosamente." })
  })
)

// ✅ Eliminar un servicio
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params

    const [result] = await db.query("DELETE FROM services WHERE id = ?", [id])
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Servicio no encontrado." })
    }

    res.json({ message: "Servicio eliminado exitosamente." })
  })
)

module.exports = router
