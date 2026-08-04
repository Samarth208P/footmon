import MarketplaceClient from "@/components/MarketplaceClient";

export const metadata = {
  title: "Reroll Marketplace — FootMon",
  description: "Buy reroll credit bundles to roll instantly with zero wallet signature popups in FootMon solo tournaments and 1v1 staked duels.",
};

export default function MarketplacePage() {
  return <MarketplaceClient />;
}
