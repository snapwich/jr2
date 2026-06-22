# Workflows are templates of injected providers, with noop defaults

A Machine is a **template**: it defines the control-flow shape and references its moving parts abstractly (as named
xstate actors / actions / guards — "slots"). It does not hard-code how any step concretely works. Concrete behavior is
supplied at deployment via xstate's `provide({ actors, actions, guards })`. j2 ships a library of **providers** (the
"pieces"): the Agent Actor, the work-source readiness actor (poll or push), Sandbox lifecycle, worktree setup, memory
injection, and so on. A user grabs the template that fits the work, then chooses providers (e.g. GitHub vs Jira work
source, which Agent, memory on/off).

Slots can default to **noops** that sit in the correct position in the flow — e.g. a "pre-coding memory injection" step
is a passthrough unless a memory provider is supplied, at which point it activates in place without changing the
template.

This is the single composability mechanism for the whole kit: everything pluggable is an injectable xstate actor. It
keeps templates reusable across backends, lets a Machine be unit-tested with mock actors (no Kubernetes, no flue —
mirroring how jr faked subagents, but first-class), and gives one consistent extension model instead of bespoke plugin
shapes per concern. The cost is the discipline of designing good slot boundaries up front and a capability-negotiation
layer so a template fails fast when given a provider that can't satisfy a required slot.
