export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ ok: false, error: `Method ${req.method} Not Allowed` });
  }

  const hasToken = Boolean(process.env.WHATSAPP_TOKEN);
  const hasPhoneId = Boolean(process.env.WHATSAPP_PHONE_ID);
  const hasVerify = Boolean(process.env.WSP_VERIFY_TOKEN);

  return res.status(200).json({
    ok: true,
    env: {
      WHATSAPP_TOKEN: hasToken ? 'present' : 'missing',
      WHATSAPP_PHONE_ID: hasPhoneId ? 'present' : 'missing',
      WSP_VERIFY_TOKEN: hasVerify ? 'present' : 'missing',
    },
  });
}
