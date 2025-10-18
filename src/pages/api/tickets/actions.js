import { prisma } from "@/lib/db";
import { sendText } from "@/lib/whatsapp";
export default async function handler(req, res) {
  if (req.method !== "PATCH") return res.status(405).end();
  const { id, action, assignee } = req.body || {};
  const t = await prisma.ticket.findUnique({ where: { id: Number(id) }});
  if (!t) return res.status(404).json({ error: "Ticket not found" });

  if (action === "assign") {
    await prisma.ticket.update({ where: { id: t.id }, data: { status: "assigned", assignee: assignee || "Operador" } });
    await sendText(t.waFrom, `✅ Estás ahora conversando con ${assignee||"Operador"}. ¿En qué puedo ayudarte?`);
  } else if (action === "resolve") {
    await prisma.ticket.update({ where: { id: t.id }, data: { status: "resolved" } });
    await sendText(t.waFrom, "🦷 Tu gestión fue cerrada correctamente. ¡Gracias por elegir i-R Dental!");
  } else if (action === "transfer") {
    await prisma.ticket.update({ where: { id: t.id }, data: { status: "assigned", assignee: assignee || "Operador 2" } });
  }
  res.json({ ok: true });
}
