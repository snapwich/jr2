// The Custodian suite's rig (ADR-0059): the REAL engine — the pinned Envoy image, run by docker with
// the bootstrap and script `jr2 up` renders — against local upstreams, with the files a Harness pod
// would mount laid out in a temp directory. Only the pod is faked: the container runs on the host
// network, so its loopback listeners are this process's loopback, and an upstream bound to the
// host's LAN address stands in for a model provider.
//
// Opt-in (`pnpm --filter @jr2/cli test:custodian`, or `just custodian-test`): it needs docker and
// the image, which the default gate does not.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer, request as httpsRequest } from "node:https";
import { createServer as createNetServer, isIP, type AddressInfo, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  custodianBootstrap,
  custodianRef,
  custodianScript,
  CUSTODIAN_ARGS,
  CUSTODIAN_BOOTSTRAP_KEY,
  CUSTODIAN_SCRIPT_KEY,
  type HeldManifest,
} from "@jr2/orchestrator";
import { issueCa, issueLeaf, trustBundles, type Pem } from "../../src/held-pki.ts";

const exec = promisify(execFile);

/** The host's first non-internal IPv4 address: a target the dial guard lets a tunnel reach. */
export function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  throw new Error("no non-loopback IPv4 address on this host — the Custodian suite needs one");
}

/** One recorded request at an upstream. */
export type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; closedAt?: number };

export type Upstream = {
  host: string;
  port: number;
  /** Its own CA, the "private CA" a `caBundle` would carry. */
  ca: Pem;
  seen: Seen[];
  /** What the next request is answered with; default 200 `ok`. */
  handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void;
  close: () => Promise<void>;
};

/** An HTTPS upstream on the LAN address, with a certificate from its own CA. */
export async function startUpstream(host = lanAddress()): Promise<Upstream> {
  const ca = issueCa("upstream-test");
  const leaf = issueLeaf(ca, host);
  const seen: Seen[] = [];
  const upstream: Upstream = {
    host,
    port: 0,
    ca,
    seen,
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    },
    close: async () => {},
  };
  const server = createServer({ cert: leaf.cert, key: leaf.key }, (req, res) => {
    const entry: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers };
    seen.push(entry);
    req.socket.once("close", () => (entry.closedAt = Date.now()));
    req.resume();
    upstream.handler(req, res, entry);
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  upstream.port = (server.address() as AddressInfo).port;
  upstream.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return upstream;
}

export type Custodian = {
  dir: string;
  /** The listeners, on free host ports: the suite runs beside other processes on the host network,
   * so the rendered ports (8081, 15001, 15021) are rewritten — the only edit made to the bootstrap. */
  ports: { control: number; egress: number; health: number };
  /** The jr2 CA the client trusts (`extra.crt`'s addition). */
  ca: Pem;
  /** `extra.crt`: what `NODE_EXTRA_CA_CERTS` names in the Harness container. */
  extraCa: string;
  output: () => string;
  stop: () => Promise<void>;
};

/** Every value this rig wrote, for the no-leak check. */
export const SANDBOX_TOKEN = "sbx-1.signed-token-value";

/**
 * Lay the pod's files out and start the pinned Envoy on them. `values` are the held values by name
 * (written VERBATIM — a test that wants a trailing newline says so); `upstreamCas` are the private CAs
 * `upstream.crt` trusts beside the roots.
 */
export async function startCustodian(opts: {
  manifest: HeldManifest;
  values: Record<string, string>;
  upstreamCas: string[];
  orchestrator: { host: string; port: number };
  sandbox?: string;
  /** Names the container's resolver answers from `/etc/hosts`: the pod's DNS, faked. */
  names?: Record<string, string>;
  expectFailure?: boolean;
}): Promise<Custodian> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-custodian-"));
  for (const sub of ["values", "config", "tls", "ca"]) await mkdir(join(dir, sub));
  const ca = issueCa("custodian-suite");
  for (const secret of opts.manifest.secrets) {
    for (const h of secret.hosts) {
      const leaf = issueLeaf(ca, h.host);
      await writeFile(join(dir, "tls", `${h.leaf}.crt`), leaf.cert);
      await writeFile(join(dir, "tls", `${h.leaf}.key`), leaf.key);
    }
  }
  await writeFile(join(dir, "values", "JR2_SANDBOX_TOKEN"), SANDBOX_TOKEN);
  for (const [name, value] of Object.entries(opts.values)) await writeFile(join(dir, "values", name), value);
  const bundles = trustBundles(ca.cert, opts.upstreamCas.join(""));
  await writeFile(join(dir, "ca", "upstream.crt"), bundles.upstream);
  const ports = { control: await freePort(), egress: await freePort(), health: await freePort() };
  const bootstrap = custodianBootstrap(opts.manifest, opts.orchestrator) as {
    static_resources: { listeners: Array<{ name: string; address?: { socket_address: { port_value: number } } }> };
  };
  for (const listener of bootstrap.static_resources.listeners) {
    const port = ports[listener.name as keyof typeof ports];
    if (port !== undefined && listener.address) listener.address.socket_address.port_value = port;
  }
  await writeFile(join(dir, "config", CUSTODIAN_BOOTSTRAP_KEY), JSON.stringify(bootstrap));
  await writeFile(join(dir, "config", CUSTODIAN_SCRIPT_KEY), custodianScript(opts.manifest));

  const name = `jr2-custodian-suite-${process.pid}-${Date.now() % 100000}`;
  const args = [
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    "host",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-v",
    `${join(dir, "values")}:/etc/jr2/custodian/values:ro`,
    "-v",
    `${join(dir, "config")}:/etc/jr2/custodian/config:ro`,
    "-v",
    `${join(dir, "tls")}:/etc/jr2/custodian/tls:ro`,
    "-v",
    `${join(dir, "ca")}:/etc/jr2/ca:ro`,
    ...(opts.sandbox ? ["-e", `JR2_SANDBOX=${opts.sandbox}`] : []),
    ...Object.entries(opts.names ?? {}).flatMap(([n, ip]) => ["--add-host", `${n}:${ip}`]),
    // Readable by Envoy's uid: the pod's fsGroup does this in a cluster.
    "--user",
    `65532:${process.getgid?.() ?? 0}`,
    "--group-add",
    String(process.getgid?.() ?? 0),
    custodianRef(),
    ...CUSTODIAN_ARGS,
  ];
  let output = "";
  const child: ChildProcess = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (b: Buffer) => (output += b.toString()));
  child.stderr?.on("data", (b: Buffer) => (output += b.toString()));
  const exited = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? -1)));

  const stop = async () => {
    await exec("docker", ["rm", "-f", name]).catch(() => {});
    await exited;
    await rm(dir, { recursive: true, force: true });
  };
  if (opts.expectFailure) {
    const code = await Promise.race([exited, new Promise<number>((r) => setTimeout(() => r(-2), 20_000))]);
    if (code === -2) await stop();
    return { dir, ports, ca, extraCa: bundles.extra, output: () => output, stop };
  }
  const deadline = Date.now() + 20_000;
  for (;;) {
    const ready = await fetch(`http://127.0.0.1:${ports.health}/healthz`).then(
      (r) => r.status === 200,
      () => false,
    );
    if (ready) break;
    if (Date.now() > deadline || child.exitCode !== null) {
      await stop();
      throw new Error(`the Custodian never served:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { dir, ports, ca, extraCa: bundles.extra, output: () => output, stop };
}

/** A port nothing on the host holds right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

/** What one request through the Custodian came back with. */
export type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/**
 * Open a CONNECT tunnel through the Custodian's egress listener. Resolves the socket on 200, or the
 * refusal as an answer — what a client sees when the Custodian says no before any TLS.
 */
export function connectThrough(port: number, authority: string): Promise<{ socket: Socket } | { refused: Answer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      method: "CONNECT",
      path: authority,
      headers: { host: authority },
    });
    req.once("connect", (res, socket, head) => {
      if (res.statusCode === 200) return resolve({ socket });
      socket.destroy();
      resolve({ refused: { status: res.statusCode ?? 0, headers: res.headers, body: head.toString() } });
    });
    req.once("error", reject);
    req.end();
  });
}

/**
 * One HTTPS request to `target` through the Custodian, as a client that trusts `ca` (the Harness's
 * `extra.crt`) would make it. `onResponse` sees the live response, for the streaming cases.
 */
export async function requestThrough(
  port: number,
  target: { host: string; port: number },
  opts: {
    method?: string;
    path?: string;
    headers?: Record<string, string | string[]>;
    body?: string;
    ca: string;
    servername?: string;
    onResponse?: (res: IncomingMessage, req: ClientRequest) => void;
  },
): Promise<Answer> {
  const authority = `${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}`;
  const tunnel = await connectThrough(port, authority);
  if ("refused" in tunnel) return tunnel.refused;
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: target.host,
        port: target.port,
        method: opts.method ?? "GET",
        path: opts.path ?? "/",
        headers: { host: authority, ...opts.headers },
        createConnection: () =>
          tlsConnect({
            socket: tunnel.socket,
            host: target.host,
            ca: opts.ca,
            servername: isIP(target.host) ? undefined : (opts.servername ?? target.host),
            ALPNProtocols: ["http/1.1"],
          }),
      },
      (res) => {
        if (opts.onResponse) opts.onResponse(res, req);
        let body = "";
        res.on("data", (b: Buffer) => (body += b.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        res.on("error", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        res.on("aborted", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.once("error", reject);
    req.end(opts.body);
  });
}

/** One plain-HTTP request to the Custodian's control listener, as the Harness's Menu makes it. */
export async function controlRequest(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: opts.method ?? "GET",
    headers: opts.headers,
    body: opts.body,
  });
  return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
}

/** A plain-HTTP stand-in for the Orchestrator's Service, recording what the Custodian forwards. */
export async function startFakeOrchestrator(): Promise<{
  port: number;
  seen: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: string }>;
  /** The next `n` requests get their connection closed and no answer: a pooled connection the
   * Orchestrator closed as the request arrived. */
  drop: (n: number) => void;
  close: () => Promise<void>;
}> {
  const seen: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: string }> = [];
  let dropping = 0;
  const server = createHttpServer((req, res) => {
    if (dropping > 0) {
      dropping -= 1;
      req.socket.destroy();
      return;
    }
    let body = "";
    req.on("data", (b: Buffer) => (body += b.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, lanAddress(), resolve));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    drop: (n) => {
      dropping = n;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
