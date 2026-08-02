import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Prevent DOM state from leaking between test cases.
afterEach(() => {
  cleanup();
});
