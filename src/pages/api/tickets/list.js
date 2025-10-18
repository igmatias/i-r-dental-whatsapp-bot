import { prisma } from "@/lib/db";
export default async function handler(req, res) {
  const tickets = await prisma.ticket.findMany({ orderBy: { createdAt: "desc" } });
  res.json({ tickets });
}
