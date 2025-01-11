const express = require('express');
const router = express.Router();
const db = require('../config/db');

router.get('/db-test', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT 1 + 1 AS solution');
    res.json({ message: 'Conexión exitosa', result: rows[0].solution });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al conectar con la base de datos', details: error.message });
  }
});

module.exports = router;
