// Config surface tests (ADR-0004/0019/0031/0038). `defineConfig` is an identity passthrough;
// `loadConfig` owns the ONE resolution pass — `repos` shorthand → `Repo`s, shape-checked at runtime
// because an instance is zero-build and nothing typechecks its config before Node imports it.
//
// What is NOT here any more is the `images` contract. `j2 up` builds every image it deploys and
// resolves every ref itself (ADR-0038), so there is no config seat for one — the published
// `<kitversion>` refs moved to the CLI's resolution layer and are pinned there
// (`packages/cli/test/build.test.ts`), where the not-a-kit-checkout branch actually reads them.
//
// A stale `images:` key in someone's committed config has NO runtime enforcement: deleting the type
// is the whole signal (a typecheck error at authoring time), and `loadConfig` deliberately gains no
// rejection pass for unknown keys — the ADR asks for the seat to be gone, not for a linter. The
// runtime check below is scoped to what the pass resolves: the `repos` entries, nothing else.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIT_VERSION, defineConfig, loadConfig, repoName, resolveRepos } from "../src/config.ts";

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

test("repoName is the url's last segment minus .git — scp-style, ssh://, https, trailing slash, local path", () => {
  assert.equal(repoName("git@github.com:snapwich/richsnapp-new.git"), "richsnapp-new");
  assert.equal(repoName("ssh://git@github.com/snapwich/richsnapp-new.git"), "richsnapp-new");
  assert.equal(repoName("https://github.com/snapwich/richsnapp-new"), "richsnapp-new");
  assert.equal(repoName("https://github.com/snapwich/richsnapp-new.git/"), "richsnapp-new");
  assert.equal(repoName("/instance/seed/app.bundle"), "app.bundle", "only .git is stripped");
  assert.equal(repoName("git@github.com:solo"), "solo");
});

test("resolveRepos: a string is { url } named after the repository; an object keeps its name and ref", () => {
  assert.deepEqual(
    resolveRepos(
      [
        "git@github.com:snapwich/richsnapp-new.git",
        { url: "https://forge/me/tools.git", ref: "v2" },
        { name: "app", url: "/instance/seed/app.bundle" },
      ],
      "j2.config.ts",
    ),
    [
      { name: "richsnapp-new", url: "git@github.com:snapwich/richsnapp-new.git" },
      { name: "tools", url: "https://forge/me/tools.git", ref: "v2" },
      { name: "app", url: "/instance/seed/app.bundle" },
    ],
  );
});

test("resolveRepos: two entries deriving one name fail by naming both urls — the explicit form is the fix", () => {
  assert.throws(
    () => resolveRepos(["git@github.com:a/app.git", "git@github.com:b/app.git"], "j2.config.ts"),
    /j2\.config\.ts: repos "git@github\.com:a\/app\.git" and "git@github\.com:b\/app\.git" both resolve to the name "app".*\{ name, url \}/,
  );
});

test("resolveRepos: a mis-shaped entry fails loudly at load, by index — never reads as url: undefined", () => {
  assert.throws(() => resolveRepos([{ name: "app" }], "j2.config.ts"), /j2\.config\.ts at repos\[0\]\.url/);
  assert.throws(() => resolveRepos([42], "j2.config.ts"), /j2\.config\.ts at repos\[0\]/);
  assert.throws(() => resolveRepos("git@github.com:a/app.git", "j2.config.ts"), /at repos:/);
  assert.throws(() => resolveRepos([""], "j2.config.ts"), /at repos\[0\]/);
});

test("loadConfig resolves repos in place and hands back everything else untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "j2-config-"));
  await writeFile(
    join(dir, "j2.config.ts"),
    `export default { name: "myinst", repos: ["git@github.com:snapwich/richsnapp-new.git"], registry: "reg" };\n`,
  );
  assert.deepEqual(await loadConfig(dir), {
    name: "myinst",
    registry: "reg",
    repos: [{ name: "richsnapp-new", url: "git@github.com:snapwich/richsnapp-new.git" }],
  });
  const bare = await mkdtemp(join(tmpdir(), "j2-config-"));
  await writeFile(join(bare, "j2.config.ts"), `export default { name: "bare" };\n`);
  assert.deepEqual(await loadConfig(bare), { name: "bare" }, "no repos key → none added");
});
