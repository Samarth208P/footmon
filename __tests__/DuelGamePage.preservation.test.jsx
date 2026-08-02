/**
 * Preservation property tests for the `room-password-prompt-when-none-set`
 * spec.
 *
 * Property 2 (Preservation): private rooms and unrelated flows unchanged.
 *
 * These tests encode the behaviors listed in the design under
 * "Preservation Requirements" that MUST continue to hold after the fix:
 *
 *   P1. Private-room render — with a private room in play, the join modal
 *       renders a password `<input>` at the point the user is expected to
 *       enter one, and clicking "Join Duel" invokes
 *       `duel.joinRoom(code, enteredPassword)`.
 *   P2. Private-room rejection — when `duel.joinRoom` returns
 *       `{ error: "Incorrect room password" }`, the error surfaces to the
 *       UI (toast) for a range of wrong password values.
 *   P3. Lobby quick-join — `handleJoinFromLobby(room)` calls
 *       `duel.joinRoom(room.room_code)` with no password argument and
 *       never opens the join modal.
 *   P4. Create-modal — for a range of `{ isPrivate, password, stake }`
 *       inputs, submitting the create modal calls `duel.createRoom` with
 *       `{ stake: String(stake), isPrivate, password: isPrivate ? password : null }`.
 *   P5. Deep-link private-room — `?join=CODE` in the URL opens the modal
 *       with the code prefilled and the password input present.
 *   P6. Waiting-screen password display — when the creator's room is
 *       private, the waiting screen renders the password string they
 *       entered during create.
 *
 * These tests are EXPECTED TO PASS on UNFIXED code. That confirms the
 * baseline behavior that the upcoming fix must preserve.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Hoisted mocks — same shape as the exploration test at
// __tests__/DuelGamePage.joinModal.test.jsx so both files exercise the SUT
// with a consistent surface.
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

vi.mock("@/hooks/useDuel", () => ({
  useDuel: vi.fn(),
}));

import DuelGamePage from "@/components/DuelGamePage";
import { useDuel } from "@/hooks/useDuel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a `useDuel` mock implementation. Configurable initial values are
 * supplied by the test; the modal open flags live in real React state so
 * click handlers actually toggle them.
 */
function makeDuelImpl(opts = {}) {
  const {
    screenValue = "lobby",
    room = null,
    roomCode = null,
    isCreator = false,
    challenges = [],
    fetchRoomResult = { room: {} },
    joinRoomResult = { room: {} },
    createRoomResult = { room: {} },
  } = opts;

  const joinRoom = vi.fn(async () => joinRoomResult);
  const fetchRoomByCode = vi.fn(async () => fetchRoomResult);
  const createRoom = vi.fn(async () => createRoomResult);

  const impl = () => {
    const [joinModalOpen, setJoinModalOpen] = React.useState(false);
    const [createModalOpen, setCreateModalOpen] = React.useState(false);

    return {
      screen: screenValue,
      setScreen: vi.fn(),

      challenges,
      lobbyLoading: false,
      refreshLobby: vi.fn(),

      roomCode,
      room,
      isCreator,
      opponent: null,
      opponentReady: false,
      myReady: false,
      sessionToken: null,

      formation: "4-3-3",
      style: "balanced",
      setFormation: vi.fn(),
      setStyle: vi.fn(),
      mySlots: [],
      opponentSlots: [],

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

      isMyTurn: false,
      turnDeadline: null,

      busy: false,
      error: null,
      setError: vi.fn(),

      createModalOpen,
      setCreateModalOpen,
      joinModalOpen,
      setJoinModalOpen,

      createRoom,
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

      getMyStats: () => ({ avg: "0.0", attack: 0, defense: 0, assigned: 0, total: 0 }),
      getOpponentStats: () => ({ avg: "0.0", attack: 0, defense: 0, assigned: 0, total: 0 }),
      isSquadComplete: false,
    };
  };

  return { impl, spies: { joinRoom, fetchRoomByCode, createRoom } };
}

// Reset mocks & URL between cases so no state bleeds across tests.
beforeEach(() => {
  vi.mocked(useDuel).mockReset();
  if (typeof window !== "undefined") {
    window.history.replaceState({}, "", "/");
  }
});

// ---------------------------------------------------------------------------
// Preservation P1 — Private-room render property
// ---------------------------------------------------------------------------

describe("Preservation P1: private-room join renders password input and submits (code, password)", () => {
  const cases = [
    { code: "PRV00001", password: "hunter2" },
    { code: "SEC12345", password: "s3cret!" },
    { code: "PWDABCDE", password: "correct-horse" },
    { code: "ROOM0007", password: "abcd" },
  ];

  it.each(cases)(
    "renders password input and calls joinRoom($code, $password)",
    async ({ code, password }) => {
      const { impl, spies } = makeDuelImpl({
        fetchRoomResult: { room: { room_code: code, is_private: true } },
        joinRoomResult: { room: { room_code: code, is_private: true } },
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

      // At the point the user is expected to enter a password, the password
      // input must be present in the modal.
      const passwordInput = screen.getByPlaceholderText(/^Password/i);
      expect(passwordInput).toBeInTheDocument();
      expect(passwordInput).toHaveAttribute("type", "password");

      await user.type(passwordInput, password);
      await user.click(
        screen.getByRole("button", { name: /^join duel$/i })
      );

      await waitFor(() => {
        expect(spies.joinRoom).toHaveBeenCalled();
      });

      const [calledCode, calledPassword] = spies.joinRoom.mock.calls[0];
      expect(calledCode).toBe(code);
      expect(calledPassword).toBe(password);
    }
  );
});

// ---------------------------------------------------------------------------
// Preservation P2 — Private-room rejection property
// ---------------------------------------------------------------------------

describe("Preservation P2: wrong password surfaces 'Incorrect room password' error", () => {
  const wrongPasswords = [
    "abcd",
    "wrong-password",
    "12345678",
    "totally-not-it",
    "hunter3",
  ];

  it.each(wrongPasswords)(
    "surfaces the error toast for wrong password %j",
    async (wrongPassword) => {
      const code = "PRV99999";
      const { impl, spies } = makeDuelImpl({
        fetchRoomResult: { room: { room_code: code, is_private: true } },
        joinRoomResult: { error: "Incorrect room password" },
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

      const pw = screen.getByPlaceholderText(/^Password/i);
      await user.type(pw, wrongPassword);

      await user.click(
        screen.getByRole("button", { name: /^join duel$/i })
      );

      await waitFor(() => {
        expect(spies.joinRoom).toHaveBeenCalled();
      });

      // Toast content should carry the error message the server returned.
      await waitFor(() => {
        expect(
          screen.queryByText(/incorrect room password/i)
        ).not.toBeNull();
      });
    }
  );
});

// ---------------------------------------------------------------------------
// Preservation P3 — Lobby quick-join property
// ---------------------------------------------------------------------------

describe("Preservation P3: handleJoinFromLobby joins directly, no modal, no password", () => {
  const publicRooms = [
    { id: "r1", room_code: "PUB00001", creator: "0xa1", stake: "100000000000000000" },
    { id: "r2", room_code: "PUB00002", creator: "0xb2", stake: "200000000000000000" },
    { id: "r3", room_code: "PUB00003", creator: "0xc3", stake: "300000000000000000" },
    { id: "r4", room_code: "PUB00004", creator: "0xd4", stake: "500000000000000000" },
  ];

  it.each(publicRooms)(
    "joins $room_code without opening the modal or sending a password",
    async (room) => {
      const { impl, spies } = makeDuelImpl({
        challenges: [room],
        joinRoomResult: { room: {} },
      });
      vi.mocked(useDuel).mockImplementation(impl);

      render(<DuelGamePage />);

      const user = userEvent.setup();

      // The challenge-card button is labeled exactly "Join".
      const joinBtn = await screen.findByRole("button", { name: /^join$/i });
      await user.click(joinBtn);

      await waitFor(() => {
        expect(spies.joinRoom).toHaveBeenCalled();
      });

      const call = spies.joinRoom.mock.calls[0];
      expect(call[0]).toBe(room.room_code);
      // handleJoinFromLobby passes exactly one argument, so the second is
      // observably `undefined`.
      expect(call[1]).toBeUndefined();

      // No join modal has been opened — the "Room code" input never
      // appeared in the DOM.
      expect(screen.queryByPlaceholderText(/room code/i)).toBeNull();
    }
  );
});

// ---------------------------------------------------------------------------
// Preservation P4 — Create-modal property
// ---------------------------------------------------------------------------

describe("Preservation P4: create modal submits duel.createRoom with expected shape", () => {
  const cases = [
    { isPrivate: false, password: "", stake: "0.1" },
    { isPrivate: false, password: "", stake: "1.5" },
    { isPrivate: true, password: "hunter2", stake: "0.5" },
    { isPrivate: true, password: "s3cret!", stake: "2.0" },
    { isPrivate: true, password: "correcthorsebatterystaple", stake: "10.0" },
  ];

  it.each(cases)(
    "createRoom called with {isPrivate: $isPrivate, stake: $stake}",
    async ({ isPrivate, password, stake }) => {
      const { impl, spies } = makeDuelImpl({});
      vi.mocked(useDuel).mockImplementation(impl);

      render(<DuelGamePage />);

      const user = userEvent.setup();

      // Open the Create Duel modal (lobby header button reads "+ Create Duel").
      await user.click(
        await screen.findByRole("button", { name: /create duel/i })
      );

      // Enter stake.
      const stakeInput = await screen.findByPlaceholderText(/stake amount/i);
      await user.clear(stakeInput);
      await user.type(stakeInput, stake);

      if (isPrivate) {
        // Toggle private-room checkbox (the only checkbox on the page).
        const privateCheckbox = screen.getByRole("checkbox");
        await user.click(privateCheckbox);
        // Now the "Room password ..." input appears — enter the password.
        const pwInput = await screen.findByPlaceholderText(/room password/i);
        await user.clear(pwInput);
        await user.type(pwInput, password);
      }

      await user.click(
        screen.getByRole("button", { name: /^create challenge$/i })
      );

      await waitFor(() => {
        expect(spies.createRoom).toHaveBeenCalled();
      });

      const arg = spies.createRoom.mock.calls[0][0];
      expect(arg).toEqual({
        stake: String(parseFloat(stake)),
        isPrivate,
        password: isPrivate ? password : null,
      });
    }
  );
});

// ---------------------------------------------------------------------------
// Preservation P5 — Deep-link private-room property
// ---------------------------------------------------------------------------

describe("Preservation P5: ?join=CODE prefills modal with code and shows password input", () => {
  const codes = ["PRV00001", "SEC12345", "PWDABCDE"];

  it.each(codes)(
    "opens modal with code %s prefilled and a password input present",
    async (code) => {
      // Set the URL BEFORE render so the on-mount useEffect picks it up.
      window.history.replaceState({}, "", `/?join=${code}`);

      const { impl } = makeDuelImpl({
        fetchRoomResult: { room: { room_code: code, is_private: true } },
      });
      vi.mocked(useDuel).mockImplementation(impl);

      render(<DuelGamePage />);

      // The modal opens automatically because the mount useEffect calls
      // `duel.setJoinModalOpen(true)` after reading the query param.
      const codeInput = await screen.findByPlaceholderText(/room code/i);
      await waitFor(() => {
        expect(codeInput.value).toBe(code);
      });

      // The pre-fix invariant we assert: the modal is open, the code is
      // prefilled, and a password input is present. (Post-fix, the
      // password input appears only after the probe. Pre-fix, it appears
      // immediately. Both satisfy "input present".)
      const passwordInput = screen.getByPlaceholderText(/^Password/i);
      expect(passwordInput).toBeInTheDocument();
      expect(passwordInput).toHaveAttribute("type", "password");
    }
  );
});

// ---------------------------------------------------------------------------
// Preservation P6 — Waiting-screen password display property
// ---------------------------------------------------------------------------

/**
 * The waiting-screen password display reads from the LOCAL `passwordInput`
 * state inside `DuelGamePage`. Because that state is component-scoped, the
 * cleanest way to observe it is to walk the full create flow: open create,
 * toggle private, type the password, click Create, then have the mock hook
 * flip `screen` to `"waiting"` and expose a private room on `duel.room`.
 *
 * The stateful mock below wires `createRoom` to that transition.
 */
describe("Preservation P6: creator's waiting screen renders the room password", () => {
  const cases = [
    { code: "PRV11111", password: "hunter2" },
    { code: "PRV22222", password: "correcthorsebattery" },
    { code: "PRV33333", password: "pass1234" },
  ];

  it.each(cases)(
    "displays password '$password' after creating private room $code",
    async ({ code, password }) => {
      // Ambient store the mock will re-read on every render so a
      // successful createRoom can flip the screen state.
      let screenState = "lobby";
      let roomState = null;
      let isCreatorState = false;
      let listeners = [];
      const notify = () => {
        for (const fn of listeners) fn();
      };

      const room = {
        room_code: code,
        is_private: true,
        stake: "500000000000000000",
        creator: "0x1111111111111111111111111111111111111111",
      };

      const joinRoom = vi.fn(async () => ({ room: {} }));
      const fetchRoomByCode = vi.fn(async () => ({ room: {} }));
      const createRoom = vi.fn(async () => {
        screenState = "waiting";
        roomState = room;
        isCreatorState = true;
        notify();
        return { room };
      });

      const impl = () => {
        const [tick, setTick] = React.useState(0);
        React.useEffect(() => {
          const fn = () => setTick((n) => n + 1);
          listeners.push(fn);
          return () => {
            listeners = listeners.filter((f) => f !== fn);
          };
        }, []);
        // Read `tick` so the linter and React know we depend on it.
        void tick;

        const [joinModalOpen, setJoinModalOpen] = React.useState(false);
        const [createModalOpen, setCreateModalOpen] = React.useState(false);

        return {
          screen: screenState,
          setScreen: vi.fn(),
          challenges: [],
          lobbyLoading: false,
          refreshLobby: vi.fn(),
          roomCode: roomState?.room_code ?? null,
          room: roomState,
          isCreator: isCreatorState,
          opponent: null,
          opponentReady: false,
          myReady: false,
          sessionToken: null,
          formation: "4-3-3",
          style: "balanced",
          setFormation: vi.fn(),
          setStyle: vi.fn(),
          mySlots: [],
          opponentSlots: [],
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
          isMyTurn: false,
          turnDeadline: null,
          busy: false,
          error: null,
          setError: vi.fn(),
          createModalOpen,
          setCreateModalOpen,
          joinModalOpen,
          setJoinModalOpen,
          createRoom,
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
          getMyStats: () => ({ avg: "0.0", attack: 0, defense: 0, assigned: 0, total: 0 }),
          getOpponentStats: () => ({ avg: "0.0", attack: 0, defense: 0, assigned: 0, total: 0 }),
          isSquadComplete: false,
        };
      };

      vi.mocked(useDuel).mockImplementation(impl);

      render(<DuelGamePage />);

      const user = userEvent.setup();

      await user.click(
        await screen.findByRole("button", { name: /create duel/i })
      );

      const stakeInput = await screen.findByPlaceholderText(/stake amount/i);
      await user.clear(stakeInput);
      await user.type(stakeInput, "0.5");

      const privateCheckbox = screen.getByRole("checkbox");
      await user.click(privateCheckbox);

      const pwInput = await screen.findByPlaceholderText(/room password/i);
      await user.clear(pwInput);
      await user.type(pwInput, password);

      await user.click(
        screen.getByRole("button", { name: /^create challenge$/i })
      );

      await waitFor(() => {
        expect(createRoom).toHaveBeenCalled();
      });

      // The waiting screen renders the password as the textContent of a
      // <code class="waiting-code"> element. It appears alongside the
      // room code, so we find the specific one that matches the password.
      await waitFor(() => {
        const codeElements = Array.from(
          document.querySelectorAll("code")
        );
        const match = codeElements.find(
          (el) => el.textContent === password
        );
        expect(match).toBeTruthy();
      });
    }
  );
});
