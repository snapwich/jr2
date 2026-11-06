// A duration as a person writes it in config or a query: a number and one unit, such as `"90m"`,
// `"36h"`, `"30d"` or `"2w"`. `runs.retain` (ADR-0065) and the `since` of `GET /runs` (ADR-0009)
// read it.

const DURATION = /^(\d+(?:\.\d+)?)(s|m|h|d|w)$/;
const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

/** The duration in milliseconds, or undefined when `text` is not a positive duration. */
export function periodMs(text: string): number | undefined {
  const m = DURATION.exec(text.trim());
  if (!m) return undefined;
  const ms = Number(m[1]) * UNIT_MS[m[2]!]!;
  return ms > 0 && Number.isFinite(ms) ? ms : undefined;
}
