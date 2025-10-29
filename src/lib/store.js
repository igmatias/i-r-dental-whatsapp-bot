// src/lib/store.js

// Crea un store en memoria. Usamos globalThis para persistir entre invocaciones (mientras la lambda esté “caliente”).
function createStore() {
  return {
    messages: [], // {id, ts, waFrom, direction: 'in'|'out', type, body, meta}
    push(msg) {
      try {
        this.messages.unshift(msg);
        if (this.messages.length > 5000) this.messages = this.messages.slice(0, 5000);
      } catch (e) {
        // si algo raro pasa, reiniciar
        this.messages = [];
      }
    },
    listThreads(limit = 100) {
      const map = new Map();
      for (const m of this.messages) {
        if (!map.has(m.waFrom)) {
          map.set(m.waFrom, { waFrom: m.waFrom, last: m, count: 0, unread: 0, messages: [] });
        }
        const th = map.get(m.waFrom);
        th.messages.push(m);
        th.count++;
        if (m.direction === "in") th.unread++;
        if (!th.last || m.ts > th.last.ts) th.last = m;
      }
      return Array.from(map.values())
        .slice(0, limit)
        .sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0));
    },
    getThread(waFrom) {
      return this.messages
        .filter((m) => m.waFrom === waFrom)
        .sort((a, b) => a.ts - b.ts);
    },
  };
}

// Devuelve SIEMPRE un store válido
export function getStore() {
  if (!globalThis.__IRDENTAL_STORE__ || typeof globalThis.__IRDENTAL_STORE__.push !== "function") {
    globalThis.__IRDENTAL_STORE__ = createStore();
  }
  return globalThis.__IRDENTAL_STORE__;
}

// Compatibilidad con código anterior que importaba { STORE }
export const STORE = getStore();
export default getStore;
