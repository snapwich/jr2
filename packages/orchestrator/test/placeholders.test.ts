// The placeholder table of a Harness pod (ADR-0084): append-only for the life of the pod, so that an
// address that a client kept from an earlier answer can never reach another name.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkAppendOnly,
  emptyPlaceholders,
  jr2NameAddress,
  placeholderName,
  placeholderOf,
  withPlaceholders,
  type PlaceholderTable,
} from "../src/placeholders.ts";
import { rule } from "./_custodian-slots.ts";

const RANGE = "198.18.0.0/16";
const names = (...hosts: string[]) => hosts.map((h) => rule(h, 443, "name", false, "entry"));

test("jr2's own name has the first address; the names take the next ones, sorted, and an address entry takes none", () => {
  assert.equal(jr2NameAddress(RANGE), "198.18.0.1");
  assert.equal(jr2NameAddress("100.64.0.0/16"), "100.64.0.1");
  const table = withPlaceholders(emptyPlaceholders(RANGE), [
    rule("github.com", 443, "name", false, "entry"),
    rule("github.com", 80, "name", false, "entry"),
    rule("example.com", 443, "below", false, "entry"),
    rule("*", 443, "any", false, "entry"),
    rule("10.0.0.5", 8000, "address", false, "entry"),
  ]);
  assert.deepEqual(table.rows, [
    { name: "*", address: "198.18.0.2" },
    { name: "*.example.com", address: "198.18.0.3" },
    { name: "github.com", address: "198.18.0.4" },
  ]);
  assert.equal(placeholderOf(table, "github.com"), "198.18.0.4");
  assert.equal(placeholderName(rule("10.0.0.5", 8000, "address", false, "entry")), undefined);
});

test("the table is append-only: a new name goes at the end, a removed name keeps its row, and a name that returns gets its address back", () => {
  const first = withPlaceholders(emptyPlaceholders(RANGE), names("b.example", "a.example"));
  assert.deepEqual(first.rows, [
    { name: "a.example", address: "198.18.0.2" },
    { name: "b.example", address: "198.18.0.3" },
  ]);
  // "a.example" leaves the list, "c.example" joins it.
  const second = withPlaceholders(first, names("b.example", "c.example"));
  assert.deepEqual(second.rows, [...first.rows, { name: "c.example", address: "198.18.0.4" }]);
  checkAppendOnly(first, second);
  // "a.example" comes back: the same address, and no new row.
  const third = withPlaceholders(second, names("a.example", "d.example"));
  assert.equal(placeholderOf(third, "a.example"), "198.18.0.2");
  assert.deepEqual(third.rows.at(-1), { name: "d.example", address: "198.18.0.5" });
  checkAppendOnly(second, third);
  checkAppendOnly(undefined, third);
});

test("after any sequence of lists, each table is the one before with rows added, and no address is held twice", () => {
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
  let table: PlaceholderTable = emptyPlaceholders(RANGE);
  const seen = new Map<string, string>();
  for (let step = 0; step < 200; step++) {
    const list = Array.from({ length: next() % 6 }, () => `h${next() % 40}.example`);
    const after = withPlaceholders(table, names(...list));
    checkAppendOnly(table, after);
    for (const row of after.rows) {
      const known = seen.get(row.name);
      if (known !== undefined) assert.equal(row.address, known, `${row.name} kept its address`);
      seen.set(row.name, row.address);
    }
    table = after;
  }
  assert.equal(new Set(table.rows.map((r) => r.address)).size, table.rows.length);
});

test("checkAppendOnly refuses a lost, a changed or a moved row, an address held twice or outside the range, and jr2's own address", () => {
  const prev = withPlaceholders(emptyPlaceholders(RANGE), names("a.example", "b.example"));
  const cases: Array<[string, PlaceholderTable, RegExp]> = [
    ["a lost row", { range: RANGE, rows: prev.rows.slice(1) }, /lost or changed the row a\.example/],
    [
      "a changed address",
      { range: RANGE, rows: [{ name: "a.example", address: "198.18.0.9" }, prev.rows[1]!] },
      /lost or changed/,
    ],
    ["a moved row", { range: RANGE, rows: [prev.rows[1]!, prev.rows[0]!] }, /lost or changed/],
    [
      "an address held twice",
      { range: RANGE, rows: [...prev.rows, { name: "c.example", address: "198.18.0.3" }] },
      /gives 198\.18\.0\.3 twice/,
    ],
    [
      "jr2's own address",
      { range: RANGE, rows: [...prev.rows, { name: "c.example", address: "198.18.0.1" }] },
      /gives 198\.18\.0\.1 twice/,
    ],
    [
      "an address outside the range",
      { range: RANGE, rows: [...prev.rows, { name: "c.example", address: "198.19.0.4" }] },
      /not in 198\.18\.0\.0\/16/,
    ],
    ["another range", { range: "100.64.0.0/16", rows: [] }, /moved from 198\.18\.0\.0\/16/],
  ];
  for (const [what, next, message] of cases) {
    assert.throws(() => checkAppendOnly(prev, next), message, what);
  }
});

test("a range with no address left refuses the next name", () => {
  // A /30: the network address, jr2's own name, one name, the broadcast address.
  const one = withPlaceholders(emptyPlaceholders("10.9.0.0/30"), names("a.example"));
  assert.deepEqual(one.rows, [{ name: "a.example", address: "10.9.0.2" }]);
  assert.throws(() => withPlaceholders(one, names("a.example", "b.example")), /no address left for b\.example/);
});
