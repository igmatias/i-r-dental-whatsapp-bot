# i-R Dental • WhatsApp Bot + Consola Operador (Next.js, JS)

Bot de WhatsApp (Cloud API) con menú, sedes, obras, flujo de “Solicitar envío de estudio”, “Subir orden” y consola web para operadores.

## Requisitos
- Meta for Developers (App creada) + Producto WhatsApp agregado.
- Phone Number ID y Access Token.
- Postgres (Neon o Supabase).
- Node 18+.

## Configuración
1. Copiá `.env.example` a `.env.local` (si trabajás local) y completá valores.
2. Instalá dependencias:
   ```bash
   npm i
   npx prisma generate
   npx prisma migrate deploy
   ```
3. Dev server:
   ```bash
   npm run dev
   ```
4. Deploy en Vercel:
   - Importá repo.
   - Cargá variables de entorno: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WSP_VERIFY_TOKEN`, `DATABASE_URL`, (opcional) `OBRAS_TEXT`.
   - Redeploy.

## Webhook en Meta
- URL: `https://TU-APP.vercel.app/api/wsp/webhook`
- Verify Token: el mismo que `WSP_VERIFY_TOKEN`
- Campos: **messages**

## Consola Operador
- `https://TU-APP.vercel.app/operator`

## Cron 12h
- Ya incluido en `vercel.json` como `/api/jobs/reminder-12h` (cada 30 min).
