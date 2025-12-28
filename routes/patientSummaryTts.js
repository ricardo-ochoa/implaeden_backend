// routes/patientSummaryTts.js
const express = require("express");
const { PollyClient, SynthesizeSpeechCommand } = require("@aws-sdk/client-polly");

const router = express.Router();

function escapeXml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatDate(dateString) {
  if (!dateString) return "Sin fecha";
  const d = new Date(dateString);
  if (Number.isNaN(d.getTime())) return String(dateString);
  return d.toLocaleDateString("es-MX", { year: "numeric", month: "short", day: "2-digit" });
}

function formatDateTime(dateString) {
  if (!dateString) return "Sin fecha";
  const d = new Date(dateString);
  if (Number.isNaN(d.getTime())) return String(dateString);
  return d.toLocaleString("es-MX", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function summaryToSsml(summary) {
  const { patient, lastService, lastAppointment, lastPayment } = summary || {}
  const fullName = patient ? `${patient.nombre || ""} ${patient.apellidos || ""}`.trim() : "Paciente";

  const lines = [];
  lines.push(`Resumen del paciente: ${fullName}.`);

  if (lastService) {
    const fecha = lastService.service_date ? formatDate(lastService.service_date) : "Sin fecha";
    const costo =
      typeof lastService.total_cost === "number" ? `${lastService.total_cost.toFixed(2)} pesos` : null;

    const parts = [];
    if (lastService.service_name) parts.push(lastService.service_name);
    if (lastService.status) parts.push(`estado ${lastService.status}`);
    parts.push(`fecha ${fecha}`);
    if (costo) parts.push(`costo ${costo}`);

    lines.push(`Último servicio: ${parts.join(", ")}.`);
  } else {
    lines.push("Último servicio: no hay servicios registrados.");
  }

  if (lastAppointment) {
  const fecha = lastAppointment.appointment_at
    ? formatDateTime(lastAppointment.appointment_at)
    : "Sin fecha";

  const parts = [fecha];
  if (lastAppointment.service_name) parts.push(`para ${lastAppointment.service_name}`);

  lines.push(`Última cita registrada: ${parts.join(", ")}.`);
} else {
  lines.push("Última cita registrada: no hay citas registradas.");
}

  if (lastPayment) {
  const fecha = lastPayment.fecha ? formatDate(lastPayment.fecha) : "Sin fecha";

  // ✅ acepta "11100.00" o 11100
  const montoNumber =
    lastPayment.monto !== null && lastPayment.monto !== undefined && lastPayment.monto !== ""
      ? Number(lastPayment.monto)
      : null;

  const monto =
    montoNumber !== null && !Number.isNaN(montoNumber)
      ? `${montoNumber.toFixed(2)} pesos`
      : null;

  const parts = [fecha];
  if (monto) parts.push(`monto ${monto}`);
  if (lastPayment.payment_method) parts.push(`método ${lastPayment.payment_method}`);
  if (lastPayment.payment_status) parts.push(`estado ${lastPayment.payment_status}`);

  lines.push(`Último pago: ${parts.join(", ")}.`);
} else {
  lines.push("Último pago: no hay pagos registrados.");
}


  const body = lines.map((l) => `<p>${escapeXml(l)}</p>`).join('<break time="350ms"/>');
  return `<speak>${body}</speak>`;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// POST /api/pacientes/:patientId/resumen/tts
router.post("/resumen/tts", async (req, res, next) => {
  try {
        const { getPatientSummary } = require("../services/patientSummaryService");

    let patientId = Number(req.params.patientId || req.params.id);

if (!patientId || Number.isNaN(patientId)) {
  // fallback: /api/pacientes/50/resumen/tts
  const m = String(req.originalUrl || "").match(/\/pacientes\/(\d+)\//);
  if (m) patientId = Number(m[1]);
}

if (!patientId || Number.isNaN(patientId)) {
  return res.status(400).json({ error: "patientId inválido" });
}

    const summary = await getPatientSummary(patientId);
    const ssml = summaryToSsml(summary);

    const polly = new PollyClient({ region: process.env.AWS_REGION });

    const voiceId = process.env.POLLY_VOICE_ID || "Mia";
    const preferredEngine = process.env.POLLY_ENGINE || "neural";

    let out;
    try {
      out = await polly.send(
        new SynthesizeSpeechCommand({
          OutputFormat: "mp3",
          TextType: "ssml",
          Text: ssml,
          VoiceId: voiceId,
          Engine: preferredEngine,
        })
      );
    } catch (e) {
      out = await polly.send(
        new SynthesizeSpeechCommand({
          OutputFormat: "mp3",
          TextType: "ssml",
          Text: ssml,
          VoiceId: voiceId,
          Engine: "standard",
        })
      );
    }

    if (!out || !out.AudioStream) {
      return res.status(500).json({ error: "Polly no devolvió audio" });
    }

    const audioBuffer = await streamToBuffer(out.AudioStream);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Length", String(audioBuffer.length));
    return res.status(200).send(audioBuffer);
  } catch (err) {
    return next(err);
  }
});


module.exports = router;
