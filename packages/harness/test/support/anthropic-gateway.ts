// A fake catalog gateway (ADR-0059) that serves the Anthropic Messages API as SSE: each call gets
// one text block, `pong`, and the gateway keeps each request. `catalog-gateway.test.ts` sends pi-ai
// calls to it directly; the conformance suite sends a Turn through it. `answer` changes the reply,
// for the provider preflight's probe (ADR-0019): one `ping` tool call, or a refusal with a status.

import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export type AnthropicGateway = {
  url: string;
  seen: Array<{ url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }>;
  close: () => Promise<void>;
};

/** What the gateway answers: a text block (the default), one call of the `ping` tool, no answer at
 * all, a 200 that stops after its first line, an answer after a delay, or an error. */
export type GatewayAnswer =
  | "text"
  | "tool"
  | "hang"
  | "stall"
  | { delayMs: number; then: "text" | "tool" }
  | { status: number; body: unknown; headers?: Record<string, string> };

/** `answer` is each call's answer; a list answers call n with its n-th entry, and its last after. */
export async function startAnthropicGateway(
  answers: GatewayAnswer | GatewayAnswer[] = "text",
): Promise<AnthropicGateway> {
  const seen: AnthropicGateway["seen"] = [];
  const script = Array.isArray(answers) ? answers : [answers];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (b: Buffer) => (raw += b));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw || "{}") as Record<string, unknown> });
      const answer = script[Math.min(seen.length, script.length) - 1]!;
      // A provider that takes the request and never answers: the socket stays open until close.
      if (answer === "hang") return;
      // A 200 whose answer stops after its first line: the socket stays open until close.
      if (answer === "stall") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`,
        );
        return;
      }
      if (typeof answer === "object" && "delayMs" in answer) {
        setTimeout(() => reply(answer.then), answer.delayMs);
        return;
      }
      reply(answer);
    });
    const reply = (answer: GatewayAnswer) => {
      if (answer === "hang" || answer === "stall" || (typeof answer === "object" && "delayMs" in answer)) return;
      if (typeof answer === "object") {
        res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
        res.end(JSON.stringify(answer.body));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const block: Array<[string, unknown]> =
        answer === "tool"
          ? [
              [
                "content_block_start",
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "tool_use", id: "toolu_1", name: "ping", input: {} },
                },
              ],
              [
                "content_block_delta",
                { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
              ],
              ["content_block_stop", { type: "content_block_stop", index: 0 }],
            ]
          : [
              [
                "content_block_start",
                { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
              ],
              [
                "content_block_delta",
                { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } },
              ],
              ["content_block_stop", { type: "content_block_stop", index: 0 }],
            ];
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
        ...block,
        [
          "message_delta",
          {
            type: "message_delta",
            delta: { stop_reason: answer === "tool" ? "tool_use" : "end_turn" },
            usage: { output_tokens: 1 },
          },
        ],
        ["message_stop", { type: "message_stop" }],
      ];
      for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    };
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
