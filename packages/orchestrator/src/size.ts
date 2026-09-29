// A Workspace's SIZE (ADR-0060): the ceiling it states for its whole Sandbox, cpu and memory and
// nothing else, which jr2 reserves in full. The shape is Agent Substrate's `ActorTemplate.resources`
// — a Kubernetes `ResourceRequirements` of which only `limits.cpu` and `limits.memory` are
// accepted — so a Workspace moves there unchanged.
//
// This module is the arithmetic and the refusals, with no Kubernetes client and no Machine in it:
//
//   - `assertSize` refuses anything but the two limits WHERE IT IS READ (`workspace()`,
//     `customize()`, `jr2.config.ts`), naming the field — a request below the limit, a missing
//     memory limit, or a key Substrate refuses would make the Machine depend on something the move
//     drops.
//   - `resolveSize` walks the chain, most specific first, one field at a time: the Machine's Size
//     (a `customize()` layered over the `workspace()`), then the Instance's `sandbox.resources` — a
//     default for a Workspace that states none, never an override of one it states — then the kit.
//   - `splitSize` divides the Size inside the pod: the Custodian's fixed slice, the User
//     Container's split if the Machine states one, and the Harness gets the rest as its own limit,
//     so an OOM stays per container where it can. It refuses a split that leaves the Harness below
//     its floor, naming where each number came from, because the fix is an edit of one of them.
//
// Both the provision (sandbox-kube.ts) and `jr2 up` call the same two functions, so a Size the
// converge admits is a Size the provision composes.

/** A Kubernetes quantity: `"2Gi"`, `"1500m"`, `"2"`, or a plain number (`2` cpus, bytes of memory). */
export type Quantity = string | number;

/**
 * A Size (ADR-0060, CONTEXT.md "Size"): `limits.memory` and `limits.cpu`, nothing else. A field
 * left out resolves down the chain (`resolveSize`) — the Instance's `sandbox.resources`, then the
 * kit default of 2Gi and 1 cpu.
 *
 * The same shape is the User Container's split (`user: { image, resources }`), where a field left
 * out means the seat has no limit of its own for it and shares the pod's budget.
 */
export type Size = { limits: { memory?: Quantity; cpu?: Quantity } };

/** The kit's default Size (ADR-0060). Node gives each process a V8 heap of about 55% of its
 * container limit, and `tsc` on a mid-size repo aborted below about 1.1Gi, so 1Gi fails a common
 * task; 2Gi covers `tsc` + vitest, `cargo build` and Playwright at 2 workers. */
export const KIT_SIZE = { memory: "2Gi", cpu: "1" } as const;

/** The Custodian's fixed slice of every Sandbox's Size (ADR-0060). */
export const CUSTODIAN_SLICE = { memory: "64Mi", cpu: "50m" } as const;

/** The Harness container's floor: a split that leaves it less memory than this is refused. */
export const HARNESS_FLOOR = "256Mi";

/** `/dev/shm` is 25% of the Harness container's share, never below this (ADR-0060). */
export const SHM_FLOOR = "64Mi";

/** The `/work` disk: an ephemeral-storage REQUEST on the Harness container, with no limit and no
 * `sizeLimit` — passing either evicts the pod and loses `/work` (ADR-0060). Kit-fixed. */
export const WORK_DISK_REQUEST = "10Gi";

/** The preflight init step's resources (ADR-0037): small and fixed, and inside the pod's budget —
 * an init container runs before the others start, so it borrows the pod's Size, it adds nothing. */
export const PREFLIGHT_RESOURCES = {
  requests: { cpu: "10m", memory: "32Mi" },
  limits: { memory: "128Mi" },
} as const;

/** A container's or a pod's resources, in the Kubernetes (corev1.ResourceRequirements) shape. */
export type ResourceRequirements = {
  requests?: Record<string, string>;
  limits?: Record<string, string>;
};

// --- quantities --------------------------------------------------------------------------------

const QUANTITY = /^(\d+(?:\.\d+)?|\.\d+)(m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/;
const SCALE: Record<string, number> = {
  "": 1,
  m: 1e-3,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};

/** The quantity as a plain number of base units, or undefined when it is not one Kubernetes reads.
 * Zero and negatives are not a Size: a zero limit is a container that cannot start. */
function baseUnits(q: unknown): number | undefined {
  if (typeof q === "number") return Number.isFinite(q) && q > 0 ? q : undefined;
  if (typeof q !== "string") return undefined;
  const m = QUANTITY.exec(q.trim());
  if (!m) return undefined;
  const value = Number(m[1]) * SCALE[m[2] ?? ""]!;
  return value > 0 ? value : undefined;
}

/** Memory in bytes, rounded up as Kubernetes rounds it. */
export function memoryBytes(q: Quantity): number {
  const v = baseUnits(q);
  if (v === undefined) throw new Error(`${JSON.stringify(q)} is not a memory quantity (e.g. "2Gi", "512Mi")`);
  return Math.ceil(v - 1e-9);
}

/** CPU in millicores, rounded up to 1m as Kubernetes rounds it. */
export function cpuMillis(q: Quantity): number {
  const v = baseUnits(q);
  if (v === undefined) throw new Error(`${JSON.stringify(q)} is not a cpu quantity (e.g. "2", "1500m")`);
  return Math.ceil(v * 1000 - 1e-9);
}

/** Bytes as the quantity a human would write: `Gi`, `Mi` or `Ki` when exact, else plain bytes. */
export function formatMemory(bytes: number): string {
  for (const [unit, scale] of [
    ["Gi", 2 ** 30],
    ["Mi", 2 ** 20],
    ["Ki", 2 ** 10],
  ] as const) {
    if (bytes % scale === 0) return `${bytes / scale}${unit}`;
  }
  return String(bytes);
}

/** Millicores as the quantity a human would write: whole cpus when exact, else `m`. */
export function formatCpu(millis: number): string {
  return millis % 1000 === 0 ? String(millis / 1000) : `${millis}m`;
}

// --- the refusal where a Size is read ----------------------------------------------------------

/**
 * Refuse anything but a Size, BY FIELD (ADR-0060): `requests`, any key beside `limits`, any limit
 * beside `memory` and `cpu`, or a value Kubernetes would not read. `where` names the reader and the
 * field's own path (`workspace(): resources`, `jr2.config.ts at sandbox.resources`), so the message
 * points at the text to edit. An empty `limits` is legal and states nothing: every field resolves
 * down the chain.
 */
export function assertSize(where: string, value: unknown): asserts value is Size {
  const hint = "a Size is { limits: { memory?, cpu? } } and nothing else — Agent Substrate's template size (ADR-0060)";
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected an object (got ${JSON.stringify(value)}) — ${hint}`);
  }
  for (const key of Object.keys(value)) {
    if (key === "limits") continue;
    const why =
      key === "requests"
        ? "is not accepted — jr2 reserves the whole Size, so every request equals its limit"
        : "is not accepted";
    throw new Error(`${where}.${key} ${why} — ${hint}`);
  }
  const limits = (value as { limits?: unknown }).limits;
  if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
    throw new Error(`${where}.limits: expected an object (got ${JSON.stringify(limits)}) — ${hint}`);
  }
  for (const [key, q] of Object.entries(limits)) {
    if (key !== "memory" && key !== "cpu") {
      throw new Error(`${where}.limits.${key} is not accepted — ${hint}`);
    }
    if (q === undefined) continue;
    if (baseUnits(q) === undefined) {
      const eg = key === "memory" ? '"2Gi", "512Mi"' : '"2", "1500m"';
      throw new Error(`${where}.limits.${key}: ${JSON.stringify(q)} is not a positive quantity (e.g. ${eg})`);
    }
  }
}

/** Layer one Size over another, field by field — `customize(machine, { resources })` over the
 * `workspace()`'s own, as an Agent override layers over its stock definition. */
export function layerSize(base: Size | undefined, over: Size | undefined): Size | undefined {
  if (over === undefined) return base;
  if (base === undefined) return over;
  return { limits: { ...base.limits, ...over.limits } };
}

// --- resolution --------------------------------------------------------------------------------

/** Where a resolved number came from — what a refusal names, because the fix is an edit THERE. */
export type SizeSource = "machine" | "instance" | "kit";

/** A Size resolved to numbers, each with its source. */
export type ResolvedSize = {
  memory: { bytes: number; from: SizeSource };
  cpu: { millis: number; from: SizeSource };
};

/**
 * The chain (ADR-0060), one field at a time: the Machine's Size (its `workspace()`, with any
 * `customize()` already layered over it), then the Instance's `sandbox.resources`, then the kit.
 * The Instance default reaches only a field the Machine left out — it never overrides a stated one,
 * so each fact has one override path, and that path is `customize()`.
 */
export function resolveSize(machine: Size | undefined, instance: Size | undefined): ResolvedSize {
  const pick = (field: "memory" | "cpu"): { q: Quantity; from: SizeSource } => {
    const m = machine?.limits[field];
    if (m !== undefined) return { q: m, from: "machine" };
    const i = instance?.limits[field];
    if (i !== undefined) return { q: i, from: "instance" };
    return { q: KIT_SIZE[field], from: "kit" };
  };
  const memory = pick("memory");
  const cpu = pick("cpu");
  return {
    memory: { bytes: memoryBytes(memory.q), from: memory.from },
    cpu: { millis: cpuMillis(cpu.q), from: cpu.from },
  };
}

// --- the split inside the pod ------------------------------------------------------------------

/**
 * One Sandbox pod's resources, as the CR carries them (ADR-0060). Every request equals its limit —
 * the pod is Guaranteed, and the CPU limit is enforced — except the Harness container's
 * `ephemeral-storage`, a request with no limit, and the preflight's small fixed step.
 */
export type SizeSplit = {
  /** The whole Size, pod-level (KEP-2837): the ceiling the pod never passes. */
  pod: ResourceRequirements;
  /** The rest of the Size, after the Custodian and the User Container. */
  harness: ResourceRequirements;
  custodian: ResourceRequirements;
  /** Only when the Machine states a split for the User Container; otherwise it has no limit of its
   * own and shares the pod's budget. */
  user?: ResourceRequirements;
  preflight: ResourceRequirements;
  /** The `/dev/shm` emptyDir's `sizeLimit`: 25% of the Harness share, minimum 64Mi. */
  shmSizeLimit: string;
  /** The Harness container's memory limit in bytes — what layer 4 of ADR-0061 guards. */
  harnessMemoryBytes: number;
};

const SOURCE_TEXT: Record<SizeSource, (field: "memory" | "cpu") => string> = {
  machine: (f) => `the Machine's Size — its workspace()'s resources.limits.${f}, or a customize() of it`,
  instance: (f) =>
    `sandbox.resources.limits.${f} in jr2.config.ts, the Instance's default for a Workspace that states none`,
  kit: () => "the kit default — the Workspace states no Size",
};

/**
 * Split a resolved Size inside the pod (ADR-0060), or refuse. `user` is the User Container's split
 * as the Machine stated it. The refusal names each number and where it came from, because the fix
 * is one of them: a larger Size, or a smaller split.
 */
export function splitSize(size: ResolvedSize, user?: Size): SizeSplit {
  const custodian = { memory: memoryBytes(CUSTODIAN_SLICE.memory), cpu: cpuMillis(CUSTODIAN_SLICE.cpu) };
  const userMemory = user?.limits.memory !== undefined ? memoryBytes(user.limits.memory) : undefined;
  const userCpu = user?.limits.cpu !== undefined ? cpuMillis(user.limits.cpu) : undefined;
  const harnessMemory = size.memory.bytes - custodian.memory - (userMemory ?? 0);
  const harnessCpu = size.cpu.millis - custodian.cpu - (userCpu ?? 0);

  const floor = memoryBytes(HARNESS_FLOOR);
  if (harnessMemory < floor) {
    throw new Error(
      `the Size leaves the Harness container ${harnessMemory > 0 ? formatMemory(harnessMemory) : "no"} memory, below its ` +
        `${HARNESS_FLOOR} floor: memory ${formatMemory(size.memory.bytes)} (${SOURCE_TEXT[size.memory.from]("memory")}) ` +
        `− the Custodian's ${CUSTODIAN_SLICE.memory}` +
        (userMemory !== undefined
          ? ` − the User Container's ${formatMemory(userMemory)} (its user.resources.limits.memory)`
          : "") +
        " — raise the Size's limits.memory, or shrink the User Container's split (ADR-0060)",
    );
  }
  if (harnessCpu <= 0) {
    throw new Error(
      `the Size leaves the Harness container no cpu: cpu ${formatCpu(size.cpu.millis)} ` +
        `(${SOURCE_TEXT[size.cpu.from]("cpu")}) − the Custodian's ${CUSTODIAN_SLICE.cpu}` +
        (userCpu !== undefined ? ` − the User Container's ${formatCpu(userCpu)} (its user.resources.limits.cpu)` : "") +
        " — raise the Size's limits.cpu, or shrink the User Container's split (ADR-0060)",
    );
  }

  const exact = (memory: number, cpu: number): ResourceRequirements => {
    const limits = { cpu: formatCpu(cpu), memory: formatMemory(memory) };
    return { requests: { ...limits }, limits };
  };
  const harness = exact(harnessMemory, harnessCpu);
  harness.requests!["ephemeral-storage"] = WORK_DISK_REQUEST;

  let userResources: ResourceRequirements | undefined;
  if (userMemory !== undefined || userCpu !== undefined) {
    const limits: Record<string, string> = {
      ...(userCpu !== undefined ? { cpu: formatCpu(userCpu) } : {}),
      ...(userMemory !== undefined ? { memory: formatMemory(userMemory) } : {}),
    };
    userResources = { requests: { ...limits }, limits };
  }

  return {
    pod: exact(size.memory.bytes, size.cpu.millis),
    harness,
    custodian: exact(custodian.memory, custodian.cpu),
    ...(userResources ? { user: userResources } : {}),
    preflight: {
      requests: { ...PREFLIGHT_RESOURCES.requests },
      limits: { ...PREFLIGHT_RESOURCES.limits },
    },
    shmSizeLimit: formatMemory(Math.max(memoryBytes(SHM_FLOOR), Math.floor(harnessMemory / 4))),
    harnessMemoryBytes: harnessMemory,
  };
}

// --- the User Container seat -------------------------------------------------------------------

/**
 * The User Container as a Machine states it (ADR-0005, ADR-0060): an image in ADR-0037's two
 * shapes, and optionally its split of the Size. The object form exists for the split alone.
 */
export type UserContainer = { image: string; resources?: Size };

/** The `user` option in either shape, read as its two halves. */
export function userSeatOf(user: string | UserContainer | undefined): { image?: string; resources?: Size } {
  if (user === undefined) return {};
  if (typeof user === "string") return { image: user };
  return { image: user.image, ...(user.resources !== undefined ? { resources: user.resources } : {}) };
}

/**
 * Refuse a malformed `user` where it is written — a non-empty image string, or `{ image,
 * resources? }` whose split is a Size. `where` names the caller (`workspace()`, `customize()`).
 */
export function assertUserSeat(where: string, value: unknown): asserts value is string | UserContainer {
  const image = typeof value === "object" && value !== null ? (value as { image?: unknown }).image : value;
  if (typeof image !== "string" || !image) {
    throw new Error(
      `${where}: \`user\` must be a non-empty string (an image), or { image, resources? } (got ${JSON.stringify(value)}) — ` +
        'either a `file:` URL to a docker context this module ships (`import.meta.resolve("./image")`) or a ' +
        "registry ref (ADR-0037, ADR-0060).",
    );
  }
  if (typeof value !== "object" || value === null) return;
  for (const key of Object.keys(value)) {
    if (key !== "image" && key !== "resources") {
      throw new Error(
        `${where}: user.${key} is not accepted — the User Container is { image, resources? } (ADR-0005, ADR-0060)`,
      );
    }
  }
  const resources = (value as { resources?: unknown }).resources;
  if (resources !== undefined) assertSize(`${where} user.resources`, resources);
}
