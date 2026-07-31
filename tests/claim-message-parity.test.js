import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet, verifyMessage } from "ethers";

import { buildClaimMessage } from "@/lib/username";

/**
 * The claim message is defined twice: once in lib/username.js (server, used to
 * verify) and once in public/js/profile.js (browser, used to sign). The browser
 * copy cannot import the server module, so the duplication is unavoidable — but
 * a single character of drift silently breaks every signature.
 *
 * This test extracts the browser implementation and asserts both produce
 * byte-identical output, and that a signature over one verifies against the
 * other.
 */

function loadClientBuilder() {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "public", "js", "profile.js"),
    "utf8"
  );

  const start = src.indexOf("function buildClaimMessage");
  if (start === -1) {
    throw new Error("buildClaimMessage not found in public/js/profile.js");
  }

  // The parameter list is destructured — `({ address, ... })` — so the body's
  // opening brace is the first one AFTER the closing paren, not after `start`.
  const parenClose = src.indexOf(")", start);
  if (parenClose === -1) {
    throw new Error("Could not find the parameter list of buildClaimMessage");
  }

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
  if (end === -1) {
    throw new Error("Could not find the end of buildClaimMessage in profile.js");
  }

  const fnSource = src.slice(start, end);
  return new Function(`${fnSource}; return buildClaimMessage;`)();
}

const samples = [
  {
    address: "0xAbC0000000000000000000000000000000000001",
    username: "Pele10",
    issuedAt: "2026-07-31T12:00:00.000Z",
    nonce: "0123456789abcdef0123456789abcdef",
  },
  {
    address: "0x0000000000000000000000000000000000000000",
    username: "a_B9",
    issuedAt: "1999-12-31T23:59:59.999Z",
    nonce: "ffffffffffffffffffffffffffffffff",
  },
];

describe("claim message parity between server and browser", () => {
  let clientBuild;

  beforeAll(() => {
    clientBuild = loadClientBuilder();
  });

  it("extracts the browser implementation", () => {
    expect(typeof clientBuild).toBe("function");
  });

  it.each(samples)("produces identical bytes for $username", (sample) => {
    expect(clientBuild(sample)).toBe(buildClaimMessage(sample));
  });

  it("lowercases the address on both sides", () => {
    const msg = clientBuild(samples[0]);
    expect(msg).toContain("Address: 0xabc0000000000000000000000000000000000001");
    expect(msg).not.toContain("0xAbC0");
  });

  it("verifies a browser-built signature with the server-built message", async () => {
    const wallet = Wallet.createRandom();
    const payload = { ...samples[0], address: wallet.address };

    // Browser signs its own rendering...
    const signature = await wallet.signMessage(clientBuild(payload));
    // ...and the server verifies against its own.
    const recovered = verifyMessage(buildClaimMessage(payload), signature);

    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });
});
