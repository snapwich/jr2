// A fake `docker` for the Fence's node parts on a kind cluster (ADR-0084): the node containers of
// kind clusters, each with its plugins, its parts and its 8021q module. It answers the commands that
// `kind-fence.ts` gives: `ps` by kind's label, the node script in `check` or `make` mode, `cp` of a
// plugin under a temporary name, and the move into place.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DockerResult, DockerRunner } from "../../src/kind-fence.ts";

export const NODE_PARTS = ["bridge", "rule-set", "route"] as const;

export type FakeKindNode = {
  cluster: string;
  machine: string;
  /** Plugin name to its sha256 on the node. */
  plugins: Record<string, string>;
  /** The parts the node lacks. */
  missing: Set<string>;
  module: "loaded" | "loadable" | "absent";
};

export class FakeKindDocker {
  nodes = new Map<string, FakeKindNode>();
  /** Each command, as its argv joined by spaces. */
  calls: string[] = [];
  /** `true` → every command fails, as when no docker daemon answers. */
  down = false;
  private staged = new Map<string, string>();

  /** A node. `prepared` gives it every part and the plugins of `sums` (`linux-amd64/<p>` keys). */
  add(
    name: string,
    opts: { cluster: string; prepared: boolean; sums: ReadonlyMap<string, string>; module?: FakeKindNode["module"] },
  ): FakeKindNode {
    const node: FakeKindNode = {
      cluster: opts.cluster,
      machine: "x86_64",
      plugins: opts.prepared
        ? Object.fromEntries(["bridge", "static", "tuning"].map((p) => [p, opts.sums.get(`linux-amd64/${p}`)!]))
        : {},
      missing: new Set(opts.prepared ? [] : NODE_PARTS),
      module: opts.module ?? (opts.prepared ? "loaded" : "loadable"),
    };
    this.nodes.set(name, node);
    return node;
  }

  run: DockerRunner = async (args) => {
    this.calls.push(args.join(" "));
    const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "" });
    if (this.down) return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
    if (args[0] === "ps") {
      const cluster = args[2]!.split("=").pop();
      return ok(
        [...this.nodes]
          .filter(([, n]) => n.cluster === cluster)
          .map(([name]) => `${name}\n`)
          .join(""),
      );
    }
    if (args[0] === "cp") {
      const [, local, target] = args as [string, string, string];
      this.staged.set(target, createHash("sha256").update(readFileSync(local)).digest("hex"));
      return ok();
    }
    if (args[0] === "exec" && args[1] === "-i") {
      const node = this.nodes.get(args[2]!)!;
      const mode = args[8] as "check" | "make";
      const lines = [`arch ${node.machine}`];
      for (const p of ["bridge", "static", "tuning"]) lines.push(`plugin ${p} ${node.plugins[p] ?? "-"}`);
      if (node.module !== "loaded") {
        if (node.module === "absent") lines.push("refuse 8021q the kernel 6.6.0 has no module 8021q in /lib/modules");
        else if (mode === "check") lines.push("missing 8021q");
        else {
          node.module = "loaded";
          lines.push("made 8021q");
        }
      }
      for (const part of NODE_PARTS) {
        if (!node.missing.has(part)) continue;
        lines.push(`${mode === "check" ? "missing" : "made"} ${part}`);
        if (mode === "make") node.missing.delete(part);
      }
      return ok(lines.join("\n") + "\n");
    }
    if (args[0] === "exec") {
      // `exec <node> sh -c "chmod … && mv -f '<temp>' '/opt/cni/bin/<p>'"`
      const node = this.nodes.get(args[1]!)!;
      const m = /mv -f '([^']+)' '\/opt\/cni\/bin\/([a-z]+)'/.exec(args[4]!)!;
      const sum = this.staged.get(`${args[1]}:${m[1]}`)!;
      node.plugins[m[2]!] = sum;
      return ok();
    }
    return { code: 1, stdout: "", stderr: `unknown: ${args.join(" ")}` };
  };
}
