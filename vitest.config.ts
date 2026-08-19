import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * The suite lives exclusively in tests/. Pinning `include` (rather than
     * extending the default `**` glob with exclusions) keeps stray .spec.js files
     * out of the run — notably the Chrome extensions that ship their own tests
     * inside the persistent browser profile the "cdp" provider writes to
     * (data/chrome-profile/), and anything dropped in evidence/ or out/.
     */
    include: ["tests/**/*.test.ts"],
  },
});
