// scripts/importFiscalNotion.js
// ---------------------------------------------------------------------------
// Importa las Constancias de Situación Fiscal exportadas de Notion
// (ExportBlock-notion) hacia MinIO/S3 + `patient_fiscal_documents`.
//
// POR DEFECTO NO ESCRIBE NADA: corre en modo reporte para que puedas revisar a
// quién emparejó, a quién crearía y qué archivos subiría. Solo con --apply
// toca la base y el bucket.
//
//   node scripts/importFiscalNotion.js --dir "../ExportBlock-notion"
//   node scripts/importFiscalNotion.js --dir "../ExportBlock-notion" --apply
//
// Contra producción hay que pasar las variables de prod explícitamente, igual
// que en scripts/migrate.js. Nunca las toma solo.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const args = process.argv.slice(2);
const flag = (nombre, porDefecto = null) => {
  const i = args.indexOf(`--${nombre}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : porDefecto;
};
const APLICAR = args.includes('--apply');
const DIR = path.resolve(flag('dir', path.join(__dirname, '..', '..', 'ExportBlock-notion')));

if (!process.env.DB_HOST) {
  const env = process.env.NODE_ENV || 'development';
  require('dotenv').config({ path: path.resolve(__dirname, '..', `.env.${env}`) });
}

const cfg = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
function parseCSV(texto) {
  const filas = [];
  let campo = '';
  let fila = [];
  let enComillas = false;

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (enComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else enComillas = false;
      } else campo += c;
    } else if (c === '"') enComillas = true;
    else if (c === ',') {
      fila.push(campo);
      campo = '';
    } else if (c === '\n') {
      fila.push(campo);
      filas.push(fila);
      fila = [];
      campo = '';
    } else if (c !== '\r') campo += c;
  }
  if (campo || fila.length) {
    fila.push(campo);
    filas.push(fila);
  }
  return filas;
}

// Quita acentos, signos y dobles espacios para poder comparar nombres que
// vienen escritos de mil formas ("ADRIANA CRUZ" vs "Adriana Cruz De la Cruz").
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Notion agrega un sufijo hash a algunas carpetas: "Nombre 185f-c01f".
const sinHashNotion = (s) => String(s || '').replace(/\s+[0-9a-f]{4,}(-[0-9a-f]{4,})*$/i, '').trim();

const normalizarCorreo = (s) => String(s || '').trim().toLowerCase() || null;

const soloDigitos = (s) => String(s || '').replace(/\D/g, '');

// ---------------------------------------------------------------------------
// Lectura del export
// ---------------------------------------------------------------------------
function leerExport(dir) {
  const csvPath = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('_all.csv'))
    .map((f) => path.join(dir, f))[0];

  if (!csvPath) throw new Error(`No se encontró el CSV *_all.csv en ${dir}`);

  const filas = parseCSV(fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, ''));
  const head = filas[0].map((h) => h.trim());

  const iNombre = head.indexOf('Nombre del Paciente');
  const iCorreo = head.indexOf('Correo electrónico');
  const iFiscal = head.indexOf('Identificación fiscal');
  const iTel = head.indexOf('Teléfono celular');

  if (iNombre < 0 || iFiscal < 0) {
    throw new Error(`El CSV no tiene las columnas esperadas. Encontradas: ${head.join(' | ')}`);
  }

  // Varias filas por paciente (una por pago): se consolidan por nombre
  // normalizado para no duplicar personas ni archivos.
  const porPaciente = new Map();

  for (const fila of filas.slice(1)) {
    if (!fila || fila.length < 2) continue;

    const nombre = sinHashNotion((fila[iNombre] || '').trim());
    if (!nombre) continue;

    const clave = norm(nombre);
    const actual = porPaciente.get(clave) || {
      nombre,
      correos: new Set(),
      telefonos: new Set(),
      archivos: new Set(),
    };

    // El nombre más largo suele ser el más completo ("Adriana Cruz De la Cruz").
    if (nombre.length > actual.nombre.length) actual.nombre = nombre;

    const correo = normalizarCorreo(fila[iCorreo]);
    if (correo) actual.correos.add(correo);

    const tel = soloDigitos(iTel >= 0 ? fila[iTel] : '');
    if (tel) actual.telefonos.add(tel);

    // Notion separa varios archivos con ', ' y codifica la ruta.
    const celda = (fila[iFiscal] || '').trim();
    for (const parte of celda.split(', ')) {
      const rel = decodeURIComponent(parte.trim());
      if (!rel) continue;
      const abs = path.join(dir, rel);
      if (fs.existsSync(abs)) actual.archivos.add(abs);
      else actual.archivos.add(`__FALTA__${abs}`);
    }

    porPaciente.set(clave, actual);
  }

  return [...porPaciente.values()].map((p) => ({
    nombre: p.nombre,
    correos: [...p.correos],
    telefonos: [...p.telefonos],
    archivos: [...p.archivos].filter((a) => !a.startsWith('__FALTA__')),
    faltantes: [...p.archivos].filter((a) => a.startsWith('__FALTA__')).map((a) => a.slice(9)),
  }));
}

// ---------------------------------------------------------------------------
// Emparejamiento con `pacientes`
// ---------------------------------------------------------------------------
function emparejar(registro, pacientes, correosCompartidos) {
  // 1) correo exacto: lo más confiable, PERO solo si ese correo identifica a
  // una sola persona dentro del export. En los datos hay familiares que
  // comparten correo (madre e hijo con el mismo hotmail): emparejar por ahí
  // colgaría la constancia de uno en el expediente del otro.
  for (const correo of registro.correos) {
    if (correosCompartidos.has(correo)) continue;
    const porCorreo = pacientes.filter((p) => normalizarCorreo(p.email) === correo);
    if (porCorreo.length === 1) return { paciente: porCorreo[0], via: 'correo' };
    if (porCorreo.length > 1) return { ambiguo: porCorreo, via: 'correo' };
  }

  // 2) nombre completo normalizado
  const clave = norm(registro.nombre);
  const exactos = pacientes.filter((p) => norm(`${p.nombre} ${p.apellidos || ''}`) === clave);
  if (exactos.length === 1) return { paciente: exactos[0], via: 'nombre' };
  if (exactos.length > 1) return { ambiguo: exactos, via: 'nombre' };

  // 3) teléfono
  for (const tel of registro.telefonos) {
    const porTel = pacientes.filter((p) => soloDigitos(p.telefono).endsWith(tel.slice(-10)));
    if (porTel.length === 1) return { paciente: porTel[0], via: 'teléfono' };
  }

  // 4) todas las palabras del nombre del CSV aparecen en el del paciente.
  // Es una pista, no una certeza: se reporta como dudoso y no se aplica solo.
  const palabras = clave.split(' ').filter((w) => w.length > 2);
  if (palabras.length >= 2) {
    const parciales = pacientes.filter((p) => {
      const completo = norm(`${p.nombre} ${p.apellidos || ''}`);
      return palabras.every((w) => completo.includes(w));
    });
    if (parciales.length === 1) return { dudoso: parciales[0], via: 'nombre parcial' };
    if (parciales.length > 1) return { ambiguo: parciales, via: 'nombre parcial' };
  }

  return { nuevo: true };
}

// Partículas que forman parte del apellido y no deben quedar del lado del
// nombre: "Javier de la Rosa Garcia" -> apellidos "de la Rosa Garcia", y
// "Julian Cesar Chuc y Pat" -> apellidos "Chuc y Pat".
const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'san', 'santa', 'da', 'do']);

// Parte el nombre completo en nombre + apellidos como los guarda la app.
// Es una heurística: en español no hay forma de saber con certeza dónde
// terminan los nombres de pila, por eso el reporte muestra el resultado para
// que se revise antes de aplicar.
function partirNombre(completo) {
  const partes = String(completo || '').trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return { nombre: 'Paciente', apellidos: null };
  if (partes.length === 1) return { nombre: partes[0], apellidos: null };
  if (partes.length === 2) return { nombre: partes[0], apellidos: partes[1] };

  // Se parte por los dos últimos y se corre el corte a la izquierda mientras
  // haya una partícula pegada a cualquiera de sus dos lados. Hay que mirar
  // ambos: en "Julian Cesar Chuc y Pat" la partícula cae dentro del apellido,
  // y en "Javier de la Rosa Garcia" queda del lado del nombre.
  let corte = partes.length - 2;
  while (
    corte > 1 &&
    (PARTICULAS.has(partes[corte].toLowerCase()) || PARTICULAS.has(partes[corte - 1].toLowerCase()))
  ) {
    corte--;
  }

  return {
    nombre: partes.slice(0, corte).join(' '),
    apellidos: partes.slice(corte).join(' '),
  };
}

// ---------------------------------------------------------------------------
(async () => {
  console.log(`Export:  ${DIR}`);
  console.log(`Base:    ${cfg.host}:${cfg.port}/${cfg.database}`);
  console.log(`Modo:    ${APLICAR ? '*** APLICAR (escribe en BD y bucket) ***' : 'reporte (no escribe nada)'}\n`);

  const registros = leerExport(DIR);
  const conn = await mysql.createConnection(cfg);
  const [pacientes] = await conn.query('SELECT id, nombre, apellidos, email, telefono FROM pacientes');

  // Correos que aparecen en más de una persona del export (familiares que
  // comparten cuenta): no sirven para identificar a nadie.
  const vecesPorCorreo = new Map();
  for (const r of registros) {
    for (const c of r.correos) vecesPorCorreo.set(c, (vecesPorCorreo.get(c) || 0) + 1);
  }
  const correosCompartidos = new Set(
    [...vecesPorCorreo.entries()].filter(([, n]) => n > 1).map(([c]) => c)
  );
  if (correosCompartidos.size) {
    console.log(`  (${correosCompartidos.size} correo(s) compartidos entre personas: no se usan para emparejar)`);
  }

  const resultado = { emparejados: [], dudosos: [], ambiguos: [], nuevos: [] };

  for (const reg of registros) {
    const m = emparejar(reg, pacientes, correosCompartidos);
    if (m.paciente) resultado.emparejados.push({ reg, ...m });
    else if (m.dudoso) resultado.dudosos.push({ reg, ...m });
    else if (m.ambiguo) resultado.ambiguos.push({ reg, ...m });
    else resultado.nuevos.push({ reg });
  }

  const totalArchivos = registros.reduce((n, r) => n + r.archivos.length, 0);
  const sinTelefono = resultado.nuevos.filter((x) => x.reg.telefonos.length === 0).length;

  console.log('== RESUMEN ==');
  console.log(`  pacientes en el export : ${registros.length}`);
  console.log(`  archivos encontrados   : ${totalArchivos}`);
  console.log(`  pacientes en la BD     : ${pacientes.length}`);
  console.log(`  emparejados            : ${resultado.emparejados.length}`);
  console.log(`  dudosos (revisar)      : ${resultado.dudosos.length}`);
  console.log(`  ambiguos (varios)      : ${resultado.ambiguos.length}`);
  console.log(`  se crearían            : ${resultado.nuevos.length}  (${sinTelefono} sin teléfono)`);

  const faltantes = registros.flatMap((r) => r.faltantes);
  if (faltantes.length) {
    console.log(`\n  ⚠ archivos referenciados que no están en disco: ${faltantes.length}`);
    faltantes.slice(0, 10).forEach((f) => console.log(`     ${f}`));
  }

  const linea = (x, extra = '') =>
    `  ${x.reg.nombre}  [${x.reg.archivos.length} archivo(s)]${extra}`;

  if (resultado.emparejados.length) {
    console.log('\n== EMPAREJADOS ==');
    resultado.emparejados.forEach((x) =>
      console.log(linea(x, ` -> #${x.paciente.id} ${x.paciente.nombre} ${x.paciente.apellidos || ''} (por ${x.via})`))
    );
  }
  if (resultado.dudosos.length) {
    console.log('\n== DUDOSOS (no se aplican solos) ==');
    resultado.dudosos.forEach((x) =>
      console.log(linea(x, ` -> ¿#${x.dudoso.id} ${x.dudoso.nombre} ${x.dudoso.apellidos || ''}? (por ${x.via})`))
    );
  }
  if (resultado.ambiguos.length) {
    console.log('\n== AMBIGUOS (varios candidatos) ==');
    resultado.ambiguos.forEach((x) =>
      console.log(linea(x, ` -> ${x.ambiguo.map((p) => `#${p.id}`).join(', ')} (por ${x.via})`))
    );
  }
  if (resultado.nuevos.length) {
    console.log('\n== SE CREARÍAN ==');
    resultado.nuevos.forEach((x) => {
      const { nombre, apellidos } = partirNombre(x.reg.nombre);
      const tel = x.reg.telefonos[0] || '(sin teléfono)';
      console.log(linea(x, ` -> nuevo: "${nombre}" / "${apellidos || ''}" · ${x.reg.correos[0] || 'sin correo'} · ${tel}`));
    });
  }

  if (!APLICAR) {
    console.log('\nNada se escribió. Revisa el reporte y vuelve a correr con --apply.');
    await conn.end();
    return;
  }

  // --- Aplicar -------------------------------------------------------------
  // Se importan los emparejados y los nuevos. Los dudosos y ambiguos se dejan
  // fuera a propósito: asociar la constancia fiscal de alguien al paciente
  // equivocado es peor que no importarla.
  const { guardarConstancia } = require('../services/fiscalDocs');

  let creados = 0;
  let subidos = 0;
  let fallidos = 0;

  const aImportar = [
    ...resultado.emparejados.map((x) => ({ reg: x.reg, patientId: x.paciente.id })),
    ...resultado.nuevos.map((x) => ({ reg: x.reg, patientId: null })),
  ];

  for (const item of aImportar) {
    let patientId = item.patientId;

    if (!patientId) {
      const { nombre, apellidos } = partirNombre(item.reg.nombre);
      // `telefono` es NOT NULL en el esquema; los que no traen teléfono entran
      // con cadena vacía y registro_incompleto = 1, igual que el alta rápida.
      const telefono = item.reg.telefonos[0] || '';
      const email = item.reg.correos[0] || null;

      const [r] = await conn.query(
        `INSERT INTO pacientes
           (nombre, apellidos, telefono, email, registro_incompleto, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, NOW(), NOW())`,
        [nombre, apellidos, telefono, email]
      );
      patientId = r.insertId;
      creados++;
      console.log(`  + paciente #${patientId} ${item.reg.nombre}`);
    }

    for (const abs of item.reg.archivos) {
      try {
        const buffer = fs.readFileSync(abs);
        await guardarConstancia({
          patientId,
          file: {
            buffer,
            size: buffer.length,
            originalname: path.basename(abs),
            mimetype: '',
          },
          origen: 'import',
        });
        subidos++;
      } catch (err) {
        fallidos++;
        console.warn(`  ! ${path.basename(abs)} (#${patientId}): ${err.message}`);
      }
    }
  }

  console.log(`\nHecho. Pacientes creados: ${creados} · archivos subidos: ${subidos} · fallidos: ${fallidos}`);
  await conn.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
