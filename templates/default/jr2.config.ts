import { defineConfig } from "@jr2/orchestrator";

export default defineConfig({
  git: {
    // The fence (ADR-0051): a per-run repo url — run input, a ticket field — must match an entry here or the
    // attach refuses it, so nothing can spend this cluster's credential against an arbitrary host. `*` is
    // today's two implicit defaults made visible (JR2_GIT_TOKEN from .env for https, the jr2-git-ssh Secret
    // for ssh). Narrow it to your hosts (`match: "github.com/yourorg/"`) before anything untrusted can start
    // a run. The longest match wins; the url's scheme picks token vs sshKey.
    credentials: [{ match: "*", token: "JR2_GIT_TOKEN", sshKey: "jr2-git-ssh" }],
  },
  // Every secret of the Instance, one list (ADR-0068). Where each goes is read, never declared — a pod gets
  // what something in it names. A model key goes to the pods whose Agents' provider reads it, and a
  // `workspace()` that lists a name under `secrets` gets that one: its Custodian holds it and the Agent sees
  // only a Stand-in (ADR-0059). One an Effect names with `secret("name")` is a file in that Effect's Effector
  // alone. `hosts` says where a held value may go. Read values from .env, never commit them.
  // secrets: [{ name: "ANTHROPIC_API_KEY", value: process.env.ANTHROPIC_API_KEY }],
  // Where Sandboxes land (ADR-0052): by default wherever an ordinary pod lands — not cordoned, no taint — and
  // the Repo cache agent follows the same set. No node label is needed. To admit a tainted pool or narrow to
  // a labeled one, name it in raw pod-spec shapes; `jr2 up` reports the Sandbox nodes it sees.
  // sandbox: { nodeSelector: { pool: "agents" }, tolerations: [{ key: "gpu", operator: "Exists" }] },
});
