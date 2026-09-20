// The OPEN sentinel (ADR-0051, widened by ADR-0054) — one value, its own module.
//
// It lives alone here because both of the parts it marks must read it and they sit on opposite
// sides of the package: `agent()`'s declaration (agent.ts, a pure leaf that pulls no wire client)
// and a `workspace()`'s Repo Slots (parts.ts, which already imports agent.ts). A module with
// nothing but the sentinel in it is what lets both import it and neither import the other.

/**
 * Open (CONTEXT.md): this part is a composer's to bind, with `customize()` — a Repo Slot with no
 * url, an Agent with no model. The shape a packaged Machine ships in, because a package cannot
 * know the repository or pay for the model. `jr2 up` refuses an Open part nobody bound and names
 * the line that binds it; a run never sees one.
 *
 * `Symbol.for`, so an Instance's own copy of this module and the CLI's walk agree on it — a
 * packaged Machine may be built against one and walked by the other.
 */
export const open: unique symbol = Symbol.for("jr2.open");
