// The identity provider of the browser login (`@console @dex`, ADR-0032, ADR-0078): Dex in a
// container, one per scenario, on a free host port. Dex's `mockCallback` connector logs a person in
// with no form — the user "Kilgore Trout" (`kilgore@kilgore.trout`) in the group `authors` — so the
// scenario drives the real OIDC exchange (discovery, the code flow with PKCE as a public client,
// the token endpoint, the JWKS fetch in the Orchestrator) with no password to type.
//
// Needs docker, which the rest of `@console` does not: a host with no docker runs the browser tier
// with `--tags "@console and not @dex"`.

import { After, Given } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { E2EWorld } from "./world.ts";

const run = promisify(execFile);

/** The Dex image, at an exact version (ADR-0010: a fixture pins what it runs). */
const DEX_IMAGE = "ghcr.io/dexidp/dex:v2.44.0";

/** The client id the Console logs in as: a public client, with no secret. */
export const DEX_CLIENT_ID = "jr2-console";

/** The scenario's Dex: its container and its issuer URL, by World. */
const dexes = new WeakMap<E2EWorld, { container: string; issuer: string }>();

/** The scenario's Dex issuer URL. */
export function dexIssuer(world: E2EWorld): string {
  const dex = dexes.get(world);
  assert.ok(dex, "a Dex issuer is running");
  return dex.issuer;
}

/** A free TCP port on the loopback address. */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

Given("a Dex issuer is running", { timeout: 180_000 }, async function (this: E2EWorld): Promise<void> {
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}/dex`;
  // A public client with no redirect URI: Dex then takes any `http://localhost` or loopback-address
  // return, which is the scenario's Orchestrator on its free port. `allowedOrigins` lets the
  // Console's origin call discovery and the token endpoint from the browser.
  const config = {
    issuer,
    storage: { type: "memory" },
    web: { http: "0.0.0.0:5556", allowedOrigins: ["*"] },
    oauth2: { skipApprovalScreen: true },
    staticClients: [{ id: DEX_CLIENT_ID, name: "jr2 Console", public: true }],
    connectors: [{ type: "mockCallback", id: "mock", name: "Mock" }],
    enablePasswordDB: false,
  };
  // The config rides an environment variable, so the container needs no bind mount.
  const { stdout } = await run("docker", [
    "run",
    "-d",
    "--rm",
    "-p",
    `127.0.0.1:${port}:5556`,
    "-e",
    `DEX_CONFIG=${JSON.stringify(config)}`,
    "--entrypoint",
    "sh",
    DEX_IMAGE,
    "-c",
    'printf "%s" "$DEX_CONFIG" > /tmp/config.yaml && exec dex serve /tmp/config.yaml',
  ]);
  dexes.set(this, { container: stdout.trim(), issuer });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${issuer}/.well-known/openid-configuration`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      const logs = await run("docker", ["logs", stdout.trim()]).catch(() => ({ stdout: "", stderr: "" }));
      throw new Error(`Dex did not answer at ${issuer} in 60s:\n${logs.stdout}${logs.stderr}`);
    }
    await sleep(250);
  }
});

Given(
  "the instance offers a login at that issuer, where the group {string} may start, answer and read every Workflow",
  async function (this: E2EWorld, group: string): Promise<void> {
    const issuer = {
      issuer: dexIssuer(this),
      audience: DEX_CLIENT_ID,
      groups: { [group]: { start: "all", answer: "all", read: "all" } },
      login: true,
    };
    const config = join(this.dir, "jr2.config.ts");
    const text = await readFile(config, "utf8");
    const declared = text.replace(
      "export default defineConfig({",
      `export default defineConfig({\n  callers: { issuers: [${JSON.stringify(issuer)}] },`,
    );
    assert.notEqual(declared, text, "the scaffolded config has a defineConfig call to declare the issuer in");
    await writeFile(config, declared);
  },
);

After({ tags: "@dex" }, async function (this: E2EWorld): Promise<void> {
  const dex = dexes.get(this);
  if (!dex) return;
  dexes.delete(this);
  await run("docker", ["rm", "-f", dex.container]).catch(() => undefined);
});
