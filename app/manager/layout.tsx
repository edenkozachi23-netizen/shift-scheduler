// Layout for the manager area.
// Auth protection will be added in Phase 3.

export default function ManagerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-gray-900 text-white px-4 py-3 flex items-center justify-between">
        <span className="text-sm text-gray-400">מנהל</span>
        <h1 className="text-lg font-semibold">סידור משמרות — ניהול</h1>
      </header>
      <main className="p-4">{children}</main>
    </div>
  );
}
