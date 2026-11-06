// `jr2 caller token <name>` and `jr2 caller rotate <name>` (ADR-0078): a named Caller token's value,
// and a new one.
//
// Both read and write the values over the kube API and never through the Orchestrator, as the
// Instance token's read does (ADR-0019): kube RBAC on the token's Secret is the gate. So they take
// the deployment's addressing (`-n`, `--context`) and not `--url`: an Orchestrator holds only the
// digests, and no route of it gives a value.
//
// `token` prints the value alone on stdout, so `JR2_TOKEN=$(jr2 caller token ci)` holds it. `rotate`
// makes a new value and prints none. The old value stops working when the Orchestrator loads the
// new digest, after the kubelet updates its mount. So `rotate` waits for that, as `jr2 up` does,
// over a port-forward to the Orchestrator's open `GET /assembly`, which gives digests and no value.

import { basename } from "node:path";
import { callerTokenSecret, loadConfig, ORCHESTRATOR_PORT, ORCHESTRATOR_SERVICE } from "@jr2/orchestrator/internal";
import { rotateCallerToken } from "../caller-tokens.ts";
import { commandNamed, parseCommand, renderCommand, usageLine } from "../command-table.ts";
import { CALLER_TOKEN_KEY } from "../deploy.ts";
import { resolveRoot } from "../instance.ts";
import { kubectlAdmin, kubectlKube } from "../kube.ts";
import { awaitMounts, staleLine, type MountsView } from "../mount-wait.ts";
import { activity, type Io } from "../output.ts";

export async function caller(args: string[], io: Io): Promise<number> {
  const sub = args[0];
  if (sub !== "token" && sub !== "rotate") {
    activity(io, sub === undefined ? "jr2 caller: no subcommand" : `unknown caller subcommand: ${sub}`);
    activity(io, [commandNamed("caller token"), commandNamed("caller rotate")].map(renderCommand).join("\n\n"));
    return 2;
  }
  const { values, positionals } =
    sub === "token" ? parseCommand("caller token", args) : parseCommand("caller rotate", args);
  const name = positionals[1];
  if (!name) {
    activity(io, `jr2 caller ${sub}: no token name`);
    activity(io, usageLine(sub === "token" ? "caller token" : "caller rotate"));
    return 2;
  }

  const root = resolveRoot(io.cwd);
  const config = (await loadConfig(root)) ?? {};
  const instance = config.name ?? basename(root);
  const namespace = (values.namespace as string | undefined) ?? instance;
  const ctx = values.context ? { context: values.context as string } : {};

  if (sub === "token") {
    const kube = io.kube ?? kubectlKube;
    const context = (values.context as string | undefined) ?? (await kube.currentContext());
    if (!context) throw new Error("no kube context — `kind create cluster` (or point kubectl at one), then `jr2 up`");
    activity(io, `→ context ${context} / namespace ${namespace}`);
    let value: string | undefined;
    try {
      value = await kube.readSecret({ namespace, name: callerTokenSecret(name), key: CALLER_TOKEN_KEY, ...ctx });
    } catch (e) {
      throw new Error(`cannot reach the cluster — context ${context}: ${(e as Error).message}`);
    }
    if (!value) {
      throw new Error(
        `no Caller token "${name}" here (context ${context}, namespace ${namespace}) — declare it in ` +
          "callers.tokens of jr2.config.ts, then `jr2 up` makes it",
      );
    }
    io.stdout(`${value}\n`);
    return 0;
  }

  const kube = io.kubeAdmin ?? kubectlAdmin;
  const context = (values.context as string | undefined) ?? (await kube.context());
  if (!context) throw new Error("no kube context — `kind create cluster` (or point kubectl at one), then `jr2 up`");
  activity(io, `→ context ${context} / namespace ${namespace}`);
  const applied = await rotateCallerToken(kube, { instance, namespace, name, ctx });
  const stale = await awaitLoaded(io, { namespace, ctx, want: applied, prefix: `caller token "${name}"` });
  if (stale.length) {
    activity(
      io,
      `caller token "${name}": rotated, but ${staleLine(stale)}; the old value still works until it does. ` +
        `\`jr2 caller token ${name}\` prints the new one`,
    );
    return 1;
  }
  activity(
    io,
    `caller token "${name}": rotated — the old value no longer works; \`jr2 caller token ${name}\` prints the new one`,
  );
  return 0;
}

/**
 * Wait until the Orchestrator has loaded the digests that `want` names (ADR-0078), over a
 * port-forward of its Service, as `jr2 up` reaches it. Returns the names that were still older when
 * the wait ended: none when it succeeded.
 */
async function awaitLoaded(
  io: Io,
  opts: { namespace: string; ctx: { context?: string }; want: Record<string, string>; prefix: string },
): Promise<string[]> {
  const fetchImpl = io.fetch ?? globalThis.fetch;
  const fwd = await (io.kube ?? kubectlKube).portForward({
    namespace: opts.namespace,
    service: ORCHESTRATOR_SERVICE,
    port: ORCHESTRATOR_PORT,
    ...opts.ctx,
  });
  try {
    const base = fwd.url.replace(/\/+$/, "");
    const view = async (): Promise<MountsView> => {
      const res = await fetchImpl(`${base}/assembly`);
      if (!res.ok) throw new Error(`the Orchestrator answered GET /assembly with HTTP ${res.status}`);
      return (await res.json()) as MountsView;
    };
    return (await awaitMounts(io, { seen: await view(), view, want: opts.want, prefix: opts.prefix })).stale;
  } finally {
    fwd.close();
  }
}
