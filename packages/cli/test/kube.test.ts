// The one-shot probe's failure message (ADR-0019). `kubectl run --attach` puts the POD's output on
// kubectl's stdout and kubectl's own verdict on stderr, and execFile's rejection carries only the
// latter — so a preflight that failed inside the pod reported nothing about why. These cases pin
// the pod's words into the message the converge throws.

import { test } from "node:test";
import assert from "node:assert/strict";
import { oneShotFailure } from "../src/kube.ts";

/** What `promisify(execFile)` rejects with: a message built from stderr, plus both streams. */
function execFileRejection(stdout: string, stderr: string): Error {
  return Object.assign(new Error(`Command failed: kubectl run …\n${stderr}`), { stdout, stderr });
}

test("the pod's own output leads, and kubectl's verdict follows", () => {
  const err = oneShotFailure(
    execFileRejection(
      "[TypeError: fetch failed] { cause: ENOTFOUND vllm.example }\n",
      "pod ns/j2-provider-preflight-1 terminated (Error)\n",
    ),
  );
  const lines = err.message.split("\n");
  assert.equal(lines[0], "[TypeError: fetch failed] { cause: ENOTFOUND vllm.example }");
  assert.match(err.message, /terminated \(Error\)/);
});

test("a failure that attached nothing is passed through unchanged", () => {
  const original = execFileRejection("", "error: timed out waiting for the condition\n");
  assert.equal(oneShotFailure(original), original);
});

test("whitespace-only attached output does not add an empty line", () => {
  const err = oneShotFailure(execFileRejection("\n  \n", "pod ns/probe terminated (Error)\n"));
  assert.doesNotMatch(err.message, /^\s*\n/);
});

test("a non-Error rejection still yields an Error", () => {
  const err = oneShotFailure("kubectl is not installed");
  assert.ok(err instanceof Error);
  assert.equal(err.message, "kubectl is not installed");
});
