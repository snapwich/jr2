// TEMPORARY (ADR-0049): the roster the DEPLOYED Harness still reads. A Machine carries its Agents
// now — the definition lives in `workflows/_agents.ts`, beside the slots that declare it — but the
// stock Harness image still resolves a definition by name out of the `J2_AGENTS_JSON` ConfigMap
// `j2 up` writes from this folder. This file (and the folder) goes when the definition rides the
// Turn.

export { coder as default } from "../workflows/_agents.ts";
