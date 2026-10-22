# pi 0.82.1 replay fixtures

What `@earendil-works/pi-agent-core` 0.82.1's own code answered for a corpus of inputs. jr2 ported that code when pi 1.x
removed it (Compaction, the `read`, `write` and `edit` tools, and the `bash` tool's output).
`test/replay-pi-0.82.1.test.ts` runs each port over the same inputs and compares the answers byte for byte.

| File              | Holds                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compaction.json` | A transcript in the engine part's format, the cut settings, the model and the thinking level; 0.82.1's cut, each summary request (system prompt, messages, options) and its result. |
| `file-tools.json` | The files before the call, the tool and its arguments; 0.82.1's content or error, and for `write` and `edit` the files after the call.                                              |
| `bash.json`       | A command; 0.82.1's text or error, and the size of the full-output file when the output was cut.                                                                                    |

Machine-specific values are stand-ins: the temporary directory is `<dir>`, a full-output path is `<full-output>`.

## How they were made

The script is `packages/harness/scripts/pi-0.82.1-fixtures.mjs` in the `pi-golden` worktree (main at `fdc8ce7`, where pi
0.82.1 is installed). It is not in this tree, because it imports pi 0.82.1. From that worktree's `packages/harness`:

```sh
node scripts/pi-0.82.1-fixtures.mjs <this folder>
```

A Submission's mark in a transcript (`{"type":"submission"}`) is written to pi's session as the tool-set entry that pi
0.82.1 wrote before each prompt. A Compaction's `firstKept` index becomes the id of that entry.

Two changes are not in the corpus, because the port changes them on purpose: `write` counts UTF-8 bytes (pi counted
UTF-16 units, the same number for ASCII text), and a shell that a signal killed names the signal. Their own tests are in
`test/file-tools.test.ts` and `test/bash-tool.test.ts`.
