# intro

The jr2 intro talk: a [reveal.js](https://revealjs.com) deck that frames a running instance beside it, rather than
describing one.

| Folder      | What it is                                                     |
| ----------- | -------------------------------------------------------------- |
| `instance/` | the jr2 Instance the talk demonstrates (ADR-0009)              |
| `repo/`     | the toy CLI the `task` step changes, served in-cluster         |
| `slides/`   | the deck, the commands it can fire, and the script that starts |

## Prerequisites

Everything the instance needs — Node >= 24, Docker, kind, kubectl, llama.cpp; see
[instance/README.md](./instance/README.md) — plus:

| What   | Why                                                   |
| ------ | ----------------------------------------------------- |
| `tmux` | the session every demo command runs in                |
| `ttyd` | serves that session to the deck — `brew install ttyd` |
| `jq`   | the `task` step reads a runId out of JSON             |

## Before the talk

The demo runs with **no network**. Do this online, after the last edit to `instance/`, because a changed instance makes
`jr2 up` build again and a build needs the network:

```sh
cd instance && npx jr2 up          # builds and delivers every image jr2 builds
cd instance && npm run seed        # serves repo/ in-cluster at http://seed.intro-seed.svc/greet.git
cd instance && npm run preload     # puts the images jr2 up does not build onto the node
```

`npm run preload` loads the User Container image, `node:24-slim` (the image of `jr2 up`'s provider probe), and the
seed's two images. It also names any image `jr2 up` delivered that the node no longer holds. `npm start` checks the same
list and the seed, and stops on anything missing.

Then start the model with `LLAMA_ARG_OFFLINE=1 npm run llama`. Without it, `-hf` asks Hugging Face for the manifest
first.

To rehearse offline, turn off Wi-Fi and run every step in `slides/demo.json`. The pods reach the model at `192.168.5.2`,
Colima's address for the host. That path goes through the VM, not Wi-Fi, but the Wi-Fi-off rehearsal is what proves it.

## Run it

```sh
cd instance && npm install && npm run llama    # shell 1 — the model; leave it running
cd instance && npx jr2 up                      # once, so subsequent ups are faster
cd slides   && npm install && npm start        # shell 2 — preflight, then the deck
```

Open the deck at `http://localhost:9000`. It frames the Console (`:8080`) and the demo terminal (`:7681`).

`npm start` checks its prerequisites first and names what is missing. Ctrl-C in shell 2 stops everything it started, the
tmux session included.

One more command:

- `npm run slides` — the deck alone, for writing slides with no cluster running.

## Keys

| Key           | What it does                                                        |
| ------------- | ------------------------------------------------------------------- |
| `i`           | go live: click in the Console, and type into the terminal           |
| `Ctrl-Escape` | leave live mode — plain Escape goes to the terminal, for k9s or vim |

Changing slides also leaves live mode.
