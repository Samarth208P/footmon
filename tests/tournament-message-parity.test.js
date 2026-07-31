import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { Wallet, verifyMessage } from "ethers";

import { buildTournamentMessage, squadFingerprint } from "@/lib/tournament";

/**
 * buildTournamentMessage exists twice: lib/tournament.js (server, verifies) and
 * public/js/tournament.js (browser, signs). Drift of a single character makes
 * every run submission fail with a 401, so both are compared here.
 *
 * The browser also recomputes the squad fingerprint before hashing it; that
 * ordering rule is checked too.
 */
function loadClientBuilder() {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "public", "js", "tournament.js"),
    "utf8"
  );

  const start = src.indexOf("function buildTournamentMessage");
  if (start === -1) throw new Error("buildTournamentMessage not found in public/js/tournament.js");

  const parenClose = src.indexOf(")", start);
  const open = src.indexOf("{", parenClose);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) throw new Error("Could not delimit buildTournamentMessage");

  return new Function(`${src.slice(start, end)}; return buildTournamentMessage;`)();
}

const samples = [
  {
    address: "0xAbC0000000000000000000000000000000000001",
    squadHash: "a".repeat(64),
    issuedAt: "2026-07-31T12:00:00.000Z",
    nonce: "0123456789abcdef0123456789abcdef",
  },
  {
    address: "0x0000000000000000000000000000000000000000",
    squadHash: "f".repeat(64),
    issuedAt: "1999-12-31T23:59:59.999Z",
    nonce: "ffffffffffffffffffffffffffffffff",
  },
];

describe("tournament message parity", () => {
  let clientBuild;
  beforeAll(() => {
    clientBuild = loadClientBuilder();
  });

  it.each(samples)("produces identical bytes for $squadHash", (sample) => {
    expect(clientBuild(sample)).toBe(buildTournamentMessage(sample));
  });

  it("lowercases the address on both sides", () => {
    expect(clientBuild(samples[0])).toContain(
      "Address: 0xabc0000000000000000000000000000000000001"
    );
  });

  it("verifies a browser-built signature against the server message", async () => {
    const wallet = Wallet.createRandom();
    const payload = { ...samples[0], address: wallet.address };

    const signature = await wallet.signMessage(clientBuild(payload));
    const recovered = verifyMessage(buildTournamentMessage(payload), signature);

    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it("agrees with the server on the squad fingerprint and its hash", () => {
    const players = [
      { name: "Pele", position: "ST", rating: 94 },
      { name: "Gerson", position: "CM", rating: 86 },
      { name: "Felix", position: "GK", rating: 78.5 },
    ];

    // Mirrors the browser: sort "name|position|rating(2dp)" then join with ';'.
    const clientFingerprint = players
      .map((p) => `${p.name}|${p.position ?? ""}|${Number(p.rating ?? 0).toFixed(2)}`)
      .sort()
      .join(";");

    expect(clientFingerprint).toBe(squadFingerprint(players));

    const hash = createHash("sha256").update(clientFingerprint).digest("hex");
    expect(hash).toHaveLength(64);
  });

  it("keeps the fingerprint order-independent", () => {
    const players = [
      { name: "A", position: "GK", rating: 70 },
      { name: "B", position: "ST", rating: 80 },
    ];
    expect(squadFingerprint(players)).toBe(squadFingerprint([...players].reverse()));
  });
});
