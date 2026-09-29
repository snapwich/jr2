// A Workspace's Size (ADR-0060): the refusal where it is read, the resolution chain, and the split
// inside the pod — the arithmetic the provision and `jr2 up` share.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertSize,
  assertUserSeat,
  cpuMillis,
  formatCpu,
  formatMemory,
  layerSize,
  memoryBytes,
  resolveSize,
  splitSize,
} from "../src/size.ts";

test("quantities: binary and decimal memory, whole and milli cpu, rounded up as Kubernetes rounds", () => {
  assert.equal(memoryBytes("2Gi"), 2 * 2 ** 30);
  assert.equal(memoryBytes("512Mi"), 512 * 2 ** 20);
  assert.equal(memoryBytes("1G"), 1e9);
  assert.equal(memoryBytes(1024), 1024);
  assert.equal(cpuMillis("2"), 2000);
  assert.equal(cpuMillis(0.5), 500);
  assert.equal(cpuMillis("1500m"), 1500);
  assert.equal(cpuMillis("0.0005"), 1, "below 1m rounds up to 1m");
  assert.equal(formatMemory(1984 * 2 ** 20), "1984Mi");
  assert.equal(formatMemory(2 * 2 ** 30), "2Gi");
  assert.equal(formatCpu(950), "950m");
  assert.equal(formatCpu(2000), "2");
});

test("a Size is limits.memory and limits.cpu ONLY — requests and every other key are refused by field", () => {
  assertSize("workspace(): resources", { limits: { memory: "3Gi", cpu: "2" } });
  assertSize("workspace(): resources", { limits: { memory: "3Gi" } });
  assertSize("workspace(): resources", { limits: {} });
  assert.throws(
    () => assertSize("workspace(): resources", { limits: { memory: "3Gi" }, requests: { memory: "1Gi" } }),
    /workspace\(\): resources\.requests is not accepted — jr2 reserves the whole Size/,
  );
  assert.throws(
    () => assertSize("workspace(): resources", { limits: { memory: "3Gi", "ephemeral-storage": "10Gi" } }),
    /resources\.limits\.ephemeral-storage is not accepted/,
  );
  assert.throws(() => assertSize("workspace(): resources", { claims: [] }), /resources\.claims is not accepted/);
  assert.throws(() => assertSize("workspace(): resources", { limits: { memory: "lots" } }), /limits\.memory: "lots"/);
  assert.throws(() => assertSize("workspace(): resources", { limits: { cpu: 0 } }), /limits\.cpu: 0 is not a positive/);
  assert.throws(() => assertSize("workspace(): resources", "2Gi"), /expected an object/);
  assert.throws(() => assertSize("workspace(): resources", {}), /resources\.limits: expected an object/);
});

test("the chain resolves whole Sizes: the Machine's, else the Instance default, then the kit", () => {
  assert.deepEqual(resolveSize(undefined, undefined), {
    memory: { bytes: 2 * 2 ** 30, from: "kit" },
    cpu: { millis: 1000, from: "kit" },
  });
  // The Instance default applies only to a Workspace that states NO Size (ADR-0060): a Machine
  // that states memory alone takes the kit's cpu, so its Size resolves the same on every Instance.
  assert.deepEqual(resolveSize({ limits: { memory: "4Gi" } }, { limits: { memory: "3Gi", cpu: "2" } }), {
    memory: { bytes: 4 * 2 ** 30, from: "machine" },
    cpu: { millis: 1000, from: "kit" },
  });
  // A Workspace with no Size takes the Instance default, and the kit fills what that leaves out.
  assert.deepEqual(resolveSize(undefined, { limits: { cpu: "2" } }), {
    memory: { bytes: 2 * 2 ** 30, from: "kit" },
    cpu: { millis: 2000, from: "instance" },
  });
  // A customize() layers over the workspace(), field by field.
  assert.deepEqual(layerSize({ limits: { memory: "3Gi", cpu: "2" } }, { limits: { cpu: "4" } }), {
    limits: { memory: "3Gi", cpu: "4" },
  });
});

test("the split: Custodian slice fixed, Harness the rest, requests = limits, pod-level = the whole Size", () => {
  const split = splitSize(resolveSize(undefined, undefined));
  assert.deepEqual(split.pod, { requests: { cpu: "1", memory: "2Gi" }, limits: { cpu: "1", memory: "2Gi" } });
  assert.deepEqual(split.custodian, {
    requests: { cpu: "50m", memory: "64Mi" },
    limits: { cpu: "50m", memory: "64Mi" },
  });
  assert.deepEqual(split.harness, {
    requests: { cpu: "950m", memory: "1984Mi", "ephemeral-storage": "10Gi" },
    limits: { cpu: "950m", memory: "1984Mi" },
  });
  assert.equal(split.user, undefined, "no split stated → no per-container limit on the User Container");
  assert.equal(split.shmSizeLimit, "496Mi", "25% of the Harness share");
  assert.deepEqual(split.preflight, { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "128Mi" } });
});

test("a stated User Container split comes out of the Harness share; requests = limits for what it states", () => {
  const split = splitSize(resolveSize({ limits: { memory: "3Gi", cpu: "2" } }, undefined), {
    limits: { memory: "1Gi" },
  });
  assert.deepEqual(split.user, { requests: { memory: "1Gi" }, limits: { memory: "1Gi" } });
  assert.equal(split.harness.limits!.memory, "1984Mi");
  assert.equal(split.harness.limits!.cpu, "1950m", "no cpu split → the User Container shares the Harness cpu");
});

test("a split that leaves the Harness below 256Mi is refused, naming each number and its source", () => {
  assert.throws(
    () => splitSize(resolveSize({ limits: { memory: "1Gi" } }, undefined), { limits: { memory: "800Mi" } }),
    (err: Error) =>
      /leaves the Harness container 160Mi memory, below its 256Mi floor/.test(err.message) &&
      /memory 1Gi \(the Machine's Size/.test(err.message) &&
      /the User Container's 800Mi \(its user\.resources\.limits\.memory\)/.test(err.message),
  );
  assert.throws(
    () => splitSize(resolveSize(undefined, { limits: { memory: "300Mi" } })),
    /sandbox\.resources\.limits\.memory in jr2\.config\.ts/,
  );
  assert.throws(
    () => splitSize(resolveSize({ limits: { cpu: "50m" } }, undefined)),
    /leaves the Harness container no cpu/,
  );
});

test("the User Container seat: a string, or { image, resources? } whose split is a Size", () => {
  assertUserSeat("workspace()", "ghcr.io/acme/sshd:1");
  assertUserSeat("workspace()", { image: "ghcr.io/acme/sshd:1", resources: { limits: { memory: "256Mi" } } });
  assert.throws(() => assertUserSeat("workspace()", ""), /`user` must be a non-empty string/);
  assert.throws(() => assertUserSeat("workspace()", { resources: {} }), /`user` must be a non-empty string/);
  assert.throws(
    () => assertUserSeat("workspace()", { image: "x", resources: { requests: { memory: "1Gi" } } }),
    /workspace\(\) user\.resources\.requests is not accepted/,
  );
  assert.throws(() => assertUserSeat("workspace()", { image: "x", env: [] }), /user\.env is not accepted/);
});
