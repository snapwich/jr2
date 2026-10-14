FROM node:24-slim

# git for the Agent. openssh-client gives ssh-keygen, which the Sandbox Effector signs with.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*
