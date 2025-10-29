import { getStore } from "../../../lib/store";
const API_URL = (id) => `https://graph.facebook.com/v20.0/${id}/messages`;

export default async function handler(req, res) {
  const k = process.env.OPERATOR_SECRET || "";
  if (k && req.query.key !== k) return res.status(401).json({ ok: false, error: "Unauthorized" });

  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ ok: false, error: "Missing to/text" });

    const r = await fetch(API_URL(process.env.WHATSAPP_PHONE_ID), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("OPERATOR REPLY ERROR", r.status, JSON.stringify(data));
      return res.status(r.status).json({ ok: false, data });
    }

    // log saliente
    const STORE = getStore();
    STORE.push({
      id: `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      waFrom: to,
      direction: "out",
      type: "text",
      body: text,
      meta: { by: "operator", via: "portal" },
    });

    return res.status(200).json({ ok: true, data });
  } catch (e) {
    console.error("OPERATOR REPLY THROW:", e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
