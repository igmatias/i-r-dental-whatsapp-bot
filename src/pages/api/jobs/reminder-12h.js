import { prisma } from "@/lib/db";
export default async function handler(req, res) {
  const twelveHrsAgo = new Date(Date.now() - 12*60*60*1000);
  const pending = await prisma.ticket.findMany({
    where: {
      reason: "Envio de estudio",
      status: { not: "resolved" },
      createdAt: { lte: twelveHrsAgo },
    },
  });
  res.json({ count: pending.length, pending });
}
