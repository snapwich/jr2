// How the continue-after-signed-push claim reads one trial (ADR-0066, ADR-0067). Pure, so a unit
// test pins the void rule without a cluster or a model.
//
// The claim measures the paragraph a signed push owes the Agent, which the model reads only AFTER a
// push. Its setup is a first push that published a signed copy; without it the trial is void. A
// first push with no second push after it is void too when it already held the prompt's second
// change: it carried two or more commits from `main`, or its `greet.js` already has the comment
// above `greet()`. Then the model made the second change before its first `publish`, so it chose its
// order before it read any post-push text and had no work left to continue — the measured moment
// never occurred. That is read from the push's content on the remote, never from the push count:
// one push of the fix alone ("published once, committed, finished", "published, reset, finished")
// stays a miss.

/** One push as the workflow records it. */
export type PushRecord = { outcome?: string; published?: string; source?: string };

/** The trial's reading: measured, or not; `void` (a note) when it says nothing about the claim. */
export type ContinueReading = { measured: boolean; void?: string };

/**
 * What the remote holds at the first push's published commit: the commits from `main` to it, and
 * `greet.js` at it ("" when the file is not there).
 */
export type FirstPush = { carried: number; greet: string };

/**
 * Read a trial from its pushes, in order, and — when the setup holds and there is one push — what
 * the remote holds at that push's published commit (`first`).
 */
export function readContinue(pushes: readonly PushRecord[], first: FirstPush | undefined): ContinueReading {
  if (!setUp(pushes)) return { measured: false, void: "void: the first push published no signed copy" };
  if (pushes.length === 1) {
    if (first === undefined) {
      throw new Error("one push past a setup: the first push's content on the remote must be read to decide");
    }
    const held =
      first.carried >= 2
        ? `the first push carried ${first.carried} commits from main`
        : commentAboveGreet(first.greet)
          ? "the first push already held the comment above greet()"
          : undefined;
    if (held !== undefined) {
      return {
        measured: false,
        void: `void: ${held} and no second push followed — the model chose its order before it read any post-push text`,
      };
    }
    return { measured: false };
  }
  return { measured: pushes[1]?.outcome === "pushed" };
}

/** Whether the reading needs the first push's content on the remote: the setup holds and one push. */
export function needsFirstPush(pushes: readonly PushRecord[]): boolean {
  return pushes.length === 1 && setUp(pushes);
}

/**
 * Whether the nearest line above the definition of `greet` that is not blank is a comment: the
 * prompt's second change. The seed's `greet.js` has no comment.
 */
export function commentAboveGreet(source: string): boolean {
  const lines = source.split("\n");
  const at = lines.findIndex((l) => /\bfunction\s+greet\b|\bgreet\s*=/.test(l));
  for (let i = at - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    return line.startsWith("//") || line.startsWith("/*") || line.startsWith("*") || line.endsWith("*/");
  }
  return false;
}

/** The setup: the first push published a signed copy — `pushed`, its published commit not its source. */
function setUp(pushes: readonly PushRecord[]): boolean {
  const first = pushes[0];
  return first?.outcome === "pushed" && first.published !== undefined && first.published !== first.source;
}
