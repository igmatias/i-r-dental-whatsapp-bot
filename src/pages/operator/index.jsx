import { useEffect, useRef, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_OPERATOR_BASE || ''; // same origin
const DEFAULT_SECRET =
  typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('secret') || 'irdental2025'
    : 'irdental2025';

function cls(...a) {
  return a.filter(Boolean).join(' ');
}
function withPlus(wa){ return wa?.startsWith('+') ? wa : `+${wa}` }

export default function OperatorConsole() {
  const [secret, setSecret] = useState(DEFAULT_SECRET);
  const [chats, setChats] = useState([]);
  const [activeWa, setActiveWa] = useState(null);
  const [messages, setMessages] = useState([]);
  const [pollMs, setPollMs] = useState(2000);
  const [outText, setOutText] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  // Poll chats
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch(`${API_BASE}/api/wsp/webhook?secret=${encodeURIComponent(secret)}`);
        if (!res.ok) {
          const t = await res.text().catch(()=> '');
          console.warn('fetch chats failed', res.status, t);
          throw new Error('fetch chats failed');
        }
        const data = await res.json();
        if (!alive) return;
        const list = Array.isArray(data.chats) ? data.chats : [];
        setChats(list);
        if (!activeWa && list[0]?.wa) setActiveWa(withPlus(list[0].wa));
      } catch (_err) {
        // silent
      }
    }
    load();
    const id = setInterval(load, Math.max(1500, pollMs));
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [secret, pollMs, activeWa]);

  // Poll messages for active chat
  useEffect(() => {
    if (!activeWa) return;
    let alive = true;
    async function load() {
      try {
        const res = await fetch(
          `${API_BASE}/api/wsp/webhook?secret=${encodeURIComponent(secret)}&wa=${encodeURIComponent(
            withPlus(activeWa)
          )}&limit=300`
        );
        if (!res.ok) {
          const t = await res.text().catch(()=> '');
          console.warn('fetch messages failed', res.status, t);
          throw new Error('fetch messages failed');
        }
        const data = await res.json();
        if (!alive) return;
        const list = Array.isArray(data.messages) ? data.messages : [];
        // claves estables para evitar flicker
        const keyed = list.map((m, i) => ({ ...m, _key: m.id || `${String(m.ts || 0)}-${i}` }));
        // merge incremental (no reemplazar array completo) + ordenar por ts
        setMessages((prev) => {
          const map = new Map();
          for (const m of prev) map.set(m._key, m);
          for (const m of keyed) map.set(m._key, m);
          return Array.from(map.values()).sort((a, b) => (a.ts || 0) - (b.ts || 0));
        });
        // autoscroll
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTo({ top: 1e9, behavior: 'smooth' });
        });
      } catch (_err) {
        // silent
      }
    }
    load();
    const id = setInterval(load, Math.max(1200, pollMs));
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [secret, activeWa, pollMs]);

  async function sendOutgoing() {
    if (!activeWa || !outText.trim() || sending) return;
    setSending(true);
    try {
      const res = await fetch(`${API_BASE}/api/wsp/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          op: 'send',
          secret,
          wa: withPlus(activeWa), // waKey (normalizado) — el server busca el wa_raw o hace fallback
          text: outText.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error('send failed', data);
      } else {
        setOutText('');
        // No hace falta push optimista: el server ya persiste 'out' optimista y real
      }
    } catch (e) {
      console.error('send error', e);
    } finally {
      setSending(false);
    }
  }

  function onEnter(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendOutgoing();
    }
  }

  const palette = {
    bordo: '#6b0f1a',
    rojo: '#c1121f',
    gris: '#2b2d42',
    negro: '#0b0b0d',
    grisClaro: '#edf2f4',
  };

  return (
    <div
      className="min-h-screen"
      style={{ background: `linear-gradient(180deg, ${palette.negro} 0%, ${palette.gris} 100%)` }}
    >
      <style>{`
        *{ box-sizing:border-box; }
        body{ margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica Neue, Arial; }
        .w-full{ width:100%; }
        .text-left{ text-align:left; }
      `}</style>

      <header
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid #1f1f22',
          background: palette.negro,
          color: '#fff',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 8, height: 24, borderRadius: 4, background: palette.rojo }} />
          <div style={{ fontWeight: 600, fontSize: 18 }}>i-R Dental · Consola de Operador</div>
          <div
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
            }}
          >
            <input
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="OPERATOR_SECRET"
              style={{
                padding: '6px 8px',
                borderRadius: 8,
                background: 'rgba(0,0,0,.4)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,.1)',
              }}
            />
            <select
              value={pollMs}
              onChange={(e) => setPollMs(Number(e.target.value))}
              style={{
                padding: '6px 8px',
                borderRadius: 8,
                background: 'rgba(0,0,0,.4)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,.1)',
              }}
            >
              <option value={1200}>1.2s</option>
              <option value={2000}>2s</option>
              <option value={3000}>3s</option>
              <option value={5000}>5s</option>
            </select>
          </div>
        </div>
      </header>

      <main style={{ display: 'grid', gridTemplateColumns: '320px 1fr', minHeight: 'calc(100vh - 56px)' }}>
        <aside style={{ borderRight: '1px solid #1f1f22', background: palette.gris }}>
          <div style={{ padding: '8px', fontSize: 12, color: 'rgba(255,255,255,.7)' }}>Chats recientes</div>
          <div>
            {chats.map((c) => (
              <button
                key={c.wa}
                onClick={() => setActiveWa(withPlus(c.wa))}
                className={cls('w-full', 'text-left')}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '12px 12px',
                  color: '#fff',
                  background: activeWa === withPlus(c.wa) ? 'rgba(255,255,255,.1)' : 'transparent',
                  border: '0',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 600 }}>{withPlus(c.wa)}</div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,.6)' }}>
                  {new Date(c.ts).toLocaleString()}
                </div>
              </button>
            ))}
            {chats.length === 0 && (
              <div style={{ padding: '24px 12px', color: 'rgba(255,255,255,.6)', fontSize: 14 }}>Sin chats aún…</div>
            )}
          </div>
        </aside>

        <section style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              padding: '8px 16px',
              borderBottom: '1px solid #1f1f22',
              background: palette.gris,
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <div style={{ width: 8, height: 16, borderRadius: 4, background: palette.bordo }} />
            <div style={{ fontWeight: 600 }}>{activeWa || 'Seleccioná un chat'}</div>
          </div>

          {/* mini debug opcional */}
          <div style={{ padding: '4px 16px', color: 'rgba(255,255,255,.5)', fontSize: 11 }}>
            consultando: {activeWa || '(sin wa)'}
          </div>

          <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: 16, background: palette.negro }}>
            {messages.map((m) => (
              <div
                key={m._key}
                style={{
                  maxWidth: '70%',
                  marginBottom: 8,
                  padding: '12px',
                  borderRadius: 16,
                  background: m.direction === 'in' ? '#1f2937' : palette.rojo,
                  color: '#fff',
                  marginLeft: m.direction === 'in' ? 0 : 'auto',
                  marginRight: m.direction === 'in' ? 'auto' : 0,
                }}
              >
                <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6 }}>
                  {new Date(m.ts).toLocaleString()}
                </div>

                {/* Texto principal */}
                {m.text && (
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</div>
                )}

                {/* Botones/lista como chips */}
                {Array.isArray(m.buttons) && m.buttons.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                    {m.buttons.map((b, i) => (
                      <span
                        key={i}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 999,
                          background: 'rgba(0,0,0,.25)',
                          border: '1px solid rgba(255,255,255,.25)',
                          fontSize: 12,
                        }}
                      >
                        {b}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {messages.length === 0 && <div style={{ color: 'rgba(255,255,255,.6)' }}>No hay mensajes para este chat.</div>}
          </div>

          {/* Input de salida */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 120px',
              gap: 8,
              padding: '10px 16px',
              borderTop: '1px solid #1f1f22',
              background: palette.gris,
            }}
          >
            <textarea
              value={outText}
              onChange={(e) => setOutText(e.target.value)}
              onKeyDown={onEnter}
              placeholder={activeWa ? `Mensaje a ${activeWa}` : 'Seleccioná un chat'}
              rows={2}
              style={{
                resize: 'none',
                padding: '10px 12px',
                borderRadius: 10,
                background: '#111',
                color: '#fff',
                border: '1px solid rgba(255,255,255,.15)',
                outline: 'none',
              }}
            />
            <button
              onClick={sendOutgoing}
              disabled={!activeWa || !outText.trim() || sending}
              style={{
                border: 0,
                borderRadius: 10,
                background: sending ? 'rgba(193,18,31,.5)' : '#c1121f',
                color: '#fff',
                fontWeight: 600,
                cursor: !activeWa || !outText.trim() || sending ? 'not-allowed' : 'pointer',
              }}
            >
              {sending ? 'Enviando…' : 'Enviar'}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
