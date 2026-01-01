// routes/users.js
const { authenticateJwt, authorizePermissions } = require("../middleware/auth");

router.patch(
  "/users/:id/disable",
  authenticateJwt,
  authorizePermissions("all"),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).send({ message: "id inválido" });

    await db.query("UPDATE users SET status = 'disabled' WHERE id = ?", [id]);
    res.send({ message: "Usuario desactivado" });
  }
);
