import { test } from "node:test";
import assert from "node:assert/strict";
import { greet, HELP } from "../src/greet.js";

test("greets the world by default", () => {
  assert.deepEqual(greet([]), { code: 0, stdout: "hello, world" });
});

test("greets a name", () => {
  assert.deepEqual(greet(["ada"]), { code: 0, stdout: "hello, ada" });
});

test("shouts", () => {
  assert.deepEqual(greet(["--shout"]), { code: 0, stdout: "HELLO, WORLD!" });
  assert.deepEqual(greet(["ada", "--shout"]), { code: 0, stdout: "HELLO, ADA!" });
});

test("trims the name", () => {
  assert.deepEqual(greet([" ada "]), { code: 0, stdout: "hello, ada" });
});

test("prints help", () => {
  assert.deepEqual(greet(["--help"]), { code: 0, stdout: HELP });
});

test("refuses an unknown flag", () => {
  const { code, stderr } = greet(["--whisper"]);
  assert.equal(code, 2);
  assert.match(stderr ?? "", /^greet: unknown flag --whisper/);
});
