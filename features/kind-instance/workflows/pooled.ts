// The kind tier's Pool of nested Workspaces (ADR-0012, ADR-0017): two parent Workspaces, `item-a`
// and `item-b`, each of which invokes its own child Workspace from the same state, with the same
// invoke id, for two rounds. See `_nested.ts`.

import { fromPromise } from "xstate";
import { pool, source, type PoolNextInput } from "@jr2/orchestrator";
import { parent } from "./_nested.ts";

type Item = { id: string };
const items: Item[] = [{ id: "item-a" }, { id: "item-b" }];

const all = source<Item>({
  next: fromPromise(async ({ input }: { input: PoolNextInput }) => {
    return items.find((i) => !input.active.includes(i.id) && !input.settled.includes(i.id)) ?? null;
  }),
});

export const machine = pool(parent, {
  id: "pooled",
  source: all,
  itemId: (item: Item) => item.id,
  cap: 2,
  itemInput: () => ({ mode: "rounds" as const, sleep: "3" }),
});
