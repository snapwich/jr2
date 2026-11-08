// In-memory connections for `dialFetch` (src/dial.ts), so a test of a bounded connect opens no
// socket. A connection goes through the phases a TCP socket does — the name lookup, the connect —
// each when the test says, and an HTTP server in memory answers once the request is whole.

import type { ClientRequestArgs } from "node:http";
import { Duplex } from "node:stream";

export type FakeConnection = Duplex & {
  connecting: boolean;
  /** The options `dialFetch` asked the connection for. */
  args?: ClientRequestArgs;
  /** The raw request, once it is whole. */
  request: Promise<string>;
  setTimeout(ms: number, cb?: () => void): FakeConnection;
};

export type FakeConnectionOptions = {
  /** When the name lookup answers, in ms. Default at once. `null`: it never answers. */
  lookupMs?: number | null;
  /** When the TCP connect completes, in ms. `null` (the default for a closed one): never. */
  connectMs?: number | null;
  /** Open from the start: no lookup, no connect phase. */
  open?: boolean;
  /** The JSON body the server answers with. Absent: no answer. */
  answer?: string;
  /** How long after the whole request the server answers. Default at once. */
  answerMs?: number;
  /** Send the headers and hold the body for ever. */
  holdBody?: boolean;
};

export function fakeConnection(opts: FakeConnectionOptions = {}): FakeConnection {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };
  let idle: { ms: number; cb: () => void; timer?: ReturnType<typeof setTimeout> } | undefined;
  const touch = () => {
    if (!idle) return;
    clearTimeout(idle.timer);
    idle.timer = setTimeout(idle.cb, idle.ms);
  };
  let seen = "";
  let done!: (raw: string) => void;
  const request = new Promise<string>((resolve) => (done = resolve));
  const socket = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      seen += String(chunk);
      const end = seen.indexOf("\r\n\r\n");
      const length = Number(/content-length: (\d+)/i.exec(seen)?.[1] ?? 0);
      if (end >= 0 && Buffer.byteLength(seen) - (end + 4) >= length) {
        done(seen);
        if (opts.answer !== undefined) {
          later(opts.answerMs ?? 0, () => {
            const head =
              `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n` +
              `content-length: ${Buffer.byteLength(opts.answer!)}\r\nconnection: close\r\n\r\n`;
            touch();
            if (opts.holdBody) {
              socket.push(head);
              return;
            }
            socket.push(head + opts.answer);
            socket.push(null);
          });
        }
      }
      cb();
    },
    destroy(err, cb) {
      for (const t of timers) clearTimeout(t);
      clearTimeout(idle?.timer);
      cb(err);
    },
  }) as FakeConnection;
  socket.request = request;
  socket.setTimeout = (ms, cb) => {
    clearTimeout(idle?.timer);
    idle = ms > 0 && cb ? { ms, cb } : undefined;
    touch();
    return socket;
  };
  if (opts.open) {
    socket.connecting = false;
    return socket;
  }
  socket.connecting = true;
  if (opts.lookupMs !== null) later(opts.lookupMs ?? 0, () => socket.emit("lookup", null, "10.96.0.7", 4, "fake"));
  if (opts.connectMs !== undefined && opts.connectMs !== null) {
    later(opts.connectMs, () => {
      socket.connecting = false;
      socket.emit("connect");
    });
  }
  return socket;
}

/** A connection that never opens: what a SYN that no one answers looks like from the client. */
export function neverOpens(): FakeConnection {
  return fakeConnection();
}

/** An open connection with an HTTP server behind it, which answers `body` after `delayMs`. */
export function answers(body: string, delayMs = 0): FakeConnection {
  return fakeConnection({ open: true, answer: body, answerMs: delayMs });
}
