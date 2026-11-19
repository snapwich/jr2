import { defineConfig } from "@jr2/orchestrator";

export default defineConfig({
  // The Egress list of each Sandbox whose workspace() states no egress of its own.
  egress: [
    // The npm registry, on ports 443 and 80.
    "registry.npmjs.org",
    // ssh to GitHub. ssh sends no name, so the entry is an exact name with its port.
    "github.com:22",
    // PyPI as an Intercepted host: the Custodian ends its TLS and reads each request.
    { host: "pypi.org", intercept: true },
    // A server that has no name: an exact IPv4 address with its port.
    "192.168.1.20:8000",
  ],
});
