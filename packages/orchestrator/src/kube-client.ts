// The Orchestrator's Kubernetes client (ADR-0063): plain REST on Node's built-in `fetch`, with no
// dependency. The Orchestrator is always in-cluster (ADR-0019), so the whole of "configuration" is
// the ServiceAccount the kubelet mounts and the Service the API server publishes:
//
//   base URL   https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT
//   bearer     the SA token FILE, read on every request (below)
//   trust      the SA `ca.crt`, through NODE_EXTRA_CA_CERTS on the Deployment (deploy.ts) — so
//              this module holds no TLS code at all
//
// It speaks for jr2's own kinds alone — Sandbox, Repo, Secret — and every call stays behind the
// Sandbox and Repo ports, so swapping it for a client library is a contained change if jr2 ever
// needs exec or many more kinds (ADR-0063's considered options).
//
// Its rules, each observed on a real cluster (ADR-0063):
//
//   - The token is never cached. The kubelet replaced a 10-minute token only about 50 seconds
//     before it expired, so a cached one fails in production and never in a test. A `401` re-reads
//     the file and retries ONCE — a rotation between the read and the request.
//   - Writes are capped (8–16 at once). 200 parallel writes each opened a TLS connection and cost
//     about 130% CPU; a provision burst queues here instead.
//   - A watch asks for bookmarks and `timeoutSeconds=240`: built-in `fetch` aborts a body silent
//     for 300s (`UND_ERR_BODY_TIMEOUT`) and that cannot be changed without undici's dispatcher, so
//     the server closing first — and bookmarks about every 60s — keep a healthy watch clear of it.
//     The watch LOOP that reads this stream lives in sandbox-watch.ts.

import { readFile } from "node:fs/promises";

// The API server's CA (`SERVICE_ACCOUNT_CA`, names.ts) is not read here: the Deployment points
// NODE_EXTRA_CA_CERTS at it, and built-in `fetch` trusts it from there.

/** Where the kubelet mounts the Pod's ServiceAccount. */
export const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
/** The bearer — rotated by the kubelet, so read per request. */
export const SERVICE_ACCOUNT_TOKEN = `${SERVICE_ACCOUNT_DIR}/token`;

/** The field manager every server-side apply names — the Orchestrator's one identity as a writer. */
export const FIELD_MANAGER = "jr2";

/** The write cap when the caller names none: inside ADR-0063's 8–16. */
const DEFAULT_MAX_WRITES = 12;

/** One kind, as its REST path spells it. The core group is `""` (`/api/v1`). */
export type KubeKind = { group: string; version: string; plural: string };

export const SANDBOXES: KubeKind = { group: "core.jr2.dev", version: "v1alpha1", plural: "sandboxes" };
export const REPOS: KubeKind = { group: "core.jr2.dev", version: "v1alpha1", plural: "repos" };
export const SECRETS: KubeKind = { group: "", version: "v1", plural: "secrets" };

/** The object fields every kind shares — what the client and the watch read off any of them. */
export type KubeObject = {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
};

/** One event off a watch stream. `ERROR` carries a `Status` (code 410 for a resourceVersion too
 * old) INSIDE an HTTP 200 — the caller re-lists on any of them. */
export type WatchEvent<T extends KubeObject = KubeObject> =
  | { type: "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK"; object: T }
  | { type: "ERROR"; object: { kind?: "Status"; code?: number; reason?: string; message?: string } };

/** A refusal from the API server: the HTTP status and the `Status` body's own reason and words. */
export class KubeError extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  constructor(status: number, reason: string | undefined, message: string) {
    super(message);
    this.name = "KubeError";
    this.status = status;
    this.reason = reason;
  }
}

export type KubeClientOptions = {
  /** The API server. Default: the in-cluster Service from `KUBERNETES_SERVICE_HOST`/`_PORT`. */
  baseUrl?: string;
  /** The environment the default base URL is read from. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** The bearer, asked for on EVERY request — never cached (see the header). Default: the SA
   * token file. */
  token?: () => Promise<string>;
  /** Injectable transport: the tests' fake API server. Default: global `fetch`. */
  fetch?: typeof fetch;
  /** How many writes may be in flight at once. Default 12. */
  maxWrites?: number;
};

/** The client the Sandbox, Repo and fetch ports share: one process, one write cap. */
export interface KubeClient {
  /** The object, or `undefined` when there is none (404). */
  get<T extends KubeObject>(kind: KubeKind, namespace: string, name: string): Promise<T | undefined>;
  /** Every object of the kind in the namespace, with the list's resourceVersion — where a watch
   * starts. A kind the cluster does not serve (no CRD) is a {@link KubeError} with status 404. */
  list<T extends KubeObject>(
    kind: KubeKind,
    namespace: string,
    opts?: { labelSelector?: string },
  ): Promise<{ items: T[]; resourceVersion: string }>;
  /** Create; an existing object is a {@link KubeError} with status 409. */
  create<T extends KubeObject>(kind: KubeKind, namespace: string, body: T): Promise<T & KubeObject>;
  /** Delete; true when there was one to delete, false when it was already gone. */
  delete(kind: KubeKind, namespace: string, name: string): Promise<boolean>;
  /** A JSON merge patch — `null` removes a key. `status` patches the status subresource. Answers
   * the object as it stands after the patch. */
  patch<T extends KubeObject>(
    kind: KubeKind,
    namespace: string,
    name: string,
    body: object,
    opts?: { status?: boolean },
  ): Promise<T>;
  /** Server-side apply as field manager `jr2`, forced: create-or-update of every field the body
   * names. Answers the object as it stands afterwards (its `uid` included). */
  apply<T extends KubeObject>(kind: KubeKind, namespace: string, body: T): Promise<T & KubeObject>;
  /** One watch request's events, from `resourceVersion`, until the server closes it. Throws on a
   * refused request or a broken stream — the caller decides what each means (sandbox-watch.ts). */
  watch<T extends KubeObject>(
    kind: KubeKind,
    namespace: string,
    opts: { resourceVersion: string; labelSelector?: string; timeoutSeconds: number; signal?: AbortSignal },
  ): AsyncIterable<WatchEvent<T>>;
}

/** The in-cluster base URL, from the Service env the kubelet injects into every pod. */
export function inClusterBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT ?? "443";
  if (!host) {
    throw new Error(
      "no Kubernetes API server: KUBERNETES_SERVICE_HOST is unset. The Orchestrator drives the cluster " +
        "only from inside it (ADR-0019, ADR-0063) — `jr2 up` deploys it there.",
    );
  }
  // An IPv6 address needs brackets in a URL.
  return `https://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** Build the client. Nothing is read until the first request: a boot never fails on the cluster. */
export function kubeClient(opts: KubeClientOptions = {}): KubeClient {
  const fetchImpl = opts.fetch ?? fetch;
  const token = opts.token ?? (async () => (await readFile(SERVICE_ACCOUNT_TOKEN, "utf8")).trim());
  const writes = semaphore(opts.maxWrites ?? DEFAULT_MAX_WRITES);
  let base: string | undefined = opts.baseUrl;
  const baseUrl = () => (base ??= inClusterBaseUrl(opts.env));

  /** One request, with the bearer read fresh and a 401 re-read and retried once. */
  const send = async (
    method: string,
    path: string,
    init: { query?: Record<string, string>; body?: string; contentType?: string; signal?: AbortSignal } = {},
  ): Promise<Response> => {
    const url = new URL(path, baseUrl());
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${await token()}`,
          accept: "application/json",
          ...(init.contentType ? { "content-type": init.contentType } : {}),
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
      });
      // A rotation landed between the read and the request: the file already holds the new one.
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel();
        continue;
      }
      return res;
    }
  };

  /** The answer as JSON, or a {@link KubeError} carrying the Status body's reason and words. */
  const json = async <T>(res: Response, what: string): Promise<T> => {
    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : {}) as T;
    throw errorOf(res.status, text, what);
  };

  /** A write: inside the cap until its answer is read, so the cap bounds connections, not calls. */
  const write = <T>(method: string, path: string, what: string, init: Parameters<typeof send>[2]) =>
    writes(async () => json<T>(await send(method, path, init), what));

  return {
    async get<T extends KubeObject>(kind: KubeKind, ns: string, name: string) {
      const res = await send("GET", pathOf(kind, ns, name));
      if (res.status === 404) {
        await res.body?.cancel();
        return undefined;
      }
      return json<T>(res, `get ${kind.plural}/${name}`);
    },

    async list<T extends KubeObject>(kind: KubeKind, ns: string, opts: { labelSelector?: string } = {}) {
      const res = await send("GET", pathOf(kind, ns), {
        query: opts.labelSelector ? { labelSelector: opts.labelSelector } : {},
      });
      const out = await json<{ items?: T[]; metadata?: { resourceVersion?: string } }>(res, `list ${kind.plural}`);
      return { items: out.items ?? [], resourceVersion: out.metadata?.resourceVersion ?? "" };
    },

    create<T extends KubeObject>(kind: KubeKind, ns: string, body: T) {
      return write<T & KubeObject>("POST", pathOf(kind, ns), `create ${kind.plural}/${body.metadata?.name ?? "?"}`, {
        body: JSON.stringify(body),
        contentType: "application/json",
      });
    },

    delete(kind: KubeKind, ns: string, name: string) {
      return writes(async () => {
        const res = await send("DELETE", pathOf(kind, ns, name));
        if (res.status === 404) {
          await res.body?.cancel();
          return false;
        }
        await json(res, `delete ${kind.plural}/${name}`);
        return true;
      });
    },

    patch<T extends KubeObject>(kind: KubeKind, ns: string, name: string, body: object, o: { status?: boolean } = {}) {
      return write<T>(
        "PATCH",
        pathOf(kind, ns, name, o.status ? "status" : undefined),
        `patch ${kind.plural}/${name}`,
        {
          body: JSON.stringify(body),
          contentType: "application/merge-patch+json",
        },
      );
    },

    apply<T extends KubeObject>(kind: KubeKind, ns: string, body: T) {
      const name = body.metadata?.name;
      if (!name) throw new Error(`apply ${kind.plural}: the object names no metadata.name`);
      // JSON is YAML, so the apply content type takes the object as it is.
      return write<T & KubeObject>("PATCH", pathOf(kind, ns, name), `apply ${kind.plural}/${name}`, {
        query: { fieldManager: FIELD_MANAGER, force: "true" },
        body: JSON.stringify(body),
        contentType: "application/apply-patch+yaml",
      });
    },

    async *watch<T extends KubeObject>(
      kind: KubeKind,
      ns: string,
      o: { resourceVersion: string; labelSelector?: string; timeoutSeconds: number; signal?: AbortSignal },
    ): AsyncIterable<WatchEvent<T>> {
      const res = await send("GET", pathOf(kind, ns), {
        query: {
          watch: "true",
          allowWatchBookmarks: "true",
          timeoutSeconds: String(o.timeoutSeconds),
          resourceVersion: o.resourceVersion,
          ...(o.labelSelector ? { labelSelector: o.labelSelector } : {}),
        },
        ...(o.signal ? { signal: o.signal } : {}),
      });
      if (!res.ok) throw errorOf(res.status, await res.text(), `watch ${kind.plural}`);
      if (!res.body) return;
      // One JSON object per line. A line can straddle two chunks, so the tail waits for the next.
      let buf = "";
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) yield JSON.parse(line) as WatchEvent<T>;
        }
      }
      if (buf.trim()) yield JSON.parse(buf) as WatchEvent<T>;
    },
  };
}

/** A `Status` body read into a {@link KubeError}; a body that is not one keeps its raw text. */
function errorOf(status: number, text: string, what: string): KubeError {
  let reason: string | undefined;
  let message = text;
  try {
    const parsed = JSON.parse(text) as { reason?: string; message?: string };
    reason = parsed.reason;
    message = parsed.message ?? text;
  } catch {
    // not a Status: the raw text is the most there is to say
  }
  return new KubeError(status, reason, `${what} failed (${status}${reason ? ` ${reason}` : ""}): ${message}`);
}

/** The REST path of a kind in a namespace, optionally one object and one subresource. */
function pathOf(kind: KubeKind, ns: string, name?: string, sub?: string): string {
  const root = kind.group ? `/apis/${kind.group}/${kind.version}` : `/api/${kind.version}`;
  return (
    `${root}/namespaces/${encodeURIComponent(ns)}/${kind.plural}` +
    (name !== undefined ? `/${encodeURIComponent(name)}` : "") +
    (sub !== undefined ? `/${sub}` : "")
  );
}

/** At most `n` of the wrapped calls at once; the rest queue in arrival order. */
function semaphore(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  return async (fn) => {
    // A released slot passes straight to the next waiter, so a caller arriving in between can
    // never slip past the cap.
    if (active >= n) await new Promise<void>((resolve) => queue.push(resolve));
    else active++;
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

/** True for the API server's "no such object" — the one refusal most callers read as an answer. */
export const isNotFound = (err: unknown): boolean => err instanceof KubeError && err.status === 404;
/** True for "already exists" on a create. */
export const isAlreadyExists = (err: unknown): boolean => err instanceof KubeError && err.status === 409;
