// src/pages/api/wsp/webhook.js

const API_URL = (phoneId) => `https://graph.facebook.com/v20.0/${phoneId}/messages`;

// ======== TEXTOS =========
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

// ======== NORMALIZACIÓN (solo pruebas) =========
// TEST_RECIPIENT_FORMAT en Vercel: "no9" | "with9"
function toE164ArForTesting(raw) {
  let n = (raw || "").trim();
  if (!n.startsWith("+")) n = "+" + n; // asegurar "+"

  const mode = (process.env.TEST_RECIPIENT_FORMAT || "").toLowerCase();
  if (mode === "no9" && /^\+54911\d{8}$/.test(n)) {
    const fixed = n.replace(/^\+54911/, "+5411");
    console.log("NORMALIZED(no9):", n, "→", fixed);
    n = fixed;
  }
  if (mode === "with9" && /^\+5411\d{8}$/.test(n)) {
    const fixed = n.replace(/^\+5411/, "+54911");
    console.log("NORMALIZED(with9):", n, "→", fixed);
    n = fixed;
  }
  return n;
}

// ======== HELPERS =========
async function sendJson(to, payload) {
  try {
    console.log("USING PHONE_ID:", process.env.WHATSAPP_PHONE_ID, "SENDING TO:", to);
    const r = await fetch(API_URL(process.env.WHATSAPP_PHONE_ID), {
      method: "POST",
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
    const data = await r.json();
    if (!r.ok) {
      console.error("SEND ERROR", r.status, JSON.stringify(data));
    } else {
      console.log("MESSAGE SENT →", to);
    }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    console.error("SEND THROW", e);
    return { ok: false, status: 0, data: { error: String(e) } };
  }
}

const sendText = (to, body) => sendJson(to, { type: "text", text: { body } });

// Botones: máx 3 por mensaje (límite WhatsApp)
async function sendButtons(to, body, buttons = []) {
  const btns = buttons.slice(0, 3).map((b) => ({
    type: "reply",
    reply: { id: b.id, title: b.title },
  }));
  return sendJson(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body }, // sin 'type'
      action: { buttons: btns },
    },
  });
}

// Menú principal con botones (dos tandas para cubrir todo)
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

// Botones de sedes
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

// ======== HANDLER =========
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

      // 1) TEXTO: bienvenida + botones (SIN lista, para evitar bloqueos)
      if (type === "text") {
        await sendText(from, TXT_BIENVENIDA);
        await sendMainMenuButtons(from);
      }

      // 2) INTERACTIVE (botones)
      if (type === "interactive") {
        const inter = msg.interactive;
        const buttonReply = inter?.button_reply;
        const selId = buttonReply?.id || "";

        switch (selId) {
          // ===== Menú principal =====
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
            await sendText(
              from,
              "📤 Para solicitar el envío de un estudio, por favor indicá:\n\n" +
              "• Apellido y Nombre\n• DNI\n• Fecha de nacimiento\n• Estudio realizado\n• Sede (Quilmes / Avellaneda / Lomas)\n" +
              "• Preferencia de envío (WhatsApp o Email — si es email, indicarlo)\n\n" +
              "Un/a operador/a lo gestionará a la brevedad. 🙌"
            );
            await sendButtons(from, "¿Querés volver al menú?", [
              { id: "BTN_BACK_MENU",   title: "↩️ Menú" },
              { id: "MENU_OPERADOR",   title: "👤 Operador" },
              { id: "MENU_SUBIR_ORDEN", title: "📎 Subir orden" },
            ]);
            break;

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

          // ===== Submenú sedes =====
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

          // ===== Volver al menú =====
          case "BTN_BACK_MENU":
            await sendMainMenuButtons(from);
            break;

          default:
            await sendText(from, "Te envío el menú nuevamente:");
            await sendMainMenuButtons(from);
            break;
        }
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
