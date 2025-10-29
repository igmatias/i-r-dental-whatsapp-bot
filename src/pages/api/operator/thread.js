import { getStore } from "../../../lib/store";

export default async function handler(req, res) {
  const k = process.env.OPERATOR_SECRET || "";
  if (k && req.query.key !== k) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const waFrom = (req.query.waFrom || "").trim();
  if (!waFrom) return res.status(400).json({ ok: false, error: "Missing waFrom" });

  try {
    const STORE = getStore();
    if (!STORE?.getThread) return res.status(200).json({ ok: true, messages: [] });

    const messages = STORE.getThread(waFrom);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true, messages });
  } catch (e) {
    console.error("OPERATOR THREAD ERROR:", e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
}