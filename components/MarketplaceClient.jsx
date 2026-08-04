"use client";

import { useState } from "react";
import { useAppKitAccount } from "@reown/appkit/react";
import { useContract } from "@/hooks/useContract";
import { useRerollCredits, REROLL_BUNDLES } from "@/hooks/useRerollCredits";
import WalletGate from "@/components/WalletGate";
import Toast from "@/components/Toast";
import Link from "next/link";

export default function MarketplaceClient() {
  const { isConnected } = useAppKitAccount();
  const contract = useContract();
  const [toasts, setToasts] = useState([]);

  const showToast = (msg, type = "info") => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  };

  const { credits, buying, buyBundle, refetch } = useRerollCredits(contract, showToast);
  const [buyingId, setBuyingId] = useState(null);

  const handleBuy = async (bundleId) => {
    setBuyingId(bundleId);
    try {
      await buyBundle(bundleId);
    } catch {
      // Error handles in hook with showToast
    } finally {
      setBuyingId(null);
    }
  };

  return (
    <main className="marketplace-shell" style={{ minHeight: "calc(100vh - 80px)", padding: "2rem 1rem", maxWidth: "1200px", margin: "0 auto" }}>
      <Toast toasts={toasts} setToasts={setToasts} />

      {/* Header section */}
      <div className="marketplace-header" style={{ textAlign: "center", marginBottom: "2.5rem" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", padding: "0.4rem 1rem", background: "rgba(240, 192, 64, 0.12)", border: "1px solid rgba(240, 192, 64, 0.3)", borderRadius: "999px", color: "#f0c040", fontWeight: "600", fontSize: "0.9rem", marginBottom: "1rem" }}>
          ⚡ Fast Rerolls • Zero Wallet Signature Popups
        </div>
        <h1 style={{ fontSize: "2.5rem", fontWeight: "800", background: "linear-gradient(135deg, #ffffff 0%, #a5b4fc 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", margin: "0.5rem 0" }}>
          Reroll Credit Marketplace
        </h1>
        <p style={{ color: "#94a3b8", maxWidth: "600px", margin: "0 auto", fontSize: "1rem", lineHeight: "1.5" }}>
          Pre-purchase reroll bundles to skip repeated wallet signature prompts. Reroll instantly in both Solo Mode and 1v1 Staked Duels!
        </p>

        {/* Live balance indicator */}
        <div style={{ marginTop: "1.5rem", display: "inline-flex", alignItems: "center", gap: "1rem", padding: "0.8rem 1.5rem", background: "rgba(15, 23, 42, 0.75)", backdropFilter: "blur(12px)", border: "1px solid rgba(255, 255, 255, 0.1)", borderRadius: "16px", boxShadow: "0 8px 24px rgba(0,0,0,0.3)" }}>
          <div style={{ textAlign: "left" }}>
            <span style={{ fontSize: "0.8rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: "700" }}>Your Credit Balance</span>
            <div style={{ fontSize: "1.5rem", fontWeight: "800", color: "#4cdf6f", display: "flex", alignItems: "center", gap: "0.4rem" }}>
              ⚡ {credits} <span style={{ fontSize: "0.9rem", color: "#94a3b8", fontWeight: "500" }}>Credits</span>
            </div>
          </div>
          <button 
            onClick={refetch}
            style={{ background: "none", border: "1px solid rgba(255,255,255,0.15)", color: "#cbd5e1", borderRadius: "8px", padding: "0.4rem 0.8rem", cursor: "pointer", fontSize: "0.85rem", transition: "all 0.2s" }}
          >
            Refresh ↺
          </button>
        </div>
      </div>

      {/* Wallet Gate */}
      <WalletGate isConnected={isConnected}>
        {/* Bundles Grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "1.5rem" }}>
          {REROLL_BUNDLES.map((bundle) => {
            const isPopular = bundle.id === "value";
            const isBestValue = bundle.id === "elite";
            const perRoll = (parseFloat(bundle.priceMon) / bundle.rerolls).toFixed(4);

            return (
              <div
                key={bundle.id}
                style={{
                  position: "relative",
                  background: isBestValue 
                    ? "linear-gradient(145deg, rgba(30, 27, 75, 0.8), rgba(15, 23, 42, 0.9))" 
                    : "rgba(15, 23, 42, 0.6)",
                  backdropFilter: "blur(12px)",
                  border: isBestValue
                    ? "2px solid #818cf8"
                    : isPopular
                    ? "1px solid #f0c040"
                    : "1px solid rgba(255, 255, 255, 0.08)",
                  borderRadius: "20px",
                  padding: "1.75rem",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  boxShadow: isBestValue ? "0 12px 32px rgba(99, 102, 241, 0.25)" : "0 8px 24px rgba(0,0,0,0.2)",
                  transition: "transform 0.2s ease, box-shadow 0.2s ease",
                }}
              >
                {/* Badge */}
                {(bundle.discount > 0 || isBestValue || isPopular) && (
                  <div style={{ position: "absolute", top: "-12px", right: "20px", background: isBestValue ? "linear-gradient(135deg, #6366f1, #a855f7)" : isPopular ? "#f0c040" : "#22c55e", color: isPopular ? "#000" : "#fff", fontSize: "0.75rem", fontWeight: "800", padding: "0.25rem 0.75rem", borderRadius: "999px", textTransform: "uppercase", letterSpacing: "0.05em", boxShadow: "0 4px 12px rgba(0,0,0,0.3)" }}>
                    {isBestValue ? "Best Value" : isPopular ? "Popular" : `Save ${bundle.discount}%`}
                  </div>
                )}

                <div>
                  <h3 style={{ fontSize: "1.25rem", fontWeight: "700", color: "#f8fafc", margin: "0 0 0.5rem 0" }}>
                    {bundle.label}
                  </h3>
                  <div style={{ fontSize: "2.2rem", fontWeight: "800", color: "#ffffff", margin: "0.5rem 0" }}>
                    ⚡ {bundle.rerolls} <span style={{ fontSize: "1rem", color: "#94a3b8", fontWeight: "500" }}>Rerolls</span>
                  </div>

                  <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", margin: "1rem 0" }}>
                    <span style={{ fontSize: "1.75rem", fontWeight: "800", color: "#f0c040" }}>
                      {bundle.priceMon} MON
                    </span>
                    {bundle.discount > 0 && (
                      <span style={{ fontSize: "0.85rem", color: "#64748b", textDecoration: "line-through" }}>
                        {(bundle.rerolls * 0.01).toFixed(2)} MON
                      </span>
                    )}
                  </div>

                  <p style={{ fontSize: "0.85rem", color: "#94a3b8", margin: "0 0 1.5rem 0" }}>
                    ~{perRoll} MON per roll • <span style={{ color: "#4cdf6f" }}>0.005 MON to Daily Prize Pot</span>
                  </p>
                </div>

                <button
                  onClick={() => handleBuy(bundle.id)}
                  disabled={buying}
                  style={{
                    width: "100%",
                    padding: "0.85rem 1rem",
                    borderRadius: "12px",
                    border: "none",
                    background: isBestValue
                      ? "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)"
                      : "linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)",
                    color: "#ffffff",
                    fontWeight: "700",
                    fontSize: "1rem",
                    cursor: buying ? "not-allowed" : "pointer",
                    opacity: buying ? 0.6 : 1,
                    transition: "all 0.2s ease",
                    boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
                  }}
                >
                  {buyingId === bundle.id ? "Processing..." : `Buy ${bundle.rerolls} Credits`}
                </button>
              </div>
            );
          })}
        </div>
      </WalletGate>

      {/* Info Footer */}
      <div style={{ marginTop: "3rem", padding: "1.5rem", background: "rgba(15, 23, 42, 0.4)", border: "1px solid rgba(255, 255, 255, 0.05)", borderRadius: "16px", display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: "1rem" }}>
        <div>
          <h4 style={{ color: "#f8fafc", margin: "0 0 0.25rem 0", fontSize: "1rem" }}>Ready to draft?</h4>
          <p style={{ color: "#94a3b8", margin: "0", fontSize: "0.875rem" }}>Use your credits right now in solo tournament runs or 1v1 duels.</p>
        </div>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <Link href="/play" style={{ padding: "0.6rem 1.2rem", background: "rgba(255, 255, 255, 0.08)", color: "#fff", borderRadius: "10px", textDecoration: "none", fontWeight: "600", fontSize: "0.9rem" }}>
            Play Solo
          </Link>
          <Link href="/play/duel" style={{ padding: "0.6rem 1.2rem", background: "#6366f1", color: "#fff", borderRadius: "10px", textDecoration: "none", fontWeight: "600", fontSize: "0.9rem" }}>
            1v1 Duel
          </Link>
        </div>
      </div>
    </main>
  );
}
