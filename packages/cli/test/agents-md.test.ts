// The `AGENTS.md` block (ADR-0072): `jr2 up` rewrites the text between the two marker lines to the
// block the Instance's Kit bundles, and nothing else. The file is the user's, so these tests hold
// the rewrite to the two promises that make that safe: a folder without the markers is never
// touched, and every byte outside the markers survives, line endings included. A fixture bundle
// stands in for `docs:build`'s output, which this package never builds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BEGIN_MARKER, END_MARKER, rewriteAgentsBlock, scaffoldAgentsMd, syncAgentsMd } from "../src/agents-md.ts";
import { up } from "../src/commands/up.ts";
import { linkKit } from "./_kit.ts";
import type { Io } from "../src/output.ts";

const BLOCK = "jr2 0.9.0 is newer than your training data.\nRead node_modules/@jr2/orchestrator/docs/.\n";

/** A Kit root with a docs bundle, or without one when `block` is undefined. */
async function fixtureKit(t: { after: (fn: () => Promise<void>) => void }, block?: string): Promise<string> {
  const kit = await mkdtemp(join(tmpdir(), "jr2-kit-docs-"));
  t.after(() => rm(kit, { recursive: true, force: true }));
  if (block !== undefined) {
    await mkdir(join(kit, "docs"));
    await writeFile(join(kit, "docs", "agents-block.md"), block);
  }
  return kit;
}

async function instance(t: { after: (fn: () => Promise<void>) => void }, agents?: string | Buffer): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jr2-agents-md-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (agents !== undefined) await writeFile(join(root, "AGENTS.md"), agents);
  return root;
}

function capture(cwd: string): { io: Io; err: string[] } {
  const err: string[] = [];
  return { io: { stdout: () => {}, stderr: (s) => void err.push(s), env: {}, cwd }, err };
}

// --- the rewrite, pure ---------------------------------------------------------------------------

test("a text with no marker line has opted out, even when it names a marker inside a line", () => {
  assert.deepEqual(rewriteAgentsBlock("# my rules\n", BLOCK), { kind: "opted-out" });
  assert.deepEqual(rewriteAgentsBlock(`see ${BEGIN_MARKER} and ${END_MARKER}\n`, BLOCK), { kind: "opted-out" });
});

test("each kind of broken pair is named, and nothing is rewritten", () => {
  const cases: Array<[string, RegExp]> = [
    [`${BEGIN_MARKER}\nold\n`, /has no <!-- END:jr2-docs --> after it/],
    [`old\n${END_MARKER}\n`, /has no <!-- BEGIN:jr2-docs --> before it/],
    [`${END_MARKER}\nold\n${BEGIN_MARKER}\n`, /<!-- END:jr2-docs --> comes before <!-- BEGIN:jr2-docs -->/],
    [`${BEGIN_MARKER}\n${BEGIN_MARKER}\n${END_MARKER}\n`, /<!-- BEGIN:jr2-docs --> occurs 2 times/],
    [`${BEGIN_MARKER}\n${END_MARKER}\n${END_MARKER}\n`, /<!-- END:jr2-docs --> occurs 2 times/],
  ];
  for (const [text, reason] of cases) {
    const r = rewriteAgentsBlock(text, BLOCK);
    assert.equal(r.kind, "broken", text);
    assert.match((r as { reason: string }).reason, reason);
  }
});

test("the same text between the markers is current", () => {
  assert.deepEqual(rewriteAgentsBlock(scaffoldAgentsMd(BLOCK), BLOCK), { kind: "current" });
});

test("a different text is replaced, and every byte outside the markers is kept", () => {
  const before = "# Mine\n\nno trailing space here  \n";
  const after = "\n## After\n\nkeep this, and no final newline";
  const text = `${before}${BEGIN_MARKER}\nold block\nsecond line\n${END_MARKER}${after}`;
  const r = rewriteAgentsBlock(text, BLOCK);
  assert.deepEqual(r, { kind: "updated", text: `${before}${BEGIN_MARKER}\n${BLOCK}${END_MARKER}${after}` });
});

test("empty markers are filled", () => {
  const r = rewriteAgentsBlock(scaffoldAgentsMd(), BLOCK);
  assert.deepEqual(r, { kind: "updated", text: scaffoldAgentsMd(BLOCK) });
});

test("a CRLF file gets the block in CRLF, keeps its own line endings, and is then current", () => {
  const text = `mine\r\n${BEGIN_MARKER}\r\nold\r\n${END_MARKER}\r\nafter\n`;
  const r = rewriteAgentsBlock(text, BLOCK);
  const crlf = BLOCK.replace(/\n/g, "\r\n");
  assert.deepEqual(r, { kind: "updated", text: `mine\r\n${BEGIN_MARKER}\r\n${crlf}${END_MARKER}\r\nafter\n` });
  assert.deepEqual(rewriteAgentsBlock((r as { text: string }).text, BLOCK), { kind: "current" });
});

// --- `jr2 up`'s step, on disk --------------------------------------------------------------------

test("no AGENTS.md: nothing is created and nothing is said", async (t) => {
  const kit = await fixtureKit(t, BLOCK);
  const root = await instance(t);
  const { io, err } = capture(root);
  await syncAgentsMd(io, root, kit, "0.9.0");
  await assert.rejects(stat(join(root, "AGENTS.md")));
  assert.deepEqual(err, []);
});

test("an AGENTS.md with no markers is not touched, and nothing is said", async (t) => {
  const kit = await fixtureKit(t, BLOCK);
  const root = await instance(t, "# my own rules\n");
  const { io, err } = capture(root);
  await syncAgentsMd(io, root, kit, "0.9.0");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "# my own rules\n");
  assert.deepEqual(err, []);
});

test("broken markers: one warning line, and the file is not touched — with or without a bundle", async (t) => {
  for (const kit of [await fixtureKit(t, BLOCK), await fixtureKit(t)]) {
    const text = `${BEGIN_MARKER}\nold\n`;
    const root = await instance(t, text);
    const { io, err } = capture(root);
    await syncAgentsMd(io, root, kit, "0.9.0");
    assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), text);
    assert.equal(err.length, 1);
    assert.match(err[0]!, /^warning: AGENTS\.md: .*has no <!-- END:jr2-docs --> after it.*not updated\n$/);
  }
});

test("a Kit with no bundle: one line that says why, and the file is not touched", async (t) => {
  const kit = await fixtureKit(t);
  const root = await instance(t, scaffoldAgentsMd());
  const { io, err } = capture(root);
  await syncAgentsMd(io, root, kit, "0.9.0");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), scaffoldAgentsMd());
  assert.equal(err.length, 1);
  assert.match(err[0]!, /^AGENTS\.md: jr2 block not updated: .*docs\/agents-block\.md/);
});

test("a current block: nothing is written and nothing is said", async (t) => {
  const kit = await fixtureKit(t, BLOCK);
  const root = await instance(t, scaffoldAgentsMd(BLOCK));
  const { mtimeMs } = await stat(join(root, "AGENTS.md"));
  const { io, err } = capture(root);
  await syncAgentsMd(io, root, kit, "0.9.0");
  assert.equal((await stat(join(root, "AGENTS.md"))).mtimeMs, mtimeMs);
  assert.deepEqual(err, []);
});

test("a stale block is rewritten, the bytes outside kept exactly, and the one line names the version", async (t) => {
  const kit = await fixtureKit(t, BLOCK);
  // Not valid UTF-8 outside the markers, and a BOM: a decode-and-encode would change both.
  const head = Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0xff, 0xfe, 0x0d, 0x0a]);
  const tail = Buffer.from("\r\nmine é\n", "utf8");
  const file = Buffer.concat([head, Buffer.from(`${BEGIN_MARKER}\nold\n${END_MARKER}`), tail]);
  const root = await instance(t, file);
  const { io, err } = capture(root);
  await syncAgentsMd(io, root, kit, "0.9.0");
  const written = await readFile(join(root, "AGENTS.md"));
  assert.deepEqual(written, Buffer.concat([head, Buffer.from(`${BEGIN_MARKER}\n${BLOCK}${END_MARKER}`), tail]));
  assert.deepEqual(err, ["AGENTS.md: jr2 block updated for 0.9.0\n"]);
});

test("a block that is not ASCII is written as UTF-8 and is then current", async (t) => {
  const block = "jr2 — the Kit’s docs\n";
  const kit = await fixtureKit(t, block);
  const root = await instance(t, scaffoldAgentsMd());
  const { io } = capture(root);
  await syncAgentsMd(io, root, kit, "0.9.0");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), scaffoldAgentsMd(block));
  const again = capture(root);
  await syncAgentsMd(again.io, root, kit, "0.9.0");
  assert.deepEqual(again.err, []);
});

// --- the wiring in `jr2 up` ----------------------------------------------------------------------

test("up checks AGENTS.md before anything can refuse: a converge that fails still says so", async (t) => {
  // The broken pair is the one outcome that does not depend on whether this checkout has run
  // docs:build, so it is the wiring's probe.
  const root = await instance(t, `${END_MARKER}\n`);
  await writeFile(join(root, "jr2.config.ts"), "export default {};\n");
  await linkKit(root);
  const { io, err } = capture(root);
  // No kube context: the first thing `up` refuses on, before the typecheck and the cluster.
  io.kubeAdmin = { context: async () => undefined } as unknown as Io["kubeAdmin"];
  await assert.rejects(up([], io), /no kube context/);
  assert.match(err.join(""), /^warning: AGENTS\.md: .*has no <!-- BEGIN:jr2-docs --> before it/);
});
