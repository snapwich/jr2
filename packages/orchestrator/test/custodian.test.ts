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

type FlagFilter = { response_flag_filter?: { flags: string[] } };
type Mapper = {
  filter: FlagFilter & {
    and_filter?: { filters: Array<FlagFilter & { extension_filter?: { typed_config: { expression: string } } }> };
  };
  status_code: number;
  body_format_override: { text_format_source: { inline_string: string } };
};

test("the Orchestrator's unreachable answer names every Envoy flag of a stream it did not complete, its own resets included (ADR-0002)", () => {
  const mappers = ORCHESTRATOR_UNREACHABLE.mappers as Array<{ filter: Mapper["filter"]; status_code: number }>;
  assert.equal(mappers.length, 1);
  assert.equal(mappers[0]!.status_code, 502);
  assert.deepEqual([...mappers[0]!.filter.response_flag_filter!.flags].sort(), [
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
  assert.deepEqual(mappers[0]!.filter.response_flag_filter!.flags, [...NOT_SENT_FLAGS, ...MAY_HAVE_SENT_FLAGS]);
});

test("an intercepted target that gave no answer has two 502 texts, one per flag group, and says why a TLS handshake failed (ADR-0059)", () => {
  const target = "litellm.corp.example:443";
  const details = "%RESPONSE_CODE_DETAILS% %UPSTREAM_TRANSPORT_FAILURE_REASON%\n";
  const reached = `jr2 custodian: ${target} could not be reached`;
  const offered =
    "the host may not accept TLS 1.2 with an ECDHE cipher suite and AES-GCM or ChaCha20-Poly1305, which is all that the Custodian offers";
  const certificate =
    `${reached}: the TLS handshake failed: the Custodian does not trust the certificate of the host, or the ` +
    "certificate is not for this name (a private CA must be in harness.caBundle)";
  const handshake = `${reached}: the TLS handshake failed: ${offered}`;
  const closed = `${reached}: the host closed the connection before the TLS handshake ended: ${offered}`;
  const cel = (m: Mapper) => m.filter.and_filter?.filters[1]!.extension_filter!.typed_config.expression;
  const flagsOf = (m: Mapper) =>
    (m.filter.and_filter?.filters[0]!.response_flag_filter ?? m.filter.response_flag_filter)!.flags;
  const rows = (mappers: Mapper[]) =>
    mappers.map((m) => [m.status_code, flagsOf(m), cel(m), m.body_format_override.text_format_source.inline_string]);
  const plain = unreachable(target).mappers as Mapper[];
  assert.deepEqual(rows(plain), [
    [502, ["UF"], "response.code_details.contains('CERTIFICATE_VERIFY_FAILED')", `${certificate}: ${details}`],
    [502, ["UF"], "response.code_details.contains('TLS_error')", `${handshake}: ${details}`],
    [502, ["UF", "UH", "DF"], undefined, `${reached}: ${details}`],
    [
      502,
      ["UC", "DPE", "UMSDR", "URX", "UPE", "UR", "LR"],
      undefined,
      `jr2 custodian: ${target} did not answer; the request may have reached it: ${details}`,
    ],
  ]);
  // On a route to TLS, a close with no TLS alert after the connect is a close in the handshake. The
  // details are that text alone: a refused connect adds `delayed_connect_error`.
  const tls = unreachable(target, { tls: true }).mappers as Mapper[];
  assert.deepEqual(rows(tls).slice(0, 3), [
    ...rows(plain).slice(0, 2),
    [
      502,
      ["UF"],
      "response.code_details == 'upstream_reset_before_response_started{remote_connection_failure}'",
      `${closed}: ${details}`,
    ],
  ]);
  assert.deepEqual(rows(tls).slice(3), rows(plain).slice(2));
  // One reply can carry several flags, and Envoy uses the first mapper that matches any of them, in
  // order. `URX` comes with the last attempt's own flag: `UF,URX` was never sent, `UC,URX` may have
  // been.
  const textFor = (flags: string[]) =>
    plain
      .find((m) => !cel(m) && flagsOf(m).some((f) => flags.includes(f)))
      ?.body_format_override.text_format_source.inline_string.split(": %")[0];
  assert.equal(textFor(["UF", "URX"]), reached);
  assert.equal(textFor(["UC", "URX"]), `jr2 custodian: ${target} did not answer; the request may have reached it`);
  assert.equal(textFor(["UH"]), reached);
  assert.equal(textFor(["UPE"]), `jr2 custodian: ${target} did not answer; the request may have reached it`);
});
