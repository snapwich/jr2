// The push credentials (ADR-0051, ADR-0067, B10): a `push()` spends the `git.credentials` entry its
// Repo Slot's url matches — longest prefix, the attach match — and that entry's push credential
// reaches the pod by reference, placed by the pod's maker when the url is known.
//
//   - `jr2 up` writes each entry's push and sign credentials into that entry's own Secret,
//     `jr2-git-push-<hash of match>`, never per Workspace: Flux's key names where Flux has them
//     (`username`/`password` for a token, `identity`/`identity.pub`/`known_hosts` for an ssh key),
//     `sign.identity` or `sign.private.asc` for the signing key, and `entry.json` — what the entry
//     is, names only. A token is the `.env` value; a key is copied as data from the Secret the entry
//     names, never decoded. And it writes the manifest `git-push.json` in `jr2-held`: which entries
//     it wrote and what each can spend, names only.
//   - At provision the Orchestrator resolves each pushed slot's url against the fence and names the
//     matched entry's Secret on the Sandbox CR (`gitCredentials`, the Repo CR's `secretRef` shape);
//     the operator projects it into the Sandbox Effector at `@git/<its name>/`. Static, per-run and
//     `customize()`-bound urls take this one path, and the Orchestrator reads no value.
//
// The refusal is one function for both sides: `jr2 up` for a static Binding, from the entry as
// written; the provision for any url, from what `jr2 up` wrote.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { matchCredential, type GitCredential } from "./config.ts";
import { repoIdentity } from "./repo-identity.ts";

/** The `jr2-held` key of the push manifest. */
export const GIT_PUSH_MANIFEST_KEY = "git-push.json";
/** The label every entry's push Secret carries, so a stale one is found. */
export const LABEL_GIT_PUSH = "jr2.dev/git-push";

/** One entry's push Secret: deterministic in `match`, so a redeploy finds its own and two entries
 * never share one. Apart from the clone token's Secret (`jr2-git-<hash>`), which the Orchestrator
 * writes for the cache agent. */
export function gitPushSecretName(match: string): string {
  return `jr2-git-push-${createHash("sha256").update(match).digest("hex").slice(0, 8)}`;
}

/** The keys of an entry's push Secret — the operator projects exactly these, each when present. */
export const GIT_PUSH_KEYS = {
  entry: "entry.json",
  username: "username",
  password: "password",
  identity: "identity",
  identityPub: "identity.pub",
  knownHosts: "known_hosts",
  signSsh: "sign.identity",
  signGpg: "sign.private.asc",
} as const;

export type PushKind = "ssh" | "token";

/** One entry's push Secret as `jr2 up` wrote it: names only. */
export type GitPushEntry = {
  match: string;
  /** Its place in `git.credentials`: a tie on the match's length goes to the first. */
  order: number;
  secret: string;
  /** What it can push with. */
  push: PushKind[];
  sign?: "ssh" | "gpg";
};

/** `git-push.json`: every entry `jr2 up` wrote a push Secret for. */
export type GitPushManifest = { version: 1; entries: GitPushEntry[] };

/** The push credentials an entry declares: its `push` field alone when it has one; otherwise the
 * clone credentials it holds, each spent over its own scheme. None: it admits a clone, never a push. */
export function declaredPushKinds(entry: GitCredential): PushKind[] {
  if (entry.push) return ["sshKey" in entry.push ? "ssh" : "token"];
  return [...(entry.sshKey ? (["ssh"] as const) : []), ...(entry.token ? (["token"] as const) : [])];
}

/** What a push of one url needs from the entry it matches. */
export type PushNeed = {
  /** For the message: `workflow "w": push "p" pushes Repo Slot "app" (url)`. */
  at: string;
  url: string;
  sign: boolean;
};

/**
 * Why a push of `need.url` cannot be spent, with the fix that works, or undefined. `kinds` says
 * what an entry can push with — as written (`jr2 up`, `declaredPushKinds`) or as placed (the
 * provision, the manifest; undefined when `jr2 up` placed nothing for it); `signs` whether it holds
 * a signing key. Refused: a local path and `git://` (jr2 never pushes there), `http://` (a
 * credential over cleartext http is the credential in the clear: a token goes over https only and
 * an ssh key over ssh only), a url no entry matches, an entry whose credentials the url's scheme
 * cannot spend, and `sign: true` on an entry with no `sign` field.
 *
 * Each fix is one the next check accepts: the match it names is a prefix of the url's identity;
 * an `http://` url is told the url its entry CAN push to, or the https url and the token to add;
 * a field it names to add never takes away a credential the entry already pushes with.
 */
export function pushRefusal(
  need: PushNeed,
  list: readonly GitCredential[],
  kinds: (entry: GitCredential) => readonly PushKind[] | undefined,
  signs: (entry: GitCredential) => boolean,
): { refusal: string } | { entry: GitCredential } {
  const { at, url } = need;
  const { scheme, identity } = repoIdentity(url);
  if (scheme === "local") {
    return {
      refusal: `${at}, a local path — jr2 never pushes to one: git's local transport runs that repository's config and hooks (ADR-0067)`,
    };
  }
  if (scheme === "git") {
    return { refusal: `${at} over git://, which carries no credential — bind the slot over https or ssh (ADR-0051)` };
  }
  const entry = matchCredential(identity, list);
  const held = entry === undefined ? [] : (kinds(entry) ?? []);
  if (scheme === "http") {
    const why =
      `${at} over http://, and jr2 sends a push credential over https or ssh only — a token over http is the ` +
      "token in the clear, and no ssh key is spent over http";
    if (entry === undefined) {
      return {
        refusal:
          `${why}; bind the slot to the https url, and add the entry it then spends: ` +
          `git: { credentials: [{ match: "${matchFor(identity)}", token: "${TOKEN_ENV}" }] } (ADR-0051)`,
      };
    }
    if (held.includes("token")) {
      return {
        refusal: `${why}; bind the slot to the https url (git.credentials entry "${entry.match}" then pushes with its token) (ADR-0051)`,
      };
    }
    if (held.includes("ssh")) {
      return {
        refusal: `${why}; bind the slot to the ssh url (git.credentials entry "${entry.match}" then pushes with its ssh key) (ADR-0051)`,
      };
    }
    return {
      refusal:
        `${why}; bind the slot to the https url, and add ${addLine(entry, "token")} to git.credentials entry ` +
        `"${entry.match}" — it holds no push credential (ADR-0051)`,
    };
  }
  const want: PushKind = scheme === "ssh" ? "ssh" : "token";
  if (entry === undefined) {
    const field = want === "ssh" ? `sshKey: "${SSH_SECRET}"` : `token: "${TOKEN_ENV}"`;
    return {
      refusal:
        `${at}, and no git.credentials entry matches "${identity}" — a push spends the entry its url ` +
        `matches; add one: git: { credentials: [{ match: "${matchFor(identity)}", ${field} }] } (ADR-0051)`,
    };
  }
  if (!held.includes(want)) {
    const other: PushKind = want === "ssh" ? "token" : "ssh";
    const why = `${at}, and git.credentials entry "${entry.match}" holds no credential a push over ${scheme} can spend`;
    // Its `push` field is the one credential it pushes with, and the field names one: the url that
    // spends it is the fix, as a second credential there would take the first away.
    if (entry.push !== undefined && held.includes(other)) {
      return {
        refusal:
          `${why} — its push field names ${other === "ssh" ? "an ssh key" : "a token"}, and a push field names ` +
          `one credential; bind the slot to ${other === "ssh" ? "the ssh url" : "the https url"} (ADR-0051)`,
      };
    }
    return {
      refusal:
        held.length === 0
          ? `${why} — an entry with none admits a clone, never a push; add ${addLine(entry, want)} to it (ADR-0051)`
          : `${why}; add ${addLine(entry, want)} to it (ADR-0051)`,
    };
  }
  if (need.sign && !signs(entry)) {
    return {
      refusal:
        `${at} signed, and git.credentials entry "${entry.match}" holds no sign field — add ` +
        `sign: { sshKey: "<a Secret with identity>", name: "<committer name>", email: "<committer email>" } ` +
        "to it; the email must belong to the forge account that holds the key (ADR-0051, ADR-0067)",
    };
  }
  return { entry };
}

const TOKEN_ENV = "<the env var that holds the token>";
const SSH_SECRET = "<a Secret with identity and known_hosts>";

/** The `match` a new entry needs to catch `identity`: its host and every directory above the
 * repository — always a prefix of the identity (`gitea.local/app` → `gitea.local/`). */
function matchFor(identity: string): string {
  return identity.slice(0, identity.lastIndexOf("/") + 1);
}

/** The field that gives `entry` a push credential of `kind` and keeps each one it pushes with: a
 * clone credential (`token`, `sshKey`) when it holds one and no `push` field — a clone credential
 * pushes too, and a `push` field would replace it — else a `push` field. */
function addLine(entry: GitCredential, kind: PushKind): string {
  const value = kind === "ssh" ? `sshKey: "${SSH_SECRET}"` : `token: "${TOKEN_ENV}"`;
  if (entry.push === undefined && (entry.token !== undefined || entry.sshKey !== undefined)) return value;
  return `push: { ${value} }`;
}

/** The refusal against the manifest `jr2 up` wrote: what the provision checks for any url. An entry
 * whose config holds what the push needs, and whose Secret `jr2 up` wrote without it — a token
 * unset, a key's Secret absent at the last `jr2 up` — is refused as that, never as a field to add. */
export function placedPushRefusal(
  need: PushNeed,
  list: readonly GitCredential[],
  manifest: GitPushManifest,
): { refusal: string } | { entry: GitPushEntry } {
  const placed = (entry: GitCredential) => manifest.entries.find((e) => e.match === entry.match);
  const out = pushRefusal(
    need,
    list,
    (entry) => placed(entry)?.push,
    (entry) => placed(entry)?.sign !== undefined,
  );
  if (!("refusal" in out)) return { entry: placed(out.entry)! };
  const written = pushRefusal(need, list, declaredPushKinds, (entry) => entry.sign !== undefined);
  // An http:// url is never pushed: the url to bind instead is read from the entry as written, so
  // a token whose variable was unset is named as the entry's, and the https url then says so.
  if (repoIdentity(need.url).scheme === "http" && "refusal" in written) return written;
  // As written, would the entry push? Then what is missing is what `jr2 up` could not place.
  if ("refusal" in written) return out;
  const entry = written.entry;
  const what =
    placed(entry) === undefined
      ? "no push credential"
      : need.sign && placed(entry)!.sign === undefined
        ? "no signing key"
        : "no credential for this url's scheme";
  return {
    refusal:
      `${need.at}, and jr2 up placed ${what} for git.credentials entry "${entry.match}" — its token's variable was ` +
      "not set, or a Secret it names did not exist, when jr2 up last ran; set it or create it, and run jr2 up again " +
      "(ADR-0051)",
  };
}

/** One key of an entry's push Secret, and where its value comes from: a token's value, or a key of
 * the Secret the entry names, copied as data. */
export type GitPushSource =
  | { key: string; literal: string }
  | { key: string; from: { secret: string; key: string }; optional?: boolean };

/** One entry's push Secret, as `jr2 up` plans it before it reads the cluster. */
export type GitPushPlan = {
  entry: GitPushEntry;
  sources: GitPushSource[];
};

/**
 * Each `git.credentials` entry's push Secret (B10): the entries whose declared push credentials
 * `jr2 up` can place. A token whose variable is unset is left out of its entry, as a kind it
 * cannot push with; an entry with nothing left is not written. `skipped` says why, by match.
 */
export function gitPushPlansOf(
  list: readonly GitCredential[],
  env: (name: string) => string | undefined,
): { plans: GitPushPlan[]; skipped: Map<string, string> } {
  const plans: GitPushPlan[] = [];
  const skipped = new Map<string, string>();
  list.forEach((entry, order) => {
    const sources: GitPushSource[] = [];
    const push: PushKind[] = [];
    const token = entry.push ? ("token" in entry.push ? entry.push.token : undefined) : entry.token;
    const sshKey = entry.push ? ("sshKey" in entry.push ? entry.push.sshKey : undefined) : entry.sshKey;
    if (sshKey !== undefined) {
      push.push("ssh");
      sources.push(
        { key: GIT_PUSH_KEYS.identity, from: { secret: sshKey, key: "identity" } },
        { key: GIT_PUSH_KEYS.identityPub, from: { secret: sshKey, key: "identity.pub" }, optional: true },
        { key: GIT_PUSH_KEYS.knownHosts, from: { secret: sshKey, key: "known_hosts" } },
      );
    }
    if (token !== undefined) {
      const value = env(token);
      if (value) {
        push.push("token");
        sources.push(
          { key: GIT_PUSH_KEYS.username, literal: "x-access-token" },
          { key: GIT_PUSH_KEYS.password, literal: value },
        );
      } else {
        skipped.set(entry.match, `its token's variable ${token} is not set — set it in .env`);
      }
    }
    if (push.length === 0) return;
    const sign = entry.sign;
    if (sign) {
      sources.push(
        "gpgKey" in sign
          ? { key: GIT_PUSH_KEYS.signGpg, from: { secret: sign.gpgKey, key: "private.asc" } }
          : { key: GIT_PUSH_KEYS.signSsh, from: { secret: sign.sshKey, key: "identity" } },
      );
    }
    const placed: GitPushEntry = {
      match: entry.match,
      order,
      secret: gitPushSecretName(entry.match),
      push: push.sort(),
      ...(sign ? { sign: "gpgKey" in sign ? ("gpg" as const) : ("ssh" as const) } : {}),
    };
    const entryJson = {
      match: entry.match,
      order,
      push: placed.push,
      ...(sign ? { sign: { format: placed.sign, name: sign.name, email: sign.email } } : {}),
    };
    sources.unshift({ key: GIT_PUSH_KEYS.entry, literal: JSON.stringify(entryJson) });
    plans.push({ entry: placed, sources });
  });
  return { plans, skipped };
}

/** The manifest the provision reads, or none when `jr2 up` wrote no push Secret. */
export async function readGitPushManifest(path: string): Promise<GitPushManifest> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [] };
    throw err;
  }
  const parsed = JSON.parse(raw) as GitPushManifest;
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`${path} is not a push manifest jr2 reads (version 1)`);
  }
  return parsed;
}
