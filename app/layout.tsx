import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider"
import { GithubProvider } from "@/lib/github-context"
import { PwaRegister } from "@/components/pwa-register"

const inter = Inter({ subsets: ["latin"] });

// Menangkap beforeinstallprompt sedini mungkin agar tidak terlewat sebelum React siap
const earlyInstallCapture = `(function(){try{window.__pwaInstallEvent=null;window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__pwaInstallEvent=e;window.dispatchEvent(new Event('pwa-install-available'));});window.addEventListener('appinstalled',function(){window.__pwaInstallEvent=null;});}catch(e){}})();`

export const metadata: Metadata = {
  applicationName: "Github-Uploader",
  title: "Github-Uploader",
  description: "Upload files to GitHub easily",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: '/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }
    ]
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Github-Uploader",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FAF6EE" },
    { media: "(prefers-color-scheme: dark)", color: "#17110C" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <Script
          id="pwa-early-install-capture"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: earlyInstallCapture }}
        />
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} forcedTheme="light">
          <GithubProvider>
            <PwaRegister />
            {children}
          </GithubProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
