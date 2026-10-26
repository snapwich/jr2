// Every Chart file under examples/ is admitted at the door (ADR-0070), as `jr2 up` admits it: a
// guide tells the reader to put it in workflows/<wrapper>/ and run `jr2 up`, and an Assistant copies
// it, so a Chart file that the door refuses fails this suite. Each Chart is admitted against each
// Chart wrapper beside it: a `.ts` file in its own folder, or in a provider folder below it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { admitWrapperChart, ChartRefusal, openBodiesOf, chartWrapperMachineOf } from "@jr2/orchestrator/internal";
import type { AnyStateMachine } from "xstate";

const EXAMPLES = fileURLToPath(new URL("../examples", import.meta.url));

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path)));
    else out.push(path);
  }
  return out;
}

const files = await filesUnder(EXAMPLES);
const charts = files.filter((f) => f.endsWith(".chart.json"));

test("the examples have Chart files", () => {
  assert.ok(charts.length > 0);
});

for (const chart of charts) {
  test(`the door admits ${relative(EXAMPLES, chart)} under each Chart wrapper beside it`, async () => {
    const folder = dirname(chart);
    const candidates = files.filter(
      (f) => f.endsWith(".ts") && (dirname(f) === folder || dirname(dirname(f)) === folder),
    );
    const text = JSON.parse(await readFile(chart, "utf8")) as unknown;
    let wrappers = 0;
    for (const file of candidates) {
      const { machine } = (await import(pathToFileURL(file).href)) as { machine?: AnyStateMachine };
      if (!machine || !openBodiesOf(chartWrapperMachineOf(machine).machine).length) continue;
      wrappers++;
      try {
        admitWrapperChart(machine, text);
      } catch (err) {
        if (!(err instanceof ChartRefusal)) throw err;
        assert.fail(`${relative(EXAMPLES, file)} refuses it:\n${err.report.join("\n")}`);
      }
    }
    assert.ok(wrappers > 0, "no Chart wrapper is beside it");
  });
}
