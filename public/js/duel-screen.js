// js/duel-screen.js — pure mapping from persisted duel state to a UI screen.
//
// A refresh mid-duel must land the player back where they were. That decision is
// derived from durable state (duel_rooms.status + match_logs) rather than from
// anything held in memory, so it survives a reload, a crash, or a device swap.
//
// Pure: no DOM, no network. Unit tested in tests/duel-screen.test.js.

const DuelScreen = (() => {
  const SCREENS = {
    LOBBY: "lobby",
    WAITING: "waiting",     // created, nobody has joined yet
    READY_CHECK: "ready",   // both staked, waiting on ready-up
    DRAFT: "draft",
    KICKOFF: "kickoff",     // line-ups converging, match about to start
    MATCH: "match",         // minute ticks streaming
    RESULT: "result",
  };

  function lastEventType(matchLogs) {
    if (!Array.isArray(matchLogs) || matchLogs.length === 0) return null;
    let best = matchLogs[0];
    for (const log of matchLogs) {
      if ((log?.seq ?? -1) >= (best?.seq ?? -1)) best = log;
    }
    return best?.event_type ?? best?.eventType ?? null;
  }

  function matchFinished(matchLogs) {
    const type = lastEventType(matchLogs);
    return type === "full_time" || type === "forfeit";
  }

  /**
   * @param {object|null} room
   * @param {object[]} matchLogs
   * @returns {{screen: string, reason: string}}
   */
  function screenForRoom(room, matchLogs = []) {
    if (!room) return { screen: SCREENS.LOBBY, reason: "no active room" };

    switch (room.status) {
      case "cancelled":
      case "expired":
        // Stake is refunded/refundable on-chain; nothing left to play.
        return { screen: SCREENS.LOBBY, reason: `room ${room.status}` };

      case "open":
        return room.joiner
          ? { screen: SCREENS.READY_CHECK, reason: "opponent present" }
          : { screen: SCREENS.WAITING, reason: "waiting for opponent" };

      case "full":
      case "ready":
        return { screen: SCREENS.READY_CHECK, reason: "ready check" };

      case "drafting":
        return { screen: SCREENS.DRAFT, reason: "draft in progress" };

      case "simulating":
        // No ticks yet means the match has not started streaming: show kickoff.
        if (!matchLogs || matchLogs.length === 0) {
          return { screen: SCREENS.KICKOFF, reason: "awaiting kickoff" };
        }
        return matchFinished(matchLogs)
          ? { screen: SCREENS.RESULT, reason: "match finished, settlement pending" }
          : { screen: SCREENS.MATCH, reason: "match in progress" };

      case "complete":
        return { screen: SCREENS.RESULT, reason: "duel complete" };

      default:
        return { screen: SCREENS.LOBBY, reason: `unknown status '${room.status}'` };
    }
  }

  /** Whose turn label to show, from the viewer's perspective. */
  function turnLabel(room, myAddress) {
    if (!room?.current_turn) return null;
    const mine = String(myAddress ?? "").toLowerCase() === String(room.current_turn).toLowerCase();
    return mine ? "YOUR TURN" : "OPPONENT'S TURN";
  }

  function isMyTurn(room, myAddress) {
    if (!room?.current_turn || !myAddress) return false;
    return String(room.current_turn).toLowerCase() === String(myAddress).toLowerCase();
  }

  /** 'creator' | 'joiner' | null — which side the viewer is. */
  function sideOf(room, myAddress) {
    if (!room || !myAddress) return null;
    const me = String(myAddress).toLowerCase();
    if (String(room.creator).toLowerCase() === me) return "creator";
    if (room.joiner && String(room.joiner).toLowerCase() === me) return "joiner";
    return null;
  }

  /**
   * Result from the viewer's perspective. Returns null while undecided so the UI
   * cannot accidentally announce a winner mid-match.
   */
  function outcomeFor(room, myAddress) {
    if (!room) return null;
    if (!["complete", "simulating"].includes(room.status)) return null;

    const side = sideOf(room, myAddress);
    if (!side) return null;

    const myScore = side === "creator" ? room.score_creator : room.score_joiner;
    const theirScore = side === "creator" ? room.score_joiner : room.score_creator;

    if (room.is_draw) return { result: "draw", myScore, theirScore, canClaim: false };
    if (!room.winner) return null;

    const iWon = String(room.winner).toLowerCase() === String(myAddress).toLowerCase();
    return {
      result: iWon ? "win" : "loss",
      myScore,
      theirScore,
      // Only a settled duel has anything to pull from escrow.
      canClaim: iWon && room.status === "complete",
    };
  }

  return {
    SCREENS,
    screenForRoom,
    matchFinished,
    lastEventType,
    turnLabel,
    isMyTurn,
    sideOf,
    outcomeFor,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = DuelScreen;
}
