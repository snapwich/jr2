// The clone credentials (ADR-0051, ADR-0068, B11): the token a Repo's cache clone spends. `jr2 up`
// declares and writes every Secret that holds a git credential; the Orchestrator matches and names,
// and holds no git credential.
//
//   - `jr2 up` writes each `git.credentials` entry's token, read from `.env`, into that entry's
//     own Secret, `jr2-git-<hash of match>` (`gitTokenSecretName`), in Flux's key names
//     (`username`/`password`), as it writes the entry's push Secret. An entry whose token variable
//     is unset gets no Secret. And it writes `git-clone.json` in `jr2-held`: which clone Secrets it
//     wrote, names only.
//   - The Orchestrator resolves a Repo's url against `git.credentials` and names the matched
//     entry's Secret as the Repo CR's `secretRef` when `git-clone.json` says it exists. Otherwise
//     the CR carries no `secretRef` and the clone is anonymous.
//   - The operator's cache agent reads the Secret the `secretRef` names, and spends it.

import { readFile } from "node:fs/promises";
import { gitTokenSecretName, type GitCredential } from "./config.ts";

/** The `jr2-held` key of the clone manifest. */
export const GIT_CLONE_MANIFEST_KEY = "git-clone.json";
/** The label every entry's clone Secret carries, so a stale one is found. */
export const LABEL_GIT_CLONE = "jr2.dev/git-clone";

/** `git-clone.json`: the clone Secrets `jr2 up` wrote, by name. */
export type GitCloneManifest = { version: 1; secrets: string[] };

/** One entry's clone Secret, as `jr2 up` writes it. */
export type GitCloneSecret = { match: string; name: string; data: { username: string; password: string } };

/**
 * Each `git.credentials` entry's clone Secret: the entries with a `token` whose variable is set.
 * The values are plain strings; the caller encodes them. Two entries never share a name.
 */
export function gitCloneSecretsOf(
  list: readonly GitCredential[],
  env: (name: string) => string | undefined,
): GitCloneSecret[] {
  const out: GitCloneSecret[] = [];
  for (const entry of list) {
    if (entry.token === undefined) continue;
    const value = env(entry.token);
    if (!value) continue;
    out.push({
      match: entry.match,
      name: gitTokenSecretName(entry.match),
      data: { username: "x-access-token", password: value },
    });
  }
  return out;
}

/** The manifest the Orchestrator reads, or an empty one when `jr2 up` wrote no clone Secret. */
export async function readGitCloneManifest(path: string): Promise<GitCloneManifest> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, secrets: [] };
    throw err;
  }
  const parsed = JSON.parse(raw) as GitCloneManifest;
  if (parsed.version !== 1 || !Array.isArray(parsed.secrets)) {
    throw new Error(`${path} is not a clone manifest jr2 reads (version 1)`);
  }
  return parsed;
}
