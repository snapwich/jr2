// The Fence as Workspace code meets it (ADR-0084): each probe runs as a regular client in a Harness
// pod's own posture, and each result is read from outside the pod, in the probe's output and in the
// Custodian's own log lines. Two postures of the product: the Harness container (the image's uid, no
// capability) and the User Container (root, with the runtime's default capabilities, NET_RAW among
// them). A plain pod on the cluster's network is the third vantage: it may reach the Custodian pod
// on its published ports only.
//
// Nothing here forges an identity: no spoofed address, no VLAN of its own, no PROXY preamble and no
// header of jr2's (plan section 7, item 11). Those claims are an open item for the user.

import { Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CUSTODIAN_CONTROL_PORT,
  CUSTODIAN_HEALTH_PORT,
  CUSTODIAN_INBOUND_PORT,
  INSTANCE_HARNESS_SERVICE,
  SLOT_LISTENER_BASE,
  SLOT_RESOLVER_BASE,
  SLOT_SPEC_KEY,
} from "@jr2/orchestrator/internal";
import {
  CONNECT_PROBE,
  FENCE_PROBE,
  fenceOf,
  kubectl,
  NO_ENTRY_REFUSAL,
  probeJson,
  rawRequest,
  waitForReadySandbox,
} from "./kind.steps.ts";
import type { E2EWorld } from "./world.ts";

/** A name of the kind instance's Egress list (`features/kind-instance/jr2.config.ts`): its
 * resolver answers it with a placeholder address. */
const LISTED_NAME = "lfs.jr2-e2e-seed.svc.cluster.local";
/** The placeholder range of the Fence's default (ADR-0084). */
const PLACEHOLDERS = /^198\.18\.\d{1,3}\.\d{1,3}$/;
/** A public address: the probe's named DNS server, and a target that no entry names. */
const PUBLIC_ADDRESS = "1.1.1.1";
/** The names no entry names: a public one, and the API server's own. */
const UNLISTED_NAMES = ["example.com", "kubernetes.default.svc.cluster.local"];

/** What one probe of the Fence saw, in one shape for each posture. */
type FenceSeen = {
  /** The uid and the effective capability mask (`CapEff`, hexadecimal) of the probe's process. */
  uid: number;
  capEff: string;
  /** The answer to each lookup through the pod's own resolver: `refused`, or the address. */
  names: Record<string, string>;
  /** The answer to each lookup sent to a DNS server that the client named. */
  named: Record<string, string>;
  /** What came back from each address that no entry names (`host:port`). */
  addresses: Record<string, string>;
  /** What came back from each address of another Harness pod (`host:port`). */
  silent: Record<string, string>;
  /** What came back from another slot's placeholder, dialed for the name that the other slot holds. */
  placeholder: { to: string; name: string; result: string };
  /** ICMP echo to each address: `answered` or `no answer` (the User Container only). */
  ping?: Record<string, string>;
};

/** What a scenario of this file keeps between its steps. */
type FenceProbe = {
  sandbox: string;
  slot: number;
  /** When the probe started: the Custodian's lines from then on are this probe's. */
  since: string;
  /** The address of each target, by its role. */
  targets: Targets;
  seen?: FenceSeen;
  /** The run id of a second run, whose Sandbox is "another Sandbox". */
  otherRun?: string;
  /** The plain pod's results, by the Custodian pod's address and port. */
  plain?: { custodian: string; ports: Record<string, string>; udp: string; control: string };
};

const state = new WeakMap<E2EWorld, FenceProbe>();

function probeOf(world: E2EWorld): FenceProbe {
  let p = state.get(world);
  if (!p) {
    p = { sandbox: "", slot: -1, since: "", targets: {} as Targets };
    state.set(world, p);
  }
  return p;
}

/** The addresses that a probe dials. */
type Targets = {
  /** The Sandbox's node, at the kubelet's port. */
  node: string;
  /** The API server: its Service address and the control plane's node address. */
  apiService: string;
  apiNode: string;
  /** A public address no entry names. */
  public: string;
  /** Another Sandbox's address and the Instance Harness's, at the Harness port. */
  otherSandbox: string;
  instanceHarness: string;
  /** Another slot's placeholder, and the name it stands for in that slot. */
  placeholder: { address: string; name: string };
};

/** The placeholder table of a slot, from its slot Secret (`jr2-custodian-slot-<i>`). */
async function placeholdersOf(world: E2EWorld, slot: number): Promise<Map<string, string>> {
  const b64 = await kubectl(world, [
    "get",
    "secret",
    `jr2-custodian-slot-${slot}`,
    "-o",
    `jsonpath={.data.${SLOT_SPEC_KEY.replace(/\./g, "\\.")}}`,
  ]);
  const spec = JSON.parse(Buffer.from(b64.trim(), "base64").toString("utf8")) as {
    placeholders: { rows: Array<{ name: string; address: string }> };
  };
  return new Map(spec.placeholders.rows.map((r) => [r.address, r.name]));
}

/** The node address (InternalIP) of a node. */
async function nodeAddress(world: E2EWorld, node: string): Promise<string> {
  const ip = (
    await kubectl(world, ["get", "node", node, "-o", `jsonpath={.status.addresses[?(@.type=="InternalIP")].address}`])
  ).trim();
  assert.ok(ip, `the node ${node} has an InternalIP`);
  return ip;
}

/** The Ready Sandbox of a run, and its pod's address. */
async function readySandboxOfRun(world: E2EWorld, runId: string): Promise<{ name: string; ip: string }> {
  for (let i = 0; i < 240; i++) {
    const out = JSON.parse(await kubectl(world, ["get", "sandbox", "-l", `jr2.dev/run=${runId}`, "-o", "json"])) as {
      items: Array<{ metadata: { name: string }; status?: { phase?: string } }>;
    };
    const ready = out.items.find((s) => s.status?.phase === "Ready");
    if (ready) {
      const ip = (await kubectl(world, ["get", "pod", ready.metadata.name, "-o", "jsonpath={.status.podIP}"])).trim();
      if (ip) return { name: ready.metadata.name, ip };
    }
    await sleep(1000);
  }
  throw new Error(`no Sandbox of run ${runId} reached Ready`);
}

/** Each address a probe dials, read from the cluster as a client could learn it. */
async function targetsOf(world: E2EWorld, p: FenceProbe, node: string): Promise<Targets> {
  assert.ok(p.otherRun, "a second run has a Sandbox (When another run's Sandbox becomes Ready beside it)");
  const other = await readySandboxOfRun(world, p.otherRun);
  const controlPlane = (
    await kubectl(world, [
      "get",
      "nodes",
      "-l",
      "node-role.kubernetes.io/control-plane",
      "-o",
      "jsonpath={.items[0].metadata.name}",
    ])
  ).trim();
  const apiService = (
    await kubectl(world, ["get", "svc", "kubernetes", "-n", "default", "-o", "jsonpath={.spec.clusterIP}"])
  ).trim();
  const instanceHarness = (
    await kubectl(world, ["get", "pod", `${INSTANCE_HARNESS_SERVICE}-0`, "-o", "jsonpath={.status.podIP}"])
  ).trim();
  assert.ok(apiService && instanceHarness && controlPlane, "the API server and the Instance Harness have addresses");
  // Another slot's placeholder: an address that slot 0 (the Instance Harness) holds for a name, and
  // that this slot does not hold for the same name. A client that kept an answer of another pod has
  // such an address.
  const ours = await placeholdersOf(world, p.slot);
  const theirs = await placeholdersOf(world, 0);
  const foreign = [...theirs].find(([address, name]) => ours.get(address) !== name);
  assert.ok(
    foreign,
    `slot 0 holds a placeholder that slot ${p.slot} does not hold for the same name ` +
      `(slot 0: ${JSON.stringify([...theirs])}; slot ${p.slot}: ${JSON.stringify([...ours])})`,
  );
  return {
    node: `${await nodeAddress(world, node)}:10250`,
    apiService: `${apiService}:443`,
    apiNode: `${await nodeAddress(world, controlPlane)}:6443`,
    public: `${PUBLIC_ADDRESS}:443`,
    otherSandbox: `${other.ip}:8080`,
    instanceHarness: `${instanceHarness}:8080`,
    placeholder: { address: foreign[0], name: foreign[1] },
  };
}

/** The Sandbox, its slot, its node, and the targets of a probe; the probe's start time. */
async function startProbe(world: E2EWorld): Promise<FenceProbe> {
  const p = probeOf(world);
  const fence = await fenceOf(world);
  p.sandbox = fence.pod.metadata.name;
  p.slot = fence.slot;
  p.targets = await targetsOf(world, p, fence.node);
  p.since = new Date().toISOString();
  return p;
}

When("another run's Sandbox becomes Ready beside it", async function (this: E2EWorld): Promise<void> {
  const p = probeOf(this);
  const r = await this.runCli(["run", "sandboxed", "--detach"]);
  assert.equal(r.code, 0, `the second run started: ${r.stderr}`);
  p.otherRun = this.resultJson<{ runId: string }>().runId;
  await readySandboxOfRun(this, p.otherRun);
});

/**
 * The Harness container's probe, with node, as a tool in the image runs it (`FENCE_PROBE`): a lookup
 * of each name through the pod's resolver and through a DNS server it names, a TCP connection that
 * writes an HTTP request to each address, and a TLS handshake with another slot's placeholder.
 */
When("the Harness container dials past the Egress list", async function (this: E2EWorld): Promise<void> {
  const p = await startProbe(this);
  const t = p.targets;
  const addresses = [t.node, t.apiService, t.apiNode, t.public];
  const silent = [t.otherSandbox, t.instanceHarness];
  const script =
    FENCE_PROBE +
    `const dns=require("dns"),tls=require("tls"),fs=require("fs");` +
    `const look=(n)=>dns.promises.lookup(n,{family:4}).then(a=>a.address,e=>e.code==="ENOTFOUND"?"refused":"ERR "+e.code);` +
    `const ask=(n)=>{const r=new dns.promises.Resolver({timeout:5000,tries:1});r.setServers([${JSON.stringify(PUBLIC_ADDRESS)}]);` +
    `return r.resolve4(n).then(a=>a.join(","),e=>e.code==="ENOTFOUND"?"refused":"ERR "+e.code)};` +
    `const hello=(host,port,servername)=>new Promise((r)=>{const s=tls.connect({host,port,servername,rejectUnauthorized:false});` +
    `const t=setTimeout(()=>{s.destroy();r("timeout")},5000);` +
    `s.on("secureConnect",()=>{clearTimeout(t);s.destroy();r("secure")});` +
    `s.on("error",(e)=>{clearTimeout(t);r("ERR "+(e.code||e.message))});` +
    `s.on("close",()=>{clearTimeout(t);r("closed")})});` +
    `const req=(to)=>${JSON.stringify(rawRequest("GET", "HOST", "/", {}))}.replace("HOST",to);` +
    `(async()=>{const st=fs.readFileSync("/proc/self/status","utf8");` +
    `const out={uid:process.getuid(),capEff:/CapEff:\\s*(\\S+)/.exec(st)[1],names:{},named:{},addresses:{},silent:{},` +
    `placeholder:{to:${JSON.stringify(t.placeholder.address)}+":443",name:${JSON.stringify(t.placeholder.name)},result:""}};` +
    `for(const n of ${JSON.stringify([...UNLISTED_NAMES, LISTED_NAME])}){out.names[n]=await look(n);out.named[n]=await ask(n)}` +
    `for(const to of ${JSON.stringify(addresses)}){const [h,pt]=to.split(":");out.addresses[to]=await raw(h,Number(pt),req(to))}` +
    `for(const to of ${JSON.stringify(silent)}){const [h,pt]=to.split(":");out.silent[to]=await raw(h,Number(pt),req(to))}` +
    `out.placeholder.result=await hello(${JSON.stringify(t.placeholder.address)},443,${JSON.stringify(t.placeholder.name)});` +
    `console.log("FENCE-SEEN "+JSON.stringify(out))})()`;
  const said = await kubectl(this, ["exec", `pod/${p.sandbox}`, "-c", "harness", "--", "node", "-e", script]);
  p.seen = probeJson<FenceSeen>(said, "FENCE-SEEN ");
});

/**
 * The User Container's probe, with the tools of its image (busybox): `nslookup`, `nc` and `ping`.
 * Its image has no TLS client, so it dials another slot's placeholder with plain bytes. Each result
 * is one line, `<kind>\t<target>\t<result>`, and the step builds the same record as the Harness's
 * probe.
 */
When("the User Container dials past the Egress list", async function (this: E2EWorld): Promise<void> {
  const p = await startProbe(this);
  const t = p.targets;
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const lines: string[] = [
    `printf 'uid\\t-\\t%s\\n' "$(id -u)"`,
    `printf 'cap\\t-\\t%s\\n' "$(sed -n 's/^CapEff:[[:space:]]*//p' /proc/self/status)"`,
    // A name: `refused` when the resolver refused it, else the first address in the answer.
    `look() { out=$(nslookup -type=A "$1" $2 2>&1); case "$out" in *NXDOMAIN*) echo refused;; *) echo "$out" | sed -n 's/^Address:[[:space:]]*\\([0-9.]*\\)$/\\1/p' | tail -n 1;; esac; }`,
    ...[...UNLISTED_NAMES, LISTED_NAME].flatMap((n) => [
      `printf 'name\\t%s\\t%s\\n' ${q(n)} "$(look ${q(n)})"`,
      `printf 'named\\t%s\\t%s\\n' ${q(n)} "$(look ${q(n)} ${PUBLIC_ADDRESS})"`,
    ]),
    // A TCP connection that writes an HTTP request and reads for 5 s (stdin stays open, because
    // busybox `nc` stops at its end): `open <reply>` when it
    // connected, else `no connection <nc's error>`, as one line.
    `dial() { out=$( (printf 'GET / HTTP/1.1\\r\\nhost: %s:%s\\r\\nconnection: close\\r\\n\\r\\n' "$1" "$2"; sleep 5) | nc -v -w 5 "$1" "$2" 2>&1 | tr -d '\\r'); case "$out" in *") open"*) printf 'open %s' "$(echo "$out" | grep -v ') open$' | tr '\\n\\t' '  ')";; *) printf 'no connection %s' "$(echo "$out" | tr '\\n\\t' '  ')";; esac; }`,
    ...[t.node, t.apiService, t.apiNode, t.public].map((to) => {
      const [h, pt] = to.split(":");
      return `printf 'address\\t%s\\t%s\\n' ${q(to)} "$(dial ${h} ${pt})"`;
    }),
    ...[t.otherSandbox, t.instanceHarness].map((to) => {
      const [h, pt] = to.split(":");
      return `printf 'silent\\t%s\\t%s\\n' ${q(to)} "$(dial ${h} ${pt})"`;
    }),
    `printf 'placeholder\\t%s\\t%s\\n' ${q(`${t.placeholder.address}:443`)} "$(dial ${t.placeholder.address} 443)"`,
    ...[t.node.split(":")[0]!, PUBLIC_ADDRESS].map(
      (h) =>
        `printf 'ping\\t%s\\t%s\\n' ${h} "$(ping -c 2 -W 2 ${h} >/dev/null 2>&1 && echo answered || echo 'no answer')"`,
    ),
  ];
  const said = await kubectl(this, ["exec", `pod/${p.sandbox}`, "-c", "user", "--", "sh", "-c", lines.join("\n")]);
  const seen: FenceSeen = {
    uid: -1,
    capEff: "",
    names: {},
    named: {},
    addresses: {},
    silent: {},
    placeholder: { to: `${t.placeholder.address}:443`, name: t.placeholder.name, result: "" },
    ping: {},
  };
  for (const line of said.split("\n")) {
    const [kind, target = "", ...rest] = line.split("\t");
    const result = rest.join("\t").trim();
    if (kind === "uid") seen.uid = Number(result);
    else if (kind === "cap") seen.capEff = result;
    else if (kind === "name") seen.names[target] = result;
    else if (kind === "named") seen.named[target] = result;
    else if (kind === "address") seen.addresses[target] = result.replace(/^open /, "");
    else if (kind === "silent") seen.silent[target] = result;
    else if (kind === "placeholder") seen.placeholder.result = result;
    else if (kind === "ping") seen.ping![target] = result;
  }
  p.seen = seen;
});

function seenOf(world: E2EWorld): FenceSeen {
  const seen = probeOf(world).seen;
  assert.ok(seen, "a probe of the Fence ran");
  return seen;
}

/** The effective capabilities of a probe as a number: `CapEff` is hexadecimal. */
function hasCap(capEff: string, bit: number): boolean {
  return (BigInt(`0x${capEff || "0"}`) & (1n << BigInt(bit))) !== 0n;
}
const CAP_NET_RAW = 13;

Then("the probe ran as a uid other than 0, with no capability", function (this: E2EWorld): void {
  const seen = seenOf(this);
  assert.notEqual(seen.uid, 0, `the Harness container's process is not root (uid ${seen.uid})`);
  assert.equal(BigInt(`0x${seen.capEff}`), 0n, `it has no capability (CapEff ${seen.capEff})`);
});

Then("the probe ran as root, with NET_RAW", function (this: E2EWorld): void {
  const seen = seenOf(this);
  assert.equal(seen.uid, 0, `the User Container's process is root (uid ${seen.uid})`);
  assert.ok(hasCap(seen.capEff, CAP_NET_RAW), `it has NET_RAW (CapEff ${seen.capEff})`);
});

Then(
  "each name that no entry names got the resolver's refusal, also from a DNS server that the client named, and a listed name got its placeholder",
  function (this: E2EWorld): void {
    const seen = seenOf(this);
    for (const name of UNLISTED_NAMES) {
      assert.equal(seen.names[name], "refused", `the resolver refused ${name} (${JSON.stringify(seen.names)})`);
      assert.equal(
        seen.named[name],
        "refused",
        `a query for ${name} to ${PUBLIC_ADDRESS} was refused by jr2's resolver (${JSON.stringify(seen.named)})`,
      );
    }
    // The control: the same two paths answer a name of the Egress list, with a placeholder address.
    assert.match(seen.names[LISTED_NAME] ?? "", PLACEHOLDERS, `${LISTED_NAME} got a placeholder`);
    assert.equal(
      seen.named[LISTED_NAME],
      seen.names[LISTED_NAME],
      `the server that the client named gave the same placeholder: jr2's resolver answered (${JSON.stringify(seen.named)})`,
    );
  },
);

Then(
  "the node, the API server and a public address each got the Custodian's refusal and no byte of their own",
  function (this: E2EWorld): void {
    const seen = seenOf(this);
    const t = probeOf(this).targets;
    for (const to of [t.node, t.apiService, t.apiNode, t.public]) {
      const reply = seen.addresses[to] ?? "";
      assert.match(reply, NO_ENTRY_REFUSAL, `the Custodian refused ${to} (got: ${JSON.stringify(reply)})`);
      assert.doesNotMatch(reply, /HTTP\/1\.[01] /, `no byte of the target came back from ${to}`);
    }
  },
);

Then("another slot's placeholder got no connection to the name it stands for", function (this: E2EWorld): void {
  const seen = seenOf(this);
  const { to, name, result } = seen.placeholder;
  // The Harness's probe makes a TLS handshake by the name; the User Container's sends plain bytes.
  // Neither may reach the name: no handshake completes, and what comes back is the Custodian's
  // refusal (a TLS alert, or its line of text), never a byte of the name's server.
  assert.notEqual(result, "secure", `no TLS handshake with ${name} completed at ${to}`);
  assert.match(
    result,
    /^(ERR ERR_SSL_TLSV1_ALERT_\w+|open jr2 custodian: refused: .*)$/,
    `the Custodian refused ${to} for ${name} (got: ${JSON.stringify(result)})`,
  );
});

Then("another Sandbox and the Instance Harness got no answer", function (this: E2EWorld): void {
  const seen = seenOf(this);
  const t = probeOf(this).targets;
  // Another slot's address is on no VLAN of this Sandbox, and the uplink answers ARP only for its
  // own slot's address (ADR-0084): the dial gets no answer at all.
  for (const to of [t.otherSandbox, t.instanceHarness]) {
    const reply = seen.silent[to] ?? "";
    assert.match(
      reply,
      /^(ERR EHOSTUNREACH|timeout|no connection\b.*)$/,
      `${to} got no answer (got: ${JSON.stringify(reply)})`,
    );
  }
});

Then("an ICMP echo to the node and to a public address got no answer", function (this: E2EWorld): void {
  const seen = seenOf(this);
  const t = probeOf(this).targets;
  for (const h of [t.node.split(":")[0]!, PUBLIC_ADDRESS]) {
    assert.equal(seen.ping?.[h], "no answer", `ICMP to ${h} got no answer (got: ${JSON.stringify(seen.ping)})`);
  }
});

/** The Custodian pods' lines of one container since a time. */
async function custodianLinesSince(world: E2EWorld, container: "envoy" | "control", since: string): Promise<string> {
  const pods = (
    await kubectl(world, ["get", "pods", "-l", "app=jr2-custodian", "-o", "jsonpath={.items[*].metadata.name}"])
  )
    .split(/\s+/)
    .filter((n) => n !== "");
  assert.ok(pods.length > 0, "the namespace has a Custodian pod");
  const logs = await Promise.all(
    pods.map((pod) => kubectl(world, ["logs", `pod/${pod}`, "-c", container, `--since-time=${since}`]).catch(() => "")),
  );
  return logs.join("\n");
}

/** Wait for a line of the Custodian since the probe started. */
async function lineSince(world: E2EWorld, container: "envoy" | "control", pattern: RegExp): Promise<string> {
  const { since } = probeOf(world);
  let seen = "";
  // The access log flushes twice a second, so a line is waited for.
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(500)) {
    seen = await custodianLinesSince(world, container, since);
    const line = seen.split("\n").find((l) => pattern.test(l));
    if (line) return line;
  }
  throw new Error(`no Custodian ${container} line since ${since} matches ${pattern} (lines: ${seen.slice(-3000)})`);
}

const re = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

Then(
  "the Custodian logged each refusal with the Sandbox and the reason",
  async function (this: E2EWorld): Promise<void> {
    const p = probeOf(this);
    const t = p.targets;
    for (const name of UNLISTED_NAMES) {
      await lineSince(
        this,
        "control",
        new RegExp(
          `^jr2\\.custodian dns action=refuse slot=${p.slot} sandbox=${re(p.sandbox)} name=${re(name)} type=A reason=no-entry$`,
        ),
      );
    }
    for (const to of [t.node, t.apiService, t.apiNode, t.public]) {
      await lineSince(
        this,
        "envoy",
        new RegExp(`sandbox=${re(p.sandbox)} action=refuse reason=no-entry .*to=${re(to)} `),
      );
    }
    // Another slot's placeholder: refused for the slot's own rules at that address, whatever they are.
    const placeholder = `${t.placeholder.address}:443`;
    await lineSince(
      this,
      "envoy",
      new RegExp(`sandbox=${re(p.sandbox)} action=refuse reason=\\S+ .*to=${re(placeholder)} `),
    );
  },
);

// --- a plain pod on the cluster's network --------------------------------------------------------

/** The plain pod: the Orchestrator's image, as an image that is on each node, with no label of jr2's,
 * no ServiceAccount token, no capability and a uid that is not root. */
const PLAIN_POD = "jr2-e2e-plain";

/** A UDP DNS query for `example.com` to `host:port`, 3 s: `answered` or `no answer`. */
const UDP_PROBE =
  `const dgram=require("dgram");` +
  `const udp=(host,port)=>new Promise((r)=>{const s=dgram.createSocket("udp4");` +
  `const q=Buffer.from("123401000001000000000000076578616d706c6503636f6d0000010001","hex");` +
  `const t=setTimeout(()=>{s.close();r("no answer")},3000);` +
  `s.on("message",()=>{clearTimeout(t);s.close();r("answered")});` +
  `s.on("error",(e)=>{clearTimeout(t);s.close();r("ERR "+e.code)});s.send(q,port,host)});`;

When(
  "a plain pod on the cluster's network dials each port of a Custodian pod",
  { timeout: 300_000 },
  async function (this: E2EWorld): Promise<void> {
    const p = probeOf(this);
    const image = (
      await kubectl(this, [
        "get",
        "deployment/jr2-orchestrator",
        "-o",
        "jsonpath={.spec.template.spec.containers[0].image}",
      ])
    ).trim();
    const pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: PLAIN_POD, namespace: this.namespace },
      spec: {
        automountServiceAccountToken: false,
        restartPolicy: "Never",
        containers: [
          {
            name: "plain",
            image,
            imagePullPolicy: "IfNotPresent",
            command: ["node", "-e", "setInterval(()=>{},1<<30)"],
            securityContext: {
              runAsUser: 1000,
              runAsNonRoot: true,
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
            },
          },
        ],
      },
    };
    await new Promise<void>((resolve, reject) => {
      const child = execFile("kubectl", ["--namespace", this.namespace!, "apply", "-f", "-"], (err, _o, stderr) =>
        err ? reject(new Error(`kubectl apply of the plain pod: ${stderr || err.message}`)) : resolve(),
      );
      child.stdin?.end(JSON.stringify(pod));
    });
    await kubectl(this, ["wait", "--for=condition=Ready", `pod/${PLAIN_POD}`, "--timeout=180s"]);
    const custodian = (
      await kubectl(this, ["get", "pods", "-l", "app=jr2-custodian", "-o", "jsonpath={.items[0].status.podIP}"])
    ).trim();
    assert.ok(custodian, "a Custodian pod has an address on the cluster's network");
    // Its published ports, the slot listeners and resolvers of the Instance Harness and of a
    // Sandbox's first slot, and Envoy's admin port (on the pod's loopback alone).
    const ports = [
      CUSTODIAN_HEALTH_PORT,
      CUSTODIAN_INBOUND_PORT,
      CUSTODIAN_CONTROL_PORT,
      SLOT_LISTENER_BASE,
      SLOT_LISTENER_BASE + 3,
      SLOT_RESOLVER_BASE,
      SLOT_RESOLVER_BASE + 3,
      15000,
    ];
    const script =
      CONNECT_PROBE +
      UDP_PROBE +
      `(async()=>{const out={ports:{}};` +
      `for(const pt of ${JSON.stringify(ports)})out.ports[pt]=await probe(${JSON.stringify(custodian)},pt);` +
      `out.udp=await udp(${JSON.stringify(custodian)},${SLOT_RESOLVER_BASE});` +
      `console.log("PLAIN-SEEN "+JSON.stringify(out))})()`;
    const seen = probeJson<{ ports: Record<string, string>; udp: string }>(
      await kubectl(this, ["exec", `pod/${PLAIN_POD}`, "--", "node", "-e", script]),
      "PLAIN-SEEN ",
    );
    // The control: the Orchestrator of the Instance, which the NetworkPolicy admits, connects to the
    // inbound port of the same pod.
    const control = (
      await kubectl(this, [
        "exec",
        "deployment/jr2-orchestrator",
        "--",
        "node",
        "-e",
        `${CONNECT_PROBE}probe(${JSON.stringify(custodian)},${CUSTODIAN_INBOUND_PORT}).then((r)=>console.log(r))`,
      ])
    ).trim();
    p.plain = { custodian, ports: seen.ports, udp: seen.udp, control };
  },
);

Then(
  "only the Custodian's health port answered it, and no slot listener, resolver, inbound or control port did",
  function (this: E2EWorld): void {
    const plain = probeOf(this).plain;
    assert.ok(plain, "the plain pod dialed the Custodian pod");
    assert.equal(
      plain.control,
      "connected",
      `the Instance's Orchestrator connects to the inbound port (got: ${plain.control})`,
    );
    for (const [port, result] of Object.entries(plain.ports)) {
      if (Number(port) === CUSTODIAN_HEALTH_PORT) {
        assert.equal(result, "connected", `the health port answers any peer (got: ${result})`);
        continue;
      }
      assert.notEqual(
        result,
        "connected",
        `port ${port} of the Custodian pod ${plain.custodian} gave a plain pod no connection (got: ${JSON.stringify(plain.ports)})`,
      );
    }
    assert.equal(plain.udp, "no answer", `a DNS query to a slot's resolver got no answer (got: ${plain.udp})`);
  },
);
