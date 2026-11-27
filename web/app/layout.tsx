import type { Metadata, Viewport } from "next";
import { Geist_Mono, Raleway } from "next/font/google";
import "./globals.css";

// STYLES.md §5: Raleway 400/500/700 as the sans family.
const raleway = Raleway({
  variable: "--font-raleway",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

// Monospace for addresses and hashes.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "FairHold: AI-mediated stablecoin escrow",
  description: "Lock tUSD8 on QDay Aevum. Disputes are resolved by agreement, a bounded AI mediator, or deterministic deadlines.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#111827" },
  ],
};

// Applies the saved theme (default "system") before first paint, so there is no flash.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("fairhold:theme")||"system";var d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${raleway.variable} ${geistMono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body suppressHydrationWarning className="flex min-h-full flex-col bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
