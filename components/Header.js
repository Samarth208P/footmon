"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAppKitAccount } from "@reown/appkit/react";
import { useState, useEffect, useMemo } from "react";
import GooeyNav from "./GooeyNav";

const NAV_ITEMS = [
  { label: "Play Solo", href: "/play" },
  { label: "1v1 Duel", href: "/play/duel" },
  { label: "Marketplace", href: "/marketplace" },
];

export default function Header() {
  const router = useRouter();
  const pathname = usePathname() || "";
  const { address, isConnected } = useAppKitAccount();
  const [username, setUsername] = useState(null);

  // Match the current URL to a nav item. Anything under /play/duel is the
  // Duel tab; anything else under /play is Solo. On routes outside /play
  // (e.g. the landing page) neither tab is highlighted — passing -1 keeps
  // GooeyNav's active pill hidden entirely.
  const activeIndex = useMemo(() => {
    if (pathname.startsWith("/marketplace")) return 2;
    if (pathname.startsWith("/play/duel")) return 1;
    if (pathname.startsWith("/play")) return 0;
    return -1;
  }, [pathname]);

  useEffect(() => {
    async function fetchProfile() {
      if (!isConnected || !address) {
        setUsername(null);
        return;
      }

      try {
        const res = await fetch(`/api/profile/${address}`);
        if (res.ok) {
          const data = await res.json();
          setUsername(data.profile?.username || null);
        }
      } catch (err) {
        console.error("Failed to fetch profile:", err);
      }
    }

    fetchProfile();
  }, [address, isConnected]);

  return (
    <header className="site-header">
      <div className="header-inner">
        <Link href="/" className="header-logo">
          <img src="/footmon.svg" alt="FootMon" width={28} height={28} />
          <span className="header-logo-text">FootMon</span>
        </Link>

        <div className="header-nav-wrap" aria-label="Primary">
          <GooeyNav
            items={NAV_ITEMS}
            initialActiveIndex={activeIndex}
            onNavigate={(href) => router.push(href)}
            particleCount={12}
            particleDistances={[80, 8]}
            particleR={100}
            animationTime={600}
            timeVariance={280}
            colors={[1, 2, 3, 1, 2, 3, 1, 4]}
          />
        </div>

        <div className="header-right">
          {isConnected && username && (
            <span className="header-username">{username}</span>
          )}
          <appkit-button size="sm" balance="hide" />
        </div>
      </div>
    </header>
  );
}
