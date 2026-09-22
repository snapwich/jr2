// The deck's server: static files, plus the two routes that let a slide drive the tmux session the
// audience is watching.
//
// `POST /step/:id` runs a rehearsed command. A slide does not own its command text — `demo.json`
// does (read fresh per request, so editing it needs no restart) — and the route takes the step's ID,
// not a command string, so what a slide can fire is a fixed list you can read before the talk.
//
// `POST /keys` forwards ONE keystroke. It exists because the terminal is a cross-origin iframe and
// xterm.js only takes the caret from a real click: the deck cannot hand it the keyboard, so instead
// the deck KEEPS the keyboard and retypes what it hears here. That makes this route arbitrary text
// into a shell — which is why the server binds loopback: reaching it already means running as this
// user on this laptop, and anything that can do that has a shell without asking the deck.

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.JR2_DECK_PORT ?? 9000);
/** The tmux session the deck types into — `npm start` creates it with exactly one pane. */
const SESSION = process.env.JR2_TMUX_SESSION ?? "intro";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** What the pane is running right now. A plain shell name means it is idle at a prompt. */
const SHELLS = new Set(["zsh", "bash", "sh", "fish"]);

/**
 * The pane to type into, resolved per request — and resolved in exactly this order, because tmux is
 * generous in three ways that all end with keystrokes in a shell nobody was looking at:
 *
 * - `-t intro` PREFIX-matches, so it will happily hit a session called `introspection`.
 * - `-t=intro` is exact for a session, but is not valid as a PANE target.
 * - `list-panes -t=<absent>` does not fail; it falls back to the current session's pane.
 *
 * So: prove the session exists with `has-session -t=` (the one form that errors), then take its
 * pane's own id (`%12`), which is globally unique and matches nothing else.
 */
async function resolvePane() {
  await exec("tmux", ["has-session", "-t=" + SESSION]);
  const { stdout } = await exec("tmux", ["list-panes", "-t=" + SESSION, "-f", "#{pane_active}", "-F", "#{pane_id}"]);
  const pane = stdout.trim().split("\n")[0];
  if (!pane.startsWith("%")) throw new Error(`session "${SESSION}" reported no pane`);
  return pane;
}

async function paneCommand(pane) {
  const { stdout } = await exec("tmux", ["display-message", "-p", "-t", pane, "#{pane_current_command}"]);
  return stdout.trim();
}

async function sendKeys(pane, text) {
  // `-l` sends the text literally: without it tmux reads words like `Enter` or `C-c` inside a
  // command as key names. Enter is then its own send, as a key.
  await exec("tmux", ["send-keys", "-t", pane, "-l", text]);
  await exec("tmux", ["send-keys", "-t", pane, "Enter"]);
}

/**
 * Keystrokes the deck forwards as tmux KEY NAMES. Everything else a key can be goes literally, so
 * this list is only what tmux would otherwise have to guess at — and it is a list, not a passthrough,
 * because `send-keys` without `-l` reads its argument as a key EXPRESSION.
 */
const KEY_NAMES = new Set([
  "Enter",
  "Escape",
  "Tab",
  "BSpace",
  "Space",
  "Up",
  "Down",
  "Left",
  "Right",
  "Home",
  "End",
  "PPage",
  "NPage",
  "DC",
  "IC",
]);
/** One modifier and one key: `C-c`, `M-b`. */
const MODIFIED = /^[CM]-[A-Za-z0-9]$/;

/**
 * Retype one keystroke into the pane. No Enter of its own and no busy guard: this IS the presenter
 * typing, so an interactive program in the pane is a destination, not an obstacle.
 */
async function type(payload) {
  let pane;
  try {
    pane = await resolvePane();
  } catch {
    return { status: 503, body: { error: `no tmux session "${SESSION}" — run \`npm start\`` } };
  }
  const { literal, key } = payload ?? {};
  if (typeof literal === "string" && literal.length > 0) {
    await exec("tmux", ["send-keys", "-t", pane, "-l", literal]);
    return { status: 200, body: { sent: literal } };
  }
  if (typeof key === "string" && (KEY_NAMES.has(key) || MODIFIED.test(key))) {
    await exec("tmux", ["send-keys", "-t", pane, key]);
    return { status: 200, body: { sent: key } };
  }
  return { status: 400, body: { error: "send a `literal` string or one known `key`" } };
}

/** The request body, capped: a keystroke is small, and this port answers whatever reaches it. */
async function body(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 4096) throw new Error("body too large");
  }
  return text === "" ? {} : JSON.parse(text);
}

async function fire(id) {
  const { steps } = JSON.parse(await readFile(join(ROOT, "demo.json"), "utf8"));
  const step = steps[id];
  if (!step) return { status: 404, body: { error: `no step "${id}" in demo.json` } };

  let pane, running;
  try {
    pane = await resolvePane();
    running = await paneCommand(pane);
  } catch {
    return { status: 503, body: { error: `no tmux session "${SESSION}" — run \`npm start\`` } };
  }
  const busy = !SHELLS.has(running);
  if (busy && step.interrupt !== true) {
    return { status: 409, body: { error: `pane busy (${running}) — it is running something, or you are typing` } };
  }
  if (busy) {
    await exec("tmux", ["send-keys", "-t", pane, "C-c"]);
    await new Promise((r) => setTimeout(r, 300));
  }
  await sendKeys(pane, step.cmd);
  return { status: 200, body: { fired: id, cmd: step.cmd, pane, interrupted: busy } };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Resolve a request path inside ROOT, or null if it climbs out of it. */
function localPath(urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = resolve(ROOT, "." + sep + rel);
  return full === ROOT || full.startsWith(ROOT + sep) ? full : null;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    const step = url.pathname.match(/^\/step\/([\w.-]+)$/);
    if (step) {
      if (req.method !== "POST") return json(res, 405, { error: "POST" });
      const { status, body } = await fire(step[1]);
      return json(res, status, body);
    }

    if (url.pathname === "/keys") {
      if (req.method !== "POST") return json(res, 405, { error: "POST" });
      const { status, body: out } = await type(await body(req));
      return json(res, status, out);
    }

    const path = localPath(url.pathname === "/" ? "/index.html" : url.pathname);
    if (!path) return json(res, 403, { error: "outside the deck" });
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return json(res, 404, { error: `no ${url.pathname}` });
    res.writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(path).pipe(res);
  } catch (err) {
    json(res, 500, { error: String(err?.message ?? err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`deck      http://localhost:${PORT}  (tmux session: ${SESSION})\n`);
});
