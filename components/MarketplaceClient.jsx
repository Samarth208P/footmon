"use client";

import { useState } from "react";
import { useAppKitAccount } from "@reown/appkit/react";
import { useContract } from "@/hooks/useContract";
import { useRerollCredits, REROLL_BUNDLES } from "@/hooks/useRerollCredits";
import WalletGate from "@/components/WalletGate";
import Toast from "@/components/Toast";
import Link from "next/link";

import RerollIcon from "@/components/RerollIcon";

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
  const [isRefetching, setIsRefetching] = useState(false);

  const handleBuy = async (bundleId) => {
    setBuyingId(bundleId);
    try {
      await buyBundle(bundleId);
    } catch {
      // Error handled in hook with showToast
    } finally {
      setBuyingId(null);
    }
  };

  const handleRefresh = async () => {
    setIsRefetching(true);
    await refetch();
    setTimeout(() => setIsRefetching(false), 500);
  };

  return (
    <main style={{ minHeight: "calc(100vh - 80px)", padding: "1.5rem 1rem 3rem 1rem", maxWidth: "960px", margin: "0 auto" }}>
      <Toast toasts={toasts} setToasts={setToasts} />

      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: "2rem" }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.4rem",
            padding: "0.28rem 0.8rem",
            background: "rgba(109, 92, 255, 0.1)",
            border: "1px solid rgba(109, 92, 255, 0.25)",
            borderRadius: "999px",
            color: "#a78bfa",
            fontWeight: "600",
            fontSize: "0.8rem",
            marginBottom: "0.75rem",
            letterSpacing: "0.02em",
          }}
        >
          <RerollIcon size={14} color="#a78bfa" /> Fast Rerolls • Zero Signature Popups
        </div>

        <h1
          style={{
            fontSize: "2.1rem",
            fontWeight: "700",
            color: "#ffffff",
            margin: "0.15rem 0 0.5rem 0",
            letterSpacing: "-0.02em",
            fontFamily: "'Space Grotesk', sans-serif",
          }}
        >
          Reroll Marketplace
        </h1>

        <p style={{ color: "#94a3b8", maxWidth: "520px", margin: "0 auto 1.25rem auto", fontSize: "0.88rem", lineHeight: "1.5" }}>
          Pre-purchase reroll credit bundles for instant card rerolls in Solo Tournaments and 1v1 Staked Duels.
        </p>

        {/* Live balance indicator */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.6rem",
            padding: "0.4rem 1rem",
            background: "rgba(19, 21, 28, 0.85)",
            border: "1px solid rgba(255, 255, 255, 0.1)",
            borderRadius: "999px",
            boxShadow: "0 4px 16px rgba(0, 0, 0, 0.25)",
          }}
        >
          <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>
            Balance:
          </span>
          <span style={{ fontSize: "1rem", fontWeight: "700", color: "#ffffff", display: "flex", alignItems: "center", gap: "0.35rem" }}>
            <RerollIcon size={16} color="#8b7aff" /> {credits} <span style={{ fontSize: "0.8rem", color: "#64748b", fontWeight: "500" }}>Credits</span>
          </span>
          <button
            onClick={handleRefresh}
            title="Refresh Balance"
            style={{
              background: "none",
              border: "none",
              color: "#64748b",
              cursor: "pointer",
              fontSize: "0.85rem",
              padding: "0.15rem",
              display: "flex",
              alignItems: "center",
              transform: isRefetching ? "rotate(180deg)" : "none",
              transition: "transform 0.4s ease, color 0.2s ease",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#ffffff")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#64748b")}
          >
            ↺
          </button>
        </div>
      </div>

      {/* Wallet Gate & Cards */}
      <WalletGate isConnected={isConnected}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: "1rem",
          }}
        >
          {REROLL_BUNDLES.map((bundle) => {
            const isPopular = bundle.id === "value";
            const isElite = bundle.id === "elite";
            const isFeatured = isPopular || isElite;
            const perRoll = (parseFloat(bundle.priceMon) / bundle.rerolls).toFixed(4);

            return (
              <div
                key={bundle.id}
                style={{
                  background: "rgba(19, 21, 28, 0.75)",
                  backdropFilter: "blur(12px)",
                  border: isFeatured
                    ? "1px solid rgba(129, 140, 248, 0.4)"
                    : "1px solid rgba(255, 255, 255, 0.09)",
                  borderRadius: "14px",
                  padding: "1.15rem 1.25rem",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  transition: "transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease",
                  position: "relative",
                  boxShadow: isFeatured ? "0 6px 20px rgba(99, 102, 241, 0.15)" : "0 4px 14px rgba(0, 0, 0, 0.2)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = "translateY(-2px)";
                  e.currentTarget.style.borderColor = isFeatured
                    ? "rgba(129, 140, 248, 0.65)"
                    : "rgba(109, 92, 255, 0.4)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "none";
                  e.currentTarget.style.borderColor = isFeatured
                    ? "rgba(129, 140, 248, 0.4)"
                    : "rgba(255, 255, 255, 0.09)";
                }}
              >
                <div>
                  {/* Card Header row */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem" }}>
                    <h3 style={{ fontSize: "1rem", fontWeight: "700", color: "#ffffff", margin: 0, fontFamily: "'Space Grotesk', sans-serif" }}>
                      {bundle.label}
                    </h3>

                    {/* Clean Badge */}
                    {isPopular && (
                      <span style={{ fontSize: "0.7rem", fontWeight: "600", color: "#fbbf24", background: "rgba(245, 158, 11, 0.15)", border: "1px solid rgba(245, 158, 11, 0.3)", padding: "0.15rem 0.5rem", borderRadius: "999px" }}>
                        Popular
                      </span>
                    )}
                    {isElite && (
                      <span style={{ fontSize: "0.7rem", fontWeight: "600", color: "#a5b4fc", background: "rgba(99, 102, 241, 0.18)", border: "1px solid rgba(99, 102, 241, 0.35)", padding: "0.15rem 0.5rem", borderRadius: "999px" }}>
                        Best Value
                      </span>
                    )}
                    {!isPopular && !isElite && bundle.discount > 0 && (
                      <span style={{ fontSize: "0.7rem", fontWeight: "600", color: "#34d399", background: "rgba(52, 211, 153, 0.12)", border: "1px solid rgba(52, 211, 153, 0.25)", padding: "0.15rem 0.5rem", borderRadius: "999px" }}>
                        Save {bundle.discount}%
                      </span>
                    )}
                  </div>

                  {/* Quantity */}
                  <div style={{ margin: "0.4rem 0" }}>
                    <div style={{ fontSize: "1.6rem", fontWeight: "800", color: "#ffffff", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                      <RerollIcon size={20} color="#8b7aff" /> {bundle.rerolls}
                      <span style={{ fontSize: "0.85rem", color: "#94a3b8", fontWeight: "500" }}>Rerolls</span>
                    </div>
                  </div>

                  {/* Pricing */}
                  <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", marginTop: "0.5rem" }}>
                    <span style={{ fontSize: "1.3rem", fontWeight: "700", color: "#ffffff" }}>
                      {bundle.priceMon} MON
                    </span>
                    {bundle.discount > 0 && (
                      <span style={{ fontSize: "0.8rem", color: "#64748b", textDecoration: "line-through" }}>
                        {(bundle.rerolls * 0.01).toFixed(2)} MON
                      </span>
                    )}
                  </div>

                  {/* Subtext info */}
                  <div style={{ marginTop: "0.35rem", marginBottom: "1rem", fontSize: "0.78rem", color: "#64748b" }}>
                    <span>~{perRoll} MON per roll</span>
                  </div>
                </div>

                {/* Purchase Button - Uniform Solid Active Styling */}
                <button
                  onClick={() => handleBuy(bundle.id)}
                  disabled={buying}
                  style={{
                    width: "100%",
                    padding: "0.6rem 0.85rem",
                    borderRadius: "8px",
                    border: "none",
                    background: "linear-gradient(135deg, #6d5cff 0%, #4f46e5 100%)",
                    color: "#ffffff",
                    fontWeight: "600",
                    fontSize: "0.88rem",
                    cursor: buying ? "not-allowed" : "pointer",
                    opacity: buying ? 0.6 : 1,
                    transition: "all 0.2s ease",
                    boxShadow: "0 3px 10px rgba(109, 92, 255, 0.25)",
                  }}
                  onMouseEnter={(e) => {
                    if (buying) return;
                    e.currentTarget.style.opacity = "0.9";
                    e.currentTarget.style.transform = "scale(1.01)";
                  }}
                  onMouseLeave={(e) => {
                    if (buying) return;
                    e.currentTarget.style.opacity = "1";
                    e.currentTarget.style.transform = "scale(1)";
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
      <div
        style={{
          marginTop: "2rem",
          padding: "1rem 1.25rem",
          background: "rgba(19, 21, 28, 0.6)",
          border: "1px solid rgba(255, 255, 255, 0.07)",
          borderRadius: "12px",
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "0.75rem",
        }}
      >
        <div>
          <h4 style={{ color: "#f8fafc", margin: "0 0 0.15rem 0", fontSize: "0.9rem", fontWeight: "600" }}>Ready to draft?</h4>
          <p style={{ color: "#64748b", margin: 0, fontSize: "0.8rem" }}>Use your credits right now in solo tournaments or 1v1 staked duels.</p>
        </div>
        <div style={{ display: "flex", gap: "0.6rem" }}>
          <Link
            href="/play"
            style={{
              padding: "0.45rem 0.85rem",
              background: "rgba(255, 255, 255, 0.06)",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              color: "#f8fafc",
              borderRadius: "7px",
              textDecoration: "none",
              fontWeight: "600",
              fontSize: "0.8rem",
              transition: "all 0.2s ease",
            }}
          >
            Play Solo
          </Link>
          <Link
            href="/play/duel"
            style={{
              padding: "0.45rem 0.85rem",
              background: "#6d5cff",
              color: "#ffffff",
              borderRadius: "7px",
              textDecoration: "none",
              fontWeight: "600",
              fontSize: "0.8rem",
              transition: "all 0.2s ease",
              boxShadow: "0 2px 8px rgba(109, 92, 255, 0.25)",
            }}
          >
            1v1 Duel
          </Link>
        </div>
      </div>
    </main>
  );
}
