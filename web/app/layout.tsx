import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PR Agent | Coordinate Studio",
  description:
    "PR Agent official website prototype built with Next.js App Router.",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon.jpeg", type: "image/jpeg" },
    ],
    shortcut: "/icon.svg",
    apple: "/icon.jpeg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
