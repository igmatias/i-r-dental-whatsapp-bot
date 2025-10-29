import { getStore } from "../../../lib/store";

export default async function handler(req, res) {
  const k = process.env.OPERATOR_SECRET || "";
  if (k && req.query.key !== k) return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const STORE = getStore();
    if (!STORE?.listThreads) return res.status(200).json({ ok: true, threads: [] }); // fallback

    const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);
    const threads = STORE.listThreads(limit);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true, threads });
  } catch (e) {
    console.error("OPERATOR EVENTS ERROR:", e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
}