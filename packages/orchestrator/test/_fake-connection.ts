// In-memory connections for `dialFetch` (src/dial.ts), so a test of a bounded connect opens no
// socket: one that never opens, as a dropped SYN looks from the client, and one with an HTTP server
// behind it.

import { Duplex } from "node:stream";

/** A connection that never opens: what a SYN that no one answers looks like from the client. */
export function neverOpens(): Duplex & { connecting: boolean } {
  const socket = new Duplex({
    read() {},
    write(_chunk, _enc, _cb) {
      // Held, as a connecting socket holds what is written before it opens.
    },
  }) as Duplex & { connecting: boolean };
  socket.connecting = true;
  return socket;
}

/** An open connection with an HTTP server behind it, which answers `body` after `delayMs`. */
export function answers(body: string, delayMs = 0): Duplex & { connecting: boolean; request: Promise<string> } {
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
        setTimeout(() => {
          socket.push(
            `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n` +
              `connection: close\r\n\r\n${body}`,
          );
          socket.push(null);
        }, delayMs);
      }
      cb();
    },
  }) as Duplex & { connecting: boolean; request: Promise<string> };
  socket.connecting = false;
  socket.request = request;
  return socket;
}
