const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;
const GROQ_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

const sessions = new Map();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: "Demasiadas solicitudes. Espera unos minutos." }
});

app.use("/api/chat", limiter);

app.post("/api/session", (req, res) => {
  const sessionId = uuidv4();
  sessions.set(sessionId, {
    messages: [],
    createdAt: Date.now(),
    messageCount: 0,
    userName: null,
    language: "es",
    preferences: {}
  });
  for (const [id, s] of sessions.entries()) {
    if (Date.now() - s.createdAt > 7200000) sessions.delete(id);
  }
  res.json({ sessionId });
});

app.post("/api/preferences", (req, res) => {
  const { sessionId, userName, language } = req.body;
  if (!sessionId || !sessions.has(sessionId))
    return res.status(400).json({ error: "Sesión inválida." });
  const session = sessions.get(sessionId);
  if (userName) session.userName = userName;
  if (language) session.language = language;
  res.json({ ok: true });
});

const SYSTEM_PROMPT = (userName, language) => `Eres Drip IA, una inteligencia artificial avanzada, amigable y muy capaz.
${userName ? `El usuario se llama ${userName}. Dirígete a él por su nombre ocasionalmente.` : ""}
Idioma principal: ${language === "en" ? "inglés" : language === "fr" ? "francés" : "español"}.
Responde SIEMPRE en el idioma en que te habla el usuario.

CAPACIDADES ESPECIALES:
- Matemáticas: Resuelve paso a paso con procedimiento completo. Formato:
  Paso 1: ...
  Paso 2: ...
  Resultado: ✅
- Ciencias: Explica con ejemplos del mundo real.
- Tareas escolares: Enseña el razonamiento, no solo la respuesta.
- Imágenes: Analiza y describe imágenes detalladamente.
- Código: Ayuda con cualquier lenguaje de programación.

ESTILO:
- Ortografía perfecta, tildes correctas en español.
- Claro, directo y organizado.
- Usa emojis ocasionalmente para ser más amigable.

Al final de cada respuesta sugiere 2-3 preguntas de seguimiento en formato:
[SUGERENCIAS: pregunta1 | pregunta2 | pregunta3]`;

app.post("/api/chat", async (req, res) => {
  const { message, sessionId, imageBase64, imageMime } = req.body;

  if (!message || typeof message !== "string" || message.trim().length === 0)
    return res.status(400).json({ error: "Mensaje vacío." });
  if (message.length > 2000)
    return res.status(400).json({ error: "Mensaje demasiado largo." });
  if (!sessionId || !sessions.has(sessionId))
    return res.status(400).json({ error: "Sesión inválida. Recarga la página." });

  const session = sessions.get(sessionId);
  if (session.messageCount >= 50)
    return res.status(429).json({ error: "Límite de 50 mensajes por sesión." });

  let userContent;
  if (imageBase64 && imageMime) {
    userContent = [
      { type: "text", text: message.trim() },
      { type: "image_url", image_url: { url: `data:${imageMime};base64,${imageBase64}` } }
    ];
  } else {
    userContent = message.trim();
  }

  session.messages.push({ role: "user", content: userContent });
  session.messageCount++;

  const recentMessages = session.messages.slice(-20);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: imageBase64 ? "meta-llama/llama-4-scout-17b-16e-instruct" : "llama-3.3-70b-versatile",
        max_tokens: 1024,
        stream: true,
        messages: [
          { role: "system", content: SYSTEM_PROMPT(session.userName, session.language) },
          ...recentMessages
        ]
      })
    });

    if (!response.ok) {
      res.write(`data: ${JSON.stringify({ error: "Error en la IA." })}\n\n`);
      res.end();
      return;
    }

    let fullReply = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const text = parsed.choices?.[0]?.delta?.content;
            if (text) {
              fullReply += text;
              res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
            }
          } catch {}
        }
      }
    }

    if (fullReply) session.messages.push({ role: "assistant", content: fullReply });

    const sugMatch = fullReply.match(/\[SUGERENCIAS:\s*(.+)\]/);
    if (sugMatch) {
      const sugs = sugMatch[1].split("|").map(s => s.trim()).filter(Boolean);
      res.write(`data: ${JSON.stringify({ suggestions: sugs })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: "Error de conexión." })}\n\n`);
    res.end();
  }
});

app.post("/api/image", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Prompt vacío." });

  const enhanced = `${prompt}, ultra realistic, high quality, 4k, detailed, professional photography`;
  const encoded = encodeURIComponent(enhanced);
  const imageUrl = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true&enhance=true&seed=${Math.floor(Math.random()*99999)}`;

  res.json({ imageUrl });
});

app.post("/api/feedback", (req, res) => {
  const { sessionId, rating } = req.body;
  console.log(`Feedback - Session: ${sessionId}, Rating: ${rating}`);
  res.json({ ok: true });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`Drip IA corriendo en http://localhost:${PORT}`);
});
