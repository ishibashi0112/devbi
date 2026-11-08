import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = { title: "社内ポータル（Next.js）" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <header>
          <strong>社内ポータル</strong>
          <nav>
            <Link href="/">売上（DB から）</Link>
            <Link href="/daily">日次集計（毎朝）</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
