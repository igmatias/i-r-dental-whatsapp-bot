export const dynamic = 'force-dynamic';

// ✅ GET: verificación inicial del webhook de Meta
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === process.env.WSP_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

// ✅ POST: recepción de mensajes de WhatsApp
export async function POST(req) {
  try {
    const body = await req.json();
    console.log('WEBHOOK BODY:', JSON.stringify(body));

    // Ejemplo: detectar texto "hola" y responder
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];
    const from = message?.from;
    const text = message?.text?.body?.toLowerCase();

    if (from && text) {
      console.log(`Mensaje recibido de ${from}: ${text}`);

      // Respuesta automática mínima (solo texto)
      await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: from,
          type: 'text',
          text: { body: '👋 ¡Hola! Gracias por contactar a i-R Dental. Pronto te responderemos.' }
        })
      });
    }

    return Response.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error('WEBHOOK ERROR:', error);
    return Response.json({ ok: false, error: String(error) }, { status: 200 });
  }
}
