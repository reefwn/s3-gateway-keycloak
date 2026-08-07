import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "S3 Browser — Internal Storage",
  description: "Internal S3 object browser"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background antialiased">{children}</body>
    </html>
  );
}
