// auth/passport.js
require('dotenv').config(); // Carga variables de entorno en desarrollo

const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const { Strategy: JwtStrategy, ExtractJwt } = require('passport-jwt');
const bcrypt = require('bcrypt');
const db = require('../config/db');

// Verificar que JWT_SECRET esté definido
if (!process.env.JWT_SECRET) {
  console.error('❌ Error: JWT_SECRET no está definido en .env');
  process.exit(1);
}

// Strategy para login con email y contraseña
passport.use(
  new LocalStrategy(
    { usernameField: 'email' },
    async (email, password, done) => {
      try {
        const [rows] = await db.query(
          'SELECT * FROM users WHERE email = ?',
          [email]
        );
        const user = rows[0];
        if (!user) return done(null, false, { message: 'Usuario no existe' });
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return done(null, false, { message: 'Credenciales inválidas' });
        return done(null, { id: user.id, role: user.role, permission: user.permission });
      } catch (err) {
        return done(err);
      }
    }
  )
);

// Strategy para JWT
passport.use(
  new JwtStrategy(
    {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: process.env.JWT_SECRET,
    },
    async (payload, done) => {
      try {
        const [rows] = await db.query(
          'SELECT id, role, permission FROM users WHERE id = ?',
          [payload.sub]
        );
        const user = rows[0];
        if (!user) return done(null, false);
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  )
);

module.exports = passport;
