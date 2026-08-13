// routes/doctors.js
// ---------------------------------------------------------------------------
// Catálogo de médicos de la clínica (tabla `doctors`). Lo consumen:
//   - el selector de "Odontólogo" en las firmas del expediente clínico
//   - la pantalla /admin/medicos
//
// Lectura: cualquier usuario autenticado (el expediente lo necesita sin importar
// el rol). Escritura: solo permiso 'all' (admin), igual que el menú de admin.
//
// Bajas: lo normal es marcar `activo = 0`, para que los expedientes que ese
// médico firmó sigan mostrando quién los firmó. El DELETE duro existe solo para
// corregir altas equivocadas y se bloquea si algún expediente ya lo referencia.
// ---------------------------------------------------------------------------
const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authorizePermissions } = require('../middleware/auth');

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const soloAdmin = authorizePermissions('all');

const normalizar = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

const SELECT_DOCTOR =
  'SELECT id, nombre, titulo, cedula_profesional, activo, created_at, updated_at FROM doctors';

// Valida el body compartido por POST y PUT.
const leerBody = (body, { requerirTodo }) => {
  const nombre = body?.nombre === undefined ? undefined : normalizar(body.nombre);
  const titulo = body?.titulo === undefined ? undefined : normalizar(body.titulo);
  const cedula =
    body?.cedula_profesional === undefined ? undefined : normalizar(body.cedula_profesional);

  if (requerirTodo || nombre !== undefined) {
    if (!nombre) return { error: 'El nombre es obligatorio.' };
    if (nombre.length > 150) return { error: 'El nombre es demasiado largo (máx. 150).' };
  }
  if (requerirTodo || cedula !== undefined) {
    if (!cedula) return { error: 'La cédula profesional es obligatoria.' };
    if (cedula.length > 50) return { error: 'La cédula es demasiado larga (máx. 50).' };
  }
  if (titulo !== undefined && titulo.length > 100) {
    return { error: 'El título es demasiado largo (máx. 100).' };
  }

  let activo;
  if (body?.activo !== undefined) {
    activo = body.activo === true || body.activo === 1 || body.activo === '1' ? 1 : 0;
  }

  return { nombre, titulo, cedula, activo };
};

// ¿Otro médico ya usa esta cédula? (la columna es UNIQUE)
const cedulaOcupada = async (cedula, exceptoId) => {
  const [rows] = await db.query(
    `SELECT id FROM doctors WHERE cedula_profesional = ?${exceptoId ? ' AND id <> ?' : ''} LIMIT 1`,
    exceptoId ? [cedula, exceptoId] : [cedula]
  );
  return rows.length > 0;
};

// GET /  -> médicos activos. ?todos=1 incluye los dados de baja, para poder
// mostrar el nombre en expedientes viejos y para la pantalla de administración.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const incluirInactivos = req.query.todos === '1';

    const [rows] = await db.query(
      `${SELECT_DOCTOR}
       ${incluirInactivos ? '' : 'WHERE activo = 1'}
       ORDER BY activo DESC, nombre`
    );

    res.json(rows);
  })
);

// POST / -> alta de médico
router.post(
  '/',
  soloAdmin,
  asyncHandler(async (req, res) => {
    const datos = leerBody(req.body, { requerirTodo: true });
    if (datos.error) return res.status(400).json({ error: datos.error });

    if (await cedulaOcupada(datos.cedula)) {
      return res.status(409).json({ error: 'Ya existe un médico con esa cédula profesional.' });
    }

    const [result] = await db.query(
      `INSERT INTO doctors (nombre, titulo, cedula_profesional, activo, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [datos.nombre, datos.titulo || null, datos.cedula, datos.activo === undefined ? 1 : datos.activo]
    );

    const [rows] = await db.query(`${SELECT_DOCTOR} WHERE id = ?`, [result.insertId]);
    res.status(201).json(rows[0]);
  })
);

// PUT /:id -> edición. También es la vía para dar de alta/baja (`activo`).
router.put(
  '/:id',
  soloAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const datos = leerBody(req.body, { requerirTodo: false });
    if (datos.error) return res.status(400).json({ error: datos.error });

    if (datos.cedula !== undefined && (await cedulaOcupada(datos.cedula, id))) {
      return res.status(409).json({ error: 'Ya existe un médico con esa cédula profesional.' });
    }

    const campos = [];
    const valores = [];

    if (datos.nombre !== undefined) {
      campos.push('nombre = ?');
      valores.push(datos.nombre);
    }
    if (datos.titulo !== undefined) {
      campos.push('titulo = ?');
      valores.push(datos.titulo || null);
    }
    if (datos.cedula !== undefined) {
      campos.push('cedula_profesional = ?');
      valores.push(datos.cedula);
    }
    if (datos.activo !== undefined) {
      campos.push('activo = ?');
      valores.push(datos.activo);
    }

    if (campos.length === 0) {
      return res.status(400).json({ error: 'No hay nada que actualizar.' });
    }

    campos.push('updated_at = NOW()');

    const [result] = await db.query(
      `UPDATE doctors SET ${campos.join(', ')} WHERE id = ?`,
      [...valores, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Médico no encontrado.' });
    }

    const [rows] = await db.query(`${SELECT_DOCTOR} WHERE id = ?`, [id]);
    res.json(rows[0]);
  })
);

// DELETE /:id -> borrado duro, solo si ningún expediente lo tiene como firmante.
// Para retirar a un médico que ya firmó, se usa PUT con activo = 0.
router.delete(
  '/:id',
  soloAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total
       FROM clinical_records
       WHERE JSON_UNQUOTE(JSON_EXTRACT(form_data, '$.odontologoId')) = ?`,
      [String(id)]
    );

    if (total > 0) {
      return res.status(409).json({
        error: `No se puede eliminar: ${total} expediente(s) lo tienen como firmante. Da de baja al médico en lugar de eliminarlo.`,
      });
    }

    const [result] = await db.query('DELETE FROM doctors WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Médico no encontrado.' });
    }

    res.json({ message: 'Médico eliminado exitosamente.' });
  })
);

module.exports = router;
