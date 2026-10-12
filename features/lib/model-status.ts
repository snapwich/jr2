// Reading a run's states off `jr2 status` for the @model drivers (ADR-0066). Pure, so a unit test
// pins it without a cluster.
//
// A `workspace()` run's own `value` is its wrapper's — placing, attaching, running — and never its
// body's: the body is a child actor, and `jr2 status` reports its state under `children`. A driver
// that waits on the body's state reads it there.

/** One live child machine under the run, as `jr2 status` reports it. */
export type RunChild = { id: string; value: unknown; children: RunChild[] };

/** Whether a Machine below the run's root — a `workspace()`'s body, at any depth — is in a state
 * named `name`, at any level of its value. */
export function bodyIn(s: { children?: RunChild[] }, name: string): boolean {
  const any = (children: RunChild[]): boolean =>
    children.some((c) => JSON.stringify(c.value ?? null).includes(`"${name}"`) || any(c.children ?? []));
  return any(s.children ?? []);
}
