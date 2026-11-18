// The Custodian (ADR-0059, ADR-0084): the part of an Instance that holds the credentials of its
// Harness pods and carries their traffic out — the Agent's Menu and the ask toward the Orchestrator
// (ADR-0013, ADR-0053), and each connection of a pod on the Fence. It is one pod on each Sandbox
// node, outside every Harness pod (`custodian-rules.ts` renders what its Envoy is told).
//
// Its engine is Envoy, the upstream distroless image pinned by digest: jr2 deploys it and never
// builds it (ADR-0038). This module holds the facts that the renderer, the control process, the
// Sandbox's composition and `jr2 up` share: the image, the control routes and their replies, the
// paths in a Harness pod, and the ports and files of the Custodian pod.
//
// The Custodian is a separate pod from each Harness, and that is the point: the Agent executes code
// in the Harness container and nothing in the Custodian (ADR-0005). The Harness container gets the
// Stand-ins, every one but the public fetch Stand-in secret, as files under `/run/jr2/` that no
// child the Harness confines can read (ADR-0076).

import { readFileSync } from "node:fs";
import { CUSTODIAN_PROGRAM_KEY } from "./names.ts";

/**
 * The Custodian's image: Envoy's upstream distroless build, pinned by the digest of its multi-arch
 * index. Deployed, never built (ADR-0038) — jr2 writes Envoy's configuration, not Envoy. The tag
 * rides along for a human reading a pod spec; the digest is what a node pulls. `kitRegistry`
 * re-homes it like a Kit image, and `jr2 kit push` mirrors it (ADR-0044).
 */
export const CUSTODIAN_IMAGE = {
  repo: "envoyproxy/envoy",
  tag: "distroless-v1.39.1",
  digest: "sha256:eb2c01c13125d1629637cb4e4cce7207009fb7cc2c8027f9742758549d15b6f4",
} as const;

/** The Custodian's ref, at its canonical home or re-homed onto a `kitRegistry` mirror — the same
 * two answers `publishedKitRefs` gives a Kit image (ADR-0044). */
export function custodianRef(kitRegistry?: string): string {
  const { repo, tag, digest } = CUSTODIAN_IMAGE;
  const home = kitRegistry ? `${kitRegistry.replace(/\/+$/, "")}/${repo.split("/").pop()}` : `docker.io/${repo}`;
  return `${home}:${tag}@${digest}`;
}

/** Where the Harness and the Custodian see the `jr2-ca` ConfigMap (ADR-0020). */
export const CA_MOUNT = "/etc/jr2/ca";

/** Where the Harness container holds its Stand-ins (ADR-0059, ADR-0076): a read-only mount that no
 * child the Harness confines can read — the confiner denies all of `/run/jr2`. Never env. */
export const HARNESS_CREDENTIALS = "/run/jr2";
/** The secret control Stand-in, as the Harness reads it once at start (C1). */
export const CONTROL_STANDIN_FILE = `${HARNESS_CREDENTIALS}/control/standin`;
/** The directory of the held secrets' Stand-ins, one file per name: `<dir>/<NAME>`. */
export const STANDINS_DIR = `${HARNESS_CREDENTIALS}/standins`;
/** The Harness env that names the control Stand-in's file; its default is {@link CONTROL_STANDIN_FILE}. */
export const CONTROL_STANDIN_FILE_ENV = "JR2_CONTROL_STANDIN_FILE";
/** The Harness env that names the held secrets the `workspace()` grants a confined child (its
 * `secrets` list, ADR-0076), comma-separated: names, never a value. Absent → none is granted. */
export const GRANTED_SECRETS_ENV = "JR2_GRANTED_SECRETS";
/** The Harness container's credentials volume: its Stand-ins, mounted at {@link HARNESS_CREDENTIALS}. */
export const HARNESS_CREDENTIALS_VOLUME = "harness-credentials";

/**
 * The keys of a pod's Stand-in Secret (a Sandbox's `<sandbox>-standins`): the secret control
 * Stand-in, and one secret Stand-in per held secret ({@link heldStandInKey}). The pod's maker mints
 * them. The tokens are in the pod's slot Secret, which only the Custodian reads.
 */
export const CREDENTIAL_KEYS = {
  controlStandIn: "control-standin",
} as const;

/** The key of one held secret's secret Stand-in in its pod's Stand-in Secret. */
export function heldStandInKey(name: string): string {
  return `standin-${name}`;
}

/** The file of a Stand-in among the Custodian's values: beside its value, `<NAME>.standin`. A held
 * name is an env var's, so it holds no `.` and never meets another value's file. */
export function standInValueFile(name: string): string {
  return `${name}.standin`;
}

/** The path prefixes each control credential may ride, after the control listener's rewrite
 * (ADR-0076, C3): the control token on the agent routes alone, the fetch token on the fetch route
 * alone. The program's path guard refuses either one elsewhere, before any swap. */
export const CONTROL_PATHS = "/agents/";
export const FETCH_PATHS = "/sandboxes/";

/** Where the Orchestrator's Service is, from the Custodian pod. */
export type OrchestratorAddress = { host: string; port: number };

type Json = Record<string, unknown>;

const LUA_FILTER = "envoy.filters.http.lua";

/** Route metadata the program reads its role and target from. */
function meta(fields: Record<string, string>): Json {
  return { filter_metadata: { [LUA_FILTER]: fields } };
}

/** Envoy's flags for a request it did not send to the target (ADR-0059): the connection failed, no
 * host was healthy, the DNS lookup failed. */
export const NOT_SENT_FLAGS = ["UF", "UH", "DF"] as const;

/** Envoy's flags for a request that may have reached the target before the stream ended (ADR-0059):
 * the target closed the connection or reset the stream, Envoy reset it, a protocol error on either
 * side (a body framing error can come after the headers went). `UMSDR` (the maximum stream
 * duration) ends a stream that was sent. `URX` (the retry limit) comes with the last attempt's own
 * flag (`UF,URX`, `UC,URX`), so alone it says nothing of the send; the mapper for
 * {@link NOT_SENT_FLAGS} comes first, so `UF,URX` still reads "could not be reached". These routes
 * set no retry policy and no `max_stream_duration`, so Envoy sets neither flag on them; they keep
 * the union equal to ORCHESTRATOR_UNREACHABLE's. */
export const MAY_HAVE_SENT_FLAGS = ["UC", "DPE", "UMSDR", "URX", "UPE", "UR", "LR"] as const;

/** One of the Custodian's own 502s for a target that gave no answer (§5.4): the target, what
 * jr2 knows about the request, and Envoy's reason — never a retry without verification. */
function noAnswer(target: string, flags: readonly string[], words: string): Json {
  return {
    filter: { response_flag_filter: { flags: [...flags] } },
    status_code: 502,
    body_format_override: {
      text_format_source: {
        inline_string: `jr2 custodian: ${target} ${words}: %RESPONSE_CODE_DETAILS% %UPSTREAM_TRANSPORT_FAILURE_REASON%\n`,
      },
    },
  };
}

const NOT_REACHED = "could not be reached";
const MAY_HAVE_REACHED = "did not answer; the request may have reached it";

/**
 * An intercepted target that gave no answer (ADR-0059). Two mappers, because the words must be
 * true: after a `NOT_SENT_FLAGS` failure the target did not get the request, and after a
 * `MAY_HAVE_SENT_FLAGS` one it may have it — so an Agent that sends a POST again can write twice,
 * and the text must not tell it the first one went nowhere. One reply can carry several flags,
 * and Envoy uses the first mapper that matches, in order: the `NOT_SENT_FLAGS` mapper is first, so
 * a reply with `UF`, `UH` or `DF` reads "could not be reached" whatever else it carries. Without
 * the mappers, Envoy answers each of these flags itself (503 for most, 502 for `UPE`) with a body
 * that names no target, which a caller can read as the target's answer. No caller reads the flags;
 * the Orchestrator route's go to the Harness, which tells "never reached" from "not known"
 * (ADR-0002).
 */
export function unreachable(target: string): Json {
  return {
    mappers: [noAnswer(target, NOT_SENT_FLAGS, NOT_REACHED), noAnswer(target, MAY_HAVE_SENT_FLAGS, MAY_HAVE_REACHED)],
  };
}

/** The Orchestrator unreachable, said so the Harness can tell it from an answer and retry the
 * surface read the way ADR-0042 asks — the one route on this pod that retries. */
export const ORCHESTRATOR_UNREACHABLE: Json = {
  mappers: [
    {
      // Envoy's own answers for a stream it reset (`UPE`, `UR`, `LR`: 503, or 502 for `UPE`) are said
      // here too, so the Harness reads them as "not known" and not as a stopping Orchestrator's 503
      // (ADR-0002). One text for
      // both lists: the Harness reads the flags, not the words.
      filter: { response_flag_filter: { flags: [...NOT_SENT_FLAGS, ...MAY_HAVE_SENT_FLAGS] } },
      status_code: 502,
      headers_to_add: [
        { header: { key: "x-jr2-custodian", value: "unreachable" }, append_action: "OVERWRITE_IF_EXISTS_OR_ADD" },
      ],
      body_format_override: {
        json_format: {
          error: "the Orchestrator never answered through the Custodian",
          detail: "%RESPONSE_CODE_DETAILS% %UPSTREAM_TRANSPORT_FAILURE_REASON%",
          flags: "%RESPONSE_FLAGS%",
        },
      },
    },
  ],
};

/** One route toward the Orchestrator (ADR-0059): its name, its method, the path it takes, and
 * which resets Envoy sends again. */
export type ControlRoute = { name: string; method: "GET" | "POST"; regex: string; retryOn: string };

/**
 * The six routes the Custodian forwards to the Orchestrator, and no other (ADR-0059): the five agent
 * routes, then the ask. A read retries any reset. A pick and the ask retry only a reset before they
 * were sent: one the Orchestrator may have read is not sent twice. An outstanding pick's answer is
 * long-polled (ADR-0024) and is a read, so an Orchestrator restart mid-poll costs a retry, not the
 * pick. Notices marked heard twice (ADR-0062, ADR-0076) and a batch of the conversation's entries
 * sent twice (ADR-0023) change nothing, so any reset is retried.
 */
export const CONTROL_ROUTES: readonly ControlRoute[] = [
  { name: "surface", method: "GET", regex: "/agents/[^/]+/surface", retryOn: "reset,connect-failure" },
  { name: "events", method: "POST", regex: "/agents/[^/]+/events", retryOn: "reset-before-request,connect-failure" },
  { name: "deliveries", method: "GET", regex: "/agents/[^/]+/deliveries/[^/]+", retryOn: "reset,connect-failure" },
  { name: "notices", method: "POST", regex: "/agents/[^/]+/notices", retryOn: "reset,connect-failure" },
  { name: "conversation", method: "POST", regex: "/agents/[^/]+/conversation", retryOn: "reset,connect-failure" },
  { name: "fetch", method: "POST", regex: "/fetch", retryOn: "reset-before-request,connect-failure" },
];

/** One of {@link CONTROL_ROUTES} as an Envoy route to the `orchestrator` cluster, with the role and
 * the route name that the program reads. */
export function controlRoute(r: ControlRoute): Json {
  return {
    name: r.name,
    match: { safe_regex: { regex: r.regex }, headers: [{ name: ":method", string_match: { exact: r.method } }] },
    route: {
      cluster: "orchestrator",
      timeout: "0s",
      auto_host_rewrite: true,
      retry_policy: { retry_on: r.retryOn, num_retries: 2 },
    },
    metadata: meta({ role: "control", route: r.name }),
  };
}

// ---- the program ---------------------------------------------------------------------------------

/** `custodian.lua` beside this module — the fixed Lua of each slot listener, as written. `jr2 up`
 * puts it in the Custodian's ConfigMap (`CUSTODIAN_PROGRAM_KEY`), and each slot's own table, which
 * the control process writes, loads it. */
export const CUSTODIAN_PROGRAM: string = readFileSync(new URL("./custodian.lua", import.meta.url), "utf8");

// ---- the Custodian of an Instance (ADR-0084) -----------------------------------------------------
//
// One Custodian pod on each Sandbox node, outside every Harness pod. `custodian-rules.ts` renders
// what its Envoy is told; these are the fixed facts that the renderer, the control process (M5) and
// `jr2 up` (M8) share.

/** jr2's own name (ADR-0059, ADR-0084): the resolver of each slot answers it with the first address
 * of the placeholder range, and it is an Intercepted host of every Harness pod. The control routes
 * are HTTPS on its port 443; the fetch route is on 443 and on plain HTTP port 80. */
export const JR2_CUSTODIAN_NAME = "custodian.jr2.internal";

/** The slots of one Instance (ADR-0084): its range of VLANs. Slot 0 is the Instance Harness, slot 1
 * the check pod, slot 2 the node probe, and slots 3–127 the Sandboxes. */
export const FENCE_SLOTS = 128;
/** The uplink sends the TCP of slot i to port `SLOT_LISTENER_BASE + i` and its DNS to port
 * `SLOT_RESOLVER_BASE + i`, by one static map: the port, not a source address, names the slot. */
export const SLOT_LISTENER_BASE = 20000;
export const SLOT_RESOLVER_BASE = 25000;

/** The bounds of the Custodian pod's one cache of names, which every slot of the pod shares
 * (ADR-0084): the names it holds, and the lookups in flight. Envoy's defaults (1,024 of each) are 8
 * names for each slot of a full range; these are 64 names and 32 lookups for each slot. A name that
 * no dial used for `CUSTODIAN_NAME_TTL` leaves the cache. While the cache is full, a new name of each
 * slot is refused with jr2's reason (`reason=name-cache`). */
export const CUSTODIAN_NAME_CACHE = { hosts: 64 * FENCE_SLOTS, pending: 32 * FENCE_SLOTS } as const;
export const CUSTODIAN_NAME_TTL = "300s";

/** The connection bounds of a Custodian pod (ADR-0059, ADR-0084). `pod` is Envoy's global limit:
 * the connections of all slot listeners of the pod together. `dial` is the inbound listener's own
 * bound, outside the global limit: the Orchestrator's dials to the pod's slots, 4 connections for
 * each of 128 slots × 2 ports, for long polls and streams. So a peer that fills one bound does not
 * stop the other side. */
export const CUSTODIAN_CONNECTIONS = { pod: 16384, dial: 4 * FENCE_SLOTS * 2 } as const;
/** How long the inbound listener keeps a connection that has no stream. A stream (a Handoff carry,
 * a long poll) has the idle hour of every listener. */
export const CUSTODIAN_DIAL_IDLE = "60s";

/** The Custodian pod's ports on the cluster's network: the health probe (`CUSTODIAN_HEALTH_PORT`),
 * the Orchestrator's dial to a Harness pod (inbound), and the control process's API. Envoy's admin
 * listener is on the pod's loopback only, which no Harness pod can reach. */
export const CUSTODIAN_INBOUND_PORT = 18080;
export const CUSTODIAN_CONTROL_PORT = 18081;
export const CUSTODIAN_ADMIN_PORT = 15000;

/** The headers of the Orchestrator's dial (ADR-0084): the dial token of the Instance, and the slot
 * address and port of the Harness pod. The Custodian removes both before it dials. */
export const DIAL_TOKEN_HEADER = "x-jr2-dial";
export const DIAL_TARGET_HEADER = "x-jr2-target";
/** The two ports the Orchestrator dials on a Harness pod: the Harness, and the Sandbox Effector. */
export const DIAL_PORTS: readonly number[] = [8080, 8082];

/** What the Custodian pod reads (ADR-0084). The bootstrap and the program are the same for each
 * pod of an Instance; the state folder is an in-memory emptyDir that the control process writes and
 * Envoy reads: the LDS and CDS files, each slot's values, leaves and Lua table, and the dial token. */
export const CUSTODIAN_POD_CONFIG = "/etc/jr2/custodian";
export const CUSTODIAN_POD_BOOTSTRAP = `${CUSTODIAN_POD_CONFIG}/envoy.json`;
export const CUSTODIAN_POD_PROGRAM = `${CUSTODIAN_POD_CONFIG}/${CUSTODIAN_PROGRAM_KEY}`;
export const CUSTODIAN_STATE = "/run/jr2-custodian";
export const CUSTODIAN_XDS = `${CUSTODIAN_STATE}/xds`;
export const CUSTODIAN_LDS = `${CUSTODIAN_XDS}/lds.json`;
export const CUSTODIAN_CDS = `${CUSTODIAN_XDS}/cds.json`;
export const CUSTODIAN_DIAL_TOKEN = `${CUSTODIAN_STATE}/dial-token`;

/** The folder of slot i's own files: `values/` (each value as `<NAME>`, each secret Stand-in as
 * `<NAME>.standin`), `tls/` (each leaf as `<stem>.crt` and `<stem>.key`, `leafStem`) and its Lua
 * tables. */
export function slotFolder(slot: number): string {
  return `${CUSTODIAN_STATE}/slots/${slot}`;
}

/** The uplink's VLAN interface of slot i in the Custodian pod: the only way to the slot's address. */
export function slotInterface(slot: number): string {
  return `v${slot}`;
}

/** Envoy's drain time in the Custodian pod (ADR-0084): when a slot's rules change, a connection on a
 * chain that changed is closed after this time. Envoy's default is 600 s, and churn then holds memory
 * for ten minutes. */
export const CUSTODIAN_DRAIN_SECONDS = 60;

/** Envoy's command line in the Custodian pod. Two workers, because one pod serves each Sandbox on
 * its node; no hot restart (a pod replaces a container); the access log flushed twice a second. */
export const CUSTODIAN_POD_ARGS: readonly string[] = [
  "-c",
  CUSTODIAN_POD_BOOTSTRAP,
  "--concurrency",
  "2",
  "--disable-hot-restart",
  "--drain-time-s",
  String(CUSTODIAN_DRAIN_SECONDS),
  "--file-flush-interval-msec",
  "500",
  "--log-level",
  "warning",
];
