import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sundark · Research Library",
  description: "나만의 논문 서재. 읽고, 메모하고, 다시 발견하세요.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
