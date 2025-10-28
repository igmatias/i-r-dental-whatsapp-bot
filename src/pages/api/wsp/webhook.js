export default async function handler(req, res) {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.WSP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  if (req.method === 'POST') {
    try {
      console.log('WEBHOOK BODY:', JSON.stringify(req.body));
      const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      const from = msg?.from;
      const text = msg?.text?.body?.toLowerCase();

      if (from && text) {
        await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: from,
            type: 'text',
            text: { body: '👋 ¡Hola! Gracias por contactar a i-R Dental. Pronto te responderemos.' },
          }),
        });
      }
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('WEBHOOK ERROR:', e);
      return res.status(200).json({ ok: false, error: String(e) });
    }
  }

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
