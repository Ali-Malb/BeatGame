import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter, Saira } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "600", "800", "900"],
});

/** display face: strong racing/technical italic feel for titles & judgments */
const saira = Saira({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["600", "800", "900"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "Midnight Runner — Shuto Expressway Liter Bike Sim",
  description: "High-speed lane-splitting motorcycle simulation on an elevated Tokyo expressway: dense AI traffic, dynamic weather, cockpit telemetry.",
  keywords: ["motorcycle", "racing", "Shutoko", "traffic", "simulator", "Three.js"],
  authors: [{ name: "Midnight Runner" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Midnight Runner",
    description: "High-speed lane-splitting motorcycle simulation",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${inter.variable} ${saira.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
