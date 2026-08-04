// Config surface tests (ADR-0019/0031). Small on purpose: `defineConfig` is an identity
// passthrough and `loadConfig` is exercised through the server/instance tests — what is pinned
// here is the `images` contract, because three deploy seats (Sandbox pods, the Instance Harness,
// the operator layer) default off these constants and drifting tags would ship different code to
// different pods of one release train (npm version == image tag).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ADAPTER_IMAGE,
  DEFAULT_HARNESS_IMAGE,
  DEFAULT_OPERATOR_IMAGE,
  KIT_VERSION,
  defineConfig,
} from "../src/config.ts";

test("the kit three default to the published <kitversion> tags (ADR-0031)", () => {
  assert.equal(DEFAULT_HARNESS_IMAGE, `j2-harness:${KIT_VERSION}`);
  assert.equal(DEFAULT_ADAPTER_IMAGE, `j2-adapter:${KIT_VERSION}`);
  assert.equal(DEFAULT_OPERATOR_IMAGE, `j2-operator:${KIT_VERSION}`);
});

test("defineConfig is an identity passthrough — the images block rides through untouched", () => {
  const config = defineConfig({
    repos: [{ name: "app", url: "https://example.test/app.git" }],
    images: { harness: "j2-harness:local", user: "workbench:me" },
  });
  assert.deepEqual(config, {
    repos: [{ name: "app", url: "https://example.test/app.git" }],
    images: { harness: "j2-harness:local", user: "workbench:me" },
  });
});
