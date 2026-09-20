# @jr2/agent-protocol

The Orchestrator↔Agent wire for jr2: `defineEvent` and nothing else — a pure leaf both `@jr2/orchestrator` and the
Adapter that serves an Agent its Menu depend on, so an event an Agent can deliver is typed once and read the same way on
both ends.

You rarely depend on this directly; a Workflow imports what it needs from `@jr2/orchestrator`. Docs, glossary, and
architecture decisions: [github.com/snapwich/jr2](https://github.com/snapwich/jr2).
