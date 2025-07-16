// middleware/auth.js
const passport = require('passport');

// Middleware para autenticar JWT
const authenticateJwt = passport.authenticate('jwt', { session: false });

// Middleware para autorizar según permisos
function authorizePermissions(...allowedPerms) {
  return (req, res, next) => {
    const userPerm = req.user.permission;
    if (!allowedPerms.includes(userPerm)) {
      return res.status(403).send({ error: 'No tienes permiso para esto' });
    }
    next();
  };
}

module.exports = { authenticateJwt, authorizePermissions };
