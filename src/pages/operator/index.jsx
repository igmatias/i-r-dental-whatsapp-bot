import { useEffect, useMemo, useRef, useState } from 'react'

// Colores bordó/rojo/gris/negro
const colors = {
  bg: '#0f0f10',
  card: '#17171a',
  bordó: '#6b0f1a',
  rojo: '#d7263d',
  gris: '#9aa0a6',
  grisOsc: '#2a2a2e',
  negro: '#0b0b0c',
  verde: '#11a36a'
}

const SECRET = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('secret') : ''
const API = '/api/wsp/webhook'

export default function Operator() {
  const [chats, setChats] = useState([])
  const [active, setActive] = useState(null) // wa seleccionado
  const [msgs, setMsgs] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef(null)

  // Poll chats
  useEffect(() => {
    let stop = false
    async function tick() {
      try {
        const res = await fetch(`${API}?secret=${encodeURIComponent(SECRET)}`)
        const j = await res.json()
        setChats(j?.chats || [])
      } catch (e) {}
      if (!stop) setTimeout(tick, 3500)
    }
    tick()
    return () => { stop = true }
  }, [])

  // Poll messages for active chat
  useEffect(() => {
    if (!active) return
    let stop = false
    async function load() {
      try {
        const url = `${API}?secret=${encodeURIComponent(SECRET)}&wa=${encodeURIComponent(active)}&limit=200`
        const res = await fetch(url)
        const j = await res.json()
        const arr = (j?.messages || []).map(m => ({
          ...m,
          // normaliza
          dir: m.direction || m.dir,
          text: m.text || '',
          ts: m.ts || Date.now()
        }))
        setMsgs(arr)
        requestAnimationFrame(() => { try { scrollRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' }) } catch {} })
      } catch (e) {}
      if (!stop) setTimeout(load, 2000)
    }
    load()
    return () => { stop = true }
  }, [active])

  // UX: auto-activar primer chat
  useEffect(() => {
    if (!active && chats?.length) setActive(chats[0].wa)
  }, [chats, active])

  async function send() {
    if (!input.trim() || !active) return
    const body = { op: 'send', secret: SECRET, wa: active, text: input.trim() }
    setLoading(true)
    try {
      await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      setInput('')
    } catch (e) {}
    setLoading(false)
  }

  function renderBubble(m, i) {
    const isOut = m.dir === 'out'
    return (
      <div key={m.id || i} style={{
        display: 'flex',
        justifyContent: isOut ? 'flex-end' : 'flex-start',
        margin: '6px 0'
      }}>
        <div style={{
          maxWidth: 620,
          padding: '10px 12px',
          borderRadius: 14,
          background: isOut ? colors.rojo : colors.grisOsc,
          color: '#fff',
          boxShadow: '0 2px 8px rgba(0,0,0,.25)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        }}>
          <div style={{ fontSize: 12, opacity: .7, marginBottom: 4 }}>{new Date(m.ts).toLocaleString()}</div>
          <div style={{ fontSize: 15, lineHeight: 1.35 }}>{m.text || ''}</div>
          {!!m.buttons?.length && (
            <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {m.buttons.map((b, idx) => (
                <span key={idx} style={{
                  border: '1px solid rgba(255,255,255,.3)',
                  padding: '4px 8px',
                  borderRadius: 10,
                  fontSize: 12,
                  opacity: .9
                }}>{b}</span>
              ))}
            </div>
          )}
          {!!m.file && (
            <div style={{ marginTop: 8 }}>
              <a href={m.file} target="_blank" rel="noreferrer" style={{ color: '#fff', textDecoration: 'underline' }}>
                Abrir archivo
              </a>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', height: '100vh', background: colors.bg, color: '#fff' }}>
      <aside style={{ borderRight: `1px solid ${colors.grisOsc}`, padding: 12, overflowY: 'auto' }}>
        <div style={{ fontWeight: 700, fontSize: 18, color: colors.rojo, marginBottom: 10 }}>i-R Dental — Operador</div>
        {chats.map(c => (
          <div key={c.wa} onClick={() => setActive(c.wa)} style={{
            padding: '10px 12px', marginBottom: 8, borderRadius: 12,
            background: active === c.wa ? colors.bordó : colors.card,
            cursor: 'pointer', border: `1px solid ${colors.grisOsc}`
          }}>
            <div style={{ fontWeight: 600 }}>{c.wa}</div>
            <div style={{ fontSize: 12, color: colors.gris }}>{new Date(c.ts).toLocaleString()}</div>
          </div>
        ))}
      </aside>

      <main style={{ display: 'grid', gridTemplateRows: '1fr auto', height: '100%', overflow: 'hidden' }}>
        <div ref={scrollRef} style={{ padding: 16, overflowY: 'auto', background: '#121214' }}>
          {!msgs.length && (
            <div style={{ color: colors.gris, textAlign: 'center', marginTop: 40 }}>
              No hay mensajes para este chat.
            </div>
          )}
          {msgs.map(renderBubble)}
        </div>
        <div style={{ display: 'flex', gap: 8, padding: 12, borderTop: `1px solid ${colors.grisOsc}`, background: colors.card }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') send() }}
            placeholder="Escribí un mensaje para el paciente…"
            style={{ flex: 1, padding: '12px 14px', borderRadius: 12, border: '1px solid #333', background: '#0e0e10', color: '#fff' }}
          />
          <button onClick={send} disabled={loading || !input.trim()}
            style={{ padding: '12px 16px', borderRadius: 12, background: colors.rojo, border: 'none', color: '#fff', fontWeight: 700 }}>
            Enviar
          </button>
        </div>
      </main>
    </div>
  )
}
