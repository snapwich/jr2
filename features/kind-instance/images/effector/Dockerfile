# The @kind tier's Sandbox Effector image (ADR-0068, B4.3): what a `workspace()` names as
# `effector: { image }` for the tools its Effects need and the Agent's image lacks. The tier's
# Sandbox Image carries git and no ssh, and a signed push over ssh needs `ssh` and `ssh-keygen`
# beside git. Zero jr2 knowledge, like a user's: jr2's binary arrives on the runtime volume and is
# this container's command. The build context is THIS directory (ADR-0037).
#
# MUSL on purpose: the Effector is a static binary, so the seat owes it no libc.
FROM alpine:3.21

RUN apk add --no-cache git openssh-client-default openssh-keygen

# No USER: ADR-0037's fallback seat, uid 1000, as the tier's Sandbox Image runs.
