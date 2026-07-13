// `j2 cluster up|down [--name <n>]` (ADR-0009, amended): j2 OWNS kind cluster creation because
// the one thing a Sandbox data plane cannot get after the fact is the repos mount — kind's
// hostPath resolves against the NODE (the kind Docker container), so `<instance>/repos` reaches
// Sandbox pods only via `nodes[].extraMounts` baked in AT CLUSTER CREATION. `up` therefore
// generates the kind config (repos → /repos, read-only), creates the cluster, and installs the
// bundled Sandbox CRD; a cluster that already exists is left alone LOUDLY (its mounts may be
// stale — recreating is the only fix, and that is the user's call). The operator itself still
// runs out-of-band (`just operator-run`) until a deployable operator image lands.
//
// `up` also records the POD→HOST address into `.j2/cluster.json` (ADR-0013). Only it can: a pod
// reaches a host-side `j2 dev` through the gateway of the docker network kind put the node on, and
// this command is what put it there. `j2 dev` reads it back, appends its own port, and hands the
// result to the Adapter as env — the address the Agent never sees and its Adapter always uses.
//
// The process seam is injectable (like the orchestrator's kubectl port) so the command logic is
// unit-testable without kind/docker; the real path is the kind e2e tier's job.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveRoot } from "../instance.ts";
import { activity, result, type Io } from "../output.ts";

/** What `j2 cluster up` recorded about the live cluster, for `j2 dev` to read back. */
export type ClusterInfo = { cluster: string; context: string; podToHost?: string };

/** Read `<root>/.j2/cluster.json`; undefined when this instance has no cluster of ours. */
export function readClusterJson(root: string): ClusterInfo | undefined {
  try {
    return JSON.parse(readFileSync(join(root, ".j2", "cluster.json"), "utf8")) as ClusterInfo;
  } catch {
    return undefined;
  }
}

/** Run one external command to completion (kind / kubectl). Injectable for tests. */
export type CmdExec = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

/** The Sandbox CRD bundled with the CLI (synced from operator/config/crd/bases). */
const CRD_PATH = fileURLToPath(new URL("../../assets/sandbox-crd.yaml", import.meta.url));

export async function cluster(args: string[], io: Io, exec: CmdExec = defaultExec): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: { name: { type: "string" } },
  });
  const sub = positionals[0];
  const name = (values.name as string | undefined) ?? "j2";

  if (sub === "up") return up(name, io, exec);
  if (sub === "down") {
    await exec("kind", ["delete", "cluster", "--name", name]);
    activity(io, `deleted kind cluster "${name}"`);
    result(io, { cluster: name, deleted: true });
    return 0;
  }
  activity(io, "usage: j2 cluster up|down [--name <n>]");
  return 2;
}

async function up(name: string, io: Io, exec: CmdExec): Promise<number> {
  const root = resolveRoot(io.cwd);
  const reposDir = join(root, "repos");
  await mkdir(reposDir, { recursive: true });
  await mkdir(join(root, ".j2"), { recursive: true });

  const configPath = join(root, ".j2", "kind.yaml");
  await writeFile(configPath, kindConfig(name, reposDir));

  const existing = (await exec("kind", ["get", "clusters"])).stdout.split("\n").map((l) => l.trim());
  if (existing.includes(name)) {
    activity(io, `kind cluster "${name}" already exists — leaving it as-is.`);
    activity(io, `  NOTE: extraMounts are baked at creation; if repos/ moved, \`j2 cluster down\` and re-up.`);
  } else {
    activity(io, `creating kind cluster "${name}" (repos/ mounted read-only at /repos on the node)…`);
    await exec("kind", ["create", "cluster", "--name", name, "--config", configPath]);
  }

  activity(io, "installing the Sandbox CRD…");
  await exec("kubectl", ["apply", "--context", `kind-${name}`, "-f", CRD_PATH]);

  // The pod→host address (ADR-0013). Recorded now because only `up` can know it: a Sandbox's Adapter
  // dials the orchestrator running on the HOST, and the route out of the pod is the gateway of the
  // docker network kind attached the node to. `j2 dev` reads this back and appends its port.
  const podToHost = await dockerGateway(exec);
  const info: ClusterInfo = { cluster: name, context: `kind-${name}`, podToHost };
  await writeFile(join(root, ".j2", "cluster.json"), `${JSON.stringify(info, null, 2)}\n`);
  if (podToHost) activity(io, `pods reach this host at ${podToHost} (recorded in .j2/cluster.json)`);
  else activity(io, "WARNING: could not read the kind network's gateway — Sandboxes will not reach `j2 dev`.");

  activity(io, "cluster ready. next steps:");
  activity(io, "  1. run the Sandbox operator against it (repo dev: `just operator-run`)");
  activity(io, "  2. set `sandbox: { image: …, adapterImage: … }` in j2.config.ts, then `j2 dev`");
  result(io, { ...info, repos: reposDir, crd: "sandboxes.core.j2.dev" });
  return 0;
}

/**
 * The address a pod on the `kind` docker network reaches this host at: that network's IPv4 gateway.
 *
 * Pick the gateway by ADDRESS FAMILY, never by position — the IPAM config commonly lists IPv6 first
 * (this box: `[{Subnet: fc00:…::/64}, {Subnet: 172.19.0.0/16, Gateway: 172.19.0.1}]`), so the
 * customary `index .IPAM.Config 0` yields an empty string and every Adapter silently gets no route.
 */
async function dockerGateway(exec: CmdExec): Promise<string | undefined> {
  try {
    const { stdout } = await exec("docker", ["network", "inspect", "kind", "--format", "{{json .IPAM.Config}}"]);
    const configs = JSON.parse(stdout.trim()) as Array<{ Subnet?: string; Gateway?: string }>;
    return configs.find((c) => c.Gateway?.includes("."))?.Gateway;
  } catch {
    return undefined; // no docker, or a cluster that is not kind's — the warning above says so
  }
}

/** The generated kind config: the ONE thing that must exist at creation time (see header). */
export function kindConfig(name: string, reposDir: string): string {
  return `# Generated by \`j2 cluster up\` — do not edit; regenerate by re-running it.
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: ${name}
nodes:
  - role: control-plane
    extraMounts:
      # The instance's repos/ (RO default/ checkouts) exposed to the NODE, so Sandbox pods can
      # hostPath-mount it (ADR-0004 storage shape). Baked here because kind cannot add mounts
      # to a live cluster.
      - hostPath: ${reposDir}
        containerPath: /repos
        readOnly: true
`;
}

const defaultExec: CmdExec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const hint =
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? `\`${cmd}\` is not installed or not on PATH` + (cmd === "kind" ? " (brew install kind)" : "")
            : stderr || err.message;
        reject(new Error(`${cmd} ${args[0]} failed: ${hint}`));
      } else resolve({ stdout });
    });
  });
