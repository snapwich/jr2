// The named Caller tokens on the cluster (ADR-0078): what `jr2 up` and `jr2 caller rotate` share.
//
// Each name that `callers.tokens` declares has a Secret of its own, `jr2-caller-<name>`, which holds
// its value (`jr2c_` and 32 random bytes in base64url) and which no pod mounts. The Orchestrator
// gets only the digests, in `jr2-caller-digests`, which it mounts and reads again when it changes.
// So the value stays where kube RBAC guards it, as the Instance token does, and a new token or a
// rotation rolls no pod.
//
// `jr2 up` makes a value once, for a name that has none, and keeps it after that. It deletes the
// Secret of a name that the config no longer declares, so that value stops working. `jr2 caller
// rotate` makes a new value for one name and writes the digests again from every token Secret.

import { CALLER_TOKEN_PREFIX, mintCallerToken } from "@jr2/orchestrator/internal";
import { CALLER_TOKEN_KEY, callerTokenObjects, LABEL_CALLER_TOKEN, LABEL_INSTANCE } from "./deploy.ts";
import type { KubeAdmin, KubeObject } from "./kube.ts";

type Ctx = { context?: string };
type SecretObject = KubeObject & { data?: Record<string, string> };

/** The values of the token Secrets in the namespace, by the name on their label. A Secret with no
 * value, or a value that is not a Caller token's, is left out. */
export async function storedCallerTokens(kube: KubeAdmin, namespace: string, ctx: Ctx): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const secret of await kube.listJson<SecretObject>({
    kind: "secret",
    selector: LABEL_CALLER_TOKEN,
    namespace,
    ...ctx,
  })) {
    const name = secret.metadata.labels?.[LABEL_CALLER_TOKEN];
    const b64 = secret.data?.[CALLER_TOKEN_KEY];
    if (!name || !b64) continue;
    const value = Buffer.from(b64, "base64").toString("utf8");
    if (value.startsWith(CALLER_TOKEN_PREFIX)) found.set(name, value);
  }
  return found;
}

/** What `jr2 up` does with the named Caller tokens: the value of each declared name, the names it
 * made a value for now, and the names whose Secret it deletes. */
export type CallerTokenPlan = {
  values: Record<string, string>;
  made: string[];
  undeclared: string[];
};

/**
 * Plan the named Caller tokens for one converge (ADR-0078): keep the stored value of each declared
 * name, make one for a declared name that has none, and name each stored name that the config no
 * longer declares.
 */
export async function planCallerTokens(
  kube: KubeAdmin,
  declared: readonly string[],
  namespace: string,
  ctx: Ctx,
): Promise<CallerTokenPlan> {
  const stored = await storedCallerTokens(kube, namespace, ctx);
  const values: Record<string, string> = {};
  const made: string[] = [];
  for (const name of [...declared].sort()) {
    const kept = stored.get(name);
    if (kept !== undefined) values[name] = kept;
    else {
      values[name] = mintCallerToken();
      made.push(name);
    }
  }
  const undeclared = [...stored.keys()].filter((n) => !declared.includes(n)).sort();
  return { values, made, undeclared };
}

/**
 * Make a new value for one named Caller token, and write the digests again (ADR-0078). The value
 * goes first: when the digests write fails, `jr2 caller rotate` runs again and the token still has
 * a value that `jr2 caller token` prints. Refuses a name that has no token Secret: `jr2 up` makes
 * it, from the config.
 */
export async function rotateCallerToken(
  kube: KubeAdmin,
  opts: { instance: string; namespace: string; name: string; ctx: Ctx },
): Promise<void> {
  const stored = await storedCallerTokens(kube, opts.namespace, opts.ctx);
  if (!stored.has(opts.name)) {
    const known = [...stored.keys()].sort();
    throw new Error(
      `no Caller token "${opts.name}" in namespace "${opts.namespace}" — declare it in callers.tokens of ` +
        `jr2.config.ts and run \`jr2 up\`${known.length ? ` (tokens here: ${known.join(", ")})` : ""}`,
    );
  }
  stored.set(opts.name, mintCallerToken());
  const labels = { [LABEL_INSTANCE]: opts.instance, "app.kubernetes.io/managed-by": "jr2" };
  const meta = (name: string, extra: Record<string, string> = {}) => ({
    name,
    namespace: opts.namespace,
    labels: { ...labels, ...extra },
  });
  const [valueSecret, digests] = callerTokenObjects(Object.fromEntries(stored), meta).filter(
    (o) =>
      (o.metadata as { labels: Record<string, string> }).labels[LABEL_CALLER_TOKEN] === opts.name ||
      (o.metadata as { labels: Record<string, string> }).labels[LABEL_CALLER_TOKEN] === undefined,
  );
  await kube.apply({ manifest: JSON.stringify(valueSecret), ...opts.ctx });
  await kube.apply({ manifest: JSON.stringify(digests), ...opts.ctx });
}
