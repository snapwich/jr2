# The @model tier's Sandbox Effector image, the @kind tier's twin (ADR-0068): what a `workspace()` names as
# `effector: { image }` for the tools its Effects need and the Agent's image lacks. The tier's
# Sandbox Image carries git and no ssh, and a signed push over ssh needs `ssh` and `ssh-keygen`
# beside git. Zero jr2 knowledge, like a user's: jr2's binary arrives on the runtime volume and is
# this container's command. The build context is THIS directory (ADR-0037).
#
# MUSL on purpose: the Effector is a static binary, so the seat owes it no libc.
FROM alpine:3.21

RUN apk add --no-cache git openssh-client-default openssh-keygen

# ssh exits ("No user exists for uid 1000") when the uid it runs as has no passwd entry, so the
# image names one for the fallback uid, as most base images do for theirs (node's `node`).
RUN adduser -D -u 1000 -h /home/effector effector

# No USER: ADR-0037's fallback seat, uid 1000, as the tier's Sandbox Image runs.
