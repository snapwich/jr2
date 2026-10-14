# A User Container: a shell for a person, beside the Agent, on the same Worktrees.
FROM alpine:3.21

RUN apk add --no-cache git

# The Worktrees under /work belong to a different user. Tell git to trust them.
RUN git config --system --add safe.directory '*'

# jr2 does not replace this command. It must keep running: when it ends, the pod is not ready.
CMD ["sh", "-c", "while true; do sleep 3600; done"]
