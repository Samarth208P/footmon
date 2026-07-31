import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Loads .env for tests and makes the FILE authoritative.
 *
 * process.loadEnvFile() will not overwrite a variable that is already present
 * in the ambient environment. That bites hard here: a stale key exported into
 * the shell silently shadows the rotated one in .env, and the test suite then
 * exercises the wrong project (or the wrong key class) while looking green.
 */

const envPath = resolve(import.meta.dirname, "..", ".env");

if (existsSync(envPath)) {
  const raw = readFileSync(envPath, "utf8");

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(key)) continue;

    let value = trimmed.slice(eq + 1).trim();
    // Strip matching surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}
