// A fake Instance Effector, in-process and socket-free (ADR-0010): an `EffectorTransport` that
// speaks the signed wire (ADR-0068) for several replicas. It verifies every request's signature
// and signs every answer, so a test drives the real client. The test settles each Effect by hand,
// takes a replica down, restarts one (it forgets its Effects), or stops one (it refuses new ones).

import {
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIME,
  requestMac,
  responseMac,
  type EffectState,
  type EffectorTransport,
  type HttpOutput,
  type RawAnswer,
  type StartRequest,
} from "../src/effector-wire.ts";

type Held = { req: StartRequest; output?: HttpOutput; waiters: Set<() => void> };
type FakeReplica = { name: string; address: string; effects: Map<string, Held>; down: boolean; stopping: boolean };

export const EFFECTOR_KEY = "the-instance-effector-placement-key";

/** A connection refused, as Node's fetch reports one. */
const refused = (address: string): Error =>
  Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: "ECONNREFUSED", syscall: "connect" });

export class FakeEffector {
  readonly replicas: FakeReplica[] = [];
  /** Every start that started an Effect: id and request, in order. */
  readonly starts: Array<{ id: string; req: StartRequest; replica: string }> = [];
  /** Every request, as method and path. */
  readonly calls: Array<{ method: string; path: string; address: string }> = [];
  /** How long a poll holds before it answers `running`. */
  hold = 30;
  /** When set, the next start is taken by a replica and its answer lost (a reset). */
  loseNextAnswer = false;

  readonly key: string;

  constructor(names: string[] = ["effector-a"], key: string = EFFECTOR_KEY) {
    this.key = key;
    names.forEach((name, i) =>
      this.replicas.push({ name, address: `10.0.0.${i + 1}:8082`, effects: new Map(), down: false, stopping: false }),
    );
  }

  replica(name: string): FakeReplica {
    const r = this.replicas.find((x) => x.name === name);
    if (!r) throw new Error(`no replica ${name}`);
    return r;
  }

  /** Settle the newest Effect (or the named one), wherever it is held. */
  settle(output: HttpOutput, id = this.starts.at(-1)?.id): void {
    for (const r of this.replicas) {
      const held = id ? r.effects.get(id) : undefined;
      if (!held || held.output) continue;
      held.output = output;
      for (const wake of [...held.waiters]) wake();
    }
  }

  /** A replica restarts: it forgets every Effect it held. */
  restart(name: string): void {
    const r = this.replica(name);
    for (const held of r.effects.values()) for (const wake of [...held.waiters]) wake();
    r.effects.clear();
  }

  transport: EffectorTransport = {
    replicas: async () => this.replicas.filter((r) => !r.down).map((r) => r.address),
    send: async (address, method, path, headers, body, signal) => {
      this.calls.push({ method, path, address });
      const replica = this.replicas.find((r) => r.address === address);
      if (!replica || replica.down) throw refused(address);
      const nonce = headers[HEADER_NONCE] ?? "";
      const expect = requestMac(this.key, method, path, headers[HEADER_TIME] ?? "", nonce, body);
      if (headers[HEADER_SIGNATURE] !== expect) return { status: 401, headers: {}, body: "" };
      const answer = (status: number, value: unknown): RawAnswer => {
        const text = JSON.stringify(value);
        return {
          status,
          headers: { [HEADER_SIGNATURE]: responseMac(this.key, status, method, path, nonce, text) },
          body: text,
        };
      };
      const id = decodeURIComponent(path.replace(/^\/effects\//, ""));
      const stateOf = (held: Held | undefined): EffectState => ({
        effect: id,
        replica: { name: replica.name, address: replica.address },
        state: held === undefined ? "unknown" : held.output ? "settled" : "running",
        ...(held?.output ? { output: held.output } : {}),
      });
      if (method === "POST") {
        const existing = replica.effects.get(id);
        if (existing) return answer(200, stateOf(existing));
        if (replica.stopping) return answer(503, { error: "stopping", replica: { name: replica.name, address } });
        const held: Held = { req: JSON.parse(body) as StartRequest, waiters: new Set() };
        replica.effects.set(id, held);
        this.starts.push({ id, req: held.req, replica: replica.name });
        if (this.loseNextAnswer) {
          this.loseNextAnswer = false;
          throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
        }
        return answer(202, stateOf(held));
      }
      const held = replica.effects.get(id);
      if (!held) return answer(404, stateOf(undefined));
      if (!held.output) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, this.hold);
          function done() {
            clearTimeout(timer);
            held!.waiters.delete(done);
            resolve();
          }
          held.waiters.add(done);
          signal?.addEventListener("abort", done, { once: true });
        });
      }
      if (signal?.aborted) throw new Error("aborted");
      return answer(200, stateOf(replica.effects.get(id)));
    },
  };
}
