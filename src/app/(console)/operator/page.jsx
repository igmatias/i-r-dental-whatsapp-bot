"use client";
import useSWR from "swr";

const fetcher = (url)=>fetch(url).then(r=>r.json());

export default function OperatorConsole() {
  const { data, mutate } = useSWR("/api/tickets/list", fetcher);
  async function act(id, action) {
    await fetch("/api/tickets/actions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action, assignee: action==="assign" ? "Operador 1" : (action==="transfer"?"Operador 2":undefined) }),
    });
    mutate();
  }

  const tickets = data?.tickets || [];

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold">Consola del Operador</h1>
      <p className="text-sm text-neutral-600">Tickets: waiting / assigned / resolved</p>
      <div className="mt-4 grid gap-3">
        {tickets.map((t)=> (
          <div key={t.id} className="border rounded-xl p-3">
            <div className="font-medium">#{t.id} • {t.reason} • {t.status}</div>
            <div className="text-xs text-neutral-600">De: {t.waFrom} • {new Date(t.createdAt).toLocaleString()}</div>
            {t.payload && (<pre className="bg-neutral-50 text-xs p-2 rounded mt-2 overflow-auto">{JSON.stringify(t.payload, null, 2)}</pre>)}
            <div className="mt-2 flex gap-2">
              <button onClick={()=>act(t.id,"assign")} className="px-2 py-1 rounded bg-emerald-600 text-white text-xs">Tomar</button>
              <button onClick={()=>act(t.id,"transfer")} className="px-2 py-1 rounded bg-blue-100 text-blue-700 text-xs">Transferir</button>
              <button onClick={()=>act(t.id,"resolve")} className="px-2 py-1 rounded bg-neutral-200 text-neutral-800 text-xs">Resolver</button>
            </div>
          </div>
        ))}
        {tickets.length===0 && (<div className="text-sm text-neutral-500">No hay tickets por ahora.</div>)}
      </div>
    </div>
  );
}
