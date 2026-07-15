// The dev Harness image's scripted AGENT (ADR-0013). This is the pod's side of the leg nothing
// used to test: an Agent that reaches its Machine the only way j2 permits — an MCP client to the
// Adapter on `localhost`, whose menu is whatever the invoking state registered for this turn.
//
// It stands in for flue's persona, and mirrors its shape deliberately:
//
//   export default defineAgent(async ({ id, env }) => ({
//     model, instructions,
//     tools: [await connectMcpServer("j2", { url: `${env.J2_ADAPTER_URL}/mcp/${id}` })],
//   }));
//
// (`connectMcpServer(name, options)` — the name is REQUIRED and visible to the model: adapted
// tools are named `mcp__<name>__<tool>`, so the server key j2 picks is part of the Agent's
// vocabulary. Verified against flue source — the ADR-0013 sample used to omit it.)
//
// `defineAgent` is an INITIALIZER, re-run on every submission, and its context carries the agent
// instance id — so the Agent names its own iid and the Adapter never has to learn which turn is
// live. This persona does the same: the admission hands it the iid, and it connects per turn.
// What is faked here is the LLM (a directive in the prompt, not a model deciding); the wire, the
// container boundary, and the tool call are real.
//
// The prompt IS the script: `call <tool> [<json args>]` makes the Agent act. Any other prompt
// parks it — which is what the restore and `workspace.lost` scenarios need, and what a real Agent
// that is still thinking looks like from the Machine's side.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Admission } from "./stub-harness.ts";

/** `call finish {"summary":"ok"}` — the tool to invoke and its (optional) JSON arguments. */
const SCRIPT = /^\s*call\s+(\S+)\s*(\{[\s\S]*\})?\s*$/;

/** Play one turn: connect to this turn's menu and call the scripted tool. */
export async function playAgent(admission: Admission): Promise<void> {
  const script = SCRIPT.exec(admission.message ?? "");
  if (!script) return; // no directive → the Agent is "still working"; the Machine parks
  const [, tool, args] = script as unknown as [string, string, string | undefined];

  // The Agent's ONLY control-plane peer (ADR-0013). It holds no Orchestrator credential and knows
  // no Orchestrator address: if this is unset, the Agent is mute — which is the point.
  const adapter = process.env.J2_ADAPTER_URL;
  if (!adapter) {
    throw new Error("no J2_ADAPTER_URL: this Agent has no Adapter to reach, so it cannot drive its Machine (ADR-0013)");
  }

  const client = new Client({ name: "j2-dev-agent", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${adapter}/mcp/${admission.instanceId}`)));
  try {
    // List before calling, as flue's `connectMcpServer` does — so a green tool call proves the
    // Adapter rendered the turn's surface, not just that it forwarded a blind request.
    const menu = (await client.listTools()).tools.map((t) => t.name);
    if (!menu.includes(tool)) {
      throw new Error(`this turn's menu does not offer "${tool}" (offers: ${menu.join(", ") || "nothing"})`);
    }
    const result = await client.callTool({ name: tool, arguments: args ? (JSON.parse(args) as object) : {} });
    if (result.isError) throw new Error(`tool "${tool}" failed: ${JSON.stringify(result.content)}`);
    console.log(`agent ${admission.instanceId}: called ${tool}`);
  } finally {
    await client.close();
  }
}
