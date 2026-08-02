import "./globals.css";
import Header from "@/components/Header";
import Web3ModalProvider from "@/context/Web3Modal";

const SITE_URL = "https://footmon.app";

export const metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "FootMon — World Cup Squad Builder on Monad",
    template: "%s | FootMon",
  },
  description:
    "Build your dream World Cup squad, compete on-chain, and win MON prizes every day on Monad Testnet.",
  keywords: [
    "FootMon",
    "World Cup",
    "squad builder",
    "Monad",
    "MON",
    "blockchain game",
    "on-chain",
    "duel",
    "fantasy football",
    "crypto gaming",
  ],
  authors: [{ name: "FootMon" }],
  creator: "FootMon",
  openGraph: {
    type: "website",
    siteName: "FootMon",
    title: "FootMon — Draft the Greatest XI. Win MON.",
    description:
      "Roll for legendary World Cup squads, draft your dream 11, and win MON in daily tournaments and 1v1 staked duels on Monad.",
    url: SITE_URL,
    images: [
      {
        url: "/footmon.png",
        width: 1200,
        height: 630,
        alt: "FootMon — World Cup Squad Builder on Monad",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "FootMon — Draft the Greatest XI. Win MON.",
    description:
      "Roll for legendary World Cup squads, draft your dream 11, and win MON in daily tournaments and 1v1 staked duels on Monad.",
    images: ["/footmon.png"],
  },
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-icon.png",
  },
  alternates: {
    canonical: SITE_URL,
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head suppressHydrationWarning>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;700;900&display=swap"
          rel="stylesheet"
        />
      </head>
      <body suppressHydrationWarning>
        <Web3ModalProvider>
          <Header />
          {children}
        </Web3ModalProvider>
      </body>
    </html>
  );
}
