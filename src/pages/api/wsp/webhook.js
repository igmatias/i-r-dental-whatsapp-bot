// ==============================================
// WhatsApp webhook + Operator feed (GET/POST) + fallbacks
// - Upstash Redis (historial LPUSH/LRANGE, índice ZSET)
// - Botones interactivos + fallback en texto numerado
// - Flujo “Envío de estudio” con pasos
// - GET debug=1 / probe=1 para diagnóstico rápido
// ==============================================

import { Redis } from '@upstash/redis'

export const config = { api: { bodyParser: false } }

// --- ENV ---
const {
  OPERATOR_SECRET = 'irdental2025',
  WHATSAPP_PHONE_ID,
  WHATSAPP_TOKEN,
  WSP_VERIFY_TOKEN,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  TEST_RECIPIENT_FORMAT = 'no9', // 'no9' (sin 9) | 'with9' | ''
} = process.env

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN })

// Compat: si no existe zrevrange, emular con zrange rev:true
if (typeof redis.zrevrange !== 'function') {
  redis.zrevrange = async (key, start, stop, opts = {}) => {
    return await redis.zrange(key, start, stop, { ...opts, rev: true })
  }
}

// --- Keys ---
const kSess  = (wa) => `sess:${wa}`
const kMsgs  = (wa) => `chat:${wa}:messages`
const kSeen  = (wa) => `seen:${wa}`
const kChats = 'chats:index'
const kWaRaw = (wa) => `waid:${wa}`

// --- Util ---
const ensurePlus = (wa) => (wa?.startsWith('+') ? wa : `+${wa}`)
function flowLog(tag, obj) { console.log(`FLOW_${tag} →`, typeof obj === 'string' ? obj : JSON.stringify(obj)) }
async function readBody(req) {
  const chunks = []; for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8') || '{}'
  try { return { raw, json: JSON.parse(raw) } } catch { return { raw, json: {} } }
}
function normalizeWaKey(waId) {
  let id = waId || ''
  if (!id) return null
  if (!id.startsWith('+')) id = '+' + id
  if (TEST_RECIPIENT_FORMAT === 'with9') id = id.replace(/^\+54(?!9)/, '+549')
  if (TEST_RECIPIENT_FORMAT === 'no9')   id = id.replace(/^\+549/, '+54')
  return id
}
function sanitizeToE164NoPlus(rawDigits) {
  let to = String(rawDigits || '').replace(/\D/g, '')
  if (to.startsWith('549')) to = '54' + to.slice(3) // quitar 9
  return to
}

// --- Sesiones ---
async function getSession(wa) {
  const raw = await redis.get(kSess(wa))
  try { return raw ? JSON.parse(raw) : { state: 'idle', step: 0 } }
  catch { return { state: 'idle', step: 0 } }
}
async function setSession(wa, sess) { return redis.set(kSess(wa), JSON.stringify(sess)) }

// --- Persistencia de mensajes ---
async function appendMessage(waKey, msg) {
  const key = ensurePlus(waKey)
  const listKey = kMsgs(key)
  const now = msg.ts || Date.now()
  try {
    const len = await redis.lpush(listKey, JSON.stringify({ ...msg, ts: now }))
    await redis.ltrim(listKey, 0, 499)
    await redis.zadd(kChats, { score: now, member: key })
    flowLog('APPEND_MSG', { listKey, lenAfterLpush: len, dir: msg.direction, text: (msg.text||'').slice(0, 60) })
    return { ok: true, listKey }
  } catch (e) {
    flowLog('APPEND_ERR', { listKey, err: String(e) })
    return { ok: false, listKey, err: String(e) }
  }
}

// --- Feed (variantes + SCAN fallback) ---
async function getHistory(waInput, limit = 100) {
  const raw = String(waInput || '').trim()
  const withPlus = raw.startsWith('+') ? raw : `+${raw}`
  const noPlus = withPlus.slice(1)
  const argentinaNo9 = withPlus.replace(/^\+549/, '+54')
  const argentina9 = withPlus.replace(/^\+54(?!9)/, '+549')

  const variants = Array.from(new Set([withPlus, noPlus, argentinaNo9, argentina9])).filter(Boolean)
  let all = []
  let hitKeys = []

  // 1) variantes directas
  for (const v of variants) {
    const k = v.startsWith('+') ? v : `+${v}`
    const listKey = kMsgs(k)
    try {
      const arr = await redis.lrange(listKey, 0, limit - 1)
      const parsed = (arr || []).map(s => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)
      if (parsed.length) { all = all.concat(parsed); hitKeys.push(listKey) }
    } catch (e) { flowLog('FEED_HISTORY_ERR', { stage: 'variants', listKey, err: String(e) }) }
  }

  // 2) SCAN si nada
  if (!all.length) {
    try {
      const digits = withPlus.replace(/\D/g, '')
      const needleShort = digits.slice(-7)
      const needleNo9 = digits.replace(/^549/, '54')
      const needle9 = digits.replace(/^54(?!9)/, '549')
      let cursor = 0
      do {
        const [next, keys] = await redis.scan(cursor, { match: 'chat:*:messages', count: 200 })
        cursor = Number(next) || 0
        for (const listKey of (keys || [])) {
          const s = String(listKey)
          if (
            s.includes(needleShort) || s.includes(needleNo9) || s.includes(needle9) ||
            s.includes(withPlus.replace('+', '')) || s.includes(noPlus)
          ) {
            try {
              const arr = await redis.lrange(s, 0, limit - 1)
              const parsed = (arr || []).map(x => { try { return JSON.parse(x) } catch { return null } }).filter(Boolean)
              if (parsed.length) { all = all.concat(parsed); hitKeys.push(s) }
            } catch (e) { flowLog('FEED_HISTORY_ERR', { stage: 'scan-read', listKey: s, err: String(e) }) }
          }
        }
      } while (cursor !== 0)
    } catch (e) { flowLog('FEED_HISTORY_ERR', { stage: 'scan', err: String(e) }) }
  }

  all.sort((a, b) => (a.ts || 0) - (b.ts || 0))
  if (all.length > limit) all = all.slice(-limit)
  flowLog('FEED_HISTORY_MERGE', { wa: withPlus, total: all.length, hitKeys })
  return { messages: all, hitKeys }
}

async function alreadyProcessed(wa, messageId) {
  const last = await redis.get(kSeen(wa))
  if (last === messageId) return true
  await redis.set(kSeen(wa), messageId)
  return false
}

// --- Envío a WhatsApp (con fallback) ---
async function sendJson(toRawDigits, payload, storeKey, label = 'SEND_JSON') {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    flowLog('SEND_GUARD', { error: 'Missing WhatsApp env', WHATSAPP_PHONE_ID: !!WHATSAPP_PHONE_ID, WHATSAPP_TOKEN: !!WHATSAPP_TOKEN })
    return { ok: false, status: 500, data: { error: 'Missing env' } }
  }
  const to = sanitizeToE164NoPlus(toRawDigits)
  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, ...payload })
  })
  let data = {}
  try { data = await res.json() } catch {}
  flowLog(label, { to, status: res.status, data })

  // snapshot OUT para consola
  try {
    const outId = data?.messages?.[0]?.id || `out-${Date.now()}`
    const snap = { id: outId, from: storeKey, direction: 'out', ts: Date.now() }
    if (payload.type === 'text') snap.text = payload.text?.body || ''
    if (payload.type === 'interactive') {
      const i = payload.interactive || {}
      snap.text = i?.body?.text || snap.text || ''
      if (i.type === 'button') {
        snap.buttons = (i.action?.buttons || []).map(b => b?.reply?.title).filter(Boolean)
      }
      if (i.type === 'list') {
        const it = []
        for (const s of i.action?.sections || []) for (const r of s?.rows || []) it.push(r?.title)
        snap.buttons = it
      }
    }
    await appendMessage(storeKey, snap)
  } catch {}

  return { ok: res.ok, status: res.status, data }
}

const sendText = (to, body, storeKey) =>
  sendJson(to, { type: 'text', text: { body } }, storeKey, 'SEND_TEXT')

const sendButtons = async (to, body, buttons, storeKey) => {
  const payload = {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body || '' },
      action: {
        buttons: buttons.slice(0, 3).map((b, i) => ({
          type: 'reply',
          reply: { id: b.id || `btn_${i}`, title: b.title || `Opción ${i + 1}` }
        }))
      }
    }
  }
  const r = await sendJson(to, payload, storeKey, 'SEND_BUTTONS')

  // Fallback si falla enviar botones (fuera de 24h, etc.)
  if (!r.ok) await sendMenuTextFallback(to, storeKey)
  return r
}

const sendMenuTextFallback = async (to, storeKey) => {
  const text =
`Menú (texto):
1) 📍 Sedes
2) 🧾 Estudios
3) 💳 Obras sociales
4) 📤 Envío de estudio
5) 📎 Subir orden
6) 👤 Operador

Respondé con el número de la opción.`
  await sendText(to, text, storeKey)
}

const sendList = async (to, body, sections, storeKey) => {
  const r = await sendJson(to, { type: 'interactive', interactive: { type: 'list', body: { text: body || '' }, action: { button: 'Ver opciones', sections } } }, storeKey, 'SEND_LIST')
  if (!r.ok) await sendMenuTextFallback(to, storeKey)
  return r
}

// --- Textos base ---
const HOURS = `🕒 Horarios (todas las sedes)
• Lunes a viernes: 09:00 a 17:30
• Sábados: 09:00 a 12:30`
const NO_TURNO = `📌 Atención SIN TURNO, por orden de llegada.`
const LINKS = {
  QUILMES: 'https://maps.google.com/?q=i-R+Dental+Quilmes',
  AVELL: 'https://maps.google.com/?q=i-R+Dental+Avellaneda',
  LOMAS: 'https://maps.google.com/?q=i-R+Dental+Lomas',
}
const SEDES = {
  QUILMES: { title: 'Sede Quilmes — i-R Dental', dir: 'Moreno 851 — 1° B', tel: '4257-3638', mail: 'quilmes@irdental.com.ar', link: LINKS.QUILMES },
  AVELL: { title: 'Sede Avellaneda — i-R Dental', dir: '9 de Julio 64 — 2° A', tel: '4222-5553', mail: 'avellaneda@irdental.com.ar', link: LINKS.AVELL },
  LOMAS: { title: 'Sede Lomas de Zamora — i-R Dental', dir: 'España 156 — PB', tel: '4244-0148', mail: 'lomas@irdental.com.ar', link: LINKS.LOMAS },
}
const TXT_ESTUDIOS = `🧾 Estudios i-R Dental:
• Panorámica (OPG)
• Cefalométrica (lateral/PA)
• Periapicales
• Oclusales
• Serie completa
• ATM básica
• CBCT / Tomografía (si corresponde)
• Fotografías intra/extraorales (si corresponde)

✅ SIN TURNO, por orden de llegada.`
const TXT_OBRAS = `💳 Obras sociales activas:
AMFFA, ANSSAL APDIS, APESA SALUD, CENTRO MEDICO PUEYRREDON, COLEGIO DE FARMACÉUTICOS, DASMI, DASUTeN, FEDERADA, GALENO*, IOMA*, IOSFA, MEDICUS*, OMINT*, OSDE*, OSECAC, OSPACA, OSPE, OSPERYHRA, PAMI, PREMEDIC, SIMECO, SWISS MEDICAL*.
(*) Algunas con requisitos de orden/diagnóstico.
⚠️ Este listado puede cambiar. Consultá por WhatsApp, teléfono o mail.`

// --- Validaciones ---
const isValidDni = (s) => /^[0-9]{6,9}$/.test((s || '').replace(/\D/g, ''))
function normalizeDate(s) {
  const t = (s || '').trim()
  const ddmmyyyy = /^([0-3]?\d)\/([01]?\d)\/(\d{4})$/
  const yyyymmdd = /^(\d{4})-(\d{2})-(\d{2})$/
  if (ddmmyyyy.test(t)) { const [, d, m, y] = t.match(ddmmyyyy); return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` }
  if (yyyymmdd.test(t)) return t
  return null
}

// --- Flujo Envío de estudio ---
async function flowStart(wa) {
  await setSession(wa, { state: 'envio_estudio', step: 'APELLIDO', data: { apellido: '', nombre: '', dni: '', fechaNac: '', estudio: '', sede: '', via: '', email: '' }, startedAt: Date.now() })
}
async function flowEnd(wa) { await setSession(wa, { state: 'idle', step: 0 }) }

async function promptNext(waRaw, wa) {
  const s = await getSession(wa)
  if (!s || s.state !== 'envio_estudio') return
  switch (s.step) {
    case 'APELLIDO':     await sendText(waRaw, '✍️ Ingresá el **apellido** del paciente:', wa); break
    case 'NOMBRE':       await sendText(waRaw, 'Ahora ingresá el **nombre** del paciente:', wa); break
    case 'DNI':          await sendText(waRaw, 'Ingresá el **DNI** (solo números):', wa); break
    case 'FECHA_NAC':    await sendText(waRaw, 'Ingresá la **fecha de nacimiento** (DD/MM/AAAA o AAAA-MM-DD):', wa); break
    case 'ESTUDIO':      await sendText(waRaw, '¿Qué **estudio** se realizó? (ej.: Panorámica OPG)', wa); break
    case 'SEDE':
      await sendButtons(waRaw, 'Elegí la **sede** donde se realizó:', [
        { id: 'EV_SEDE_QUILMES', title: 'Quilmes' },
        { id: 'EV_SEDE_AVELL', title: 'Avellaneda' },
        { id: 'EV_SEDE_LOMAS', title: 'Lomas' },
      ], wa); break
    case 'VIA':
      await sendButtons(waRaw, '¿Por dónde querés recibirlo?', [
        { id: 'EV_VIA_WSP', title: 'WhatsApp' },
        { id: 'EV_VIA_EMAIL', title: 'Email' },
      ], wa); break
    case 'EMAIL_IF_NEEDED':
      await sendText(waRaw, 'Indicá tu **correo electrónico**:', wa); break
    case 'CONFIRM': {
      const d = s.data
      await sendButtons(waRaw,
        `Confirmá los datos:\n• Paciente: ${d.apellido}, ${d.nombre}\n• DNI: ${d.dni}\n• Nac.: ${d.fechaNac}\n• Estudio: ${d.estudio}\n• Sede: ${d.sede}\n• Vía: ${d.via}${d.email ? ` (${d.email})` : ''}`,
        [{ id: 'EV_CONFIRM_YES', title: '✅ Confirmar' }, { id: 'EV_CONFIRM_NO', title: '❌ Cancelar' }], wa)
      break
    }
    default: await flowEnd(wa); await sendText(waRaw, 'Listo. Si necesitás enviar un estudio, escribí: Envío de estudio', wa)
  }
}
async function handleEnvioText(waRaw, wa, rawBody) {
  const s = await getSession(wa)
  if (!s || s.state !== 'envio_estudio') return false
  const body = (rawBody || '').trim()
  if (/^(cancelar|salir|menu|menú)$/i.test(body)) {
    await flowEnd(wa); await sendText(waRaw, 'Se canceló la solicitud. Te dejo el menú:', wa); await sendMainMenu(waRaw, wa); return true
  }
  switch (s.step) {
    case 'APELLIDO': s.data.apellido = body.toUpperCase(); s.step = 'NOMBRE'; await setSession(wa, s); await promptNext(waRaw, wa); return true
    case 'NOMBRE':   s.data.nombre = body.toUpperCase();   s.step = 'DNI';    await setSession(wa, s); await promptNext(waRaw, wa); return true
    case 'DNI': {
      const digits = body.replace(/\D/g, '')
      if (!isValidDni(digits)) { await sendText(waRaw, 'DNI no válido (6–9 dígitos).', wa); return true }
      s.data.dni = digits; s.step = 'FECHA_NAC'; await setSession(wa, s); await promptNext(waRaw, wa); return true
    }
    case 'FECHA_NAC': {
      const norm = normalizeDate(body)
      if (!norm) { await sendText(waRaw, 'Usá DD/MM/AAAA o AAAA-MM-DD.', wa); return true }
      s.data.fechaNac = norm; s.step = 'ESTUDIO'; await setSession(wa, s); await promptNext(waRaw, wa); return true
    }
    case 'ESTUDIO': s.data.estudio = body; s.step = 'SEDE'; await setSession(wa, s); await promptNext(waRaw, wa); return true
    case 'EMAIL_IF_NEEDED': {
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body)
      if (!ok) { await sendText(waRaw, 'Email no válido.', wa); return true }
      s.data.email = body; s.step = 'CONFIRM'; await setSession(wa, s); await promptNext(waRaw, wa); return true
    }
  }
  return false
}
async function handleEnvioButton(waRaw, wa, btnIdOrTitle) {
  const s = await getSession(wa)
  if (!s || s.state !== 'envio_estudio') return false
  const sel = (btnIdOrTitle || '').toUpperCase()
  switch (s.step) {
    case 'SEDE':
      if (/EV_SEDE_QUILMES|QUILMES/.test(sel)) { s.data.sede = 'quilmes'; s.step = 'VIA' }
      else if (/EV_SEDE_AVELL|AVELLANEDA/.test(sel)) { s.data.sede = 'avellaneda'; s.step = 'VIA' }
      else if (/EV_SEDE_LOMAS|LOMAS/.test(sel)) { s.data.sede = 'lomas'; s.step = 'VIA' }
      else { await sendText(waRaw, 'Elegí una opción de los botones, por favor.', wa); return true }
      await setSession(wa, s); await promptNext(waRaw, wa); return true
    case 'VIA':
      if (/EV_VIA_WSP|WHATSAPP/.test(sel)) { s.data.via = 'WhatsApp'; s.step = 'CONFIRM' }
      else if (/EV_VIA_EMAIL|EMAIL/.test(sel)) { s.data.via = 'Email'; s.step = 'EMAIL_IF_NEEDED' }
      else { await sendText(waRaw, 'Elegí una opción de los botones, por favor.', wa); return true }
      await setSession(wa, s); await promptNext(waRaw, wa); return true
    case 'CONFIRM':
      if (/EV_CONFIRM_YES|CONFIRMAR|SI|SÍ|OK|CORRECTO/.test(sel)) {
        await sendText(waRaw, '✅ Recibimos tu solicitud. Un/a operador/a la gestionará a la brevedad.', wa)
        await flowEnd(wa)
        await sendMainMenu(waRaw, wa)
        return true
      }
      if (/EV_CONFIRM_NO|CANCELAR/.test(sel)) {
        await flowEnd(wa)
        await sendText(waRaw, 'Solicitud cancelada. Te dejo el menú:', wa)
        await sendMainMenu(waRaw, wa)
        return true
      }
      await sendText(waRaw, 'Elegí una opción de los botones, por favor.', wa); return true
  }
  return false
}

// --- Menú principal (botones + fallback texto) ---
async function sendMainMenu(waRaw, wa) {
  const r1 = await sendButtons(waRaw, 'Menú (1/2): elegí una opción', [
    { id: 'MENU_SEDES',    title: '📍 Sedes' },
    { id: 'MENU_ESTUDIOS', title: '🧾 Estudios' },
    { id: 'MENU_OBRAS',    title: '💳 Obras sociales' },
  ], wa)
  const r2 = await sendButtons(waRaw, 'Menú (2/2): más opciones', [
    { id: 'MENU_ENVIO',       title: '📤 Envío de estudio' },
    { id: 'MENU_SUBIR_ORDEN', title: '📎 Subir orden' },
    { id: 'MENU_OPERADOR',    title: '👤 Operador' },
  ], wa)
  if (!r1.ok || !r2.ok) await sendMenuTextFallback(waRaw, wa)
}
function sedeInfo(key) {
  const s = SEDES[key]
  return `📍 ${s.title}
Dirección: ${s.dir}
Teléfono: ${s.tel}
Email: ${s.mail}
Cómo llegar: ${s.link}

${HOURS}

${NO_TURNO}`
}

// --- Router de menú + comandos numéricos ---
async function routeMenuSelection(waRaw, wa, selRaw) {
  const selUpper = (selRaw || '').toUpperCase()

  // Mapear menús de texto (1..6)
  if (/^\s*1\s*$/.test(selRaw)) return routeMenuSelection(waRaw, wa, 'MENU_SEDES')
  if (/^\s*2\s*$/.test(selRaw)) return routeMenuSelection(waRaw, wa, 'MENU_ESTUDIOS')
  if (/^\s*3\s*$/.test(selRaw)) return routeMenuSelection(waRaw, wa, 'MENU_OBRAS')
  if (/^\s*4\s*$/.test(selRaw)) return routeMenuSelection(waRaw, wa, 'MENU_ENVIO')
  if (/^\s*5\s*$/.test(selRaw)) return routeMenuSelection(waRaw, wa, 'MENU_SUBIR_ORDEN')
  if (/^\s*6\s*$/.test(selRaw)) return routeMenuSelection(waRaw, wa, 'MENU_OPERADOR')

  // Fuzzy: "envío de estudio"
  if (/ENV[IÍ]O.*ESTUDIO/.test(selUpper)) return routeMenuSelection(waRaw, wa, 'MENU_ENVIO')

  switch (selUpper) {
    case 'MENU':
    case 'MENÚ':
    case 'BTN_BACK_MENU':
      await sendMainMenu(waRaw, wa); return true

    case 'MENU_SEDES':
    case '📍 SEDES':
      await sendButtons(waRaw, 'Elegí una sede:', [
        { id: 'SEDE_QUILMES', title: 'Quilmes' },
        { id: 'SEDE_AVELL',   title: 'Avellaneda' },
        { id: 'SEDE_LOMAS',   title: 'Lomas' },
      ], wa); return true

    case 'SEDE_QUILMES':
    case 'QUILMES':
      await sendText(waRaw, sedeInfo('QUILMES'), wa); return true
    case 'SEDE_AVELL':
    case 'AVELLANEDA':
      await sendText(waRaw, sedeInfo('AVELL'), wa); return true
    case 'SEDE_LOMAS':
    case 'LOMAS':
      await sendText(waRaw, sedeInfo('LOMAS'), wa); return true

    case 'MENU_ESTUDIOS':
    case '🧾 ESTUDIOS':
      await sendText(waRaw, TXT_ESTUDIOS, wa); return true

    case 'MENU_OBRAS':
    case '💳 OBRAS SOCIALES':
      await sendText(waRaw, TXT_OBRAS, wa); return true

    case 'MENU_SUBIR_ORDEN':
    case '📎 SUBIR ORDEN':
      await sendText(waRaw, '📎 Adjuntá una foto clara de la orden médica. Un/a operador/a te confirmará la recepción.', wa); return true

    case 'MENU_OPERADOR':
    case '👤 OPERADOR':
      await sendText(waRaw, '👤 Derivando a operador. Te responderán a la brevedad.', wa); return true

    case 'MENU_ENVIO':
    case '📤 ENVÍO DE ESTUDIO':
    case '📤 ENVIO DE ESTUDIO':
      await flowStart(wa)
      await sendText(waRaw, 'Vamos a tomar los datos para enviar tu estudio. Podés escribir **cancelar** en cualquier momento.', wa)
      await promptNext(waRaw, wa)
      return true
  }
  return false
}

// --- Bienvenida ---
async function sendWelcome(waRaw, wa) {
  await sendText(waRaw, '¡Hola! 👋 Soy el asistente de i-R Dental.', wa)
  await sendMainMenu(waRaw, wa)
}

// --- Router principal ---
async function routeIncomingMessage(waRaw, wa, kind, payloadTextOrId, payloadTitle) {
  const sess = await getSession(wa)

  if (!sess || sess.state === 'idle') {
    if (kind === 'text') {
      const t = (payloadTextOrId || '').toLowerCase()
      const isCmd = /(envio|envío).*(estudio)/.test(t) || /^[1-6]$/.test(t)
      if (!isCmd) { await sendWelcome(waRaw, wa); return }
    }
  }

  if (kind === 'interactive') {
    const sel = payloadTextOrId || payloadTitle || ''
    flowLog('BTN_STEP', { wa, sel })
    if (await handleEnvioButton(waRaw, wa, sel)) return
    if (await routeMenuSelection(waRaw, wa, sel)) return
    await sendMainMenu(waRaw, wa); return
  }

  if (kind === 'text') {
    const text = payloadTextOrId || ''
    flowLog('TEXT_STEP', { wa, text })
    if (/(envio|envío).*(estudio)/i.test(text) || /^[1-6]$/.test((text || '').trim())) {
      await routeMenuSelection(waRaw, wa, text); return
    }
    if (await handleEnvioText(waRaw, wa, text)) return
    await sendText(waRaw, 'Para iniciar, tocá un botón del menú o respondé con un número (1..6).', wa)
    await sendMainMenu(waRaw, wa)
    return
  }
}

// --- Handler ---
export default async function handler(req, res) {
  // GET: verificación Meta + feed operador
  if (req.method === 'GET') {
    const mode = req.query['hub.mode']
    const token = req.query['hub.verify_token']
    const challenge = req.query['hub.challenge']
    if (mode === 'subscribe') {
      if (token === WSP_VERIFY_TOKEN) return res.status(200).send(challenge)
      return res.status(403).send('Forbidden')
    }

    const { secret, wa, limit = '100' } = req.query || {}
    if (secret !== OPERATOR_SECRET) return res.status(401).json({ error: 'unauthorized' })

    if (wa) {
      const lim = parseInt(limit, 10) || 100

      // PROBE: escribe 2 mensajes de prueba y lee
      if (req.query.probe === '1') {
        const w = ensurePlus(wa)
        const now = Date.now()
        const a = await appendMessage(w, { id: `probe-in-${now}`, from: w, direction: 'in', text: `[probe IN ${now}]`, ts: now })
        const b = await appendMessage(w, { id: `probe-out-${now}`, from: w, direction: 'out', text: `[probe OUT ${now}]`, ts: now + 1 })
        const { messages, hitKeys } = await getHistory(w, lim)
        return res.status(200).json({ wa: w, probe: { wroteTo: [a.listKey, b.listKey], writeOk: !!(a.ok && b.ok) }, found: { hitKeys, count: messages.length }, sample: messages.slice(-3) })
      }

      // DEBUG: lista claves candidatas + conteos
      if (req.query.debug === '1') {
        try {
          const raw = String(wa || '').trim()
          const withPlus = raw.startsWith('+') ? raw : `+${raw}`
          const digits = withPlus.replace(/\D/g, '')
          const needleShort = digits.slice(-7)
          const needleNo9 = digits.replace(/^549/, '54')
          const needle9 = digits.replace(/^54(?!9)/, '549')

          let cursor = 0, keys = []
          do {
            const [next, k] = await redis.scan(cursor, { match: 'chat:*:messages', count: 200 })
            cursor = Number(next) || 0; keys.push(...(k || []))
          } while (cursor !== 0)

          const candidates = keys.filter(k =>
            k.includes(needleShort) || k.includes(needleNo9) || k.includes(needle9) ||
            k.includes(withPlus.replace('+','')) || k.includes(withPlus)
          )
          const counts = {}
          for (const ck of candidates) {
            try { const arr = await redis.lrange(ck, 0, 2); counts[ck] = Array.isArray(arr) ? arr.length : 0 }
            catch (e) { counts[ck] = `ERR ${String(e)}` }
          }
          return res.status(200).json({ wa: withPlus, debug: { keysCount: keys.length, candidates, counts } })
        } catch (e) { return res.status(500).json({ wa, debugError: String(e) }) }
      }

      // normal
      const { messages, hitKeys } = await getHistory(wa, lim)
      flowLog('FEED_HISTORY', { wa, count: messages?.length || 0, last: messages?.[messages.length - 1], hitKeys })
      return res.status(200).json({ wa, messages })
    }

    const rows = await redis.zrange(kChats, 0, 49, { rev: true, withScores: true })
    const items = Array.isArray(rows) && rows.length && typeof rows[0] === 'object'
      ? rows.map(r => ({ wa: r.member, ts: Number(r.score) }))
      : (() => { const arr = []; for (let i = 0; i < rows.length; i += 2) arr.push({ wa: rows[i], ts: Number(rows[i + 1]) }); return arr })()
    return res.status(200).json({ chats: items })
  }

  // POST: operador o Meta webhook
  if (req.method === 'POST') {
    const { raw, json } = await readBody(req)

    // Operador: enviar texto
    if (json?.op === 'send') {
      const { secret, wa, text } = json || {}
      if (secret !== OPERATOR_SECRET) return res.status(401).json({ error: 'unauthorized' })
      if (!wa || !text) return res.status(400).json({ error: 'wa and text required' })

      const optimisticId = `out-local-${Date.now()}`
      await appendMessage(wa, { id: optimisticId, from: ensurePlus(wa), direction: 'out', text, ts: Date.now() })

      let waRaw = await redis.get(kWaRaw(ensurePlus(wa)))
      if (!waRaw) waRaw = ensurePlus(wa).replace(/^\+/, '')
      const r = await sendText(waRaw, text, ensurePlus(wa))
      if (!r.ok) await appendMessage(wa, { id: `${optimisticId}-err`, from: ensurePlus(wa), direction: 'out', text: `⚠️ Error envío: ${r.status}`, ts: Date.now() })
      return res.status(r.ok ? 200 : 500).json(r)
    }

    // Operador: (opcional) media por link
    if (json?.op === 'send-media') {
      const { secret, wa, mediaType, link, caption } = json || {}
      if (secret !== OPERATOR_SECRET) return res.status(401).json({ error: 'unauthorized' })
      if (!wa || !mediaType || !link) return res.status(400).json({ error: 'wa, mediaType, link required' })

      const optimisticId = `out-media-${Date.now()}`
      await appendMessage(wa, { id: optimisticId, from: ensurePlus(wa), direction: 'out', text: caption || `(${mediaType})`, ts: Date.now(), file: link })

      let waRaw = await redis.get(kWaRaw(ensurePlus(wa)))
      if (!waRaw) waRaw = ensurePlus(wa).replace(/^\+/, '')

      const payloadOk = mediaType === 'image'
        ? await sendJson(waRaw, { type:'image', image:{ link, caption: caption||'' } }, ensurePlus(wa), 'SEND_IMG')
        : await sendJson(waRaw, { type:'document', document:{ link, caption: caption||'' } }, ensurePlus(wa), 'SEND_DOC')

      if (!payloadOk.ok) await appendMessage(wa, { id: `${optimisticId}-err`, from: ensurePlus(wa), direction: 'out', text: `⚠️ Error envío media: ${payloadOk.status}`, ts: Date.now(), file: link })
      return res.status(payloadOk.ok ? 200 : 500).json(payloadOk)
    }

    // Meta webhook
    flowLog('WEBHOOK_BODY', raw)
    const entry = json?.entry?.[0]
    const change = entry?.changes?.[0]
    const value = change?.value
    if (!value) return res.status(200).json({ ok: true })

    if (Array.isArray(value.statuses) && value.statuses.length) {
      flowLog('STATUSES', value.statuses); return res.status(200).json({ ok: true })
    }

    const waIdRaw = value?.contacts?.[0]?.wa_id
    const waKey = normalizeWaKey(waIdRaw)
    const msg = value?.messages?.[0]
    if (!waKey || !msg) { flowLog('MISSING_MSG', { wa: waIdRaw, hasMsg: !!msg }); return res.status(200).json({ ok: true }) }

    if (waIdRaw) await redis.set(kWaRaw(waKey), waIdRaw)
    if (await alreadyProcessed(waKey, msg.id)) { flowLog('DUPLICATE', { wa: waKey, id: msg.id }); return res.status(200).json({ ok: true }) }

    const type = msg.type
    const ts = Number(msg.timestamp ? Number(msg.timestamp) * 1000 : Date.now())

    if (type === 'text') {
      const bodyIn = msg.text?.body || ''
      await appendMessage(waKey, { id: msg.id, from: waKey, direction: 'in', text: bodyIn, ts })
      await routeIncomingMessage(waIdRaw, waKey, 'text', bodyIn)
      return res.status(200).json({ ok: true })
    }

    if (type === 'interactive') {
      const selId = msg?.interactive?.button_reply?.id || msg?.interactive?.list_reply?.id || ''
      const selTitle = msg?.interactive?.button_reply?.title || msg?.interactive?.list_reply?.title || ''
      await appendMessage(waKey, { id: msg.id, from: waKey, direction: 'in', text: selId || selTitle, ts, type: 'interactive', meta: msg.interactive })
      if (await handleEnvioButton(waIdRaw, waKey, selId || selTitle)) return res.status(200).json({ ok: true })
      await routeIncomingMessage(waIdRaw, waKey, 'interactive', selId, selTitle)
      return res.status(200).json({ ok: true })
    }

    // otros tipos (media, etc.)
    await appendMessage(waKey, { id: msg.id, from: waKey, direction: 'in', text: `[${type}]`, ts })
    await sendText(waIdRaw, 'Recibimos tu mensaje. Tocá un botón o respondé con un número (1..6).', waKey)
    await sendMainMenu(waIdRaw, waKey)
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', ['GET', 'POST'])
  return res.status(405).send('Method Not Allowed')
}
