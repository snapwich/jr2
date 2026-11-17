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
//                            `/run/jr2/`. No token and no value.
//
// The Sandbox's CA is made here (`sandboxPki`) and its key goes with the call: no object holds it,
// so no key that can sign a leaf for the Sandbox exists while its Agents run.
//
// `fenceComposition` is what the CR gains on the Fence, in place of the in-pod Custodian: the
// attachment and the nameserver of its slot (`spec.network`), the Harness container's env and its
// mounts. No Custodian container, no proxy variable and no control socket: the Custodian is at
// jr2's own name, outside the pod.

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
import type { FenceRanges, HostPort } from "./egress.ts";
import { CONTROL_TOKEN_NAME, heldStandIn, leafStem, SANDBOX_TOKEN_NAME, type HeldManifest } from "./held-secrets.ts";
import type { KubeObject } from "./kube-client.ts";
import {
  CA_CONFIGMAP,
  custodianSlotSecret,
  fenceSlotAttachment,
  LABEL_FENCE_SLOT,
  sandboxStandInSecret,
  sandboxTrustConfigMap,
} from "./names.ts";
import { sandboxPki } from "./pki.ts";
import { checkAppendOnly, emptyPlaceholders, withPlaceholders, type PlaceholderTable } from "./placeholders.ts";
import { controlStandIn, controlToken, sandboxToken } from "./tokens.ts";

/** The Custodian's address as a Harness on the Fence calls it (ADR-0059): HTTPS at jr2's own name. */
export const FENCE_CUSTODIAN_URL = `https://${JR2_CUSTODIAN_NAME}`;

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
 * CA that the pod trusts. Each `data` is base64, as a server-side apply owns it.
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
      (s) => [`values/${standInValueFile(s.name)}`, heldStandIn(signingKey, sandbox, s.name)] as [string, string],
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
          manifest.secrets.map((s) => [heldStandInKey(s.name), heldStandIn(signingKey, sandbox, s.name)]),
        ),
      }),
    },
  };
}

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
  },
): FenceComposition {
  const held = new Set(manifest.secrets.map((s) => s.name));
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
              ? [{ configMap: { name: CA_CONFIGMAP, items: [{ key: "ca.crt", path: "ca.crt" }] } }]
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
                  ...manifest.secrets.map((s) => ({ key: heldStandInKey(s.name), path: `standins/${s.name}` })),
                ],
              },
            },
          ],
        },
      },
    ],
  };
}
