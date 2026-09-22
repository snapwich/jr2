# intro

The jr2 intro talk: a [reveal.js](https://revealjs.com) deck that frames a running instance beside it, rather than
describing one.

| Folder      | What it is                                                     |
| ----------- | -------------------------------------------------------------- |
| `instance/` | the jr2 Instance the talk demonstrates (ADR-0009)              |
| `slides/`   | the deck, the commands it can fire, and the script that starts |

## Prerequisites

Everything the instance needs — Node >= 24, Docker, kind, kubectl, llama.cpp; see
[instance/README.md](./instance/README.md) — plus:

| What   | Why                                                   |
| ------ | ----------------------------------------------------- |
| `tmux` | the session every demo command runs in                |
| `ttyd` | serves that session to the deck — `brew install ttyd` |
| `jq`   | the `task` step reads a runId out of JSON             |

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
