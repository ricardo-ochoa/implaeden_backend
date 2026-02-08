const express = require('express')
const db = require('../config/db')
const router = express.Router()

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await db.query(`
      SELECT tooth_code, name_es
      FROM teeth
      ORDER BY tooth_code
    `)
    res.json(rows)
  } catch (e) {
    next(e)
  }
})

module.exports = router
