// A Sandbox's objects on the Fence (ADR-0084, ADR-0059): what the Orchestrator writes for a Sandbox
// whose pod has no network but its slot's VLAN, and what its CR gains for it. Pure: no I/O.
//
//   jr2-custodian-slot-<i>   Secret, owned by the CR: the slot's spec (its Sandbox, its held
//                            manifest, its placeholder table), the control token and its Stand-in,
//                            the fetch token, each held secret's Stand-in, and a leaf of the
//                            Sandbox's CA for each Intercepted host and for jr2's own name. The
//                            Custodian's control process reads it (`custodian-slot.ts`); the
//                            Orchestrator writes it and never reads it. No Harness pod mounts it.
//   <sandbox>-trust          ConfigMap, owned by the CR: `extra.crt` (`caBundle` + the Sandbox's CA)
//                            and `bundle.crt` (the Instance's `upstream.crt` + the Sandbox's CA).
//                            The CA's certificate is the only part of the PKI that the pod gets.
//   <sandbox>-standins       Secret, owned by the CR: the secret control Stand-in and each held
//                            secret's Stand-in, which the Harness container reads as files under
//                            `/run/jr2/`, and the Stand-in of each secret that the Custodian holds
//                            for the Sandbox Effector, which only the Effector's container mounts
//                            (ADR-0068). No token and no value. A push token's Stand-in is the
//                            entry's, in its push Secret (`gitPushStandIn`), and is not here.
//
// The Sandbox's CA is made here (`sandboxPki`) and its key goes with the call: no object holds it,
// so no key that can sign a leaf for the Sandbox exists while its Agents run.
//
// `fenceComposition` is what the CR gains on the Fence, in place of the in-pod Custodian: the
// attachment and the nameserver of its slot (`spec.network`), the Harness container's env and its
// mounts. No Custodian container, no proxy variable and no control socket: the Custodian is at
// jr2's own name, outside the pod.
//
// `podFenceObjects` gives the same three objects for a Harness pod that `jr2 up` makes (the
// Instance Harness on slot 0, the check pod on slot 1), with leaves of the Instance's CA and no
// owner, and `fencePodNetwork` the pod-level part that the operator writes for a Sandbox.

import type { HarnessEnvVar } from "./config.ts";
import {
  CA_MOUNT,
  CONTROL_STANDIN_FILE,
  CONTROL_STANDIN_FILE_ENV,
  CREDENTIAL_KEYS,
  GRANTED_SECRETS_ENV,
  HARNESS_CREDENTIALS,
  HARNESS_CREDENTIALS_VOLUME,
  heldStandInKey,
  JR2_CUSTODIAN_NAME,
  standInValueFile,
} from "./custodian.ts";
import { slotAddress } from "./custodian-rules.ts";
import { slotSecretData, type SlotSpec } from "./custodian-slot.ts";
import { isIP } from "node:net";
import { uncarried, type EgressMatch, type EgressRule, type FenceRanges, type HostPort } from "./egress.ts";
import {
  CONTROL_TOKEN_NAME,
  gitPushStandIn,
  heldStandIn,
  leafStem,
  pushBindingName,
  SANDBOX_TOKEN_NAME,
  type HeldBinding,
  type HeldManifest,
} from "./held-secrets.ts";
import type { KubeObject } from "./kube-client.ts";
import {
  CA_CONFIGMAP,
  custodianSlotSecret,
  fenceSlotAttachment,
  LABEL_FENCE_SLOT,
  sandboxStandInSecret,
  sandboxTrustConfigMap,
} from "./names.ts";
import { sandboxPki, type Pem } from "./pki.ts";
import { checkAppendOnly, emptyPlaceholders, withPlaceholders, type PlaceholderTable } from "./placeholders.ts";
import { controlStandIn, controlToken, sandboxToken } from "./tokens.ts";

/** The Custodian's address as a Harness on the Fence calls it (ADR-0059): HTTPS at jr2's own name. */
export const FENCE_CUSTODIAN_URL = `https://${JR2_CUSTODIAN_NAME}`;

/** A binding's Stand-in in a Sandbox (ADR-0059, ADR-0068): a push token's is its entry's, minted
 * from the push Secret's name; each other one is the Sandbox's own. */
function standInOf(signingKey: Buffer, pod: string, s: HeldBinding): string {
  if (s.push && s.source.kind === "secret") return gitPushStandIn(signingKey, s.source.secret);
  return heldStandIn(signingKey, pod, s.name);
}

/** One token push of a Sandbox, as the provision resolved it: the push Secret of the entry that
 * the slot's url matches, and the url's host and port. */
export type PushToken = { secret: string; host: string; port: number };

/**
 * A Sandbox's held manifest with the token of each of its pushes over HTTPS (ADR-0068, ADR-0051):
 * a binding that the Custodian holds for the Sandbox Effector, whose value is the `token` key of the
 * entry's push Secret and which rides Basic, toward the url's host, which is then an Intercepted
 * host of the Sandbox. The provision adds it, because only the provision knows the url of a slot that
 * the run or a `customize()` binds. Throws when the Fence cannot carry the host. Pure: the manifest
 * given is not changed.
 */
export function withPushTokens(
  manifest: HeldManifest,
  pushes: readonly PushToken[],
  ranges: FenceRanges,
): HeldManifest {
  if (pushes.length === 0) return manifest;
  const secrets = manifest.secrets.map((s) => ({ ...s, hosts: [...s.hosts] }));
  const egress = manifest.egress.map((r) => ({ ...r, from: [...r.from] }));
  for (const p of pushes) {
    const why = uncarried(p.host, ranges);
    if (why !== undefined) {
      throw new Error(`the push to ${p.host}:${p.port} cannot go through the Fence: the host ${why} (ADR-0084)`);
    }
    const host = { host: p.host, port: p.port, leaf: leafStem(p.host, p.port) };
    const name = pushBindingName(p.secret);
    const known = secrets.find((s) => s.name === name);
    if (known === undefined) {
      secrets.push({
        name,
        source: { kind: "secret", secret: p.secret, key: "token" },
        hosts: [host],
        headers: ["authorization"],
        holder: "effector",
        basic: true,
        push: true,
      });
    } else if (!known.hosts.some((h) => h.host === p.host && h.port === p.port)) known.hosts.push(host);
    const match: EgressMatch = isIP(p.host) === 0 ? "name" : "address";
    const rule = egress.find((r) => r.match === match && r.host === p.host && r.port === p.port);
    if (rule === undefined) egress.push({ host: p.host, port: p.port, match, intercept: true, from: ["effector"] });
    else {
      rule.intercept = true;
      if (!rule.from.includes("effector")) rule.from.push("effector");
    }
  }
  const order: Record<EgressMatch, number> = { name: 0, address: 1, below: 2, any: 3 };
  egress.sort(
    (a: EgressRule, b: EgressRule) =>
      order[a.match] - order[b.match] || a.host.localeCompare(b.host) || a.port - b.port,
  );
  return { ...manifest, secrets, egress };
}

/** The TLS targets of a pod whose Custodian ends TLS with a leaf of the pod's CA: jr2's own name on
 * port 443, then each Intercepted rule of its manifest on a port other than 80 (port 80 of an
 * Intercepted host is plain HTTP, with no leaf). Each target once. */
export function leafTargets(manifest: HeldManifest): HostPort[] {
  const out: HostPort[] = [{ host: JR2_CUSTODIAN_NAME, port: 443 }];
  for (const r of manifest.egress) {
    if (!r.intercept || r.port === 80) continue;
    if (!out.some((t) => t.host === r.host && t.port === r.port)) out.push({ host: r.host, port: r.port });
  }
  return out;
}

export type SandboxFenceInput = {
  namespace: string;
  sandbox: string;
  /** The uid of the Sandbox CR, which owns each object. */
  uid: string;
  slot: number;
  /** The pod's held manifest, as `jr2 up` placed it (`readHeldManifest`). */
  manifest: HeldManifest;
  /** The pod whose `jr2-held-secrets-<pod>` holds its literal values (`workspaceHeldPod`). The slot
   * spec names it only when the manifest holds a literal. */
  heldPod: string;
  /** The Sandbox's placeholder table before this write, if its slot Secret had one: its rows stay at
   * their addresses, and each new name gets the next address (append-only, ADR-0084). */
  placeholders?: PlaceholderTable;
  ranges: FenceRanges;
  signingKey: Buffer;
  /** The user's `harness.caBundle` (ADR-0020), trusted beside the Sandbox's CA. */
  caBundle?: string;
  /** The text of the Instance's `upstream.crt` (ADR-0020): the roots of the Node that ran `jr2 up`,
   * and `caBundle`. `bundle.crt` is this and the Sandbox's CA, so a Sandbox trusts the same roots
   * as the Instance Harness, whatever Node runs the Orchestrator. */
  upstream: string;
  now?: Date;
};

/** The three objects of a Sandbox on the Fence, and the placeholder table that its slot Secret holds. */
type Written = KubeObject & { type?: string; data: Record<string, string> };

export type SandboxFenceObjects = {
  slotSecret: Written;
  trust: Written;
  standIns: Written;
  placeholders: PlaceholderTable;
};

const base64Values = (values: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Buffer.from(v).toString("base64")]));

/**
 * A Sandbox's slot Secret, trust ConfigMap and Stand-in Secret (above), each owned by its CR. Each
 * call makes a new CA and new leaves, so a write of these objects for a pod that runs must keep the
 * CA that the pod trusts. The `data` of each Secret is base64, as a server-side apply owns it; the
 * `data` of the ConfigMap is plain text.
 */
export function sandboxFenceObjects(input: SandboxFenceInput): SandboxFenceObjects {
  const { namespace, sandbox, slot, manifest, signingKey } = input;
  const prev = input.placeholders;
  if (prev !== undefined && prev.range !== input.ranges.placeholders) {
    throw new Error(
      `Sandbox "${sandbox}": its placeholder table is of ${prev.range}, not the Instance's ${input.ranges.placeholders} (ADR-0084)`,
    );
  }
  const placeholders = withPlaceholders(prev ?? emptyPlaceholders(input.ranges.placeholders), manifest.egress);
  checkAppendOnly(prev, placeholders);

  const targets = leafTargets(manifest);
  const pki = sandboxPki(
    sandbox,
    targets.map((t) => t.host),
    input.now,
  );
  const files = new Map<string, string>([
    [`values/${CONTROL_TOKEN_NAME}`, controlToken(signingKey, sandbox)],
    [`values/${standInValueFile(CONTROL_TOKEN_NAME)}`, controlStandIn(signingKey, sandbox)],
    [`values/${SANDBOX_TOKEN_NAME}`, sandboxToken(signingKey, sandbox)],
    ...manifest.secrets.map(
      (s) => [`values/${standInValueFile(s.name)}`, standInOf(signingKey, sandbox, s)] as [string, string],
    ),
  ]);
  for (const { host, port } of targets) {
    const leaf = pki.leaves.get(host.toLowerCase());
    if (leaf === undefined) throw new Error(`Sandbox "${sandbox}": no leaf was issued for ${host}`);
    files.set(`tls/${leafStem(host, port)}.crt`, leaf.cert);
    files.set(`tls/${leafStem(host, port)}.key`, leaf.key);
  }
  const literal = manifest.secrets.some((s) => s.source.kind === "literal");
  const spec: SlotSpec = {
    version: 1,
    owner: { sandbox },
    manifest,
    placeholders,
    ...(literal ? { heldPod: input.heldPod } : {}),
  };

  const metadata = (name: string, labels: Record<string, string> = {}) => ({
    name,
    namespace,
    labels: { "jr2.dev/sandbox": sandbox, ...labels },
    ownerReferences: [
      {
        apiVersion: "core.jr2.dev/v1alpha1",
        kind: "Sandbox",
        name: sandbox,
        uid: input.uid,
        controller: true,
        blockOwnerDeletion: false,
      },
    ],
  });
  const line = (text: string): string => (text === "" || text.endsWith("\n") ? text : `${text}\n`);
  const bundles = { extra: `${line(input.caBundle ?? "")}${pki.ca}`, bundle: `${line(input.upstream)}${pki.ca}` };
  return {
    placeholders,
    slotSecret: {
      apiVersion: "v1",
      kind: "Secret",
      metadata: metadata(custodianSlotSecret(slot), { [LABEL_FENCE_SLOT]: String(slot) }),
      type: "Opaque",
      data: base64Values(slotSecretData(spec, files)),
    },
    trust: {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: metadata(sandboxTrustConfigMap(sandbox)),
      data: { "extra.crt": bundles.extra, "bundle.crt": bundles.bundle },
    },
    standIns: {
      apiVersion: "v1",
      kind: "Secret",
      metadata: metadata(sandboxStandInSecret(sandbox)),
      type: "Opaque",
      data: base64Values({
        [CREDENTIAL_KEYS.controlStandIn]: controlStandIn(signingKey, sandbox),
        ...Object.fromEntries(
          manifest.secrets
            .filter((s) => !s.push)
            .map((s) => [heldStandInKey(s.name), heldStandIn(signingKey, sandbox, s.name)]),
        ),
      }),
    },
  };
}

export type PodFenceInput = {
  namespace: string;
  /** The pod: the slot's owner, and the stem of its trust ConfigMap (`<pod>-trust`) and its Stand-in
   * Secret (`<pod>-standins`). */
  pod: string;
  slot: number;
  /** The pod's held manifest. */
  manifest: HeldManifest;
  /** The key of the pod's secret Stand-ins (`heldStandIn(key, heldPod, name)`), and, when `values` is
   * absent, the pod whose `jr2-held-secrets-<heldPod>` holds its literal values. */
  heldPod: string;
  /** The literal values of the manifest, copied into the slot Secret (a check pod, whose slot Secret
   * `jr2 up` deletes after the check). Absent: the Custodian reads them from `jr2-held-secrets-<heldPod>`. */
  values?: Readonly<Record<string, string>>;
  /** The pod's control token (`controlToken` for its placement, or a value that no one signed). */
  controlToken: string;
  /** The name the control Stand-in is derived for (`controlStandIn`). */
  placement: string;
  /** The leaves of the Instance's CA, by file stem (`leafStem`): one for each of `leafTargets`. */
  leaves: Readonly<Record<string, Pem>>;
  /** The pod's trust files: the Instance's CA after `caBundle` (`extra`), and after `upstream.crt`
   * (`bundle`); and `caBundle` itself (`ca`), when the Instance ships one. */
  trust: { extra: string; bundle: string; ca?: string };
  /** The pod's placeholder table before this write, if its slot Secret had one (append-only). */
  placeholders?: PlaceholderTable;
  ranges: FenceRanges;
  signingKey: Buffer;
  /** The labels of each object. */
  labels: Record<string, string>;
};

/**
 * The slot Secret, trust ConfigMap and Stand-in Secret of a Harness pod that `jr2 up` makes on the
 * Fence (ADR-0084): the Instance Harness on slot 0 and the check pod on slot 1. The same three
 * objects as a Sandbox's (`sandboxFenceObjects`), with two differences: the leaves come from the
 * Instance's CA (`jr2-held-ca`), which `jr2 up` keeps, so a converge that changes nothing writes
 * the same objects; and no CR owns them, so `jr2 up` deletes them with the pod. The pod serves no
 * fetch, so its slot holds no fetch token.
 */
export function podFenceObjects(input: PodFenceInput): SandboxFenceObjects {
  const { namespace, pod, slot, manifest, signingKey } = input;
  const prev = input.placeholders?.range === input.ranges.placeholders ? input.placeholders : undefined;
  const placeholders = withPlaceholders(prev ?? emptyPlaceholders(input.ranges.placeholders), manifest.egress);
  checkAppendOnly(prev, placeholders);
  const files = new Map<string, string>([
    [`values/${CONTROL_TOKEN_NAME}`, input.controlToken],
    [`values/${standInValueFile(CONTROL_TOKEN_NAME)}`, controlStandIn(signingKey, input.placement)],
    ...manifest.secrets.map(
      (s) => [`values/${standInValueFile(s.name)}`, heldStandIn(signingKey, input.heldPod, s.name)] as [string, string],
    ),
  ]);
  for (const { host, port } of leafTargets(manifest)) {
    const leaf = input.leaves[leafStem(host, port)];
    if (leaf === undefined) throw new Error(`pod "${pod}": no leaf of the Instance's CA for ${host}:${port}`);
    files.set(`tls/${leafStem(host, port)}.crt`, leaf.cert);
    files.set(`tls/${leafStem(host, port)}.key`, leaf.key);
  }
  const literals = manifest.secrets.filter((s) => s.source.kind === "literal");
  if (input.values !== undefined) {
    for (const s of literals) {
      const value = input.values[s.name];
      if (value === undefined) throw new Error(`pod "${pod}": no value of the literal held secret ${s.name}`);
      files.set(`values/${s.name}`, value);
    }
  }
  const spec: SlotSpec = {
    version: 1,
    owner: { pod },
    manifest,
    placeholders,
    ...(literals.length > 0 && input.values === undefined ? { heldPod: input.heldPod } : {}),
  };
  const metadata = (name: string, labels: Record<string, string> = {}) => ({
    name,
    namespace,
    labels: { ...input.labels, ...labels },
  });
  return {
    placeholders,
    slotSecret: {
      apiVersion: "v1",
      kind: "Secret",
      metadata: metadata(custodianSlotSecret(slot), { [LABEL_FENCE_SLOT]: String(slot) }),
      type: "Opaque",
      data: base64Values(slotSecretData(spec, files)),
    },
    trust: {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: metadata(sandboxTrustConfigMap(pod)),
      data: {
        "extra.crt": input.trust.extra,
        "bundle.crt": input.trust.bundle,
        ...(input.trust.ca !== undefined ? { "ca.crt": input.trust.ca } : {}),
      },
    },
    standIns: {
      apiVersion: "v1",
      kind: "Secret",
      metadata: metadata(sandboxStandInSecret(pod)),
      type: "Opaque",
      data: base64Values({
        [CREDENTIAL_KEYS.controlStandIn]: controlStandIn(signingKey, input.placement),
        ...Object.fromEntries(
          manifest.secrets.map((s) => [heldStandInKey(s.name), heldStandIn(signingKey, input.heldPod, s.name)]),
        ),
      }),
    },
  };
}

/** The exec probe of a Harness container on the Fence (ADR-0063, ADR-0084): the Effector binary's own
 * GET of the Harness's `/healthz`, bounded at 1 s, because no HTTP probe of the kubelet reaches a pod
 * on the Fence. The operator gives a Sandbox's Harness the same command. */
export function harnessHealthcheck(port: number): string[] {
  return ["/opt/jr2/bin/effector", "healthcheck", `http://127.0.0.1:${port}/healthz`];
}

/** The pod-level part of a pod on the Fence that `jr2 up` makes (ADR-0084), as the operator writes it
 * for a Sandbox: Multus's default network is the slot's attachment, and the one nameserver is the
 * uplink's, with no search domain and `ndots:1`. */
export function fencePodNetwork(
  namespace: string,
  network: FenceComposition["network"],
): {
  annotations: Record<string, string>;
  dnsPolicy: "None";
  dnsConfig: { nameservers: string[]; searches: string[]; options: Array<{ name: string; value: string }> };
} {
  return {
    annotations: { [FENCE_DEFAULT_NETWORK_ANNOTATION]: `${namespace}/${network.attachment}` },
    dnsPolicy: "None",
    dnsConfig: { nameservers: [network.nameserver], searches: [], options: [{ name: "ndots", value: "1" }] },
  };
}

/** Multus's annotation of a pod's default network. */
export const FENCE_DEFAULT_NETWORK_ANNOTATION = "v1.multus-cni.io/default-network";

type Volume = Record<string, unknown>;
type VolumeMount = { name: string; mountPath: string; readOnly?: boolean };

/** What a Sandbox's CR gains on the Fence (ADR-0084), in place of the in-pod Custodian. */
export type FenceComposition = {
  /** The CR's `spec.network`: the slot's attachment, and its one nameserver, the uplink's address. */
  network: { attachment: string; nameserver: string };
  /** The Harness container's env: the Custodian's URL at jr2's own name, the control Stand-in's
   * file, the granted names and the trust variables. No proxy variable and no socket. */
  harnessEnv: HarnessEnvVar[];
  /** The Harness container's mounts: the trust files at `/etc/jr2/ca`, its Stand-ins at `/run/jr2`. */
  harnessMounts: VolumeMount[];
  volumes: Volume[];
};

/** The Harness container's part of a Sandbox on the Fence (above). */
export function fenceComposition(
  manifest: HeldManifest,
  opts: {
    sandbox: string;
    slot: number;
    ranges: FenceRanges;
    /** The held secrets that the `workspace()` grants its confined children; names that the
     * manifest does not hold are left out. */
    granted?: readonly string[];
    /** Whether the Instance ships a `caBundle`: its `ca.crt` joins the trust files. */
    caBundle?: boolean;
    /** The ConfigMap whose `ca.crt` is the `caBundle`. Default `jr2-ca`; a check pod has its own. */
    caBundleFrom?: string;
  },
): FenceComposition {
  // The Harness's own: a secret the Custodian holds for the Sandbox Effector is none of its (ADR-0068).
  const harness = manifest.secrets.filter((s) => s.holder === undefined);
  const held = new Set(harness.map((s) => s.name));
  const granted = (opts.granted ?? []).filter((n) => held.has(n));
  return {
    network: { attachment: fenceSlotAttachment(opts.slot), nameserver: slotAddress(opts.ranges.segment, 1) },
    // Every Harness pod on the Fence ends TLS at jr2's own name under its own CA, so each one gets
    // the trust variables, whether or not it holds a secret. No Stand-in rides env (ADR-0076).
    harnessEnv: [
      { name: "JR2_CUSTODIAN_URL", value: FENCE_CUSTODIAN_URL },
      { name: CONTROL_STANDIN_FILE_ENV, value: CONTROL_STANDIN_FILE },
      ...(granted.length ? [{ name: GRANTED_SECRETS_ENV, value: granted.join(",") }] : []),
      { name: "NODE_EXTRA_CA_CERTS", value: `${CA_MOUNT}/extra.crt` },
      { name: "SSL_CERT_FILE", value: `${CA_MOUNT}/bundle.crt` },
      { name: "REQUESTS_CA_BUNDLE", value: `${CA_MOUNT}/bundle.crt` },
      { name: "GIT_SSL_CAINFO", value: `${CA_MOUNT}/bundle.crt` },
    ],
    harnessMounts: [
      { name: "ca", mountPath: CA_MOUNT, readOnly: true },
      { name: HARNESS_CREDENTIALS_VOLUME, mountPath: HARNESS_CREDENTIALS, readOnly: true },
    ],
    volumes: [
      {
        name: "ca",
        projected: {
          sources: [
            {
              configMap: {
                name: sandboxTrustConfigMap(opts.sandbox),
                items: [
                  { key: "extra.crt", path: "extra.crt" },
                  { key: "bundle.crt", path: "bundle.crt" },
                ],
              },
            },
            ...(opts.caBundle
              ? [
                  {
                    configMap: { name: opts.caBundleFrom ?? CA_CONFIGMAP, items: [{ key: "ca.crt", path: "ca.crt" }] },
                  },
                ]
              : []),
          ],
        },
      },
      // Group-readable for the pod's fsGroup, as on the in-pod Custodian's pod (custodian.ts).
      {
        name: HARNESS_CREDENTIALS_VOLUME,
        projected: {
          defaultMode: 0o440,
          sources: [
            {
              secret: {
                name: sandboxStandInSecret(opts.sandbox),
                items: [
                  { key: CREDENTIAL_KEYS.controlStandIn, path: "control/standin" },
                  ...harness.map((s) => ({ key: heldStandInKey(s.name), path: `standins/${s.name}` })),
                ],
              },
            },
          ],
        },
      },
    ],
  };
}
