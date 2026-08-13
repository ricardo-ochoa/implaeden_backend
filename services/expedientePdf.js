// services/expedientePdf.js
// ---------------------------------------------------------------------------
// Arma un PDF con los archivos escaneados del historial clínico de un paciente
// (tabla `clinical_histories`).
//
// Se genera en el servidor, no en el navegador, por dos razones:
//   - los archivos viven en S3/MinIO y leerlos desde el browser exigiría CORS
//     en el bucket (mostrarlos en un <img> no lo necesita, leer sus bytes sí);
//   - los registros mezclan imágenes con PDF ya subidos, y pdf-lib sabe
//     *copiar* las páginas de esos PDF en vez de rasterizarlas.
//
// Lo que no se puede meter en un PDF (videos, formatos raros) o lo que no se
// pudo descargar no rompe la exportación: se omite y se lista al final.
// ---------------------------------------------------------------------------
const axios = require('axios');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { s3, S3_BUCKET } = require('../config/s3');
const {
  A4,
  MARGEN,
  NEGRO,
  GRIS,
  escribirPortada,
  sanitizar,
  formatearFecha,
  soloFecha,
} = require('./pdfComun');

const ALTO_ENCABEZADO = 28;

// Reconstruye la key del bucket a partir de la URL pública guardada en la BD.
// Cubre las tres formas que hay en los datos: S3 virtual-host
// (bucket.s3.region.amazonaws.com/key), y path-style con el bucket dentro de
// la ruta (files.implaeden.com/implaeden/key y MinIO 192.168.x.x:9000/...).
const keyDesdeUrl = (url) => {
  try {
    const { pathname } = new URL(url);
    const partes = pathname.replace(/^\/+/, '').split('/');
    if (partes[0] === S3_BUCKET) partes.shift();
    return partes.map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
};

// Primero por S3/MinIO (funciona aunque el bucket sea privado); si el objeto no
// está ahí —p. ej. registros viejos que apuntan al bucket de AWS anterior— se
// intenta por HTTP con la URL tal cual.
const descargarArchivo = async (url) => {
  const key = keyDesdeUrl(url);

  if (key) {
    try {
      const obj = await s3.getObject({ Bucket: S3_BUCKET, Key: key }).promise();
      return Buffer.from(obj.Body);
    } catch (err) {
      console.warn(`[expediente-pdf] S3 falló para ${key}: ${err.message}`);
    }
  }

  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
  return Buffer.from(res.data);
};

// El tipo se deduce de los bytes, no de la extensión: muchos archivos se
// guardaron con nombre "..._blob", sin extensión.
const tipoDeArchivo = (buf) => {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.toString('ascii', 0, 4) === '%PDF') return 'pdf';
  return null;
};

const nombreArchivo = (url) => decodeURIComponent(String(url || '').split('/').pop() || 'archivo');

/**
 * @param {object} paciente  fila de `pacientes`
 * @param {Array}  registros filas de `clinical_histories` ya ordenadas
 * @param {string} [fechaUnica] si se exporta un solo registro, su fecha
 * @returns {Promise<{ buffer: Buffer, incluidos: number, omitidos: Array }>}
 */
async function construirExpedientePdf({ paciente, registros, fechaUnica }) {
  const doc = await PDFDocument.create();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const nombrePaciente =
    `${paciente?.nombre || ''} ${paciente?.apellidos || ''}`.trim() || 'Paciente';

  const omitidos = [];
  let incluidos = 0;

  // Cuántos archivos tiene cada fecha, para numerar "archivo 2 de 5".
  const totalPorFecha = registros.reduce((acc, r) => {
    const f = soloFecha(r.record_date);
    acc[f] = (acc[f] || 0) + 1;
    return acc;
  }, {});
  const indicePorFecha = {};

  for (const registro of registros) {
    const fecha = soloFecha(registro.record_date);
    indicePorFecha[fecha] = (indicePorFecha[fecha] || 0) + 1;

    const etiqueta = `${nombreArchivo(registro.file_url)} (${formatearFecha(fecha)})`;

    let bytes;
    try {
      bytes = await descargarArchivo(registro.file_url);
    } catch (err) {
      console.warn(`[expediente-pdf] no se pudo descargar ${registro.file_url}: ${err.message}`);
      omitidos.push({ archivo: etiqueta, motivo: 'no se pudo descargar' });
      continue;
    }

    const tipo = tipoDeArchivo(bytes);

    if (tipo === 'pdf') {
      // Las páginas del PDF original se copian tal cual: no se re-comprimen ni
      // pierden texto seleccionable.
      try {
        const origen = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const paginas = await doc.copyPages(origen, origen.getPageIndices());
        paginas.forEach((p) => doc.addPage(p));
        incluidos += 1;
      } catch (err) {
        console.warn(`[expediente-pdf] PDF ilegible ${registro.file_url}: ${err.message}`);
        omitidos.push({ archivo: etiqueta, motivo: 'PDF ilegible' });
      }
      continue;
    }

    if (tipo !== 'jpg' && tipo !== 'png') {
      // Videos y formatos que un PDF no admite (webp, heic, ...).
      omitidos.push({ archivo: etiqueta, motivo: 'formato no admitido en PDF' });
      continue;
    }

    try {
      const imagen = tipo === 'jpg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);

      // Orientación según la forma del original: los escaneos verticales
      // aprovechan la hoja vertical y las fotos apaisadas la horizontal.
      const apaisada = imagen.width > imagen.height;
      const anchoPagina = apaisada ? A4.alto : A4.ancho;
      const altoPagina = apaisada ? A4.ancho : A4.alto;

      const page = doc.addPage([anchoPagina, altoPagina]);

      const y = altoPagina - MARGEN;
      page.drawText(sanitizar(`${nombrePaciente} · Expediente clínico`), {
        x: MARGEN,
        y,
        size: 9,
        font: helvetica,
        color: NEGRO,
      });
      const derecha = sanitizar(
        `${formatearFecha(fecha)} · archivo ${indicePorFecha[fecha]} de ${totalPorFecha[fecha]}`
      );
      const anchoDerecha = helvetica.widthOfTextAtSize(derecha, 9);
      page.drawText(derecha, {
        x: anchoPagina - MARGEN - anchoDerecha,
        y,
        size: 9,
        font: helvetica,
        color: GRIS,
      });
      page.drawLine({
        start: { x: MARGEN, y: y - 6 },
        end: { x: anchoPagina - MARGEN, y: y - 6 },
        thickness: 0.5,
        color: rgb(0.85, 0.85, 0.88),
      });

      const maxAncho = anchoPagina - MARGEN * 2;
      const maxAlto = altoPagina - MARGEN * 2 - ALTO_ENCABEZADO;
      const escala = Math.min(maxAncho / imagen.width, maxAlto / imagen.height);
      const ancho = imagen.width * escala;
      const alto = imagen.height * escala;

      page.drawImage(imagen, {
        x: (anchoPagina - ancho) / 2,
        y: (altoPagina - ALTO_ENCABEZADO - MARGEN * 2 - alto) / 2 + MARGEN,
        width: ancho,
        height: alto,
      });

      incluidos += 1;
    } catch (err) {
      console.warn(`[expediente-pdf] imagen ilegible ${registro.file_url}: ${err.message}`);
      omitidos.push({ archivo: etiqueta, motivo: 'imagen ilegible' });
    }
  }

  // Los omitidos se conocen hasta el final, así que esta página va al cierre.
  if (omitidos.length) {
    const page = doc.addPage([A4.ancho, A4.alto]);
    let y = A4.alto - MARGEN - 12;

    page.drawText('Archivos omitidos', { x: MARGEN, y, size: 14, font: helveticaBold, color: NEGRO });
    y -= 18;
    page.drawText('No se pudieron incluir en este PDF:', {
      x: MARGEN,
      y,
      size: 9,
      font: helvetica,
      color: GRIS,
    });
    y -= 20;

    omitidos.forEach((o) => {
      if (y < MARGEN) return;
      page.drawText(sanitizar(`- ${o.archivo}: ${o.motivo}`), {
        x: MARGEN,
        y,
        size: 9,
        font: helvetica,
        color: NEGRO,
      });
      y -= 14;
    });
  }

  // Portada al frente (insertPage la coloca en el índice 0).
  const portada = doc.insertPage(0, [A4.ancho, A4.alto]);
  let y = A4.alto - MARGEN - 24;

  // Portada compartida con el PDF del expediente digital: logo + aviso de
  // confidencialidad. Devuelve la y por debajo de las líneas de cabecera.
  const fechas = Object.keys(totalPorFecha).sort();

  y = await escribirPortada(doc, portada, { normal: helvetica, negrita: helveticaBold }, {
    titulo: 'Expediente clínico',
    paciente: nombrePaciente,
    lineas: [
      'Archivos escaneados del expediente',
      fechaUnica
        ? `Registro del ${formatearFecha(fechaUnica)}`
        : `${fechas.length} registro(s) · ${registros.length} archivo(s)`,
      `Generado el ${formatearFecha(new Date().toISOString().split('T')[0])}`,
    ],
  });

  // Índice de fechas cuando se exporta todo el historial. Se corta si topa con
  // la caja del aviso de confidencialidad, que vive al pie de la portada.
  if (!fechaUnica) {
    y -= 22;
    portada.drawText('Contenido', { x: MARGEN, y, size: 12, font: helveticaBold, color: NEGRO });
    y -= 18;

    const yMinimo = MARGEN + 190; // por encima del recuadro del aviso
    const cabenTodas = fechas.length;
    let dibujadas = 0;

    for (const fecha of fechas) {
      if (y < yMinimo) {
        portada.drawText(
          sanitizar(`(+${cabenTodas - dibujadas} registro(s) más)`),
          { x: MARGEN, y, size: 9, font: helvetica, color: GRIS }
        );
        break;
      }
      const total = totalPorFecha[fecha];
      portada.drawText(
        sanitizar(`${formatearFecha(fecha)} · ${total} archivo${total === 1 ? '' : 's'}`),
        { x: MARGEN, y, size: 10, font: helvetica, color: NEGRO }
      );
      y -= 15;
      dibujadas += 1;
    }
  }

  const buffer = Buffer.from(await doc.save());
  return { buffer, incluidos, omitidos };
}

module.exports = { construirExpedientePdf, formatearFecha, soloFecha };
