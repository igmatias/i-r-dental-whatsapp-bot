export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ ok: false, error: `Method ${req.method} Not Allowed` });
  }

  try {
    const to = req.query.to; // E.164, ej: +54911XXXXXXXX
    const text = req.query.text || '✅ Prueba desde i-R Dental';

    if (!to) {
      return res.status(400).json({ ok: false, error: 'Missing ?to=E164 (ej: +54911XXXXXXXX)' });
    }
    if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_ID) {
      return res.status(500).json({ ok: false, error: 'Env vars missing (WHATSAPP_TOKEN / WHATSAPP_PHONE_ID)' });
    }

    const r = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    });

    const data = await r.json();
    return res.status(r.ok ? 200 : r.status).json({ ok: r.ok, status: r.status, data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
