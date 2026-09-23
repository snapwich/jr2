# @jr2/agent-protocol

The Orchestrator↔Agent wire for jr2: `defineEvent` and nothing else — a pure leaf `@jr2/orchestrator` depends on, so an
event an Agent can deliver is typed once. The Harness reads the same definition off the wire, as the JSON Schema the
Menu offers its model.

You rarely depend on this directly; a Workflow imports what it needs from `@jr2/orchestrator`. Docs, glossary, and
architecture decisions: [github.com/snapwich/jr2](https://github.com/snapwich/jr2).
