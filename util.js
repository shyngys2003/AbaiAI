import { Redis } from "@upstash/redis";

// Upstash Redis из Vercel Marketplace кладёт переменные KV_REST_API_* (или UPSTASH_REDIS_REST_*).
const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
export const redis = url && token ? new Redis({ url, token }) : null;

export const clientIp = req =>
  String(req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown").split(",")[0].trim();

// Лимит запросов в минуту. Через Redis работает между всеми экземплярами функции; без Redis - только в памяти.
const mem = new Map();
export async function burst(ip, limit, windowMs = 60000) {
  if (redis) {
    try {
      const k = `b:${ip}:${Math.floor(Date.now() / windowMs)}`;
      const n = await redis.incr(k);
      if (n === 1) await redis.expire(k, 90);
      return n > limit;
    } catch { /* Redis недоступен: не блокируем учеников */ }
  }
  const now = Date.now();
  const a = (mem.get(ip) || []).filter(t => now - t < windowMs);
  const over = a.length >= limit;
  if (!over) a.push(now);
  mem.set(ip, a);
  if (mem.size > 5000) mem.clear();
  return over;
}

export const sendJson = (res, status, obj) => res.status(status).json(obj);
