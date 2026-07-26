import type { Metadata, Viewport } from "next";
import { Archivo } from "next/font/google";
import "./globals.css";

const archivo = Archivo({
  variable: "--font-archivo",
  weight: ["400", "600", "800"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("http://localhost:3000"),
  title: {
    default: "Relay — Encrypted video sharing, direct from your device",
    template: "%s · Relay",
  },
  description:
    "Share a video without uploading it. Relay streams it peer to peer from your device with an encrypted control channel and no stored history.",
  applicationName: "Relay",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icon-192.png", sizes: "192x192" }],
  },
  openGraph: {
    title: "Relay — Share a video without uploading it.",
    description:
      "Peer-streamed, end-to-end encrypted, nothing stored.",
    type: "website",
    images: ["/og-player.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Relay — Encrypted video sharing, direct from your device",
    description:
      "Peer-to-peer video rooms with an encrypted control channel. No accounts. No uploads. No history.",
    images: ["/og-player.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#0d0d0f",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={archivo.variable}>
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html:
              '"serviceWorker" in navigator && addEventListener("load",()=>navigator.serviceWorker.register("/sw.js"));',
          }}
        />
      </body>
    </html>
  );
}
