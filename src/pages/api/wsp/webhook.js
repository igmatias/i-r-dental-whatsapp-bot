// ==============================================
// File: src/pages/api/wsp/webhook.js
// Purpose: WhatsApp webhook + Operator feed (GET) + Operator SEND (POST)
// Notes:
//  - Redis sessions (Upstash) + FLOW_* logs de diagnóstico
//  - Bienvenida SIEMPRE con botones (menú 1/2 y 2/2)
//  - Menús: Sedes / Estudios / Obras / Envío / Subir orden / Operador
//  - Flujo "Envío de estudio" con pasos y botones (sede / vía / confirmar)
//  - Persistencia para consola: lpush chat:..., zadd chats:index
//  - Upstash v1 compat: zrange({rev:true, withScores:true}) + polyfill zrevrange
//  - Envío AR sin “9”: normalizamos a 54… (E.164 sin '+')
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
  TEST_RECIPIENT_FORMAT = 'no9', // 'no9' (mantener sin 9) | 'with9' | ''
} = process.env

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN })

// Compat: si no existe zrevrange, emulamos con zrange rev:true
if (typeof redis.zrevrange !== 'function') {
  redis.zrevrange = async (key, start, stop, opts = {}) => {
    return await redis.zrange(key, start, stop, { ...opts, rev: true })
  }
}

// --- Keys Redis ---
const kSess   = (wa) => `sess:${wa}`
const kMsgs   = (wa) => `chat:${wa}:messages`
const kSeen   = (wa) => `seen:${wa}`
const kChats  = 'chats:index'
const kWaRaw  = (wa) => `waid:${wa}` // último wa_id (crudo) visto

// --- LOG helper ---
function flowLog(tag, obj) {
  console.log(`FLOW_${tag} →`, typeof obj === 'string' ? obj : JSON.stringify(obj))
}

// --- HTTP body reader (raw JSON) ---
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8') || '{}'
  try { return { raw, json: JSON.parse(raw) } } catch { return { raw, json: {} } }
}

// --- Normalización de números ---
function normalizeWaKey(waId) {
  // Guardamos claves con "+54..." (para UI), pero enviamos a Meta sin "+"
  let id = waId || ''
  if (!id) return null
  if (!id.startsWith('+')) id = '+' + id
  if (TEST_RECIPIENT_FORMAT === 'with9') id = id.replace(/^\+54(?!9)/, '+549')
  if (TEST_RECIPIENT_FORMAT === 'no9')   id = id.replace(/^\+549/, '+54')
  return id
}

// Sanitiza para enviar a Meta: solo dígitos y SIN “9” intermedio para AR
function sanitizeToE164NoPlus(toRawDigits) {
  let to = String(toRawDigits || '').replace(/\D/g, '')
  if (to.startsWith('549')) to = '54' + to.slice(3) // quitar 9
  return to // Meta quiere sin '+'
}

// --- Sesiones JSON-safe ---
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
  await redis.lpush(kMsgs(waKey), JSON.stringify(msg))
  await redis.ltrim(kMsgs(waKey), 0, 499)
  await redis.zadd(kChats, { score: msg.ts || Date.now(), member: waKey })
}
async function getHistory(waKey, limit = 100) {
  const arr = await redis.lrange(kMsgs(waKey), 0, limit - 1)
  const out = arr.map(s => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)
  return out.sort((a,b) => (a.ts||0)-(b.ts||0))
}
async function alreadyProcessed(waKey, messageId) {
  const last = await redis.get(kSeen(waKey))
  if (last === messageId) return true
  await redis.set(kSeen(waKey), messageId)
  return false
}

// --- Envíos ---
async function sendJson(toRawDigits, payload, storeKey, label='SEND_JSON') {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    flowLog('SEND_GUARD', { error: 'Missing WhatsApp env', WHATSAPP_PHONE_ID: !!WHATSAPP_PHONE_ID, WHATSAPP_TOKEN: !!WHATSAPP_TOKEN })
    return { ok:false, status:500, data:{ error:'Missing env' } }
  }
  let to = sanitizeToE164NoPlus(toRawDigits)
  flowLog(`${label}_REQ`, { to, type: payload.type || 'text' })
  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', Authorization:`Bearer ${WHATSAPP_TOKEN}` },
    body: JSON.stringify({ messaging_product:'whatsapp', to, ...payload })
  })
  let data = {}
  try { data = await res.json() } catch {}
  flowLog(`${label}_RES`, { status: res.status, data })
  try {
    const outId = data?.messages?.[0]?.id || `out-${Date.now()}`
    // Persistimos una representación legible para consola
    const snapshot = {
      id: outId,
      from: storeKey,
      direction: 'out',
      ts: Date.now(),
    }
    if (payload.type === 'text') snapshot.text = payload.text?.body || ''
    if (payload.type === 'interactive') {
      const i = payload.interactive || {}
      snapshot.text = (i.body?.text) || ''
      if (i.type === 'button') {
        snapshot.buttons = (i.action?.buttons || []).map(b => b?.reply?.title).filter(Boolean)
      }
      if (i.type === 'list') {
        // Mostrar títulos de items de lista como “chips”
        const items = []
        for (const sec of i.action?.sections || []) {
          for (const it of sec?.rows || []) items.push(it?.title)
        }
        snapshot.buttons = items
      }
    }
    await appendMessage(storeKey, snapshot)
  } catch {}
  return { ok: res.ok, status: res.status, data }
}

async function sendText(toRawDigits, body, storeKey) {
  return sendJson(toRawDigits, { type:'text', text:{ body } }, storeKey, 'SEND_TEXT')
}

async function sendButtons(toRawDigits, body, buttons, storeKey) {
  // Máx 3 botones
  const payload = {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body || '' },
      action: { buttons: buttons.slice(0,3).map((b,i) => ({ type:'reply', reply:{ id: b.id || `btn_${i}`, title: b.title || `Opción ${i+1}` } })) }
    }
  }
  return sendJson(toRawDigits, payload, storeKey, 'SEND_BUTTONS')
}

async function sendList(toRawDigits, body, sections, storeKey) {
  const payload = {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: body || '' },
      action: { button: 'Ver opciones', sections }
    }
  }
  return sendJson(toRawDigits, payload, storeKey, 'SEND_LIST')
}

// --- Textos base / data (tomados de tu webhook anterior) ---
const HOURS = `🕒 Horarios (todas las sedes)
• Lunes a viernes: 09:00 a 17:30
• Sábados: 09:00 a 12:30`
const NO_TURNO = `📌 Atención SIN TURNO, por orden de llegada.`

// Links sedes (ajustá si cambian)
const LINKS = {
  QUILMES: 'https://maps.google.com/?q=i-R+Dental+Quilmes',
  AVELL:   'https://maps.google.com/?q=i-R+Dental+Avellaneda',
  LOMAS:   'https://maps.google.com/?q=i-R+Dental+Lomas',
}

const SEDES = {
  QUILMES: { title:'Sede Quilmes — i-R Dental',   dir:'Moreno 851 — 1° B', tel:'4257-3638', mail:'quilmes@irdental.com.ar', link: LINKS.QUILMES },
  AVELL:   { title:'Sede Avellaneda — i-R Dental', dir:'9 de Julio 64 — 2° A', tel:'4222-5553', mail:'avellaneda@irdental.com.ar', link: LINKS.AVELL },
  LOMAS:   { title:'Sede Lomas de Zamora — i-R Dental', dir:'España 156 — PB', tel:'4244-0148', mail:'lomas@irdental.com.ar', link: LINKS.LOMAS },
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

// --- Menús (como tu versión anterior) ---
async function sendMainMenuButtons(toRawDigits, storeKey) {
  await sendButtons(toRawDigits, 'Menú (1/2): elegí una opción', [
    { id:'MENU_SEDES',    title:'📍 Sedes' },
    { id:'MENU_ESTUDIOS', title:'🧾 Estudios' },
    { id:'MENU_OBRAS',    title:'💳 Obras sociales' },
  ], storeKey)
  await sendButtons(toRawDigits, 'Menú (2/2): más opciones', [
    { id:'MENU_ENVIO',       title:'📤 Envío de estudio' },
    { id:'MENU_SUBIR_ORDEN', title:'📎 Subir orden' },
    { id:'MENU_OPERADOR',    title:'👤 Operador' },
  ], storeKey)
}

async function sendSedesButtons(toRawDigits, storeKey) {
  return sendButtons(toRawDigits, 'Elegí una sede para ver dirección y contacto:', [
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

// --- Validaciones (como tu versión) ---
function isValidDni(s) { return /^[0-9]{6,9}$/.test((s||'').replace(/\D/g,'')) }
function normalizeDate(s) {
  const t = (s||'').trim()
  const ddmmyyyy = /^([0-3]?\d)\/([01]?\d)\/(\d{4})$/
  const yyyymmdd = /^(\d{4})-(\d{2})-(\d{2})$/
  if (ddmmyyyy.test(t)) {
    const [, d, m, y] = t.match(ddmmyyyy)
    return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`
  }
  if (yyyymmdd.test(t)) return t
  return null
}

// --- Flujo "Envío de estudio" (calcado de tu anterior) ---
async function flowStart(fromKey) {
  await setSession(fromKey, { state:'envio_estudio', step:'APELLIDO', data:{
    apellido:'', nombre:'', dni:'', fechaNac:'', estudio:'', sede:'', via:'', email:''
  }, startedAt: Date.now() })
}
async function flowEnd(fromKey) {
  await setSession(fromKey, { state:'idle', step:0 })
}

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
    await flowEnd(waKey)
    await sendText(waRaw, 'Se canceló la solicitud. Te dejo el menú:', waKey)
    await sendMainMenuButtons(waRaw, waKey)
    return true
  }

  switch (s.step) {
    case 'APELLIDO':
      s.data.apellido = body.toUpperCase()
      s.step = 'NOMBRE'
      await setSession(waKey, s); await promptNext(waRaw, waKey); return true
    case 'NOMBRE':
      s.data.nombre = body.toUpperCase()
      s.step = 'DNI'
      await setSession(waKey, s); await promptNext(waRaw, waKey); return true
    case 'DNI': {
      const digits = body.replace(/\D/g,'')
      if (!isValidDni(digits)) { await sendText(waRaw, 'El DNI no parece válido. Escribilo solo con números (6 a 9 dígitos).', waKey); return true }
      s.data.dni = digits
      s.step = 'FECHA_NAC'
      await setSession(waKey, s); await promptNext(waRaw, waKey); return true
    }
    case 'FECHA_NAC': {
      const norm = normalizeDate(body)
      if (!norm) { await sendText(waRaw, 'Formato no válido. Usá DD/MM/AAAA o AAAA-MM-DD.', waKey); return true }
      s.data.fechaNac = norm
      s.step = 'ESTUDIO'
      await setSession(waKey, s); await promptNext(waRaw, waKey); return true
    }
    case 'ESTUDIO':
      s.data.estudio = body
      s.step = 'SEDE'
      await setSession(waKey, s); await promptNext(waRaw, waKey); return true
    case 'EMAIL_IF_NEEDED': {
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body)
      if (!ok) { await sendText(waRaw, 'Email no válido. Probá nuevamente.', waKey); return true }
      s.data.email = body
      s.step = 'CONFIRM'
      await setSession(waKey, s); await promptNext(waRaw, waKey); return true
    }
  }
  return false
}

async function handleEnvioButton(waRaw, waKey, btnId) {
  const s = await getSession(waKey)
  if (!s || s.state !== 'envio_estudio') return false

  switch (s.step) {
    case 'SEDE':
      if (btnId === 'EV_SEDE_QUILMES' || btnId === 'EV_SEDE_AVELL' || btnId === 'EV_SEDE_LOMAS') {
        s.data.sede = btnId.replace('EV_SEDE_','').toLowerCase()
        s.step = 'VIA'
        await setSession(waKey, s); await promptNext(waRaw, waKey); return true
      }
      await sendText(waRaw, 'Elegí una opción de los botones, por favor.', waKey); return true

    case 'VIA':
      if (btnId === 'EV_VIA_WSP') { s.data.via = 'WhatsApp'; s.step = 'CONFIRM'; await setSession(waKey, s); await promptNext(waRaw, waKey); return true }
      if (btnId === 'EV_VIA_EMAIL'){ s.data.via = 'Email';    s.step = 'EMAIL_IF_NEEDED'; await setSession(waKey, s); await promptNext(waRaw, waKey); return true }
      await sendText(waRaw, 'Elegí una opción de los botones, por favor.', waKey); return true

    case 'CONFIRM':
      if (btnId === 'EV_CONFIRM_YES') {
        await sendText(waRaw, '✅ Recibimos tu solicitud. Un/a operador/a la gestionará a la brevedad.', waKey)
        await flowEnd(waKey)
        await sendButtons(waRaw, '¿Querés volver al menú o hablar con un operador?', [
          { id:'BTN_BACK_MENU', title:'↩️ Menú' },
          { id:'MENU_OPERADOR', title:'👤 Operador' },
        ], waKey)
        return true
      }
      if (btnId === 'EV_CONFIRM_NO') {
        await flowEnd(waKey)
        await sendText(waRaw, 'Solicitud cancelada. Te dejo el menú:', waKey)
        await sendMainMenuButtons(waRaw, waKey)
        return true
      }
      await sendText(waRaw, 'Elegí una opción de los botones, por favor.', waKey); return true
  }
  return false
}

// --- Router de menús (como el anterior) ---
async function routeMenuSelection(waRaw, waKey, selId) {
  switch (selId) {
    case 'BTN_BACK_MENU':
      await sendMainMenuButtons(waRaw, waKey); return true

    case 'MENU_SEDES':
      await sendSedesButtons(waRaw, waKey); return true
    case 'SEDE_QUILMES':
      await sendText(waRaw, sedeInfo('QUILMES'), waKey); return true
    case 'SEDE_AVELL':
      await sendText(waRaw, sedeInfo('AVELL'), waKey); return true
    case 'SEDE_LOMAS':
      await sendText(waRaw, sedeInfo('LOMAS'), waKey); return true

    case 'MENU_ESTUDIOS':
      await sendText(waRaw, TXT_ESTUDIOS, waKey); return true

    case 'MENU_OBRAS':
      await sendText(waRaw, TXT_OBRAS, waKey); return true

    case 'MENU_SUBIR_ORDEN':
      await sendText(waRaw,
        '📎 Para subir tu orden, adjuntá una foto clara de la orden médica.\n' +
        'Un/a operador/a te responderá con la confirmación.', waKey)
      return true

    case 'MENU_OPERADOR':
      await sendText(waRaw, '👤 Derivando a operador. Te responderán a la brevedad.', waKey); return true

    case 'MENU_ENVIO': // iniciar flujo
      flowLog('START', { wa: waKey })
      await flowStart(waKey)
      await sendText(waRaw, 'Vamos a tomar los datos para enviar tu estudio. Podés escribir **cancelar** en cualquier momento.', waKey)
      await promptNext(waRaw, waKey)
      return true
  }
  return false
}

// --- Bienvenida SIEMPRE ---
async function sendWelcome(waRaw, waKey) {
  await sendText(waRaw, '¡Hola! 👋 Soy el asistente de i-R Dental.', waKey)
  await sendMainMenuButtons(waRaw, waKey)
}

// --- Router principal ---
async function routeIncomingMessage(waRaw, waKey, kind, payloadTextOrId) {
  // Bienvenida SIEMPRE antes de nada si está idle y no es comando directo del flujo
  const sess = await getSession(waKey)
  if (!sess || sess.state === 'idle') {
    // Si llega un botón/lista, proseguimos; si llega texto que no es “envío de estudio”, damos bienvenida
    if (kind === 'text') {
      const t = (payloadTextOrId || '').trim().toLowerCase()
      const isCmd = /(envio|envío) de estudio|^1$/.test(t)
      if (!isCmd) { await sendWelcome(waRaw, waKey); return }
    }
  }

  if (kind === 'interactive') {
    const sel = payloadTextOrId || ''
    flowLog('BTN_STEP', { wa: waKey, sel })
    // Primero, si hay flujo activo, dejalo consumir
    if (await handleEnvioButton(waRaw, waKey, sel)) return
    // Si no lo consumió, es un menú
    if (await routeMenuSelection(waRaw, waKey, sel)) return
    await sendMainMenuButtons(waRaw, waKey); return
  }

  if (kind === 'text') {
    const text = payloadTextOrId || ''
    flowLog('TEXT_STEP', { wa: waKey, text })
    // Flujo activo primero
    if (await handleEnvioText(waRaw, waKey, text)) return

    // Comando directo “Envío de estudio”
    if (/(envio|envío) de estudio|^1$/.test((text||'').toLowerCase())) {
      await routeMenuSelection(waRaw, waKey, 'MENU_ENVIO'); return
    }

    // Cualquier otra cosa → recordatorio menú
    await sendText(waRaw, 'Para iniciar, tocá un botón del menú o escribí: Envío de estudio.', waKey)
    await sendMainMenuButtons(waRaw, waKey)
    return
  }
}

// --- Handler HTTP ---
export default async function handler(req, res) {
  // GET: verificación Meta o feed operador
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
      return res.status(200).json({ wa, messages: history })
    }

    // Lista de chats recientes (desc)
    const rows = await redis.zrange(kChats, 0, 49, { rev:true, withScores:true })
    let items
    if (Array.isArray(rows) && rows.length && typeof rows[0] === 'object') {
      items = rows.map(r => ({ wa:r.member, ts:Number(r.score) }))
    } else {
      items = []; for (let i=0;i<rows.length;i+=2) items.push({ wa:rows[i], ts:Number(rows[i+1]) })
    }
    return res.status(200).json({ chats: items })
  }

  // POST: WhatsApp webhook events o envío de operador
  if (req.method === 'POST') {
    const { raw, json } = await readBody(req)

    // Rama operador
    if (json?.op === 'send') {
      const { secret, wa, text } = json || {}
      if (secret !== OPERATOR_SECRET) return res.status(401).json({ error:'unauthorized' })
      if (!wa || !text) return res.status(400).json({ error:'wa and text required' })
      let waRaw = await redis.get(kWaRaw(wa))
      if (!waRaw) waRaw = wa.replace(/^\+/, '') // fallback básico
      const r = await sendText(waRaw, text, wa)
      return res.status(r.ok ? 200 : 500).json(r)
    }

    // Rama Meta webhook
    flowLog('WEBHOOK_BODY', raw)
    const entry  = json?.entry?.[0]
    const change = entry?.changes?.[0]
    const value  = change?.value
    if (!value) return res.status(200).json({ ok:true })

    if (Array.isArray(value.statuses) && value.statuses.length) {
      flowLog('STATUSES', value.statuses); return res.status(200).json({ ok:true })
    }

    const waIdRaw = value?.contacts?.[0]?.wa_id            // 54911... o 5411...
    const waKey   = normalizeWaKey(waIdRaw)                 // +5411..., sin 9 si corresponde
    const msg     = value?.messages?.[0]
    if (!waKey || !msg) { flowLog('MISSING_MSG', { wa:waIdRaw, hasMsg:!!msg }); return res.status(200).json({ ok:true }) }

    // Guardar último wa_id crudo para operador
    if (waIdRaw) await redis.set(kWaRaw(waKey), waIdRaw)

    // Idempotencia
    if (await alreadyProcessed(waKey, msg.id)) { flowLog('DUPLICATE', { wa:waKey, id:msg.id }); return res.status(200).json({ ok:true }) }

    const type = msg.type
    const ts   = Number(msg.timestamp ? Number(msg.timestamp) * 1000 : Date.now())

    // Persistencia consola (IN)
    if (type === 'text') {
      const bodyIn = msg.text?.body || ''
      await appendMessage(waKey, { id:msg.id, from:waKey, direction:'in', text: bodyIn, ts })
      await routeIncomingMessage(waIdRaw, waKey, 'text', bodyIn)
      return res.status(200).json({ ok:true })
    }

    if (type === 'interactive') {
      const selId = msg?.interactive?.button_reply?.id || msg?.interactive?.list_reply?.id || ''
      await appendMessage(waKey, { id:msg.id, from:waKey, direction:'in', text: selId, ts, type:'interactive', meta: msg.interactive })
      // Primero deja consumir al flujo activo (sede/vía/confirm)
      if (await handleEnvioButton(waIdRaw, waKey, selId)) return res.status(200).json({ ok:true })
      // Sino, rutea como menú
      await routeIncomingMessage(waIdRaw, waKey, 'interactive', selId)
      return res.status(200).json({ ok:true })
    }

    // Otros tipos (documento, imagen, etc.) → sólo log + guardado básico
    await appendMessage(waKey, { id:msg.id, from:waKey, direction:'in', text:`[${type}]`, ts })
    await sendText(waIdRaw, 'Recibimos tu mensaje. Para empezar, tocá un botón del menú o escribí: Envío de estudio.', waKey)
    await sendMainMenuButtons(waIdRaw, waKey)
    return res.status(200).json({ ok:true })
  }

  res.setHeader('Allow', ['GET','POST'])
  return res.status(405).send('Method Not Allowed')
}
