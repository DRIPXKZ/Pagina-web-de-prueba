const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: "10kb" }));
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
  sessions.set(sessionId, { messages: [], createdAt: Date.now(), messageCount: 0 });
  for (const [id, s] of sessions.entries()) {
    if (Date.now() - s.createdAt > 7200000) sessions.delete(id);
  }
  res.json({ sessionId });
});

const SYSTEM_PROMPT = `Eres Drip IA, una inteligencia artificial amigable, inteligente y útil.
Respondes siempre en el idioma en que te hablan (español por defecto).
Eres directa, clara y concisa. Tienes personalidad: eres cálida pero cool, curiosa e ingeniosa.
Cuando no sabes algo, lo admites honestamente.`;

app.post("/api/chat", async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || typeof message !== "string" || message.trim().length === 0)
    return res.status(400).json({ error: "Mensaje vacío." });
  if (message.length > 2000)
    return res.status(400).json({ error: "Mensaje demasiado largo." });
  if (!sessionId || !sessions.has(sessionId))
    return res.status(400).json({ error: "Sesión inválida. Recarga la página." });

  const session = sessions.get(sessionId);
  if (session.messageCount >= 50)
    return res.status(429).json({ error: "Límite de 50 mensajes por sesión." });

  session.messages.push({ role: "user", content: message.trim() });
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
        model: "llama-3.3-70b-versatile",
        max_tokens: 1024,
        stream: true,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
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
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: "Error de conexión." })}\n\n`);
    res.end();
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`Drip IA corriendo en http://localhost:${PORT}`);
});
