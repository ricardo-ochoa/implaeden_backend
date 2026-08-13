// services/pdfComun.js
// ---------------------------------------------------------------------------
// Piezas compartidas por los PDF del expediente clínico (el de los escaneados
// y el del formato capturado en la app): portada con logo y aviso de
// confidencialidad, y utilidades de texto para pdf-lib.
//
// pdf-lib no acomoda texto solo: no corta líneas ni salta de página. Todo eso
// lo resuelven `partirEnLineas` y la clase `Lienzo`.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { StandardFonts, rgb, PDFName, PDFString } = require('pdf-lib');

const A4 = { ancho: 595.28, alto: 841.89 };
const MARGEN = 48;

const NEGRO = rgb(0.1, 0.1, 0.12);
const GRIS = rgb(0.42, 0.42, 0.45);
const GRIS_CLARO = rgb(0.85, 0.85, 0.88);
const AZUL = rgb(0.12, 0.36, 0.67);

const LOGO_PATH = path.resolve(__dirname, '..', 'assets', 'logo-implaeden.png');

// Texto del aviso que la clínica quiere en cada descarga. La NOM-004-SSA3-2012
// obliga a tratar el expediente como confidencial; el enlace apunta a la norma
// publicada en el DOF.
const AVISO_CONFIDENCIALIDAD = {
  titulo: 'Aviso de Confidencialidad y Uso del Expediente Clínico',
  cuerpo:
    'La información contenida en este expediente clínico es estrictamente confidencial y de uso ' +
    'exclusivo para los fines de diagnóstico, tratamiento y atención médica del paciente. Queda ' +
    'prohibida su reproducción total o parcial, transmisión o divulgación a terceros ajenos al ' +
    'equipo de salud sin la autorización expresa del titular o mandato judicial, en cumplimiento ' +
    'con la normatividad de salud y de protección de datos personales vigentes.',
  referencia: 'Referencia: DOF - Diario Oficial de la Federación (NOM-004-SSA3-2012)',
  url: 'https://dof.gob.mx/nota_detalle_popup.php?codigo=5272787',
};

// Helvetica se codifica en WinAnsi (Windows-1252): acepta acentos, ñ y los
// signos tipográficos del bloque 0x80-0x9F (— – " " ' ' … • €), pero no emoji
// ni alfabetos no latinos. Se limpia lo que pdf-lib no podría codificar.
//
// Ese segundo rango hay que listarlo aparte: en Unicode esos signos NO viven
// entre \xA0 y \xFF, así que un filtro por rangos Latin-1 se los comería —y el
// guion largo se usa en todo el documento como marca de "sin dato".
const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const NO_CODIFICABLE = new RegExp(`[^\\x20-\\x7E\\xA0-\\xFF${WINANSI_EXTRA}]`, 'g');

const sanitizar = (texto) => String(texto ?? '').replace(NO_CODIFICABLE, '');

const formatearFecha = (ymd) => {
  const [y, m, d] = String(ymd || '').split('-');
  return y && m && d ? `${d}/${m}/${y}` : String(ymd || '');
};

// "2026-08-13T06:00:00.000Z" | Date -> "2026-08-13"
const soloFecha = (valor) => {
  if (valor instanceof Date) return valor.toISOString().split('T')[0];
  return String(valor || '').split('T')[0];
};

const hoyYMD = () => new Date().toISOString().split('T')[0];

// Corta un texto en líneas que quepan en `ancho`. Las palabras más largas que
// el renglón se parten por carácter para que nada se salga de la caja.
function partirEnLineas(texto, fuente, tamano, ancho) {
  const limpio = sanitizar(texto).replace(/\s+/g, ' ').trim();
  if (!limpio) return [];

  const lineas = [];
  let actual = '';

  for (const palabra of limpio.split(' ')) {
    const tentativa = actual ? `${actual} ${palabra}` : palabra;

    if (fuente.widthOfTextAtSize(tentativa, tamano) <= ancho) {
      actual = tentativa;
      continue;
    }

    if (actual) lineas.push(actual);

    if (fuente.widthOfTextAtSize(palabra, tamano) <= ancho) {
      actual = palabra;
      continue;
    }

    let trozo = '';
    for (const caracter of palabra) {
      if (fuente.widthOfTextAtSize(trozo + caracter, tamano) > ancho) {
        lineas.push(trozo);
        trozo = caracter;
      } else {
        trozo += caracter;
      }
    }
    actual = trozo;
  }

  if (actual) lineas.push(actual);
  return lineas;
}

// Anotación de enlace: pdf-lib no tiene API de alto nivel para hipervínculos.
function agregarEnlace(doc, page, { x, y, ancho, alto, url }) {
  const anotacion = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [x, y, x + ancho, y + alto],
    Border: [0, 0, 0],
    A: doc.context.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(url) }),
  });

  const previas = page.node.get(PDFName.of('Annots'));
  if (previas) previas.push(anotacion);
  else page.node.set(PDFName.of('Annots'), doc.context.obj([anotacion]));
}

/**
 * Cursor de escritura sobre un PDF: lleva la posición vertical y abre página
 * nueva cuando lo que sigue ya no cabe.
 */
class Lienzo {
  constructor(doc, fuentes) {
    this.doc = doc;
    this.fuentes = fuentes;
    this.page = null;
    this.y = 0;
    this.encabezado = null;
    this.nuevaPagina();
  }

  get anchoUtil() {
    return A4.ancho - MARGEN * 2;
  }

  nuevaPagina() {
    this.page = this.doc.addPage([A4.ancho, A4.alto]);
    this.y = A4.alto - MARGEN;

    if (this.encabezado) {
      this.page.drawText(sanitizar(this.encabezado), {
        x: MARGEN,
        y: this.y,
        size: 8,
        font: this.fuentes.normal,
        color: GRIS,
      });
      this.page.drawLine({
        start: { x: MARGEN, y: this.y - 6 },
        end: { x: A4.ancho - MARGEN, y: this.y - 6 },
        thickness: 0.5,
        color: GRIS_CLARO,
      });
      this.y -= 24;
    }
  }

  // Abre página nueva si no quedan `alto` puntos libres.
  asegurarEspacio(alto) {
    if (this.y - alto < MARGEN) this.nuevaPagina();
  }

  espacio(alto) {
    this.y -= alto;
  }

  // Título de sección con línea inferior.
  titulo(texto, { tamano = 13 } = {}) {
    this.asegurarEspacio(tamano + 22);
    this.y -= tamano;
    this.page.drawText(sanitizar(texto), {
      x: MARGEN,
      y: this.y,
      size: tamano,
      font: this.fuentes.negrita,
      color: NEGRO,
    });
    this.y -= 6;
    this.page.drawLine({
      start: { x: MARGEN, y: this.y },
      end: { x: A4.ancho - MARGEN, y: this.y },
      thickness: 0.5,
      color: GRIS_CLARO,
    });
    this.y -= 12;
  }

  subtitulo(texto) {
    this.asegurarEspacio(24);
    this.y -= 11;
    this.page.drawText(sanitizar(texto), {
      x: MARGEN,
      y: this.y,
      size: 10,
      font: this.fuentes.negrita,
      color: NEGRO,
    });
    this.y -= 10;
  }

  // Párrafo con salto de línea automático (y de página si hace falta).
  parrafo(texto, { tamano = 9.5, color = NEGRO, negrita = false, sangria = 0, interlineado = 1.45 } = {}) {
    const fuente = negrita ? this.fuentes.negrita : this.fuentes.normal;
    const alto = tamano * interlineado;
    const lineas = partirEnLineas(texto, fuente, tamano, this.anchoUtil - sangria);

    for (const linea of lineas) {
      this.asegurarEspacio(alto);
      this.y -= alto;
      this.page.drawText(linea, {
        x: MARGEN + sangria,
        y: this.y,
        size: tamano,
        font: fuente,
        color,
      });
    }
  }

  /**
   * Renglón "Etiqueta: valor" con la etiqueta en columna fija. El valor se
   * ajusta al ancho restante y puede ocupar varias líneas.
   */
  campo(etiqueta, valor, { anchoEtiqueta = 150, tamano = 9.5 } = {}) {
    const texto = String(valor ?? '').trim();
    const mostrado = texto || '—';
    const alto = tamano * 1.45;

    const lineas = partirEnLineas(mostrado, this.fuentes.normal, tamano, this.anchoUtil - anchoEtiqueta);
    this.asegurarEspacio(alto * Math.max(1, lineas.length));

    const yInicial = this.y - alto;
    this.page.drawText(sanitizar(etiqueta), {
      x: MARGEN,
      y: yInicial,
      size: tamano,
      font: this.fuentes.negrita,
      color: NEGRO,
    });

    if (lineas.length === 0) lineas.push('—');

    lineas.forEach((linea, i) => {
      if (i > 0) this.asegurarEspacio(alto);
      this.y -= alto;
      this.page.drawText(linea, {
        x: MARGEN + anchoEtiqueta,
        y: this.y,
        size: tamano,
        font: this.fuentes.normal,
        color: texto ? NEGRO : GRIS,
      });
    });
  }

  /**
   * Tabla simple con encabezado y filas zebra.
   * @param {string[]} encabezados
   * @param {string[][]} filas
   * @param {number[]} anchos proporciones que suman <= anchoUtil
   */
  tabla(encabezados, filas, anchos, { tamano = 8.5 } = {}) {
    const altoFila = 16;

    const dibujarEncabezados = () => {
      this.asegurarEspacio(altoFila * 2);
      this.y -= altoFila;
      this.page.drawRectangle({
        x: MARGEN,
        y: this.y - 4,
        width: this.anchoUtil,
        height: altoFila,
        color: rgb(0.95, 0.95, 0.97),
      });
      let x = MARGEN + 4;
      encabezados.forEach((titulo, i) => {
        this.page.drawText(sanitizar(titulo), {
          x,
          y: this.y,
          size: tamano,
          font: this.fuentes.negrita,
          color: NEGRO,
        });
        x += anchos[i];
      });
      this.y -= 6;
    };

    dibujarEncabezados();

    filas.forEach((fila, indice) => {
      // Una celda puede necesitar varias líneas: la fila crece con la más alta.
      const celdas = fila.map((valor, i) =>
        partirEnLineas(String(valor ?? '') || '—', this.fuentes.normal, tamano, anchos[i] - 8)
      );
      const lineasMax = Math.max(1, ...celdas.map((c) => c.length));
      const altoReal = Math.max(altoFila, lineasMax * (tamano * 1.35) + 6);

      if (this.y - altoReal < MARGEN) {
        this.nuevaPagina();
        dibujarEncabezados();
      }

      this.y -= altoReal;

      if (indice % 2 === 1) {
        this.page.drawRectangle({
          x: MARGEN,
          y: this.y - 2,
          width: this.anchoUtil,
          height: altoReal,
          color: rgb(0.975, 0.975, 0.985),
        });
      }

      let x = MARGEN + 4;
      celdas.forEach((lineas, i) => {
        lineas.forEach((linea, j) => {
          this.page.drawText(linea, {
            x,
            y: this.y + altoReal - (tamano * 1.35) * (j + 1) - 2,
            size: tamano,
            font: this.fuentes.normal,
            color: NEGRO,
          });
        });
        x += anchos[i];
      });
    });

    this.y -= 6;
  }
}

async function cargarFuentes(doc) {
  return {
    normal: await doc.embedFont(StandardFonts.Helvetica),
    negrita: await doc.embedFont(StandardFonts.HelveticaBold),
    cursiva: await doc.embedFont(StandardFonts.HelveticaOblique),
  };
}

/**
 * Portada completa (async porque embedPng lo es).
 * @returns {Promise<void>}
 */
async function escribirPortada(doc, page, fuentes, { titulo, paciente, lineas = [] }) {
  let y = A4.alto - MARGEN;

  try {
    const logo = await doc.embedPng(fs.readFileSync(LOGO_PATH));
    const ancho = 155;
    const alto = (logo.height / logo.width) * ancho;
    y -= alto;
    page.drawImage(logo, { x: MARGEN, y, width: ancho, height: alto });
    y -= 30;
  } catch (err) {
    console.warn(`[pdf] no se pudo incrustar el logo: ${err.message}`);
    y -= 14;
    page.drawText('IMPLAEDÉN', { x: MARGEN, y, size: 12, font: fuentes.negrita, color: GRIS });
    y -= 26;
  }

  y -= 24;
  page.drawText(sanitizar(titulo), {
    x: MARGEN,
    y,
    size: 24,
    font: fuentes.negrita,
    color: NEGRO,
  });

  y -= 26;
  page.drawText(sanitizar(paciente), {
    x: MARGEN,
    y,
    size: 14,
    font: fuentes.normal,
    color: NEGRO,
  });

  y -= 20;
  lineas.forEach((linea) => {
    page.drawText(sanitizar(linea), { x: MARGEN, y, size: 9.5, font: fuentes.normal, color: GRIS });
    y -= 14;
  });

  // --- Aviso de confidencialidad, anclado al pie de la portada ---
  const anchoUtil = A4.ancho - MARGEN * 2;
  const cuerpo = partirEnLineas(AVISO_CONFIDENCIALIDAD.cuerpo, fuentes.normal, 8.5, anchoUtil - 24);
  const altoCaja = 30 + 14 + cuerpo.length * 11.5 + 26;

  const yCaja = MARGEN + 10;
  page.drawRectangle({
    x: MARGEN,
    y: yCaja,
    width: anchoUtil,
    height: altoCaja,
    color: rgb(0.97, 0.97, 0.98),
    borderColor: GRIS_CLARO,
    borderWidth: 0.5,
  });

  let yAviso = yCaja + altoCaja - 20;
  page.drawText(sanitizar(AVISO_CONFIDENCIALIDAD.titulo), {
    x: MARGEN + 12,
    y: yAviso,
    size: 9.5,
    font: fuentes.negrita,
    color: NEGRO,
  });

  yAviso -= 15;
  cuerpo.forEach((linea) => {
    page.drawText(linea, { x: MARGEN + 12, y: yAviso, size: 8.5, font: fuentes.normal, color: NEGRO });
    yAviso -= 11.5;
  });

  yAviso -= 6;
  page.drawText(sanitizar(AVISO_CONFIDENCIALIDAD.referencia), {
    x: MARGEN + 12,
    y: yAviso,
    size: 8,
    font: fuentes.normal,
    color: GRIS,
  });

  yAviso -= 11;
  const url = AVISO_CONFIDENCIALIDAD.url;
  const anchoUrl = fuentes.normal.widthOfTextAtSize(url, 8);
  page.drawText(url, { x: MARGEN + 12, y: yAviso, size: 8, font: fuentes.normal, color: AZUL });
  page.drawLine({
    start: { x: MARGEN + 12, y: yAviso - 1.5 },
    end: { x: MARGEN + 12 + anchoUrl, y: yAviso - 1.5 },
    thickness: 0.4,
    color: AZUL,
  });
  agregarEnlace(doc, page, { x: MARGEN + 12, y: yAviso - 3, ancho: anchoUrl, alto: 11, url });

  return y;
}

module.exports = {
  A4,
  MARGEN,
  NEGRO,
  GRIS,
  GRIS_CLARO,
  AZUL,
  AVISO_CONFIDENCIALIDAD,
  Lienzo,
  cargarFuentes,
  escribirPortada,
  partirEnLineas,
  agregarEnlace,
  sanitizar,
  formatearFecha,
  soloFecha,
  hoyYMD,
};
