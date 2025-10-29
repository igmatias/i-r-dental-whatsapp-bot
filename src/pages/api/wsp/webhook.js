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
• AMFFA
• ANSSAL APDIS
• APESA SALUD
• CENTRO MEDICO PUEYRREDON
• COLEGIO DE ESCRIBANOS PROVINCIA DE BUENOS AIRES
• DASUTEN
• DOCTHOS
• ELEVAR*
• ESPORA SALUD*
• FATFA
• FEMEBA AVELLANEDA
• HOSPITAL BRITANICO
• HOSPITAL ITALIANO
• LUIS PASTEUR
• MEDICUS*
• NUBIAL
• OMA
• OMINT*
• OSDE
• OSDIPP
• OSMEBA
• OPSA
• PODER JUDICIAL (en orden de Federación Odontológica)*
• PROGRAMAS MEDICOS
• QUALITAS
• SANCOR SALUD*
• SERVESALUD*
• SETIA
• SIMECO
• SIND. MUNIC. AVELLANEDA
• SWISS MEDICAL*

(*) En la orden debe incluirse el Diagnóstico.

⚠️ Este listado puede presentar modificaciones. Por favor consulte telefónicamente, por mail o por WhatsApp con el operador.`;

// ======== NORMALIZACIÓN (solo para pruebas) =========
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
  if (!r.ok) console.error("SEND ERROR", r.status, JSON.stringify(data));
  else console.log("MESSAGE SENT →", to);
  return { ok: r.ok, status: r.status, data };
}

const sendText = (to, body) => sendJson(to, { type: "text", text: { body } });

async function sendButtons(to, body, buttons = []) {
  // Botones: [{ id, title }, ...]
  const btns = buttons.map((b) => ({
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

async function sendMainMenu(to) {
  return sendJson(to, {
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "i-R Dental" }, // header sí admite 'type'
      body: { text: TXT_BIENVENIDA },               // sin 'type'
      footer: { text: "Seleccioná una opción" },    // sin 'type'
      action: {
        button: "Abrir menú",
        sections: [
          {
            title: "Opciones",
            rows: [
              { id: "MENU_INFO_GENERAL", title: "ℹ️ Información general" },
              { id: "MENU_SEDES",        title: "📍 Información de sedes" },
              { id: "MENU_ESTUDIOS",     title: "🧾 Estudios que realizamos" },
              { id: "MENU_OBRAS",        title: "💳 Obras sociales activas" },
              { id: "MENU_ENVIO",        title: "📤 Solicitar envío de un estudio" },
              { id: "MENU_SUBIR_ORDEN",  title: "📎 Subir orden" },
              { id: "MENU_OPERADOR",     title: "🗣️ Hablar con una persona" },
            ],
          },
        ],
      },
    },
  });
}

async function sendSedesList(to) {
  return sendJson(to, {
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Sedes i-R Dental" },
      body: { text: "Elegí una sede para ver dirección, contacto y cómo llegar." },
      action: {
        button: "Elegir sede",
        sections: [
          {
            title: "Sedes",
            rows: [
              { id: "SEDE_QUILMES", title: "Quilmes — Olavarría 88" },
              { id: "SEDE_AVELL",   title: "Avellaneda — 9 de Julio 64 — 2° A" },
              { id: "SEDE_LOMAS",   title: "Lomas de Zamora — España 156 — PB" },
            ],
          },
        ],
      },
    },
  });
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

      // 1) TEXTO: siempre enviar texto y luego menú (fallback si la lista falla)
      if (type === "text") {
        await sendText(from, `¡Hola! 👋 Gracias por escribirnos a i-R Dental.\n\n${HOURS}\n\n${NO_TURNO}`);
        await sendMainMenu(from);
      }

      // 2) INTERACTIVE (botones/lista)
      if (type === "interactive") {
        const inter = msg.interactive;
        const buttonReply = inter?.button_reply;
        const listReply = inter?.list_reply;
        const selId = buttonReply?.id || listReply?.id || "";

        switch (selId) {
          // ===== Menú principal =====
          case "MENU_INFO_GENERAL":
            await sendText(from, `${HOURS}\n\n${NO_TURNO}`);
            await sendButtons(from, "¿Querés hacer otra consulta?", [
              { id: "BTN_BACK_MENU", title: "↩️ Volver al menú" },
              { id: "MENU_OPERADOR", title: "👤 Operador" },
            ]);
            break;

          case "MENU_SEDES":
            await sendSedesList(from);
            break;

          case "MENU_ESTUDIOS":
            await sendText(from, TXT_ESTUDIOS);
            await sendButtons(from, "¿Algo más?", [
              { id: "BTN_BACK_MENU", title: "↩️ Volver al menú" },
              { id: "MENU_OPERADOR", title: "👤 Operador" },
            ]);
            break;

          case "MENU_OBRAS":
            await sendText(from, TXT_OBRAS);
            await sendButtons(from, "¿Querés volver al menú o hablar con un operador?", [
              { id: "BTN_BACK_MENU", title: "↩️ Volver al menú" },
              { id: "MENU_OPERADOR", title: "👤 Operador" },
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
              { id: "BTN_BACK_MENU", title: "↩️ Volver al menú" },
              { id: "MENU_OPERADOR", title: "👤 Operador" },
            ]);
            break;

          case "MENU_SUBIR_ORDEN":
            await sendText(
              from,
              "📎 Para subir tu orden, adjuntá una foto clara de la orden médica.\n" +
              "Un/a operador/a te responderá con la confirmación y pasos a seguir."
            );
            await sendButtons(from, "¿Querés volver al menú?", [
              { id: "BTN_BACK_MENU", title: "↩️ Volver al menú" },
              { id: "MENU_OPERADOR", title: "👤 Operador" },
            ]);
            break;

          case "MENU_OPERADOR":
            await sendText(
              from,
              "🗣️ Te derivamos con un/a asistente. Si escribiste fuera de horario, respondemos a primera hora hábil."
            );
            break;

          // ===== Submenú sedes =====
          case "SEDE_QUILMES":
            await sendText(from, sedeInfo("QUILMES"));
            await sendButtons(from, "¿Querés otra opción?", [
              { id: "BTN_BACK_MENU", title: "↩️ Volver al menú" },
              { id: "MENU_OPERADOR", title: "👤 Operador" },
            ]);
            break;

          case "SEDE_AVELL":
            await sendText(from, sedeInfo("AVELL"));
            await sendButtons(from, "¿Querés otra opción?", [
              { id: "BTN_BACK_MENU", title: "↩️ Volver al menú" },
              { id: "MENU_OPERADOR", title: "👤 Operador" },
            ]);
            break;

          case "SEDE_LOMAS":
            await sendText(from, sedeInfo("LOMAS"));
            await sendButtons(from, "¿Querés otra opción?", [
              { id: "BTN_BACK_MENU", title: "↩️ Volver al menú" },
              { id: "MENU_OPERADOR", title: "👤 Operador" },
            ]);
            break;

          // ===== Botón: volver al menú =====
          case "BTN_BACK_MENU":
            await sendMainMenu(from);
            break;

          default:
            await sendText(from, "Te envío el menú nuevamente:");
            await sendMainMenu(from);
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
