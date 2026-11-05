// The nav: breadcrumb (the address, made clickable), the Machine's id, the zoom controls, the
// fleet-wide attention badge, the feed state, and the credential box (ADR-0032). The token INPUT is
// uncontrolled — its value is the reader's secret, never state — seeded once from sessionStorage
// and committed on the change event; the store carries only the token's STATE, which is what the
// badge renders, and the Caller that `GET /whoami` said it is.
//
// With no live credential the box offers the field and a login button for each issuer the Instance
// declares for a login. With one, it shows who the page acts as (its scopes in the title) and a
// sign-out button in place of the field.

import { h, type JSX } from "preact";
import { useRef } from "preact/hooks";
import { callerLabel, callerScopes, gateCount, may, type Store, type TokenState } from "../store.ts";
import type { LoginIssuer } from "../login.ts";
import type { AppApi } from "./app.ts";

const TOKEN_BADGES: Record<TokenState, string> = { none: "", checking: "…", live: "live", invalid: "invalid" };

export function Nav(props: {
  store: Store;
  machineId: string | null;
  zoomPct: number;
  initialToken: string;
  logins: readonly LoginIssuer[];
  loginNote: string | null;
  onChooseTab: (tab: "attention") => void;
  api: AppApi;
}): JSX.Element {
  const { store, machineId, zoomPct, initialToken, logins, loginNote, onChooseTab, api } = props;
  const field = useRef<HTMLInputElement>(null);
  const actingAs = callerLabel(store);
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
        h("span", { class: "mark" }, "jr2"),
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
      h("button", { id: "zoom-fit", title: "fit the whole Machine", onClick: () => api.zoomFit() }, "fit"),
    ),
    h(
      "button",
      {
        id: "attention-badge",
        hidden: !may(store, "answer") || count === 0,
        title: "open gates across the fleet",
        onClick: () => onChooseTab("attention"),
      },
      "⚑ ",
      h("span", { id: "attention-count" }, String(count)),
    ),
    h("span", { id: "connection", class: `conn conn--${connection}`, title: "feed connection" }, connection),
    h(
      "div",
      { id: "token-box" },
      h(
        "span",
        { id: "caller", hidden: actingAs === null, title: callerScopes(store.caller) },
        actingAs === null ? "" : `as ${actingAs}`,
      ),
      h(
        "button",
        {
          id: "sign-out",
          hidden: actingAs === null,
          title: "forget the credential: the page goes back to observer",
          onClick: () => {
            if (field.current) field.current.value = "";
            api.setToken("");
          },
        },
        "sign out",
      ),
      h("input", {
        id: "token",
        ref: field,
        type: "password",
        hidden: actingAs !== null,
        placeholder: "Caller token",
        title: "a Caller's token — unlocks what its scopes allow (ADR-0032)",
        autocomplete: "off",
        defaultValue: initialToken,
        onChange: (e: Event) => api.setToken((e.currentTarget as HTMLInputElement).value.trim()),
      }),
      actingAs === null
        ? logins.map((issuer) =>
            h(
              "button",
              {
                key: issuer.issuer,
                class: "login",
                title: `log in at ${issuer.issuer}`,
                onClick: () => api.login(issuer),
              },
              logins.length === 1 ? "log in" : `log in · ${new URL(issuer.issuer).host}`,
            ),
          )
        : null,
      h("span", { id: "token-state", class: `token-state token-state--${store.token}` }, TOKEN_BADGES[store.token]),
      h("span", { id: "login-note", hidden: loginNote === null, title: loginNote ?? "" }, loginNote ?? ""),
    ),
  );
}
