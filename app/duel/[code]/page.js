import HomePage from "@/app/page";

export const metadata = {
  title: "FootMon — Duel invite",
  description: "You've been invited to a 1v1 staked draft duel on Monad Testnet.",
};

/**
 * Invite links land here: /duel/<ROOMCODE>#pw=<password>
 *
 * The same app is rendered; the client reads the room code from the path and the
 * password from the URL fragment. The fragment is never sent to the server, so a
 * room password cannot end up in server logs or an access log.
 */
export default function DuelInvitePage() {
  return <HomePage />;
}
