// The bottom drawer (ADR-0032, ADR-0023): the selected run's kept conversations, full width across
// the bottom of the page. Closed, it is a bar of tabs, one for each Agent slot of the run,
// with a dot on a slot whose Turn is open. Open, it shows the chosen slot's conversation and follows
// a live Turn: the model's words, each tool call folded with its answer, the picks, the Steering
// messages, the notices, the refusals, and the cut and swept marks. The Steering box is beside it,
// for a Caller with `steer` on a live run.
//
// The entries are store belief (main.ts reads them); the height is the viewer's own, kept in
// localStorage (a per-viewer convenience — the page works the same without it).

import { h, type JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { activeSlot, may, slotConversations, slotTabs, type SlotConversation, type Store } from "../store.ts";
import { foldEntries, type ConversationItem } from "../conversation.ts";
import type { AppApi } from "./app.ts";

const HEIGHT_KEY = "jr2.console.bottom.height";
const HEIGHT_DEFAULT = 300;
const HEIGHT_MIN = 120;

function storedHeight(): number {
  try {
    const value = Number(localStorage.getItem(HEIGHT_KEY));
    const kept = Number.isFinite(value) && value >= HEIGHT_MIN ? value : HEIGHT_DEFAULT;
    // A height kept on a taller window must leave room for the Machine on this one.
    return Math.min(kept, maxHeight());
  } catch {
    return HEIGHT_DEFAULT;
  }
}

/** The tallest the drawer goes: the Machine keeps at least 160px. */
function maxHeight(): number {
  return Math.max(HEIGHT_MIN, window.innerHeight - 160);
}

function keepHeight(height: number): void {
  try {
    localStorage.setItem(HEIGHT_KEY, String(Math.round(height)));
  } catch {
    // no storage (a private window, or blocked): the height lasts for this page only
  }
}

export function BottomDrawer(props: { store: Store; api: AppApi }): JSX.Element | null {
  const { store, api } = props;
  const [height, setHeight] = useState(storedHeight);
  const run = store.selectedRunId;
  const workflow = store.workflow;
  const live = run !== null && store.runs.has(run);
  const canRead = workflow !== null && may(store, "read", workflow);
  const canSteer = live && workflow !== null && may(store, "steer", workflow);
  // The observer's page has no conversation to show and no Agent to steer (ADR-0014).
  if (run === null || (!canRead && !canSteer)) return null;

  const tabs = slotTabs(store);
  const slot = activeSlot(store);
  const open = store.bottom.open;
  const tab = tabs.find((t) => t.slot === slot);

  const startResize = (e: PointerEvent): void => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = height;
    let last = startHeight;
    const move = (ev: PointerEvent): void => {
      last = Math.min(maxHeight(), Math.max(HEIGHT_MIN, startHeight + (startY - ev.clientY)));
      setHeight(last);
    };
    const up = (): void => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      keepHeight(last);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };

  return h(
    "section",
    {
      id: "bottom-drawer",
      class: open ? "bottom--open" : "",
      style: open ? { height: `${Math.min(height, maxHeight())}px` } : undefined,
    },
    open ? h("div", { class: "bottom-resize", title: "drag to change the height", onPointerDown: startResize }) : null,
    h(
      "div",
      { class: "bottom-tabs" },
      h(
        "button",
        {
          id: "bottom-toggle",
          title: open ? "close the conversations" : "open the conversations",
          onClick: () => api.dispatch({ kind: "bottom", open: !open }),
        },
        open ? "▾" : "▴",
      ),
      h("span", { class: "bottom-title" }, "Conversations"),
      tabs.length
        ? tabs.map((t) =>
            h(
              "button",
              {
                key: t.slot,
                class: `slot-tab${t.slot === slot ? " tab--active" : ""}`,
                title: t.open ? `${t.slot}: a Turn is open` : t.slot,
                onClick: () => api.dispatch({ kind: "bottom", open: true, slot: t.slot }),
              },
              t.open ? h("span", { class: "live-dot" }) : null,
              t.slot,
            ),
          )
        : h("span", { class: "dim" }, canRead ? "no Agent has a conversation in this run yet" : ""),
    ),
    open
      ? h(
          "div",
          { class: "bottom-body" },
          h(
            "div",
            { class: "conversation-pane" },
            canRead
              ? h(Conversation, { key: `${run}/${slot ?? ""}`, conversations: slotConversations(store, slot) })
              : h("div", { class: "dim" }, "to read a conversation, the Caller needs the read scope"),
          ),
          canSteer && slot !== null
            ? h(SteeringBox, { key: `${run}/${slot}`, runId: run, slot, steerable: tab?.steerable ?? false, api })
            : null,
        )
      : null,
  );
}

/** One slot's conversations, the first first. It stays at the end while the reader is at the end,
 *  so a live Turn is followed; a reader who scrolls up stays where they are. */
function Conversation(props: { conversations: SlotConversation[] }): JSX.Element {
  const { conversations } = props;
  const ref = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const count = conversations.reduce((n, c) => n + c.entries.length, 0);
  useEffect(() => {
    const el = ref.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [count]);
  const onScroll = (): void => {
    const el = ref.current;
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  return h(
    "div",
    { id: "conversation", ref, onScroll },
    conversations.length
      ? conversations.map((c) => conversationBlock(c))
      : h("div", { class: "dim" }, "this Agent has no kept conversation yet"),
  );
}

function conversationBlock(c: SlotConversation): JSX.Element {
  const { row, entries, ended } = c;
  const swept = row.swept ?? ended?.swept;
  const cut = (row.cut || ended?.cut) && !entries.some((e) => e.kind === "cut");
  return h(
    "div",
    { key: row.instanceId, class: "conversation-block" },
    h("div", { class: "conversation-head dim" }, `${row.agent} · ${row.instanceId}${row.open ? " · Turn open" : ""}`),
    swept ? h("div", { class: "conv-mark conv-swept" }, `conversation swept: ${swept}`) : null,
    foldEntries(entries).map((item, i) => itemView(item, i)),
    cut ? h("div", { class: "conv-mark conv-cut" }, "cut: the conversation reached its size limit") : null,
  );
}

/** The first line of a text, short, for a folded item's summary. */
function firstLine(text: string, max = 120): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function itemView(item: ConversationItem, i: number): JSX.Element {
  switch (item.type) {
    case "text":
      return h("div", { key: i, class: "conv-text" }, item.text);
    case "thinking":
      return h(
        "details",
        { key: i, class: "conv-thinking" },
        h("summary", null, h("span", { class: "conv-label" }, "thinking"), ` ${firstLine(item.text)}`),
        h("div", { class: "conv-body" }, item.text),
      );
    case "prompt":
    case "notice":
    case "steering":
      return h(
        "details",
        { key: i, class: `conv-${item.type}`, open: item.type !== "prompt" },
        h("summary", null, h("span", { class: "conv-label" }, item.type), ` ${firstLine(item.text)}`),
        h("div", { class: "conv-body" }, item.text),
      );
    case "call": {
      const result = item.result;
      const label = result ? (result.error ? "refused" : "pick") : "tool";
      return h(
        "details",
        { key: i, class: `conv-call${result?.error ? " conv-refused" : ""}` },
        h(
          "summary",
          null,
          h("span", { class: "conv-label" }, label),
          ` ${item.tool}`,
          item.input ? h("span", { class: "dim" }, ` ${firstLine(item.input, 100)}`) : null,
        ),
        item.input ? h("div", { class: "conv-body" }, item.input) : null,
        result ? h("div", { class: "conv-body conv-answer" }, result.text) : null,
      );
    }
    default:
      return h(
        "div",
        { key: i, class: `conv-mark conv-${item.type}` },
        item.label ? `${item.label}: ${item.text}` : item.text,
      );
  }
}

/**
 * The Steering box (ADR-0002) beside the slot it steers. What the person types is theirs
 * (uncontrolled), and a refusal shows where they typed. A slot that the run says is not steerable
 * shows the box and cannot send.
 */
function SteeringBox(props: { runId: string; slot: string; steerable: boolean; api: AppApi }): JSX.Element {
  const { runId, slot, steerable, api } = props;
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = (e: Event): void => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const area = form.elements.namedItem("text") as HTMLTextAreaElement | null;
    const text = area?.value.trim() ?? "";
    if (!text) return setNote("write the message");
    setBusy(true);
    setNote(null);
    void api.steer(runId, slot, text).then((failure) => {
      setBusy(false);
      if (failure) return setNote(`not sent: ${failure}`);
      if (area) area.value = "";
      setNote(`sent to ${slot}: it reads the message at its next step`);
    });
  };
  return h(
    "form",
    { id: "steering-box", class: "schema-form steering-box", onSubmit: send },
    h("div", { class: "dim" }, steerable ? `steer ${slot}` : `${slot} cannot be steered now`),
    h("textarea", { name: "text", rows: 4, disabled: !steerable }),
    h("button", { type: "submit", disabled: busy || !steerable }, "send"),
    h("div", { class: note?.startsWith("sent to ") ? "dim" : "form-error", hidden: note === null }, note ?? ""),
  );
}
