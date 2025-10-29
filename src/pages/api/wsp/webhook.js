// ==============================================
// File: src/pages/api/wsp/webhook.js
// Purpose: WhatsApp webhook + Operator feed (GET)
// Notes:
//  - Implements Redis sessions with Upstash (@upstash/redis)
//  - Adds FLOW_* logs for quick diagnosis
//  - Fixes: (a) first prompt for "Envío de estudio" flow, (b) idempotency to avoid double-processing,
//           (c) stores ordered message history for operator console, (d) optional GET endpoint for operator
// ==============================================

import { Redis } from '@upstash/redis'

export const config = { api: { bodyParser: false } } // parse raw for accurate logs

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

// --- Helpers ---
function flowLog(tag, obj) { console.log(`FLOW_${tag} →`, typeof obj === 'string' ? obj : JSON.stringify(obj)) }

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const buf = Buffer.concat(chunks)
  const raw = buf.toString('utf8') || '{}'
  try { return { raw, json: JSON.parse(raw) } } catch { return { raw, json: {} } }
}

function toRawFromWaKey(waKey){ return (waKey||'').replace(/^\+/, ''); }

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

async function sendText(toRawDigits, body, storeKey) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    flowLog('SEND_GUARD', { error: 'Missing WhatsApp env', WHATSAPP_PHONE_ID: !!WHATSAPP_PHONE_ID, WHATSAPP_TOKEN: !!WHATSAPP_TOKEN })
    return null
  }
  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`
  const payload = { messaging_product: 'whatsapp', to: String(toRawDigits), text: { body } }
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WHATSAPP_TOKEN}` }, body: JSON.stringify(payload) })
  let data = {}
  try { data = await res.json() } catch {}
  flowLog('SEND_TEXT', { to: toRawDigits, body, status: res.status, data })
  try{
    const outId = data?.messages?.[0]?.id || `out-${Date.now()}`
    if(storeKey){ await appendMessage(storeKey, { id: outId, from: storeKey, direction: 'out', text: body, ts: Date.now() }) }
  }catch{}
  return { ok: res.ok, status: res.status, data }
}

// Redis keys
const kSess = (wa) => `sess:${wa}`
const kMsgs = (wa) => `chat:${wa}:messages`
const kSeen = (wa) => `seen:${wa}`
const kChats = 'chats:index'

async function appendMessage(wa, msg) {
  await redis.lpush(kMsgs(wa), JSON.stringify(msg))
  await redis.ltrim(kMsgs(wa), 0, 499)
  await redis.zadd(kChats, { score: msg.ts || Date.now(), member: wa })
}

async function getHistory(wa, limit = 100) {
  const arr = await redis.lrange(kMsgs(wa), 0, limit - 1)
  const parsed = arr.map((s) => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)
  return parsed.sort((a, b) => (a.ts || 0) - (b.ts || 0))
}

async function getSession(wa) { return (await redis.get(kSess(wa))) || { state: 'idle', step: 0 } }
async function setSession(wa, sess) { return await redis.set(kSess(wa), sess) }

async function alreadyProcessed(wa, messageId) {
  const last = await redis.get(kSeen(wa))
  if (last === messageId) return true
  await redis.set(kSeen(wa), messageId)
  return false
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
    await setSession(wa, sess)
    await sendText(waRaw, 'Perfecto. Te voy a solicitar algunos datos para enviar el estudio.\n1) Nombre y apellido del paciente:', waKey)
    return sess
  }
  const t = (incomingText || '').trim()
  switch (sess.step) {
    case 1:
      if (t.length < 2) { await sendText(waRaw, 'Por favor, indicá nombre y apellido válidos.', waKey); return sess }
      sess.data.nombre = t
      sess.step = 2
      await setSession(wa, sess)
      await sendText(waRaw, '2) Tipo de estudio (por ej.: panorámica, periapical, teleradiografía):', waKey)
      return sess
    case 2:
      sess.data.tipo = t
      sess.step = 3
      await setSession(wa, sess)
      await sendText(waRaw, '3) Fecha del estudio (dd/mm/aaaa):', waKey)
      return sess
    case 3:
      sess.data.fecha = t
      sess.step = 4
      await setSession(wa, sess)
      await sendText(waRaw, '4) Sede donde lo realizó (Quilmes / Avellaneda / Lomas):', waKey)
      return sess
    case 4:
      sess.data.sede = t
      sess.step = 5
      await setSession(wa, sess)
      await sendText(waRaw, `¡Gracias! Confirmá por favor:\n• Paciente: ${sess.data.nombre}\n• Estudio: ${sess.data.tipo}\n• Fecha: ${sess.data.fecha}\n• Sede: ${sess.data.sede}\n\n¿Está correcto? Responde SI o NO.`, waKey)
      return sess
    case 5:
      if (/^si|sí|ok|correcto$/i.test(t)) {
        sess.step = 6
        await setSession(wa, sess)
        await sendText(waRaw, 'Perfecto. En breve un operador te enviará el archivo o el enlace de descarga. ¡Gracias!', waKey)
      } else {
        sess = { state: 'idle', step: 0 }
        await setSession(wa, sess)
        await sendText(waRaw, 'Entendido. Si querés iniciar de nuevo, escribí: Envío de estudio', waKey)
      }
      return sess
    default:
      sess = { state: 'idle', step: 0 }
      await setSession(wa, sess)
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

  await sendText(wa, 'Hola 👋 Soy el asistente de i‑R Dental. Para solicitar tu estudio, escribí: \"Envío de estudio\".')
}

// --- Handler ---
export default async function handler(req, res) {
  // GET: webhook verify OR operator feed
  if (req.method === 'GET') {
    const { ['hub.mode']: mode, ['hub.verify_token']: token, ['hub.challenge']: challenge } = req.query || {}
    if (mode === 'subscribe') {
      if (token === WSP_VERIFY_TOKEN) { flowLog('VERIFY_OK', { mode }); return res.status(200).send(challenge) }
      flowLog('VERIFY_FAIL', { mode }); return res.status(403).send('Forbidden')
    }

    const { secret, wa, limit = '100' } = req.query || {}
    if (secret !== OPERATOR_SECRET) return res.status(401).json({ error: 'unauthorized' })

    if (wa) {
      const history = await getHistory(wa, parseInt(limit, 10) || 100)
      return res.status(200).json({ wa, messages: history })
    }

    const chats = await redis.zrevrange(kChats, 0, 49, { withScores: true })
    const items = []
    for (let i = 0; i < chats.length; i += 2) items.push({ wa: chats[i], ts: Number(chats[i + 1]) })
    return res.status(200).json({ chats: items })
  }

  // POST: WhatsApp webhook events
  if (req.method === 'POST') {
    const { raw, json } = await readBody(req)
    flowLog('WEBHOOK_BODY', raw)

    const entry = json?.entry?.[0]
    const change = entry?.changes?.[0]
    const value = change?.value

    if (!value) { flowLog('NO_VALUE', json); return res.status(200).json({ ok: true }) }

    if (Array.isArray(value.statuses) && value.statuses.length) {
      flowLog('STATUSES', value.statuses); return res.status(200).json({ ok: true })
    }

    const waIdRaw = value?.contacts?.[0]?.wa_id
    const waKey = normalizeWaId(waIdRaw)

    const msg = value?.messages?.[0]
    if (!waKey || !msg) { flowLog('MISSING_MSG', { wa: waIdRaw, hasMsg: !!msg }); return res.status(200).json({ ok: true }) }

    if (await alreadyProcessed(waKey, msg.id)) { flowLog('DUPLICATE', { wa: waKey, id: msg.id }); return res.status(200).json({ ok: true }) }

    const type = msg.type
    const ts = Number(msg.timestamp ? Number(msg.timestamp) * 1000 : Date.now())

    let incomingText = ''
    if (type === 'text') incomingText = msg.text?.body || ''
    else if (type === 'interactive') incomingText = msg.interactive?.list_reply?.title || msg.interactive?.button_reply?.title || ''
    else incomingText = ''

    await appendMessage(waKey, { id: msg.id, from: waKey, direction: 'in', text: incomingText || `[${type}]`, ts })

    try { await routeIncomingMessage(waIdRaw, waKey, { id: msg.id, text: incomingText, ts }) }
    catch (e) { flowLog('ROUTE_ERR', { wa, err: String(e) }) }

    return res.status(200).json({ ok: true })
  }

  return res.status(405).send('Method Not Allowed')
}
