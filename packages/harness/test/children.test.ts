// The Harness's children (ADR-0076, ADR-0077): the Stand-ins read from their files, a child's explicit
// env, the refusals of a policy that would hand a child a secret, and the Landlock probe's refusal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertHarnessHome,
  childEnv,
  childPolicy,
  grantedOf,
  HARNESS_HOME,
  lookPath,
  probeLandlock,
  readControlStandIn,
  readStandIns,
  RUNTIME_SECRETS,
  runIn,
  useOutputDir,
} from "../src/children.ts";
import { deniedDir, testChildren, testConfiner } from "./support/children.ts";

test("readStandIns: one file a held secret, one trailing newline off; a projected volume's own entries are skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-standins-"));
  mkdirSync(join(dir, "..2026_11_01_00_00_00.0"));
  symlinkSync("..2026_11_01_00_00_00.0", join(dir, "..data"));
  writeFileSync(join(dir, "ANTHROPIC_API_KEY"), "jr2-held-ANTHROPIC_API_KEY.c2lnbmVk\n");
  writeFileSync(join(dir, "JIRA_TOKEN"), "jr2-held-JIRA_TOKEN.b3RoZXI");
  assert.deepEqual([...readStandIns(dir)].sort(), [
    ["ANTHROPIC_API_KEY", "jr2-held-ANTHROPIC_API_KEY.c2lnbmVk"],
    ["JIRA_TOKEN", "jr2-held-JIRA_TOKEN.b3RoZXI"],
  ]);
  assert.deepEqual([...readStandIns(join(dir, "absent"))], [], "a pod with no held secret has no folder");
});

test("readControlStandIn: the file's value; no file, or an empty one, is a start that cannot serve (ADR-0076)", () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-control-"));
  writeFileSync(join(dir, "standin"), "Y29udHJvbC1zdGFuZC1pbg\n");
  assert.equal(readControlStandIn(join(dir, "standin")), "Y29udHJvbC1zdGFuZC1pbg");
  assert.throws(
    () => readControlStandIn(join(dir, "absent")),
    /no control Stand-in at .*ENOENT.*cannot serve \(ADR-0076\)/,
  );
  writeFileSync(join(dir, "empty"), "\n");
  assert.throws(() => readControlStandIn(join(dir, "empty")), /is empty/);
});

test("childEnv: the container's start env, HOME, TMPDIR and the granted Stand-ins — no JR2_* but the Custodian's address, never the control Stand-in, never an ungranted one", () => {
  const env = childEnv(
    {
      PATH: "/usr/bin:/bin",
      HTTPS_PROXY: "http://127.0.0.1:15001",
      NODE_EXTRA_CA_CERTS: "/etc/jr2/ca/extra.crt",
      GIT_CONFIG_SYSTEM: "/opt/jr2/etc/gitconfig",
      JR2_CUSTODIAN_URL: "http://127.0.0.1:8081",
      JR2_HARNESS_TOKEN_SHA256: "digest",
      JR2_HARNESS_JSON: "{}",
      JR2_GRANTED_SECRETS: "JIRA_TOKEN,SNEAKY",
      // An image's ENV and the author's `harness.env` reach the domain (ADR-0076).
      SOME_IMAGE_VAR: "x",
      VIRTUAL_ENV: "/app/.venv",
      // A held secret's Stand-in in the start env that no grant names is withheld, by its value.
      ANTHROPIC_API_KEY: "jr2-held-ANTHROPIC_API_KEY.model",
      OTHER_NAME: "the-control",
      HOME: "/start-home",
      TMPDIR: "/start-tmp",
    },
    new Map([
      ["ANTHROPIC_API_KEY", "jr2-held-ANTHROPIC_API_KEY.model"],
      ["JIRA_TOKEN", "jr2-held-JIRA_TOKEN.granted"],
      ["SNEAKY", "the-control"],
    ]),
    ["JIRA_TOKEN", "SNEAKY"],
    "the-control",
    { home: "/home/jr2", tmp: "/tmp" },
  );
  assert.deepEqual(env, {
    PATH: "/usr/bin:/bin",
    HTTPS_PROXY: "http://127.0.0.1:15001",
    NODE_EXTRA_CA_CERTS: "/etc/jr2/ca/extra.crt",
    GIT_CONFIG_SYSTEM: "/opt/jr2/etc/gitconfig",
    JR2_CUSTODIAN_URL: "http://127.0.0.1:8081",
    SOME_IMAGE_VAR: "x",
    VIRTUAL_ENV: "/app/.venv",
    HOME: "/home/jr2",
    TMPDIR: "/tmp",
    JIRA_TOKEN: "jr2-held-JIRA_TOKEN.granted",
  });
  assert.throws(
    () => childEnv({}, new Map(), ["JIRA_TOKEN"], undefined, { home: "/h", tmp: "/t" }),
    /grants JIRA_TOKEN, and the pod holds no Stand-in for it/,
  );
  assert.deepEqual(grantedOf(" JIRA_TOKEN, ,GH_TOKEN "), ["JIRA_TOKEN", "GH_TOKEN"]);
  assert.deepEqual(grantedOf(undefined), []);
});

test("childPolicy refuses a HOME or a TMPDIR in what the domain may not reach", () => {
  const root = mkdtempSync(join(tmpdir(), "jr2-policy-"));
  const secret = join(root, "run-jr2");
  mkdirSync(join(secret, "home"), { recursive: true });
  assert.throws(
    () =>
      childPolicy({
        env: { PATH: "/usr/bin", HOME: join(secret, "home"), TMPDIR: root },
        confiner: testConfiner(),
        standIns: new Map(),
        control: undefined,
        deny: [secret],
      }),
    /HOME is .*run-jr2\/home, which is in .*run-jr2: no process of the domain reaches/,
  );
  assert.throws(
    () =>
      childPolicy({
        env: { PATH: "/usr/bin", HOME: root, TMPDIR: secret },
        confiner: testConfiner(),
        standIns: new Map(),
        control: undefined,
        deny: [secret],
      }),
    /TMPDIR is .*run-jr2, which is in/,
  );
});

// ADR-0076: pi's bash writes a long command's whole output in this process's TMPDIR, and opens it
// by its path again. So the Harness's TMPDIR is its own output folder, which the domain reads and
// does not write, and the domain keeps the TMPDIR of the start env, whatever the image sets.
test("useOutputDir: the Harness's TMPDIR is its output folder, and the domain keeps the start env's TMPDIR", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jr2-output-dir-")));
  const output = join(root, "output");
  mkdirSync(output);
  const env: NodeJS.ProcessEnv = { TMPDIR: "/tmp" };
  useOutputDir(output, env);
  assert.equal(env.TMPDIR, output);
  const link = join(root, "link");
  symlinkSync(output, link);
  assert.throws(() => useOutputDir(link, {}), /output folder .*link is not a folder: mount a folder/);
  assert.throws(() => useOutputDir(join(root, "missing"), {}), /output folder .*missing is not there/);
  writeFileSync(join(root, "file"), "");
  assert.throws(() => useOutputDir(join(root, "file"), {}), /is not a folder/);
  const imageTmp = mkdtempSync(join(tmpdir(), "jr2-image-tmp-"));
  const domain = testChildren({ tmp: imageTmp });
  assert.equal(domain.env.TMPDIR, realpathSync(imageTmp), "the domain's TMPDIR is the image's, not the Harness's");
});

test("lookPath: the program by PATH — never by a relative PATH entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-lookpath-"));
  writeFileSync(join(dir, "tool"), "#!/bin/sh\n");
  chmodSync(join(dir, "tool"), 0o755);
  assert.equal(lookPath("tool", `.:${dir}`), join(dir, "tool"));
  assert.equal(lookPath("tool", ":."), undefined, "the current folder is the Agent's, and never searched");
});

test("probeLandlock: the confiner's refusal is the Harness's, with the node and the fix (ADR-0077)", () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-probe-"));
  const failing = join(dir, "effector");
  writeFileSync(failing, "#!/bin/sh\necho 'landlock: the kernel has no Landlock (ENOSYS)' >&2\nexit 1\n");
  chmodSync(failing, 0o755);
  const refusal = probeLandlock(failing, "node-7");
  assert.match(refusal ?? "", /^landlock: unavailable on node node-7 \(the kernel has no Landlock \(ENOSYS\)\)/);
  assert.match(refusal ?? "", /ADR-0077/);
  assert.match(refusal ?? "", /sandbox\.nodeSelector or a taint, or enable Landlock/);
  assert.equal(probeLandlock(testConfiner(), "this-host"), undefined, "the host's kernel has Landlock");
  assert.match(probeLandlock(join(dir, "absent"), "node-7") ?? "", /^the confiner .*absent did not run \(.*ENOENT\)/);
});

// ADR-0076: the Harness process reads files under its HOME: node, once at its start, for the
// folders of a bare require() (`$HOME/.node_modules`); the AWS SDK's ~/.aws/config, which can run a
// credential_process; Google's ~/.config/gcloud. So its HOME is not the domain's, which the domain
// writes: `effector nocore --harness-env` gives node /run/jr2/home before it starts, where no
// process of the domain makes or writes anything. The Harness only checks it. The domain keeps the
// Workspace HOME.
test("the Harness process starts with a HOME of its own under /run/jr2; the domain keeps the Workspace HOME", async () => {
  assert.ok(HARNESS_HOME.startsWith(`${RUNTIME_SECRETS}/`), HARNESS_HOME);
  const domain = testChildren();
  const workspaceHome = domain.env.HOME!;
  assertHarnessHome({ HOME: HARNESS_HOME }, domain);
  // A HOME that the Harness would take after node started is too late: the start is refused.
  assert.throws(() => assertHarnessHome({ HOME: workspaceHome }, domain), /node read it at its start/);
  assert.throws(() => assertHarnessHome({}, domain), /HOME is not set/);
  assert.throws(() => assertHarnessHome({ HOME: HARNESS_HOME }, { ...domain, env: {} }), /no HOME of its own/);
  const r = await runIn(domain, ["sh", "-c", 'echo "$HOME"'], { cwd: "/" });
  assert.equal(r.stdout, `${workspaceHome}\n`);
  // What /run/jr2 is to the pod: a process of the domain makes no folder there, so none makes the
  // Harness's HOME.
  const denied = deniedDir("harness-home-");
  const confined = testChildren({ deny: [denied] });
  const made = await runIn(confined, ["mkdir", `${denied}/home`], { cwd: "/" });
  assert.notEqual(made.code, 0, made.stdout);
  domain.spawner.close();
  confined.spawner.close();
});

// ADR-0076, the red team's F1: node fills Module.globalPaths from HOME once, at its start. With the
// fallback seat's HOME (an emptyDir that the domain writes), `$HOME/.node_modules/supports-color`
// planted by the domain ran in the Harness on a Bedrock Turn. Under `effector nocore --harness-env`,
// node starts with HOME=/run/jr2/home: no folder of the container's HOME is one where node looks.
test("node under `effector nocore --harness-env` looks for no module under the container's HOME (ADR-0076)", () => {
  const home = mkdtempSync(join(tmpdir(), "jr2-boot-home-"));
  mkdirSync(join(home, ".node_modules", "supports-color"), { recursive: true });
  writeFileSync(join(home, ".node_modules", "supports-color", "index.js"), "console.log('PLANTED-RAN');");
  const script =
    `const { createRequire } = await import("node:module");` +
    `const req = createRequire(import.meta.url);` +
    `let planted = "missed"; try { req("supports-color"); planted = "loaded"; } catch {}` +
    `console.log(JSON.stringify({ home: process.env.HOME, globalPaths: req("node:module").globalPaths, planted }));`;
  const out = execFileSync(
    testConfiner(),
    ["nocore", "--harness-env", "--", process.execPath, "--input-type=module", "-e", script],
    {
      encoding: "utf8",
      cwd: "/",
      env: { JR2_HARNESS_ENV_NAMES: "HOME,PATH", HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    },
  );
  assert.doesNotMatch(out, /PLANTED-RAN/);
  const got = JSON.parse(out) as { home: string; globalPaths: string[]; planted: string };
  assert.equal(got.home, HARNESS_HOME);
  assert.equal(got.planted, "missed");
  assert.deepEqual(
    got.globalPaths.filter((p) => p.startsWith(home)),
    [],
    `node looks under the container's HOME: ${got.globalPaths.join(", ")}`,
  );
  assert.ok(got.globalPaths.includes(`${HARNESS_HOME}/.node_modules`), got.globalPaths.join(", "));
});

// ADR-0076, the gaps review's C2: the rules are made once, and the spawner's confiner opens them
// again at each restart. A link beside the denied path, whose target is in a folder that the domain
// writes, once carried a rule: the domain retargeted the target onto the denied path and ended the
// spawner, and the restarted spawner read the control Stand-in. A link now gets no rule.
test("a link retargeted onto the denied path gives a restarted spawner nothing (ADR-0076)", async () => {
  const t = deniedDir("retarget-");
  mkdirSync(join(t, "run", "jr2", "control"), { recursive: true });
  mkdirSync(join(t, "w", "target"), { recursive: true });
  writeFileSync(join(t, "run", "jr2", "control", "standin"), "SECRET-CONTROL-RETARGET");
  symlinkSync(join(t, "w", "target"), join(t, "run", "link"));
  const policy = testChildren({ deny: [join(t, "run", "jr2")] });
  const sh = (cmd: string) => runIn(policy, ["sh", "-c", cmd], { cwd: t });
  const read = `cat ${t}/run/link/control/standin; cat ${t}/run/jr2/control/standin; echo spawner=$PPID`;
  const first = await sh(read);
  assert.doesNotMatch(first.stdout + first.stderr, /SECRET-CONTROL/);
  const before = /spawner=(\d+)/.exec(first.stdout)?.[1];
  // The domain retargets what the link names, then ends its spawner. The call itself ends with it.
  await sh(`rmdir ${t}/w/target && ln -s ${t}/run/jr2 ${t}/w/target && kill -9 $PPID`).catch(() => undefined);
  let after: Awaited<ReturnType<typeof sh>> | undefined;
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      after = await sh(read);
      const pid = /spawner=(\d+)/.exec(after.stdout)?.[1];
      if (pid !== undefined && pid !== before) break;
    } catch {
      // The spawner is starting again.
    }
  }
  const pid = /spawner=(\d+)/.exec(after?.stdout ?? "")?.[1];
  assert.ok(pid !== undefined && pid !== before, `the spawner did not restart: ${after?.stdout}`);
  assert.doesNotMatch((after?.stdout ?? "") + (after?.stderr ?? ""), /SECRET-CONTROL/);
  policy.spawner.close();
});

// ADR-0076: the Harness starts as `effector nocore --harness-env -- node …`. The Harness process
// gets only the names that jr2 composed, less each that loads code from a path, so an image's
// NODE_OPTIONS (here a --require of a file that is not there, which would stop node) and its
// LD_LIBRARY_PATH never reach it. The domain's env, made from JR2_START_ENV, holds both, so the
// Agent's toolchain sees the image's env as it did.
test("an image-only NODE_OPTIONS and LD_LIBRARY_PATH reach the domain's env and not the Harness process (ADR-0076)", () => {
  const children = new URL("../src/children.ts", import.meta.url).href;
  const script =
    `const { takeStartEnv, childEnv } = await import(${JSON.stringify(children)});` +
    `const own = { ...process.env };` +
    `const domain = childEnv(takeStartEnv(process.env), new Map(), [], undefined, { home: "/h", tmp: "/t" });` +
    `console.log(JSON.stringify({ own, domain, left: process.env.JR2_START_ENV ?? null }));`;
  const out = execFileSync(
    testConfiner(),
    ["nocore", "--harness-env", "--", process.execPath, "--input-type=module", "-e", script],
    {
      encoding: "utf8",
      env: {
        // The image's ENV.
        NODE_OPTIONS: "--require /nonexistent/jr2-e2e-hook.cjs",
        LD_LIBRARY_PATH: "/app/lib",
        IMAGE_ONLY: "yes",
        // What jr2 composed.
        JR2_HARNESS_ENV_NAMES: "PORT,JR2_CUSTODIAN_URL",
        PORT: "8080",
        JR2_CUSTODIAN_URL: "http://127.0.0.1:8081",
        // harness.envFrom, with the Orchestrator's prefix.
        JR2_ENVFROM_GOOGLE_CLOUD_PROJECT: "p",
      },
    },
  );
  const { own, domain, left } = JSON.parse(out) as {
    own: Record<string, string>;
    domain: Record<string, string>;
    left: string | null;
  };
  for (const name of ["NODE_OPTIONS", "LD_LIBRARY_PATH", "IMAGE_ONLY"]) {
    assert.equal(own[name], undefined, `the Harness process got ${name}`);
  }
  assert.equal(own.PORT, "8080");
  assert.equal(own.GOOGLE_CLOUD_PROJECT, "p");
  assert.equal(left, null, "JR2_START_ENV is taken out of the Harness's env");
  assert.equal(domain.NODE_OPTIONS, "--require /nonexistent/jr2-e2e-hook.cjs");
  assert.equal(domain.LD_LIBRARY_PATH, "/app/lib");
  assert.equal(domain.IMAGE_ONLY, "yes");
  assert.equal(domain.GOOGLE_CLOUD_PROJECT, "p");
  assert.equal(domain.JR2_CUSTODIAN_URL, "http://127.0.0.1:8081");
  assert.deepEqual(
    Object.keys(domain).filter((n) => n.startsWith("JR2_") && n !== "JR2_CUSTODIAN_URL"),
    [],
  );
});
