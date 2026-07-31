import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * Task 1 baseline: the toolchain runs, and the env contract every later task
 * depends on is declared in .env.example with placeholder names only.
 */
describe("toolchain baseline", () => {
  it("runs the test suite", () => {
    expect(true).toBe(true);
  });
});

describe(".env.example contract", () => {
  const raw = readFileSync(resolve(ROOT, ".env.example"), "utf8");
  const keys = raw
    .split(/\r?\n/)
    .filter((line) => /^[A-Za-z_][A-Za-z_0-9]*=/.test(line))
    .map((line) => line.split("=")[0]);

  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "RESOLVER_PRIVATE_KEY",
  ];

  for (const key of required) {
    it(`declares ${key}`, () => {
      expect(keys).toContain(key);
    });
  }

  it("contains no real values, only placeholders", () => {
    const values = raw
      .split(/\r?\n/)
      .filter((line) => /^[A-Za-z_][A-Za-z_0-9]*=/.test(line))
      .map((line) => line.slice(line.indexOf("=") + 1).trim())
      .filter(Boolean);

    for (const value of values) {
      expect(value).not.toMatch(/^sb_secret_/);
      expect(value).not.toMatch(/^sb_publishable_/);
      expect(value).not.toMatch(/^eyJ/); // supabase JWT keys
      expect(value).not.toMatch(/^0x[0-9a-fA-F]{64}$/); // private keys
    }
  });

  it("never exposes a private key to the browser bundle", () => {
    expect(keys.filter((k) => k.startsWith("NEXT_PUBLIC_"))).not.toContain(
      "NEXT_PUBLIC_RESOLVER_PRIVATE_KEY"
    );
    for (const key of keys) {
      if (key.startsWith("NEXT_PUBLIC_")) {
        expect(key).not.toMatch(/PRIVATE_KEY|SERVICE_ROLE/);
      }
    }
  });
});
