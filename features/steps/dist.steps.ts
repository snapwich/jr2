// Steps for the @dist tier (ADR-0043/0044): the kit as a user installs it. Three of them are the
// user's whole path — `jr2 init`, their own package manager, `jr2 up` — and that shape is the claim.
// The fourth reaches into the cluster with `kubectl`, for the one thing the path cannot show from
// outside: that the Kit images came off a registry by PULL (ADR-0044). Nothing here reaches past
// what a user's own shell could see (ADR-0010).
//
// Everything after `jr2 up` is already covered by the run-control steps (`I run … with message …`,
// `stdout is the terminal status with reply …`), and they work here unchanged because the World
// decides WHICH binary `runCli` spawns. That reuse is the point: the assertions are the same
// claims the other tiers make, and only the delivery of the kit differs.

import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  IMAGES_CONFIGMAP,
  IMAGES_KEY,
  INSTANCE_SECRET,
  ORCHESTRATOR_PORT,
  ORCHESTRATOR_SERVICE,
} from "@jr2/orchestrator/internal";
import { E2EWorld } from "./world.ts";

const exec = promisify(execFile);

/** 64 MB: a package manager resolving a whole dependency tree out loud. */
const BIG = 64 * 1024 * 1024;

// Lifecycle lives in hooks.ts with every other tier's: the suite-wide published kit, and a per
// -scenario namespace + temp folder the World's `cleanup` already deletes.

// --- given ---------------------------------------------------------------------------------------

/**
 * `jr2 init` in a temp folder, run by the INSTALLED binary. The assertions before it are the
 * scenario's real preconditions, not paranoia: an instance inside a pnpm workspace bundles with
 * `pnpm deploy` and an instance inside a git repo is a different scaffold story, so a stray
 * `TMPDIR` under a checkout would silently test the mode every other tier already tests.
 */
Given("a standalone instance scaffolded by the installed jr2", async function (this: E2EWorld): Promise<void> {
  for (const marker of ["pnpm-workspace.yaml", ".git", "package.json"]) {
    const found = await findAbove(this.dir, marker);
    assert.equal(found, undefined, `the @dist instance must stand alone — found ${marker} above it at ${found}`);
  }
  const r = await this.runCli(["init"], { namespaced: false });
  assert.equal(r.code, 0, `jr2 init failed: ${r.stderr}`);

  // The one edit a self-hosting user makes to the scaffold (ADR-0044): this cluster pulls its Kit
  // images from a mirror, not from the canonical home. It rides `.env` + `process.env` rather than
  // a literal because it is deployment-varying — which also means the instance's config file is
  // byte-identical to what any other self-hoster writes, and the fixture's address stays out of it.
  const kitRegistry = this.dist?.kitRegistry;
  assert.ok(kitRegistry, "a @dist scenario has its installed kit");
  await writeFile(join(this.dir, ".env"), `JR2_KIT_REGISTRY=${kitRegistry}\n`);
  await writeFile(join(this.dir, "jr2.config.ts"), KIT_REGISTRY_CONFIG_TS);
});

/**
 * The scaffold's own `jr2.config.ts` plus the mirror key — written whole rather than patched, so the
 * step never depends on the template's exact bytes (`jr2 init` owns those, and `init.test.ts` guards
 * them). No `git` block: these scenarios run `ping`, which touches no Workspace at all.
 *
 * `.env` reaches the CLI and stops there. It is one of the credential files a bundle stage drops
 * (ADR-0043), so nothing about the mirror rides the Assembly — and nothing needs to be:
 * `kitRegistry` is answered at converge time, when the pod spec's image refs are composed.
 *
 * The import names `@jr2/orchestrator` by BARE specifier, so this tier is where it meets a
 * genuinely npm-installed kit — both when Node type-strips this file and when `jr2 up`'s gate
 * compiles the folder.
 */
const KIT_REGISTRY_CONFIG_TS = `import { defineConfig } from "@jr2/orchestrator";

export default defineConfig({ kitRegistry: process.env.JR2_KIT_REGISTRY });
`;

// --- when ----------------------------------------------------------------------------------------

/**
 * The user's own install, with their own package manager. The `.npmrc` is written first and is
 * REALISTIC, not a test fixture: it is what anyone resolving a scoped package from a private
 * registry already has. It reaches this install only — the staged bundle drops `.npmrc` with the
 * rest of the credential files (ADR-0043), so the frozen install `jr2 up` runs inside it takes the
 * registry off the environment instead (see `setupDist`).
 *
 * The one thing the manager gets that a user's shell would not: a cache of the fixture's, because
 * the user's own remembers a registry that was wiped since (`InstalledKit.cacheDir`).
 */
When("I install its dependencies with {string}", async function (this: E2EWorld, pm: string): Promise<void> {
  const registry = this.dist?.registry;
  const cacheDir = this.dist?.cacheDir;
  assert.ok(registry && cacheDir, "a @dist scenario has its installed kit");
  const cacheSetting = CACHE_SETTING[pm];
  assert.ok(cacheSetting, `no cache setting is known for "${pm}" — this tier drives npm and pnpm`);
  await writeFile(join(this.dir, ".npmrc"), `registry=${registry}\n`);
  // The resolution failure is the likeliest one in this tier, so its own words are carried out.
  const env = { ...shellEnv(), [cacheSetting]: cacheDir };
  await exec(pm, ["install"], { cwd: this.dir, env, maxBuffer: BIG }).catch((err: Error & { stderr?: string }) => {
    throw new Error(`${pm} install failed in ${this.dir}: ${err.stderr || err.message}`);
  });
  // The lockfile is part of the instance contract (ADR-0043): it, not the node_modules this just
  // wrote, is what the image bundle installs from — so a manager that wrote none has already
  // broken the converge, three minutes before `jr2 up` would say so.
  const lockfile = pm === "npm" ? "package-lock.json" : "pnpm-lock.yaml";
  await stat(join(this.dir, lockfile)).catch(() => {
    throw new Error(`${pm} install left no ${lockfile} — the bundle installs from the lockfile (ADR-0043)`);
  });
});

/**
 * Each manager's name for its cache, as the environment spells it. Keyed by manager because the
 * two names differ and each warns about the other's as unknown config — and it goes through the
 * environment, never through the `.npmrc` above, which stays what a user writes.
 */
const CACHE_SETTING: Record<string, string> = { npm: "npm_config_cache", pnpm: "npm_config_cache_dir" };

// The converge, in installed mode: no kit sources resolve, so the Harness, the operator and the
// Orchestrator come from the published `<kitRegistry>/jr2-<x>:<kitversion>` tags the suite fixture
// PUSHED, pulled by the nodes themselves (ADR-0038/0044/0069). Nothing is built: the Instance's
// Workflows are staged from the lockfile above as an Assembly and published to the running
// Orchestrator through `PUT /assembly` (ADR-0069) — the strip of the Kit closure, the Kit version
// check at the door and the atomic publish all execute here, against the installed kit.
When("I converge it onto the cluster", { timeout: 900_000 }, async function (this: E2EWorld): Promise<void> {
  const r = await this.runCli(["up", "--yes"]);
  assert.equal(r.code, 0, `jr2 up failed: ${r.stderr}`);
  assert.match(
    r.stderr,
    /images: installed kit — the published v\S+ Harness, operator and Orchestrator/,
    "the installed CLI took installed mode, not checkout mode",
  );
  const staged = /assembly: ([0-9a-f]{12}) \(kit v/.exec(r.stderr)?.[1];
  assert.ok(staged, `jr2 up staged an Assembly:\n${r.stderr}`);
  assert.match(
    r.stderr,
    new RegExp(`assembly: ${staged} is current — workflows: .*\\bping\\b`),
    "a fresh namespace has no current Assembly, so the converge published one, and it registers ping",
  );
  this.assemblyHash = staged;
});

/**
 * The door's Kit version refusal (ADR-0069), against the Orchestrator the installed kit deployed.
 * The publish token is read the way `jr2 up` reads it, through the kube API; the PUT names another
 * Kit version, so the door answers 409 before it reads the body, names both numbers, and the
 * Assembly the converge published stays current.
 */
Then(
  "the Orchestrator refuses a publish at another Kit version, naming both numbers",
  { timeout: 60_000 },
  async function (this: E2EWorld): Promise<void> {
    assert.ok(this.assemblyHash, "a converge published an Assembly first");
    const token = Buffer.from(
      await kubectlOut([
        "--namespace",
        this.namespace!,
        "get",
        "secret",
        INSTANCE_SECRET,
        "-o",
        "jsonpath={.data.JR2_PUBLISH_TOKEN}",
      ]),
      "base64",
    ).toString("utf8");
    assert.ok(token, "the Instance Secret holds the publish token");
    await withServiceForward(this.namespace!, async (base) => {
      const before = (await (await fetch(`${base}/assembly`)).json()) as { kitVersion: string };
      const other = "0.0.0-not-this-kit";
      const res = await fetch(`${base}/assembly`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-tar",
          "jr2-kit-version": other,
          "jr2-assembly-hash": "000000000000",
        },
        body: new Uint8Array(0),
      });
      assert.equal(res.status, 409);
      const body = (await res.json()) as { error?: string };
      assert.match(body.error ?? "", new RegExp(`${other.replace(/\./g, "\\.")}[\\s\\S]*${before.kitVersion}`));
      const after = (await (await fetch(`${base}/assembly`)).json()) as { current?: { hash?: string } | null };
      assert.equal(after.current?.hash, this.assemblyHash, "the published Assembly is still current");
    });
  },
);

/**
 * The strip of the Kit closure (ADR-0069), seen on the Orchestrator's own volume: the published
 * Assembly holds no copy of a package the Kit image ships, so each resolves from the image. `ping`
 * uses no Menu, so a second copy of xstate would not show in its reply; this reads the tree.
 */
Then(
  "the published Assembly carries no copy of a Kit package",
  { timeout: 60_000 },
  async function (this: E2EWorld): Promise<void> {
    assert.ok(this.assemblyHash, "a converge published an Assembly first");
    const modules = `/instance/.jr2/assemblies/${this.assemblyHash}/node_modules`;
    const kit = ["@jr2/orchestrator", "@jr2/agent-protocol", "xstate", "zod", "hono"];
    const found = await kubectlOut([
      "--namespace",
      this.namespace!,
      "exec",
      `deployment/${ORCHESTRATOR_SERVICE}`,
      "--",
      "node",
      "-e",
      `const fs=require("fs");console.log(JSON.stringify(${JSON.stringify(kit)}.filter(n=>fs.existsSync(${JSON.stringify(modules)}+"/"+n))))`,
    ]);
    assert.deepEqual(JSON.parse(found), [], `the Assembly carries Kit packages under ${modules}`);
  },
);

/** Port-forward the Orchestrator Service, as `jr2 up` reaches its door, for one callback. */
async function withServiceForward(namespace: string, fn: (base: string) => Promise<void>): Promise<void> {
  const child = spawn("kubectl", [
    "--namespace",
    namespace,
    "port-forward",
    `service/${ORCHESTRATOR_SERVICE}`,
    `:${ORCHESTRATOR_PORT}`,
  ]);
  try {
    const port = await new Promise<string>((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        const m = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(out);
        if (m) resolve(m[1]!);
      });
      child.on("close", (code) => reject(new Error(`port-forward service/${ORCHESTRATOR_SERVICE} exited (${code})`)));
    });
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
  }
}

/**
 * `jr2 version --json` from the installed global, inside the Instance it just converged. Three
 * claims in one report (ADR-0009/0056 as amended): `cli` is the Instance's OWN copy (its path is
 * under the Instance), `global` is the copy on PATH that handed off (its path is under the
 * throwaway prefix), and the deployed orchestrator answers the same number — so `skew` is `same`.
 */
When(
  "jr2 version names the Instance's own jr2, the global that handed off, and the deployed orchestrator",
  { timeout: 120_000 },
  async function (this: E2EWorld): Promise<void> {
    assert.ok(this.dist, "a @dist scenario has its installed kit");
    const r = await this.runCli(["version", "--json"]);
    assert.equal(r.code, 0, `jr2 version failed: ${r.stderr}`);
    const report = this.resultJson<{
      cli: { version: string; path: string };
      global?: { version: string; path: string };
      kit?: { version?: string; check: string };
      instance?: { mode: string };
      deployed?: { orchestrator?: { version?: string; hash?: string; error?: string } };
      skew: string;
    }>();
    // Real paths on both sides: the report resolves symlinks (ADR-0056 compares real paths), and
    // macOS's `tmpdir()` is itself a symlink (`/var` → `/private/var`).
    const instanceRoot = await realpath(this.dir);
    const prefix = await realpath(dirname(dirname(this.dist.binDir)));
    assert.ok(
      report.cli.path.startsWith(instanceRoot),
      `the copy that ran is the Instance's own under ${instanceRoot}, not ${report.cli.path}`,
    );
    assert.ok(report.global, "the global on PATH said it handed off");
    assert.ok(
      report.global.path.startsWith(prefix),
      `the global is the one in the throwaway prefix ${prefix}, not ${report.global.path}`,
    );
    assert.equal(report.global.version, report.cli.version, "published from one verdaccio: one number");
    assert.equal(report.kit?.check, "ok", "the Instance's orchestrator is the copy its CLI runs against");
    assert.equal(report.instance?.mode, "installed");
    assert.equal(
      report.deployed?.orchestrator?.version,
      report.cli.version,
      report.deployed?.orchestrator?.error ?? "the deployed orchestrator answers the CLI's number",
    );
    // `/healthz.hash` is the current Assembly's (ADR-0069): the one this converge published.
    assert.equal(
      report.deployed?.orchestrator?.hash,
      this.assemblyHash,
      "the Orchestrator serves the published Assembly",
    );
    assert.equal(report.skew, "same");
  },
);

/** `jr2 down --yes`, from the installed binary: removes the instance's namespace and sweeps the
 * images its roots no longer protect (ADR-0019/0039). `--yes` because the verb always confirms,
 * and there is no one at the prompt. */
When("I take the instance down", { timeout: 300_000 }, async function (this: E2EWorld): Promise<void> {
  const r = await this.runCli(["down", "--yes"]);
  assert.equal(r.code, 0, `jr2 down failed: ${r.stderr}`);
  assert.match(r.stderr, /removed/, "down reports the instance removed");
});

// --- then ----------------------------------------------------------------------------------------

/** The namespace IS the instance (ADR-0019): gone means removed. `jr2 down` waits on the delete, so
 * this asks once and expects kubectl's NotFound — spelled the way a user would check. */
Then("the instance's namespace is gone", async function (this: E2EWorld): Promise<void> {
  assert.ok(this.namespace, "a @dist scenario has its namespace set in setupDist");
  const left = await kubectlOut(["get", "namespace", this.namespace, "--ignore-not-found", "-o", "name"]);
  assert.equal(left.trim(), "", `namespace ${this.namespace} still exists after jr2 down`);
});

/**
 * The claim ADR-0044 adds to this tier: the Kit images this cluster runs came out of a REGISTRY.
 *
 * Two halves, because one of them alone would prove less than it looks. The refs say the CLI
 * re-homed the published tags onto `kitRegistry` (the Harness and the Custodian have no pod in a
 * `ping` scenario — the instance's own image map is where they are nameable at all); the RUNNING
 * operator and Orchestrator pods say a node resolved that address, pulled the bytes and unpacked
 * them, which is the exact leg `kind load` at the published names used to skip. The Orchestrator
 * is a Kit image since ADR-0069, so an installed kit pulls it like the others.
 *
 * Spelled the way a user's `kubectl` would (ADR-0010), namespace and selector included — they are
 * `OPERATOR_NAMESPACE`/`OPERATOR_SELECTOR` in packages/cli/src/deploy.ts, and a black-box step is
 * not entitled to import them from the kit it is testing at arm's length.
 */
Then("the cluster pulled its Kit images from the local registry", async function (this: E2EWorld): Promise<void> {
  const kitRegistry = this.dist?.kitRegistry;
  assert.ok(kitRegistry, "a @dist scenario has its installed kit");
  assert.ok(this.namespace, "a @dist scenario has its namespace set in setupDist");

  const map = await kubectlOut(["--namespace", this.namespace, "get", "configmap", IMAGES_CONFIGMAP, "-o", "json"]);
  const raw = (JSON.parse(map) as { data?: Record<string, string> }).data?.[IMAGES_KEY];
  assert.ok(raw, `the ${IMAGES_CONFIGMAP} ConfigMap carries ${IMAGES_KEY} (ADR-0038)`);
  const refs = JSON.parse(raw) as { harness?: string; custodian?: string };
  assert.ok(
    refs.harness?.startsWith(`${kitRegistry}/jr2-harness:`),
    `the harness ref is ${refs.harness} — an installed kit pointed at a mirror deploys ${kitRegistry}/jr2-harness:<ver>`,
  );
  // The Custodian's pinned Envoy is re-homed the same way (ADR-0044, ADR-0059): the tag and the
  // digest it was pinned by, under the mirror — which `jr2 kit push` fills and `just kit-push` does
  // not (it builds, and jr2 builds no Envoy). No pod pulls it in a `ping` scenario.
  assert.match(
    refs.custodian ?? "",
    new RegExp(`^${kitRegistry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/envoy:[^@]+@sha256:[0-9a-f]{64}$`),
    `the custodian ref is ${refs.custodian} — a mirror re-homes it as ${kitRegistry}/envoy:<tag>@<digest>`,
  );

  await pulledFromRegistry(kitRegistry, {
    what: "operator",
    namespace: "jr2-system",
    deployment: "jr2-controller-manager",
    selector: "control-plane=controller-manager",
    repo: "jr2-operator",
  });
  await pulledFromRegistry(kitRegistry, {
    what: "Orchestrator",
    namespace: this.namespace,
    deployment: "jr2-orchestrator",
    selector: "app=jr2-orchestrator",
    repo: "jr2-orchestrator",
  });
});

/**
 * One Kit image's pull, proved on its Deployment and a pod. The declared image first: a pod could
 * otherwise be a survivor of some earlier converge, and "something running out of the mirror" is
 * not the claim. Then a pod actually RUNNING it. `Running` is the whole assertion: the kubelet
 * reaches that phase only after containerd resolved `localhost:<port>/…` through the node's
 * hosts.toml, pulled the manifest and unpacked the layers. A rollout leaves the previous pod
 * terminating, so this asks whether ANY running pod carries the declared ref rather than that
 * every one does.
 */
async function pulledFromRegistry(
  kitRegistry: string,
  opts: { what: string; namespace: string; deployment: string; selector: string; repo: string },
): Promise<void> {
  const declared = (
    await kubectlOut([
      "--namespace",
      opts.namespace,
      "get",
      "deployment",
      opts.deployment,
      "-o",
      "jsonpath={.spec.template.spec.containers[0].image}",
    ])
  ).trim();
  assert.ok(
    declared.startsWith(`${kitRegistry}/${opts.repo}:`),
    `the ${opts.what} Deployment declares ${declared}, not a ${kitRegistry} ref`,
  );
  const pods = await kubectlOut([
    "--namespace",
    opts.namespace,
    "get",
    "pods",
    "-l",
    opts.selector,
    "-o",
    `jsonpath={range .items[*]}{.status.phase}{"\\t"}{.spec.containers[*].image}{"\\n"}{end}`,
  ]);
  const running = pods
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([phase]) => phase === "Running")
    .map(([, image]) => image ?? "");
  assert.ok(
    running.includes(declared),
    `no ${opts.what} pod is running ${declared} — the node never pulled it. Pods:\n${pods}`,
  );
}

/**
 * ADR-0072's first half, asked of the registry rather than of an install: the `@jr2/orchestrator`
 * tarball the fixture PUBLISHED holds the docs bundle `prepack` assembled. `npm pack <spec>` fetches
 * the published tarball, the way anyone can; the version is the one the Instance installed, so the
 * tarball is the one under test and not a `latest` that a stale registry could answer. The `\\/` in
 * the expression is a `/`: a bare one is an alternation.
 */
Then("the published @jr2\\/orchestrator tarball holds the docs bundle", async function (this: E2EWorld): Promise<void> {
  const registry = this.dist?.registry;
  const cacheDir = this.dist?.cacheDir;
  assert.ok(registry && cacheDir, "a @dist scenario has its installed kit");
  const installed = join(this.dir, "node_modules", "@jr2", "orchestrator", "package.json");
  const { version } = JSON.parse(await readFile(installed, "utf8")) as { version: string };
  // Outside the Instance folder: `jr2 up` bundles that folder, and a tarball in it would ride along.
  const out = await mkdtemp(join(tmpdir(), "jr2-dist-pack-"));
  try {
    const env = { ...shellEnv(), npm_config_cache: cacheDir };
    const { stdout } = await exec(
      "npm",
      ["pack", `@jr2/orchestrator@${version}`, "--registry", registry, "--pack-destination", out, "--json"],
      { cwd: out, env, maxBuffer: BIG },
    );
    const [packed] = JSON.parse(stdout) as { filename: string }[];
    assert.ok(packed, `npm pack fetched no tarball of @jr2/orchestrator@${version}`);
    const { stdout: list } = await exec("tar", ["-tzf", join(out, packed.filename)], { maxBuffer: BIG });
    const entries = new Set(list.split("\n"));
    for (const file of [
      "index.md",
      "reference/authoring-surface.md",
      "reference/authoring-surface/workspace.md",
      "agents-block.md",
      "llms.txt",
    ])
      assert.ok(
        entries.has(`package/docs/${file}`),
        `the published @jr2/orchestrator@${version} packs no docs/${file} (ADR-0072)`,
      );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

/**
 * ADR-0072's second half, from the one tier that packs the kit: the `AGENTS.md` in the Instance
 * holds exactly the installed bundle's block between the markers. Asked after the install, it is
 * the block the installed `jr2 init` wrote, so an Assistant in a fresh folder reads the index
 * before the first `jr2 up`; asked after the converge, it is the block `jr2 up` keeps. Every file
 * the index names is in the bundle, so the index leads nowhere that is not packed.
 *
 * The block init wrote came from the GLOBAL CLI's own peer; the one compared is the Instance's
 * install. They are equal because both are this run's one published version.
 */
Then(
  "the Instance's AGENTS.md indexes the installed Kit's docs bundle",
  async function (this: E2EWorld): Promise<void> {
    const bundle = join(this.dir, "node_modules", "@jr2", "orchestrator", "docs");
    const block = await readFile(join(bundle, "agents-block.md"), "utf8").catch(() =>
      assert.fail(`the installed @jr2/orchestrator packs no docs/agents-block.md under ${bundle} (ADR-0072)`),
    );
    const agents = await readFile(join(this.dir, "AGENTS.md"), "utf8");
    // The marker lines as a user's own AGENTS.md shows them.
    const begin = "<!-- BEGIN:jr2-docs -->\n";
    const end = "<!-- END:jr2-docs -->\n";
    const from = agents.indexOf(begin);
    const to = agents.indexOf(end);
    assert.ok(from >= 0 && to > from, `AGENTS.md holds the jr2-docs markers:\n${agents}`);
    assert.equal(
      agents.slice(from + begin.length, to),
      block,
      "AGENTS.md holds the bundle's block between its markers",
    );

    const index = block.split("\n").find((l) => l.startsWith("[jr2 docs index]"));
    assert.ok(index, `the block holds the docs index:\n${block}`);
    const entries = [...index.matchAll(/\|([\w./-]+):\{([^}]*)\}/g)];
    assert.ok(entries.length > 0, `the index names no file:\n${index}`);
    for (const [, dir, files] of entries) {
      // A folder entry (`reference/decisions`, `reference/authoring-surface`) is one line for the
      // whole folder, not a file list: the folder and the contents page it names are packed.
      if (files!.endsWith(" lists them")) {
        const contents = /; (\S+) lists them$/.exec(files!)?.[1];
        assert.ok(contents, `the folder entry ${dir} names its contents page:\n${index}`);
        await stat(join(bundle, contents)).catch(() =>
          assert.fail(`the index names ${contents}, and the packed bundle has no such file`),
        );
        const packed = await readdir(join(bundle, dir!)).catch(() => []);
        assert.ok(packed.length > 0, `the index names the folder ${dir}, and the packed bundle has no file in it`);
        continue;
      }
      for (const file of files!.split(",")) {
        await stat(join(bundle, dir!, file)).catch(() =>
          assert.fail(`the index names ${dir}/${file}, and the packed bundle has no such file`),
        );
      }
    }
  },
);

/** kubectl, verbatim, for the claims that reach past the instance's own namespace. */
async function kubectlOut(args: string[]): Promise<string> {
  const { stdout } = await exec("kubectl", args, { maxBuffer: BIG });
  return stdout;
}

/**
 * The environment a USER's shell has. This suite is launched by `pnpm --filter`, and pnpm exports
 * its whole configuration as `npm_config_*` — `registry` included — to everything it spawns. Env
 * config OUTRANKS a project `.npmrc` in both managers, so an inherited environment would resolve
 * `@jr2/*` from npmjs and fail the tier on a leak from its own runner rather than on the kit.
 */
function shellEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("npm_")));
}

/** The nearest ancestor of `dir` (inclusive) holding `marker`, or undefined. */
async function findAbove(dir: string, marker: string): Promise<string | undefined> {
  for (let at = dir; ; at = dirname(at)) {
    try {
      await stat(join(at, marker));
      return at;
    } catch {
      // absent here — keep walking
    }
    if (dirname(at) === at) return undefined;
  }
}
