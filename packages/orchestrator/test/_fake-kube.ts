// A small fake Kubernetes API server (ADR-0063: "tests fake the client with a small HTTP server"),
// served as a `fetch` so the suites stay socket-free (ADR-0010). It speaks the REST the client
// speaks — get, list, create, delete, merge patch (status included), server-side apply, and a
// streaming watch — over an in-memory store with a real resourceVersion counter, and it lets a
// test play the cluster: publish a status, delete an object, send a bookmark, close every watch,
// answer a resume with ERROR 410, stall a stream into fetch's body timeout, refuse a token, or make
// a Sandbox Lost the way the operator does (ADR-0021).

type Obj = {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

export type FakeCall = {
  method: string;
  /** The namespace the path named. */
  namespace?: string;
  /** `<plural>/<name>[/status]`, or `<plural>` for a collection. */
  target: string;
  query: Record<string, string>;
  contentType?: string;
  body?: any;
  token?: string;
};

type WatchStream = {
  plural: string;
  selector?: string;
  push: (event: object) => void;
  close: () => void;
  fail: (err: unknown) => void;
};

/** RFC 7386 merge patch. */
function mergePatch(target: any, patch: any): any {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = target !== null && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

const matches = (obj: Obj, selector?: string): boolean => {
  if (!selector) return true;
  return selector.split(",").every((term) => {
    const [k, v] = term.split("=");
    const labels = obj.metadata.labels ?? {};
    return v === undefined ? k! in labels : labels[k!] === v;
  });
};

export function fakeKube(opts: { token?: string } = {}) {
  const store = new Map<string, Map<string, Obj>>(); // plural → name → object
  const history: Array<{ rv: number; plural: string; event: { type: string; object: Obj } }> = [];
  const watches = new Set<WatchStream>();
  const calls: FakeCall[] = [];
  /** The writes alone — every call but a GET — so "nothing was applied" is an empty array while a
   * watch is running beside it. */
  const writes: FakeCall[] = [];
  let rv = 100;
  let uid = 0;
  /** Resume points below this are gone: a watch from one gets ERROR 410. */
  let compactedAt = 0;
  /** Refuse this many requests with 401 before accepting any. */
  let unauthorized = 0;
  /** The bearer this server accepts. Change it to play a rotation. */
  let token = opts.token ?? "t0";
  /** In-flight writes right now, and the most there ever were — the write cap's evidence. */
  let inFlight = 0;
  let maxInFlight = 0;
  /** Hold every write until released — lets a test see how many are in flight at once. */
  let gate: Promise<void> | undefined;
  /** Scripted refusals: return a Response to answer instead of the store. */
  const refusals: Array<(call: FakeCall) => Response | undefined> = [];
  /** Called after every create/apply/patch of an object, so a test can play the operator. */
  const onWrite: Array<(plural: string, obj: Obj, call: FakeCall) => void> = [];

  const bucket = (plural: string) => {
    let b = store.get(plural);
    if (!b) store.set(plural, (b = new Map()));
    return b;
  };

  const emit = (plural: string, type: string, obj: Obj) => {
    const at = Number(obj.metadata.resourceVersion);
    const event = { type, object: structuredClone(obj) };
    history.push({ rv: at, plural, event });
    for (const w of watches) if (w.plural === plural && matches(obj, w.selector)) w.push(event);
  };

  const put = (plural: string, obj: Obj, type: "ADDED" | "MODIFIED") => {
    obj.metadata.resourceVersion = String(++rv);
    bucket(plural).set(obj.metadata.name, obj);
    emit(plural, type, obj);
    return obj;
  };

  const json = (status: number, body: unknown): globalThis.Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const status = (code: number, reason: string, message: string): globalThis.Response =>
    json(code, { kind: "Status", status: "Failure", code, reason, message });

  const written = (plural: string, obj: Obj, call: FakeCall) => {
    for (const hook of onWrite) hook(plural, obj, call);
    return json(200, bucket(plural).get(obj.metadata.name));
  };

  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers = new Headers(init.headers);
    const bearer = headers.get("authorization")?.replace(/^Bearer /, "");
    const parts = url.pathname.split("/").filter(Boolean);
    // /api/v1/namespaces/<ns>/<plural>[/<name>[/status]]  |  /apis/<g>/<v>/namespaces/<ns>/...
    const at = parts.indexOf("namespaces");
    const [plural, name, sub] = parts.slice(at + 2);
    const method = init.method ?? "GET";
    const call: FakeCall = {
      method,
      ...(at >= 0 ? { namespace: parts[at + 1] } : {}),
      target: [plural, name, sub].filter(Boolean).join("/"),
      query: Object.fromEntries(url.searchParams),
      ...(headers.get("content-type") ? { contentType: headers.get("content-type")! } : {}),
      ...(typeof init.body === "string" ? { body: JSON.parse(init.body) } : {}),
      ...(bearer !== undefined ? { token: bearer } : {}),
    };
    calls.push(call);
    if (method !== "GET") writes.push(call);
    if (unauthorized > 0 || bearer !== token) {
      if (unauthorized > 0) unauthorized--;
      return status(401, "Unauthorized", "Unauthorized");
    }
    for (const refuse of refusals) {
      const res = refuse(call);
      if (res) return res;
    }
    if (!plural) return status(404, "NotFound", "the server could not find the requested resource");

    if (method === "GET" && name === undefined && call.query.watch === "true") {
      const from = Number(call.query.resourceVersion ?? "0");
      return watchResponse(plural, from, call.query.labelSelector, init.signal ?? undefined);
    }
    if (method === "GET" && name === undefined) {
      const items = [...bucket(plural).values()].filter((o) => matches(o, call.query.labelSelector));
      return json(200, { kind: "List", metadata: { resourceVersion: String(rv) }, items: structuredClone(items) });
    }
    if (method === "GET") {
      const obj = bucket(plural).get(name!);
      return obj ? json(200, obj) : status(404, "NotFound", `${plural} "${name}" not found`);
    }

    // Writes: counted, and held at the gate when a test closes it.
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (gate) await gate;
      if (method === "POST") {
        const body = call.body as Obj;
        if (bucket(plural).has(body.metadata.name)) {
          return status(409, "AlreadyExists", `${plural} "${body.metadata.name}" already exists`);
        }
        const obj = structuredClone(body);
        obj.metadata.uid = `uid-${++uid}`;
        return written(plural, put(plural, obj, "ADDED"), call);
      }
      if (method === "DELETE") {
        const obj = bucket(plural).get(name!);
        if (!obj) return status(404, "NotFound", `${plural} "${name}" not found`);
        bucket(plural).delete(name!);
        obj.metadata.resourceVersion = String(++rv);
        emit(plural, "DELETED", obj);
        return json(200, { kind: "Status", status: "Success" });
      }
      if (method === "PATCH" && call.contentType === "application/apply-patch+yaml") {
        const existing = bucket(plural).get(name!);
        const body = structuredClone(call.body) as Obj;
        if (!existing) {
          body.metadata.uid = `uid-${++uid}`;
          return written(plural, put(plural, body, "ADDED"), call);
        }
        // Server-side apply, as far as a test needs it: the applied fields replace, the rest stays.
        const next = { ...existing, ...body, metadata: { ...existing.metadata, ...body.metadata } } as Obj;
        next.metadata.uid = existing.metadata.uid;
        if (existing["status"] !== undefined) next["status"] = existing["status"];
        return written(plural, put(plural, next, "MODIFIED"), call);
      }
      if (method === "PATCH") {
        const existing = bucket(plural).get(name!);
        if (!existing) return status(404, "NotFound", `${plural} "${name}" not found`);
        const next = mergePatch(existing, call.body) as Obj;
        return written(plural, put(plural, next, "MODIFIED"), call);
      }
      return status(405, "MethodNotAllowed", method);
    } finally {
      inFlight--;
    }
  };

  function watchResponse(plural: string, from: number, selector: string | undefined, signal?: AbortSignal) {
    if (from < compactedAt) {
      // The API server's way: HTTP 200, and the verdict as the stream's one event.
      const body = JSON.stringify({
        type: "ERROR",
        object: { kind: "Status", code: 410, reason: "Expired", message: "too old resource version" },
      });
      return new Response(body + "\n", { status: 200 });
    }
    const enc = new TextEncoder();
    let stream!: WatchStream;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = {
          plural,
          ...(selector ? { selector } : {}),
          push: (event) => controller.enqueue(enc.encode(JSON.stringify(event) + "\n")),
          close: () => {
            watches.delete(stream);
            try {
              controller.close();
            } catch {}
          },
          fail: (err) => {
            watches.delete(stream);
            try {
              controller.error(err);
            } catch {}
          },
        };
        watches.add(stream);
        for (const h of history) {
          if (h.plural === plural && h.rv > from && matches(h.event.object, selector)) stream.push(h.event);
        }
        signal?.addEventListener("abort", () => stream.fail(signal.reason), { once: true });
      },
      cancel() {
        watches.delete(stream);
      },
    });
    return new Response(body, { status: 200 });
  }

  return {
    fetch: fetchImpl as typeof fetch,
    calls,
    writes,
    /** The bearer the client must present — assign to play a token rotation. */
    get token() {
      return token;
    },
    set token(t: string) {
      token = t;
    },
    /** Refuse the next `n` requests with 401. */
    refuseAuth(n = 1) {
      unauthorized = n;
    },
    /** Answer calls the predicate picks with a scripted response instead. */
    refuse(fn: (call: FakeCall) => globalThis.Response | undefined) {
      refusals.push(fn);
    },
    status,
    onWrite(fn: (plural: string, obj: Obj, call: FakeCall) => void) {
      onWrite.push(fn);
    },
    /** One object as the store holds it. */
    object(plural: string, name: string): any {
      return bucket(plural).get(name);
    },
    /** Put an object in, as another writer (the operator, a human) would. */
    seed(plural: string, obj: Obj) {
      const o = structuredClone(obj);
      o.metadata.uid ??= `uid-${++uid}`;
      put(plural, o, bucket(plural).has(o.metadata.name) ? "MODIFIED" : "ADDED");
    },
    /** Publish a status, as the operator does — one MODIFIED event. */
    setStatus(plural: string, name: string, s: unknown) {
      const obj = bucket(plural).get(name);
      if (!obj) throw new Error(`no ${plural}/${name} to set a status on`);
      put(plural, { ...obj, status: s } as Obj, "MODIFIED");
    },
    /**
     * Make a Sandbox Lost, as the operator does once its one pod is gone or terminal (ADR-0021):
     * phase `Lost`, `Ready` False, and a `Lost` condition with the pod's reason and words — on top
     * of the status it had, so the endpoint and the pod facts stay. One MODIFIED event.
     */
    lose(name: string, reason: string, message: string) {
      const obj = bucket("sandboxes").get(name);
      if (!obj) throw new Error(`no sandboxes/${name} to lose`);
      const was = (obj.status ?? {}) as { conditions?: Array<{ type: string }> };
      const kept = (was.conditions ?? []).filter((c) => c.type !== "Ready" && c.type !== "Lost");
      const conditions = [
        ...kept,
        { type: "Ready", status: "False", reason: "Lost", message },
        { type: "Lost", status: "True", reason, message },
      ];
      put("sandboxes", { ...obj, status: { ...was, phase: "Lost", conditions } } as Obj, "MODIFIED");
    },
    /** Delete an object as another writer — one DELETED event. */
    remove(plural: string, name: string) {
      const obj = bucket(plural).get(name);
      if (!obj) return;
      bucket(plural).delete(name);
      obj.metadata.resourceVersion = String(++rv);
      emit(plural, "DELETED", obj);
    },
    /** Advance the resourceVersion with no change, and tell every watch in a BOOKMARK. */
    bookmark(plural: string) {
      const at = String(++rv);
      for (const w of watches) {
        if (w.plural === plural)
          w.push({ type: "BOOKMARK", object: { kind: "Sandbox", metadata: { resourceVersion: at } } });
      }
      return at;
    },
    /** Forget history up to now: a resume from any earlier point gets ERROR 410. */
    compact() {
      compactedAt = rv;
    },
    /** Send an ERROR event on every open watch (the stream stays open, as the server's does). */
    errorWatches(code = 410) {
      for (const w of watches) w.push({ type: "ERROR", object: { kind: "Status", code, reason: "Expired" } });
    },
    /** Close every open watch, as the server does at `timeoutSeconds`. */
    closeWatches() {
      for (const w of [...watches]) w.close();
    },
    /** Break every open watch the way fetch's 300s body timeout does. */
    stallWatches() {
      const err = new TypeError("terminated", {
        cause: Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" }),
      });
      for (const w of [...watches]) w.fail(err);
    },
    get openWatches() {
      return watches.size;
    },
    get rv() {
      return String(rv);
    },
    /** Hold every write until the returned function is called. */
    holdWrites(): () => void {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = undefined;
        release();
      };
    },
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    /** The watch requests made so far, in order — where each resumed from. */
    watchCalls(): FakeCall[] {
      return calls.filter((c) => c.method === "GET" && c.query.watch === "true");
    },
    listCalls(plural: string): FakeCall[] {
      return calls.filter((c) => c.method === "GET" && c.target === plural && c.query.watch !== "true");
    },
  };
}

export type FakeKube = ReturnType<typeof fakeKube>;
