// The nav: breadcrumb (the address, made clickable), the Machine's id, the zoom controls, the
// fleet-wide attention badge, the feed state, and the token box (ADR-0032). The token INPUT is
// uncontrolled — its value is the reader's secret, never state — seeded once from sessionStorage
// and committed on the change event; the store carries only the token's STATE, which is what the
// badge renders.

import { h, type JSX } from "preact";
import { gateCount, type Store, type TokenState } from "../store.ts";
import type { AppApi } from "./app.ts";

const TOKEN_BADGES: Record<TokenState, string> = { none: "", checking: "…", live: "live", invalid: "invalid" };

export function Nav(props: {
  store: Store;
  machineId: string | null;
  zoomPct: number;
  initialToken: string;
  onChooseTab: (tab: "attention") => void;
  api: AppApi;
}): JSX.Element {
  const { store, machineId, zoomPct, initialToken, onChooseTab, api } = props;
  const connection = store.workflow ? store.connection : "idle";
  const count = gateCount(store);
  return h(
    "header",
    null,
    h(
      "nav",
      { id: "breadcrumb" },
      h(
        "a",
        {
          id: "crumb-root",
          href: "/",
          title: "the fleet",
          onClick: (e: Event) => {
            e.preventDefault();
            void api.selectWorkflow(null, { push: true });
          },
        },
        h("span", { class: "mark" }, "j2"),
      ),
      h("span", { id: "crumb-sep", class: "dim", hidden: !store.workflow }, "/"),
      h("h1", { id: "workflow-name" }, store.workflow ?? ""),
    ),
    h("span", { id: "machine-id", class: "dim" }, machineId ? `machine: ${machineId}` : ""),
    h(
      "div",
      { class: "zoom" },
      h("button", { id: "zoom-out", title: "zoom out", onClick: () => api.zoomOut() }, "−"),
      h("button", { id: "zoom-reset", title: "reset zoom", onClick: () => api.zoomReset() }, `${zoomPct}%`),
      h("button", { id: "zoom-in", title: "zoom in", onClick: () => api.zoomIn() }, "+"),
      h("button", { id: "zoom-fit", title: "fit to width", onClick: () => api.zoomFit() }, "fit"),
    ),
    h(
      "button",
      {
        id: "attention-badge",
        hidden: store.token !== "live" || count === 0,
        title: "open gates across the fleet",
        onClick: () => onChooseTab("attention"),
      },
      "⚑ ",
      h("span", { id: "attention-count" }, String(count)),
    ),
    h("span", { id: "connection", class: `conn conn--${connection}`, title: "feed connection" }, connection),
    h(
      "label",
      { id: "token-box", title: "Instance token — unlocks start & gates (ADR-0032)" },
      h("input", {
        id: "token",
        type: "password",
        placeholder: "instance token",
        autocomplete: "off",
        defaultValue: initialToken,
        onChange: (e: Event) => api.setToken((e.currentTarget as HTMLInputElement).value.trim()),
      }),
      h("span", { id: "token-state", class: `token-state token-state--${store.token}` }, TOKEN_BADGES[store.token]),
    ),
  );
}
