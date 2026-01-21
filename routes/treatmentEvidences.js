// routes/treatmentEvidences.js
const express = require('express')
const router = express.Router({ mergeParams: true })
const AWS = require('aws-sdk')
const multer = require('multer')
const pool = require('../config/db')
const { logPatientEvent } = require('../utils/logPatientEvent')


const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next)

// 1) Configura AWS
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
})
const s3 = new AWS.S3()

// 2) Multer (in memory)
const upload = multer({ storage: multer.memoryStorage() })

// 3) Helper para subir a S3
async function uploadFileToS3(file) {
  const key = `evidencias/${Date.now()}_${file.originalname}`
  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  }
  const { Location } = await s3.upload(params).promise()
  return Location
}

// 4) GET: listar evidencias de un patient_service
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { treatmentId } = req.params
    const [rows] = await pool.query(
      `
      SELECT id, patient_service_id, record_date, file_url, created_at
      FROM treatment_evidences
      WHERE patient_service_id = ?
      ORDER BY record_date DESC, id DESC
      `,
      [Number(treatmentId)]
    )
    res.json(rows)
  })
)

// 5) POST: subir evidencias
// POST /api/pacientes/:patientId/tratamientos/:treatmentId/evidencias
router.post(
  '/',
  upload.array('files', 10),
  asyncHandler(async (req, res) => {
    const { patientId, treatmentId } = req.params
    const { record_date } = req.body

    const pid = Number(patientId)
    const tid = Number(treatmentId)
    const createdBy = req.user?.id ?? null

    const files = Array.isArray(req.files) ? req.files : []
    if (files.length === 0) {
      return res.status(400).json({ error: 'Debes enviar al menos un archivo.' })
    }

    const recordDateValue = record_date ? new Date(record_date) : new Date()

    // 1) sube a S3
    const urls = await Promise.all(files.map(uploadFileToS3))

    // 2) guarda evidencias en DB
    const insertedIds = []
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]
      const [ins] = await pool.query(
        `
        INSERT INTO treatment_evidences
          (patient_service_id, record_date, file_url, created_at, updated_at)
        VALUES
          (?, ?, ?, NOW(), NOW())
        `,
        [tid, recordDateValue, url]
      )
      insertedIds.push(ins?.insertId)
    }

    // 3) ✅ Log evento CORRECTO: evidence_added (no evidence_deleted)
    await logPatientEvent({
      patientId: pid,
      patientServiceId: tid,
      // group se autocompleta desde patient_services.id = tid
      eventType: 'evidence_added',
      message: `Se agregó ${urls.length} evidencia(s) al tratamiento (ID: ${tid}).`,
      meta: {
        treatmentId: tid,
        record_date: recordDateValue,
        count: urls.length,
        urls,
        filenames: files.map((f) => f.originalname),
        evidence_ids: insertedIds,
      },
      createdBy,
    })

    res.status(201).json({
      message: 'Evidencias subidas correctamente.',
      urls,
      evidence_ids: insertedIds,
    })
  })
)

// 6) DELETE: borrar evidencia
// DELETE /api/pacientes/:patientId/tratamientos/:treatmentId/evidencias/:id
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { patientId, treatmentId, id } = req.params

    const pid = Number(patientId)
    const tid = Number(treatmentId)
    const eid = Number(id)
    const createdBy = req.user?.id ?? null

    // 1) leer evidencia antes de borrarla (para log)
    const [[ev]] = await pool.query(
      `
      SELECT id, patient_service_id, record_date, file_url, created_at
      FROM treatment_evidences
      WHERE id = ? AND patient_service_id = ?
      LIMIT 1
      `,
      [eid, tid]
    )

    if (!ev) {
      return res.status(404).json({ error: 'Evidencia no encontrada.' })
    }

    // 2) borrar
    const [result] = await pool.query(
      `DELETE FROM treatment_evidences WHERE id = ? AND patient_service_id = ?`,
      [eid, tid]
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Evidencia no encontrada.' })
    }

    // 3) ✅ log evento CORRECTO: evidence_deleted (código)
    await logPatientEvent({
      patientId: pid,
      patientServiceId: tid,
      eventType: 'evidence_deleted',
      message: `Se eliminó una evidencia del tratamiento (ID: ${tid}).`,
      meta: {
        treatmentId: tid,
        evidence_id: eid,
        file_url: ev.file_url,
        record_date: ev.record_date,
        created_at: ev.created_at,
      },
      createdBy,
    })

    res.json({ message: 'Evidencia eliminada.' })
  })
)

module.exports = router
