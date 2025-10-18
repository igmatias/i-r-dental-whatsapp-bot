import { sendText } from "@/lib/whatsapp";
export default async function handler(req, res) {
  const { to, text } = req.query;
  await sendText(to, text || "Hola desde i-R Dental");
  res.json({ ok: true });
}
