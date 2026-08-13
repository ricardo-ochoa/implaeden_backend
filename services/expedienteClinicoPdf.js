// services/expedienteClinicoPdf.js
// ---------------------------------------------------------------------------
// PDF del expediente capturado en la app (tabla `clinical_records`): imprime
// el formato FO-CD-00003 sección por sección, en el mismo orden del wizard,
// incluido el odontograma dibujado como vectores.
//
// Complementa a expedientePdf.js, que exporta los archivos escaneados.
// ---------------------------------------------------------------------------
const { PDFDocument, rgb } = require('pdf-lib');

const {
  A4,
  MARGEN,
  NEGRO,
  GRIS,
  GRIS_CLARO,
  Lienzo,
  cargarFuentes,
  escribirPortada,
  sanitizar,
  formatearFecha,
  soloFecha,
  hoyYMD,
} = require('./pdfComun');

const {
  ANTECEDENTES_HEREDOFAMILIARES,
  ANTECEDENTES_PATOLOGICOS,
  APARATOS_Y_SISTEMAS,
  SIGNOS_VITALES,
  EXPLORACION_CAMPOS,
  ESTADOS_DIENTE,
  ESTADO_DIENTE_POR_ID,
  CUADRANTES_FDI,
} = require('./expedienteCatalogos');

// El wizard guarda tri-estado: true / false / null (sin responder).
const siNo = (valor) => (valor === true ? 'Sí' : valor === false ? 'No' : 'Sin responder');

const texto = (valor) => {
  const limpio = String(valor ?? '').trim();
  return limpio || '';
};

// Dibuja las 32 piezas FDI. Devuelve el alto ocupado.
function dibujarOdontograma(lienzo, odontograma, titulo) {
  const dientes = odontograma?.dientes || {};

  const ANCHO_PIEZA = 22;
  const ALTO_PIEZA = 26;
  const SEPARACION_CUADRANTES = 14;
  const ALTO_NUMERO = 10;
  const ALTO_ARCADA = ALTO_PIEZA + ALTO_NUMERO + 4;

  // Alto total: dos arcadas + separador + leyenda (dos columnas de 5).
  const ALTO_LEYENDA = 5 * 12 + 8;
  lienzo.asegurarEspacio(ALTO_ARCADA * 2 + 16 + ALTO_LEYENDA + 24);

  lienzo.subtitulo(titulo);
  lienzo.espacio(4);

  const anchoFila = ANCHO_PIEZA * 16 + SEPARACION_CUADRANTES;
  const xInicio = MARGEN + (lienzo.anchoUtil - anchoFila) / 2;

  const dibujarArcada = (izquierda, derecha, yTope, numeroArriba) => {
    const piezas = [...izquierda, null, ...derecha]; // null = hueco central

    let x = xInicio;
    piezas.forEach((fdi) => {
      if (fdi === null) {
        x += SEPARACION_CUADRANTES;
        return;
      }

      const estadoId = dientes[fdi]?.estado || 'sano';
      const estado = ESTADO_DIENTE_POR_ID[estadoId] || ESTADO_DIENTE_POR_ID.sano;

      const yPieza = numeroArriba ? yTope - ALTO_NUMERO - ALTO_PIEZA : yTope - ALTO_PIEZA;

      lienzo.page.drawRectangle({
        x: x + 2,
        y: yPieza,
        width: ANCHO_PIEZA - 4,
        height: ALTO_PIEZA,
        color: rgb(...estado.rgb),
        borderColor: estadoId === 'sano' ? GRIS_CLARO : rgb(...estado.rgb.map((c) => c * 0.8)),
        borderWidth: 0.8,
      });

      // Las piezas ausentes se cruzan, como en el diagrama de la app.
      if (estadoId === 'ausente') {
        const blanco = rgb(1, 1, 1);
        lienzo.page.drawLine({
          start: { x: x + 5, y: yPieza + 4 },
          end: { x: x + ANCHO_PIEZA - 7, y: yPieza + ALTO_PIEZA - 4 },
          thickness: 1,
          color: blanco,
        });
        lienzo.page.drawLine({
          start: { x: x + 5, y: yPieza + ALTO_PIEZA - 4 },
          end: { x: x + ANCHO_PIEZA - 7, y: yPieza + 4 },
          thickness: 1,
          color: blanco,
        });
      }

      const etiqueta = String(fdi);
      const anchoEtiqueta = lienzo.fuentes.normal.widthOfTextAtSize(etiqueta, 6.5);
      lienzo.page.drawText(etiqueta, {
        x: x + (ANCHO_PIEZA - anchoEtiqueta) / 2,
        y: numeroArriba ? yTope - 8 : yPieza - 9,
        size: 6.5,
        font: lienzo.fuentes.normal,
        color: GRIS,
      });

      x += ANCHO_PIEZA;
    });
  };

  // Arcada superior: número arriba de la pieza, como en el formato impreso.
  dibujarArcada(CUADRANTES_FDI.superiorDerecho, CUADRANTES_FDI.superiorIzquierdo, lienzo.y, true);
  lienzo.y -= ALTO_ARCADA + 6;

  lienzo.page.drawLine({
    start: { x: xInicio, y: lienzo.y + 2 },
    end: { x: xInicio + anchoFila, y: lienzo.y + 2 },
    thickness: 0.5,
    color: GRIS_CLARO,
  });
  lienzo.y -= 6;

  dibujarArcada(CUADRANTES_FDI.inferiorDerecho, CUADRANTES_FDI.inferiorIzquierdo, lienzo.y, false);
  lienzo.y -= ALTO_ARCADA + 12;

  // Leyenda en dos columnas.
  const mitad = Math.ceil(ESTADOS_DIENTE.length / 2);
  const yLeyenda = lienzo.y;

  ESTADOS_DIENTE.forEach((estado, i) => {
    const columna = i < mitad ? 0 : 1;
    const fila = i < mitad ? i : i - mitad;
    const x = MARGEN + columna * (lienzo.anchoUtil / 2);
    const y = yLeyenda - fila * 12;

    lienzo.page.drawRectangle({
      x,
      y: y - 1,
      width: 8,
      height: 8,
      color: rgb(...estado.rgb),
      borderColor: GRIS_CLARO,
      borderWidth: 0.5,
    });
    lienzo.page.drawText(sanitizar(estado.label), {
      x: x + 12,
      y,
      size: 7.5,
      font: lienzo.fuentes.normal,
      color: NEGRO,
    });
  });

  lienzo.y = yLeyenda - mitad * 12 - 8;

  // Observaciones por pieza, solo las que tengan nota.
  const conNota = Object.entries(dientes)
    .filter(([, d]) => texto(d?.observaciones))
    .map(([fdi, d]) => `${fdi}: ${texto(d.observaciones)}`);

  if (conNota.length) {
    lienzo.espacio(4);
    lienzo.parrafo(`Observaciones por pieza — ${conNota.join(' · ')}`, {
      tamano: 8,
      color: GRIS,
    });
  }
}

/**
 * @param {object} paciente   fila de `pacientes`
 * @param {object} expediente fila de `clinical_records` (form_data ya parseado)
 * @returns {Promise<Buffer>}
 */
async function construirExpedienteClinicoPdf({ paciente, expediente }) {
  const doc = await PDFDocument.create();
  const fuentes = await cargarFuentes(doc);

  const datos = expediente?.form_data || {};
  const nombrePaciente =
    `${paciente?.nombre || ''} ${paciente?.apellidos || ''}`.trim() || 'Paciente';
  const fechaConsulta = texto(datos.fechaConsulta) || soloFecha(expediente?.record_date);

  const lienzo = new Lienzo(doc, fuentes);
  lienzo.encabezado = `${nombrePaciente} · Expediente clínico · ${formatearFecha(fechaConsulta)}`;

  // --- 2. Datos generales ---
  lienzo.titulo('Datos generales');
  lienzo.campo('Nombre', datos.nombre);
  lienzo.campo('Edad', datos.edad ? `${datos.edad} años` : '');
  lienzo.campo('Sexo', datos.sexo);
  lienzo.campo('Fecha de consulta', formatearFecha(fechaConsulta));
  lienzo.campo('Teléfono', datos.telefono);
  lienzo.campo('Correo', datos.correo);
  lienzo.campo('Domicilio', datos.domicilio);
  lienzo.campo('Lugar de residencia', datos.lugarResidencia);
  lienzo.campo('Escolaridad', datos.escolaridad);
  lienzo.campo('Ocupación', datos.ocupacion);
  lienzo.espacio(10);

  // --- 3. Motivo de la consulta ---
  lienzo.titulo('Motivo de la consulta');
  lienzo.parrafo(texto(datos.motivoConsulta) || 'Sin información.', {
    color: texto(datos.motivoConsulta) ? NEGRO : GRIS,
  });
  lienzo.espacio(10);

  // --- 4. Antecedentes heredofamiliares ---
  lienzo.titulo('Antecedentes heredofamiliares');
  lienzo.tabla(
    ['Padecimiento', 'Presente', 'Parentesco'],
    ANTECEDENTES_HEREDOFAMILIARES.map((item) => {
      const fila = datos.heredofamiliares?.[item.id] || {};
      return [item.label, fila.presente ? 'Sí' : 'No', texto(fila.parentesco) || '—'];
    }),
    [280, 70, 149]
  );
  if (texto(datos.heredofamiliaresOtros)) {
    lienzo.espacio(4);
    lienzo.campo('Otros', datos.heredofamiliaresOtros);
  }
  lienzo.espacio(10);

  // --- 5. Antecedentes personales patológicos ---
  lienzo.titulo('Antecedentes personales patológicos');
  lienzo.tabla(
    ['Padecimiento', 'Sí / No', 'Tiempo de evolución'],
    ANTECEDENTES_PATOLOGICOS.map((item) => {
      const fila = datos.antecedentesPatologicos?.[item.id] || {};
      return [item.label, siNo(fila.presente), texto(fila.tiempoEvolucion) || '—'];
    }),
    [280, 70, 149]
  );
  lienzo.espacio(10);

  // --- 6. Medicamentos y alergias ---
  lienzo.titulo('Medicamentos y alergias');
  lienzo.campo(
    '¿Toma algún medicamento?',
    `${siNo(datos.tomaMedicamento?.presente)}${
      texto(datos.tomaMedicamento?.cual) ? ` — ${texto(datos.tomaMedicamento.cual)}` : ''
    }`,
    { anchoEtiqueta: 190 }
  );
  lienzo.campo(
    '¿Alérgico a algún medicamento?',
    `${siNo(datos.alergicoMedicamento?.presente)}${
      texto(datos.alergicoMedicamento?.cual) ? ` — ${texto(datos.alergicoMedicamento.cual)}` : ''
    }`,
    { anchoEtiqueta: 190 }
  );
  lienzo.campo('Otros', datos.otrosMedicamentos, { anchoEtiqueta: 190 });
  lienzo.espacio(10);

  // --- 7 y 8. No patológicos y gineco-obstétricos ---
  lienzo.titulo('Antecedentes no patológicos y gineco-obstétricos');
  lienzo.campo('¿Fuma?', siNo(datos.fuma), { anchoEtiqueta: 190 });
  if (datos.fuma === true) {
    lienzo.campo('Desde cuándo', datos.fumaDesdeCuando, { anchoEtiqueta: 190 });
    lienzo.campo('Cigarros al día', datos.fumaCigarrosPorDia, { anchoEtiqueta: 190 });
  }
  lienzo.campo('¿Está embarazada?', siNo(datos.embarazada), { anchoEtiqueta: 190 });
  if (datos.embarazada === true) {
    lienzo.campo('Meses de gestación', datos.mesesGestacion, { anchoEtiqueta: 190 });
  }
  lienzo.campo('Problemas del periodo menstrual', datos.problemaPeriodoMenstrual, {
    anchoEtiqueta: 190,
  });
  lienzo.espacio(10);

  // --- 9 y 10. Padecimientos ---
  lienzo.titulo('Padecimiento actual');
  lienzo.parrafo(texto(datos.padecimientoActual) || 'Sin información.', {
    color: texto(datos.padecimientoActual) ? NEGRO : GRIS,
  });
  lienzo.espacio(8);
  lienzo.subtitulo('Padecimientos sistémicos bucales previos');
  lienzo.parrafo(texto(datos.padecimientosSistemicosBucalesPrevios) || 'Sin información.', {
    color: texto(datos.padecimientosSistemicosBucalesPrevios) ? NEGRO : GRIS,
  });
  lienzo.espacio(10);

  // --- 11. Aparatos y sistemas ---
  lienzo.titulo('Aparatos y sistemas');
  APARATOS_Y_SISTEMAS.forEach((aparato) => {
    lienzo.campo(aparato.label, datos[aparato.id], { anchoEtiqueta: 110 });
  });
  lienzo.espacio(10);

  // --- 12 y 13. Exploración física ---
  lienzo.titulo('Exploración física');
  lienzo.subtitulo('Habitus exterior');
  SIGNOS_VITALES.forEach((signo) => {
    const valor = texto(datos[signo.id]);
    lienzo.campo(`${signo.label} (${signo.unidad})`, valor, { anchoEtiqueta: 150 });
  });
  lienzo.espacio(6);
  lienzo.subtitulo('Cabeza, cavidad oral y cuello');
  EXPLORACION_CAMPOS.forEach((campo) => {
    lienzo.campo(campo.label, datos[campo.id], { anchoEtiqueta: 110 });
  });
  lienzo.espacio(10);

  // --- 14. Odontograma ---
  lienzo.titulo('Odontograma');
  const fechaInicial = texto(datos.odontogramaInicial?.fecha);
  dibujarOdontograma(
    lienzo,
    datos.odontogramaInicial,
    `Inicial${fechaInicial ? ` — ${formatearFecha(fechaInicial)}` : ''}`
  );
  lienzo.espacio(14);
  const fechaFinal = texto(datos.odontogramaFinal?.fecha);
  dibujarOdontograma(
    lienzo,
    datos.odontogramaFinal,
    `Final${fechaFinal ? ` — ${formatearFecha(fechaFinal)}` : ''}`
  );
  lienzo.espacio(10);

  // --- 15. Estudios, diagnóstico, seguimiento y firmas ---
  lienzo.titulo('Estudios, diagnóstico y seguimiento');
  lienzo.subtitulo('Estudios de gabinete (Lab y/o Rx)');
  lienzo.parrafo(texto(datos.estudiosGabinete) || 'Sin información.', {
    color: texto(datos.estudiosGabinete) ? NEGRO : GRIS,
  });
  lienzo.espacio(8);
  lienzo.subtitulo('Diagnóstico');
  lienzo.parrafo(texto(datos.diagnostico) || 'Sin información.', {
    color: texto(datos.diagnostico) ? NEGRO : GRIS,
  });
  lienzo.espacio(10);

  lienzo.campo('Primera consulta', formatearFecha(texto(datos.fechaPrimeraConsulta)), {
    anchoEtiqueta: 150,
  });
  lienzo.campo('Cita subsecuente', formatearFecha(texto(datos.fechaCitaSubsecuente)), {
    anchoEtiqueta: 150,
  });
  lienzo.espacio(10);

  lienzo.titulo('Firmas');
  lienzo.campo('Odontólogo', datos.odontologoNombre, { anchoEtiqueta: 150 });
  lienzo.campo('Cédula profesional', datos.odontologoCedula, { anchoEtiqueta: 150 });
  lienzo.campo(
    'Confirmación del paciente',
    datos.pacienteConfirma
      ? `El paciente confirma que la información es verídica${
          texto(datos.pacienteConfirmaFecha) ? ` (${texto(datos.pacienteConfirmaFecha)})` : ''
        }`
      : 'Sin confirmar',
    { anchoEtiqueta: 150 }
  );

  // Líneas de firma autógrafa: la NOM-004 pide firma de quien elabora la nota.
  lienzo.espacio(36);
  lienzo.asegurarEspacio(50);
  const anchoFirma = (lienzo.anchoUtil - 40) / 2;
  [0, 1].forEach((i) => {
    const x = MARGEN + i * (anchoFirma + 40);
    lienzo.page.drawLine({
      start: { x, y: lienzo.y },
      end: { x: x + anchoFirma, y: lienzo.y },
      thickness: 0.5,
      color: GRIS,
    });
    lienzo.page.drawText(i === 0 ? 'Firma del odontólogo' : 'Firma del paciente', {
      x,
      y: lienzo.y - 11,
      size: 8,
      font: fuentes.normal,
      color: GRIS,
    });
  });
  lienzo.y -= 24;

  // Portada al frente, con el mismo diseño que el PDF de escaneados.
  const portada = doc.insertPage(0, [A4.ancho, A4.alto]);
  const estado = expediente?.status === 'completado' ? 'Completado' : 'Borrador';

  await escribirPortada(doc, portada, fuentes, {
    titulo: 'Expediente clínico',
    paciente: nombrePaciente,
    lineas: [
      'Formato FO-CD-00003 · REV:00 · captura digital',
      `Consulta del ${formatearFecha(fechaConsulta)} · ${estado}`,
      texto(datos.odontologoNombre)
        ? `Odontólogo: ${texto(datos.odontologoNombre)}${
            texto(datos.odontologoCedula) ? ` · Céd. prof. ${texto(datos.odontologoCedula)}` : ''
          }`
        : null,
      `Generado el ${formatearFecha(hoyYMD())}`,
    ].filter(Boolean),
  });

  return Buffer.from(await doc.save());
}

module.exports = { construirExpedienteClinicoPdf };
