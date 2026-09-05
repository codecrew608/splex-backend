import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Instrument_Serif } from "next/font/google";
import Script from "next/script";
import "./globals.css";

// Variable font (no fixed weight array) — the reference design uses
// in-between weights like 450 for body text, which only a variable font
// range supports.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
  weight: ["400", "500", "600"],
});
// Display face — the Prism system's third type role, reserved for
// headings, nav section labels, and empty states (globals.css'
// --font-display). Instrument Serif ships one weight (400) only, in both
// styles — italic is reserved for the landing page's own hero headline
// (a deliberate one-off flourish, applied directly there via font-style,
// not a second global token) rather than every heading in the app.
const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  variable: "--font-instrument-serif",
  display: "swap",
  weight: "400",
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "SPLEX",
  description: "Describe the outcome you want. SPLEX chooses the intelligence.",
};

// Runs before hydration so the correct theme is on <html> for the very
// first paint — without this, the page would flash the wrong theme for a
// beat while React boots and themeStore reads the (still-default) DOM state.
const THEME_INIT_SCRIPT = `
try {
  var t = localStorage.getItem('splex-theme');
  if (t !== 'light' && t !== 'dark') {
    t = 'light';
  }
  document.documentElement.setAttribute('data-theme', t);
} catch (e) {
  document.documentElement.setAttribute('data-theme', 'light');
}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} ${instrumentSerif.variable}`}
      suppressHydrationWarning
    >
      <head>
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
        <Script
          async
          src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9691000514071341"
          crossOrigin="anonymous"
          strategy="afterInteractive"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
