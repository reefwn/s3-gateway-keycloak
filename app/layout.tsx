import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "S3 Browser",
  description: "Internal S3 object browser"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
