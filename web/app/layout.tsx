import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PR Agent | AI Code Review Service",
  description:
    "PR Agent official website showcasing AI-powered code review workflows for GitHub and GitLab.",
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
