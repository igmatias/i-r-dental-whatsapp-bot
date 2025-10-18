import { prisma } from "@/lib/db";
import { sendMainMenu, sendSedesList, sendText } from "@/lib/whatsapp";

export default async function handler(req, res) {
  // GET verification
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.WSP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).end("Forbidden");
  }

  const body = req.body;
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const msg = value?.messages?.[0];
  if (!msg) return res.status(200).json({ ok: true });

  const waFrom = msg.from;
  const textBody = msg.text?.body?.trim();
  const interactive = msg.interactive;
  const buttonId = interactive?.button_reply?.id;
  const listId = interactive?.list_reply?.id;

  // Routers
  if (buttonId === "BTN_SEDES") { await sendSedesList(waFrom); return res.status(200).json({ ok:true }); }
  if (buttonId === "BTN_ESTUDIOS") { await sendText(waFrom, `🧾 Estudios i-R Dental:\n• Panorámica (OPG)\n• Cefalométrica (lateral/PA)\n• Periapicales\n• Oclusales\n• Serie completa\n• ATM básica\n• CBCT / Tomografía (si corresponde)\n• Fotografías intra/extraorales (si corresponde)\n\n✅ SIN TURNO, por orden de llegada.\n0) Volver`); return res.status(200).json({ ok:true }); }
  if (buttonId === "BTN_OBRAS") { await sendText(waFrom, process.env.OBRAS_TEXT || "Obras sociales activas…\n0) Volver"); return res.status(200).json({ ok:true }); }
  if (buttonId === "BTN_ENVIO") {
    await prisma.conversationState.upsert({
      where: { waFrom },
      create: { waFrom, flow: "envio_estudio", step: 0, data: {} },
      update: { flow: "envio_estudio", step: 0, data: {} }
    });
    await handleEnvioEstudioStep(waFrom);
    return res.status(200).json({ ok:true });
  }
  if (buttonId === "BTN_ORDEN") {
    await prisma.conversationState.upsert({
      where: { waFrom },
      create: { waFrom, flow: "subir_orden", step: 0, data: {} },
      update: { flow: "subir_orden", step: 0, data: {} }
    });
    await handleSubirOrdenStep(waFrom, msg);
    return res.status(200).json({ ok:true });
  }
  if (buttonId === "BTN_HUMANO") {
    const t = await prisma.ticket.create({ data: { waFrom, reason: "Solicitud desde menú", status: "waiting" }});
    await prisma.message.create({ data: { ticketId: t.id, direction: "in", body: "[Hablar con persona]" }});
    await sendText(waFrom, "⏳ Te derivamos con un/a asistente. Si escribiste fuera de horario, respondemos a primera hora hábil.\n0) Volver");
    return res.status(200).json({ ok:true });
  }

  // List replies (sedes)
  if (listId === "SEDE_QUILMES") {
    await sendText(waFrom, "📍 Sede Quilmes — i-R Dental\nDirección: Olavarría 88\nTeléfono: 4257-1222\nEmail: quilmes@irdental.com.ar\nCómo llegar: https://maps.app.goo.gl/8j58wRew5mdYRwdM7\n🕒 Lun a Vie 09:00–17:30 | Sáb 09:00–12:30\n📌 SIN TURNO, por orden de llegada.\n0) Volver");
    return res.status(200).json({ ok:true });
  }
  if (listId === "SEDE_AVELL") {
    await sendText(waFrom, "📍 Sede Avellaneda — i-R Dental\nDirección: 9 de Julio 64 - 2° A\nTeléfono: 4222-5553\nEmail: avellaneda@irdental.com.ar\nCómo llegar: https://maps.app.goo.gl/WZY2x6RS8AKs7N3X6\n🕒 Lun a Vie 09:00–17:30 | Sáb 09:00–12:30\n📌 SIN TURNO, por orden de llegada.\n0) Volver");
    return res.status(200).json({ ok:true });
  }
  if (listId === "SEDE_LOMAS") {
    await sendText(waFrom, "📍 Sede Lomas de Zamora — i-R Dental\nDirección: España 156 - PB\nTeléfono: 4244-0148\nEmail: lomas@irdental.com.ar\nCómo llegar: https://maps.app.goo.gl/UARCmN2jZRm19ycy7\n🕒 Lun a Vie 09:00–17:30 | Sáb 09:00–12:30\n📌 SIN TURNO, por orden de llegada.\n0) Volver");
    return res.status(200).json({ ok:true });
  }

  // State machine by text
  const state = await prisma.conversationState.findUnique({ where: { waFrom }});
  if (state?.flow === "envio_estudio") {
    await handleEnvioEstudioStep(waFrom, textBody);
    return res.status(200).json({ ok:true });
  }
  if (state?.flow === "subir_orden") {
    await handleSubirOrdenStep(waFrom, msg);
    return res.status(200).json({ ok:true });
  }

  // Fallback: greetings -> menu
  if (textBody && ["hola","menu","menú","buenas","buen día","buenos días","inicio"].includes(textBody.toLowerCase())) {
    await sendMainMenu(waFrom);
    return res.status(200).json({ ok:true });
  }
  await sendText(waFrom, "No te entendí 🤔. Te dejo el menú:");
  await sendMainMenu(waFrom);
  return res.status(200).json({ ok:true });
}

async function resetState(waFrom) {
  await prisma.conversationState.deleteMany({ where: { waFrom } }).catch(()=>{});
}

async function upsertState(waFrom, patch) {
  const current = await prisma.conversationState.findUnique({ where: { waFrom }});
  if (!current) {
    return prisma.conversationState.create({ data: { waFrom, flow: patch.flow || null, step: patch.step || 0, data: patch.data || {} }});
  }
  return prisma.conversationState.update({ where: { waFrom }, data: { flow: patch.flow ?? current.flow, step: patch.step ?? current.step, data: patch.data ?? current.data }});
}

async function handleEnvioEstudioStep(waFrom, text) {
  const state = await prisma.conversationState.findUnique({ where: { waFrom }});
  const step = state?.step ?? 0;
  const data = (state?.data) || {};

  const ask = async (msg) => sendText(waFrom, msg + "\n(Escribí 0 para volver al menú)");

  if (text === "0") { await resetState(waFrom); await sendMainMenu(waFrom); return; }

  switch (step) {
    case 0: await upsertState(waFrom, { flow: "envio_estudio", step: 1, data }); return ask("Decime el APELLIDO del paciente:");
    case 1: data.apellido = (text||"").trim(); await upsertState(waFrom, { step: 2, data }); return ask("Ahora el NOMBRE del paciente:");
    case 2: data.nombre = (text||"").trim(); await upsertState(waFrom, { step: 3, data }); return ask("DNI del paciente:");
    case 3: {
      const dni = (text||"").replace(/\D/g, ""); if (dni.length<7||dni.length>9) return ask("DNI inválido. Ingresá solo números:");
      data.dni = dni; await upsertState(waFrom, { step: 4, data }); return ask("Fecha de nacimiento (DD/MM/AAAA):"); }
    case 4: {
      const ok = /^(\d{2})\/(\d{2})\/(\d{4})$/.test(text||""); if (!ok) return ask("Formato inválido. Usá DD/MM/AAAA:");
      data.fechaNac = (text||"").trim(); await upsertState(waFrom, { step: 5, data }); return ask("¿Qué estudio se realizó?"); }
    case 5: data.estudio = (text||"").trim(); await upsertState(waFrom, { step: 6, data }); return ask("¿En qué sede? (Quilmes / Avellaneda / Lomas de Zamora)"); 
    case 6: {
      const sede = (text||"").toLowerCase();
      if (!["quilmes","avellaneda","lomas de zamora","lomas"].includes(sede)) return ask("Ingresá una sede válida: Quilmes / Avellaneda / Lomas de Zamora");
      data.sede = sede.includes("lomas") ? "Lomas de Zamora" : (sede[0].toUpperCase()+sede.slice(1));
      await upsertState(waFrom, { step: 7, data }); return ask("¿Por dónde querés recibir el estudio? (WhatsApp / Email)"); }
    case 7: {
      const via = (text||"").toLowerCase(); if (!["whatsapp","email"].includes(via)) return ask("Elegí: WhatsApp o Email");
      data.via = via === "email" ? "Email" : "WhatsApp";
      if (data.via === "Email") { await upsertState(waFrom, { step: 8, data }); return ask("Decinos el email:"); }
      await upsertState(waFrom, { step: 9, data }); /* skip email */ }
    case 8: {
      const email = (text||"").trim(); const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!ok) return ask("Email inválido. Intentá de nuevo:");
      data.email = email; await upsertState(waFrom, { step: 9, data }); }
    case 9: {
      const resumen = `Solicitud de envío de estudio\n\nPaciente: ${data.apellido}, ${data.nombre}\nDNI: ${data.dni}\nFecha de nacimiento: ${data.fechaNac}\nEstudio: ${data.estudio}\nSede: ${data.sede}\nEnvío por: ${data.via}${data.email?` (${data.email})`:''}\n\n¿Confirmás? (Sí/No)`;
      await upsertState(waFrom, { step: 10, data }); return sendText(waFrom, resumen); }
    case 10: {
      const ok = (text||"").trim().toLowerCase(); if (!["si","sí","yes","ok"].includes(ok)) { await resetState(waFrom); await sendText(waFrom, "Cancelado. Volvemos al menú."); return sendMainMenu(waFrom); }
      const ticket = await prisma.ticket.create({ data: { waFrom, reason: "Envio de estudio", status: "waiting", payload: data } });
      await prisma.message.create({ data: { ticketId: ticket.id, direction: "in", body: "[Solicitud de envío]" }});
      await sendText(waFrom, "✅ Recibimos tu solicitud. Un/a operador/a la gestionará a la brevedad. Si es fuera de horario, te contactamos a primera hora hábil.");
      await resetState(waFrom); return sendMainMenu(waFrom); }
  }
}

async function handleSubirOrdenStep(waFrom, msg) {
  const state = await prisma.conversationState.findUnique({ where: { waFrom }});
  const step = state?.step ?? 0;
  const data = (state?.data) || {};
  const ask = async (m) => sendText(waFrom, m + "\n(Escribí 0 para volver al menú)");

  if (msg?.text?.body?.trim() === "0") { await resetState(waFrom); return sendMainMenu(waFrom); }

  if (step === 0) { await upsertState(waFrom, { flow: "subir_orden", step: 1, data }); return ask("Adjuntá una foto o PDF de la orden (enviá como documento o imagen)."); }
  if (step === 1) {
    const media = msg.image || msg.document; if (!media) return ask("No vi ningún archivo. Enviá una IMAGEN o PDF como documento.");
    data.archivoId = media.id; data.mime = media.mime_type; data.filename = msg.document?.filename;
    await upsertState(waFrom, { step: 2, data }); return ask("¿Querés agregar un comentario? (opcional). Escribilo o poné 'no'.");
  }
  if (step === 2) {
    data.comentario = msg.text?.body || "-";
    const ticket = await prisma.ticket.create({ data: { waFrom, reason: "Orden médica", status: "waiting", payload: data } });
    await prisma.message.create({ data: { ticketId: ticket.id, direction: "in", body: "[Orden médica]" }});
    await sendText(waFrom, "✅ Recibimos tu orden médica. Un/a operador/a la revisará y te responderá a la brevedad.");
    await resetState(waFrom); return sendMainMenu(waFrom);
  }
}
