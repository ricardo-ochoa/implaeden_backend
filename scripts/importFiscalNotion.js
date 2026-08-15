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
// Hoja de revisión: --out la escribe, --from-csv la lee para aplicar solo lo aprobado.
const SALIDA = flag('out');
const DESDE_CSV = flag('from-csv');

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

/**
 * Resuelve una ruta relativa del CSV contra el disco, tolerando la diferencia
 * de normalización Unicode.
 *
 * macOS guarda los nombres de archivo en NFD ("Jiménez" = e + acento) y Linux
 * en NFC (é como un solo carácter). El CSV de Notion viene en NFC. En la Mac no
 * se nota porque el sistema de archivos normaliza al buscar; tras copiar al NAS,
 * `existsSync` falla en todo lo que lleve acento aunque el archivo esté ahí.
 *
 * Por eso se camina segmento por segmento: si el nombre exacto no está, se
 * busca en el directorio una entrada cuya forma NFC coincida.
 *
 * @returns {string|null} ruta real en disco, o null si de verdad no existe
 */
function resolverRuta(base, relativo) {
  let actual = base;

  for (const segmento of relativo.split('/').filter(Boolean)) {
    const directo = path.join(actual, segmento);
    if (fs.existsSync(directo)) {
      actual = directo;
      continue;
    }

    let entradas;
    try {
      entradas = fs.readdirSync(actual);
    } catch {
      return null;
    }

    const buscado = segmento.normalize('NFC');
    let encontrado = entradas.find((e) => e.normalize('NFC') === buscado);

    // Segundo intento, sin distinguir mayúsculas: Notion generó carpetas que
    // solo difieren en capitalización ("ADRIANA CRUZ DE LA CRUZ" vs "Adriana
    // Cruz De la Cruz"). APFS las colapsa en una sola y Linux no las encuentra.
    if (!encontrado) {
      const buscadoMin = buscado.toLowerCase();
      encontrado = entradas.find((e) => e.normalize('NFC').toLowerCase() === buscadoMin);
    }

    if (!encontrado) return null;

    actual = path.join(actual, encontrado);
  }

  return actual;
}

// Palabras que no distinguen a nadie al comparar nombres.
const PARTICULAS_NOMBRE = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'san', 'santa', 'da', 'do']);

// Devuelve palabras ÚNICAS. Deduplicar es imprescindible: hay pacientes con el
// apellido repetido ("ROCIO DEL CARMEN JIMENEZ JIMENEZ") y sin esto cualquier
// persona apellidada Jiménez sacaba 2 coincidencias con un solo apellido en
// común, arrastrando a media lista hacia el mismo expediente.
const tokensNombre = (s) => [
  ...new Set(
    norm(s)
      .split(' ')
      .filter((w) => w.length >= 3 && !PARTICULAS_NOMBRE.has(w))
  ),
];

/**
 * ¿Dos nombres pueden ser de la misma persona?
 *
 * Existe porque emparejar SOLO por correo o teléfono produjo falsos positivos
 * reales en producción ("FIDEL TORRUCO MAY" -> "ADDY GOMEZ REAL" por correo;
 * "Hugo Arturo Arellano Pérez" -> "Paulina Carrillo Sanchez" por teléfono):
 * parejas y familiares comparten contacto, o alguien pagó por otro. Colgar la
 * constancia fiscal de una persona en el expediente de otra es de lo peor que
 * podría hacer este script, así que el contacto ya no basta por sí solo.
 */
function nombresCompatibles(a, b) {
  const ta = new Set(tokensNombre(a));
  const tb = tokensNombre(b);
  if (ta.size === 0 || tb.length === 0) return false;

  const comunes = tb.filter((w) => ta.has(w)).length;
  return comunes >= Math.min(2, ta.size, tb.length);
}

// Cuántos tokens comparten, para ordenar candidatos dudosos.
const tokensEnComun = (a, b) => {
  const ta = new Set(tokensNombre(a));
  return tokensNombre(b).filter((w) => ta.has(w)).length;
};

// ---------------------------------------------------------------------------
// Lectura del export
// ---------------------------------------------------------------------------
function leerExport(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(
      `No existe la carpeta del export:\n    ${dir}\n\n` +
        `  Cópiala al servidor y pásala con --dir (ruta relativa o absoluta).\n` +
        `  Debe contener el CSV "*_all.csv" y la carpeta "Facturas Pacientes".`
    );
  }

  if (!fs.statSync(dir).isDirectory()) {
    throw new Error(`--dir debe apuntar a una carpeta, no a un archivo:\n    ${dir}`);
  }

  const csvPath = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('_all.csv'))
    .map((f) => path.join(dir, f))[0];

  if (!csvPath) {
    throw new Error(
      `No se encontró ningún "*_all.csv" en:\n    ${dir}\n\n` +
        `  Contenido: ${fs.readdirSync(dir).slice(0, 8).join(', ') || '(vacía)'}`
    );
  }

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
      const abs = resolverRuta(dir, rel);
      if (abs) actual.archivos.add(abs);
      else actual.archivos.add(`__FALTA__${path.join(dir, rel)}`);
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
  const nombreCompleto = (p) => `${p.nombre} ${p.apellidos || ''}`;

  // 1) nombre completo normalizado: la única señal que se acepta sola.
  const clave = norm(registro.nombre);
  const exactos = pacientes.filter((p) => norm(nombreCompleto(p)) === clave);
  if (exactos.length === 1) return { paciente: exactos[0], via: 'nombre' };
  if (exactos.length > 1) return { ambiguo: exactos, via: 'nombre' };

  // 2) correo, pero SOLO si el nombre corrobora. Sin esa condición se producen
  // falsos positivos entre familiares que comparten cuenta.
  for (const correo of registro.correos) {
    if (correosCompartidos.has(correo)) continue;
    const porCorreo = pacientes.filter((p) => normalizarCorreo(p.email) === correo);
    if (porCorreo.length === 0) continue;

    const compatibles = porCorreo.filter((p) => nombresCompatibles(registro.nombre, nombreCompleto(p)));
    if (compatibles.length === 1) return { paciente: compatibles[0], via: 'correo + nombre' };
    if (compatibles.length > 1) return { ambiguo: compatibles, via: 'correo + nombre' };

    // Correo igual pero nombre distinto: casi siempre es otra persona del mismo
    // hogar. Se manda a revisión, nunca se aplica solo.
    return { dudoso: porCorreo[0], via: 'correo, pero el nombre NO coincide' };
  }

  // 3) teléfono, con la misma exigencia de corroboración.
  for (const tel of registro.telefonos) {
    if (tel.length < 10) continue;
    const porTel = pacientes.filter((p) => soloDigitos(p.telefono).endsWith(tel.slice(-10)));
    if (porTel.length === 0) continue;

    const compatibles = porTel.filter((p) => nombresCompatibles(registro.nombre, nombreCompleto(p)));
    if (compatibles.length === 1) return { paciente: compatibles[0], via: 'teléfono + nombre' };
    if (compatibles.length > 1) return { ambiguo: compatibles, via: 'teléfono + nombre' };

    return { dudoso: porTel[0], via: 'teléfono, pero el nombre NO coincide' };
  }

  // 4) parecido de nombre: nunca se aplica solo, pero evita crear duplicados de
  // pacientes que ya existen escritos distinto. Se ofrece el mejor candidato.
  const candidatos = pacientes
    .map((p) => ({ p, puntos: tokensEnComun(registro.nombre, nombreCompleto(p)) }))
    .filter((c) => c.puntos >= 2)
    .sort((a, b) => b.puntos - a.puntos);

  if (candidatos.length === 1) {
    return { dudoso: candidatos[0].p, via: `nombre parecido (${candidatos[0].puntos} palabras)` };
  }
  if (candidatos.length > 1) {
    return {
      ambiguo: candidatos.slice(0, 4).map((c) => c.p),
      via: `nombre parecido (${candidatos[0].puntos} palabras el mejor)`,
    };
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
      console.log(
        linea(
          x,
          ` -> ${x.ambiguo.map((p) => `#${p.id} ${p.nombre} ${p.apellidos || ''}`.trim()).join('  |  ')} (por ${x.via})`
        )
      )
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

  // --- Hoja de revisión ----------------------------------------------------
  // 52 personas no se validan leyendo la terminal. Con --out se escribe un CSV
  // con la decisión ya sugerida para revisarlo en Excel; luego se aplica
  // exactamente lo aprobado con --from-csv.
  if (SALIDA) {
    const filas = [
      ['nombre_export', 'archivos', 'correo', 'telefono', 'decision', 'paciente_id', 'paciente_sugerido', 'via', 'nombre_nuevo', 'apellidos_nuevos'],
    ];

    const agregar = (reg, decision, paciente, via) => {
      const { nombre, apellidos } = partirNombre(reg.nombre);
      filas.push([
        reg.nombre,
        reg.archivos.length,
        reg.correos[0] || '',
        reg.telefonos[0] || '',
        decision,
        paciente ? paciente.id : '',
        paciente ? `${paciente.nombre} ${paciente.apellidos || ''}`.trim() : '',
        via || '',
        decision === 'crear' ? nombre : '',
        decision === 'crear' ? apellidos || '' : '',
      ]);
    };

    resultado.emparejados.forEach((x) => agregar(x.reg, 'asociar', x.paciente, x.via));
    // Dudosos y ambiguos entran como 'revisar': no se aplican hasta que
    // alguien escriba a mano 'asociar' + el id correcto, o 'crear'.
    resultado.dudosos.forEach((x) => agregar(x.reg, 'revisar', x.dudoso, x.via));
    // Para los ambiguos se listan los candidatos CON NOMBRE: solo con los ids
    // habría que ir a buscarlos uno por uno a la base para poder decidir.
    resultado.ambiguos.forEach((x) =>
      agregar(
        x.reg,
        'revisar',
        null,
        `${x.via}: ${x.ambiguo.map((p) => `#${p.id} ${p.nombre} ${p.apellidos || ''}`.trim()).join(' | ')}`
      )
    );
    resultado.nuevos.forEach((x) => agregar(x.reg, 'crear', null, ''));

    const escapar = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    // BOM para que Excel abra los acentos bien.
    fs.writeFileSync(SALIDA, '﻿' + filas.map((f) => f.map(escapar).join(',')).join('\n'), 'utf8');
    console.log(`\nHoja de revisión escrita en: ${SALIDA}`);
    console.log('  Columna "decision": asociar | crear | omitir | revisar');
    console.log('  Para los "revisar", pon asociar + el paciente_id correcto, o crear.');
    console.log(`  Después: node scripts/importFiscalNotion.js --dir "${path.relative(process.cwd(), DIR)}" --from-csv "${SALIDA}" --apply`);
  }

  if (!APLICAR) {
    console.log('\nNada se escribió en la base ni en el bucket.');
    if (!SALIDA) console.log('Tip: agrega --out revision.csv para validar los pacientes en Excel.');
    await conn.end();
    return;
  }

  // --- Aplicar -------------------------------------------------------------
  const { guardarConstancia } = require('../services/fiscalDocs');

  let creados = 0;
  let subidos = 0;
  let fallidos = 0;
  let omitidos = 0;
  let repetidos = 0;

  let aImportar;

  if (DESDE_CSV) {
    // Manda la hoja revisada: solo se hace lo que quedó aprobado ahí.
    const revisadas = parseCSV(fs.readFileSync(DESDE_CSV, 'utf8').replace(/^﻿/, ''));
    const cab = revisadas[0].map((h) => h.trim());
    const col = (n) => cab.indexOf(n);
    const porNombre = new Map(registros.map((r) => [norm(r.nombre), r]));

    aImportar = [];

    for (const fila of revisadas.slice(1)) {
      if (!fila || fila.length < 2) continue;

      const reg = porNombre.get(norm(fila[col('nombre_export')]));
      if (!reg) continue;

      const decision = String(fila[col('decision')] || '').trim().toLowerCase();
      const pid = Number(fila[col('paciente_id')]) || null;

      if (decision === 'asociar' && pid) {
        aImportar.push({ reg, patientId: pid });
      } else if (decision === 'crear') {
        aImportar.push({
          reg,
          patientId: null,
          nombre: (fila[col('nombre_nuevo')] || '').trim() || null,
          apellidos: (fila[col('apellidos_nuevos')] || '').trim() || null,
        });
      } else {
        omitidos++;
      }
    }

    console.log(`\nSegún la hoja revisada: ${aImportar.length} a importar, ${omitidos} omitidos.`);
  } else {
    // Sin hoja: solo lo inequívoco. Dudosos y ambiguos se quedan fuera a
    // propósito: colgar la constancia de alguien en el expediente equivocado
    // es peor que no importarla.
    aImportar = [
      ...resultado.emparejados.map((x) => ({ reg: x.reg, patientId: x.paciente.id })),
      ...resultado.nuevos.map((x) => ({ reg: x.reg, patientId: null })),
    ];
    omitidos = resultado.dudosos.length + resultado.ambiguos.length;
  }

  for (const item of aImportar) {
    let patientId = item.patientId;

    if (!patientId) {
      // La hoja revisada puede traer el nombre corregido a mano; si no, se usa
      // la partición heurística.
      const heuristico = partirNombre(item.reg.nombre);
      const nombre = item.nombre || heuristico.nombre;
      const apellidos = item.apellidos ?? heuristico.apellidos;
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

        // Idempotencia: la key en el bucket lleva timestamp + aleatorio, así que
        // el UNIQUE de file_key no protege de re-correr el import (crearía
        // duplicados de los 110 archivos). Se compara por nombre y tamaño
        // dentro de lo ya migrado para ese paciente. Importa porque la revisión
        // se hace en pasadas: primero lo claro, luego lo dudoso.
        const [yaEsta] = await conn.query(
          `SELECT id FROM patient_fiscal_documents
           WHERE patient_id = ? AND origen = 'import' AND file_name = ? AND size_bytes = ?
           LIMIT 1`,
          [patientId, path.basename(abs), buffer.length]
        );

        if (yaEsta.length) {
          repetidos++;
          continue;
        }

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

  console.log(`\nHecho. Pacientes creados: ${creados} · archivos subidos: ${subidos} · ya estaban: ${repetidos} · fallidos: ${fallidos} · omitidos: ${omitidos}`);

  await conn.end();
  // services/fiscalDocs usa el pool de config/db, que mantiene vivo el event
  // loop: sin cerrarlo el script termina el trabajo pero nunca sale, y parece
  // colgado (con el riesgo de que alguien lo corte a media importación).
  await require('../config/db').end();
})().catch((e) => {
  // Los errores esperables (carpeta que no está, CSV que falta, base que no
  // responde) se explican en una línea; el stack completo solo estorba.
  console.error(`\n✖ ${e.message}`);
  if (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' || e.code === 'ENOTFOUND') {
    console.error(
      `\n  No se pudo conectar a la base en ${cfg.host}:${cfg.port}.\n` +
        `  Si corres esto EN el NAS, usa DB_HOST=127.0.0.1 (la IP externa cambia con DHCP).\n` +
        `  Si lo corres DENTRO del contenedor del backend, no pases DB_* : ya vienen del compose.`
    );
  }
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
