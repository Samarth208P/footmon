"use client";

/**
 * Wallet gate — blocks game content until wallet is connected.
 * Uses AppKit's built-in button to trigger connection.
 */
export default function WalletGate({ isConnected, children }) {
  if (isConnected) return <>{children}</>;

  return (
    <div className="wallet-gate" style={{ display: "flex" }}>
      <div className="wallet-gate-content">
        <img src="/footmon.svg" alt="FootMon" width={48} height={48} />
        <h2 className="wallet-gate-title">Connect Wallet to Play</h2>
        <p className="wallet-gate-sub">You need a wallet connected to Monad Testnet to play FootMon.</p>
        <appkit-button size="md" />
      </div>
    </div>
  );
}
