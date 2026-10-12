// How the continue-after-signed-push claim reads one trial (ADR-0066, ADR-0067). Pure, so a unit
// test pins the void rule without a cluster or a model.
//
// The claim measures the paragraph a signed push owes the Agent, which the model reads only AFTER a
// push. Its setup is a first push that published a signed copy; without it the trial is void. A
// first push that already carried two or more commits from `main`, with no second push after it,
// is void too: the model made both commits before its first `publish`, so it chose its order before
// it read any post-push text and had no work left to continue — the measured moment never
// occurred. That is read from the push's content on the remote, never from the push count: one
// push of one commit ("published once, committed, finished", "published, reset, finished") stays
// a miss.

/** One push as the workflow records it. */
export type PushRecord = { outcome?: string; published?: string; source?: string };

/** The trial's reading: measured, or not; `void` (a note) when it says nothing about the claim. */
export type ContinueReading = { measured: boolean; void?: string };

/**
 * Read a trial from its pushes, in order, and — when the setup holds and there is one push — the
 * number of commits from `main` to that push's published commit on the remote (`firstCarried`).
 */
export function readContinue(pushes: readonly PushRecord[], firstCarried: number | undefined): ContinueReading {
  if (!setUp(pushes)) return { measured: false, void: "void: the first push published no signed copy" };
  if (pushes.length === 1) {
    if (firstCarried === undefined) {
      throw new Error("one push past a setup: the first push's commits from main must be read to decide");
    }
    if (firstCarried >= 2) {
      return {
        measured: false,
        void:
          `void: the first push carried ${firstCarried} commits from main and no second push followed — the model ` +
          "chose its order before it read any post-push text",
      };
    }
    return { measured: false };
  }
  return { measured: pushes[1]?.outcome === "pushed" };
}

/** Whether the reading needs the first push's commits from `main`: the setup holds and one push. */
export function needsCarried(pushes: readonly PushRecord[]): boolean {
  return pushes.length === 1 && setUp(pushes);
}

/** The setup: the first push published a signed copy — `pushed`, its published commit not its source. */
function setUp(pushes: readonly PushRecord[]): boolean {
  const first = pushes[0];
  return first?.outcome === "pushed" && first.published !== undefined && first.published !== first.source;
}
