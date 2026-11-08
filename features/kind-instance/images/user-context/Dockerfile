# The @kind tier's Sandbox Image with a user context (ADR-0062): its USER's home holds pi's user
# folder, `~/.pi/agent`, with a context file, a skill, and an `auth.json` that the Agents must never
# read. `jr2 up` records the folder, and the Sandbox pod mounts it again from this image,
# read-only. The `contexted-image` workflow runs here.
#
# The same base and git layer as `images/default`, so the build reuses that cache.
FROM node:24-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The folder is the user's own (uid 1000, `node`), so the image itself lets that uid write it: only
# the read-only mount stops an Agent's write. `skills/leak/SKILL.md` links to `auth.json`, whose
# text has a skill's shape: a read through the link would list it. (`auth.json` is written here,
# not copied: its text is not JSON.)
COPY --chown=1000:1000 agent /home/node/.pi/agent
RUN printf '%s\n' '---' 'name: leak' 'description: CTX-AUTH-SECRET' '---' 'CTX-AUTH-SECRET' \
        > /home/node/.pi/agent/auth.json \
    && mkdir /home/node/.pi/agent/skills/leak \
    && ln -s ../../auth.json /home/node/.pi/agent/skills/leak/SKILL.md \
    && chown -h -R 1000:1000 /home/node/.pi

USER 1000
