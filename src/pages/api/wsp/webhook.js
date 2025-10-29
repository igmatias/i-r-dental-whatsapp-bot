// ==============================================
// File: src/pages/api/wsp/webhook.js
// Purpose: WhatsApp webhook + Operator feed (GET) + Operator SEND (POST)
// Notes:
//  - Redis sessions (Upstash) + FLOW_* logs
//  - Idempotencia por message.id
//  - Historial para consola y endpoint GET
//  - Envío SIEMPRE a wa_id crudo (AR 549...), storage con wa normalizado
//  - Compat Upstash v1: zrange({rev:true, withScores:true}) + polyfill zrevrange
//  - POST de operador: {op:"send", secret, wa, text}  → envía y persiste 'out'
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
  TEST_RECIPIENT_FORMAT = 'no9', // 'no9' | 'with9' | ''
} = process.env

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN })

// Compat shim: si no existe zrevrange en esta versión, mapear a zrange con rev:true
if (typeof redis.zrevrange !== 'function') {
  redis.zrevrange = async (key, start, stop, opts = {}) => {
    return await redis.zrange(key, start, stop, { ...opts, rev: true })
  }
}

// --- Keys ---
const kSess    = (wa) => `sess:${wa}`
const kMsgs    = (wa) => `chat:${wa}:messages`
const kSeen    = (wa) => `seen:${wa}`
const kChats   = 'chats:index'
const kWaRaw   = (wa) => `waid:${wa}` // último wa_id crudo visto para ese waKey

// --- Helpers ---
function flowLog(tag, obj) {
  console.log(`FLOW_${tag} →`, typeof obj === 'string' ? obj : JSON.stringify(obj))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const buf = Buffer.concat(chunks)
  const raw = buf.toString('utf8') || '{}'
  try { return { raw, json: JSON.parse(raw) } } catch { return { raw, json: {} } }
}

function normalizeWaId(waId) {
  let id = waId
  if (!id) return null
  if (!id.startsWith('+')) id = '+' + id
  if (TEST_RECIPIENT_FORMAT === 'with9') {
    id = id.replace(/^\+54(?!9)/, '+549')
  } else if (TEST_RECIPIENT_FORMAT === 'no9') {
    id = id.replace(/^\+549/, '+54')
  }
  return id
}

function waKeyToRawDigitsFallback(waKey) {
  // Intento simple: quitar '+' y, si es AR sin 9, forzar 549
  // ej: +5411... → 54911... (móvil) / si ya tiene 549, queda igual
  const digits = (waKey || '').replace(/^\+/, '')
  if (digits.startsWith('549')) return digits
  if (digits.startsWith('54') && !digits.startsWith('549')) {
    return `549${digits.slice(2)}`
  }
  return digits
}

// JSON-safe session helpers
async function getSession(waKey) {
  const raw = await redis.get(kSess(waKey))
  try { return raw ? JSON.parse(raw) : { state: 'idle', step: 0 } }
  catch { return { state: 'idle', step: 0 } }
}
async function setSession(waKey, sess) {
  return await redis.set(kSess(waKey), JSON.stringify(sess))
}

async function appendMessage(waKey, msg) {
  await redis.lpush(kMsgs(waKey), JSON.stringify(msg))
  await redis.ltrim(kMsgs(waKey), 0, 499)
  await redis.zadd(kChats, { score: msg.ts || Date.now(), member: waKey })
}

async function getHistory(waKey, limit = 100) {
  const arr = await redis.lrange(kMsgs(waKey), 0, limit - 1)
  const parsed = arr.map((s) => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)
  return parsed.sort((a, b) => (a.ts || 0) - (b.ts || 0))
}

async function alreadyProcessed(waKey, messageId) {
  const last = await redis.get(kSeen(waKey))
  if (last === messageId) return true
  await redis.set(kSeen(waKey), messageId)
  return false
}

async function sendText(toRawDigits, body, storeKey) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    flowLog('SEND_GUARD', {
      error: 'Missing WhatsApp env',
      WHATSAPP_PHONE_ID: !!WHATSAPP_PHONE_ID,
      WHATSAPP_TOKEN: !!WHATSAPP_TOKEN,
    })
    return { ok: false, status: 500, data: { error: 'Missing env' } }
  }

  // 🔹 Normalización sin el “9”
  let to = String(toRawDigits || '').replace(/\D/g, '')
  // Si empieza con 549 (con 9 móvil), lo pasamos a 54 (sin 9)
  if (to.startsWith('549')) {
    to = '54' + to.slice(3)
  }

  // Si tiene + delante, lo removemos (Meta lo quiere sin +)
  if (to.startsWith('+')) to = to.slice(1)

  // Log informativo
  flowLog('SEND_TO_SANITIZED', { original: toRawDigits, sanitized: to })

  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`
  const payload = {
    messaging_product: 'whatsapp',
    to,
    text: { body },
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify(payload),
  })

  let data = {}
  try {
    data = await res.json()
  } catch {}

  flowLog('SEND_TEXT', { to, body, status: res.status, data })

  try {
    const outId = data?.messages?.[0]?.id || `out-${Date.now()}`
    if (storeKey) {
      await appendMessage(storeKey, {
        id: outId,
        from: storeKey,
        direction: 'out',
        text: body,
        ts: Date.now(),
      })
    }
  } catch {}

  return { ok: res.ok, status: res.status, data }
}
function detectCommand(txt) {
  const t = (txt || '').trim().toLowerCase()
  if (!t) return null
  if (/(envio|envío) de estudio|enviar estudio|mandar estudio|enviar radiografia|enviar radiografía/.test(t)) return 'envio_estudio'
  if (/^1$/.test(t)) return 'envio_estudio'
  return null
}

async function handleFlowEnvioEstudio(waRaw, waKey, sess, incomingText) {
  if (sess.state !== 'envio_estudio') {
    sess = { state: 'envio_estudio', step: 1, data: {} }
    await setSession(waKey, sess)
    await sendText(waRaw, 'Perfecto. Te voy a solicitar algunos datos para enviar el estudio.\n1) Nombre y apellido del paciente:', waKey)
    return sess
  }
  const t = (incomingText || '').trim()
  switch (sess.step) {
    case 1:
      if (t.length < 2) { await sendText(waRaw, 'Por favor, indicá nombre y apellido válidos.', waKey); return sess }
      sess.data.nombre = t
      sess.step = 2
      await setSession(waKey, sess)
      await sendText(waRaw, '2) Tipo de estudio (por ej.: panorámica, periapical, teleradiografía):', waKey)
      return sess
    case 2:
      sess.data.tipo = t
      sess.step = 3
      await setSession(waKey, sess)
      await sendText(waRaw, '3) Fecha del estudio (dd/mm/aaaa):', waKey)
      return sess
    case 3:
      sess.data.fecha = t
      sess.step = 4
      await setSession(waKey, sess)
      await sendText(waRaw, '4) Sede donde lo realizó (Quilmes / Avellaneda / Lomas):', waKey)
      return sess
    case 4:
      sess.data.sede = t
      sess.step = 5
      await setSession(waKey, sess)
      await sendText(waRaw, `¡Gracias! Confirmá por favor:\n• Paciente: ${sess.data.nombre}\n• Estudio: ${sess.data.tipo}\n• Fecha: ${sess.data.fecha}\n• Sede: ${sess.data.sede}\n\n¿Está correcto? Responde SI o NO.`, waKey)
      return sess
    case 5:
      if (/^si|sí|ok|correcto$/i.test(t)) {
        sess.step = 6
        await setSession(waKey, sess)
        await sendText(waRaw, 'Perfecto. En breve un operador te enviará el archivo o el enlace de descarga. ¡Gracias!', waKey)
      } else {
        sess = { state: 'idle', step: 0 }
        await setSession(waKey, sess)
        await sendText(waRaw, 'Entendido. Si querés iniciar de nuevo, escribí: Envío de estudio', waKey)
      }
      return sess
    default:
      sess = { state: 'idle', step: 0 }
      await setSession(waKey, sess)
      await sendText(waRaw, 'Listo. Si necesitás enviar un estudio, escribí: Envío de estudio', waKey)
      return sess
  }
}

async function routeIncomingMessage(waRaw, waKey, msg) {
  let sess = await getSession(waKey)
  flowLog('TEXT_STEP', { wa: waKey, sess })

  const cmd = detectCommand(msg.text)
  if (cmd === 'envio_estudio') { await handleFlowEnvioEstudio(waRaw, waKey, sess, msg.text); return }

  if (sess.state === 'envio_estudio') { await handleFlowEnvioEstudio(waRaw, waKey, sess, msg.text); return }

  await sendText(waRaw, 'Hola 👋 Soy el asistente de i-R Dental. Para solicitar tu estudio, escribí: "Envío de estudio".', waKey)
}

// --- Handler ---
export default async function handler(req, res) {
  // GET: webhook verify OR operator feed
  if (req.method === 'GET') {
    // 1) Verificación de Meta
    const { ['hub.mode']: mode, ['hub.verify_token']: token, ['hub.challenge']: challenge } = req.query || {}
    if (mode === 'subscribe') {
      if (token === WSP_VERIFY_TOKEN) { flowLog('VERIFY_OK', { mode }); return res.status(200).send(challenge) }
      flowLog('VERIFY_FAIL', { mode }); return res.status(403).send('Forbidden')
    }

    // 2) Feed para consola
    const { secret, wa, limit = '100' } = req.query || {}
    if (secret !== OPERATOR_SECRET) return res.status(401).json({ error: 'unauthorized' })

    if (wa) {
      const history = await getHistory(wa, parseInt(limit, 10) || 100)
      return res.status(200).json({ wa, messages: history })
    }

    // Lista de chats por score descendente (compat v1)
    const rows = await redis.zrange(kChats, 0, 49, { rev: true, withScores: true })

    let items
    if (Array.isArray(rows) && rows.length && typeof rows[0] === 'object' && rows[0] !== null) {
      // [{ member, score }]
      items = rows.map(r => ({ wa: r.member, ts: Number(r.score) }))
    } else {
      // ['member','score',...]
      items = []
      for (let i = 0; i < rows.length; i += 2) items.push({ wa: rows[i], ts: Number(rows[i + 1]) })
    }

    return res.status(200).json({ chats: items })
  }

  // POST: WhatsApp webhook events  **o** Operator send
  if (req.method === 'POST') {
    const { raw, json } = await readBody(req)

    // ---- Rama operador: { op:"send", secret, wa, text }
    if (json?.op === 'send') {
      const { secret, wa, text } = json || {}
      if (secret !== OPERATOR_SECRET) return res.status(401).json({ error: 'unauthorized' })
      if (!wa || !text) return res.status(400).json({ error: 'wa and text required' })

      // Buscar wa_id crudo guardado; si no hay, usar fallback desde waKey
      let waRaw = await redis.get(kWaRaw(wa))
      if (!waRaw) waRaw = waKeyToRawDigitsFallback(wa)

      flowLog('OPERATOR_SEND_REQ', { waKey: wa, waRaw, text })
      const r = await sendText(waRaw, text, wa)
      flowLog('OPERATOR_SEND_RES', r)
      return res.status(r.ok ? 200 : 500).json(r)
    }

    // ---- Rama WhatsApp webhook (Meta)
    flowLog('WEBHOOK_BODY', raw)

    const entry  = json?.entry?.[0]
    const change = entry?.changes?.[0]
    const value  = change?.value

    if (!value) { flowLog('NO_VALUE', json); return res.status(200).json({ ok: true }) }

    if (Array.isArray(value.statuses) && value.statuses.length) {
      flowLog('STATUSES', value.statuses); return res.status(200).json({ ok: true })
    }

    const waIdRaw = value?.contacts?.[0]?.wa_id     // crudo para enviar (549...)
    const waKey   = normalizeWaId(waIdRaw)          // normalizado para guardar

    const msg = value?.messages?.[0]
    if (!waKey || !msg) { flowLog('MISSING_MSG', { wa: waIdRaw, hasMsg: !!msg }); return res.status(200).json({ ok: true }) }

    // Guardar el último waRaw visto para ese waKey (lo usa el operador)
    if (waIdRaw) await redis.set(kWaRaw(waKey), waIdRaw)

    if (await alreadyProcessed(waKey, msg.id)) { flowLog('DUPLICATE', { wa: waKey, id: msg.id }); return res.status(200).json({ ok: true }) }

    const type = msg.type
    const ts = Number(msg.timestamp ? Number(msg.timestamp) * 1000 : Date.now())

    let incomingText = ''
    if (type === 'text') incomingText = msg.text?.body || ''
    else if (type === 'interactive') incomingText = msg.interactive?.list_reply?.title || msg.interactive?.button_reply?.title || ''
    else incomingText = ''

    await appendMessage(waKey, { id: msg.id, from: waKey, direction: 'in', text: incomingText || `[${type}]`, ts })

    try { await routeIncomingMessage(waIdRaw, waKey, { id: msg.id, text: incomingText, ts }) }
    catch (e) { flowLog('ROUTE_ERR', { wa: waKey, err: String(e) }) }

    return res.status(200).json({ ok: true })
  }

  return res.status(405).send('Method Not Allowed')
}
