// services/facturacom.js
// ---------------------------------------------------------------------------
// Integración con el módulo de AUTOFACTURACIÓN de factura.com.
// El paciente autofactura en el portal de factura.com tecleando Folio + Fecha +
// Total; nosotros cargamos por API las "órdenes" (los pagos) para que existan y
// hagan match. El FOLIO de la orden = patient_payments.id (numérico y único).
//
// DISEÑO TOLERANTE (como googleCalendar): si faltan las llaves, isConfigured()
// es false y las rutas simplemente NO sincronizan (no rompen el flujo de pagos).
//
// Env:
//   FACTURACOM_API_URL        Host base. Sandbox: https://sandbox.factura.com/api
//                             Prod:    https://api.factura.com
//   FACTURACOM_API_KEY        F-Api-Key
//   FACTURACOM_SECRET_KEY     F-Secret-Key
//   FACTURACOM_IVA            Tasa de IVA de las órdenes (default "16")
//   FACTURACOM_VENCIMIENTO_DIAS  Días desde la fecha del pago para el límite de
//                                timbrado (default 30)
// ---------------------------------------------------------------------------

const IVA = String(process.env.FACTURACOM_IVA || '16')
const VENCIMIENTO_DIAS = Number(process.env.FACTURACOM_VENCIMIENTO_DIAS || 30)
const OBJETO_IMPUESTO = '02' // "Sí objeto de impuesto"

// Prefijo opcional para el folio. Dev y prod comparten la MISMA cuenta de
// factura.com; para que los folios de dev (= id del pago) no choquen con los de
// prod, en dev se puede poner FACTURACOM_FOLIO_PREFIX (p. ej. "DEV"). En prod se
// deja vacío para que el folio sea limpio (el que teclea el paciente).
const FOLIO_PREFIX = String(process.env.FACTURACOM_FOLIO_PREFIX || '')

// Folio de la orden a partir del id del pago (con prefijo opcional).
function folioFor(id) {
  return `${FOLIO_PREFIX}${id}`
}

// Método de pago (nombre nuestro) -> clave SAT de forma de pago.
const SAT_FORMA_PAGO = {
  efectivo: '01',
  transferencia: '03',
  tarjeta_credito: '04',
  tarjeta_debito: '28',
}

function isConfigured() {
  return Boolean(
    process.env.FACTURACOM_API_URL &&
    process.env.FACTURACOM_API_KEY &&
    process.env.FACTURACOM_SECRET_KEY
  )
}

function formaPagoFromMethod(name) {
  const k = String(name || '').trim().toLowerCase()
  return SAT_FORMA_PAGO[k] || '01' // default efectivo
}

// 'YYYY-MM-DD' desde ISO/fecha/date-only (idempotente).
function toDateOnly(d) {
  if (!d) return null
  const s = String(d)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const dt = new Date(s)
  if (Number.isNaN(dt.getTime())) return null
  return dt.toISOString().slice(0, 10)
}

// Suma días a una fecha 'YYYY-MM-DD' y devuelve 'YYYY-MM-DD' (en UTC, estable).
function addDays(ymd, days) {
  const base = toDateOnly(ymd)
  if (!base) return null
  const dt = new Date(`${base}T00:00:00Z`)
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0))
  return dt.toISOString().slice(0, 10)
}

// Construye el cuerpo de la orden a partir de un pago (con id, monto, fecha, metodo_pago).
function buildOrder(payment) {
  const fecha = toDateOnly(payment.fecha)
  return {
    folio: folioFor(payment.id),
    importe: Number(payment.monto || 0),
    fecha,
    vencimiento: addDays(fecha, VENCIMIENTO_DIAS),
    iva: IVA,
    formaDePago: formaPagoFromMethod(payment.metodo_pago),
    objetoImpuesto: OBJETO_IMPUESTO,
  }
}

async function apiFetch(path, { method = 'GET', body } = {}) {
  const url = `${process.env.FACTURACOM_API_URL}${path}`
  // Timeout para que una API lenta/caída no cuelgue el proceso (default 8s).
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    Number(process.env.FACTURACOM_TIMEOUT_MS || 8000)
  )
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'F-Api-Key': process.env.FACTURACOM_API_KEY,
        'F-Secret-Key': process.env.FACTURACOM_SECRET_KEY,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    let json = {}
    try { json = await res.json() } catch (_) {}
    return { ok: res.ok, status: res.status, json }
  } finally {
    clearTimeout(timer)
  }
}

// Crea (o recupera si ya existe) la orden del pago. Devuelve { softId }.
async function createOrder(payment) {
  const order = buildOrder(payment)
  const { json } = await apiFetch('/v4/autofacturacion', { method: 'POST', body: order })
  // Éxito: json.data.soft_id ; "El registro ya existe": json.data.soft_id también viene.
  const softId = json?.data?.soft_id ?? null
  return { softId: softId != null ? String(softId) : null, raw: json }
}

// Actualiza la orden por folio (no aplica si ya está facturada).
async function updateOrder(folio, patch) {
  return apiFetch(`/v4/autofacturacion/folio/${encodeURIComponent(folio)}`, {
    method: 'PATCH',
    body: patch,
  })
}

// Elimina la orden por folio.
async function deleteOrder(folio) {
  return apiFetch(`/v4/autofacturacion/folio/${encodeURIComponent(folio)}`, { method: 'DELETE' })
}

// Busca una orden por folio (para conocer si ya fue facturada / su uuid).
async function findByFolio(folio) {
  const { json } = await apiFetch(`/v4/autofacturacion/folio/${encodeURIComponent(folio)}`, { method: 'GET' })
  return json?.data || null
}

module.exports = {
  isConfigured,
  buildOrder,
  createOrder,
  updateOrder,
  deleteOrder,
  findByFolio,
  formaPagoFromMethod,
  folioFor,
  toDateOnly,
  addDays,
}
