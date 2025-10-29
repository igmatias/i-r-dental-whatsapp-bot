const API_URL = (phoneId) => `https://graph.facebook.com/v20.0/${phoneId}/messages`;

// ======== TEXTOS =========
const HOURS = `🕒 Horarios (todas las sedes)
• Lunes a viernes: 09:00 a 17:30
• Sábados: 09:00 a 12:30`;
const NO_TURNO = `📌 Atención SIN TURNO, por orden de llegada.`;

const LINKS = {
  QUILMES: "https://maps.app.goo.gl/8j58wRew5mdYRwdM7",
  AVELL: "https://maps.app.goo.gl/WZY2x6RS8AKs7N3X6",
  LOMAS: "https://maps.app.goo.gl/UARCmN2jZRm19ycy7",
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

// ======== NORMALIZACIÓN AR =========
function toE164ArForTesting(raw) {
  let n = (raw || "").trim();

  // Asegura que tenga "+"
  if (!n.startsWith("+")) n = "+" + n;

  // Ajuste según formato de test
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

async function sendMainMenu(to) {
  return sendJson(to, {
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "i-R Dental" },
      body: { text: TXT_BIENVENIDA },
      footer: { text: "Seleccioná una opción" },
      action: {
        button: "Abrir menú",
        sections: [
          {
            title: "Opciones",
            rows: [
              { id: "MENU_INFO_GENERAL", title: "ℹ️ Información general" },
              { id: "MENU_SEDES", title: "📍 Información de sedes" },
              { id: "MENU_ESTUDIOS", title: "🧾 Estudios que realizamos" },
              { id: "MENU_OBRAS", title: "💳 Obras sociales activas" },
              { id: "MENU_ENVIO", title: "📤 Solicitar envío de un estudio" },
              { id: "MENU_SUBIR_ORDEN", title: "📎 Subir orden" },
              { id: "MENU_OPERADOR", title: "🗣️ Hablar con una persona" },
            ],
          },
        ],
      },
    },
  });
}

// ======== HANDLER =========
export default async function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.WSP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method === "POST") {
    try {
      const body = req.body;
      console.log("WEBHOOK BODY:", JSON.stringify(body));

      const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msg) return res.status(200).json({ ok: true });

      const fromRaw = msg.from;
      const from = toE164ArForTesting(fromRaw);
      const type = msg.type;

      if (type === "text") {
        await sendText(from, `¡Hola! 👋 Gracias por escribirnos a i-R Dental.\n\n${HOURS}\n\n${NO_TURNO}`);
        await sendMainMenu(from);
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
