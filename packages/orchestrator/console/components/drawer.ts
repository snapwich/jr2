// The drawer: Attention (the gate inbox) + Activity (the emit log). The Attention tab is there only
// for a Caller with `answer` on some Workflow (ADR-0032, ADR-0078) — without it the page is the
// observer band of ADR-0014 — and a card is only ever a fact that `GET /gates` stated: it empties
// when the server's next answer leaves it out, never through bookkeeping on this side.

import { h, type JSX } from "preact";
import { may, visibleGates, type GateCard, type Store } from "../store.ts";
import { SchemaForm } from "./schema-form.ts";
import type { AppApi } from "./app.ts";

/** Which tab the reader last chose. View state like the zoom, not belief — the store's `token`
 *  decides whether Attention exists at all. */
export type DrawerTab = "attention" | "activity";

export function Drawer(props: {
  store: Store;
  chosenTab: DrawerTab;
  onChooseTab: (tab: DrawerTab) => void;
  api: AppApi;
}): JSX.Element {
  const { store, chosenTab, onChooseTab, api } = props;
  const unlocked = may(store, "answer");
  const tab = unlocked ? chosenTab : "activity"; // no `answer`: no Attention tab — the observer's drawer
  return h(
    "aside",
    { id: "drawer" },
    h(
      "div",
      { class: "drawer-tabs" },
      h(
        "button",
        {
          id: "tab-attention",
          hidden: !unlocked,
          class: tab === "attention" ? "tab--active" : "",
          onClick: () => onChooseTab("attention"),
        },
        "Attention",
      ),
      h(
        "button",
        { id: "tab-activity", class: tab === "activity" ? "tab--active" : "", onClick: () => onChooseTab("activity") },
        "Activity",
      ),
    ),
    h(
      "div",
      { id: "attention-panel", hidden: tab !== "attention" },
      h(
        "label",
        { class: "inbox-scope" },
        h("input", {
          id: "inbox-all",
          type: "checkbox",
          checked: store.inboxAll,
          onChange: (e: Event) =>
            api.dispatch({ kind: "inboxScope", all: (e.currentTarget as HTMLInputElement).checked }),
        }),
        " all workflows",
      ),
      h("ul", { id: "gate-inbox" }, inbox(store, api)),
    ),
    h("div", { id: "activity-panel", hidden: tab !== "activity" }, h("ul", { id: "emit-log" }, activity(store))),
  );
}

function inbox(store: Store, api: AppApi): JSX.Element | JSX.Element[] {
  const cards = visibleGates(store);
  if (!cards.length) {
    return h(
      "li",
      { class: "empty" },
      store.inboxAll || !store.workflow ? "no gates waiting" : "no gates waiting here",
    );
  }
  return cards.flatMap(({ runId, workflow, gates }) =>
    gates.map((view) => inboxCard(runId, workflow, view, store, api)),
  );
}

/** One parked decision: meta to read, one form per accepted event (the shared ADR-0033 form). */
function inboxCard(runId: string, workflow: string, view: GateCard, store: Store, api: AppApi): JSX.Element {
  return h(
    "li",
    { key: `${runId}/${view.gate}`, class: "gate-card" },
    h(
      "div",
      {
        class: "gate-head",
        title: "show this run",
        onClick: () => {
          if (workflow === store.workflow) api.dispatch({ kind: "selectRun", runId });
          else void api.selectWorkflow(workflow, { push: true, runId });
        },
      },
      h("span", { class: "gate-id" }, `⚑ ${view.gate}`),
      h("span", { class: "dim" }, `${workflow} · ${runId.slice(0, 8)}`),
      view.openedAt
        ? h(
            "span",
            { class: "dim", title: view.openedAt },
            ` · open since ${new Date(view.openedAt).toLocaleTimeString()}`,
          )
        : null,
    ),
    view.meta && Object.keys(view.meta).length
      ? h(
          "dl",
          { class: "gate-meta" },
          Object.entries(view.meta).flatMap(([k, v]) => [
            h("dt", { key: `t:${k}` }, k),
            h("dd", { key: `d:${k}` }, typeof v === "string" ? v : JSON.stringify(v)),
          ]),
        )
      : null,
    view.accepts.map((accepted) =>
      h(
        "div",
        { key: accepted.name, class: "gate-event" },
        h("div", { class: "gate-event-name", title: accepted.description }, accepted.name),
        h(SchemaForm, {
          schema: accepted.input,
          submitLabel: "send",
          // Deliberately NO local bookkeeping on success: the delivery moves the Machine, the move
          // lands a frame, the frame triggers the re-fetch, and the re-fetch empties this card
          // (ADR-0032) — `deliverGate` concludes nothing on its own.
          onSubmit: (body) => api.deliverGate(runId, view.gate, accepted.name, body),
        }),
      ),
    ),
  );
}

function activity(store: Store): JSX.Element | JSX.Element[] {
  if (!store.emits.length) return h("li", { class: "empty" }, "no emits yet");
  return store.emits.map((emitted) =>
    h("li", null, emitted.type, h("span", { class: "dim" }, emitted.runId.slice(0, 8))),
  );
}
