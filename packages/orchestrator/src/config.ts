// Workflow author configuration: the repos a j2 deployment orchestrates.
//
// `defineConfig` is an identity passthrough — it exists solely so a `j2.config.ts` gets full
// type inference and checking against `J2Config` at authoring time, exactly like the config
// helpers in vite/tsup/etc. No runtime behavior beyond returning its argument.

export type RepoConfig = {
  name: string;
  url: string;
  ref?: string;
};

export type J2Config = {
  repos: RepoConfig[];
};

/** Identity passthrough that pins a config object's type to `J2Config` for inference. */
export function defineConfig(c: J2Config): J2Config {
  return c;
}
