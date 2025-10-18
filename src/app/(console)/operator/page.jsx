"use client";
import useSWR from "swr";
const fetcher = (url)=>fetch(url).then(r=>r.json());
export default function OperatorConsole() {
  const { data } = useSWR("/api/tickets/list", fetcher);
  const tickets = data?.tickets || [];
  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold">Consola del Operador</h1>
      <div className="mt-4 grid gap-3">
        {tickets.map((t)=> (<div key={t.id} className="border rounded-xl p-3">#{t.id} • {t.reason}</div>))}
        {tickets.length===0 && (<div>No hay tickets por ahora.</div>)}
      </div>
    </div>
  );
}
