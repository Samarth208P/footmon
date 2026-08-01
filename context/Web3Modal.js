"use client";

import { createAppKit } from "@reown/appkit/react";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { defineChain } from "@reown/appkit/networks";
import { useEffect } from "react";
import {
  useAppKitAccount,
  useAppKitProvider,
} from "@reown/appkit/react";
import { BrowserProvider } from "ethers";

// ── Monad Testnet chain definition ──────────────────────────────────────────
const monadTestnet = defineChain({
  id: 10143,
  caipNetworkId: "eip155:10143",
  chainNamespace: "eip155",
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://testnet-rpc.monad.xyz"] },
  },
  blockExplorers: {
    default: { name: "Monad Explorer", url: "https://explorer.testnet.monad.xyz" },
  },
});

// ── AppKit metadata ─────────────────────────────────────────────────────────
const metadata = {
  name: "FootMon",
  description: "Build your dream World Cup squad on Monad",
  url: typeof window !== "undefined" ? window.location.origin : "https://footmon.xyz",
  icons: ["/footmon.svg"],
};

// ── Project ID ──────────────────────────────────────────────────────────────
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "d291972ffedba34bacef9b4bf4169d34";

// ── Create AppKit instance (singleton) ──────────────────────────────────────
const ethersAdapter = new EthersAdapter();

createAppKit({
  adapters: [ethersAdapter],
  networks: [monadTestnet],
  defaultNetwork: monadTestnet,
  projectId,
  metadata,
  features: {
    analytics: false,
    email: false,
    socials: false,
    swaps: false,
    onramp: false,
  },
  allowUnsupportedChain: false,
  themeMode: "dark",
  themeVariables: {
    "--w3m-accent": "#7c5cff",
    "--w3m-border-radius-master": "2px",
  },
});

// ── Bridge component: syncs React wallet state → vanilla JS WalletManager ───
function WalletBridge() {
  const { address, isConnected } = useAppKitAccount();
  const { walletProvider } = useAppKitProvider("eip155");

  useEffect(() => {
    async function sync() {
      if (isConnected && address && walletProvider) {
        try {
          const provider = new BrowserProvider(walletProvider);
          const signer = await provider.getSigner();

          // Update the global WalletManager that vanilla JS relies on
          if (typeof window !== "undefined") {
            window.__APPKIT_PROVIDER__ = provider;
            window.__APPKIT_SIGNER__ = signer;
            window.__APPKIT_ADDRESS__ = address;
            window.__APPKIT_CONNECTED__ = true;
          }

          // Fire the same event the vanilla JS listens for
          document.dispatchEvent(
            new CustomEvent("wallet:connected", { detail: address })
          );
        } catch (err) {
          console.error("[Web3Modal] Failed to create ethers provider:", err);
        }
      } else {
        if (typeof window !== "undefined") {
          window.__APPKIT_PROVIDER__ = null;
          window.__APPKIT_SIGNER__ = null;
          window.__APPKIT_ADDRESS__ = null;
          window.__APPKIT_CONNECTED__ = false;
        }

        document.dispatchEvent(new CustomEvent("wallet:disconnected"));
      }
    }

    sync();
  }, [address, isConnected, walletProvider]);

  return null;
}

// ── Provider wrapper ────────────────────────────────────────────────────────
export default function Web3ModalProvider({ children }) {
  return (
    <>
      <WalletBridge />
      {children}
    </>
  );
}
