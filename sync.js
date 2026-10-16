import { redis, clientIp, burst, sendJson } from "../lib/util.js";

// Что разрешено хранить на сервере (всё остальное отбрасывается)
const SYNC_KEYS = ["lang", "level", "score", "mode", "sub", "mlevel", "days", "best", "total"];
const YEAR = 365 * 24 * 3600;

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "method" });
  if (!redis) return sendJson(res, 503, { error: "no_db" });
  if (await burst("s:" + clientIp(req), 30)) return sendJson(res, 429, { error: "rate_limited" });

  let b = req.body;
  try { if (typeof b === "string") b = JSON.parse(b); } catch { b = null; }
  if (!b || typeof b !== "object" || JSON.stringify(b).length > 5000)
    return sendJson(res, 400, { error: "bad_request" });

  const id = typeof b.id === "string" && /^[A-Za-z0-9-]{20,64}$/.test(b.id) ? b.id : null;
  if (!id) return sendJson(res, 400, { error: "bad_request" });
  const k = "u:" + id;

  try {
    if (b.action === "put") {
      const data = {};
      for (const key of SYNC_KEYS)
        if (typeof b.data?.[key] === "string") data[key] = b.data[key].slice(0, 2000);
      await redis.set(k, data, { ex: YEAR });
      return sendJson(res, 200, { ok: true });
    }
    const data = await redis.get(k);
    return sendJson(res, 200, { data: data || null });
  } catch {
    return sendJson(res, 503, { error: "busy" });
  }
}
