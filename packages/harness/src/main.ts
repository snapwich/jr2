// The Harness process's PID 1 (ADR-0018/0027): process → env → reach → serve. Runtime
// construction, not codegen — the retired boot assembly and its readiness lag are gone; binding
// :8080 is the pod's Ready signal. Everything here is wiring: validation lives in `spec.ts`, the
// wire in `app.ts`, the turn in `turn.ts`. Fatal errors land in the pod log by throwing.
//
// The env carries what this instance can REACH and nothing about WHO runs (ADR-0049): each
// admission brings its own Agent definition, so this process boots knowing no Agents at all.
//
// It is the container's command in BOTH placements: the stock image's own `CMD` (the Instance
// Harness, ADR-0031), and the command the operator overrides a Sandbox Image with, where jr2's
// runtime is mounted at `/opt/jr2` and nothing about this process came from the image (ADR-0037).

// First, before any other module of the Harness runs: node must look for modules in jr2's folders
// alone (ADR-0076, `module-paths.ts`).
import "./module-paths-guard.ts";
import { existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { harnessServer } from "./app.ts";
import { attacher } from "./attach.ts";
import {
  childPolicy,
  CONFINER,
  runIn,
  CONTROL_SOCKET,
  CONTROL_STANDIN_FILE,
  CONVERSATIONS_DIR,
  probeLandlock,
  readControlStandIn,
  readStandIns,
  RESERVED_ENV,
  RUNTIME_SECRETS,
  SHELL_SOCKET,
  STANDINS_DIR,
  assertHarnessHome,
  OUTPUT_DIR,
  USER_CONTEXT_DIR,
  takeStartEnv,
  useOutputDir,
  type ChildPolicy,
} from "./children.ts";
import { syncer } from "./sync.ts";
import { bundleHandoff } from "./handoff-bundle.ts";
import { dropLandedOf, landHandoff } from "./handoff-land.ts";
import { Execs } from "./exec.ts";
import { seatFacts, standingBriefing } from "./briefing.ts";
import { clearShm, clearShmInDomain, podMemoryGuard } from "./memory-guard.ts";
import { admissionFault, modelsFor } from "./provider.ts";
import { McpHost } from "./mcp.ts";
import { loadHarnessSpec, mcpAdmissionFault } from "./spec.ts";
import {
  conditionPathAndHome,
  defaultGitIdentity,
  imageSystemGitConfigBy,
  oldGitWarningBy,
  NO_SYSTEM_FILE,
  prepareProcess,
  RUNTIME_GITCONFIG,
} from "./startup.ts";
import { serveHarness } from "./serve.ts";
import { runSubmissionFor } from "./turn.ts";
import { contextScopeOf, userContextMount } from "./project-context.ts";
import { OutputFolder } from "./output-folder.ts";
import { unixFetch } from "./unix-fetch.ts";
import { keepSendOver } from "./keep.ts";
import { serveShells } from "./workspace-shell.ts";

// The env the container STARTED with, before this process changes its own (ADR-0076): the domain's
// env is made from it, so nothing that this process adds later — a held secret's Stand-in, a model
// key's — reaches a process of the domain. In a pod it is `JR2_START_ENV`: this process's own env is
// only the names that jr2 composed, less each that loads code from a path (`effector nocore
// --harness-env`), and the image's `ENV` reaches the domain alone. The imports above change no env
// (see below).
const startEnv: Readonly<Record<string, string>> = takeStartEnv(process.env);

// The process's name (ADR-0076): an Agent's `pkill node` does not end the Harness by accident, and a
// test finds it by this name.
process.title = "jr2-harness";

// Then, before anything else reads the environment or writes a file: umask 002, PATH appended with
// /opt/jr2/bin, HOME defaulted, git's default identity at its lowest rung. In a Sandbox the image
// is the user's and carries none of these, and every process of the domain gets them from here —
// the umask by inheritance, PATH, HOME and git's identity in the domain's env (startup.ts,
// children.ts, ADR-0037/ADR-0005, ADR-0076).
// "First" is first STATEMENT, not first code: the imports above are ESM, so their module bodies run
// ahead of this line. That holds only because none of them touches PATH, HOME, the umask, or spawns
// a child at module scope — they declare constants and schemas (verified). A module that ever needs
// the conditioned environment at import time must read it inside a function, not at its top level.
// The Harness of a Sandbox does not run the image's git to find git's system file: that git can be a
// program that Workspace code put on PATH. It asks the domain below (ADR-0076). The Instance
// Harness runs no Workspace code, and keeps the check here.
const menuOnly = process.env.JR2_MENU_ONLY !== undefined && process.env.JR2_MENU_ONLY !== "";
prepareProcess(process.env, undefined, undefined, menuOnly ? undefined : NO_SYSTEM_FILE);

function required(name: string, why: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`no ${name} in the environment — ${why}`);
  return value;
}

/** A start that cannot serve: said in the log and in the container's termination message, which
 * the operator publishes on the Sandbox's status (ADR-0063), then exit 1. */
function refuse(line: string): never {
  console.error(`jr2 harness: ${line}`);
  try {
    writeFileSync("/dev/termination-log", line);
  } catch {
    // Not in a pod.
  }
  process.exit(1);
}

const confiner = process.env.JR2_CONFINER || CONFINER;

// Landlock is a requirement of jr2 (ADR-0077): the Harness of a Sandbox runs each process it
// starts in a Landlock domain, so without it this Harness refuses to serve — the backstop for a node that the
// converge did not see. The Instance Harness confines nothing, and does not probe.
if (!menuOnly) {
  const refusal = probeLandlock(confiner, process.env.NODE_NAME || "unknown");
  if (refusal !== undefined) refuse(refusal);
}

const harness = loadHarnessSpec(process.env);
// The control Stand-in (ADR-0076): read ONCE, from its file, and held in this process alone — the
// bearer of every control request. It is in no env, and no process this Harness confines can read
// its file. The Custodian puts the control token in its place on the agent routes (ADR-0059).
const controlFile = process.env.JR2_CONTROL_STANDIN_FILE || CONTROL_STANDIN_FILE;
let control: string;
try {
  control = readControlStandIn(controlFile);
} catch (err) {
  refuse(err instanceof Error ? err.message : String(err));
}
// Every control request goes to the Custodian's control socket under /run/jr2 (ADR-0076), which no
// process of the domain can bind. The URL's host is a name only.
const menu = {
  url: "http://jr2-custodian",
  token: control,
  fetch: unixFetch(process.env.JR2_CUSTODIAN_SOCKET || CONTROL_SOCKET),
};
// Every held secret's Stand-in (ADR-0059): secret, a file each, read once. The engine gets a model
// key's in this process (pi reads the key variable here); the domain gets only the ones its
// `workspace()` grants (`JR2_GRANTED_SECRETS`), never this process's env.
const standInsDir = process.env.JR2_STANDINS_DIR || STANDINS_DIR;
const standIns = readStandIns(standInsDir);
for (const [name, value] of standIns) {
  // A Stand-in never takes a variable that the domain's env is made of (`children.ts`).
  if (RESERVED_ENV.includes(name)) {
    refuse(
      `the held secret ${name} names a variable of the Harness's own env (PATH, HOME, the proxy) — rename it (ADR-0059)`,
    );
  }
  process.env[name] = value;
}
const models = modelsFor(harness, process.env);

// Where the conversations are kept (ADR-0031): under /run/jr2, which the domain cannot read
// (ADR-0076). An empty value keeps them in memory alone (a test's Harness).
const conversationsDir = process.env.JR2_CONVERSATIONS_DIR ?? CONVERSATIONS_DIR;

// The image user's context (ADR-0062): the pod mounts the image's `~/.pi/agent` (`JR2_USER_CONTEXT`)
// a second time, read-only, at /run/jr2/user-context, and the Harness reads it there alone. It is
// checked now, once, before the domain is made: the domain reads it, and moves nothing there. No
// announced folder, no user context: a `~/.pi/agent` that an Agent makes is never read. The Instance
// Harness has no domain and no Workspace, so none.
const userContext = menuOnly ? undefined : userContextMount(process.env.JR2_USER_CONTEXT);

// The domain (ADR-0076): the one spawner, confined, and the env of each process in it. The Instance
// Harness has none — a Menu-only Agent has no Working tools (ADR-0031).
let children: ChildPolicy | undefined;
if (!menuOnly) {
  // A conversation outside /run/jr2 is one that a process of the domain reads.
  if (conversationsDir !== "" && !`${conversationsDir}/`.startsWith(`${RUNTIME_SECRETS}/`)) {
    refuse(
      `the conversations folder ${conversationsDir} is not under ${RUNTIME_SECRETS}: every process the Harness ` +
        "starts would read the conversations (ADR-0076)",
    );
  }
  try {
    // The start env, with PATH and HOME as startup.ts makes them: the toolchain's. git's identity
    // comes below.
    const domainStart: Record<string, string | undefined> = { ...startEnv };
    conditionPathAndHome(domainStart);
    children = childPolicy({
      env: domainStart,
      confiner,
      standIns,
      control,
      // The domain reads the image user's context mount too, under /run/jr2: the child that loads
      // the project context is in the domain (ADR-0062).
      read: [OUTPUT_DIR, ...(userContext !== undefined && !("fault" in userContext) ? [USER_CONTEXT_DIR] : [])],
    });
  } catch (err) {
    refuse(`the Harness cannot start its domain: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The Harness process has had a HOME of its own since before node started (`effector nocore
  // --harness-env`), under /run/jr2, which the domain cannot write (ADR-0076). The domain keeps the
  // Workspace HOME, and the file tools' `~` is that HOME.
  if (children) {
    try {
      assertHarnessHome(process.env, children);
    } catch (err) {
      refuse(err instanceof Error ? err.message : String(err));
    }
    // pi's `bash` writes a long command's whole output in this process's TMPDIR, and opens it by
    // its path again: the Harness's output folder, which the domain reads and does not write
    // (ADR-0076). The domain keeps the TMPDIR that the container started with.
    try {
      useOutputDir(OUTPUT_DIR);
    } catch (err) {
      refuse(err instanceof Error ? err.message : String(err));
    }
  }
}

// `/dev/shm` empty before any Working tool runs (ADR-0060): shm files outlive a container restart
// and stay charged to the pod, so a Harness restarted after a memory kill would start against the
// memory that killed it — the lab's crash loop. In a Sandbox a process of the domain empties it,
// because the domain writes there (`clearShmInDomain`, ADR-0076).
if (children) await clearShmInDomain(children);
else clearShm();

// git's default identity for the domain (startup.ts): the image's git, run in the domain, says
// which system file it reads. Its answer sets only the domain's env.
if (children) {
  const domain = children;
  const domainGit = async (args: string[]) => {
    const r = await runIn(domain, ["git", ...args], { cwd: "/", timeoutMs: 10_000 });
    return { code: r.code, stdout: r.stdout };
  };
  const systemFile = await imageSystemGitConfigBy(domainGit);
  const env: Record<string, string | undefined> = { ...domain.env };
  defaultGitIdentity(env, RUNTIME_GITCONFIG, () => systemFile);
  const gitConfigSystem = env.GIT_CONFIG_SYSTEM;
  if (gitConfigSystem !== undefined && domain.env.GIT_CONFIG_SYSTEM === undefined) {
    children = { ...domain, env: { ...domain.env, GIT_CONFIG_SYSTEM: gitConfigSystem } };
  }
  const oldGit = await oldGitWarningBy(domainGit);
  if (oldGit !== undefined) console.error(`jr2 harness: warning: ${oldGit}`);
}

// The wire's gate (ADR-0058): the Orchestrator bears a token derived for THIS placement, and the
// env carries only its sha-256 — Workspace code runs in this container, and a digest verifies
// without minting, for this pod or any other. Required at boot: a Harness that could not
// check a bearer would admit anyone who can reach it, which is the hole this closes. Digests
// compare with `===` on purpose: what a timing leak could reveal is a hash prefix, which inverts to
// nothing.
const bearerSha256 = required(
  "JR2_HARNESS_TOKEN_SHA256",
  "the Harness cannot authenticate the Orchestrator, and an unauthenticated wire lets any pod that reaches it drive its conversations (ADR-0058)",
);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("base64url");

// One guard for the process (ADR-0061): it reads this container's cgroup, so every conversation's
// `bash` calls share it. It polls from here on, not only while a `bash` call runs — a dev server
// left from an earlier call or a human's exec session is one of the Agent's processes too. Off
// where `memory.max` is `max` or unreadable (a host run).
const guard = podMemoryGuard(children);
guard.start();

// The Briefing's standing part (ADR-0062), composed once for the pod: its CPUs from the Downward API
// (`JR2_CPUS`, ADR-0060) and its Size from the cgroup — read here, not per Turn, so every Turn of
// every conversation sends the same bytes. Unknown where this is not a Sandbox, and then unsaid.
const standing = standingBriefing(seatFacts(process.env));

// The Harness's output folder (ADR-0076): each `bash` call prunes it when it ends.
const output = new OutputFolder(OUTPUT_DIR);

// The project context's reach (ADR-0062): the Workspace's bound on the context files
// (`JR2_PROJECT_CONTEXT`, the `workspace()`'s `projectContext`), and the image user's context mount,
// checked above.
if (userContext !== undefined && "fault" in userContext) {
  console.error(`jr2 harness: no user context: ${userContext.fault} (ADR-0062)`);
} else if (userContext !== undefined) {
  console.error(
    `jr2 harness: the image user's context in ${userContext.image} is read, from a read-only mount at ${userContext.dir} (ADR-0062)`,
  );
}
const projectContext = {
  scope: contextScopeOf(process.env.JR2_PROJECT_CONTEXT),
  ...(userContext !== undefined && !("fault" in userContext) ? { userContext } : {}),
};

// The MCP servers of the Instance (ADR-0079): a remote server's one connection for this pod, and the
// stdio servers of each conversation, which start in the domain. The Instance Harness has no domain,
// so it starts no stdio server, and its admission refuses a definition that names one.
const mcpHost = new McpHost({ servers: harness.mcp ?? {}, standIns, ...(children ? { children } : {}) });
const conversationKey = (agentName: string, instanceId: string) =>
  `${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`;
const harnessWire = harnessServer({
  runSubmissionFor: (seat) =>
    runSubmissionFor({
      models,
      menu,
      guard,
      standing,
      ...(children ? { children, output } : {}),
      projectContext,
      mcp: {
        conversation: mcpHost.conversation(conversationKey(seat.agentName, seat.instanceId), seat.mcpTools),
        servers: harness,
      },
      ...seat,
    }),
  // A conversation that the live set freed ends its stdio MCP servers (ADR-0079).
  conversationFreed: (agentName, instanceId) => void mcpHost.end(conversationKey(agentName, instanceId)),
  // A guard kill lands on the running conversations' streams and on `GET /memory-kills`, under one
  // id, for the Orchestrator's notice (ADR-0062).
  memoryKills: (listener) => guard.onKill(listener),
  memoryTold: (teller) => guard.onTold(teller),
  // The attach (ADR-0063), the sync (ADR-0067) and the exec of a Machine's `command` Effects
  // (ADR-0067), each in the domain (ADR-0076). The Instance Harness has none: it refuses them all
  // (`menuOnly`).
  ...(children
    ? {
        // The Workspace's Repos into `/work`, on the Orchestrator's call.
        attach: attacher({ children }),
        // The Agent's branch to the published commits, when they are not its own.
        sync: syncer({ children }),
        // The files of a Handoff, for the cut of a nested Workspace (ADR-0080).
        handoff: (req) => bundleHandoff(children, req),
        land: (id, body) => landHandoff(children, id, body),
        // In the domain: the Agent's user, and the Stand-ins its `workspace()` grants.
        // The files landed for a cut at a Handoff go when its exec settles, a timeout's kill too.
        execs: new Execs({ children, onSettled: (id) => void dropLandedOf(children, id) }),
      }
    : {}),
  checkAdmission: (resolved) =>
    admissionFault(models, resolved) ?? mcpAdmissionFault(resolved, harness, children !== undefined),
  frameExists: (path) => existsSync(path),
  // Set on the Instance Harness StatefulSet alone (deploy.ts, ADR-0031): this placement admits
  // Menu-only Agents and refuses every other definition — the gate that keeps "no code
  // execution in this pod" a property, not a comment.
  ...(menuOnly ? { menuOnly: true } : {}),
  checkBearer: (bearer) => bearer !== undefined && sha256(bearer) === bearerSha256,
  // Each conversation's entries go to the Orchestrator over the control channel, as the picks do
  // (ADR-0023, ADR-0076).
  keepSend: keepSendOver(menu),
  // Where each conversation is persisted and rebuilt from (ADR-0031): the Instance Harness's
  // PersistentVolumeClaim, a Sandbox Harness's emptyDir. Unset, conversations live in memory.
  ...(conversationsDir !== "" ? { conversationsDir } : {}),
});

// A port another container in the pod took is said in one line, exit 1 (R16 — serve.ts).
const served = serveHarness(harnessWire, { port: Number(process.env.PORT ?? 8080) });

// A person's shell (`jr2 workspace shell`, ADR-0076): started through the domain's spawner, on a
// socket in a folder of the Harness container's alone. A Harness that cannot listen there serves
// the Agents as before, and says why it serves no shell.
if (children) {
  const domain = children;
  const socket = process.env.JR2_SHELL_SOCKET || SHELL_SOCKET;
  serveShells({ children: () => domain, control, socket }).catch((err: unknown) => {
    console.error(
      `jr2 harness: no socket for \`jr2 workspace shell\` at ${socket}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

// A rollout drains Turns (ADR-0031): the first signal stops admitting and exits 0 once every
// admitted Submission has settled. A second is someone who will not wait — a human's second ^C.
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(0);
    stopping = true;
    console.log(`jr2 harness draining on ${signal}: admitting nothing, settling what it holds`);
    void served.stop();
  });
}
