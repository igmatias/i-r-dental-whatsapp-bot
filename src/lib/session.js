// src/lib/session.js
// Persistencia de sesión en Upstash Redis (REST). TTL por 45 minutos.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL_SECONDS = 45 * 60;

async function redisFetch(path, init) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    // Fallback en memoria para dev/local si olvidaste las envs
    globalThis.__IRD_FALLBACK_SESS__ = globalThis.__IRD_FALLBACK_SESS__ || new Map();
    return { ok: true, json: async () => ({ fallback: true }) };
  }
  const r = await fetch(`${REDIS_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  return r;
}

// Guarda JSON con TTL
export async function setSession(waFrom, obj) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    const m = (globalThis.__IRD_FALLBACK_SESS__ ||= new Map());
    m.set(waFrom, { ...obj, __ts: Date.now() });
    return true;
  }
  const body = { value: JSON.stringify(obj), expiration: TTL_SECONDS };
  const r = await redisFetch(`/set/${encodeURIComponent(waFrom)}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return r.ok;
}

export async function getSession(waFrom) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    const m = (globalThis.__IRD_FALLBACK_SESS__ ||= new Map());
    return m.get(waFrom) || null;
  }
  const r = await redisFetch(`/get/${encodeURIComponent(waFrom)}`, { method: "GET" });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j || typeof j.result !== "string") return null;
  try {
    return JSON.parse(j.result);
  } catch {
    return null;
  }
}

export async function delSession(waFrom) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    const m = (globalThis.__IRD_FALLBACK_SESS__ ||= new Map());
    m.delete(waFrom);
    return true;
  }
  const r = await redisFetch(`/del/${encodeURIComponent(waFrom)}`, { method: "POST" });
  return r.ok;
}
