// The placeholder addresses of one Harness pod (ADR-0084): the address that its resolver gives each
// name of its Egress list, and from which the Custodian reads the name back. "A name decides, never
// an address": the address only says which name the pod asked for.
//
// The table is append-only for the life of the pod. A name keeps its address, a name that leaves the
// list keeps its row and gets the same address back when it returns, and no address is ever given to
// a second name. So a client that kept an address from an earlier answer can never reach another
// name with it. The first address of the range is jr2's own name (`JR2_CUSTODIAN_NAME`), in every
// pod; the names of the list take the addresses after it, in the order they came.

import { isIP } from "node:net";
import type { EgressRule } from "./egress.ts";

/** One row: a name and its address. The name is an exact DNS name, `*.<domain>` for each name below a
 * domain, or `*` for each name. An address entry has no row: it is its own address. */
export type PlaceholderRow = { name: string; address: string };

/** The table of one pod: the range its addresses come from, and its rows in the order they came. */
export type PlaceholderTable = { range: string; rows: PlaceholderRow[] };

/** The row name of a rule, or undefined for an address rule. */
export function placeholderName(rule: Pick<EgressRule, "host" | "match">): string | undefined {
  switch (rule.match) {
    case "name":
      return rule.host;
    case "below":
      return `*.${rule.host}`;
    case "any":
      return "*";
    case "address":
      return undefined;
  }
}

/** jr2's own name's address in a range: its first address after the network address. */
export function jr2NameAddress(range: string): string {
  return intText(rangeOf(range).base + 1);
}

/** An empty table of a range. */
export function emptyPlaceholders(range: string): PlaceholderTable {
  rangeOf(range);
  return { range, rows: [] };
}

/**
 * The table after `prev` with a row for each name of `rules` that has none: `prev` whole, in its
 * order, then each new name, sorted, at the address after the highest address that the table holds.
 * Throws when the range has no address left, or when `prev` is of another range: a pod's addresses
 * never move.
 */
export function withPlaceholders(
  prev: PlaceholderTable,
  rules: readonly Pick<EgressRule, "host" | "match">[],
): PlaceholderTable {
  const range = rangeOf(prev.range);
  const known = new Set(prev.rows.map((r) => r.name));
  const wanted = [...new Set(rules.map(placeholderName).filter((n): n is string => n !== undefined))]
    .filter((n) => !known.has(n))
    .sort();
  let next = Math.max(range.base + 1, ...prev.rows.map((r) => ipv4Int(r.address))) + 1;
  const last = range.base + range.size - 2; // the last address before the broadcast address
  const rows = [...prev.rows];
  for (const name of wanted) {
    if (next > last) {
      throw new Error(`the placeholder range ${prev.range} has no address left for ${name} (ADR-0084)`);
    }
    rows.push({ name, address: intText(next++) });
  }
  return { range: prev.range, rows };
}

/** The address of `name` in `table`, or undefined. */
export function placeholderOf(table: PlaceholderTable, name: string): string | undefined {
  return table.rows.find((r) => r.name === name)?.address;
}

/**
 * Throws unless `next` is `prev` with rows added at its end: the same range, each row of `prev` with
 * the same address at the same place, and no address held twice or outside the range. jr2's own
 * name's address is never a row's.
 */
export function checkAppendOnly(prev: PlaceholderTable | undefined, next: PlaceholderTable): void {
  if (prev !== undefined && prev.range !== next.range) {
    throw new Error(
      `the placeholder table moved from ${prev.range} to ${next.range}; its addresses never move (ADR-0084)`,
    );
  }
  const range = rangeOf(next.range);
  for (const [i, row] of (prev?.rows ?? []).entries()) {
    const now = next.rows[i];
    if (now === undefined || now.name !== row.name || now.address !== row.address) {
      throw new Error(
        `the placeholder table lost or changed the row ${row.name} ${row.address}; it is append-only (ADR-0084)`,
      );
    }
  }
  const names = new Set<string>();
  const addresses = new Set<string>([jr2NameAddress(next.range)]);
  for (const row of next.rows) {
    if (names.has(row.name)) throw new Error(`the placeholder table holds ${row.name} twice (ADR-0084)`);
    if (addresses.has(row.address)) throw new Error(`the placeholder table gives ${row.address} twice (ADR-0084)`);
    const at = isIP(row.address) === 4 ? ipv4Int(row.address) : -1;
    if (at <= range.base + 1 || at >= range.base + range.size - 1) {
      throw new Error(`the placeholder address ${row.address} of ${row.name} is not in ${next.range} (ADR-0084)`);
    }
    names.add(row.name);
    addresses.add(row.address);
  }
}

// --- IPv4 arithmetic --------------------------------------------------------------------------

function rangeOf(range: string): { base: number; size: number } {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(range);
  if (!m || isIP(m[1]!) !== 4 || Number(m[2]) > 30) throw new Error(`"${range}" is not an IPv4 prefix a.b.c.d/n`);
  return { base: ipv4Int(m[1]!), size: 2 ** (32 - Number(m[2])) };
}

function ipv4Int(address: string): number {
  return address.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
}

function intText(n: number): string {
  return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
}
