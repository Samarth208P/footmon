import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Extracts the two pure link helpers from public/js/duel-room.js. The rest of
 * that module needs a wallet and the DOM, so only these are exercised here.
 */
function loadLinkHelpers() {
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "public", "js", "duel-room.js"),
    "utf8"
  );

  const grab = (name) => {
    const start = src.indexOf(`function ${name}`);
    if (start === -1) throw new Error(`${name} not found in duel-room.js`);
    const parenClose = src.indexOf(")", start);
    const open = src.indexOf("{", parenClose);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    throw new Error(`Could not delimit ${name}`);
  };

  const source = `${grab("shareLinkFor")}\n${grab("parseInvite")}`;
  return new Function(
    "location",
    "URL",
    "URLSearchParams",
    `${source}; return { shareLinkFor, parseInvite };`
  )({ origin: "https://footmon.example" }, URL, URLSearchParams);
}

describe("duel invite links", () => {
  let helpers;
  beforeAll(() => {
    helpers = loadLinkHelpers();
  });

  it("builds a plain link for a public room", () => {
    expect(helpers.shareLinkFor("ABC23456")).toBe("https://footmon.example/duel/ABC23456");
  });

  it("puts the password in the fragment, never the query string", () => {
    const link = helpers.shareLinkFor("ABC23456", "hunter22");
    expect(link).toBe("https://footmon.example/duel/ABC23456#pw=hunter22");
    // A query string would be sent to the server and logged; a fragment is not.
    expect(link).not.toContain("?");
  });

  it("encodes a password with URL-unsafe characters", () => {
    const link = helpers.shareLinkFor("ABC23456", "a b&c=d#e");
    expect(link).toContain("#pw=a%20b%26c%3Dd%23e");
    // The literal '#' from the password must not create a second fragment.
    expect(link.split("#")).toHaveLength(2);
  });

  it("round-trips a password through build then parse", () => {
    for (const password of ["hunter22", "a b&c=d", "p#a$s%", "üñïçødé"]) {
      const link = helpers.shareLinkFor("ABC23456", password);
      expect(helpers.parseInvite(link).password).toBe(password);
    }
  });

  it("parses a room code from the path", () => {
    expect(helpers.parseInvite("https://x.test/duel/ABC23456")).toEqual({
      code: "ABC23456",
      password: null,
    });
  });

  it("upper-cases a lowercase code", () => {
    expect(helpers.parseInvite("https://x.test/duel/abc23456").code).toBe("ABC23456");
  });

  it("tolerates a trailing slash", () => {
    expect(helpers.parseInvite("https://x.test/duel/ABC23456/").code).toBe("ABC23456");
  });

  it("returns null for non-invite URLs", () => {
    for (const url of [
      "https://x.test/",
      "https://x.test/duel",
      "https://x.test/duel/",
      "https://x.test/duel/TOO-SHORT!",
      "https://x.test/duel/ABC23456/extra",
      "https://x.test/other/ABC23456",
      "not a url",
    ]) {
      expect(helpers.parseInvite(url)).toBeNull();
    }
  });

  it("rejects a code that is too short or too long", () => {
    expect(helpers.parseInvite("https://x.test/duel/ABC12")).toBeNull();
    expect(helpers.parseInvite("https://x.test/duel/ABCDEFGHIJK")).toBeNull();
  });

  it("ignores unrelated fragment parameters", () => {
    const parsed = helpers.parseInvite("https://x.test/duel/ABC23456#foo=bar");
    expect(parsed.code).toBe("ABC23456");
    expect(parsed.password).toBeNull();
  });
});
