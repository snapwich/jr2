// pi honours `harness.catalog` (ADR-0059), over a real socket — the canary for the LiteLLM path:
// pi at the exact pin, the catalog's own `anthropic/…` model, moved by `resolveModel` onto a local
// fake that serves the Anthropic Messages API as SSE. The request must arrive THERE, with `x-api-key`
// equal to what the env holds — in a pod that is the Stand-in, which the Custodian swaps on the way
// out (its own suite proves that half). A pi bump that stopped handing the provider the model it is
// given, or that read a base URL from somewhere else, fails here and not in a user's cluster.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { modelsFor, resolveModel } from "../src/provider.ts";

test("a catalog provider moved to a gateway: the Messages call lands there, with the env's key", async () => {
  const seen: Array<{ url: string; headers: IncomingHttpHeaders; body: { model?: string } }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (b: Buffer) => (raw += b));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw || "{}") });
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
  const gateway = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "jr2-held-ANTHROPIC_API_KEY";
  try {
    const models = modelsFor({ catalog: { anthropic: { baseUrl: gateway } } }, process.env);
    const builtin = models.getModels("anthropic")[0]!;
    const answer = await models.completeSimple(resolveModel(models, `anthropic/${builtin.id}`), {
      messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
    });
    assert.equal(answer.stopReason, "stop", answer.errorMessage ?? "");
    assert.equal(seen.length, 1, "the call went to the gateway");
    assert.equal(seen[0]!.url, "/v1/messages");
    assert.equal(seen[0]!.headers["x-api-key"], "jr2-held-ANTHROPIC_API_KEY");
    assert.equal(seen[0]!.body.model, builtin.id, "the catalog id is the name the gateway must serve");
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
