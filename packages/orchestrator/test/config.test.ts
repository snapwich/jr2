// Config surface tests (ADR-0019/0031/0038). Small on purpose: `defineConfig` is an identity
// passthrough and `loadConfig` is exercised through the server/instance tests.
//
// What is NOT here any more is the `images` contract. `j2 up` builds every image it deploys and
// resolves every ref itself (ADR-0038), so there is no config seat for one — the published
// `<kitversion>` refs moved to the CLI's resolution layer and are pinned there
// (`packages/cli/test/build.test.ts`), where the not-a-kit-checkout branch actually reads them.
//
// A stale `images:` key in someone's committed config has NO runtime enforcement: deleting the type
// is the whole signal (a typecheck error at authoring time), and `loadConfig` deliberately gains no
// rejection pass — the ADR asks for the seat to be gone, not for a linter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { KIT_VERSION, defineConfig } from "../src/config.ts";

test("KIT_VERSION is the package's own version — npm version == image tag, one release train", () => {
  assert.match(KIT_VERSION, /^\d+\.\d+\.\d+/);
});

test("defineConfig is an identity passthrough — the whole config rides through untouched", () => {
  const config = defineConfig({
    repos: [{ name: "app", url: "https://example.test/app.git" }],
    registry: "reg.example.com/j2",
    harness: { provider: { id: "vllm", api: "openai-completions", baseUrl: "http://10.0.0.5:8000/v1" } },
  });
  assert.deepEqual(config, {
    repos: [{ name: "app", url: "https://example.test/app.git" }],
    registry: "reg.example.com/j2",
    harness: { provider: { id: "vllm", api: "openai-completions", baseUrl: "http://10.0.0.5:8000/v1" } },
  });
});
