// The facts of the Custodian (ADR-0059, ADR-0084) that its renderer (`custodian-rules.ts`), its
// control process and `jr2 up` share, socket-free: the pinned image, Envoy's command line in the
// Custodian pod, and the replies for a target or an Orchestrator that gave no answer. What the
// Custodian pod's Envoy is told is pinned in `custodian-rules.test.ts`; the Custodian suite
// (`packages/cli/test/custodian.docker.ts`) runs it in the pinned Envoy.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CUSTODIAN_DRAIN_SECONDS,
  CUSTODIAN_IMAGE,
  CUSTODIAN_POD_ARGS,
  custodianRef,
  MAY_HAVE_SENT_FLAGS,
  NOT_SENT_FLAGS,
  ORCHESTRATOR_UNREACHABLE,
  unreachable,
} from "../src/custodian.ts";

test("the image is upstream Envoy pinned by digest, re-homed by kitRegistry like a Kit image", () => {
  assert.match(CUSTODIAN_IMAGE.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(custodianRef(), `docker.io/envoyproxy/envoy:${CUSTODIAN_IMAGE.tag}@${CUSTODIAN_IMAGE.digest}`);
  assert.equal(
    custodianRef("zot.example.test/"),
    `zot.example.test/envoy:${CUSTODIAN_IMAGE.tag}@${CUSTODIAN_IMAGE.digest}`,
  );
  assert.deepEqual(CUSTODIAN_POD_ARGS.slice(0, 2), ["-c", "/etc/jr2/custodian/envoy.json"]);
  assert.ok(CUSTODIAN_POD_ARGS.includes("--disable-hot-restart"));
  assert.equal(CUSTODIAN_POD_ARGS[CUSTODIAN_POD_ARGS.indexOf("--drain-time-s") + 1], String(CUSTODIAN_DRAIN_SECONDS));
});

type Mapper = {
  filter: { response_flag_filter: { flags: string[] } };
  status_code: number;
  body_format_override: { text_format_source: { inline_string: string } };
};

test("the Orchestrator's unreachable answer names every Envoy flag of a stream it did not complete, its own resets included (ADR-0002)", () => {
  const mappers = ORCHESTRATOR_UNREACHABLE.mappers as Array<{ filter: Mapper["filter"]; status_code: number }>;
  assert.equal(mappers.length, 1);
  assert.equal(mappers[0]!.status_code, 502);
  assert.deepEqual([...mappers[0]!.filter.response_flag_filter.flags].sort(), [
    "DF",
    "DPE",
    "LR",
    "UC",
    "UF",
    "UH",
    "UMSDR",
    "UPE",
    "UR",
    "URX",
  ]);
  assert.deepEqual(mappers[0]!.filter.response_flag_filter.flags, [...NOT_SENT_FLAGS, ...MAY_HAVE_SENT_FLAGS]);
});

test("an intercepted target that gave no answer has two 502 texts, one per flag group (ADR-0059)", () => {
  const target = "litellm.corp.example:443";
  const intercept = unreachable(target).mappers as Mapper[];
  const details = "%RESPONSE_CODE_DETAILS% %UPSTREAM_TRANSPORT_FAILURE_REASON%\n";
  assert.deepEqual(
    intercept.map((m) => [
      m.status_code,
      m.filter.response_flag_filter.flags,
      m.body_format_override.text_format_source.inline_string,
    ]),
    [
      [502, ["UF", "UH", "DF"], `jr2 custodian: ${target} could not be reached: ${details}`],
      [
        502,
        ["UC", "DPE", "UMSDR", "URX", "UPE", "UR", "LR"],
        `jr2 custodian: ${target} did not answer; the request may have reached it: ${details}`,
      ],
    ],
  );
  // One reply can carry several flags, and Envoy uses the first mapper that matches any of them, in
  // order. `URX` comes with the last attempt's own flag: `UF,URX` was never sent, `UC,URX` may have
  // been.
  const textFor = (flags: string[]) =>
    intercept
      .find((m) => m.filter.response_flag_filter.flags.some((f) => flags.includes(f)))
      ?.body_format_override.text_format_source.inline_string.split(": %")[0];
  assert.equal(textFor(["UF", "URX"]), `jr2 custodian: ${target} could not be reached`);
  assert.equal(textFor(["UC", "URX"]), `jr2 custodian: ${target} did not answer; the request may have reached it`);
  assert.equal(textFor(["UH"]), `jr2 custodian: ${target} could not be reached`);
  assert.equal(textFor(["UPE"]), `jr2 custodian: ${target} did not answer; the request may have reached it`);
});
