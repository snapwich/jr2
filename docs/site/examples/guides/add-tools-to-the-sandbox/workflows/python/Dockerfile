# A Sandbox Image for a Python project. The build context is this folder.
FROM python:3.13-slim

# git is part of the floor: the Harness clones, makes the Worktrees and commits with it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The tools of the project.
RUN pip install --no-cache-dir pytest ruff
