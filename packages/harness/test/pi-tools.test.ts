// The import of pi's Working tools (`pi-tools.ts`, ADR-0027): the private files are where this pin
// has them, with the names jr2 calls, and the import adds no signal listener and no write.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectSupportedImageMimeType, PRIVATE_FILES } from "../src/pi-tools.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("the private files of pi's Working tools are where this pin has them, with the names jr2 calls", async () => {
  // `pi-tools.ts` imports these files by a file URL, not the package root. A pin bump that moves
  // one fails here.
  const root = import.meta.resolve("@earendil-works/pi-coding-agent");
  const names: Record<keyof typeof PRIVATE_FILES, string[]> = {
    read: ["createReadToolDefinition"],
    write: ["createWriteToolDefinition"],
    edit: ["createEditToolDefinition"],
    bash: ["createBashToolDefinition"],
    find: ["createFindToolDefinition"],
    mime: ["detectSupportedImageMimeType"],
  };
  for (const [file, wanted] of Object.entries(names)) {
    const module = (await import(new URL(PRIVATE_FILES[file as keyof typeof PRIVATE_FILES], root).href)) as Record<
      string,
      unknown
    >;
    for (const name of wanted) assert.equal(typeof module[name], "function", `${file}: ${name}`);
  }
});

test("pi's image sniff names a PNG and no text", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  assert.equal(detectSupportedImageMimeType(png), "image/png");
  assert.equal(detectSupportedImageMimeType(Buffer.from("plain text\n")), null);
});

test("the import adds no SIGINT or SIGTERM listener and writes nothing under HOME", () => {
  // The package root loads signal-exit, which listens for both. The private files do not.
  const module = join(here, "..", "src", "pi-tools.ts");
  const home = mkdtempSync(join(tmpdir(), "jr2-pi-tools-home-"));
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(module)}); console.log(process.listenerCount("SIGINT"), process.listenerCount("SIGTERM"));`,
    ],
    { encoding: "utf8", env: { ...process.env, HOME: home } },
  );
  assert.equal(out.trim(), "0 0");
  assert.deepEqual(readdirSync(home), []);
});
