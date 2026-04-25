import Link from "next/link";

export default function HomePage() {
  return (
    <main dir="rtl" className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-6 px-4">
      <h1 className="text-4xl font-bold text-gray-800">מערכת סידור עבודה</h1>
      <p className="text-lg text-gray-600">המערכת עובדת 🎉</p>
      <div className="flex gap-4">
        <Link
          href="/employee/dashboard"
          className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition-colors"
        >
          אזור עובד
        </Link>
        <Link
          href="/manager/dashboard"
          className="px-6 py-3 bg-gray-700 hover:bg-gray-800 text-white font-semibold rounded-lg transition-colors"
        >
          אזור מנהל
        </Link>
      </div>
    </main>
  );
}
