// Every Workflow under examples/ passes the Instance check of `jr2 up` (ADR-0050). A page tells the
// reader to put the file in `workflows/` and run `jr2 up`, and an Assistant copies it. `pnpm
// typecheck` compiles the file, but `jr2 up` also loads the Machine and walks it: the fault routes
// (ADR-0073, ADR-0074), the Open parts, the `mcp` names, the Chart files, the dispatches, the Effect
// secrets and the pushes, the seats (ADR-0015) and the Sizes. This test calls `checkInstance`, the
// function that `jr2 up` and `jr2 check` call, so it cannot give a different answer. It does not copy
// a rule. A `refusing:`, `error:` or `warning:` line fails the test.
//
// How the test finds the Workflows: a `.ts` file that has a line that starts with
// `export const machine` is a Workflow, because that is the module contract of `workflows/<name>.ts`.
// Each other `.ts` file is a `jr2.config.ts` or is in NOT_WORKFLOWS, with the reason. Thus a
// Workflow that loses its `export const machine` fails here, and is not skipped.
//
// How the test makes an Instance:
// - The Workflows in one folder are the `workflows/` of one Instance, because a folder is a tab or a
//   page. A Workflow can dispatch to a Workflow in the same folder.
// - The config is the `jr2.config.ts` that a page that shows these Workflows also shows. When no page
//   shows one, it is the config of the provider tab (`anthropic/` or `local/`) from
//   `examples/shared/`, which "Connect a model" gives the reader. Else it is empty, as `jr2 check`
//   reads an Instance that has no config.
// - ALSO adds what a page tells the reader to add in its text, not in a file.
// - A Chart file in the folder of a Workflow, or in the folder above it, goes in
//   `workflows/<that Workflow>/`, as "Run a Chart by name" tells.
// - The reader fills in each placeholder, such as `<you>`. The test fills it in with PLACEHOLDERS.
// - The typecheck is not run here: `pnpm typecheck` compiles every example.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, mkdir, symlink } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, type JR2Config } from "@jr2/orchestrator/internal";
import { checkInstance } from "../../../packages/cli/src/instance-check.ts";
import { allPages, readSitemap } from "../build/sitemap.ts";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const EXAMPLES = join(SITE, "examples");

/** The `.ts` files that are not a Workflow and not a `jr2.config.ts`, each with the reason. */
const NOT_WORKFLOWS: Record<string, string> = {
  "guides/publish-a-machine-as-an-npm-package/labeler/src/index.ts":
    "a package that exports a Machine; label.ts is the Workflow that registers it",
  "guides/write-a-tool-as-an-mcp-server/images/default/semver-mcp.ts":
    "an MCP server that runs in the Sandbox Image, not a Machine",
  "guides/write-a-hook-kind/hooks/stripe.ts": "a Hook kind, which jr2.config.ts imports",
  "shared/alerts/hooks/sentry.ts": "a Hook kind, which jr2.config.ts imports",
};

/** What a page tells the reader to add to the Instance in its text. The key is the page's folder of
 * examples, and the entry is for each provider tab below it too. */
const ALSO: Record<
  string,
  { why: string; secrets?: string[]; workflows?: string[]; packages?: Record<string, string> }
> = {
  "concepts/effects": {
    why: "concepts/effects.md: the jira Effect secret must be in the secrets list",
    secrets: ["jira"],
  },
  "concepts/workspaces": {
    why: "concepts/workspaces.md: the Effect upload names the Effect secret files",
    secrets: ["files"],
  },
  "guides/start-a-run-from-a-run": {
    why: "guides/start-a-run-from-a-run.md: the Instance must also have workflows/triage.ts",
    workflows: ["get-started/a-model-decides/anthropic/triage.ts"],
  },
  "guides/publish-a-machine-as-an-npm-package": {
    why: "guides/publish-a-machine-as-an-npm-package.md: the Instance installs the package @you/labeler",
    packages: { "@you/labeler": "guides/publish-a-machine-as-an-npm-package/labeler/src/index.ts" },
  },
};

/** The folders whose Workflows `jr2 up` must refuse, each with the page that shows the refusal. */
const REFUSED: Record<string, string> = {
  "guides/bind-open-parts/unbound": "guides/bind-open-parts.md",
};

/** Each placeholder in the examples, and a value that a reader can give it. */
const PLACEHOLDERS: Record<string, string> = { "<you>": "you" };

const alsoOf = (folder: string) => ALSO[folder] ?? ALSO[dirname(folder)];

// Fill in the placeholders when an example loads, and resolve each package in ALSO to its source.
const packages = new Map(
  Object.values(ALSO)
    .flatMap((a) => Object.entries(a.packages ?? {}))
    .map(([name, file]) => [name, pathToFileURL(join(EXAMPLES, file)).href]),
);
const EXAMPLES_URL = pathToFileURL(EXAMPLES).href;
registerHooks({
  resolve(specifier, context, next) {
    const url = packages.get(specifier);
    return url ? { url, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    const loaded = next(url, context);
    if (!url.startsWith(EXAMPLES_URL) || loaded.source === undefined) return loaded;
    let source = String(loaded.source);
    for (const [from, to] of Object.entries(PLACEHOLDERS)) source = source.replaceAll(from, to);
    return { ...loaded, source };
  },
});

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path)));
    else out.push(path);
  }
  return out;
}

const files = (await filesUnder(EXAMPLES)).map((f) => relative(EXAMPLES, f)).sort();
const sources = new Map(
  await Promise.all(
    files.filter((f) => f.endsWith(".ts")).map(async (f) => [f, await readFile(join(EXAMPLES, f), "utf8")] as const),
  ),
);
const workflows = [...sources].filter(([, text]) => /^export const machine\b/m.test(text)).map(([f]) => f);
const folders = [...new Set(workflows.map(dirname))];

// Each page and the example files that it shows with `<<< @/examples/…`.
const pages = await Promise.all(
  allPages(await readSitemap())
    .filter((p) => p.source === "page")
    .map(async (p) => {
      const text = await readFile(join(SITE, `${p.slug}.md`), "utf8");
      const shown = [...text.matchAll(/^<<< @\/examples\/([^#{\s]+)/gm)].map((m) => m[1]!);
      return { file: `${p.slug}.md`, text, shown };
    }),
);

/** The config of an Instance that holds the Workflows `mine` of `folder`. */
async function configOf(folder: string, mine: string[]): Promise<JR2Config> {
  const shown = [
    ...new Set(
      pages
        .filter((p) => p.shown.some((s) => mine.includes(s)))
        .flatMap((p) => p.shown.filter((s) => basename(s) === "jr2.config.ts")),
    ),
  ];
  // Two different configs is a pairing that the test cannot make: give the Workflows two folders.
  assert.ok(shown.length <= 1, `the pages show more than one config: ${shown.join(", ")}`);
  const tab = basename(folder);
  const file = shown[0] ?? (tab === "anthropic" || tab === "local" ? `shared/${tab}/jr2.config.ts` : undefined);
  const config = file ? ((await loadConfig(join(EXAMPLES, dirname(file)))) ?? {}) : {};
  const secrets = alsoOf(folder)?.secrets ?? [];
  if (!secrets.length) return config;
  return { ...config, secrets: [...(config.secrets ?? []), ...secrets.map((name) => ({ name, value: undefined }))] };
}

test("each .ts file in examples/ is a Workflow, a jr2.config.ts, or in NOT_WORKFLOWS", () => {
  const strays = [...sources.keys()].filter(
    (f) => !workflows.includes(f) && basename(f) !== "jr2.config.ts" && !(f in NOT_WORKFLOWS),
  );
  assert.deepEqual(strays, []);
  for (const f of Object.keys(NOT_WORKFLOWS)) {
    assert.ok(sources.has(f) && !workflows.includes(f), `${f} is in NOT_WORKFLOWS, but it is a Workflow or no file`);
  }
  for (const key of Object.keys(ALSO))
    assert.ok(
      folders.some((f) => f === key || dirname(f) === key),
      key,
    );
  for (const key of Object.keys(REFUSED)) assert.ok(folders.includes(key), key);
  assert.ok(workflows.length > 30, `only ${workflows.length} Workflows`);
});

for (const folder of folders) {
  const page = REFUSED[folder];
  const name =
    page === undefined
      ? `the Workflows in examples/${folder}/ pass the Instance check of jr2 up`
      : `jr2 up refuses the Workflows in examples/${folder}/ with the lines that ${page} shows`;
  test(name, async () => {
    const mine = workflows.filter((f) => dirname(f) === folder);
    const config = await configOf(folder, mine);
    const root = await mkdtemp(join(tmpdir(), "jr2-instance-check-"));
    try {
      await mkdir(join(root, "workflows"));
      // A link loads the real file, so its relative imports and `import.meta.resolve` work as in
      // the example folder.
      for (const f of [...mine, ...(alsoOf(folder)?.workflows ?? [])]) {
        await symlink(join(EXAMPLES, f), join(root, "workflows", basename(f)));
      }
      const charts = files.filter(
        (c) => c.endsWith(".chart.json") && (dirname(c) === folder || dirname(c) === dirname(folder)),
      );
      for (const f of charts.length ? mine : []) {
        const wrapper = join(root, "workflows", basename(f, ".ts"));
        await mkdir(wrapper);
        for (const c of charts) await symlink(join(EXAMPLES, c), join(wrapper, basename(c)));
      }

      const lines: string[] = [];
      let passed = false;
      try {
        const io = {
          stdout: () => {},
          stderr: (s: string) => void lines.push(...s.trimEnd().split("\n")),
          env: {},
          cwd: root,
          typecheck: async () => ({ ok: true, output: "" }),
        };
        passed = (await checkInstance(io, root, config)) !== undefined;
      } catch (err) {
        // A refusal when a module loads, or in the walk, throws. The CLI prints it as `error:`.
        lines.push(`error: ${(err as Error).message}`);
      }
      const problems = lines.filter((l) => /^(refusing|error|warning): /.test(l));

      if (page === undefined) {
        assert.ok(passed && !problems.length, `jr2 up refuses or warns:\n${problems.join("\n")}`);
        return;
      }
      assert.ok(!passed, `the check passes, but ${page} shows a refusal`);
      const text = pages.find((p) => p.file === page)?.text ?? "";
      for (const line of problems) assert.ok(text.includes(line), `${page} does not show: ${line}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
