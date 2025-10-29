import { useEffect, useMemo, useRef, useState } from "react";

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
    // Poll cada 6s
    pollRef.current = setInterval(() => {
      if (!document.hidden) refreshThreads(k, true);
      if (sel) refreshThread(sel.waFrom, k, true);
    }, 6000);
    return () => clearInterval(pollRef.current);
  }, [sel?.waFrom]);

  async function refreshThreads(k, silent = false) {
    if (!silent) setLoading(true);
    try {
      const r = await fetch(`/api/operator/events?key=${encodeURIComponent(k)}`);
      const j = await r.json();
      if (j.ok) setThreads(j.threads || []);
    } catch (e) {
      console.error(e);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  async function refreshThread(waFrom, k, silent = false) {
    try {
      const r = await fetch(`/api/operator/thread?waFrom=${encodeURIComponent(waFrom)}&key=${encodeURIComponent(k)}`);
      const j = await r.json();
      if (j.ok) setMsgs(j.messages || []);
    } catch (e) {
      console.error(e);
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

  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Consola del Operador • i-R Dental</h1>
      <button onClick={() => refreshThreads(key)} disabled={loading} style={{ marginLeft: "auto" }}>
        {loading ? "Actualizando..." : "Actualizar"}
      </button>
    </div>
  );

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 16, height: "100vh", boxSizing: "border-box" }}>
      {header}
      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 12, height: "calc(100% - 44px)" }}>
        {/* Lista de hilos */}
        <div style={{ border: "1px solid #eee", borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: 10, background: "#fafafa", borderBottom: "1px solid #eee", fontWeight: 600 }}>Hilos</div>
          <div style={{ overflowY: "auto" }}>
            {threads.length === 0 && (
              <div style={{ padding: 12, color: "#888" }}>No hay hilos todavía…</div>
            )}
            {threads.map((t) => (
              <div
                key={t.waFrom}
                onClick={() => pickThread(t)}
                style={{
                  cursor: "pointer",
                  borderBottom: "1px solid #f2f2f2",
                  padding: 10,
                  background: sel?.waFrom === t.waFrom ? "#eef7f3" : "white",
                }}
              >
                <div style={{ fontWeight: 600 }}>{t.waFrom}</div>
                <div style={{ fontSize: 12, color: "#666", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {(t.last?.direction === 'in' ? "🟢" : "🔵") + " " + (t.last?.body || "")}
                </div>
                <div style={{ fontSize: 12, color: "#999" }}>
                  {new Date(t.last?.ts || Date.now()).toLocaleString()} • {t.count} msg • {t.unread} sin leer
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Chat del hilo seleccionado */}
        <div style={{ border: "1px solid #eee", borderRadius: 12, overflow: "hidden", display: "grid", gridTemplateRows: "auto 1fr auto" }}>
          <div style={{ padding: 10, background: "#fafafa", borderBottom: "1px solid #eee" }}>
            {sel?.waFrom ? <b>{sel.waFrom}</b> : <span style={{ color: "#666" }}>Seleccioná un hilo para comenzar</span>}
          </div>

          <div style={{ padding: 12, overflowY: "auto", background: "#fcfcfc" }}>
            {sel?.waFrom && msgs.length === 0 && (
              <div style={{ color: "#888" }}>Sin mensajes…</div>
            )}
            {msgs.map((m) => (
              <div key={m.id} style={{ display: "flex", justifyContent: m.direction === "in" ? "flex-start" : "flex-end", margin: "6px 0" }}>
                <div style={{
                  maxWidth: "70%",
                  borderRadius: 12,
                  padding: "8px 10px",
                  background: m.direction === "in" ? "white" : "#d1fae5",
                  border: "1px solid #eee",
                  whiteSpace: "pre-wrap"
                }}>
                  <div style={{ fontSize: 12, color: "#666" }}>
                    {m.direction === "in" ? "Paciente" : "Operador"} • {new Date(m.ts).toLocaleString()}
                  </div>
                  <div>{m.body}</div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ padding: 10, borderTop: "1px solid #eee", display: "flex", gap: 8 }}>
            <input
              placeholder="Escribí la respuesta…"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              disabled={!sel?.waFrom}
              style={{ flex: 1, padding: 10, borderRadius: 10, border: "1px solid #ddd" }}
            />
            <button onClick={sendReply} disabled={!sel?.waFrom || sending}>
              {sending ? "Enviando…" : "Enviar"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
