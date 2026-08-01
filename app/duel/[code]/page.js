import { redirect } from "next/navigation";

export const metadata = {
  title: "FootMon — Duel invite",
  description: "You've been invited to a 1v1 staked draft duel on Monad Testnet.",
};

/**
 * Invite links land here: /duel/<ROOMCODE>#pw=<password>
 * Redirects to the duel page which handles the invite link parsing client-side.
 * The fragment (#pw=...) is preserved by the browser during redirect.
 */
export default async function DuelInvitePage({ params }) {
  const { code } = await params;
  redirect(`/play/duel?join=${code}`);
}
