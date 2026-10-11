// What a push owes the author's Effector image (ADR-0068, B13). The Sandbox Effector runs in the
// author's image — the Sandbox Image by default — and runs jr2's own programs from one fixed PATH
// (`/usr/local/bin:/usr/bin:/bin`, never the image's own). So, per push form the Workspace holds,
// `jr2 up` reads the image it built — or, for the stock Harness image, which the kit builds, knows
// what it holds — and refuses, with the fix, an image that lacks what that form needs:
//
//   - ssh transport (`ssh://`, `git@`): `ssh`, and a passwd entry for the uid the Effector runs as —
//     OpenSSH's client calls `getpwuid(getuid())` before any option, and exits "No user exists for
//     uid N" without one;
//   - ssh signing (`sign: { sshKey }`): `ssh-keygen` (`-Y sign` does no passwd lookup);
//   - GPG signing (`sign: { gpgKey }`): `gpg` and `gpg-agent`;
//   - a token over https: nothing beyond `git`, the Sandbox Image floor (the helper is jr2's binary).
//
// The uid is the image's: its `USER` line by name or number, else 1000 (ADR-0037's fallback).
// `http` (a Worktree file body included) and the credentialed command owe nothing: the first is
// Go, the last is the author's argv.

/** Where the Effector looks for jr2's own programs: effector/internal/gitclean's Path. */
export const EFFECTOR_TOOL_DIRS = ["/usr/local/bin", "/usr/bin", "/bin"] as const;

/** One form a push of a Workspace takes, by what it owes its image. */
export type PushForm = "ssh-transport" | "ssh-sign" | "gpg-sign";

/** The programs each form needs, by name. */
const TOOLS: Record<PushForm, readonly string[]> = {
  "ssh-transport": ["ssh"],
  "ssh-sign": ["ssh-keygen"],
  "gpg-sign": ["gpg", "gpg-agent"],
};

/** What to install, by program: the package name on Debian and on Alpine, where they differ. */
const PACKAGES: Record<string, string> = {
  ssh: "openssh-client",
  "ssh-keygen": "openssh-client (Alpine: openssh-keygen)",
  gpg: "gnupg",
  "gpg-agent": "gnupg",
};

/**
 * What the stock Harness image holds of the forms' programs, and its /etc/passwd: the fallback
 * Sandbox Image, which the Sandbox Effector runs in when the Workspace names no image and the
 * instance has no `images/default`. The kit builds it (deploy/harness/Dockerfile, its last stage:
 * `node:24-slim` with `git` and `ca-certificates`, `USER 1000`, node's uid), so `jr2 up` knows it in both worlds
 * without reading it — a published one is never pulled to the host for this. A test holds the
 * Dockerfile to it.
 */
export const STOCK_HARNESS_IMAGE = {
  present: ["/usr/bin/git"],
  passwd: "root:x:0:0:root:/root:/bin/bash\nnode:x:1000:1000::/home/node:/bin/bash\n",
  user: "1000",
} as const;

/** Every path the forms' programs may be at: each program in each of the Effector's tool dirs. */
export function effectorImagePaths(forms: readonly PushForm[]): string[] {
  const out: string[] = [];
  for (const form of new Set(forms)) {
    for (const tool of TOOLS[form]) for (const dir of EFFECTOR_TOOL_DIRS) out.push(`${dir}/${tool}`);
  }
  return out;
}

/** The uid the Effector runs as, from the image's recorded `USER`: a name, a number, or — none
 * declared — ADR-0037's 1000. A `user:group` line decides by its user half. */
export function effectorSeat(user: string): { name: string } | { uid: number } {
  const head = user.split(":")[0]!.trim();
  if (head === "") return { uid: 1000 };
  if (/^\d+$/.test(head)) return { uid: Number(head) };
  return { name: head };
}

/** Whether /etc/passwd's text holds an entry for the seat. */
export function passwdHolds(passwd: string, seat: { name: string } | { uid: number }): boolean {
  for (const line of passwd.split("\n")) {
    const fields = line.split(":");
    if (fields.length < 3) continue;
    if ("name" in seat ? fields[0] === seat.name : fields[2] === String(seat.uid)) return true;
  }
  return false;
}

/**
 * Why the image cannot run the forms, with the fix, or undefined. `present` is which of
 * {@link effectorImagePaths} the image holds (links followed); `passwd` its `/etc/passwd`, "" when
 * it has none; `user` its recorded `USER`.
 */
export function effectorImageRefusal(input: {
  /** For the message: `Workspace of workflow "w"`. */
  label: string;
  ref: string;
  user: string;
  /** Each form, and the push it is for: `the push of Repo Slot "app"`. */
  forms: ReadonlyArray<{ form: PushForm; push: string }>;
  present: ReadonlySet<string>;
  passwd: string;
  /** The image is the stock Harness image: the fix is an image of the author's, not an install. */
  stock?: boolean;
}): string | undefined {
  const { label, ref } = input;
  for (const { form, push } of input.forms) {
    for (const tool of TOOLS[form]) {
      if (EFFECTOR_TOOL_DIRS.some((dir) => input.present.has(`${dir}/${tool}`))) continue;
      const why =
        form === "ssh-transport" ? "over ssh" : form === "ssh-sign" ? "signed with an ssh key" : "signed with GPG";
      if (input.stock) {
        return (
          `${label}: ${push} ${why} needs ${tool}, and its Sandbox Effector runs in the stock Harness image ${ref}, ` +
          `which holds git alone — the Workspace names no image and the instance has no images/default; give it an ` +
          `image that holds ${tool} (${PACKAGES[tool]}): an images/default Sandbox Image, the workspace()'s image, ` +
          `or its effector: { image } (ADR-0068)`
        );
      }
      return (
        `${label}: ${push} ${why} needs ${tool}, and its Sandbox Effector's image ${ref} holds none in ` +
        `${EFFECTOR_TOOL_DIRS.join(", ")} — the Effector runs jr2's programs from there alone; install it in the ` +
        `image (${PACKAGES[tool]}) (ADR-0068)`
      );
    }
    if (form !== "ssh-transport") continue;
    const seat = effectorSeat(input.user);
    if (passwdHolds(input.passwd, seat)) continue;
    const who = "name" in seat ? `user ${seat.name}` : `uid ${seat.uid}`;
    const fix =
      "name" in seat
        ? `a USER line naming a user the image's /etc/passwd holds`
        : `RUN adduser -D -u ${seat.uid} <name> in the image` +
          (input.user === "" ? " (the image declares no USER, so the Effector runs as uid 1000)" : "");
    return (
      `${label}: ${push} over ssh needs a passwd entry for the ${who} the Sandbox Effector runs as, and its image ` +
      `${ref} has none — ssh exits "No user exists for uid" before it connects; add ${fix} (ADR-0068)`
    );
  }
  return undefined;
}
