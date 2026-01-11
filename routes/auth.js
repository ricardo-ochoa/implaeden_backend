// routes/auth.js
const express = require('express');
const passport = require('passport');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const router = express.Router();
const crypto = require("crypto");
const { authenticateJwt, authorizePermissions } = require("../middleware/auth");

// Registro de usuario
router.post(
  "/register",
  authenticateJwt,
  authorizePermissions("all"),
  async (req, res) => {
    const { email, password, role } = req.body;
    const allowedRoles = new Set(["medico", "secretario", "reader"]);
    if (!allowedRoles.has(role)) {
      return res.status(400).send({ message: "Rol inválido" });
    }

    if (!email || !password) {
      return res.status(400).send({ message: "Email y password requeridos" });
    }

    const permission =
      role === "medico" || role === "secretario" ? "editor" : "reader";

    try {
      // evitar duplicados
      const [exists] = await db.query("SELECT id FROM users WHERE email = ?", [email]);
      if (exists.length) return res.status(409).send({ message: "Email ya existe" });

      const hash = await bcrypt.hash(password, 10);

      await db.query(
        `INSERT INTO users (email, password_hash, role, permission)
         VALUES (?, ?, ?, ?)`,
        [email, hash, role, permission]
      );

      res.status(201).send({ message: `Usuario creado con rol ${role}` });
    } catch (err) {
      console.error("Error en registro:", err);
      res.status(500).send({ message: "Error interno al registrar usuario" });
    }
  }
);

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
  return res.clearCookie('refreshToken', { path: '/' }).sendStatus(204);
});


router.post(
  "/invite",
  authenticateJwt,
  authorizePermissions("all"),
  async (req, res) => {
    const { email, role } = req.body;

    const allowedRoles = new Set(["medico", "secretario", "reader"]);
    if (!email || !allowedRoles.has(role)) {
      return res.status(400).send({ message: "Email o rol inválido" });
    }

    const permission =
      role === "medico" || role === "secretario" ? "editor" : "reader";

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

    try {
      // 1) si ya existe usuario, no invitamos
      const [exists] = await db.query(
        "SELECT id FROM users WHERE email = ? LIMIT 1",
        [email]
      );
      if (exists.length) return res.status(409).send({ message: "Ese email ya existe" });

      // 2) rotación: borra invitaciones activas anteriores
      await db.query(
        `DELETE FROM user_invitations
         WHERE email = ? AND used_at IS NULL AND expires_at > NOW()`,
        [email]
      );

      // 3) crea nueva invitación
      await db.query(
        `INSERT INTO user_invitations (email, role, permission, token_hash, expires_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [email, role, permission, tokenHash, expiresAt, req.user.sub]
      );

      const inviteUrl = `${process.env.APP_URL}/accept-invite?token=${token}`;

      return res.status(201).send({
        message: "Invitación creada. Comparte este link con el usuario.",
        inviteUrl,
        expiresAt,
      });
    } catch (err) {
      console.error("Error invitando:", err);
      return res.status(500).send({ message: "Error interno al invitar" });
    }
  }
);

router.post("/invite/accept", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).send({ message: "token y password requeridos" });

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT * FROM user_invitations
       WHERE token_hash = ? AND used_at IS NULL
       LIMIT 1 FOR UPDATE`,
      [tokenHash]
    );

    if (!rows.length) {
      await conn.rollback();
      return res.status(400).send({ message: "Invitación inválida" });
    }

    const inv = rows[0];
    if (new Date(inv.expires_at) < new Date()) {
      await conn.rollback();
      return res.status(400).send({ message: "Invitación expirada" });
    }

    const [exists] = await conn.query("SELECT id FROM users WHERE email = ?", [inv.email]);
    if (exists.length) {
      await conn.rollback();
      return res.status(409).send({ message: "Ese email ya existe" });
    }

    const hash = await bcrypt.hash(password, 10);

    await conn.query(
      `INSERT INTO users (email, password_hash, role, permission)
       VALUES (?, ?, ?, ?)`,
      [inv.email, hash, inv.role, inv.permission]
    );

    await conn.query("UPDATE user_invitations SET used_at = NOW() WHERE id = ?", [inv.id]);

    await conn.commit();
    return res.status(201).send({ message: "Cuenta creada. Ya puedes iniciar sesión." });
  } catch (err) {
    await conn.rollback();
    console.error("Error aceptando invitación:", err);
    return res.status(500).send({ message: "Error interno" });
  } finally {
    conn.release();
  }
});

// routes/auth.js (agrega cerca de invite)
router.post(
  "/password/reset/create",
  authenticateJwt,
  authorizePermissions("all"),
  async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).send({ message: "Email requerido" });

    try {
      // 1) valida que exista el usuario
      const [users] = await db.query("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
      if (!users.length) return res.status(404).send({ message: "Usuario no encontrado" });

      const userId = users[0].id;

      // 2) rota resets activos previos (evita duplicados)
      await db.query(
        `DELETE FROM password_resets
         WHERE email = ? AND used_at IS NULL AND expires_at > NOW()`,
        [email]
      );

      // 3) crea token
      const token = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

      await db.query(
        `INSERT INTO password_resets (user_id, email, token_hash, expires_at, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, email, tokenHash, expiresAt, req.user.sub]
      );

      const resetUrl = `${process.env.APP_URL}/reset-password?token=${token}`;

      return res.status(201).send({
        message: "Link de reseteo creado. Compártelo con el usuario.",
        resetUrl,
        expiresAt,
      });
    } catch (err) {
      console.error("Error creando reset:", err);
      return res.status(500).send({ message: "Error interno" });
    }
  }
);

router.post("/password/reset/confirm", async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).send({ message: "token y newPassword requeridos" });
  }
  if (newPassword.length < 8) {
    return res.status(400).send({ message: "La contraseña debe tener mínimo 8 caracteres" });
  }

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT * FROM password_resets
       WHERE token_hash = ? AND used_at IS NULL
       LIMIT 1 FOR UPDATE`,
      [tokenHash]
    );

    if (!rows.length) {
      await conn.rollback();
      return res.status(400).send({ message: "Token inválido" });
    }

    const pr = rows[0];
    if (new Date(pr.expires_at) < new Date()) {
      await conn.rollback();
      return res.status(400).send({ message: "Token expirado" });
    }

    const hash = await bcrypt.hash(newPassword, 10);

    await conn.query(
      "UPDATE users SET password_hash = ? WHERE email = ?",
      [hash, pr.email]
    );

    await conn.query("UPDATE password_resets SET used_at = NOW() WHERE id = ?", [pr.id]);

    // (recomendado) invalidar sesiones: borrar refresh tokens de ese usuario
    if (pr.user_id) {
      await conn.query("DELETE FROM refresh_tokens WHERE user_id = ?", [pr.user_id]);
    }

    await conn.commit();
    return res.status(200).send({ message: "Contraseña actualizada. Ya puedes iniciar sesión." });
  } catch (err) {
    await conn.rollback();
    console.error("Error confirmando reset:", err);
    return res.status(500).send({ message: "Error interno" });
  } finally {
    conn.release();
  }
});


module.exports = router;
