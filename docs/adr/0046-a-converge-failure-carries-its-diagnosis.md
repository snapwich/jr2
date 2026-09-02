# A converge failure carries its diagnosis

The failure that produced [ADR-0045](0045-the-platform-joins-the-image-address-and-the-cluster-chooses-it.md) surfaced
as `error: timed out waiting for the condition` — kubectl's verdict and nothing else. The cause (`exec format error` in
a CrashLoopBackOff pod) was found only by hand-running `kubectl get pods` and `kubectl logs`. The repo already holds the
precedent for what should have happened: `oneShotFailure()` (kube.ts) rethrows a one-shot probe's failure with the pod's
own output in front of kubectl's verdict, because the line that says WHY is exactly what the verdict drops. The rollout
wait is the same failure one layer up, and `j2 up` runs three of them (operator, Orchestrator, Instance Harness), all
equally blind.

## Decision

- **On rollout failure, the error carries the evidence**: for the deployment's pods — phase, container waiting reasons,
  the last events, and a container log tail — gathered after the timeout and rethrown in front of kubectl's verdict. One
  `rolloutFailure()` beside `oneShotFailure()`, used by all three rollout waits, so every layer gets the same eyes.
- **Named diagnoses annotate the evidence, never replace it.** A small pattern table layered on top names the cause and
  the way back when it matches: `exec format error` → "image platform X, node platform Y" plus `platforms`/`--force`
  (belt-and-braces under ADR-0045, and the only trace left for pre-0045 images and registry-ref Sandbox Images j2 never
  built); `ImagePullBackOff`/`ErrImagePull` → the ref and the registry it resolved to (the `docker.io/library/`
  normalization trap); `CrashLoopBackOff` → lead with the log tail, which IS the diagnosis; `CreateContainerConfigError`
  → name the missing object (already preflighted for `envFrom` Secrets — this catches what slips past). The hard rule
  that keeps the table honest: a named diagnosis may only interpret evidence that is also printed raw beneath it — a
  table that swallows evidence turns a wrong match into a lie; one that annotates it costs nothing when wrong.
- **Scope: the rollout wait only.** A converge that never reaches a rollout (config error, build error, apply error)
  keeps its existing errors — no general "dump the namespace on any error" reflex. Those failures already name
  themselves; the rollout timeout was the one that did not.

## Considered options

- **Evidence-only** (no pattern table). Rejected: the user still translates `exec format error` into "platform mismatch"
  themselves, which is the folklore step this ADR exists to delete. The table is small, bounded, and each entry is a
  failure someone actually hit.
- **Diagnosis as a separate command** (`j2 doctor`-style, run after the failure). Rejected: the moment of failure is
  when the evidence is fresh and the user is looking; a second command is the by-hand loop with a j2 badge on it.
