# intro

A jr2 instance that runs its Agent against a model on **this machine** — llama.cpp on the Mac, the cluster dialing back
out. Two workflows: `ping` (no Agent, no Sandbox) and `task` (a coder in a Sandbox, a human at a Gate).

## Dependencies

| What                                                                          | Why                                 |
| ----------------------------------------------------------------------------- | ----------------------------------- |
| Node >= 24                                                                    | the `jr2` CLI                       |
| Docker (Colima or Desktop)                                                    | the container runtime under kind    |
| [kind](https://kind.sigs.k8s.io) + kubectl                                    | the cluster `jr2 up` converges into |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) (`brew install llama.cpp`) | serves the model                    |

The model — `unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q6_K_XL`, ~30 GB — downloads on the first `npm run llama`. Budget ~40 GB of
RAM for the server, and leave the Docker VM its own.

## Setup

```sh
npm install
kind create cluster --name jr2          # skip if the cluster exists
kubectl config use-context kind-jr2     # jr2 up converges into the CURRENT context
```

`.env` (git-ignored) holds the two values that vary by machine. Both are already written:

```sh
JR2_PROVIDER_URL=http://192.168.5.2:8000/v1   # the macOS host, from inside a Colima VM
JR2_PROVIDER_API_KEY=<64 hex chars>           # generated at setup
```

The url is the endpoint **as a pod sees it**: `localhost` never works from inside the cluster, and pod DNS does not
carry `host.docker.internal`. On Docker Desktop, or on Linux, that address differs — anything a pod can reach is fine.

The key is the fence. The cluster must dial IN, so the server binds `0.0.0.0` and is therefore on your LAN; without a
key, any device on the subnet could use the GPU and read `/props`. `npm run llama` reads the key from this file and
`jr2 up` materializes it into the instance's Secret, so it is written once and never lands in a manifest. To rotate it,
edit `.env` and restart both.

## Run

Start the model and leave it running:

```sh
npm run llama
```

Then, in a second shell, converge and run. `jr2 up` proves the endpoint from inside a pod — `GET /models` plus one real
tool call — before it converges anything:

```sh
jr2 up
jr2 run ping --input '{"message":"hi"}'
jr2 run task --input '{"prompt":"Add a --version flag to the CLI."}'
```

`task` parks at the `review` Gate when the coder finishes. While it is parked the Sandbox is alive, so read the branch,
then answer:

```sh
jr2 status                                                   # the run, the Gate, the branch
jr2 logs <runId> -f
jr2 send <runId> --gate body.review --event request_changes --input '{"notes":"Also accept -v."}'
jr2 send <runId> --gate body.review --event approve
```

`approve` tears the Workspace down. **The Machine never pushes** — anything uncommitted to a remote goes with the pod.

## Down

```sh
jr2 down
```
