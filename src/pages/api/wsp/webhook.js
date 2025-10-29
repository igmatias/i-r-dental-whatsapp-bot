// src/pages/api/wsp/webhook.js
import { getStore } from "../../../lib/store";
import {
  getSession as rGet,
  setSession as rSet,
  delSession as rDel,
} from "../../../lib/session";

const STORE = getStore();
const API_URL = (phoneId) => `https://graph.facebook.com/v20.0/${phoneId}/messages`;

/** ========= TEXTOS BASE ========= **/
const HOURS = `🕒 Horarios (todas las sedes)
• Lunes a viernes: 09:00 a 17:30
• Sábados: 09:00 a 12:30`;
const NO_TURNO = `📌 Atención SIN TURNO, por orden de llegada.`;

const LINKS = {
  QUILMES: "https://maps.app.goo.gl/8j58wRew5mdYRwdM7",
  AVELL:   "https://maps.app.goo.gl/WZY2x6RS8AKs7N3X6",
  LOMAS:   "https://maps.app.goo.gl/UARCmN2jZRm19ycy7",
};

const SEDES = {
  QUILMES: {
    title: "Sede Quilmes — i-R Dental",
    dir: "Olavarría 88",
    tel: "4257-1222",
    mail: "quilmes@irdental.com.ar",
    link: LINKS.QUILMES,
  },
  AVELL: {
    title: "Sede Avellaneda — i-R Dental",
    dir: "9 de Julio 64 — 2° A",
    tel: "4222-5553",
    mail: "avellaneda@irdental.com.ar",
    link: LINKS.AVELL,
  },
  LOMAS: {
    title: "Sede Lomas de Zamora — i-R Dental",
    dir: "España 156 — PB",
    tel: "4244-0148",
    mail: "lomas@irdental.com.ar",
    link: LINKS.LOMAS,
  },
};

const TXT_BIENVENIDA =
  "¡Hola! 👋 Gracias por escribirnos a i-R Dental.\n\n" +
  `${HOURS}\n\n${NO_TURNO}\n\n` +
  "Elegí una opción del menú para continuar.";

const TXT_ESTUDIOS = `🧾 Estudios i-R Dental:
• Panorámica (OPG)
• Cefalométrica (lateral/PA)
• Periapicales
• Oclusales
• Serie completa
• ATM básica
• CBCT / Tomografía (si corresponde)
• Fotografías intra/extraorales (si corresponde)

✅ SIN TURNO, por orden de llegada.`;

const TXT_OBRAS = `🧾 Obras sociales activas:
AMFFA, ANSSAL APDIS, APESA SALUD, CENTRO MEDICO PUEYRREDON, COLEGIO DE ESCRIBANOS PROVINCIA DE BUENOS AIRES, DASUTEN, DOCTHOS, ELEVAR*, ESPORA SALUD*, FATFA, FEMEBA AVELLANEDA, HOSPITAL BRITANICO, HOSPITAL ITALIANO, LUIS PASTEUR, MEDICUS*, NUBIAL, OMA, OMINT*, OSDE, OSDIPP, OSMEBA, OPSA, PODER JUDICIAL (FO)*, PROGRAMAS MEDICOS, QUALITAS, SANCOR SALUD*, SERVESALUD*, SETIA, SIMECO, SIND. MUNIC. AVELLANEDA, SWISS MEDICAL*.

(*) En la orden debe incluirse el Diagnóstico.

⚠️ Este listado puede presentar modificaciones. Por favor consulte telefónicamente, por mail o por WhatsApp con el operador.`;

/** ========= NORMALIZACIÓN AR (test) ========= */
function toE164ArForTesting(raw) {
  let n = (raw || "").trim();
  if (!n.startsWith("+")) n = "+" + n;
  const mode = (process.env.TEST_RECIPIENT_FORMAT || "").toLowerCase();
  if (mode === "no9" && /^\+54911\d{8}$/.test(n)) n = n.replace(/^\+54911/, "+5411");
  if (mode === "with9" && /^\+5411\d{8}$/.test(n)) n = n.replace(/^\+5411/, "+54911");
  return n;
}

/** ========= HELPERS ENVÍO MENSAJES (con reintentos) ========= **/
async function sendJson(to, payload, attempt = 1) {
  try {
    const r = await fetch(API_URL(process.env.WHATSAPP_PHONE_ID), {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        ...payload,
      }),
    });
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error("SEND ERROR", r.status, JSON.stringify(data));
      if ((r.status === 429 || r.status >= 500) && attempt < 3) {
        await new Promise(res => setTimeout(res, 300 * attempt));
        return sendJson(to, payload, attempt + 1);
      }
    } else {
      console.log("MESSAGE SENT →", to, payload.type);
    }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    console.error("SEND THROW", e);
    if (attempt < 3) {
      await new Promise(res => setTimeout(res, 300 * attempt));
      return sendJson(to, payload, attempt + 1);
    }
    return { ok: false, status: 0, data: { error: String(e) } };
  }
}

const sendText = async (to, body) => {
  const resp = await sendJson(to, { type: "text", text: { body } });
  safePush({
    id: `out_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
    ts: Date.now(),
    waFrom: to,
    direction: "out",
    type: "text",
    body,
    meta: { ok: resp.ok },
  });
  return resp;
};

async function sendButtons(to, body, buttons = []) {
  const btns = buttons.slice(0, 3).map((b) => ({
    type: "reply",
    reply: { id: b.id, title: b.title },
  }));
  const resp = await sendJson(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: { buttons: btns },
    },
  });
  safePush({
    id: `out_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
    ts: Date.now(),
    waFrom: to,
    direction: "out",
    type: "interactive",
    body,
    meta: { ok: resp.ok, buttons: buttons.map((b) => b.id) },
  });
  return resp;
}

async function sendMainMenuButtons(to) {
  await sendButtons(to, "Menú (1/2): elegí una opción", [
    { id: "MENU_SEDES",    title: "📍 Sedes" },
    { id: "MENU_ESTUDIOS", title: "🧾 Estudios" },
    { id: "MENU_OBRAS",    title: "💳 Obras sociales" },
  ]);
  await sendButtons(to, "Menú (2/2): más opciones", [
    { id: "MENU_ENVIO",       title: "📤 Envío de estudio" },
    { id: "MENU_SUBIR_ORDEN", title: "📎 Subir orden" },
    { id: "MENU_OPERADOR",    title: "👤 Operador" },
  ]);
}

async function sendSedesButtons(to) {
  return sendButtons(to, "Elegí una sede para ver dirección y contacto:", [
    { id: "SEDE_QUILMES", title: "Quilmes" },
    { id: "SEDE_AVELL",   title: "Avellaneda" },
    { id: "SEDE_LOMAS",   title: "Lomas" },
  ]);
}

function sedeInfo(key) {
  const s = SEDES[key];
  return `📍 ${s.title}
Dirección: ${s.dir}
Teléfono: ${s.tel}
Email: ${s.mail}
Cómo llegar: ${s.link}

${HOURS}

${NO_TURNO}`;
}

/** ========= VALIDACIONES ========= **/
function isValidDni(s) {
  return /^[0-9]{6,9}$/.test((s || "").replace(/\D/g, ""));
}
function normalizeDate(s) {
  const t = (s || "").trim();
  const ddmmyyyy = /^([0-3]?\d)\/([01]?\d)\/(\d{4})$/;
  const yyyymmdd = /^(\d{4})-(\d{2})-(\d{2})$/;
  if (ddmmyyyy.test(t)) {
    const [, d, m, y] = t.match(ddmmyyyy);
    const dd = String(d).padStart(2, "0");
    const mm = String(m).padStart(2, "0");
    return `${y}-${mm}-${dd}`;
  }
  if (yyyymmdd.test(t)) return t;
  return null;
}
function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || "").trim());
}
function resumenEnvio(d) {
  return `📝 Solicitud de envío de estudio

Paciente: ${d.apellido}, ${d.nombre}
DNI: ${d.dni}
Fecha de nacimiento: ${d.fechaNac}
Estudio: ${d.estudio}
Sede: ${d.sede}
Envío por: ${d.via}${d.via === "Email" ? ` (${d.email})` : ""}`;
}

/** ========= SESIONES (Redis) ========= **/
async function startEnvioFlow(from) {
  await rSet(from, {
    step: "APELLIDO",
    data: {
      apellido: "",
      nombre: "",
      dni: "",
      fechaNac: "",
      estudio: "",
      sede: "",
      via: "",
      email: "",
    },
    startedAt: Date.now(),
  });
}
async function endEnvioFlow(from) { await rDel(from); }
async function getFlow(from) { return (await rGet(from)) || null; }

async function promptNext(from) {
  const s = await getFlow(from);
  if (!s) return;

  switch (s.step) {
    case "APELLIDO":
      await sendText(from, "✍️ Ingresá el **apellido** del paciente:");
      break;
    case "NOMBRE":
      await sendText(from, "Ahora ingresá el **nombre** del paciente:");
      break;
    case "DNI":
      await sendText(from, "Ingresá el **DNI** (solo números):");
      break;
    case "FECHA_NAC":
      await sendText(from, "Ingresá la **fecha de nacimiento** (DD/MM/AAAA o AAAA-MM-DD):");
      break;
    case "ESTUDIO":
      await sendText(from, "¿Qué **estudio** se realizó? (ej.: Panorámica OPG)");
      break;
    case "SEDE":
      await sendButtons(from, "Elegí la **sede** donde se realizó:", [
        { id: "EV_SEDE_QUILMES", title: "Quilmes" },
        { id: "EV_SEDE_AVELL",   title: "Avellaneda" },
        { id: "EV_SEDE_LOMAS",   title: "Lomas" },
      ]);
      break;
    case "VIA":
      await sendButtons(from, "¿Por dónde querés recibirlo?", [
        { id: "EV_VIA_WSP",   title: "WhatsApp" },
        { id: "EV_VIA_EMAIL", title: "Email" },
        { id: "BTN_CANCEL_ENVIO", title: "Cancelar" },
      ]);
      break;
    case "EMAIL_IF_NEEDED":
      await sendText(from, "📧 Ingresá el **email** para el envío:");
      break;
    case "CONFIRM": {
      const t = resumenEnvio(s.data) + "\n\n¿Confirmás el envío?";
      await sendButtons(from, t, [
        { id: "EV_CONFIRM_YES", title: "✅ Confirmar" },
        { id: "EV_CONFIRM_NO",  title: "❌ Cancelar" },
      ]);
      break;
    }
  }
}

async function handleEnvioText(from, rawBody) {
  const s = await getFlow(from);
  if (!s) return false;

  const body = (rawBody || "").trim();
  if (/^(cancelar|salir|menu|menú)$/i.test(body)) {
    await endEnvioFlow(from);
    await sendText(from, "Se canceló la solicitud. Te dejo el menú:");
    await sendMainMenuButtons(from);
    return true;
  }

  switch (s.step) {
    case "APELLIDO":
      s.data.apellido = body.toUpperCase();
      s.step = "NOMBRE";
      await rSet(from, s);
      await promptNext(from);
      return true;

    case "NOMBRE":
      s.data.nombre = body.toUpperCase();
      s.step = "DNI";
      await rSet(from, s);
      await promptNext(from);
      return true;

    case "DNI": {
      const digits = body.replace(/\D/g, "");
      if (!isValidDni(digits)) {
        await sendText(from, "El DNI no parece válido. Escribilo solo con números (6 a 9 dígitos).");
        return true;
      }
      s.data.dni = digits;
      s.step = "FECHA_NAC";
      await rSet(from, s);
      await promptNext(from);
      return true;
    }

    case "FECHA_NAC": {
      const norm = normalizeDate(body);
      if (!norm) {
        await sendText(from, "Formato de fecha no válido. Usá **DD/MM/AAAA** o **AAAA-MM-DD**.");
        return true;
      }
      s.data.fechaNac = norm;
      s.step = "ESTUDIO";
      await rSet(from, s);
      await promptNext(from);
      return true;
    }

    case "ESTUDIO":
      s.data.estudio = body;
      s.step = "SEDE";
      await rSet(from, s);
      await promptNext(from);
      return true;

    case "EMAIL_IF_NEEDED":
      if (!isValidEmail(body)) {
        await sendText(from, "Ese email no parece válido. Probá de nuevo (ej.: nombre@dominio.com).");
        return true;
      }
      s.data.email = body.trim();
      s.step = "CONFIRM";
      await rSet(from, s);
      await promptNext(from);
      return true;

    default:
      return false;
  }
}

async function handleEnvioButton(from, btnId) {
  const s = await getFlow(from);
  if (!s) return false;

  if (btnId === "BTN_CANCEL_ENVIO") {
    await endEnvioFlow(from);
    await sendText(from, "Se canceló la solicitud. Te dejo el menú:");
    await sendMainMenuButtons(from);
    return true;
  }

  switch (s.step) {
    case "SEDE":
      if (btnId === "EV_SEDE_QUILMES") s.data.sede = "Quilmes";
      else if (btnId === "EV_SEDE_AVELL") s.data.sede = "Avellaneda";
      else if (btnId === "EV_SEDE_LOMAS") s.data.sede = "Lomas de Zamora";
      else {
        await sendText(from, "Elegí una sede de los botones, por favor.");
        return true;
      }
      s.step = "VIA";
      await rSet(from, s);
      await promptNext(from);
      return true;

    case "VIA":
      if (btnId === "EV_VIA_WSP") {
        s.data.via = "WhatsApp";
        s.step = "CONFIRM";
        await rSet(from, s);
        await promptNext(from);
        return true;
      }
      if (btnId === "EV_VIA_EMAIL") {
        s.data.via = "Email";
        s.step = "EMAIL_IF_NEEDED";
        await rSet(from, s);
        await promptNext(from);
        return true;
      }
      await sendText(from, "Elegí una opción de los botones, por favor.");
      return true;

    case "CONFIRM":
      if (btnId === "EV_CONFIRM_YES") {
        await sendText(from, "✅ Recibimos tu solicitud. Un/a operador/a la gestionará a la brevedad.");
        await endEnvioFlow(from);
        await sendButtons(from, "¿Querés volver al menú o hablar con un operador?", [
          { id: "BTN_BACK_MENU", title: "↩️ Menú" },
          { id: "MENU_OPERADOR", title: "👤 Operador" },
        ]);
        return true;
      }
      if (btnId === "EV_CONFIRM_NO") {
        await endEnvioFlow(from);
        await sendText(from, "Solicitud cancelada. Te dejo el menú:");
        await sendMainMenuButtons(from);
        return true;
      }
      return true;

    default:
      return false;
  }
}

/** ========= UTIL: LOG SEGURO ========= **/
function safePush(msg) {
  try { getStore().push(msg); } catch {}
}

/** ========= HANDLER ========= **/
export default async function handler(req, res) {
  // GET: verificación del webhook
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.WSP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  // POST: eventos entrantes
  if (req.method === "POST") {
    try {
      const body = req.body;
      console.log("WEBHOOK BODY:", JSON.stringify(body));

      const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msg) return res.status(200).json({ ok: true }); // puede ser status update

      const from = toE164ArForTesting(msg.from);
      const type = msg.type;

      // Log entrante
      if (type === "text") {
        const bodyIn = msg.text?.body || "";
        safePush({
          id: `in_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
          ts: Date.now(),
          waFrom: from,
          direction: "in",
          type: "text",
          body: bodyIn,
          meta: {},
        });
      }
      if (type === "interactive") {
        const selId = msg?.interactive?.button_reply?.id || msg?.interactive?.list_reply?.id || "";
        safePush({
          id: `in_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
          ts: Date.now(),
          waFrom: from,
          direction: "in",
          type: "interactive",
          body: selId,
          meta: { raw: msg.interactive },
        });
      }

      /** --- Flujo activo: interceptar ANTES de bienvenida --- **/
      const flow = await getFlow(from);

      if (type === "text") {
        if (flow) {
          console.log("FLOW_TEXT_STEP →", from, flow.step);
          const consumed = await handleEnvioText(from, msg.text?.body || "");
          if (consumed) return res.status(200).json({ ok: true });
          await promptNext(from);
          return res.status(200).json({ ok: true });
        }
        await sendText(from, TXT_BIENVENIDA);
        await sendMainMenuButtons(from);
        return res.status(200).json({ ok: true });
      }

      if (type === "interactive") {
        const inter = msg.interactive;
        const buttonReply = inter?.button_reply;
        const selId = buttonReply?.id || "";

        if (flow) {
          console.log("FLOW_BTN_STEP →", from, flow.step, selId);
          const consumed = await handleEnvioButton(from, selId);
          if (consumed) return res.status(200).json({ ok: true });
        }

        switch (selId) {
          case "MENU_SEDES":
            await sendSedesButtons(from);
            break;

          case "MENU_ESTUDIOS":
            await sendText(from, TXT_ESTUDIOS);
            await sendButtons(from, "¿Algo más?", [
              { id: "BTN_BACK_MENU", title: "↩️ Menú" },
              { id: "MENU_OPERADOR", title: "👤 Operador" },
              { id: "MENU_OBRAS",    title: "💳 Obras" },
            ]);
            break;

          case "MENU_OBRAS":
            await sendText(from, TXT_OBRAS);
            await sendButtons(from, "¿Querés otra opción?", [
              { id: "BTN_BACK_MENU", title: "↩️ Menú" },
              { id: "MENU_OPERADOR", title: "👤 Operador" },
              { id: "MENU_ENVIO",    title: "📤 Envío" },
            ]);
            break;

          case "MENU_ENVIO":
            console.log("FLOW_START →", from);
            await startEnvioFlow(from);
            await sendText(from, "Vamos a tomar los datos para enviarte el estudio. Podés escribir **cancelar** en cualquier momento.");
            await promptNext(from); // pide APELLIDO
            return res.status(200).json({ ok: true });

          case "MENU_SUBIR_ORDEN":
            await sendText(
              from,
              "📎 Para subir tu orden, adjuntá una foto clara de la orden médica.\n" +
              "Un/a operador/a te responderá con la confirmación y pasos a seguir."
            );
            await sendButtons(from, "¿Querés volver al menú?", [
              { id: "BTN_BACK_MENU",  title: "↩️ Menú" },
              { id: "MENU_OPERADOR",  title: "👤 Operador" },
              { id: "MENU_ESTUDIOS",  title: "🧾 Estudios" },
            ]);
            break;

          case "MENU_OPERADOR":
            await sendText(from, "🗣️ Te derivamos con un/a asistente. Si escribiste fuera de horario, respondemos a primera hora hábil.");
            break;

          /** Submenú sedes **/
          case "SEDE_QUILMES":
            await sendText(from, sedeInfo("QUILMES"));
            await sendButtons(from, "¿Querés otra opción?", [
              { id: "SEDE_AVELL",    title: "Avellaneda" },
              { id: "SEDE_LOMAS",    title: "Lomas" },
              { id: "BTN_BACK_MENU", title: "↩️ Menú" },
            ]);
            break;

          case "SEDE_AVELL":
            await sendText(from, sedeInfo("AVELL"));
            await sendButtons(from, "¿Querés otra opción?", [
              { id: "SEDE_QUILMES",  title: "Quilmes" },
              { id: "SEDE_LOMAS",    title: "Lomas" },
              { id: "BTN_BACK_MENU", title: "↩️ Menú" },
            ]);
            break;

          case "SEDE_LOMAS":
            await sendText(from, sedeInfo("LOMAS"));
            await sendButtons(from, "¿Querés otra opción?", [
              { id: "SEDE_QUILMES",  title: "Quilmes" },
              { id: "SEDE_AVELL",    title: "Avellaneda" },
              { id: "BTN_BACK_MENU", title: "↩️ Menú" },
            ]);
            break;

          /** Volver al menú **/
          case "BTN_BACK_MENU":
            await sendMainMenuButtons(from);
            break;

          default:
            await sendText(from, "Te envío el menú nuevamente:");
            await sendMainMenuButtons(from);
            break;
        }

        return res.status(200).json({ ok: true });
      }

      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error("WEBHOOK ERROR:", e);
      return res.status(200).json({ ok: false, error: String(e) });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
