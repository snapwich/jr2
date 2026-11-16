// The pinned Envoy validates what the renderer of the Custodian of an Instance writes (ADR-0084):
// the pod's bootstrap, and the LDS and CDS files of three slots — the Instance Harness, a check pod
// and a Sandbox with each kind of rule. `envoy --mode validate` builds each listener, each cluster,
// each TLS context and each Lua filter, so it reads the leaves, the program and each slot's table
// from the paths the renderer names. The files are laid out as the Custodian pod mounts them.
//
// Opt-in: `just custodian-test` (docker + the pinned image), beside the Custodian suite.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import {
  CUSTODIAN_POD_BOOTSTRAP,
  CUSTODIAN_POD_CONFIG,
  CUSTODIAN_POD_PROGRAM,
  CUSTODIAN_PROGRAM,
  CUSTODIAN_STATE,
  CUSTODIAN_LDS,
  CUSTODIAN_CDS,
  custodianPodBootstrap,
  custodianRef,
  custodianXds,
  JR2_CUSTODIAN_NAME,
  leafStem,
  renderSlot,
  slotFolder,
  type SlotInputs,
} from "@jr2/orchestrator/internal";
import { RANGES, THREE_SLOTS } from "./support/custodian-slots.ts";
import { issueCa, issueLeaf, trustBundles } from "../src/held-pki.ts";

const exec = promisify(execFile);
let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "jr2-custodian-rules-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Where a path of the pod lands in `dir`: `/etc/jr2/...` under `etc/`, the state folder under `state/`. */
function local(path: string): string {
  if (path.startsWith(CUSTODIAN_STATE)) return join(dir, "state", path.slice(CUSTODIAN_STATE.length));
  return join(dir, "etc", path.slice("/etc/jr2".length));
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(local(path)), { recursive: true });
  await writeFile(local(path), text, { mode: 0o644 });
}

/** The files of one slot: its Lua table, a value and a Stand-in for each name the table reads, and a
 * leaf for each Intercepted host. */
async function slotFiles(inputs: SlotInputs, ca: ReturnType<typeof issueCa>): Promise<void> {
  const rules = renderSlot(inputs);
  await put(rules.lua.path, rules.lua.text);
  const names = ["JR2_CONTROL_TOKEN", "JR2_SANDBOX_TOKEN", ...inputs.manifest.secrets.map((s) => s.name)];
  for (const name of names) {
    await put(`${slotFolder(inputs.slot)}/values/${name}`, `value-of-${name}\n`);
    await put(`${slotFolder(inputs.slot)}/values/${name}.standin`, `jr2-held-${name}.test\n`);
  }
  const intercepted = [
    { host: JR2_CUSTODIAN_NAME, port: 443 },
    ...inputs.manifest.egress.filter((r) => r.intercept && r.port !== 80),
  ];
  for (const { host, port } of intercepted) {
    const leaf = issueLeaf(ca, host);
    await put(`${slotFolder(inputs.slot)}/tls/${leafStem(host, port)}.crt`, leaf.cert);
    await put(`${slotFolder(inputs.slot)}/tls/${leafStem(host, port)}.key`, leaf.key);
  }
}

async function validate(bootstrap: string): Promise<{ code: number; output: string }> {
  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "-v",
    `${join(dir, "etc")}:/etc/jr2:ro`,
    "-v",
    `${join(dir, "state")}:${CUSTODIAN_STATE}:ro`,
    "--user",
    `65532:${process.getgid?.() ?? 0}`,
    custodianRef(),
    "--mode",
    "validate",
    "-c",
    bootstrap,
    "--log-level",
    "warning",
  ];
  try {
    const { stdout, stderr } = await exec("docker", args, { maxBuffer: 1 << 24 });
    return { code: 0, output: stdout + stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test("the pinned Envoy validates the Custodian pod's bootstrap with the LDS and CDS of three slots, and each slot's chains built inline (ADR-0084)", async () => {
  const ca = issueCa("custodian-rules");
  for (const inputs of THREE_SLOTS) await slotFiles(inputs, ca);
  await put(CUSTODIAN_POD_PROGRAM, CUSTODIAN_PROGRAM);
  await put(`/etc/jr2/ca/upstream.crt`, trustBundles(ca.cert).upstream);

  const slots = THREE_SLOTS.map(renderSlot);
  const bootstrap = custodianPodBootstrap({
    orchestrator: { host: "jr2-orchestrator.ns.svc", port: 4000 },
    range: 3,
    ranges: RANGES,
  });
  const { lds, cds } = custodianXds(slots);
  await put(CUSTODIAN_POD_BOOTSTRAP, JSON.stringify(bootstrap));
  await put(CUSTODIAN_LDS, JSON.stringify(lds));
  await put(CUSTODIAN_CDS, JSON.stringify(cds));

  // The same slot listeners and clusters as static resources: validate mode builds each one, with
  // its TLS contexts and Lua filters, whether or not it reads the watched files.
  const inline = structuredClone(bootstrap) as {
    dynamic_resources?: unknown;
    static_resources: { listeners: unknown[]; clusters: unknown[] };
  };
  delete inline.dynamic_resources;
  const strip = ({ "@type": _, ...rest }: Record<string, unknown>) => rest;
  inline.static_resources.listeners.push(...(lds.resources as Record<string, unknown>[]).map(strip));
  inline.static_resources.clusters.push(...(cds.resources as Record<string, unknown>[]).map(strip));
  await put(`${CUSTODIAN_POD_CONFIG}/inline.json`, JSON.stringify(inline));

  const pod = await validate(CUSTODIAN_POD_BOOTSTRAP);
  assert.equal(pod.code, 0, `the pod's bootstrap:\n${pod.output}`);
  assert.match(pod.output, /configuration '.*' OK/);
  const all = await validate(`${CUSTODIAN_POD_CONFIG}/inline.json`);
  assert.equal(all.code, 0, `the slots inline:\n${all.output}`);
  assert.match(all.output, /configuration '.*' OK/);
});
