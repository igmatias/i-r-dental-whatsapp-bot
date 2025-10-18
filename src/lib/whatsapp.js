  const BASE = (phoneId) => `https://graph.facebook.com/v20.0/${phoneId}/messages`;

  export async function sendText(to, body) {
    await fetch(BASE(process.env.WHATSAPP_PHONE_ID), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    });
  }

  export async function sendMainMenu(to) {
    const text = `¡Hola! 👋 Gracias por escribirnos a i-R Dental.

🕒 Horarios (todas las sedes)
• Lun a Vie: 09:00–17:30
• Sáb: 09:00–12:30

📌 SIN TURNO, por orden de llegada.

Elegí una opción:`;

    await fetch(BASE(process.env.WHATSAPP_PHONE_ID), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text },
          action: {
            buttons: [
              { type: "reply", reply: { id: "BTN_SEDES",    title: "Información de sedes" } },
              { type: "reply", reply: { id: "BTN_ESTUDIOS", title: "Estudios que realizamos" } },
              { type: "reply", reply: { id: "BTN_OBRAS",    title: "Obras sociales activas" } },
              { type: "reply", reply: { id: "BTN_ENVIO",    title: "Solicitar envío de estudio" } },
              { type: "reply", reply: { id: "BTN_ORDEN",    title: "Subir orden" } },
              { type: "reply", reply: { id: "BTN_HUMANO",   title: "Hablar con una persona" } },
            ],
          },
          footer: { text: "i-R Dental • +54 11 7044-2131" },
        },
      }),
    });
  }

  export async function sendSedesList(to) {
    await fetch(BASE(process.env.WHATSAPP_PHONE_ID), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "list",
          header: { type: "text", text: "Información de sedes • i-R Dental" },
          body: { text: "Elegí una sede para ver dirección, contacto y horarios:" },
          footer: { text: "Atención SIN TURNO" },
          action: {
            button: "Elegir sede",
            sections: [
              {
                title: "Sedes",
                rows: [
                  { id: "SEDE_QUILMES", title: "Quilmes",         description: "Olavarría 88" },
                  { id: "SEDE_AVELL",   title: "Avellaneda",      description: "9 de Julio 64 — 2° A" },
                  { id: "SEDE_LOMAS",   title: "Lomas de Zamora", description: "España 156 — PB" },
                ],
              },
            ],
          },
        },
      }),
    });
  }
