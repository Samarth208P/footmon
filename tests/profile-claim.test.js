import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import { createClient } from "@supabase/supabase-js";

import { POST as claimProfile } from "@/app/api/profile/claim/route";
import { GET as getProfileRoute } from "@/app/api/profile/[address]/route";
import { GET as getProfilesRoute } from "@/app/api/profile/route";
import { buildClaimMessage, RENAME_COOLDOWN_MS } from "@/lib/username";

const configured = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
);

if (!configured) {
  console.error("\n[profile-claim.test] SKIPPED: Supabase not configured.\n");
}

const randHex = (n) =>
  Array.from({ length: n }, () => "0123456789abcdef".charAt(Math.floor(Math.random() * 16))).join("");

const uniqueName = () => `P${randHex(8)}`;

/** Signs a well-formed claim, letting individual fields be overridden. */
async function signClaim(wallet, overrides = {}) {
  const payload = {
    address: wallet.address,
    username: uniqueName(),
    issuedAt: new Date().toISOString(),
    nonce: randHex(32),
    ...overrides,
  };
  const message = buildClaimMessage(payload);
  const signature = await wallet.signMessage(message);
  return { ...payload, signature };
}

function post(body) {
  return claimProfile(
    new Request("http://localhost/api/profile/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe.skipIf(!configured)("POST /api/profile/claim", () => {
  const admin = configured
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;

  const created = [];

  function track(address) {
    created.push(String(address).toLowerCase());
  }

  afterAll(async () => {
    if (!admin) return;
    for (const a of created) {
      await admin.from("profiles").delete().eq("address", a);
    }
  });

  it("accepts a valid signature and creates the profile", async () => {
    const wallet = Wallet.createRandom();
    track(wallet.address);

    const claim = await signClaim(wallet);
    const res = await post(claim);
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.profile.username).toBe(claim.username);
    expect(json.profile.address).toBe(wallet.address.toLowerCase());
  });

  it("rejects a signature produced by a different wallet", async () => {
    const owner = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    track(owner.address);

    // Attacker signs a message that names the victim's address.
    const payload = {
      address: owner.address,
      username: uniqueName(),
      issuedAt: new Date().toISOString(),
      nonce: randHex(32),
    };
    const signature = await attacker.signMessage(buildClaimMessage(payload));

    const res = await post({ ...payload, signature });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toMatch(/does not match/i);
  });

  it("rejects a signature over a tampered username", async () => {
    const wallet = Wallet.createRandom();
    track(wallet.address);

    const claim = await signClaim(wallet);
    // Signature covers the original name; the body claims a different one.
    const res = await post({ ...claim, username: uniqueName() });

    expect(res.status).toBe(401);
  });

  it("rejects a garbage signature", async () => {
    const wallet = Wallet.createRandom();
    const claim = await signClaim(wallet);
    const res = await post({ ...claim, signature: "0xdeadbeef" });
    expect(res.status).toBe(401);
  });

  it("rejects a duplicate username from a different wallet", async () => {
    const first = Wallet.createRandom();
    const second = Wallet.createRandom();
    track(first.address);
    track(second.address);

    const claim = await signClaim(first);
    expect((await post(claim)).status).toBe(201);

    const clash = await signClaim(second, { username: claim.username });
    const res = await post(clash);
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toMatch(/already taken/i);
  });

  it("treats usernames as case-insensitive for uniqueness", async () => {
    const first = Wallet.createRandom();
    const second = Wallet.createRandom();
    track(first.address);
    track(second.address);

    const claim = await signClaim(first, { username: `Case${randHex(6)}` });
    expect((await post(claim)).status).toBe(201);

    const clash = await signClaim(second, { username: claim.username.toUpperCase() });
    expect((await post(clash)).status).toBe(409);
  });

  it("is idempotent when re-claiming the same name", async () => {
    const wallet = Wallet.createRandom();
    track(wallet.address);

    const claim = await signClaim(wallet);
    expect((await post(claim)).status).toBe(201);

    // Fresh signature, same name.
    const again = await signClaim(wallet, { username: claim.username });
    const res = await post(again);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.unchanged).toBe(true);
  });

  it("enforces the 30-day rename cooldown", async () => {
    const wallet = Wallet.createRandom();
    track(wallet.address);

    const claim = await signClaim(wallet);
    expect((await post(claim)).status).toBe(201);

    const rename = await signClaim(wallet, { username: uniqueName() });
    const res = await post(rename);
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error).toMatch(/change your username again/i);
    expect(json.retryAfterMs).toBeGreaterThan(0);
    expect(json.retryAfterMs).toBeLessThanOrEqual(RENAME_COOLDOWN_MS);
  });

  it("allows a rename once the cooldown has elapsed", async () => {
    const wallet = Wallet.createRandom();
    const address = wallet.address.toLowerCase();
    track(address);

    const claim = await signClaim(wallet);
    expect((await post(claim)).status).toBe(201);

    // Backdate the last rename past the cooldown window.
    const past = new Date(Date.now() - RENAME_COOLDOWN_MS - 60_000).toISOString();
    await admin.from("profiles").update({ username_updated_at: past }).eq("address", address);

    const rename = await signClaim(wallet, { username: uniqueName() });
    const res = await post(rename);

    expect(res.status).toBe(200);
    expect((await res.json()).profile.username).toBe(rename.username);
  });

  it("rejects an expired claim", async () => {
    const wallet = Wallet.createRandom();
    const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const claim = await signClaim(wallet, { issuedAt: stale });

    const res = await post(claim);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/expired/i);
  });

  it("rejects a claim dated in the future", async () => {
    const wallet = Wallet.createRandom();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const claim = await signClaim(wallet, { issuedAt: future });

    const res = await post(claim);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/future/i);
  });

  it.each([
    ["too short", "ab"],
    ["too long", "a".repeat(21)],
    ["illegal characters", "bad name!"],
    ["reserved", "admin"],
    ["leading space", " lead"],
  ])("rejects an invalid username (%s)", async (_label, username) => {
    const wallet = Wallet.createRandom();
    const claim = await signClaim(wallet, { username });
    const res = await post(claim);
    expect(res.status).toBe(400);
  });

  it("rejects a malformed nonce", async () => {
    const wallet = Wallet.createRandom();
    const claim = await signClaim(wallet, { nonce: "not-a-nonce" });
    const res = await post(claim);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/nonce/i);
  });

  it("rejects an invalid address", async () => {
    const wallet = Wallet.createRandom();
    const claim = await signClaim(wallet);
    const res = await post({ ...claim, address: "0x123" });
    expect(res.status).toBe(400);
  });
});

describe.skipIf(!configured)("GET /api/profile", () => {
  const admin = configured
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;

  const created = [];
  afterAll(async () => {
    for (const a of created) await admin.from("profiles").delete().eq("address", a);
  });

  it("returns null profile for an unclaimed address without erroring", async () => {
    const wallet = Wallet.createRandom();
    const res = await getProfileRoute(new Request("http://localhost"), {
      params: Promise.resolve({ address: wallet.address }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).profile).toBeNull();
  });

  it("returns the claimed username", async () => {
    const wallet = Wallet.createRandom();
    created.push(wallet.address.toLowerCase());

    const claim = await signClaim(wallet);
    await post(claim);

    const res = await getProfileRoute(new Request("http://localhost"), {
      params: Promise.resolve({ address: wallet.address }),
    });
    expect((await res.json()).profile.username).toBe(claim.username);
  });

  it("rejects a malformed address", async () => {
    const res = await getProfileRoute(new Request("http://localhost"), {
      params: Promise.resolve({ address: "nope" }),
    });
    expect(res.status).toBe(400);
  });

  it("batch-resolves usernames and omits unclaimed addresses", async () => {
    const claimedWallet = Wallet.createRandom();
    const unclaimedWallet = Wallet.createRandom();
    created.push(claimedWallet.address.toLowerCase());

    const claim = await signClaim(claimedWallet);
    await post(claim);

    const url =
      "http://localhost/api/profile?addresses=" +
      [claimedWallet.address, unclaimedWallet.address].join(",");
    const res = await getProfilesRoute(new Request(url));
    const { usernames } = await res.json();

    expect(usernames[claimedWallet.address.toLowerCase()]).toBe(claim.username);
    expect(usernames[unclaimedWallet.address.toLowerCase()]).toBeUndefined();
  });
});
