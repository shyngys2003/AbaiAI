import { LEVELS, MODES, SUBS, buildSystem, pick } from "../lib/lesson.js";
import { redis, clientIp, burst, sendJson } from "../lib/util.js";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash"; // можно сменить без правки кода: переменная GEMINI_MODEL в Vercel
// Запасная модель: если основная перегружена (503/429/500), запрос автоматически уходит на неё.
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.7-flash";
const ATTEMPT_TIMEOUT_MS = 11000; // две попытки укладываются в клиентские 25 с
const DAILY_LIMIT_IP = 500;       // защита бюджета; в школе много учеников за одним IP
const BURST_LIMIT = 15;           // сообщений с одного IP в минуту
const MAX_TEXT = 500;
const MAX_BODY = 20000;
const UPSTREAM_TIMEOUT_MS = 20000; // меньше клиентских 25 с

// День считаем по Казахстану (UTC+5)
const dayKey = ip => `d:${ip}:${new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10)}`;

// Диагностика: открой в браузере /api/chat?check=1, чтобы увидеть, что не так (секреты не показываются).
async function check(req, res) {
  if (await burst("c:" + clientIp(req), 5)) return sendJson(res, 429, { error: "rate_limited" });
  const out = { hasKey: !!process.env.GEMINI_KEY, hasRedis: !!redis, model: MODEL };
  if (out.hasKey) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_KEY },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Say hi" }] }], generationConfig: { maxOutputTokens: 300, thinkingConfig: { thinkingLevel: "low" } } }),
      });
      out.geminiStatus = r.status;
      const j = await r.json().catch(() => ({}));
      out.geminiMessage = j.error?.message?.slice(0, 300) || (j.candidates ? "ok" : "no candidates");
    } catch (e) { out.geminiStatus = "network"; out.geminiMessage = String(e).slice(0, 200); }
  }
  return sendJson(res, 200, out);
}

export default async function handler(req, res) {
  if (req.method === "GET" && req.query?.check) return check(req, res);
  if (req.method !== "POST") return sendJson(res, 405, { error: "method" });
  if (!process.env.GEMINI_KEY) return sendJson(res, 502, { error: "upstream" });

  // Vercel уже разобрал JSON в req.body (объект) или оставил строкой
  let body = req.body;
  try {
    if (typeof body === "string") {
      if (body.length > MAX_BODY) return sendJson(res, 413, { error: "too_large" });
      body = JSON.parse(body);
    } else if (JSON.stringify(body ?? {}).length > MAX_BODY) {
      return sendJson(res, 413, { error: "too_large" });
    }
  } catch { return sendJson(res, 400, { error: "bad_request" }); }
  if (!body || typeof body !== "object") body = {};

  const ip = clientIp(req);
  if (await burst(ip, BURST_LIMIT)) return sendJson(res, 429, { error: "rate_limited" });

  let used = 0, key = null;
  if (redis) {
    key = dayKey(ip);
    try {
      used = parseInt(await redis.get(key), 10) || 0;
      if (used >= DAILY_LIMIT_IP) return sendJson(res, 429, { error: "daily_limit" });
    } catch { key = null; }
  }

  const level = pick(LEVELS, body.level, "A2");
  const lang = body.lang === "kk" ? "kk" : "ru";
  const src = body.src === "manual" ? "manual" : "test";
  const mode = pick(MODES, body.mode, "free");
  const pool = SUBS[mode];
  const sub = pool ? pick(pool, body.sub, Object.keys(pool)[0]) : null;

  const contents = (Array.isArray(body.messages) ? body.messages : [])
    .filter(m => m && typeof m.text === "string" && m.text.trim())
    .slice(-MODES[mode].hist)
    .map(m => ({
      role: m.role === "model" ? "model" : "user",
      parts: [{ text: m.text.trim().slice(0, MAX_TEXT) }],
    }));
  if (!contents.length || contents[contents.length - 1].role !== "user")
    return sendJson(res, 400, { error: "bad_request" });
  if (contents[0].role === "model") contents.unshift({ role: "user", parts: [{ text: "(Lesson started.)" }] });

  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: buildSystem({ level, lang, src, mode, sub }) }] },
    contents,
    generationConfig: {
      // у Gemini 3.x нельзя полностью отключить "размышление": ставим low и даём запас токенов,
      // чтобы оно не съело лимит и ответ не вышел пустым. Длину ответа держит промпт.
      maxOutputTokens: MODES[mode].tokens + 1000,
      temperature: 0.7,
      thinkingConfig: { thinkingLevel: "low" },
    },
  });

  const models = FALLBACK_MODEL && FALLBACK_MODEL !== MODEL ? [MODEL, FALLBACK_MODEL] : [MODEL];
  let reply = "", lastStatus = 0;
  for (const model of models) {
    let r;
    try {
      r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_KEY },
          signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
          body: payload,
        }
      );
    } catch (e) {
      console.error("Gemini fetch failed", model, String(e));
      lastStatus = 503;
      continue; // пробуем запасную модель
    }
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.error("Gemini error", model, r.status, errText.slice(0, 500));
      lastStatus = r.status;
      continue; // 503/429/404 и т.п.: пробуем запасную модель
    }
    const data = await r.json().catch(() => ({}));
    reply = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
    if (reply) break;
    console.error("Gemini empty reply", model, JSON.stringify(data).slice(0, 500));
    lastStatus = -1;
  }

  if (!reply) {
    if (lastStatus === -1) return sendJson(res, 502, { error: "empty" });
    const busy = [0, 429, 500, 503, 504].includes(lastStatus);
    return sendJson(res, busy ? 503 : 502, { error: busy ? "busy" : "upstream" });
  }

  if (key) { try { await redis.set(key, used + 1, { ex: 172800 }); } catch {} }
  return sendJson(res, 200, { reply });
}
