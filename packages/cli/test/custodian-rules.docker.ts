// The pinned Envoy validates what the renderer of the Custodian of an Instance writes (ADR-0084):
// the pod's bootstrap, and the LDS and CDS files of three slots — the Instance Harness, a check pod
// and a Sandbox with each kind of rule. `envoy --mode validate` builds each listener, each cluster,
// each TLS context and each Lua filter, so it reads the leaves, the program and each slot's table
// from the paths the renderer names. The files are laid out as the Custodian pod mounts them.
//
// Then the pinned Envoy RUNS one slot's rules, for the claims that the shape of a file cannot show:
// the Host's port on a wildcard, other spellings of a refused name, the headers a target gets, the
// dial listener's log, and the Orchestrator's dial when the program fails. These need a docker
// network of their own (port 80, and more addresses for a target); `custodian.docker.ts` runs the
// rest of the Custodian's claims.
//
// Opt-in: `just custodian-test` (docker + the pinned image), beside the Custodian suite.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { duplexPair } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import {
  CUSTODIAN_DIAL_TOKEN,
  CUSTODIAN_POD_ARGS,
  CUSTODIAN_POD_BOOTSTRAP,
  CUSTODIAN_POD_CONFIG,
  CUSTODIAN_POD_PROGRAM,
  CUSTODIAN_PROGRAM,
  CUSTODIAN_STATE,
  CUSTODIAN_LDS,
  CUSTODIAN_CDS,
  custodianPodBootstrap,
  custodianRef,
  custodianXds,
  emptyPlaceholders,
  JR2_CUSTODIAN_NAME,
  leafStem,
  placeholderOf,
  renderSlot,
  slotFolder,
  withPlaceholders,
  type SlotInputs,
} from "@jr2/orchestrator/internal";
import { RANGES, rule, THREE_SLOTS } from "./support/custodian-slots.ts";
import { issueCa, issueLeaf, trustBundles } from "../src/held-pki.ts";

const exec = promisify(execFile);
let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "jr2-custodian-rules-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Where a path of the pod lands in `dir`: `/etc/jr2/...` under `etc/`, the state folder under `state/`. */
function local(path: string, root = dir): string {
  if (path.startsWith(CUSTODIAN_STATE)) return join(root, "state", path.slice(CUSTODIAN_STATE.length));
  return join(root, "etc", path.slice("/etc/jr2".length));
}

async function putIn(path: string, text: string, root = dir): Promise<void> {
  await mkdir(dirname(local(path, root)), { recursive: true });
  await writeFile(local(path, root), text, { mode: 0o644 });
}
const put = (path: string, text: string) => putIn(path, text);

/** The files of one slot: its Lua table, a value and a Stand-in for each name the table reads, and a
 * leaf for each Intercepted host. */
async function slotFiles(inputs: SlotInputs, ca: ReturnType<typeof issueCa>, root = dir): Promise<void> {
  const put = (path: string, text: string) => putIn(path, text, root);
  const rules = renderSlot(inputs);
  await put(rules.lua.path, rules.lua.text);
  const names = ["JR2_CONTROL_TOKEN", "JR2_SANDBOX_TOKEN", ...inputs.manifest.secrets.map((s) => s.name)];
  for (const name of names) {
    await put(`${slotFolder(inputs.slot)}/values/${name}`, `value-of-${name}\n`);
    await put(`${slotFolder(inputs.slot)}/values/${name}.standin`, `jr2-held-${name}.test\n`);
  }
  const intercepted = [
    { host: JR2_CUSTODIAN_NAME, port: 443 },
    ...inputs.manifest.egress.filter((r) => r.intercept && r.port !== 80),
  ];
  for (const { host, port } of intercepted) {
    const leaf = issueLeaf(ca, host);
    await put(`${slotFolder(inputs.slot)}/tls/${leafStem(host, port)}.crt`, leaf.cert);
    await put(`${slotFolder(inputs.slot)}/tls/${leafStem(host, port)}.key`, leaf.key);
  }
}

async function validate(bootstrap: string): Promise<{ code: number; output: string }> {
  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "-v",
    `${join(dir, "etc")}:/etc/jr2:ro`,
    "-v",
    `${join(dir, "state")}:${CUSTODIAN_STATE}:ro`,
    "--user",
    `65532:${process.getgid?.() ?? 0}`,
    custodianRef(),
    "--mode",
    "validate",
    "-c",
    bootstrap,
    "--log-level",
    "warning",
  ];
  try {
    const { stdout, stderr } = await exec("docker", args, { maxBuffer: 1 << 24 });
    return { code: 0, output: stdout + stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test("the pinned Envoy validates the Custodian pod's bootstrap with the LDS and CDS of three slots, and each slot's chains built inline (ADR-0084)", async () => {
  const ca = issueCa("custodian-rules");
  for (const inputs of THREE_SLOTS) await slotFiles(inputs, ca);
  await put(CUSTODIAN_POD_PROGRAM, CUSTODIAN_PROGRAM);
  await put(`/etc/jr2/ca/upstream.crt`, trustBundles(ca.cert).upstream);

  const slots = THREE_SLOTS.map(renderSlot);
  const bootstrap = custodianPodBootstrap({
    orchestrator: { host: "jr2-orchestrator.ns.svc", port: 4000 },
    range: 3,
    ranges: RANGES,
  });
  const { lds, cds } = custodianXds(slots);
  await put(CUSTODIAN_POD_BOOTSTRAP, JSON.stringify(bootstrap));
  await put(CUSTODIAN_LDS, JSON.stringify(lds));
  await put(CUSTODIAN_CDS, JSON.stringify(cds));

  // The same slot listeners and clusters as static resources: validate mode builds each one, with
  // its TLS contexts and Lua filters, whether or not it reads the watched files.
  const inline = structuredClone(bootstrap) as {
    dynamic_resources?: unknown;
    static_resources: { listeners: unknown[]; clusters: unknown[] };
  };
  delete inline.dynamic_resources;
  const strip = ({ "@type": _, ...rest }: Record<string, unknown>) => rest;
  inline.static_resources.listeners.push(...(lds.resources as Record<string, unknown>[]).map(strip));
  inline.static_resources.clusters.push(...(cds.resources as Record<string, unknown>[]).map(strip));
  await put(`${CUSTODIAN_POD_CONFIG}/inline.json`, JSON.stringify(inline));

  const pod = await validate(CUSTODIAN_POD_BOOTSTRAP);
  assert.equal(pod.code, 0, `the pod's bootstrap:\n${pod.output}`);
  assert.match(pod.output, /configuration '.*' OK/);
  const all = await validate(`${CUSTODIAN_POD_CONFIG}/inline.json`);
  assert.equal(all.code, 0, `the slots inline:\n${all.output}`);
  assert.match(all.output, /configuration '.*' OK/);
});

// ---- the slot's rules, run ----------------------------------------------------------------------

const docker = (...args: string[]) => exec("docker", args, { maxBuffer: 1 << 24 }).then((r) => r.stdout.trim());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The address of a container on each of its networks. */
async function addresses(container: string): Promise<Record<string, string>> {
  const nets = JSON.parse(await docker("inspect", "-f", "{{json .NetworkSettings.Networks}}", container)) as Record<
    string,
    { IPAddress: string }
  >;
  return Object.fromEntries(Object.entries(nets).map(([n, v]) => [n, v.IPAddress]));
}

/** One HTTP/1.1 request as written, and the whole answer as text. */
function rawHttp(host: string, port: number, request: string): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const s: Socket = connect(port, host);
    s.setTimeout(10_000, () => s.destroy());
    s.on("data", (d: Buffer) => chunks.push(d));
    s.on("error", () => {});
    s.on("close", () => resolve(Buffer.concat(chunks).toString()));
    s.write(request);
  });
}

const get = (host: string, port: number, authority: string, target = "/", extra = "") =>
  rawHttp(host, port, `GET ${target} HTTP/1.1\r\nHost: ${authority}\r\n${extra}Connection: close\r\n\r\n`);

/** What a TLS client that sends `servername` (none when undefined) gets back for its hello: the
 * first bytes the Custodian sends, a TLS alert (0x15) or a server hello (0x16), or nothing. */
async function helloReply(host: string, port: number, servername?: string): Promise<Buffer> {
  const [inner, outer] = duplexPair();
  const s = connect(port, host);
  const chunks: Buffer[] = [];
  outer.on("data", (d: Buffer) => s.write(d));
  s.on("data", (d: Buffer) => chunks.push(d));
  s.on("error", () => {});
  const client = tlsConnect({ socket: inner, host: "127.0.0.1", servername, rejectUnauthorized: false });
  client.on("error", () => {});
  await new Promise<void>((resolve) => {
    s.on("close", () => resolve());
    setTimeout(resolve, 3_000);
  });
  s.destroy();
  client.destroy();
  return Buffer.concat(chunks);
}

/** A plain target of the pinned image itself: ports 80, 6379 and 443 (TLS, with `cert`) answer 200
 * with their port and the forwarding headers that the request arrived with. */
function targetBootstrap(): unknown {
  const listener = (port: number, tls: boolean) => ({
    name: `p${port}`,
    address: { socket_address: { address: "0.0.0.0", port_value: port } },
    filter_chains: [
      {
        ...(tls
          ? {
              transport_socket: {
                name: "envoy.transport_sockets.tls",
                typed_config: {
                  "@type": "type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext",
                  common_tls_context: {
                    tls_certificates: [
                      {
                        certificate_chain: { filename: "/etc/target/tls.crt" },
                        private_key: { filename: "/etc/target/tls.key" },
                      },
                    ],
                  },
                },
              },
            }
          : {}),
        filters: [
          {
            name: "envoy.filters.network.http_connection_manager",
            typed_config: {
              "@type":
                "type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager",
              stat_prefix: `p${port}`,
              generate_request_id: false,
              skip_xff_append: true,
              local_reply_config: {
                body_format: {
                  text_format_source: {
                    inline_string:
                      `port=${port} xfp=%REQ(X-FORWARDED-PROTO)% xff=%REQ(X-FORWARDED-FOR)% ` +
                      "rid=%REQ(X-REQUEST-ID)% xei=%REQ(X-ENVOY-INTERNAL)% fence=%REQ(X-JR2-FENCE-SLOT)%\n",
                  },
                },
              },
              http_filters: [
                {
                  name: "envoy.filters.http.router",
                  typed_config: { "@type": "type.googleapis.com/envoy.extensions.filters.http.router.v3.Router" },
                },
              ],
              route_config: {
                virtual_hosts: [
                  {
                    name: "all",
                    domains: ["*"],
                    routes: [{ match: { prefix: "/" }, direct_response: { status: 200 } }],
                  },
                ],
              },
            },
          },
        ],
      },
    ],
  });
  return { static_resources: { listeners: [listener(80, false), listener(6379, false), listener(443, true)] } };
}

test("the pinned Envoy runs a slot's rules: a wildcard dials the port of its rule alone, on port 80 and on another port, a wildcard carries no Intercepted host in another spelling, no target gets a forwarding header, and the Orchestrator's dial fails closed (ADR-0084, ADR-0059)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jr2-custodian-run-"));
  const tag = `${process.pid}-${Date.now() % 100000}`;
  const [netA, netB] = [`jr2-crules-a-${tag}`, `jr2-crules-b-${tag}`];
  const [targetName, custodianName] = [`jr2-crules-target-${tag}`, `jr2-crules-custodian-${tag}`];
  t.after(async () => {
    await docker("rm", "-f", targetName, custodianName).catch(() => {});
    await docker("network", "rm", netA, netB).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const gid = String(process.getgid?.() ?? 0);
  const user = ["--user", `65532:${gid}`, "--group-add", gid, "--read-only", "--cap-drop", "ALL"];
  await docker("network", "create", netA);
  await docker("network", "create", netB);

  // The target: `other.test` (no entry names it: `*` carries it) and `secure.test` (Intercepted).
  const ca = issueCa("custodian-rules-run");
  const targetCa = issueCa("custodian-rules-target");
  const targetLeaf = issueLeaf(targetCa, "secure.test");
  await mkdir(join(root, "target"), { recursive: true });
  await writeFile(join(root, "target", "envoy.json"), JSON.stringify(targetBootstrap()), { mode: 0o644 });
  await writeFile(join(root, "target", "tls.crt"), targetLeaf.cert, { mode: 0o644 });
  await writeFile(join(root, "target", "tls.key"), targetLeaf.key, { mode: 0o644 });
  // prettier-ignore
  await docker(
    "run", "-d", "--name", targetName, "--network", netA,
    "--network-alias", "other.test", "--network-alias", "secure.test",
    ...user, "-v", `${join(root, "target")}:/etc/target:ro`,
    custodianRef(), "-c", "/etc/target/envoy.json", "--log-level", "warning",
  );

  // One Sandbox slot: `*` on 443, 80 and 6379, and `secure.test:443` Intercepted with no secret.
  const egress = [
    rule("*", 443, "any", false, "entry"),
    rule("*", 80, "any", false, "entry"),
    rule("*", 6379, "any", false, "entry"),
    rule("secure.test", 443, "name", true, "entry"),
  ];
  const placeholders = withPlaceholders(emptyPlaceholders(RANGES.placeholders), egress);
  const inputs: SlotInputs = {
    slot: 3,
    owner: { sandbox: "probe" },
    manifest: { version: 1, secrets: [], egress },
    placeholders,
    ranges: RANGES,
  };
  const slot = renderSlot(inputs);
  await slotFiles(inputs, ca, root);
  await putIn(CUSTODIAN_POD_PROGRAM, CUSTODIAN_PROGRAM, root);
  await putIn("/etc/jr2/ca/upstream.crt", trustBundles(ca.cert, targetCa.cert).upstream, root);
  const bootstrap = custodianPodBootstrap({
    orchestrator: { host: "orchestrator.invalid", port: 4000 },
    range: 0,
    ranges: RANGES,
  }) as { static_resources: { listeners: Array<Record<string, any>> } };
  // A program that raises on the Orchestrator's dial: its target table is broken on purpose, so the
  // dial meets an error after the token check passed.
  const inbound = bootstrap.static_resources.listeners.find((l) => l.name === "inbound")!;
  const manager = inbound.filter_chains[0].filters.find(
    (f: { name: string }) => f.name === "envoy.filters.network.http_connection_manager",
  );
  const source = manager.typed_config.http_filters[0].typed_config.default_source_code;
  source.inline_string = (source.inline_string as string).replace("dofile(", "HELD.inbound.targets = 5\ndofile(");
  await putIn(CUSTODIAN_POD_BOOTSTRAP, JSON.stringify(bootstrap), root);
  const empty = JSON.stringify({ version_info: "0", resources: [] });
  await putIn(CUSTODIAN_LDS, empty, root);
  await putIn(CUSTODIAN_CDS, empty, root);

  // prettier-ignore
  await docker(
    "create", "--name", custodianName, "--network", netA, ...user,
    "-v", `${join(root, "etc")}:/etc/jr2:ro`, "-v", `${join(root, "state")}:${CUSTODIAN_STATE}:ro`,
    custodianRef(), ...CUSTODIAN_POD_ARGS,
  );
  await docker("network", "connect", netB, custodianName);
  let output = "";
  const child = spawn("docker", ["start", "-a", custodianName], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (b: Buffer) => (output += b.toString()));
  child.stderr.on("data", (b: Buffer) => (output += b.toString()));
  t.after(() => void child.kill());

  const target = (await addresses(targetName))[netA]!;
  let custodian: Record<string, string> = {};
  for (let i = 0; i < 100 && !(custodian[netA] && custodian[netB]); i++) {
    custodian = await addresses(custodianName).catch(() => ({}));
    await sleep(100);
  }
  const [any, secure] = [custodian[netA]!, custodian[netB]!];
  assert.ok(any && secure, `the Custodian has an address on each network: ${JSON.stringify(custodian)}`);

  // The uplink sends a slot's connection to port 20000 + slot whatever address was dialed. Here a
  // client dials the Custodian's own address, so the slot's listener takes ports 80 and 443, and
  // the placeholders of `*` and `secure.test` become the Custodian's two addresses.
  const moved = (text: string, from: string, to: string) =>
    text.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`"${from}:`, `"${to}:`);
  let lds = JSON.stringify(custodianXds([slot]).lds);
  lds = moved(lds, placeholderOf(placeholders, "*")!, any);
  lds = moved(lds, placeholderOf(placeholders, "secure.test")!, secure);
  const parsed = JSON.parse(lds) as { version_info: string; resources: Array<Record<string, any>> };
  const on443 = structuredClone(parsed.resources[0]!);
  parsed.resources[0]!.address.socket_address.port_value = 80;
  on443.name = "slot-3-443";
  on443.address.socket_address.port_value = 443;
  parsed.resources.push(on443);
  const on6379 = structuredClone(on443);
  on6379.name = "slot-3-6379";
  on6379.address.socket_address.port_value = 6379;
  parsed.resources.push(on6379);
  parsed.version_info = "1";
  const xds = local(CUSTODIAN_LDS, root);
  await writeFile(`${xds}.next`, JSON.stringify(parsed), { mode: 0o644 });
  await rename(`${xds}.next`, xds);

  const deadline = Date.now() + 30_000;
  for (;;) {
    const answer = await get(any, 80, "other.test");
    const fromTarget = await get(target, 80, "x");
    if (answer.startsWith("HTTP/1.1 200") && fromTarget.startsWith("HTTP/1.1 200")) break;
    if (Date.now() > deadline || child.exitCode !== null) {
      assert.fail(`the slot never served:\n${answer}\n${fromTarget}\n${output}`);
    }
    await sleep(200);
  }
  const body = (answer: string) => answer.slice(answer.indexOf("\r\n\r\n") + 4);
  const status = (answer: string) => answer.split("\r\n")[0];

  // Finding 1: a wildcard on port 80 dials port 80 alone, whatever port the Host names.
  for (const authority of ["other.test", "other.test:80"]) {
    const answer = await get(any, 80, authority);
    assert.equal(status(answer), "HTTP/1.1 200 OK", authority);
    assert.match(body(answer), /^port=80 /, authority);
  }
  for (const [authority, path] of [
    ["other.test:6379", "/"],
    ["other.test:6379", "http://other.test:6379/"],
    ["other.test:8080", "/"],
  ] as const) {
    const answer = await get(any, 80, authority, path);
    assert.equal(status(answer), "HTTP/1.1 403 Forbidden", `${authority} ${path}: ${answer}`);
    assert.match(body(answer), /port other than 80/);
    assert.doesNotMatch(answer, /port=6379|port=8080/);
  }

  // A wildcard on another port carries plain HTTP there too, and dials that port alone.
  {
    const answer = await get(any, 6379, "other.test:6379");
    assert.equal(status(answer), "HTTP/1.1 200 OK", answer);
    assert.match(body(answer), /^port=6379 /);
  }
  for (const authority of ["other.test", "other.test:80", "other.test:443"]) {
    const answer = await get(any, 6379, authority);
    assert.equal(status(answer), "HTTP/1.1 403 Forbidden", `${authority}: ${answer}`);
    assert.match(body(answer), /port other than 6379/, authority);
  }

  // A name with a trailing dot is refused on port 80, as the CONNECT of a tunnel refuses it.
  for (const authority of ["other.test.", "OTHER.TEST.", "other.test.:80"]) {
    const answer = await get(any, 80, authority);
    assert.equal(status(answer), "HTTP/1.1 403 Forbidden", `${authority}: ${answer}`);
    assert.match(body(answer), /ends in a dot/, authority);
  }

  // Finding 2: an Intercepted host and jr2's name are refused in any letter case, and with a dot.
  for (const authority of ["secure.test", "SECURE.TEST", "Secure.Test:80", "secure.test."]) {
    const answer = await get(any, 80, authority);
    assert.equal(status(answer), "HTTP/1.1 403 Forbidden", `${authority}: ${answer}`);
    assert.match(body(answer), /Intercepted host/, authority);
  }
  for (const authority of ["CUSTODIAN.JR2.INTERNAL", "custodian.jr2.internal.:80"]) {
    const answer = await get(any, 80, authority);
    assert.equal(status(answer), "HTTP/1.1 403 Forbidden", `${authority}: ${answer}`);
    assert.match(body(answer), /a name of jr2's/, authority);
  }
  const alert = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x31]);
  const tunneled = await helloReply(any, 443, "other.test");
  assert.equal(tunneled[0], 0x16, "a name that `*` carries is tunneled: the target's server hello");
  for (const servername of ["secure.test", "secure.test.", "custodian.jr2.internal."]) {
    const reply = await helloReply(any, 443, servername);
    assert.deepEqual(reply, alert, `${servername}: the Custodian's TLS alert, and no byte of the target`);
  }

  // Finding 3 and 8: TLS with no name on `*` is refused by name, and the dial listener's line names
  // the Sandbox as each line of the slot does.
  const nameless = await helloReply(any, 443, undefined);
  assert.notEqual(nameless[0], 0x16, "no server hello");
  const line = /jr2\.custodian slot=3 sandbox=probe action=refuse target=-:443 reason=name /;
  for (let i = 0; i < 30 && !line.test(output); i++) await sleep(200);
  assert.match(output, line);
  assert.doesNotMatch(output, /owner=/);
  // A name that does not resolve is the one `unreachable` line; a tunnel that its client closed is
  // no refusal.
  await helloReply(any, 443, "nothing.invalid");
  const unreachable =
    /jr2\.custodian slot=3 sandbox=probe action=refuse target=nothing\.invalid:443 reason=unreachable /;
  for (let i = 0; i < 30 && !unreachable.test(output); i++) await sleep(200);
  assert.match(output, unreachable);
  assert.doesNotMatch(output, /target=other\.test:443 reason=/);

  // Finding 4: a target gets no forwarding header, on a tunnel and through an interception.
  assert.match(body(await get(any, 80, "other.test")), /^port=80 xfp=http xff=- rid=- xei=- fence=-\n$/);
  const intercepted = await new Promise<string>((resolve, reject) => {
    const s = tlsConnect({ host: secure, port: 443, servername: "secure.test", rejectUnauthorized: false }, () =>
      s.write("GET / HTTP/1.1\r\nHost: secure.test\r\nConnection: close\r\n\r\n"),
    );
    let text = "";
    s.on("data", (d: Buffer) => (text += d.toString()));
    s.on("error", reject);
    s.on("close", () => resolve(text));
  });
  assert.equal(status(intercepted), "HTTP/1.1 200 OK", intercepted);
  // The target set `https` itself: the Custodian sent no `x-forwarded-proto`.
  assert.match(body(intercepted), /^port=443 xfp=https xff=- rid=- xei=- fence=-\n$/);

  // Finding 6 and 11: the Orchestrator's dial. Each refusal of the Custodian's own says so, and an
  // error of the program refuses the dial; nothing reaches the target.
  const dial = (token: string) => get(any, 18080, "x", "/", `x-jr2-dial: ${token}\r\nx-jr2-target: ${target}:80\r\n`);
  let answer = await dial("t");
  assert.equal(status(answer), "HTTP/1.1 503 Service Unavailable", answer);
  assert.match(answer, /\r\nx-jr2-custodian: not-ready\r\n/i);
  // The token's path is a folder: it opens, and reads as nothing.
  await mkdir(local(CUSTODIAN_DIAL_TOKEN, root));
  answer = await dial("t");
  assert.equal(status(answer), "HTTP/1.1 503 Service Unavailable", answer);
  assert.match(answer, /\r\nx-jr2-custodian: not-ready\r\n/i);
  await rmdir(local(CUSTODIAN_DIAL_TOKEN, root));
  await putIn(CUSTODIAN_DIAL_TOKEN, "dial-token-value\n", root);
  answer = await dial("wrong");
  assert.equal(status(answer), "HTTP/1.1 403 Forbidden", answer);
  assert.match(answer, /\r\nx-jr2-custodian: refused\r\n/i);
  answer = await dial("dial-token-value");
  assert.equal(status(answer), "HTTP/1.1 503 Service Unavailable", answer);
  assert.match(answer, /\r\nx-jr2-custodian: refused\r\n/i);
  assert.match(body(answer), /could not decide this request/);
  assert.doesNotMatch(answer, /port=80/);
  assert.match(output, /jr2\.custodian dial action=refuse target=- reason=error /);
});

test("the pinned Envoy runs a slot's rules: the dial guard judges each address of a name, so a name whose second address is guarded never reaches it, on each dial path (ADR-0059, ADR-0084)", async (t) => {
  // A name can have more addresses than one, and Envoy connects to the next one when a connection to
  // one fails. Each name below has a first address that answers nothing and a second one that the
  // guard refuses: a slot address of the segment, or the cloud metadata address. The target listens
  // on that second address. Names resolve through the Custodian container's `/etc/hosts`, as a DNS
  // record that Workspace code's author controls could answer. No two lines share an address or a
  // name, so the resolver adds no address to a name.
  const root = await mkdtemp(join(tmpdir(), "jr2-custodian-guard-"));
  const tag = `${process.pid}-${Date.now() % 100000}`;
  const nets = ["a", "b", "c"].map((n) => `jr2-cguard-${n}-${tag}`);
  // One network for each guarded address of the target: a container has one address on a network.
  const guardedNets = [
    ["198.19.0.0/26", "198.19.0.5"],
    ["198.19.0.64/26", "198.19.0.69"],
    ["198.19.0.128/26", "198.19.0.133"],
    ["198.19.0.192/26", "198.19.0.197"],
    ["169.254.169.0/24", "169.254.169.254"],
  ].map(([subnet, address], i) => ({ net: `jr2-cguard-g${i}-${tag}`, subnet: subnet!, address: address! }));
  const [targetName, custodianName] = [`jr2-cguard-target-${tag}`, `jr2-cguard-custodian-${tag}`];
  t.after(async () => {
    await docker("rm", "-f", targetName, custodianName).catch(() => {});
    for (const n of [...nets, ...guardedNets.map((g) => g.net)]) await docker("network", "rm", n).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const gid = String(process.getgid?.() ?? 0);
  const user = ["--user", `65532:${gid}`, "--group-add", gid, "--read-only", "--cap-drop", "ALL"];
  for (const n of nets) await docker("network", "create", n);
  for (const g of guardedNets) await docker("network", "create", "--subnet", g.subnet, g.net);

  const ca = issueCa("custodian-guard-run");
  const targetCa = issueCa("custodian-guard-target");
  const targetLeaf = issueLeaf(targetCa, "secure.test");
  await mkdir(join(root, "target"), { recursive: true });
  await writeFile(join(root, "target", "envoy.json"), JSON.stringify(targetBootstrap()), { mode: 0o644 });
  await writeFile(join(root, "target", "tls.crt"), targetLeaf.cert, { mode: 0o644 });
  await writeFile(join(root, "target", "tls.key"), targetLeaf.key, { mode: 0o644 });
  // prettier-ignore
  await docker(
    "run", "-d", "--name", targetName, "--network", nets[0]!, ...user,
    "-v", `${join(root, "target")}:/etc/target:ro`,
    custodianRef(), "-c", "/etc/target/envoy.json", "--log-level", "warning",
  );
  for (const g of guardedNets) await docker("network", "connect", "--ip", g.address, g.net, targetName);
  const target = (await addresses(targetName))[nets[0]!]!;
  // Addresses of the target's first network that no container holds: a connection to one fails.
  const nobody = (n: number) => target.replace(/\.\d+$/, `.${200 + n}`);
  const [seg1, seg2, seg3, segOnly, metadata] = guardedNets.map((g) => g.address);

  // One Sandbox slot: `*` on 443 and 80, `secure.test:443` Intercepted with no secret, and a raw
  // name on 6379.
  const egress = [
    rule("*", 443, "any", false, "entry"),
    rule("*", 80, "any", false, "entry"),
    rule("secure.test", 443, "name", true, "entry"),
    rule("raw.test", 6379, "name", false, "entry"),
  ];
  const placeholders = withPlaceholders(emptyPlaceholders(RANGES.placeholders), egress);
  const inputs: SlotInputs = {
    slot: 3,
    owner: { sandbox: "probe" },
    manifest: { version: 1, secrets: [], egress },
    placeholders,
    ranges: RANGES,
  };
  const slot = renderSlot(inputs);
  await slotFiles(inputs, ca, root);
  await putIn(CUSTODIAN_POD_PROGRAM, CUSTODIAN_PROGRAM, root);
  await putIn("/etc/jr2/ca/upstream.crt", trustBundles(ca.cert, targetCa.cert).upstream, root);
  const bootstrap = custodianPodBootstrap({
    orchestrator: { host: "orchestrator.invalid", port: 4000 },
    range: 0,
    ranges: RANGES,
  });
  await putIn(CUSTODIAN_POD_BOOTSTRAP, JSON.stringify(bootstrap), root);
  const empty = JSON.stringify({ version_info: "0", resources: [] });
  await putIn(CUSTODIAN_LDS, empty, root);
  await putIn(CUSTODIAN_CDS, empty, root);
  const hosts = [
    "127.0.0.1 localhost",
    `${target} other.test`,
    `${nobody(1)} multi.test`,
    `${seg1} multi.test`,
    `${nobody(2)} secure.test`,
    `${seg2} secure.test`,
    `${nobody(3)} raw.test`,
    `${seg3} raw.test`,
    `${nobody(4)} meta.test`,
    `${metadata} meta.test`,
    `${segOnly} seg.test`,
    "",
  ].join("\n");
  await writeFile(join(root, "hosts"), hosts, { mode: 0o644 });

  // prettier-ignore
  await docker(
    "create", "--name", custodianName, "--network", nets[0]!, ...user,
    "-v", `${join(root, "etc")}:/etc/jr2:ro`, "-v", `${join(root, "state")}:${CUSTODIAN_STATE}:ro`,
    "-v", `${join(root, "hosts")}:/etc/hosts:ro`,
    custodianRef(), ...CUSTODIAN_POD_ARGS,
  );
  for (const n of [...nets.slice(1), ...guardedNets.map((g) => g.net)]) {
    await docker("network", "connect", n, custodianName);
  }
  let output = "";
  const child = spawn("docker", ["start", "-a", custodianName], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (b: Buffer) => (output += b.toString()));
  child.stderr.on("data", (b: Buffer) => (output += b.toString()));
  t.after(() => void child.kill());

  let custodian: Record<string, string> = {};
  for (let i = 0; i < 100 && !nets.every((n) => custodian[n]); i++) {
    custodian = await addresses(custodianName).catch(() => ({}));
    await sleep(100);
  }
  const [any, secure, raw] = nets.map((n) => custodian[n]!);
  assert.ok(any && secure && raw, `the Custodian has an address on each network: ${JSON.stringify(custodian)}`);

  // As in the test above: the slot's listener takes ports 80, 443 and 6379 of the Custodian, and the
  // placeholders of `*`, `secure.test` and `raw.test` become its three addresses.
  const moved = (text: string, from: string, to: string) =>
    text.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`"${from}:`, `"${to}:`);
  let lds = JSON.stringify(custodianXds([slot]).lds);
  lds = moved(lds, placeholderOf(placeholders, "*")!, any);
  lds = moved(lds, placeholderOf(placeholders, "secure.test")!, secure);
  lds = moved(lds, placeholderOf(placeholders, "raw.test")!, raw);
  const parsed = JSON.parse(lds) as { version_info: string; resources: Array<Record<string, any>> };
  parsed.resources = [80, 443, 6379].map((port) => {
    const listener = structuredClone(parsed.resources[0]!);
    listener.name = `slot-3-${port}`;
    listener.address.socket_address.port_value = port;
    return listener;
  });
  parsed.version_info = "1";
  const xds = local(CUSTODIAN_LDS, root);
  await writeFile(`${xds}.next`, JSON.stringify(parsed), { mode: 0o644 });
  await rename(`${xds}.next`, xds);

  const deadline = Date.now() + 30_000;
  for (;;) {
    const answer = await get(any, 80, "other.test");
    if (answer.startsWith("HTTP/1.1 200") && /port=80 /.test(answer)) break;
    if (Date.now() > deadline || child.exitCode !== null) assert.fail(`the slot never served:\n${answer}\n${output}`);
    await sleep(200);
  }
  // The target is reachable on each guarded address, so a miss below is the guard's, not the rig's.
  for (const address of [seg1, seg2, seg3, segOnly, metadata]) {
    assert.match(await get(address!, 80, "x"), /^HTTP\/1\.1 200[\s\S]*port=80 /, `the target answers on ${address}`);
  }
  const status = (answer: string) => answer.split("\r\n")[0];
  const fromTarget = /port=(80|443|6379) /;

  // Plain HTTP through `*` on port 80 (the `dial-http` listener): the slot address, and the cloud
  // metadata address, behind a first address that fails.
  for (const host of ["multi.test", "meta.test"]) {
    for (let i = 0; i < 2; i++) {
      const answer = await get(any, 80, host);
      assert.doesNotMatch(answer, fromTarget, `${host}: no byte of the target\n${answer}`);
      assert.notEqual(status(answer), "HTTP/1.1 200 OK", `${host}: ${answer}`);
    }
  }
  // A TLS tunnel through `*` on port 443 (the `dial` listener): no server hello of the target.
  for (let i = 0; i < 2; i++) {
    const reply = await helloReply(any, 443, "multi.test");
    assert.notEqual(reply[0], 0x16, "multi.test on 443: no server hello of the target");
  }
  // An Intercepted host (the `dial-tls` listener): the Custodian's own TLS to the target, refused.
  for (let i = 0; i < 2; i++) {
    const intercepted = await new Promise<string>((resolve) => {
      const s = tlsConnect({ host: secure, port: 443, servername: "secure.test", rejectUnauthorized: false }, () =>
        s.write("GET / HTTP/1.1\r\nHost: secure.test\r\nConnection: close\r\n\r\n"),
      );
      let text = "";
      s.setTimeout(10_000, () => s.destroy());
      s.on("data", (d: Buffer) => (text += d.toString()));
      s.on("error", () => resolve(text));
      s.on("close", () => resolve(text));
    });
    assert.doesNotMatch(intercepted, fromTarget, `secure.test: no byte of the target\n${intercepted}`);
    assert.notEqual(status(intercepted), "HTTP/1.1 200 OK", intercepted);
  }
  // A raw name on port 6379 (the `dial` listener): the target would answer HTTP on 6379.
  for (let i = 0; i < 2; i++) {
    const answer = await rawHttp(raw, 6379, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    assert.doesNotMatch(answer, fromTarget, `raw.test:6379: no byte of the target\n${answer}`);
  }
  // No line of a dial says that one of these names was carried.
  assert.doesNotMatch(output, /target=(multi|meta|secure|raw)\.test\S* .*status=200/);

  // A name with no address left (a slot address alone, or `localhost`): the guard's refusal, and
  // its line.
  for (const host of ["seg.test", "localhost"]) {
    const answer = await get(any, 80, host);
    assert.equal(status(answer), "HTTP/1.1 403 Forbidden", `${host}: ${answer}`);
    assert.match(answer, /resolves to an address that the Custodian never dials/, host);
  }
  const reply = await helloReply(any, 443, "seg.test");
  assert.equal(reply.length, 0, "seg.test on 443: closed with no byte");
  for (const line of [
    /jr2\.custodian slot=3 sandbox=probe action=refuse target=seg\.test reason=guard /,
    /jr2\.custodian slot=3 sandbox=probe action=refuse target=seg\.test:443 reason=guard /,
    /jr2\.custodian slot=3 sandbox=probe action=refuse target=localhost reason=guard /,
  ]) {
    for (let i = 0; i < 30 && !line.test(output); i++) await sleep(200);
    assert.match(output, line);
  }
});

/** Two Sandbox slots of one Custodian pod, run by the pinned Envoy: slots 3 and 4, each with `*` on
 * 80 and 443, each on its own docker network and its own address of the Custodian. The target is
 * the pinned image (`targetBootstrap`) at `early.test`. The Custodian's resolver is 127.0.0.1, where
 * nothing listens, so no lookup leaves the host; the names that resolve are in its `/etc/hosts`.
 * The bootstrap takes `pod`, the options a test changes. It returns when slot 4 serves. */
async function twoSlots(
  t: { after: (fn: () => unknown) => void },
  prefix: string,
  pod: Pick<Parameters<typeof custodianPodBootstrap>[0], "nameCache" | "connections">,
): Promise<{ s3: string; s4: string; output: () => string }> {
  const root = await mkdtemp(join(tmpdir(), `jr2-${prefix}-`));
  const tag = `${process.pid}-${Date.now() % 100000}`;
  const nets = ["a", "b"].map((n) => `jr2-${prefix}-${n}-${tag}`);
  const [targetName, custodianName] = [`jr2-${prefix}-target-${tag}`, `jr2-${prefix}-custodian-${tag}`];
  t.after(async () => {
    await docker("rm", "-f", targetName, custodianName).catch(() => {});
    for (const n of nets) await docker("network", "rm", n).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const gid = String(process.getgid?.() ?? 0);
  const user = ["--user", `65532:${gid}`, "--group-add", gid, "--read-only", "--cap-drop", "ALL"];
  for (const n of nets) await docker("network", "create", n);

  const ca = issueCa(`${prefix}-run`);
  const targetCa = issueCa(`${prefix}-target`);
  const targetLeaf = issueLeaf(targetCa, "early.test");
  await mkdir(join(root, "target"), { recursive: true });
  await writeFile(join(root, "target", "envoy.json"), JSON.stringify(targetBootstrap()), { mode: 0o644 });
  await writeFile(join(root, "target", "tls.crt"), targetLeaf.cert, { mode: 0o644 });
  await writeFile(join(root, "target", "tls.key"), targetLeaf.key, { mode: 0o644 });
  // prettier-ignore
  await docker(
    "run", "-d", "--name", targetName, "--network", nets[0]!, ...user,
    "-v", `${join(root, "target")}:/etc/target:ro`,
    custodianRef(), "-c", "/etc/target/envoy.json", "--log-level", "warning",
  );
  const target = (await addresses(targetName))[nets[0]!]!;

  const egress = [rule("*", 80, "any", false, "entry"), rule("*", 443, "any", false, "entry")];
  const slots: SlotInputs[] = [3, 4].map((slot) => ({
    slot,
    owner: { sandbox: `probe-${slot}` },
    manifest: { version: 1, secrets: [], egress },
    placeholders: withPlaceholders(emptyPlaceholders(RANGES.placeholders), egress),
    ranges: RANGES,
  }));
  for (const s of slots) await slotFiles(s, ca, root);
  await putIn(CUSTODIAN_POD_PROGRAM, CUSTODIAN_PROGRAM, root);
  await putIn("/etc/jr2/ca/upstream.crt", trustBundles(ca.cert, targetCa.cert).upstream, root);
  const bootstrap = custodianPodBootstrap({
    orchestrator: { host: "orchestrator.invalid", port: 4000 },
    range: 0,
    ranges: RANGES,
    ...pod,
  });
  await putIn(CUSTODIAN_POD_BOOTSTRAP, JSON.stringify(bootstrap), root);
  await putIn(CUSTODIAN_DIAL_TOKEN, "dial-token-value\n", root);
  const empty = JSON.stringify({ version_info: "0", resources: [] });
  await putIn(CUSTODIAN_LDS, empty, root);
  await putIn(CUSTODIAN_CDS, empty, root);
  const hosts = ["127.0.0.1 localhost", `${target} early.test late.test late2.test`, ""].join("\n");
  await writeFile(join(root, "hosts"), hosts, { mode: 0o644 });
  await writeFile(join(root, "resolv.conf"), "nameserver 127.0.0.1\noptions timeout:1 attempts:1\n", { mode: 0o644 });

  // prettier-ignore
  await docker(
    "create", "--name", custodianName, "--network", nets[0]!, ...user,
    "-v", `${join(root, "etc")}:/etc/jr2:ro`, "-v", `${join(root, "state")}:${CUSTODIAN_STATE}:ro`,
    "-v", `${join(root, "hosts")}:/etc/hosts:ro`, "-v", `${join(root, "resolv.conf")}:/etc/resolv.conf:ro`,
    custodianRef(), ...CUSTODIAN_POD_ARGS,
  );
  await docker("network", "connect", nets[1]!, custodianName);
  let output = "";
  const child = spawn("docker", ["start", "-a", custodianName], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (b: Buffer) => (output += b.toString()));
  child.stderr.on("data", (b: Buffer) => (output += b.toString()));
  t.after(() => void child.kill());

  let custodian: Record<string, string> = {};
  for (let i = 0; i < 100 && !nets.every((n) => custodian[n]); i++) {
    custodian = await addresses(custodianName).catch(() => ({}));
    await sleep(100);
  }
  const [s3, s4] = nets.map((n) => custodian[n]!);
  assert.ok(s3 && s4, `the Custodian has an address on each network: ${JSON.stringify(custodian)}`);

  // Each slot's listener takes ports 80 and 443 of its own address of the Custodian, and the
  // placeholder of `*` becomes that address.
  const parsed = custodianXds(slots.map(renderSlot)).lds as { resources: Array<Record<string, any>> };
  const lds = {
    version_info: "1",
    resources: parsed.resources.flatMap((listener, i) =>
      [80, 443].map((port) => {
        const at = i === 0 ? s3 : s4;
        const from = placeholderOf(slots[i]!.placeholders, "*")!;
        const text = JSON.stringify(listener).replaceAll(`"${from}"`, `"${at}"`).replaceAll(`"${from}:`, `"${at}:`);
        const moved = JSON.parse(text);
        moved.name = `${moved.name}-${port}`;
        moved.address.socket_address = { address: at, port_value: port };
        return moved;
      }),
    ),
  };
  const xds = local(CUSTODIAN_LDS, root);
  await writeFile(`${xds}.next`, JSON.stringify(lds), { mode: 0o644 });
  await rename(`${xds}.next`, xds);

  const deadline = Date.now() + 30_000;
  for (;;) {
    const answer = await get(s4, 80, "early.test");
    if (answer.startsWith("HTTP/1.1 200") && /port=80 /.test(answer)) break;
    if (Date.now() > deadline || child.exitCode !== null) assert.fail(`the slots never served:\n${answer}\n${output}`);
    await sleep(200);
  }
  return { s3, s4, output: () => output };
}

test("the pinned Envoy runs two slots' rules: when one Sandbox fills the Custodian's cache of names, a new name of another slot gets jr2's refusal and a line that names that slot, on HTTP and on a tunnel; a TLS name that is not a DNS name is refused as a name (ADR-0084, ADR-0059)", async (t) => {
  // Every slot of a Custodian pod shares one cache of names (`dialDns`). The renderer takes its
  // bound as an option, so the cache here holds 8 names and 2 lookups in flight. Slot 3 dials names
  // that do not resolve; slot 4 then dials names that do. Each request is an ordinary request by name.
  const { s3, s4, output: log } = await twoSlots(t, "cnames", { nameCache: { hosts: 8, pending: 2 } });
  const status = (answer: string) => answer.split("\r\n")[0];
  const refusal = /^HTTP\/1\.1 503 [\s\S]*\r\n\r\njr2 custodian: refused: the Custodian's cache of names is full/;
  const line = async (pattern: RegExp) => {
    for (let i = 0; i < 30 && !pattern.test(log()); i++) await sleep(200);
    assert.match(log(), pattern);
  };

  // More lookups in flight than the bound: the ones over it get jr2's refusal.
  const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => get(s3, 80, `c${i}.fill.test`)));
  assert.ok(
    burst.some((a) => refusal.test(a)),
    `a lookup over the bound is refused by jr2:\n${burst.map(status).join("\n")}`,
  );
  await line(/jr2\.custodian slot=3 sandbox=probe-3 action=refuse target=c\d+\.fill\.test reason=name-cache /);

  // Slot 3 fills the cache with names that do not resolve.
  for (let i = 0; i < 12; i++) await get(s3, 80, `n${i}.fill.test`);

  // Slot 4: a new name over HTTP gets jr2's refusal and its line.
  const late = await get(s4, 80, "late.test");
  assert.match(late, refusal, late);
  await line(
    /jr2\.custodian slot=4 sandbox=probe-4 action=refuse target=late\.test reason=name-cache method=GET status=503 /,
  );
  // A new name through a tunnel is closed with no byte, and its line names the slot.
  const reply = await helloReply(s4, 443, "late2.test");
  assert.equal(reply.length, 0, "late2.test on 443: closed with no byte");
  await line(/jr2\.custodian slot=4 sandbox=probe-4 action=refuse target=late2\.test:443 reason=name-cache /);
  // A name in the cache still works.
  assert.match(await get(s4, 80, "early.test"), /^HTTP\/1\.1 200[\s\S]*port=80 /);

  // A TLS name that is not a DNS name: the tunnel's CONNECT is refused by the dial listener's codec,
  // which logs it as a name refused, not as a target that gave no answer.
  const odd = await helloReply(s3, 443, "1.2.3.4:22");
  assert.equal(odd.length, 0, "a TLS name with a colon: closed with no byte");
  await line(/jr2\.custodian slot=- - action=refuse target=- reason=name method=- status=400 flags=DPE/);
  await line(/jr2\.custodian slot=3 sandbox=probe-3 action=tunnel target=\*:443 .*sni=invalid:1\.2\.3\.4_22 /);
  assert.doesNotMatch(log(), /reason=unreachable .*flags=DPE/);
});

/** A connection that is held open: `request` (none when undefined) is sent, and the promise resolves
 * when its first answer has arrived, or at once with no request. `closed` tells whether the
 * Custodian closed it. */
async function hold(host: string, port: number, request?: string): Promise<{ socket: Socket; closed: () => boolean }> {
  const socket = connect(port, host);
  let closed = false;
  let answer = "";
  socket.on("error", () => {});
  socket.on("close", () => (closed = true));
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  if (request) {
    socket.write(request);
    await new Promise<void>((resolve) => {
      socket.on("data", (d: Buffer) => {
        answer += d.toString();
        if (answer.includes("\r\n\r\n")) resolve();
      });
      socket.on("close", () => resolve());
      setTimeout(resolve, 5_000);
    });
  }
  return { socket, closed: () => closed };
}

test("the pinned Envoy runs two slots' rules: the Orchestrator's dial listener has its own bound, outside the global limit of the slots, so idle connections to it do not stop a slot, and connections that a Sandbox holds do not stop the dial (ADR-0059, ADR-0084)", async (t) => {
  // The pod's bounds are options, so here the slots hold 10 connections together and the dial
  // listener holds 4. Each connection is an ordinary client's: idle, or one keep-alive request.
  const { s3, s4 } = await twoSlots(t, "cconns", { connections: { pod: 10, dial: 4 } });
  const held: Array<{ socket: Socket; closed: () => boolean }> = [];
  const release = async () => {
    for (const h of held.splice(0)) h.socket.destroy();
    await sleep(500);
  };
  t.after(() => void release());
  const dialRefused = /^HTTP\/1\.1 403 [\s\S]*a dial to a Harness pod needs the dial token/;
  assert.match(await get(s3, 18080, "x"), dialRefused, "the dial listener answers under its bound");

  // A peer opens as many idle connections to the dial listener as the slots' global limit. The dial
  // listener keeps its own bound of them and closes the rest; a slot still serves.
  for (let i = 0; i < 10; i++) held.push(await hold(s3, 18080));
  await sleep(500);
  assert.equal(held.filter((h) => !h.closed()).length, 4, "the dial listener holds 4 connections, its bound");
  assert.equal(await get(s3, 18080, "x"), "", "a connection over the dial listener's bound: closed with no byte");
  assert.match(await get(s4, 80, "early.test"), /^HTTP\/1\.1 200[\s\S]*port=80 /, "a slot serves");
  assert.match(await get(s3, 80, "early.test"), /^HTTP\/1\.1 200[\s\S]*port=80 /, "the other slot serves");
  await release();

  // A Sandbox holds as many connections as the slots' global limit. A new slot connection is
  // closed; the dial listener still answers.
  for (let i = 0; i < 10; i++) {
    held.push(await hold(s3, 80, "GET / HTTP/1.1\r\nHost: early.test\r\n\r\n"));
  }
  await sleep(500);
  assert.equal(held.filter((h) => !h.closed()).length, 10, "slot 3 holds 10 connections");
  assert.equal(await get(s4, 80, "early.test"), "", "a slot connection over the global limit: closed with no byte");
  assert.match(await get(s3, 18080, "x"), dialRefused, "the dial listener answers at the slots' global limit");
  await release();
  assert.match(await get(s4, 80, "early.test"), /^HTTP\/1\.1 200[\s\S]*port=80 /, "a slot serves again");
});

/** One Sandbox slot whose wildcard and one exact name each get an address of the Custodian: the
 * wildcard's placeholder the address on the first network, the name's placeholder the address on
 * the second. The slot's listener takes ports 80 and 443. The target answers each name of `names`. */
async function wildcardAndName(
  t: { after: (fn: () => unknown) => void },
  prefix: string,
  egress: ReturnType<typeof rule>[],
  wildcard: string,
  name: string,
  names: string[],
): Promise<{ wild: string; own: string; output: () => string }> {
  const root = await mkdtemp(join(tmpdir(), `jr2-${prefix}-`));
  const tag = `${process.pid}-${Date.now() % 100000}`;
  const nets = ["a", "b"].map((n) => `jr2-${prefix}-${n}-${tag}`);
  const [targetName, custodianName] = [`jr2-${prefix}-target-${tag}`, `jr2-${prefix}-custodian-${tag}`];
  t.after(async () => {
    await docker("rm", "-f", targetName, custodianName).catch(() => {});
    for (const n of nets) await docker("network", "rm", n).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const gid = String(process.getgid?.() ?? 0);
  const user = ["--user", `65532:${gid}`, "--group-add", gid, "--read-only", "--cap-drop", "ALL"];
  for (const n of nets) await docker("network", "create", n);

  const ca = issueCa(`${prefix}-run`);
  const targetCa = issueCa(`${prefix}-target`);
  const targetLeaf = issueLeaf(targetCa, name);
  await mkdir(join(root, "target"), { recursive: true });
  await writeFile(join(root, "target", "envoy.json"), JSON.stringify(targetBootstrap()), { mode: 0o644 });
  await writeFile(join(root, "target", "tls.crt"), targetLeaf.cert, { mode: 0o644 });
  await writeFile(join(root, "target", "tls.key"), targetLeaf.key, { mode: 0o644 });
  // prettier-ignore
  await docker(
    "run", "-d", "--name", targetName, "--network", nets[0]!, ...names.flatMap((n) => ["--network-alias", n]),
    ...user, "-v", `${join(root, "target")}:/etc/target:ro`,
    custodianRef(), "-c", "/etc/target/envoy.json", "--log-level", "warning",
  );

  const placeholders = withPlaceholders(emptyPlaceholders(RANGES.placeholders), egress);
  const inputs: SlotInputs = {
    slot: 3,
    owner: { sandbox: "probe" },
    manifest: { version: 1, secrets: [], egress },
    placeholders,
    ranges: RANGES,
  };
  await slotFiles(inputs, ca, root);
  await putIn(CUSTODIAN_POD_PROGRAM, CUSTODIAN_PROGRAM, root);
  await putIn("/etc/jr2/ca/upstream.crt", trustBundles(ca.cert, targetCa.cert).upstream, root);
  const bootstrap = custodianPodBootstrap({
    orchestrator: { host: "orchestrator.invalid", port: 4000 },
    range: 0,
    ranges: RANGES,
  });
  await putIn(CUSTODIAN_POD_BOOTSTRAP, JSON.stringify(bootstrap), root);
  await putIn(CUSTODIAN_DIAL_TOKEN, "dial-token-value\n", root);
  const empty = JSON.stringify({ version_info: "0", resources: [] });
  await putIn(CUSTODIAN_LDS, empty, root);
  await putIn(CUSTODIAN_CDS, empty, root);

  // prettier-ignore
  await docker(
    "create", "--name", custodianName, "--network", nets[0]!, ...user,
    "-v", `${join(root, "etc")}:/etc/jr2:ro`, "-v", `${join(root, "state")}:${CUSTODIAN_STATE}:ro`,
    custodianRef(), ...CUSTODIAN_POD_ARGS,
  );
  await docker("network", "connect", nets[1]!, custodianName);
  let output = "";
  const child = spawn("docker", ["start", "-a", custodianName], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (b: Buffer) => (output += b.toString()));
  child.stderr.on("data", (b: Buffer) => (output += b.toString()));
  t.after(() => void child.kill());

  let custodian: Record<string, string> = {};
  for (let i = 0; i < 100 && !nets.every((n) => custodian[n]); i++) {
    custodian = await addresses(custodianName).catch(() => ({}));
    await sleep(100);
  }
  const [wild, own] = nets.map((n) => custodian[n]!);
  assert.ok(wild && own, `the Custodian has an address on each network: ${JSON.stringify(custodian)}`);

  const moved = (text: string, from: string, to: string) =>
    text.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`"${from}:`, `"${to}:`);
  let text = JSON.stringify(custodianXds([renderSlot(inputs)]).lds);
  text = moved(text, placeholderOf(placeholders, wildcard)!, wild);
  text = moved(text, placeholderOf(placeholders, name)!, own);
  const parsed = JSON.parse(text) as { version_info: string; resources: Array<Record<string, any>> };
  parsed.resources = [80, 443].map((port) => {
    const listener = structuredClone(parsed.resources[0]!);
    listener.name = `slot-3-${port}`;
    listener.address.socket_address.port_value = port;
    return listener;
  });
  parsed.version_info = "1";
  const xds = local(CUSTODIAN_LDS, root);
  await writeFile(`${xds}.next`, JSON.stringify(parsed), { mode: 0o644 });
  await rename(`${xds}.next`, xds);

  const deadline = Date.now() + 30_000;
  for (;;) {
    const answer = await get(wild, 80, names[names.length - 1]!);
    if (answer.startsWith("HTTP/1.1 200") && /port=80 /.test(answer)) break;
    if (Date.now() > deadline || child.exitCode !== null) assert.fail(`the slot never served:\n${answer}\n${output}`);
    await sleep(200);
  }
  return { wild, own, output: () => output };
}

for (const [label, wildcard, egress, name, other] of [
  [
    "`*`",
    "*",
    [rule("*", 443, "any", false, "entry"), rule("*", 80, "any", false, "entry")],
    "github.test",
    "other.test",
  ],
  [
    "`*.corp.test`",
    "*.corp.test",
    [rule("corp.test", 443, "below", false, "entry"), rule("corp.test", 80, "below", false, "entry")],
    "git.corp.test",
    "web.corp.test",
  ],
] as const) {
  test(`the pinned Envoy runs a slot's rules: a name with an exact entry on port 22 is carried at its own placeholder on 443 and 80, as ${label} permits it (ADR-0084)`, async (t) => {
    // The rule that an SSH Repo derives: the name on port 22, Tunneled.
    const rules = [...egress, rule(name, 22, "name", false, "repo")];
    const { wild, own, output } = await wildcardAndName(t, "cover", rules, wildcard, name, [name, other]);
    const status = (answer: string) => answer.split("\r\n")[0];
    const alert = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x31]);

    // C1: TLS on 443 with the name, to the name's own placeholder: the target's server hello.
    const hello = await helloReply(own, 443, name);
    assert.equal(hello[0], 0x16, `a server hello on 443, not ${hello.toString("hex")}:\n${output()}`);
    // C2: plain HTTP on 80 with the name's `Host`, to its own placeholder: the target's 200.
    for (const authority of [name, `${name}:80`]) {
      const answer = await get(own, 80, authority);
      assert.equal(status(answer), "HTTP/1.1 200 OK", `${authority}: ${answer}`);
      assert.match(answer, /\r\n\r\nport=80 /, authority);
    }
    // The name's placeholder carries that name alone.
    assert.deepEqual(await helloReply(own, 443, other), alert, `${other} at ${name}'s placeholder`);
    const answer = await get(own, 80, other);
    assert.equal(status(answer), "HTTP/1.1 403 Forbidden", answer);
    assert.match(answer, /does not name the host of the address dialed/);
    // The wildcard's placeholder still carries its names.
    assert.equal((await helloReply(wild, 443, other))[0], 0x16, `${other} at the wildcard's placeholder`);
  });
}
