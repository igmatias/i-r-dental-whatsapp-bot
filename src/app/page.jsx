import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-lg w-full border rounded-2xl p-6">
        <h1 className="text-2xl font-bold">i-R Dental • Bot de WhatsApp</h1>
        <p className="text-neutral-600 mt-2">Proyecto desplegado correctamente. Usá el panel del operador para gestionar tickets.</p>
        <div className="mt-4">
          <Link href="/operator" className="inline-block px-4 py-2 rounded-lg bg-emerald-600 text-white">Abrir consola del operador</Link>
        </div>
      </div>
    </main>
  );
}
