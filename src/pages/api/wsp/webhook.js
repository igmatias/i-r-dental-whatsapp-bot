// ==============================================
// File: src/pages/api/wsp/webhook.js
// Purpose: WhatsApp webhook + Operator feed (GET) + Operator SEND & SEND-MEDIA (POST)
// Notes:
//  - Redis Upstash: sesiones + historial (LPUSH/LRANGE) y zindex de chats
//  - Botones/lista: soporta ids y titles (fallback)
//  - Flujo “Envío de estudio” con pasos APELLIDO→…→CONFIRM
//  - Feed robusto: busca variantes de clave (+54 / +549 / sin +)
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

// Compat: si no existe zrevrange, emulamos con zrange rev:true
if (typeof redis.zrevrange !== 'function') {
  redis.zrevrange = async (key, start, stop, opts = {}) => {
    return await redis.zrange(key, start, stop, { ...opts, rev: true })
  }
}

// --- Keys ---
const kSess   = (wa) => `sess:${wa}`
const kMsgs   = (wa) => `chat:${wa}:messages`
const kSeen   = (wa) => `seen:${wa}`
const kChats  = 'chats:index'
const kWaRaw  = (wa) => `waid:${wa}` // último wa_id crudo (para enviar)

// --- Logs ---
function flowLog(tag, obj) {
  console.log(`FLOW_${tag} →`, typeof obj === 'string' ? obj : JSON.stringify(obj))
}

// --- Body reader ---
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8') || '{}'
  try { return { raw, json: JSON.parse(raw) } } catch { return { raw, json: {} } }
}

// --- Normalización números ---
function normalizeWaKey(waId) {
  let id = waId || ''
  if (!id) return null
  if (!id.startsWith('+')) id = '+' + id
  if (TEST_RECIPIENT_FORMAT === 'with9') id = id.replace(/^\+54(?!9)/, '+549')
  if (TEST_RECIPIENT_FORMAT === 'no9')   id = id.replace(/^\+549/, '+54')
  return id
}
function sanitizeToE164NoPlus(toRawDigits) {
  let to = String(toRawDigits || '').replace(/\D/g, '')
  if (to.startsWith('549')) to = '54' + to.slice(3) // quitar 9
  return to
}
function ensurePlus(wa) { return wa?.startsWith('+') ? wa : `+${wa}` }

// --- Sesiones ---
async function getSession(waKey) {
  const raw = await redis.get(kSess(waKey))
  try { return raw ? JSON.parse(raw) : { state: 'idle', step: 0 } }
  catch { return { state: 'idle', step: 0 } }
}
async function setSession(waKey, sess) {
  return await redis.set(kSess(waKey), JSON.stringify(sess))
}

// --- Persistencia consola ---
async function appendMessage(waKey, msg) {
  const key = ensurePlus(waKey)
  await redis.lpush(kMsgs(key), JSON.stringify(msg))
  await redis.ltrim(kMsgs(key), 0, 499)
  await redis.zadd(kChats, { score: msg.ts || Date.now(), member: key })
  flowLog('APPEND_MSG', { wa: key, dir: msg.direction, text: msg.text?.slice?.(0, 60), ts: msg.ts })
}

// --- FEED robusto: busca variantes de clave y mergea ---
async function getHistory(waKeyInput, limit = 100) {
  const raw = String(waKeyInput || '').trim()
  const withPlus = raw.startsWith('+') ? raw : `+${raw}`
  const noPlus   = withPlus.slice(1)
  const argentinaNo9 = withPlus.replace(/^\+549/, '+54')
  const argentina9   = withPlus.replace(/^\+54(?!9)/, '+549')

  const candidates = Array.from(new Set([
    withPlus, noPlus, argentinaNo9, argentina9,
  ])).filter(Boolean)

  let all = []
  for (const key of candidates) {
    const k = key.startsWith('+') ? key : `+${key}`
    try {
      const arr = await redis.lrange(kMsgs(k), 0, limit - 1)
      const parsed = (arr || []).map(s => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)
      if (parsed.length) all = all.concat(parsed)
    } catch (e) {
      flowLog('FEED_HISTORY_ERR', { waTried: k, err: String(e) })
    }
  }
  all.sort((a, b) => (a.ts || 0) - (b.ts || 0))
  if (all.length > limit) all = all.slice(-limit)
  flowLog('FEED_HISTORY_MERGE', { wa: withPlus, variants: candidates, total: all.length })
  return all
}

async function alreadyProcessed(waKey, messageId) {
  const last = await redis.get(kSeen(waKey))
  if (last === messageId) return true
  await redis.set(kSeen(waKey), messageId)
  return false
}

// --- Envíos base ---
async function sendJson(toRawDigits, payload, storeKey, label='SEND_JSON') {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    flowLog('SEND_GUARD', { error: 'Missing WhatsApp env', WHATSAPP_PHONE_ID: !!WHATSAPP_PHONE_ID, WHATSAPP_TOKEN: !!WHATSAPP_TOKEN })
    return { ok:false, status:500, data:{ error:'Missing env' } }
  }
  const to = sanitizeToE164NoPlus(toRawDigits)
  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', Authorization:`Bearer ${WHATSAPP_TOKEN}` },
    body: JSON.stringify({ messaging_product:'whatsapp', to, ...payload })
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
    if (payload.type === 'image')    { snap.text = payload.image?.caption || '(imagen)';    snap.file = payload.image?.link }
    if (payload.type === 'document') { snap.text = payload.document?.caption || '(documento)'; snap.file = payload.document?.link }
    await appendMessage(storeKey, snap)
  } catch {}
  return { ok: res.ok, status: res.status, data }
}

const sendText     = (to, body, storeKey) => sendJson(to, { type:'text', text:{ body } }, storeKey, 'SEND_TEXT')
const sendButtons  = (to, body, buttons, storeKey) => sendJson(to, {
  type:'interactive',
  interactive:{ type:'button', body:{ text: body || '' },
    action:{ buttons: buttons.slice(0,3).map((b,i)=>({ type:'reply', reply:{ id:b.id||`btn_${i}`, title:b.title||`Opción ${i+1}` } })) }
  }
}, storeKey, 'SEND_BUTTONS')
const sendList     = (to, body, sections, storeKey) => sendJson(to, {
  type:'interactive',
  interactive:{ type:'list', body:{ text: body||'' }, action:{ button:'Ver opciones', sections } }
}, storeKey, 'SEND_LIST')
const sendDocument = (to, link, caption, storeKey) => sendJson(to, { type:'document', document:{ link, caption } }, storeKey, 'SEND_DOC')
const sendImage    = (to, link, caption, storeKey) => sendJson(to, { type:'image',    image:{ link, caption } }, storeKey, 'SEND_IMG')

// --- Textos base y menús ---
const HOURS = `🕒 Horarios (todas las sedes)
• Lunes a viernes: 09:00 a 17:30
• Sábados: 09:00 a 12:30`
const NO_TURNO = `📌 Atención SIN TURNO, por orden de llegada.`
const LINKS = {
  QUILMES:'https://maps.google.com/?q=i-R+Dental+Quilmes',
  AVELL:  'https://maps.google.com/?q=i-R+Dental+Avellaneda',
  LOMAS:  'https://maps.google.com/?q=i-R+Dental+Lomas',
}
const SEDES = {
  QUILMES:{ title:'Sede Quilmes — i-R Dental', dir:'Moreno 851 — 1° B', tel:'4257-3638', mail:'quilmes@irdental.com.ar', link:LINKS.QUILMES },
  AVELL:  { title:'Sede Avellaneda — i-R Dental', dir:'9 de Julio 64 — 2° A', tel:'4222-5553', mail:'avellaneda@irdental.com.ar', link:LINKS.AVELL },
  LOMAS:  { title:'Sede Lomas de Zamora — i-R Dental', dir:'España 156 — PB', tel:'4244-0148', mail:'lomas@irdental.com.ar', link:LINKS.LOMAS },
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

async function sendMainMenuButtons(to, storeKey) {
  await sendButtons(to, 'Menú (1/2): elegí una opción', [
    { id:'MENU_SEDES',    title:'📍 Sedes' },
    { id:'MENU_ESTUDIOS', title:'🧾 Estudios' },
    { id:'MENU_OBRAS',    title:'💳 Obras sociales' },
  ], storeKey)
  await sendButtons(to, 'Menú (2/2): más opciones', [
    { id:'MENU_ENVIO',       title:'📤 Envío de estudio' },
    { id:'MENU_SUBIR_ORDEN', title:'📎 Subir orden' },
    { id:'MENU_OPERADOR',    title:'👤 Operador' },
  ], storeKey)
}
async function sendSedesButtons(to, storeKey) {
  return sendButtons(to, 'Elegí una sede para ver dirección y contacto:', [
    { id:'SEDE_QUILMES', title:'Quilmes' },
    { id:'SEDE_AVELL',   title:'Avellaneda' },
    { id:'SEDE_LOMAS',   title:'Lomas' },
  ], storeKey)
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

// --- Validaciones ---
function isValidDni(s) { return /^[0-9]{6,9}$/.test((s||'').replace(/\D/g,'')) }
function normalizeDate(s) {
  const t = (s||'').trim()
  const ddmmyyyy = /^([0-3]?\d)\/([01]?\d)\/(\d{4})$/
  const yyyymmdd = /^(\d{4})-(\d{2})-(\d{2})$/
  if (ddmmyyyy.test(t)) { const [,d,m,y]=t.match(ddmmyyyy); return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}` }
  if (yyyymmdd.test(t)) return t
  return null
}

// --- Flujo "Envío de estudio" ---
async function flowStart(waKey) {
  await setSession(waKey, { state:'envio_estudio', step:'APELLIDO', data:{
    apellido:'', nombre:'', dni:'', fechaNac:'', estudio:'', sede:'', via:'', email:''
  }, startedAt: Date.now() })
}
async function flowEnd(waKey) { await setSession(waKey, { state:'idle', step:0 }) }

async function promptNext(waRaw, waKey) {
  const s = await getSession(waKey)
  if (!s || s.state !== 'envio_estudio') return
  switch (s.step) {
    case 'APELLIDO':     await sendText(waRaw, '✍️ Ingresá el **apellido** del paciente:', waKey); break
    case 'NOMBRE':       await sendText(waRaw, 'Ahora ingresá el **nombre** del paciente:', waKey); break
    case 'DNI':          await sendText(waRaw, 'Ingresá el **DNI** (solo números):', waKey); break
    case 'FECHA_NAC':    await sendText(waRaw, 'Ingresá la **fecha de nacimiento** (DD/MM/AAAA o AAAA-MM-DD):', waKey); break
    case 'ESTUDIO':      await sendText(waRaw, '¿Qué **estudio** se realizó? (ej.: Panorámica OPG)', waKey); break
    case 'SEDE':         await sendButtons(waRaw, 'Elegí la **sede** donde se realizó:', [
                          { id:'EV_SEDE_QUILMES', title:'Quilmes' },
                          { id:'EV_SEDE_AVELL',   title:'Avellaneda' },
                          { id:'EV_SEDE_LOMAS',   title:'Lomas' },
                         ], waKey); break
    case 'VIA':          await sendButtons(waRaw, '¿Por dónde querés recibirlo?', [
                          { id:'EV_VIA_WSP',   title:'WhatsApp' },
                          { id:'EV_VIA_EMAIL', title:'Email' },
                         ], waKey); break
    case 'EMAIL_IF_NEEDED':
                          await sendText(waRaw, 'Indicá tu **correo electrónico**:', waKey); break
    case 'CONFIRM': {
      const d = s.data
      await sendButtons(waRaw,
        `Confirmá los datos:\n• Paciente: ${d.apellido}, ${d.nombre}\n• DNI: ${d.dni}\n• Nac.: ${d.fechaNac}\n• Estudio: ${d.estudio}\n• Sede: ${d.sede}\n• Vía: ${d.via}${d.email ? ` (${d.email})` : ''}`,
        [{ id:'EV_CONFIRM_YES', title:'✅ Confirmar' }, { id:'EV_CONFIRM_NO', title:'❌ Cancelar' }], waKey)
      break
    }
    default:
      await flowEnd(waKey)
      await sendText(waRaw, 'Listo. Si necesitás enviar un estudio, escribí: Envío de estudio', waKey)
  }
}
async function handleEnvioText(waRaw, waKey, rawBody) {
  const s = await getSession(waKey)
  if (!s || s.state !== 'envio_estudio') return false
  const body = (rawBody || '').trim()
  if (/^(cancelar|salir|menu|menú)$/i.test(body)) {
    await flowEnd(waKey); await sendText(waRaw, 'Se canceló la solicitud. Te dejo el menú:', waKey); await sendMainMenuButtons(waRaw, waKey); return true
  }
  switch (s.step) {
    case 'APELLIDO': s.data.apellido = body.toUpperCase(); s.step='NOMBRE';         await setSession(waKey, s); await promptNext(waRaw, waKey); return true
    case 'NOMBRE':   s.data.nombre   = body.toUpperCase(); s.step='DNI';            await setSession(waKey, s); await promptNext(waRaw, waKey); return true
    case 'DNI': {
      const digits = body.replace(/\D/g,''); if (!isValidDni(digits)) { await sendText(waRaw, 'DNI no válido (6–9 dígitos).', waKey); return true }
      s.data.dni = digits; s.step='FECHA_NAC';                                      await setSession(waKey, s); await promptNext(waRaw, waKey); return true
    }
    case 'FECHA_NAC': {
      const norm = normalizeDate(body); if (!norm) { await sendText(waRaw, 'Usá DD/MM/AAAA o AAAA-MM-DD.', waKey); return true }
      s.data.fechaNac = norm; s.step='ESTUDIO';                                      await setSession(waKey, s); await promptNext(waRaw, waKey); return true
    }
    case 'ESTUDIO':  s.data.estudio = body; s.step='SEDE';                           await setSession(waKey, s); await promptNext(waRaw, waKey); return true
    case 'EMAIL_IF_NEEDED': {
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body); if (!ok) { await sendText(waRaw, 'Email no válido.', waKey); return true }
      s.data.email = body; s.step='CONFIRM';                                         await setSession(waKey, s); await promptNext(waRaw, waKey); return true
    }
  }
  return false
}
async function handleEnvioButton(waRaw, waKey, btnIdOrTitle) {
  const s = await getSession(waKey)
  if (!s || s.state !== 'envio_estudio') return false
  const sel = (btnIdOrTitle || '').toUpperCase()

  switch (s.step) {
    case 'SEDE':
      if (/EV_SEDE_QUILMES|QUILMES/.test(sel)) { s.data.sede='quilmes'; s.step='VIA' }
      else if (/EV_SEDE_AVELL|AVELLANEDA/.test(sel)) { s.data.sede='avellaneda'; s.step='VIA' }
      else if (/EV_SEDE_LOMAS|LOMAS/.test(sel)) { s.data.sede='lomas'; s.step='VIA' }
      else { await sendText(waRaw, 'Elegí una opción de los botones, por favor.', waKey); return true }
      await setSession(waKey, s); await promptNext(waRaw, waKey); return true

    case 'VIA':
      if (/EV_VIA_WSP|WHATSAPP/.test(sel)) { s.data.via='WhatsApp'; s.step='CONFIRM' }
      else if (/EV_VIA_EMAIL|EMAIL/.test(sel)) { s.data.via='Email'; s.step='EMAIL_IF_NEEDED' }
      else { await sendText(waRaw, 'Elegí una opción de los botones, por favor.', waKey); return true }
      await setSession(waKey, s); await promptNext(waRaw, waKey); return true

    case 'CONFIRM':
      if (/EV_CONFIRM_YES|CONFIRMAR|SI|SÍ|OK|CORRECTO/.test(sel)) {
        await sendText(waRaw, '✅ Recibimos tu solicitud. Un/a operador/a la gestionará a la brevedad.', waKey)
        await flowEnd(waKey)
        await sendButtons(waRaw, '¿Querés volver al menú o hablar con un operador?', [
          { id:'BTN_BACK_MENU', title:'↩️ Menú' },
          { id:'MENU_OPERADOR', title:'👤 Operador' },
        ], waKey)
        return true
      }
      if (/EV_CONFIRM_NO|CANCELAR/.test(sel)) {
        await flowEnd(waKey)
        await sendText(waRaw, 'Solicitud cancelada. Te dejo el menú:', waKey)
        await sendMainMenuButtons(waRaw, waKey)
        return true
      }
      await sendText(waRaw, 'Elegí una opción de los botones, por favor.', waKey); return true
  }
  return false
}

// --- Router de menús ---
async function routeMenuSelection(waRaw, waKey, selRaw) {
  const sel = (selRaw || '').toUpperCase()
  // Fuzzy: cualquier variante con "ENVÍO ... ESTUDIO"
  if (/ENV[IÍ]O.*ESTUDIO/.test(sel)) return routeMenuSelection(waRaw, waKey, 'MENU_ENVIO')

  switch (sel) {
    case 'BTN_BACK_MENU':
    case 'MENU':
    case 'MENÚ':
      await sendMainMenuButtons(waRaw, waKey); return true

    case 'MENU_SEDES':
    case '📍 SEDES':
      await sendSedesButtons(waRaw, waKey); return true
    case 'SEDE_QUILMES':
    case 'QUILMES':
      await sendText(waRaw, sedeInfo('QUILMES'), waKey); return true
    case 'SEDE_AVELL':
    case 'AVELLANEDA':
      await sendText(waRaw, sedeInfo('AVELL'), waKey); return true
    case 'SEDE_LOMAS':
    case 'LOMAS':
      await sendText(waRaw, sedeInfo('LOMAS'), waKey); return true

    case 'MENU_ESTUDIOS':
    case '🧾 ESTUDIOS':
      await sendText(waRaw, TXT_ESTUDIOS, waKey); return true

    case 'MENU_OBRAS':
    case '💳 OBRAS SOCIALES':
      await sendText(waRaw, TXT_OBRAS, waKey); return true

    case 'MENU_SUBIR_ORDEN':
    case '📎 SUBIR ORDEN':
      await sendText(waRaw, '📎 Adjuntá una foto clara de la orden médica. Un/a operador/a te confirmará la recepción.', waKey)
      return true

    case 'MENU_OPERADOR':
    case '👤 OPERADOR':
      await sendText(waRaw, '👤 Derivando a operador. Te responderán a la brevedad.', waKey); return true

    case 'MENU_ENVIO':
    case '📤 ENVÍO DE ESTUDIO':
    case '📤 ENVIO DE ESTUDIO':
      flowLog('START_FLOW', { wa: waKey })
      await flowStart(waKey)
      await sendText(waRaw, 'Vamos a tomar los datos para enviar tu estudio. Podés escribir **cancelar** en cualquier momento.', waKey)
      await promptNext(waRaw, waKey)
      return true
  }
  return false
}

// --- Bienvenida SIEMPRE si idle ---
async function sendWelcome(waRaw, waKey) {
  await sendText(waRaw, '¡Hola! 👋 Soy el asistente de i-R Dental.', waKey)
  await sendMainMenuButtons(waRaw, waKey)
}

// --- Router principal ---
async function routeIncomingMessage(waRaw, waKey, kind, payloadTextOrId, payloadTitle) {
  const sess = await getSession(waKey)

  // Bienvenida si idle y texto no tiene "envio"+"estudio"
  if (!sess || sess.state === 'idle') {
    if (kind === 'text') {
      const t = (payloadTextOrId || '').toLowerCase()
      const isCmd = /(envio|envío).*(estudio)/.test(t) || /^1$/.test(t)
      if (!isCmd) { await sendWelcome(waRaw, waKey); return }
    }
  }

  if (kind === 'interactive') {
    const sel = payloadTextOrId || payloadTitle || ''
    flowLog('BTN_STEP', { wa: waKey, sel })
    if (await handleEnvioButton(waRaw, waKey, sel)) return
    if (await routeMenuSelection(waRaw, waKey, sel)) return
    await sendMainMenuButtons(waRaw, waKey); return
  }

  if (kind === 'text') {
    const text = payloadTextOrId || ''
    flowLog('TEXT_STEP', { wa: waKey, text })
    if (/(envio|envío).*(estudio)/i.test(text) || /^1$/.test((text||'').trim())) {
      await routeMenuSelection(waRaw, waKey, 'MENU_ENVIO'); return
    }
    if (await handleEnvioText(waRaw, waKey, text)) return
    await sendText(waRaw, 'Para iniciar, tocá un botón del menú o escribí: Envío de estudio.', waKey)
    await sendMainMenuButtons(waRaw, waKey)
    return
  }
}

// --- Handler ---
export default async function handler(req, res) {
  // GET: verify Meta / feed operador
  if (req.method === 'GET') {
    const mode = req.query['hub.mode']
    const token = req.query['hub.verify_token']
    const challenge = req.query['hub.challenge']
    if (mode === 'subscribe') {
      if (token === WSP_VERIFY_TOKEN) return res.status(200).send(challenge)
      return res.status(403).send('Forbidden')
    }

    const { secret, wa, limit = '100' } = req.query || {}
    if (secret !== OPERATOR_SECRET) return res.status(401).json({ error:'unauthorized' })

    if (wa) {
      const history = await getHistory(wa, parseInt(limit,10) || 100)
      flowLog('FEED_HISTORY', { wa, count: history?.length || 0, last: history?.[history.length - 1] })
      return res.status(200).json({ wa, messages: history })
    }

    const rows = await redis.zrange(kChats, 0, 49, { rev:true, withScores:true })
    let items
    if (Array.isArray(rows) && rows.length && typeof rows[0] === 'object') {
      items = rows.map(r => ({ wa:r.member, ts:Number(r.score) }))
    } else {
      items = []; for (let i=0;i<rows.length;i+=2) items.push({ wa:rows[i], ts:Number(rows[i+1]) })
    }
    flowLog('FEED_CHATS', { count: items?.length || 0, sample: items?.slice?.(0,3) || [] })
    return res.status(200).json({ chats: items })
  }

  // POST: operador o Meta webhook
  if (req.method === 'POST') {
    const { raw, json } = await readBody(req)

    // --- Operador: TEXT
    if (json?.op === 'send') {
      const { secret, wa, text } = json || {}
      if (secret !== OPERATOR_SECRET) return res.status(401).json({ error:'unauthorized' })
      if (!wa || !text) return res.status(400).json({ error:'wa and text required' })

      // Persistencia optimista
      const optimisticId = `out-local-${Date.now()}`
      await appendMessage(wa, { id: optimisticId, from: wa, direction: 'out', text, ts: Date.now() })

      let waRaw = await redis.get(kWaRaw(wa))
      if (!waRaw) waRaw = wa.replace(/^\+/, '')
      const r = await sendText(waRaw, text, wa)

      if (!r.ok) {
        await appendMessage(wa, { id: `${optimisticId}-err`, from: wa, direction: 'out', text: `⚠️ Error envío: ${r.status}`, ts: Date.now() })
      }
      return res.status(r.ok ? 200 : 500).json(r)
    }

    // --- Operador: MEDIA (document/image con link)
    if (json?.op === 'send-media') {
      const { secret, wa, mediaType, link, caption } = json || {}
      if (secret !== OPERATOR_SECRET) return res.status(401).json({ error:'unauthorized' })
      if (!wa || !mediaType || !link) return res.status(400).json({ error:'wa, mediaType, link required' })

      // Persistencia optimista
      const optimisticId = `out-media-${Date.now()}`
      await appendMessage(wa, { id: optimisticId, from: wa, direction: 'out', text: caption || `(${mediaType})`, ts: Date.now(), file: link })

      let waRaw = await redis.get(kWaRaw(wa))
      if (!waRaw) waRaw = wa.replace(/^\+/, '')

      const r = mediaType === 'image'
        ? await sendImage(waRaw, link, caption || '', wa)
        : await sendDocument(waRaw, link, caption || '', wa)

      if (!r.ok) {
        await appendMessage(wa, { id: `${optimisticId}-err`, from: wa, direction: 'out', text: `⚠️ Error envío media: ${r.status}`, ts: Date.now(), file: link })
      }
      return res.status(r.ok ? 200 : 500).json(r)
    }

    // --- Meta webhook
    flowLog('WEBHOOK_BODY', raw)
    const entry  = json?.entry?.[0]
    const change = entry?.changes?.[0]
    const value  = change?.value
    if (!value) return res.status(200).json({ ok:true })

    if (Array.isArray(value.statuses) && value.statuses.length) {
      flowLog('STATUSES', value.statuses); return res.status(200).json({ ok:true })
    }

    const waIdRaw = value?.contacts?.[0]?.wa_id
    const waKey   = normalizeWaKey(waIdRaw)
    const msg     = value?.messages?.[0]
    if (!waKey || !msg) { flowLog('MISSING_MSG', { wa:waIdRaw, hasMsg:!!msg }); return res.status(200).json({ ok:true }) }

    if (waIdRaw) await redis.set(kWaRaw(waKey), waIdRaw)
    if (await alreadyProcessed(waKey, msg.id)) { flowLog('DUPLICATE', { wa:waKey, id:msg.id }); return res.status(200).json({ ok:true }) }

    const type = msg.type
    const ts   = Number(msg.timestamp ? Number(msg.timestamp) * 1000 : Date.now())

    if (type === 'text') {
      const bodyIn = msg.text?.body || ''
      await appendMessage(waKey, { id:msg.id, from:waKey, direction:'in', text: bodyIn, ts })
      await routeIncomingMessage(waIdRaw, waKey, 'text', bodyIn)
      return res.status(200).json({ ok:true })
    }

    if (type === 'interactive') {
      const selId = msg?.interactive?.button_reply?.id || msg?.interactive?.list_reply?.id || ''
      const selTitle = msg?.interactive?.button_reply?.title || msg?.interactive?.list_reply?.title || ''
      await appendMessage(waKey, { id:msg.id, from:waKey, direction:'in', text: selId || selTitle, ts, type:'interactive', meta: msg.interactive })
      if (await handleEnvioButton(waIdRaw, waKey, selId || selTitle)) return res.status(200).json({ ok:true })
      await routeIncomingMessage(waIdRaw, waKey, 'interactive', selId, selTitle)
      return res.status(200).json({ ok:true })
    }

    // media u otros tipos
    await appendMessage(waKey, { id:msg.id, from:waKey, direction:'in', text:`[${type}]`, ts })
    await sendText(waIdRaw, 'Recibimos tu mensaje. Para empezar, tocá un botón del menú o escribí: Envío de estudio.', waKey)
    await sendMainMenuButtons(waIdRaw, waKey)
    return res.status(200).json({ ok:true })
  }

  res.setHeader('Allow', ['GET','POST'])
  return res.status(405).send('Method Not Allowed')
}
