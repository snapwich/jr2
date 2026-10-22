// A fake catalog gateway (ADR-0059) that serves the Anthropic Messages API as SSE: each call gets
// one text block, `pong`, and the gateway keeps each request. `catalog-gateway.test.ts` sends pi-ai
// calls to it directly; the conformance suite sends a Turn through it.

import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export type AnthropicGateway = {
  url: string;
  seen: Array<{ url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }>;
  close: () => Promise<void>;
};

export async function startAnthropicGateway(): Promise<AnthropicGateway> {
  const seen: AnthropicGateway["seen"] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (b: Buffer) => (raw += b));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw || "{}") as Record<string, unknown> });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events: Array<[string, unknown]> = [
        [
          "message_start",
          {
            type: "message_start",
            message: {
              id: "m1",
              type: "message",
              role: "assistant",
              model: "x",
              content: [],
              stop_reason: null,
              usage: { input_tokens: 3, output_tokens: 0 },
            },
          },
        ],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ];
      for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
