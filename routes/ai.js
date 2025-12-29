// routes/ai.js
const express = require("express");
const router = express.Router();
const { z } = require("zod");

const db = require("../config/db");
const { getPatientSummary } = require("../services/patientSummaryService");

async function buscarPacientesDB({ search, page = 1, limit = 10 }) {
  const safeSearch = String(search || "").trim();
  const safePage = Math.max(1, Number(page || 1));
  const safeLimit = Math.min(50, Math.max(1, Number(limit || 10)));
  const offset = (safePage - 1) * safeLimit;

  const like = `%${safeSearch}%`;

  const query = `
    SELECT id, nombre, apellidos, telefono, email, created_at
    FROM pacientes
    WHERE nombre LIKE ? OR apellidos LIKE ? OR telefono LIKE ? OR email LIKE ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM pacientes
    WHERE nombre LIKE ? OR apellidos LIKE ? OR telefono LIKE ? OR email LIKE ?
  `;

  const [rows] = await db.query(query, [like, like, like, like, safeLimit, offset]);
  const [countRows] = await db.query(countQuery, [like, like, like, like]);

  const total = countRows?.[0]?.total ?? 0;

  return {
    page: safePage,
    limit: safeLimit,
    total,
    totalPages: Math.ceil(total / safeLimit),
    patients: rows.map((p) => ({ id: p.id, nombre: p.nombre, apellidos: p.apellidos })),
  };
}

// routes/ai.js
router.post("/chat", async (req, res, next) => {
  try {
    const body = req.body || {};
    const { messages, system } = body;

    if (!Array.isArray(messages)) {
      return res.status(400).json({
        error: "Bad Request",
        details: "`messages` debe ser un arreglo (UIMessage[]).",
      });
    }

    const { streamText, convertToModelMessages, tool, stepCountIs } = await import("ai");
    const { openai } = await import("@ai-sdk/openai");

    const tools = {
      buscar_pacientes: tool({
        description: "Busca pacientes por texto.",
        inputSchema: z.object({
          search: z.string().min(1),
          page: z.number().int().min(1).default(1),
          limit: z.number().int().min(1).max(50).default(10),
        }),
        execute: async ({ search, page, limit }) => buscarPacientesDB({ search, page, limit }),
      }),

      resumen_paciente: tool({
        description: "Obtiene el resumen del paciente por id.",
        inputSchema: z.object({
          patientId: z.number().int().positive(),
        }),
        execute: async ({ patientId }) => getPatientSummary(patientId),
      }),
    };

    // Headers SSE (antes de empezar a streamear)
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const result = streamText({
      model: openai("gpt-4o"),
      system:
        system ||
        `Eres un asistente interno de una clínica dental.
- No inventes datos.
- Si piden "resumen del paciente <nombre>": usa buscar_pacientes.
- Si hay 1 match: usa resumen_paciente con el id.
- Si hay varios: pregunta cuál (muestra id + nombre + apellidos).
- Si no hay: dilo.
IMPORTANTE: Después de usar herramientas, SIEMPRE responde al usuario con texto.`,
      messages: await convertToModelMessages(messages), // ✅ CLAVE
      tools,

      // ✅ más margen para: tool -> tool output -> texto final
      stopWhen: stepCountIs(10),
    });

    return result.pipeUIMessageStreamToResponse(res);
  } catch (err) {
    next(err);
  }
});


module.exports = router;
