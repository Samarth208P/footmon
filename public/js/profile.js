// js/profile.js — username identity: claim, cache and render
//
// Every address in the UI is rendered as a username. Raw addresses are only
// ever shown as a last-resort fallback when a name genuinely is not known yet.

const ProfileManager = (() => {
  /** address(lowercase) -> username */
  const cache = new Map();
  /** addresses already looked up and confirmed to have no profile */
  const known = new Set();

  let myAddress = null;
  let myUsername = null;
  let modalEl = null;
  let pendingClaim = null;

  // ── Message format ────────────────────────────────────────────────────────
  // ⚠️ Must stay byte-identical to buildClaimMessage() in lib/username.js.
  function buildClaimMessage({ address, username, issuedAt, nonce }) {
    return [
      "FootMon username claim",
      "",
      `Address: ${String(address).toLowerCase()}`,
      `Username: ${username}`,
      `Issued At: ${issuedAt}`,
      `Nonce: ${nonce}`,
      "",
      "Signing proves you control this wallet.",
      "It costs no gas and sends no transaction.",
    ].join("\n");
  }

  function randomNonce() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function shortAddr(address) {
    if (!address) return "—";
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
  }

  // ── Lookup ────────────────────────────────────────────────────────────────

  /**
   * Synchronous render helper. Returns the cached username, or a shortened
   * address while the name is still in flight.
   */
  function usernameFor(address) {
    if (!address) return "—";
    const key = String(address).toLowerCase();
    if (cache.has(key)) return cache.get(key);
    return shortAddr(address);
  }

  function isMe(address) {
    return Boolean(
      address && myAddress && String(address).toLowerCase() === myAddress.toLowerCase()
    );
  }

  /** Username with a "You" marker for the connected wallet. */
  function displayName(address) {
    if (isMe(address)) return myUsername ? `${myUsername} (you)` : "You";
    return usernameFor(address);
  }

  async function fetchProfile(address) {
    const key = String(address).toLowerCase();
    try {
      const res = await fetch(`/api/profile/${key}`, { cache: "no-store" });
      if (!res.ok) return null;
      const { profile } = await res.json();
      if (profile?.username) {
        cache.set(key, profile.username);
        return profile;
      }
      known.add(key);
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Batch-resolves any addresses not already cached, then fires
   * `profiles:updated` so open lists can re-render with real names.
   */
  async function prefetch(addresses) {
    const missing = [...new Set(
      (addresses || [])
        .filter(Boolean)
        .map((a) => String(a).toLowerCase())
        .filter((a) => !cache.has(a) && !known.has(a))
    )];
    if (missing.length === 0) return;

    try {
      const res = await fetch(`/api/profile?addresses=${missing.join(",")}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const { usernames } = await res.json();
      let changed = false;
      for (const a of missing) {
        if (usernames[a]) {
          cache.set(a, usernames[a]);
          changed = true;
        } else {
          known.add(a);
        }
      }
      if (changed) {
        document.dispatchEvent(new CustomEvent("profiles:updated"));
      }
    } catch {
      /* names simply stay as shortened addresses */
    }
  }

  // ── Claim modal ───────────────────────────────────────────────────────────

  function buildModal() {
    if (modalEl) return modalEl;

    modalEl = document.createElement("div");
    modalEl.className = "profile-overlay";
    modalEl.setAttribute("role", "dialog");
    modalEl.setAttribute("aria-modal", "true");
    modalEl.setAttribute("aria-labelledby", "profileClaimTitle");
    modalEl.hidden = true;
    modalEl.innerHTML = `
      <div class="profile-modal">
        <h2 id="profileClaimTitle" class="profile-modal-title">Choose your username</h2>
        <p class="profile-modal-sub">
          Other players will see this name instead of your wallet address.
          You can change it once every 30 days.
        </p>
        <label class="profile-modal-label" for="profileUsernameInput">Username</label>
        <input
          id="profileUsernameInput"
          class="profile-modal-input"
          type="text"
          maxlength="20"
          autocomplete="off"
          spellcheck="false"
          placeholder="e.g. Pele10"
          aria-describedby="profileClaimHint profileClaimError"
        />
        <p id="profileClaimHint" class="profile-modal-hint">
          3–20 characters. Letters, numbers and underscores only.
        </p>
        <p id="profileClaimError" class="profile-modal-error" role="alert" aria-live="polite"></p>
        <button id="profileClaimBtn" class="profile-modal-btn" type="button">
          Sign &amp; claim
        </button>
        <p class="profile-modal-foot">Signing is free — no gas, no transaction.</p>
      </div>
    `;
    document.body.appendChild(modalEl);

    const input = modalEl.querySelector("#profileUsernameInput");
    const btn = modalEl.querySelector("#profileClaimBtn");

    btn.addEventListener("click", () => submitClaim());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitClaim();
    });
    input.addEventListener("input", () => setError(""));

    return modalEl;
  }

  function setError(message) {
    const el = modalEl?.querySelector("#profileClaimError");
    if (el) el.textContent = message || "";
  }

  function setBusy(busy) {
    const btn = modalEl?.querySelector("#profileClaimBtn");
    const input = modalEl?.querySelector("#profileUsernameInput");
    if (btn) {
      btn.disabled = busy;
      btn.textContent = busy ? "Waiting for signature…" : "Sign & claim";
    }
    if (input) input.disabled = busy;
  }

  function openModal() {
    buildModal();
    modalEl.hidden = false;
    document.body.classList.add("profile-modal-open");
    const input = modalEl.querySelector("#profileUsernameInput");
    input.value = "";
    setError("");
    setBusy(false);
    setTimeout(() => input.focus(), 30);
  }

  function closeModal() {
    if (!modalEl) return;
    modalEl.hidden = true;
    document.body.classList.remove("profile-modal-open");
  }

  function validateLocally(username) {
    if (username.length < 3 || username.length > 20) {
      return "Username must be 3–20 characters";
    }
    if (!/^[A-Za-z0-9_]+$/.test(username)) {
      return "Only letters, numbers and underscores";
    }
    return null;
  }

  async function submitClaim() {
    const input = modalEl.querySelector("#profileUsernameInput");
    const username = input.value.trim();

    const localError = validateLocally(username);
    if (localError) {
      setError(localError);
      return;
    }

    const address = WalletManager.getAddress();
    if (!address) {
      setError("Wallet disconnected. Reconnect and try again.");
      return;
    }

    setBusy(true);
    setError("");

    try {
      const payload = {
        address: address.toLowerCase(),
        username,
        issuedAt: new Date().toISOString(),
        nonce: randomNonce(),
      };

      const signer = WalletManager.getSigner();
      const signature = await signer.signMessage(buildClaimMessage(payload));

      const res = await fetch("/api/profile/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, signature }),
      });
      const json = await res.json();

      if (!res.ok) {
        setError(json.error || "Could not claim that username");
        setBusy(false);
        return;
      }

      myUsername = json.profile.username;
      cache.set(address.toLowerCase(), myUsername);
      known.delete(address.toLowerCase());

      closeModal();
      document.dispatchEvent(
        new CustomEvent("profile:claimed", { detail: { address, username: myUsername } })
      );
      document.dispatchEvent(new CustomEvent("profiles:updated"));

      pendingClaim?.resolve(myUsername);
      pendingClaim = null;
    } catch (err) {
      // User rejecting the signature in MetaMask lands here.
      const rejected = err?.code === "ACTION_REJECTED" || /reject|denied/i.test(err?.message || "");
      setError(rejected ? "Signature rejected — a username is required to play." : (err?.message || "Signing failed"));
      setBusy(false);
    }
  }

  // ── Entry point ───────────────────────────────────────────────────────────

  /**
   * Called after a wallet connects. Resolves once the address has a username,
   * blocking on the modal when it does not.
   */
  async function ensureUsername(address) {
    myAddress = address;
    const profile = await fetchProfile(address);

    if (profile?.username) {
      myUsername = profile.username;
      document.dispatchEvent(new CustomEvent("profiles:updated"));
      return myUsername;
    }

    openModal();
    return new Promise((resolve) => {
      pendingClaim = { resolve };
    });
  }

  function reset() {
    myAddress = null;
    myUsername = null;
    closeModal();
  }

  function getMyUsername() {
    return myUsername;
  }

  document.addEventListener("wallet:disconnected", reset);

  return {
    ensureUsername,
    usernameFor,
    displayName,
    prefetch,
    getMyUsername,
    shortAddr,
    buildClaimMessage,
    reset,
  };
})();
