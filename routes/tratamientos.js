// routes/tratamientos.js
const express = require("express");
const db = require("../config/db");
const router = express.Router({ mergeParams: true });

// Middleware para manejar errores
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ✅ ÚNICA FUENTE DE VERDAD
const VALID_STATUSES = ["Por Iniciar", "En proceso", "Terminado"];

/**
 * Normaliza cualquier variante de status al set permitido.
 * - null/"" => "Por Iniciar"
 * - "por iniciar" / "Por iniciar" / "POR INICIAR" => "Por Iniciar"
 * - "en proceso" => "En proceso"
 * - "terminado" => "Terminado"
 * - cualquier otra cosa => null (para que truene con 400)
 */
const normalizeStatus = (raw) => {
  const v = String(raw ?? "").trim().toLowerCase();

  if (!v) return "Por Iniciar";
  if (v === "terminado") return "Terminado";
  if (v === "en proceso") return "En proceso";
  if (v === "por iniciar") return "Por Iniciar";

  return null;
};

// Helper: normaliza números (evita NaN)
const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * GET /api/pacientes/:patientId/tratamientos
 * Lista tratamientos (patient_services) del paciente, con service + category normalizada
 * (incluye group_id; si aún no tienes tabla groups, al menos ya viene group_id)
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId);
    if (!patientId) return res.status(400).json({ error: "patientId inválido" });

    const query = `
      SELECT 
        ps.id AS treatment_id,
        ps.patient_id,
        ps.group_id AS group_id,
        ps.service_id,
        ps.service_date,
        ps.notes,
        ps.status,
        ps.total_cost AS total_cost,
        s.name AS service_name,
        c.id   AS service_category_id,
        c.name AS service_category,
        c.sort_order AS service_category_sort_order
      FROM patient_services ps
      JOIN services s ON ps.service_id = s.id
      JOIN service_categories c ON c.id = s.category_id
      WHERE ps.patient_id = ?
      ORDER BY ps.service_date DESC, ps.id DESC
    `;

    const [rows] = await db.query(query, [patientId]);
    res.json(rows);
  })
);

/**
 * POST /api/pacientes/:patientId/tratamientos
 * Crea un tratamiento (registro en patient_services)
 * Body: { service_id, service_date, notes?, total_cost?, status? }
 */
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId);
    if (!patientId) return res.status(400).json({ error: "patientId inválido" });

    const { service_id, service_date, notes, total_cost, status } = req.body;

    const sid = toNumber(service_id);
    if (!sid) return res.status(400).json({ error: "service_id es obligatorio" });
    if (!service_date) return res.status(400).json({ error: "service_date es obligatorio" });

    const cost = total_cost == null || total_cost === "" ? 0 : toNumber(total_cost);
    if (cost == null) return res.status(400).json({ error: "total_cost no es válido" });

    // ✅ normaliza status
    const normalized = normalizeStatus(status);
    if (!normalized || !VALID_STATUSES.includes(normalized)) {
      return res.status(400).json({
        error: "Estado no válido.",
        valid: VALID_STATUSES,
      });
    }

    // valida que exista el servicio
    const [svc] = await db.query("SELECT id FROM services WHERE id = ? LIMIT 1", [sid]);
    if (!svc.length) return res.status(400).json({ error: "service_id no existe" });

    const [result] = await db.query(
      `
      INSERT INTO patient_services
        (patient_id, service_id, service_date, notes, status, total_cost, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, NOW(), NOW())
      `,
      [patientId, sid, service_date, notes || null, normalized, cost]
    );

    res.status(201).json({
      message: "Tratamiento creado exitosamente.",
      id: result.insertId,
    });
  })
);

/**
 * PATCH /api/pacientes/:patientId/tratamientos/:treatmentId
 * Actualización parcial (costo / notas / fecha / service_id)
 * Body soportado: { total_cost?, notes?, service_date?, service_id? }
 */
router.patch(
  "/:treatmentId",
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId);
    const treatmentId = toNumber(req.params.treatmentId);
    if (!patientId) return res.status(400).json({ error: "patientId inválido" });
    if (!treatmentId) return res.status(400).json({ error: "treatmentId inválido" });

    const { total_cost, notes, service_date, service_id } = req.body;

    // Construir SET dinámico
    const sets = [];
    const values = [];

    if (total_cost !== undefined) {
      const cost = total_cost == null || total_cost === "" ? 0 : toNumber(total_cost);
      if (cost == null) return res.status(400).json({ error: "total_cost no es válido" });
      sets.push("total_cost = ?");
      values.push(cost);
    }

    if (notes !== undefined) {
      sets.push("notes = ?");
      values.push(notes || null);
    }

    if (service_date !== undefined) {
      if (!service_date) return res.status(400).json({ error: "service_date no es válido" });
      sets.push("service_date = ?");
      values.push(service_date);
    }

    if (service_id !== undefined) {
      const sid = toNumber(service_id);
      if (!sid) return res.status(400).json({ error: "service_id no es válido" });

      // valida que exista el servicio
      const [svc] = await db.query("SELECT id FROM services WHERE id = ? LIMIT 1", [sid]);
      if (!svc.length) return res.status(400).json({ error: "service_id no existe" });

      sets.push("service_id = ?");
      values.push(sid);
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: "No hay campos para actualizar." });
    }

    sets.push("updated_at = NOW()");

    // Importante: asegurar que el tratamiento pertenece al paciente
    const query = `
      UPDATE patient_services
      SET ${sets.join(", ")}
      WHERE id = ? AND patient_id = ?
    `;
    values.push(treatmentId, patientId);

    const [result] = await db.query(query, values);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Tratamiento no encontrado." });
    }

    res.status(200).json({ message: "Tratamiento actualizado exitosamente." });
  })
);

/**
 * PUT /api/pacientes/:patientId/tratamientos/:treatmentId/status
 * Actualizar status de un tratamiento (normaliza + valida)
 * Body: { status }
 */
router.put(
  "/:treatmentId/status",
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId);
    const treatmentId = toNumber(req.params.treatmentId);
    if (!patientId) return res.status(400).json({ error: "patientId inválido" });
    if (!treatmentId) return res.status(400).json({ error: "treatmentId inválido" });

    const { status } = req.body;

    const normalized = normalizeStatus(status);
    if (!normalized || !VALID_STATUSES.includes(normalized)) {
      return res.status(400).json({
        error: "Estado no válido.",
        valid: VALID_STATUSES,
      });
    }

    const [result] = await db.query(
      `UPDATE patient_services
       SET status = ?, updated_at = NOW()
       WHERE id = ? AND patient_id = ?`,
      [normalized, treatmentId, patientId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: "Tratamiento no encontrado para este paciente.",
      });
    }

    res.json({ message: "Estado actualizado exitosamente." });
  })
);

/**
 * DELETE /api/pacientes/:patientId/tratamientos/:treatmentId
 * Elimina un tratamiento (patient_services)
 */
router.delete(
  "/:treatmentId",
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId);
    const treatmentId = toNumber(req.params.treatmentId);
    if (!patientId) return res.status(400).json({ error: "patientId inválido" });
    if (!treatmentId) return res.status(400).json({ error: "treatmentId inválido" });

    const [result] = await db.query(
      "DELETE FROM patient_services WHERE id = ? AND patient_id = ?",
      [treatmentId, patientId]
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ error: "Tratamiento no encontrado en la base de datos." });
    }

    res.status(200).json({ message: "Tratamiento eliminado exitosamente." });
  })
);

module.exports = router;
