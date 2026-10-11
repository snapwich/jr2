// What a push owes the author's Effector image (ADR-0068, B13): per form, the programs the
// Effector runs from its fixed PATH, and for ssh a passwd entry for the uid it runs as — each
// refused with the fix for the case found.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tarFileText } from "../src/build.ts";
import {
  effectorImagePaths,
  effectorImageRefusal,
  effectorSeat,
  passwdHolds,
  STOCK_HARNESS_IMAGE,
  type PushForm,
} from "../src/effector-image.ts";

const PASSWD = "root:x:0:0:root:/root:/bin/sh\nnode:x:1000:1000::/home/node:/bin/sh\n";
const push = 'the push of Repo Slot "app" (git@git.example.com:acme/app.git)';

function refusal(forms: PushForm[], present: string[], opts: { user?: string; passwd?: string } = {}) {
  return effectorImageRefusal({
    label: 'Workspace of workflow "w"',
    ref: "img:1",
    user: opts.user ?? "",
    forms: forms.map((form) => ({ form, push })),
    present: new Set(present),
    passwd: opts.passwd ?? PASSWD,
  });
}

test("each push form names the programs it owes, in the Effector's own tool dirs", () => {
  assert.deepEqual(effectorImagePaths(["ssh-transport"]), ["/usr/local/bin/ssh", "/usr/bin/ssh", "/bin/ssh"]);
  assert.deepEqual(effectorImagePaths(["ssh-sign"]).length, 3);
  assert.deepEqual(
    effectorImagePaths(["gpg-sign"]).filter((p) => p.startsWith("/usr/bin/")),
    ["/usr/bin/gpg", "/usr/bin/gpg-agent"],
  );
  assert.deepEqual(effectorImagePaths([]), [], "a token over https owes nothing beyond git");
});

test("ssh transport: ssh in the tool dirs, and a passwd entry for the uid the Effector runs as", () => {
  assert.equal(refusal(["ssh-transport"], ["/usr/bin/ssh"]), undefined);
  assert.match(
    refusal(["ssh-transport"], ["/opt/tools/ssh"]) ?? "",
    /over ssh needs ssh, and its Sandbox Effector's image img:1 holds none in \/usr\/local\/bin, \/usr\/bin, \/bin.*install it in the image \(openssh-client\)/,
  );
  // No USER: the Effector runs as uid 1000, and the fix is adduser for it.
  assert.match(
    refusal(["ssh-transport"], ["/usr/bin/ssh"], { passwd: "root:x:0:0::/root:/bin/sh\n" }) ?? "",
    /needs a passwd entry for the uid 1000 .*No user exists for uid.*add RUN adduser -D -u 1000 <name> in the image \(the image declares no USER/,
  );
  // A numeric USER: its uid.
  assert.match(
    refusal(["ssh-transport"], ["/usr/bin/ssh"], { user: "1001:1001" }) ?? "",
    /for the uid 1001 .*add RUN adduser -D -u 1001 <name> in the image \(ADR-0068\)/,
  );
  assert.equal(
    refusal(["ssh-transport"], ["/usr/bin/ssh"], { user: "1001", passwd: `${PASSWD}app:x:1001:1001::/a:/bin/sh\n` }),
    undefined,
  );
  // A USER by name the image does not hold: the fix is a USER line.
  assert.match(
    refusal(["ssh-transport"], ["/usr/bin/ssh"], { user: "deploy" }) ?? "",
    /for the user deploy .*add a USER line naming a user the image's \/etc\/passwd holds/,
  );
  assert.equal(refusal(["ssh-transport"], ["/usr/bin/ssh"], { user: "node" }), undefined);
});

test("ssh signing owes ssh-keygen and no passwd entry; GPG signing owes gpg and gpg-agent", () => {
  assert.equal(refusal(["ssh-sign"], ["/usr/bin/ssh-keygen"], { passwd: "" }), undefined, "-Y sign does no lookup");
  assert.match(refusal(["ssh-sign"], []) ?? "", /signed with an ssh key needs ssh-keygen/);
  assert.equal(refusal(["gpg-sign"], ["/usr/bin/gpg", "/usr/bin/gpg-agent"]), undefined);
  assert.match(
    refusal(["gpg-sign"], ["/usr/bin/gpg"]) ?? "",
    /signed with GPG needs gpg-agent.*install it in the image \(gnupg\)/,
  );
});

test("the seat is the image's USER by name or number, else 1000; passwd is read by that", () => {
  assert.deepEqual(effectorSeat(""), { uid: 1000 });
  assert.deepEqual(effectorSeat("1002:1002"), { uid: 1002 });
  assert.deepEqual(effectorSeat("app:app"), { name: "app" });
  assert.equal(passwdHolds(PASSWD, { uid: 1000 }), true);
  assert.equal(passwdHolds(PASSWD, { name: "node" }), true);
  assert.equal(passwdHolds(PASSWD, { uid: 1001 }), false);
  assert.equal(passwdHolds("", { uid: 0 }), false);
});

test("a docker cp tar stream's one file reads as its text", () => {
  const body = Buffer.from("root:x:0:0::/root:/bin/sh\n");
  const header = Buffer.alloc(512);
  header.write("passwd", 0);
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "latin1");
  const tar = Buffer.concat([header, body, Buffer.alloc(512 - body.length), Buffer.alloc(1024)]);
  assert.equal(tarFileText(tar), body.toString());
  assert.equal(tarFileText(Buffer.alloc(10)), "");
});

test("the stock Harness image is what the kit's Dockerfile builds: node:24-slim with git alone of the forms' programs, USER 1000", async () => {
  const dockerfile = await readFile(new URL("../../../deploy/harness/Dockerfile", import.meta.url), "utf8");
  // Its last stage is the image itself.
  const last = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
  assert.match(last, /^\nFROM node:24-slim\n/, "the stock image's base, whose passwd holds node at uid 1000");
  const installs = [...last.matchAll(/apt-get install -y --no-install-recommends ([^&]+)&&/g)].flatMap((m) =>
    m[1]!.trim().split(/\s+/),
  );
  assert.deepEqual(installs.sort(), ["ca-certificates", "git"], "a new package may hold a form's program");
  assert.deepEqual(
    [...last.matchAll(/^USER (.+)$/gm)].map((m) => m[1]),
    ["1000"],
    "the Effector runs as 1000",
  );
  assert.deepEqual(STOCK_HARNESS_IMAGE.present, ["/usr/bin/git"]);
  assert.equal(STOCK_HARNESS_IMAGE.user, "1000");
});

test("in the stock Harness image only a token over https passes, and the fix is an image of the author's", () => {
  const stock = (forms: PushForm[]) =>
    effectorImageRefusal({
      label: 'Workspace of workflow "w"',
      ref: "jr2-harness:1",
      user: STOCK_HARNESS_IMAGE.user,
      forms: forms.map((form) => ({ form, push })),
      present: new Set(STOCK_HARNESS_IMAGE.present),
      passwd: STOCK_HARNESS_IMAGE.passwd,
      stock: true,
    });
  assert.match(
    stock(["ssh-transport"])!,
    /over ssh needs ssh, and its Sandbox Effector runs in the stock Harness image jr2-harness:1, which holds git alone .*an images\/default Sandbox Image, the workspace\(\)'s image, or its effector: \{ image \}/,
  );
  assert.match(stock(["ssh-sign"])!, /signed with an ssh key needs ssh-keygen, .*stock Harness image/);
  assert.match(stock(["gpg-sign"])!, /signed with GPG needs gpg, .*stock Harness image/);
  assert.equal(stock([]), undefined, "a token over https owes nothing beyond git");
});
