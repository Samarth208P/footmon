/**
 * Bug condition exploration test for the `room-password-prompt-when-none-set`
 * spec.
 *
 * Property 1 (Bug Condition): Public rooms show no password prompt.
 *
 * This test encodes the expected behavior:
 *   - When the user opens the join modal, enters a room code that resolves
 *     to a room with `is_private: false`, and clicks "Join Duel", the modal
 *     MUST NOT render a password `<input>` at any point.
 *   - `joinRoom` must be invoked with `(code, null)` or `(code, undefined)` —
 *     never with a user-entered password.
 *   - A room that cannot be resolved MUST surface a distinct "not found"
 *     style message and must NOT fall back to a password prompt.
 *
 * On UNFIXED code the join modal renders a password `<input>` unconditionally,
 * so this test is EXPECTED TO FAIL. That failure IS the confirmation of the
 * bug described in `.kiro/specs/room-password-prompt-when-none-set/bugfix.md`.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Hoisted mocks — declared BEFORE the DuelGamePage import so Vitest's module
// resolver hands the component a mocked hook surface.
// ---------------------------------------------------------------------------

vi.mock("@reown/appkit/react", () => ({
  useAppKitAccount: () => ({
    address: "0x1111111111111111111111111111111111111111",
    isConnected: true,
  }),
  useAppKitProvider: () => ({ walletProvider: null }),
}));

vi.mock("@/hooks/useContract", () => ({
  useContract: () => ({
    isAvailable: () => false,
    createDuel: vi.fn(),
    joinDuel: vi.fn(),
    payForRoll: vi.fn(),
  }),
}));

vi.mock("@/hooks/useProfile", () => ({
  useProfile: () => ({
    username: null,
    usernameFor: (addr) => (addr ? String(addr).slice(0, 8) : "player"),
    prefetch: vi.fn(),
    showClaimModal: false,
    claimUsername: vi.fn(),
    dismissModal: vi.fn(),
    claimError: null,
    claimBusy: false,
    setClaimError: vi.fn(),
  }),
}));

vi.mock("@/lib/sound", () => ({
  play: vi.fn(),
  unlockOnFirstGesture: () => () => {},
}));

// The useDuel mock is a plain spy — each test attaches a stateful
// implementation that owns the join-modal open flag via `React.useState`.
vi.mock("@/hooks/useDuel", () => ({
  useDuel: vi.fn(),
}));

// After the mocks are registered, import the SUT and the mocked module.
import DuelGamePage from "@/components/DuelGamePage";
import { useDuel } from "@/hooks/useDuel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a `useDuel` hook implementation that:
 *   - keeps the join-modal open/close flag in real React state so clicks on
 *     "Join Room" actually reveal the modal;
 *   - uses the supplied spies for `joinRoom` and `fetchRoomByCode` so the
 *     test can assert on them.
 *
 * Returns { impl, spies } — `impl` is what `useDuel.mockImplementation`
 * accepts; `spies` gives the test direct access to the spy handles.
 */
function makeDuelImpl({ fetchRoomResult, joinRoomResult } = {}) {
  const joinRoom = vi.fn(async () => joinRoomResult ?? { room: {} });
  const fetchRoomByCode = vi.fn(async () => fetchRoomResult ?? { room: {} });

  const impl = () => {
    // React state so setJoinModalOpen actually toggles the modal.
    const [joinModalOpen, setJoinModalOpen] = React.useState(false);
    const [createModalOpen, setCreateModalOpen] = React.useState(false);

    return {
      // Screen
      screen: "lobby",
      setScreen: vi.fn(),

      // Lobby
      challenges: [],
      lobbyLoading: false,
      refreshLobby: vi.fn(),

      // Room state — lobby, so all empty.
      roomCode: null,
      room: null,
      isCreator: false,
      opponent: null,
      opponentReady: false,
      myReady: false,
      sessionToken: null,

      // Formation / slots — never touched on lobby screen.
      formation: "4-3-3",
      style: "balanced",
      setFormation: vi.fn(),
      setStyle: vi.fn(),
      mySlots: [],
      opponentSlots: [],

      // Draft — never touched on lobby screen.
      nationCode: null,
      nationName: null,
      year: null,
      squad: [],
      filteredSquad: [],
      rolledThisTurn: false,
      selectedPlayer: null,
      setSelectedPlayer: vi.fn(),
      filterPos: null,
      setFilterPos: vi.fn(),
      assignedIds: new Set(),
      assignedNames: new Set(),
      opponentRoll: null,
      myPenaltyMaxRating: null,

      // Turn
      isMyTurn: false,
      turnDeadline: null,

      // UI
      busy: false,
      error: null,
      setError: vi.fn(),

      // Modals — the two flags we care about.
      createModalOpen,
      setCreateModalOpen,
      joinModalOpen,
      setJoinModalOpen,

      // Actions — spies for what the test observes.
      createRoom: vi.fn(),
      joinRoom,
      fetchRoomByCode,
      openSession: vi.fn(),
      readyUp: vi.fn(),
      roll: vi.fn(),
      pickPlayer: vi.fn(),
      rearrangeSlots: vi.fn(),
      simulateMatch: vi.fn(),
      matchResult: null,
      cancelRoom: vi.fn(),
      resetDuel: vi.fn(),

      // Stats — trivial values so DuelGamePage renders fine.
      getMyStats: () => ({ avg: "0.0", attack: 0, defense: 0, assigned: 0, total: 0 }),
      getOpponentStats: () => ({ avg: "0.0", attack: 0, defense: 0, assigned: 0, total: 0 }),
      isSquadComplete: false,
    };
  };

  return { impl, spies: { joinRoom, fetchRoomByCode } };
}

/**
 * Query the DOM for any element that would indicate a password prompt.
 * Returns true when the join modal is (visibly) prompting for a password.
 */
function hasPasswordPrompt() {
  const passwordInputs = document.querySelectorAll('input[type="password"]');
  const byPlaceholder = screen.queryByPlaceholderText(/password/i);
  return passwordInputs.length > 0 || byPlaceholder !== null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(useDuel).mockReset();
});

describe("DuelGamePage join modal — Bug Condition: public rooms show no password prompt", () => {
  // Scoped property-based sweep across concrete public-room codes.
  const publicRoomCodes = ["ABC12345", "PUB00001", "ROOM0000"];

  it.each(publicRoomCodes)(
    "renders no password input when joining public room %s",
    async (code) => {
      const { impl, spies } = makeDuelImpl({
        fetchRoomResult: { room: { room_code: code, is_private: false } },
        joinRoomResult: { room: { room_code: code, is_private: false } },
      });
      vi.mocked(useDuel).mockImplementation(impl);

      render(<DuelGamePage />);

      // Sanity — nothing password-y before the modal is open.
      expect(hasPasswordPrompt()).toBe(false);

      const user = userEvent.setup();

      // 1) Open the join modal.
      const openJoinBtn = await screen.findByRole("button", {
        name: /^join room$/i,
      });
      await user.click(openJoinBtn);

      // Modal now open. Password MUST NOT be rendered at this stage — the
      // room's `is_private` flag is not yet known / is `false`.
      expect(hasPasswordPrompt()).toBe(false);

      // 2) Type the room code.
      const codeInput = await screen.findByPlaceholderText(/room code/i);
      await user.clear(codeInput);
      await user.type(codeInput, code);

      // Still no password input — the user hasn't clicked Join yet, and
      // even after clicking it the target room is public.
      expect(hasPasswordPrompt()).toBe(false);

      // 3) Click "Join Duel".
      const joinBtn = screen.getByRole("button", { name: /^join duel$/i });
      await user.click(joinBtn);

      // Give the async handler a tick.
      await waitFor(() => {
        expect(spies.joinRoom).toHaveBeenCalled();
      });

      // 4) Final assertion — the whole flow must never have surfaced a
      // password prompt anywhere.
      expect(hasPasswordPrompt()).toBe(false);

      // 5) joinRoom must have been called with the code and no user-entered
      // password (null or undefined is acceptable).
      const [calledCode, calledPassword] = spies.joinRoom.mock.calls[0];
      expect(calledCode).toBe(code);
      expect(calledPassword == null).toBe(true);
    }
  );

  it("shows a distinct 'not found' message and no password input when the code is unknown", async () => {
    const code = "NOROOM00";
    const { impl, spies } = makeDuelImpl({
      // Probe layer resolves with a not-found signal.
      fetchRoomResult: { error: "Room not found" },
      // If the current (unfixed) code path submits the join anyway, the
      // server would also say Room not found. Mirror that here so the join
      // side of the mock reads plausibly.
      joinRoomResult: { error: "Room not found" },
    });
    vi.mocked(useDuel).mockImplementation(impl);

    render(<DuelGamePage />);

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: /^join room$/i })
    );

    const codeInput = await screen.findByPlaceholderText(/room code/i);
    await user.clear(codeInput);
    await user.type(codeInput, code);

    await user.click(screen.getByRole("button", { name: /^join duel$/i }));

    // (a) A distinct "not found" style message must render in the modal.
    // The fixed UI is expected to surface something the user can read as
    // "no such room" — accept several plausible phrasings.
    await waitFor(() => {
      const notFoundMsg = screen.queryByText(/not found|no room/i);
      expect(notFoundMsg).not.toBeNull();
    });

    // (b) A password prompt must NOT be present as a fallback.
    expect(hasPasswordPrompt()).toBe(false);

    // Guardrail — record what the mock saw, purely for debugging when the
    // test fails. No behavioral assertion beyond the two above.
    void spies;
  });
});
