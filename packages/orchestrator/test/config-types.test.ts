// `defineConfig`'s TYPE-level claims (ADR-0050, ADR-0051), asserted by the compiler. `pnpm
// typecheck` is what runs this file: every `@ts-expect-error` below fails the build if the error
// it names stops happening, and every unannotated call fails if the acceptance it relies on breaks.
//
// The rule these claims serve: what code names is typed where it is named (ADR-0050), and
// `git.credentials` is the fence a per-run url must pass (ADR-0051). A key the config does not
// declare must stop at `tsc` — at authoring time and in `j2 up`'s typecheck gate — never ride
// through to an entry that admits its prefix anonymously because its `token` was spelled `tokn`.
// That is what a generic `defineConfig<T extends J2Config>(c: T)` cannot do: TypeScript infers `T`
// as the literal's own type and never runs excess-property checking on it, at any depth. The
// parameter is `J2Config` itself, so the checks below hold.
//
// The claims:
//   1. a misspelled field on a `git.credentials` entry is refused — the fence's own fields;
//   2. a misspelled field at any other depth is refused too — the runtime check in `loadConfig`
//      covers only `git.credentials`, so the compiler is the ONLY signal for the rest;
//   3. a stale top-level key (`images`, `repos` — seats ADR-0038/0051 removed) is refused, which is
//      the whole signal those ADRs ask for;
//   4. every declared shape is accepted as written, `readonly` lists included.

import { test } from "node:test";
import assert from "node:assert/strict";
import { defineConfig, type J2Config } from "../src/config.ts";

// 1. The fence's fields, misspelled.
// @ts-expect-error `tokn` is not a credentials field — the entry would admit `*` anonymously
defineConfig({ git: { credentials: [{ match: "*", tokn: "J2_GIT_TOKEN" }] } });
// @ts-expect-error `sshkey` is not a credentials field (`sshKey` is)
defineConfig({ git: { credentials: [{ match: "*", sshkey: "j2-git-ssh" }] } });
// @ts-expect-error `credential` is not the list's key (`credentials` is)
defineConfig({ git: { credential: [{ match: "*" }] } });

// 2. Other depths — nothing at runtime checks these.
defineConfig({
  // @ts-expect-error `modles` is not a provider field (`models` is)
  harness: { provider: { id: "v", api: "openai-completions", baseUrl: "http://h:8000/v1", modles: {} } },
});
// @ts-expect-error `contextWindows` is not a per-model limit (`contextWindow` is)
defineConfig({ harness: { provider: { id: "v", api: "a", baseUrl: "u", models: { m: { contextWindows: 1 } } } } });
// @ts-expect-error `manages` is not an operator key (`manage` is)
defineConfig({ operator: { manages: false } });

// 3. Seats that no longer exist.
// @ts-expect-error `images` is gone — `j2 up` resolves every image ref itself (ADR-0038)
defineConfig({ images: { harness: "j2-harness:local" } });
// @ts-expect-error `repos` is gone — a Machine names its Repos by url on its Repo Slots (ADR-0051)
defineConfig({ repos: { app: "https://example.test/app.git" } });

// 4. Everything declared, as written.
const credentials = [{ match: "github.com/ourorg/", token: "GH_TOKEN", sshKey: "j2-git-ssh" }, { match: "*" }] as const;
const full: J2Config = defineConfig({
  name: "inst",
  git: { credentials },
  harness: {
    provider: {
      id: "vllm",
      api: "openai-completions",
      baseUrl: "http://10.0.0.5:8000/v1",
      apiKey: "k",
      contextWindow: 32768,
      maxTokens: 4096,
      models: { "Qwen/Qwen3-32B": { contextWindow: 40960, maxTokens: 8192 } },
    },
    env: [
      { name: "A", value: "1" },
      { name: "B", valueFrom: { secretKeyRef: { name: "s", key: "k" } } },
    ],
    envFrom: [{ secretRef: { name: "anthropic" } }, { configMapRef: { name: "cm" } }],
    caBundle: "ca.pem",
  },
  registry: "reg.example.com/j2",
  kitRegistry: "reg.example.com/kit",
  platforms: ["linux/arm64"] as const,
  operator: { manage: false },
});

test("defineConfig hands the literal back unchanged — the checks above are the compiler's, not the runtime's", () => {
  assert.equal(full.git?.credentials, credentials);
  assert.equal(defineConfig({}).name, undefined);
});
