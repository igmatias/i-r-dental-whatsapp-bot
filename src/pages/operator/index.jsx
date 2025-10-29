// src/pages/operator/index.jsx
import { useEffect, useRef, useState } from "react";

const PALETTE = {
  bg: "#0f0f10",
  panel: "#181a1b",
  panelSoft: "#202326",
  text: "#e8e8e8",
  sub: "#a9a9a9",
  accent: "#8e2430",     // bordó
  accent2: "#e53935",    // rojo
  gray: "#2a2d31",
  line: "#2f3337",
  badgeIn: "#37474f",
  badgeOut: "#3f2a2d",
  bubbleIn: "#1f2124",
  bubbleOut: "#31161b",
};

function Header({ loading, onRefresh }) {
  return (
    <div style={{
      padding: 14,
      borderRadius: 14,
      background: `linear-gradient(90deg, ${PALETTE.accent} 0%, ${PALETTE.accent2} 50%, ${PALETTE.bg} 100%)`,
      display: "flex",
      alignItems: "center",
      gap: 12,
    }}>
      <div style={{ fontWeight: 800, color: "white", fontSize: 18, letterSpacing: .3 }}>
        i-R Dental • Consola del Operador
      </div>
      <div style={{ marginLeft: "auto" }}>
        <button
          onClick={onRefresh}
          disabled={loading}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,.25)",
            background: "rgba(0,0,0,.25)",
            color: "white",
            cursor: loading ? "not-allowed" : "pointer"
          }}
        >
          {loading ? "Actualizando…" : "Actualizar"}
        </button>
      </div>
    </div>
  );
}

function ThreadItem({ t, active, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        cursor: "pointer",
        padding: 12,
        borderBottom: `1px solid ${PALETTE.line}`,
        background: active ? PALETTE.panelSoft : "transparent",
        transition: "background .15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{
          width: 10, height: 10, borderRadius: 20,
          background: t.last?.direction === "in" ? PALETTE.accent2 : PALETTE.accent
        }}/>
        <div style={{ fontWeight: 700, color: PALETTE.text }}>{t.waFrom}</div>
        <div style={{
          marginLeft: "auto",
          fontSize: 12,
          color: PALETTE.sub,
        }}>
          {new Date(t.last?.ts || Date.now()).toLocaleString()}
        </div>
      </div>
      <div style={{ fontSize: 12, color: PALETTE.sub, marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {(t.last?.direction === 'in' ? "Paciente: " : "Operador: ") + (t.last?.body || "")}
      </div>
      <div style={{ marginTop: 6, display: "flex", gap: 8 }}>
        <span style={{
          fontSize: 11, color: "#fff",
          background: "#444", borderRadius: 999, padding: "3px 8px"
        }}>msgs {t.count}</span>
        <span style={{
          fontSize: 11, color: "#fff",
          background: t.unread ? PALETTE.accent2 : "#444",
          borderRadius: 999, padding: "3px 8px"
        }}>sin leer {t.unread}</span>
      </div>
    </div>
  );
}

function Bubble({ m }) {
  const isIn = m.direction === "in";
  return (
    <div style={{ display: "flex", justifyContent: isIn ? "flex-start" : "flex-end", margin: "8px 0" }}>
      <div style={{
        maxWidth: "78%",
        borderRadius: 14,
        padding: "10px 12px",
        background: isIn ? PALETTE.bubbleIn : PALETTE.bubbleOut,
        border: `1px solid ${PALETTE.line}`,
        color: PALETTE.text,
      }}>
        <div style={{ fontSize: 11, color: PALETTE.sub, marginBottom: 4 }}>
          {isIn ? "Paciente" : "Operador"} • {new Date(m.ts).toLocaleString()}
        </div>
        <div style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>
      </div>
    </div>
  );
}

export default function OperatorPage() {
  const [key, setKey] = useState("");
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(null); // { waFrom }
  const [msgs, setMsgs] = useState([]);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const pollRef = useRef(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const k = url.searchParams.get("key") || "";
    setKey(k);
    refreshThreads(k);
    pollRef.current = setInterval(() => {
      if (!document.hidden) {
        refreshThreads(k, true);
        if (sel?.waFrom) refreshThread(sel.waFrom, k, true);
      }
    }, 2000);
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.waFrom]);

  async function refreshThreads(k, silent = false) {
    if (!silent) setLoading(true);
    try {
      const r = await fetch(`/api/operator/events?key=${encodeURIComponent(k)}`, { cache: "no-store" });
      const j = await r.json();
      if (j.ok) setThreads(j.threads || []);
      else alert(j.error || "Error");
    } catch (e) {
      console.error(e);
      if (!silent) alert("Error al cargar hilos");
    } finally {
      if (!silent) setLoading(false);
    }
  }

  async function refreshThread(waFrom, k, silent = false) {
    try {
      const r = await fetch(`/api/operator/thread?waFrom=${encodeURIComponent(waFrom)}&key=${encodeURIComponent(k)}`, { cache: "no-store" });
      const j = await r.json();
      if (j.ok) setMsgs(j.messages || []);
    } catch (e) {
      console.error(e);
      if (!silent) alert("Error al cargar el hilo");
    }
  }

  async function pickThread(t) {
    setSel({ waFrom: t.waFrom });
    await refreshThread(t.waFrom, key);
  }

  async function sendReply() {
    if (!sel?.waFrom) return alert("Elegí un hilo primero");
    if (!replyText.trim()) return;
    setSending(true);
    try {
      const r = await fetch(`/api/operator/reply?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ to: sel.waFrom, text: replyText.trim() }),
      });
      const j = await r.json();
      if (!j.ok) {
        console.error(j);
        alert("Error al enviar");
      } else {
        setReplyText("");
        await refreshThread(sel.waFrom, key, true);
        await refreshThreads(key, true);
      }
    } catch (e) {
      console.error(e);
      alert("Error al enviar");
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial", background: PALETTE.bg, color: PALETTE.text, minHeight: "100vh" }}>
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: 16 }}>
        <Header loading={loading} onRefresh={() => refreshThreads(key)} />

        <div style={{
          marginTop: 12,
          display: "grid",
          gridTemplateColumns: "340px 1fr",
          gap: 12,
          alignItems: "stretch",
        }}>
          {/* Sidebar */}
          <div style={{ border: `1px solid ${PALETTE.line}`, borderRadius: 14, background: PALETTE.panel, overflow: "hidden", display: "flex", flexDirection: "column", minHeight: "72vh" }}>
            <div style={{ padding: 12, borderBottom: `1px solid ${PALETTE.line}`, fontWeight: 700, background: PALETTE.panelSoft }}>
              Hilos
            </div>
            <div style={{ overflowY: "auto", flex: 1 }}>
              {threads.length === 0 && <div style={{ padding: 16, color: PALETTE.sub }}>No hay hilos todavía…</div>}
              {threads.map((t) => (
                <ThreadItem key={t.waFrom} t={t} active={sel?.waFrom === t.waFrom} onClick={() => pickThread(t)} />
              ))}
            </div>
          </div>

          {/* Chat */}
          <div style={{ border: `1px solid ${PALETTE.line}`, borderRadius: 14, background: PALETTE.panel, display: "grid", gridTemplateRows: "auto 1fr auto", minHeight: "72vh" }}>
            <div style={{ padding: 12, borderBottom: `1px solid ${PALETTE.line}`, background: PALETTE.panelSoft }}>
              {sel?.waFrom ? <b>{sel.waFrom}</b> : <span style={{ color: PALETTE.sub }}>Seleccioná un hilo para comenzar</span>}
            </div>

            <div style={{ padding: 14, overflowY: "auto", background: PALETTE.gray }}>
              {sel?.waFrom && msgs.length === 0 && (
                <div style={{ color: PALETTE.sub }}>Sin mensajes…</div>
              )}
              {msgs.map((m) => <Bubble key={m.id} m={m} />)}
            </div>

            <div style={{ padding: 12, borderTop: `1px solid ${PALETTE.line}`, background: PALETTE.panelSoft, display: "flex", gap: 8 }}>
              <input
                placeholder="Escribí la respuesta…"
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                disabled={!sel?.waFrom}
                style={{
                  flex: 1, padding: "12px 14px", borderRadius: 12, outline: "none",
                  border: `1px solid ${PALETTE.line}`, background: "#0d0f11", color: PALETTE.text
                }}
              />
              <button
                onClick={sendReply}
                disabled={!sel?.waFrom || sending}
                style={{
                  padding: "12px 16px",
                  borderRadius: 12,
                  border: "none",
                  color: "white",
                  background: sending ? "#555" : `linear-gradient(90deg, ${PALETTE.accent} 0%, ${PALETTE.accent2} 100%)`,
                  cursor: (!sel?.waFrom || sending) ? "not-allowed" : "pointer",
                  fontWeight: 700
                }}
              >
                {sending ? "Enviando…" : "Enviar"}
              </button>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 10, textAlign: "right", color: PALETTE.sub, fontSize: 12 }}>
          Atajos: <code>Actualizar</code> • Polling 2 s • Fetch <code>no-store</code>
        </div>
      </div>
    </div>
  );
}
