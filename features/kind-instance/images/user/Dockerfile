# The @kind tier's User Container image (ADR-0005): the optional third seat, and a stranger's image
# on purpose. Zero jr2 knowledge — no ARG, no `FROM jr2-harness`, nothing about /opt/jr2, no jr2 env —
# because that seat's identity is "what jr2 does not own": jr2 mounts /work read-write and the
# checkouts' two read-only halves (/repos, /opt/jr2) beside it, and injects nothing into the
# process. The build context is THIS directory (ADR-0037).
#
# MUSL, deliberately. `origin`'s fetch url runs /opt/jr2/bin/jr2-upload-pack (ADR-0053), and that
# program is a STATIC binary for exactly this reason — the `work-acl` rule of ADR-0037: it executes
# on a libc jr2 does not control. A glibc seat would pass whether the binary were static or not, so
# alpine is the cheaper proof.
FROM alpine:3.21

# git, because this seat's sessions run git: the fetch url lives in the SHARED `default/.git/config`
# and a seat without git has checkouts it cannot read at all.
RUN apk add --no-cache git

# The dubious-ownership line ADR-0005 names as this seat's own cost. The checkouts under /work were
# created by the Harness's uid and this seat runs as another (root — jr2 hardens nothing here), so
# git refuses them until the IMAGE says otherwise. `--system`: the seat gets no login shell and no
# $HOME of jr2's making, so a `--global` line would depend on env jr2 does not set.
RUN git config --system --add safe.directory '*'

# Its own entrypoint, untouched — jr2 overrides no command in this seat, so an image that exits
# takes the pod's readiness with it. A managed-access image would run its sshd here; this one just
# waits to be exec'd into. `while true; do sleep`, because busybox `sleep` has no `infinity`.
CMD ["sh", "-c", "while true; do sleep 3600; done"]
