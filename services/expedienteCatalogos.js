// services/expedienteCatalogos.js
// ---------------------------------------------------------------------------
// ⚠️ ESPEJO de implaeden-frontend/src/components/expediente-clinico/constants.js
//
// Los `id` son las llaves con las que el wizard guarda `clinical_records.form_data`;
// aquí solo se necesitan para poner las ETIQUETAS en el PDF. Si allá se agrega o
// renombra un renglón, hay que reflejarlo aquí o el PDF lo omitirá (los ids que
// no estén en esta lista simplemente no se imprimen).
//
// Se duplica en vez de compartirse porque frontend y backend son repos
// separados; no hay paquete común donde vivan los catálogos.
// ---------------------------------------------------------------------------

const ANTECEDENTES_HEREDOFAMILIARES = [
  { id: 'diabetesMellitus', label: 'Diabetes Mellitus' },
  { id: 'hipertensionArterial', label: 'Hipertensión Arterial' },
  { id: 'enfermedadCardiaca', label: 'Enfermedad Cardiaca' },
  { id: 'cancer', label: 'Cáncer' },
];

const ANTECEDENTES_PATOLOGICOS = [
  { id: 'fiebreReumatica', label: 'Fiebre reumática o enfermedad cardioreumática' },
  { id: 'enfermedadesCardiovasculares', label: 'Enfermedades cardiovasculares' },
  { id: 'mareosDesmayos', label: 'Mareos, desmayos o ataques' },
  { id: 'diabetesMellitus', label: 'Diabetes Mellitus' },
  { id: 'hepatitis', label: 'Hepatitis' },
  { id: 'vihSida', label: 'VIH / SIDA' },
  { id: 'artritisReumatismo', label: 'Artritis o reumatismo' },
  { id: 'gastritisUlceras', label: 'Gastritis o úlceras estomacales' },
  { id: 'problemasRenales', label: 'Problemas renales' },
  { id: 'anemia', label: 'Anemia' },
  { id: 'hipertensionArterial', label: 'Hipertensión arterial' },
  { id: 'hipotensionArterial', label: 'Hipotensión arterial' },
  { id: 'extraccionesSangrado', label: 'Extracciones dentales con facilidad de sangrado' },
  { id: 'sangradoPorTratamiento', label: 'Sangrado relacionado con algún tratamiento' },
];

const APARATOS_Y_SISTEMAS = [
  { id: 'aparatoCirculatorio', label: 'Circulatorio' },
  { id: 'aparatoRespiratorio', label: 'Respiratorio' },
  { id: 'aparatoDigestivo', label: 'Digestivo' },
  { id: 'aparatoUrinario', label: 'Urinario' },
  { id: 'aparatoNervioso', label: 'Nervioso' },
];

const SIGNOS_VITALES = [
  { id: 'fc', label: 'FC', unidad: 'lpm' },
  { id: 'fr', label: 'FR', unidad: 'rpm' },
  { id: 'temperatura', label: 'Temperatura', unidad: '°C' },
  { id: 'tensionArterial', label: 'Tensión arterial', unidad: 'mmHg' },
  { id: 'glicemia', label: 'Glicemia', unidad: 'mg/dL' },
  { id: 'pesoActual', label: 'Peso actual', unidad: 'kg' },
];

const EXPLORACION_CAMPOS = [
  { id: 'exploracionCabeza', label: 'Cabeza' },
  { id: 'exploracionCavidadOral', label: 'Cavidad oral' },
  { id: 'exploracionCuello', label: 'Cuello' },
];

// Colores en 0-1 para pdf-lib, equivalentes a las clases Tailwind del front.
const ESTADOS_DIENTE = [
  { id: 'sano', label: 'Sano', rgb: [1, 1, 1] },
  { id: 'caries', label: 'Caries', rgb: [0.94, 0.27, 0.27] },
  { id: 'obturado', label: 'Obturado', rgb: [0.23, 0.51, 0.96] },
  { id: 'corona', label: 'Corona', rgb: [0.98, 0.75, 0.14] },
  { id: 'endodoncia', label: 'Endodoncia', rgb: [0.66, 0.33, 0.97] },
  { id: 'implante', label: 'Implante', rgb: [0.08, 0.72, 0.65] },
  { id: 'sellante', label: 'Sellante', rgb: [0.52, 0.8, 0.09] },
  { id: 'fractura', label: 'Fractura', rgb: [0.98, 0.45, 0.09] },
  { id: 'extraccion_indicada', label: 'Extracción indicada', rgb: [0.93, 0.28, 0.6] },
  { id: 'ausente', label: 'Ausente', rgb: [0.25, 0.25, 0.27] },
];

const ESTADO_DIENTE_POR_ID = ESTADOS_DIENTE.reduce((acc, e) => {
  acc[e.id] = e;
  return acc;
}, {});

const CUADRANTES_FDI = {
  superiorDerecho: [18, 17, 16, 15, 14, 13, 12, 11],
  superiorIzquierdo: [21, 22, 23, 24, 25, 26, 27, 28],
  inferiorDerecho: [48, 47, 46, 45, 44, 43, 42, 41],
  inferiorIzquierdo: [31, 32, 33, 34, 35, 36, 37, 38],
};

module.exports = {
  ANTECEDENTES_HEREDOFAMILIARES,
  ANTECEDENTES_PATOLOGICOS,
  APARATOS_Y_SISTEMAS,
  SIGNOS_VITALES,
  EXPLORACION_CAMPOS,
  ESTADOS_DIENTE,
  ESTADO_DIENTE_POR_ID,
  CUADRANTES_FDI,
};
