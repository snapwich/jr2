// What a Harness container's env tells its start (ADR-0076): which names jr2 composed. The Harness
// starts as `effector nocore --harness-env -- node …`, and that gives the Harness PROCESS only the
// names jr2 composed, less each name that loads code from a path (`NODE_OPTIONS`, `LD_*`,
// `OPENSSL_CONF` …), because the image's `ENV` can name a file that Workspace code writes. The
// domain, where the Agent's programs run, still gets the container's whole start env.
//
// Two marks make the names jr2 composed visible inside the container:
//   - `JR2_HARNESS_ENV_NAMES`: the names of the container's `env`, comma-separated.
//   - The prefix `JR2_ENVFROM_` before each `envFrom` key (with a source's own prefix after it):
//     its keys are not known here, a user's Secret or ConfigMap among them. The start puts each key
//     back under its own name, below a name of `env`, as Kubernetes orders them.

/** The env name that lists the names of the Harness container's `env`. */
export const HARNESS_ENV_NAMES_ENV = "JR2_HARNESS_ENV_NAMES";

/** The prefix before each `envFrom` key of a Harness container. */
export const HARNESS_ENVFROM_PREFIX = "JR2_ENVFROM_";

/** The Harness container's `env` with `JR2_HARNESS_ENV_NAMES` last, and its `envFrom` with the
 * prefix `JR2_ENVFROM_`. Both Harness placements use it: a Sandbox's and the Instance Harness. */
export function markHarnessEnv<E extends { name: string }, F extends { prefix?: string }>(
  env: readonly E[],
  envFrom: readonly F[],
): { env: (E | { name: string; value: string })[]; envFrom: F[] } {
  const names = [...new Set(env.map((v) => v.name))].filter((n) => n !== HARNESS_ENV_NAMES_ENV);
  return {
    env: [
      ...env.filter((v) => v.name !== HARNESS_ENV_NAMES_ENV),
      { name: HARNESS_ENV_NAMES_ENV, value: names.join(",") },
    ],
    envFrom: envFrom.map((f) => ({ ...f, prefix: `${HARNESS_ENVFROM_PREFIX}${f.prefix ?? ""}` })),
  };
}
