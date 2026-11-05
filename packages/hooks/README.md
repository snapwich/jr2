# @jr2/hooks

The interface of a jr2 Hook kind, and the kinds that jr2 ships. A Hook is an Instance's door for one outside service
that sends it deliveries. Its Hook kind is that service's protocol: what the service signed, how to read a delivery and
its payloads, the service's handshake, and the envelope of an answer that a person reads.

- `@jr2/hooks`: `defineHookKind`, the types of a kind, and the helpers `json`, `form` and `at`.
- `@jr2/hooks/github`, `@jr2/hooks/gitlab`, `@jr2/hooks/slack`, `@jr2/hooks/discord`: jr2's kinds.
- `@jr2/hooks/webhook`: `webhook()`, which makes a kind from data for a service that has no kind.

`jr2.config.ts` imports a kind and declares each Hook with its credential:
`hooks: { reviews: github({ secret: secret("GH_HOOK") }) }`. A kind never gets the credential. A kind from another
package has a peer dependency on `@jr2/hooks` `^1` and states `api: 1`.

Docs, glossary, and architecture decisions: [github.com/snapwich/jr2](https://github.com/snapwich/jr2).
