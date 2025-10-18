export const metadata = {
  title: "i-R Dental • Consola y Bot",
  description: "Panel del operador y endpoints del bot de WhatsApp",
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body className="antialiased">{children}</body>
    </html>
  );
}
