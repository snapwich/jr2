import { defineConfig, secret } from "@jr2/orchestrator";
import { github } from "@jr2/orchestrator/hooks/github";
import { gitlab } from "@jr2/orchestrator/hooks/gitlab";

export default defineConfig({
  // Each Hook's secret is an entry of the list. jr2 up places GH_HOOK in the Instance Effector, and
  // gives the Orchestrator only the sha-256 of GL_HOOK.
  secrets: [
    { name: "GH_HOOK", value: process.env.GH_HOOK },
    { name: "GL_HOOK", value: process.env.GL_HOOK },
  ],
  hooks: {
    // POST /hooks/forge: GitHub signs each delivery with the secret GH_HOOK. The Hook may answer
    // the Gates of review alone.
    forge: github({ secret: secret("GH_HOOK"), may: { answer: ["review"] } }),
    // POST /hooks/lab: GitLab sends the secret GL_HOOK as a token in a header.
    lab: gitlab({ secret: secret("GL_HOOK"), may: { answer: ["review"] } }),
  },
});
