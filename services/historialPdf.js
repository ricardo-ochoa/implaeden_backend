// services/historialPdf.js
// ---------------------------------------------------------------------------
// PDF de TODO el historial clínico de un paciente en un solo archivo: los
// expedientes capturados en la app (`clinical_records`, formato FO-CD-00003)
// y los archivos escaneados (`clinical_histories`), intercalados por fecha.
//
// Antes "Descargar todo" solo bajaba los escaneados, así que el expediente
// digital —que es la nota clínica en sí— quedaba fuera del documento que se
// entrega o se archiva.
//
// Orden: cronológico ascendente, como se archiva el expediente en papel. Dentro
// de una misma fecha va primero el expediente digital (la nota) y luego sus
// escaneados (el soporte: estudios, consentimientos, radiografías).
//
// Los expedientes se generan con su propio servicio y sus páginas se COPIAN
// aquí con `copyPages`: así el formato y el odontograma se dibujan una sola vez
// y este módulo no tiene que saber cómo se pinta el FO-CD-00003.
// ---------------------------------------------------------------------------
const { PDFDocument, StandardFonts } = require('pdf-lib');

const { A4, escribirPortada, formatearFecha, soloFecha, hoyYMD } = require('./pdfComun');
const {
  agregarArchivosAlPdf,
  agregarPaginaOmitidos,
  escribirContenido,
} = require('./expedientePdf');
const { construirExpedienteClinicoPdf } = require('./expedienteClinicoPdf');

// Agrupa expedientes y archivos en una sola línea de tiempo por fecha.
const agruparPorFecha = (expedientes, registros) => {
  const dias = new Map();

  const dia = (fecha) => {
    if (!dias.has(fecha)) dias.set(fecha, { fecha, expedientes: [], archivos: [] });
    return dias.get(fecha);
  };

  expedientes.forEach((exp) => dia(soloFecha(exp.record_date)).expedientes.push(exp));
  registros.forEach((reg) => dia(soloFecha(reg.record_date)).archivos.push(reg));

  return [...dias.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
};

// Resumen de un día para el índice de la portada: "1 expediente · 3 archivos".
const detalleDelDia = ({ expedientes, archivos }) => {
  const partes = [];
  if (expedientes.length) {
    partes.push(`${expedientes.length} expediente${expedientes.length === 1 ? '' : 's'}`);
  }
  if (archivos.length) {
    partes.push(`${archivos.length} archivo${archivos.length === 1 ? '' : 's'}`);
  }
  return partes.join(' · ');
};

/**
 * @param {object} paciente    fila de `pacientes`
 * @param {Array}  expedientes filas de `clinical_records` con `form_data` ya
 *                             parseado, ordenadas por fecha ascendente
 * @param {Array}  registros   filas de `clinical_histories` ordenadas igual
 * @returns {Promise<{ buffer: Buffer, incluidos: number, omitidos: Array }>}
 */
async function construirHistorialPdf({ paciente, expedientes = [], registros = [] }) {
  const doc = await PDFDocument.create();
  const fuentes = {
    normal: await doc.embedFont(StandardFonts.Helvetica),
    negrita: await doc.embedFont(StandardFonts.HelveticaBold),
  };

  const nombrePaciente =
    `${paciente?.nombre || ''} ${paciente?.apellidos || ''}`.trim() || 'Paciente';

  const dias = agruparPorFecha(expedientes, registros);

  const omitidos = [];
  let incluidos = 0;
  let expedientesIncluidos = 0;

  for (const dia of dias) {
    for (const expediente of dia.expedientes) {
      try {
        // Sin portada: la del historial completo ya va al frente, y cada página
        // del expediente lleva su encabezado con paciente y fecha de consulta.
        const bytes = await construirExpedienteClinicoPdf({
          paciente,
          expediente,
          incluirPortada: false,
        });

        const origen = await PDFDocument.load(bytes);
        const paginas = await doc.copyPages(origen, origen.getPageIndices());
        paginas.forEach((p) => doc.addPage(p));

        expedientesIncluidos += 1;
        incluidos += 1;
      } catch (err) {
        // Un expediente con datos corruptos no debe tumbar la descarga entera:
        // se anota junto a los archivos omitidos y el resto sigue su curso.
        console.warn(`[historial-pdf] expediente ${expediente?.id} falló: ${err.message}`);
        omitidos.push({
          archivo: `Expediente clínico del ${formatearFecha(soloFecha(expediente?.record_date))}`,
          motivo: 'no se pudo generar',
        });
      }
    }

    if (dia.archivos.length) {
      const resultado = await agregarArchivosAlPdf(doc, fuentes, dia.archivos, { nombrePaciente });
      incluidos += resultado.incluidos;
      omitidos.push(...resultado.omitidos);
    }
  }

  agregarPaginaOmitidos(doc, fuentes, omitidos);

  const portada = doc.insertPage(0, [A4.ancho, A4.alto]);

  const y = await escribirPortada(doc, portada, fuentes, {
    titulo: 'Historial clínico',
    paciente: nombrePaciente,
    lineas: [
      'Expedientes capturados y archivos escaneados',
      `${dias.length} fecha(s) · ${expedientesIncluidos} expediente(s) · ${registros.length} archivo(s)`,
      `Generado el ${formatearFecha(hoyYMD())}`,
    ],
  });

  escribirContenido(
    portada,
    fuentes,
    y,
    dias.map((dia) => ({ fecha: dia.fecha, detalle: detalleDelDia(dia) }))
  );

  const buffer = Buffer.from(await doc.save());
  return { buffer, incluidos, omitidos };
}

module.exports = { construirHistorialPdf };
