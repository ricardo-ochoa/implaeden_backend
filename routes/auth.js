// routes/auth.js
const express = require('express');
const passport = require('passport');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const router = express.Router();

// Registro de usuario
router.post('/register', async (req, res) => {
  const { email, password, role } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    let permission = 'reader';
    if (role === 'admin') {
      permission = 'all';
    } else if (role === 'medico' || role === 'secretario') {
      permission = 'editor';
    }
    await db.query(
      `INSERT INTO users (email, password_hash, role, permission)
       VALUES (?, ?, ?, ?)`,
      [email, hash, role, permission]
    );
    res.status(201).send({ message: 'Usuario creado con rol ' + role });
  } catch (err) {
    console.error('Error en registro:', err);
    res.status(500).send({ message: 'Error interno al registrar usuario' });
  }
});

// Login de usuario
router.post('/login', (req, res, next) => {
  passport.authenticate('local', { session: false }, (err, user, info) => {
    if (err) {
      console.error('Error de passport:', err);
      return res.status(500).send({ message: 'Error interno al autenticar' });
    }
    if (!user) {
      return res.status(401).send(info);
    }
    const token = jwt.sign(
      { sub: user.id, role: user.role, permission: user.permission },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.send({ token });
  })(req, res, next);
});

module.exports = router;
