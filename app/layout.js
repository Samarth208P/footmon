import "./globals.css";
import Header from "@/components/Header";
import Web3ModalProvider from "@/context/Web3Modal";

export const metadata = {
  title: "FootMon — World Cup Squad Builder on Monad",
  description:
    "Build your dream World Cup squad, compete on-chain, and win MON prizes every day on Monad Testnet.",
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
