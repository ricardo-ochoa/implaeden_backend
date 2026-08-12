// routes/cobranza.js
// ---------------------------------------------------------------------------
// Tablero de cobranza (vista de TODA la clínica). Devuelve un renglón por
// tratamiento con su costo, lo pagado y el saldo, más el paciente. El frontend
// lo agrupa en columnas (por cobrar / en proceso / cobrado) y suma los totales.
//
// Filtro por FECHA DEL TRATAMIENTO (service_date) vía ?from=YYYY-MM-DD&to=...
// (coherente para las 3 columnas: incluso "por cobrar" tiene fecha de tratamiento).
// ---------------------------------------------------------------------------
const express = require('express')
const router = express.Router()
const db = require('../config/db')

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next)

// GET /api/cobranza?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { from, to } = req.query
    const where = []
    const params = []
    if (from) { where.push('ps.service_date >= ?'); params.push(from) }
    if (to)   { where.push('ps.service_date <= ?'); params.push(to) }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const [rows] = await db.query(
      `SELECT
         ps.id             AS treatment_id,
         ps.patient_id,
         ps.service_date,
         ps.status         AS clinical_status,
         ps.group_id,
         g.title           AS group_title,
         s.name            AS service_name,
         pac.nombre        AS paciente_nombre,
         pac.apellidos     AS paciente_apellidos,
         ps.total_cost     AS total_cost,
         IFNULL(pg.pagado, 0) AS pagado
       FROM patient_services ps
       JOIN services s    ON s.id   = ps.service_id
       JOIN pacientes pac ON pac.id = ps.patient_id
       LEFT JOIN patient_service_groups g ON g.id = ps.group_id
       LEFT JOIN (
         SELECT patient_service_id, SUM(monto) AS pagado
         FROM patient_payments
         WHERE patient_service_id IS NOT NULL
         GROUP BY patient_service_id
       ) pg ON pg.patient_service_id = ps.id
       ${whereSql}
       ORDER BY ps.service_date DESC, ps.id DESC`,
      params
    )

    const items = rows.map((r) => {
      const total = Number(r.total_cost || 0)
      const pagado = Number(r.pagado || 0)
      const saldo = total - pagado
      // estado financiero: por_cobrar (nada pagado) | en_proceso (abonado) | cobrado (saldo 0)
      let estado = 'por_cobrar'
      if (total > 0 && saldo <= 0.009) estado = 'cobrado'
      else if (pagado > 0) estado = 'en_proceso'
      return {
        treatment_id: r.treatment_id,
        patient_id: r.patient_id,
        paciente: `${r.paciente_nombre || ''} ${r.paciente_apellidos || ''}`.trim() || 'Paciente',
        service_name: r.service_name,
        group_title: r.group_title || null,
        service_date: r.service_date,
        clinical_status: r.clinical_status,
        total_cost: total,
        pagado,
        saldo,
        estado,
      }
    })

    res.json(items)
  })
)

module.exports = router
