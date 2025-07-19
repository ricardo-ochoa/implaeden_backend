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
    let permission = 
      role === 'admin' ? 'all' :
      (role === 'medico' || role === 'secretario') ? 'editor' :
      'reader';
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

// Login de usuario: emite access + refresh tokens
// routes/auth.js → LOGIN
router.post('/login', (req, res, next) => {
  passport.authenticate('local', { session: false }, async (err, user, info) => {
    if (err)   return res.status(500).send({ message: 'Error interno' });
    if (!user) return res.status(401).send(info);

    // Genera tokens
    const accessToken  = jwt.sign({ sub: user.id, role: user.role, permission: user.permission }, process.env.JWT_SECRET,       { expiresIn: '8h' });
    const refreshToken = jwt.sign({ sub: user.id }, process.env.REFRESH_TOKEN_SECRET, { expiresIn: '7d' });

    // Guarda refreshToken en BD…
    await db.query('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
                   [user.id, refreshToken, new Date(Date.now() + 7*24*60*60*1000)]);

    // Devuelve accessToken + cookie httpOnly
    res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path:     '/',
        maxAge:   7 * 24 * 60 * 60 * 1000,
      })
      .json({ accessToken });
  })(req, res, next);
});


// Refresh token: recibe refreshToken, verifica y emite nuevos tokens
// routes/auth.js → REFRESH
router.post('/token', async (req, res) => {
  const { refreshToken } = req.cookies;        // <<< leer de cookie
  if (!refreshToken) return res.sendStatus(401);

  // Validar en BD…
  const [rows] = await db.query('SELECT * FROM refresh_tokens WHERE token = ?', [refreshToken]);
  if (rows.length === 0) return res.sendStatus(403);
  const tokenRecord = rows[0];
  if (new Date(tokenRecord.expires_at) < new Date()) {
    await db.query('DELETE FROM refresh_tokens WHERE id = ?', [tokenRecord.id]);
    return res.sendStatus(403);
  }

  // Verificar JWT
  jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET, async (err, payload) => {
    if (err) return res.sendStatus(403);

    // Traer datos de usuario
    const [users] = await db.query('SELECT id, role, permission FROM users WHERE id = ?', [payload.sub]);
    if (users.length === 0) return res.sendStatus(403);
    const user = users[0];

    // Generar nuevos tokens
    const newAccessToken  = jwt.sign({ sub: user.id, role: user.role, permission: user.permission }, process.env.JWT_SECRET,       { expiresIn: '8h' });
    const newRefreshToken = jwt.sign({ sub: user.id }, process.env.REFRESH_TOKEN_SECRET, { expiresIn: '7d' });

    // Rotar en BD: borra viejo, inserta nuevo
    await db.query('DELETE FROM refresh_tokens WHERE id = ?', [tokenRecord.id]);
    await db.query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      [user.id, newRefreshToken, new Date(Date.now() + 7*24*60*60*1000)]
    );

    // Enviar cookie + accessToken
    res
      .cookie('refreshToken', newRefreshToken, {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path:     '/',
        maxAge:   7 * 24 * 60 * 60 * 1000,
      })
      .json({ accessToken: newAccessToken });
  });
});


// Logout: revoca el refresh token
router.post('/logout', async (req, res) => {
  const { refreshToken } = req.cookies;
  if (refreshToken) {
    await db.query('DELETE FROM refresh_tokens WHERE token = ?', [refreshToken]);
  }
  res
    .clearCookie('refreshToken', { path: '/' })
    .sendStatus(204);
});

module.exports = router;
