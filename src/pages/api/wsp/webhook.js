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

const TXT_BIENVENIDA = `¡Hola! 👋 Gracias por escribirnos a i-R Dental.

${HOURS}

${NO_TURNO}

Elegí una opción del menú para continuar.`;

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

// ======== HELPERS =========
async function sendJson(to, payload) {
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
  return { ok: r.ok, status: r.status, data };
}

async function sendText(to, body) {
  return sendJson(to, { type: "text", text: { body } });
}

async function sendMainMenu(to) {
  // Usamos LISTA para poder ofrecer muchas opciones
  const rows = [
    { id: "MENU_INFO_GENERAL", title: "ℹ️ Información general" },
    { id: "MENU_SEDES", title: "📍 Información de sedes" },
    { id: "MENU_ESTUDIOS", title: "🧾 Estudios que realizamos" },
    { id: "MENU_OBRAS", title: "💳 Obras sociales activas" },
    { id: "MENU_ENVIO", title: "📤 Solicitar envío de un estudio" },
    { id: "MENU_SUBIR_ORDEN", title: "📎 Subir orden" },
    { id: "MENU_OPERADOR", title: "🗣️ Hablar con una persona" },
  ].map(r => ({ id: r.id, title: r.title }));

  return sendJson(to, {
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "i-R Dental" },
      body: { type: "text", text: TXT_BIENVENIDA },
      footer: { type: "text", text: "Seleccioná una opción" },
      action: {
        button: "Abrir menú",
        sections: [{ title: "Opciones", rows }],
      },
    },
  });
}

async function sendSedesList(to) {
  const rows = [
    { id: "SEDE_QUILMES", title: "Quilmes — Olavarría 88" },
    { id: "SEDE_AVELL", title: "Avellaneda — 9 de Julio 64 — 2° A" },
    { id: "SEDE_LOMAS", title: "Lomas de Zamora — España 156 — PB" },
  ];
  return sendJson(to, {
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Sedes i-R Dental" },
      body: { type: "text", text: "Elegí una sede para ver dirección, contacto y cómo llegar." },
      action: { button: "Elegir sede", sections: [{ title: "Sedes", rows }] },
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
      if (!msg) return res.status(200).json({ ok: true }); // eventos no relacionados (statuses, etc.)

      const from = msg.from;
      const type = msg.type;

      // 1) Mensaje de TEXTO → disparar menú si dice "hola" o algo parecido, o información general por defecto
      if (type === "text") {
        const text = (msg.text?.body || "").trim().toLowerCase();
        if (["hola", "menu", "buenas", "ir dental", "i-r dental"].some(k => text.includes(k))) {
          await sendMainMenu(from);
        } else {
          // Respuesta por defecto + menú
          await sendText(from, "¡Gracias por escribirnos! Te compartimos la información general y el menú:");
          await sendMainMenu(from);
        }
      }

      // 2) Respuesta INTERACTIVA (botón/lista)
      if (type === "interactive") {
        const inter = msg.interactive;
        const buttonReply = inter?.button_reply;
        const listReply = inter?.list_reply;

        const selId = buttonReply?.id || listReply?.id;

        switch (selId) {
          // Menú principal
          case "MENU_INFO_GENERAL":
            await sendText(from, `${HOURS}\n\n${NO_TURNO}`);
            await sendMainMenu(from);
            break;

          case "MENU_SEDES":
            await sendSedesList(from);
            break;

          case "MENU_ESTUDIOS":
            await sendText(from, TXT_ESTUDIOS);
            await sendMainMenu(from);
            break;

          case "MENU_OBRAS":
            await sendText(from, TXT_OBRAS);
            await sendMainMenu(from);
            break;

          case "MENU_ENVIO":
            await sendText(
              from,
              "📤 Para solicitar el envío de un estudio, por favor indicá:\n\n• Apellido y Nombre\n• DNI\n• Fecha de nacimiento\n• Estudio realizado\n• Sede (Quilmes / Avellaneda / Lomas)\n• Preferencia de envío (WhatsApp o Email — si es email, indicarlo)\n\nUn/a operador/a lo gestionará a la brevedad. 🙌"
            );
            await sendMainMenu(from);
            break;

          case "MENU_SUBIR_ORDEN":
            await sendText(
              from,
              "📎 Para subir tu orden, adjuntá una foto clara de la orden médica.\nUn/a operador/a te responderá con la confirmación y pasos a seguir."
            );
            await sendMainMenu(from);
            break;

          case "MENU_OPERADOR":
            await sendText(
              from,
              "🗣️ Te derivamos con un/a asistente. Si escribiste fuera de horario, respondemos a primera hora hábil."
            );
            // Acá podrías notificar a tu consola interna / ticketing si ya la tenés conectada.
            break;

          // Submenú sedes
          case "SEDE_QUILMES":
            await sendText(from, sedeInfo("QUILMES"));
            await sendMainMenu(from);
            break;
          case "SEDE_AVELL":
            await sendText(from, sedeInfo("AVELL"));
            await sendMainMenu(from);
            break;
          case "SEDE_LOMAS":
            await sendText(from, sedeInfo("LOMAS"));
            await sendMainMenu(from);
            break;

          default:
            // Desconocido → devolver menú
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
