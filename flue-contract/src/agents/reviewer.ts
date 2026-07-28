// A faithful reduction of the Agent shim the stock Harness image GENERATES at pod start
// (`packages/orchestrator/harness/boot.mjs`). Everything that is not load-bearing for the
// contract — the mounted spec, conversation printing (ADR-0023), thinking levels — is dropped.
//
// What is kept is the part the contract is about: the initializer re-runs per submission, and it
// connects an MCP client to the Adapter at `/mcp/<flue instance id>`. flue re-runs this whenever
// it needs a session for the instance — INCLUDING after the turn is over, to write its own
// `submission_aborted` advisory. That is why a dead iid must answer rather than refuse (ADR-0026),
// and this file is what makes the test exercise the real reason.

import { connectMcpServer, defineAgent, type AgentRouteHandler, type McpServerConnection } from "@flue/runtime";

/** The pod is the trust boundary, so the route admits without extra auth — as in `boot.mjs`. */
export const route: AgentRouteHandler = async (_c, next) => next();

/** flue offers no disposal hook, so each new connection retires the previous one (`boot.mjs`). */
let previous: McpServerConnection | undefined;

export default defineAgent(async ({ id }) => {
  const adapter = process.env.J2_ADAPTER_URL;
  if (!adapter) throw new Error("no J2_ADAPTER_URL: this Agent has no Adapter to reach (ADR-0013)");
  const j2 = await connectMcpServer("j2", { url: `${adapter}/mcp/${encodeURIComponent(id)}` });
  void previous?.close().catch(() => {});
  previous = j2;
  return {
    model: "fake/model-x",
    instructions: "Finish by calling the tool you were given, once, and then stop.",
    tools: j2.tools,
  };
});
