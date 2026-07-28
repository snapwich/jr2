// The flue instance under test, as close to the stock Harness image as a test can be (ADR-0018):
// a custom provider registered before flue's routes are mounted, exactly like `boot.mjs`'s app
// shim. The provider points at the test's scripted fake, so a turn's shape is chosen by the test
// rather than by a model — deterministic, offline, and free.

import { registerProvider } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

const baseUrl = process.env.J2_CONTRACT_PROVIDER_URL;
if (!baseUrl) throw new Error("no J2_CONTRACT_PROVIDER_URL: the test picks the fake provider's port");

registerProvider("fake", {
  api: "openai-completions",
  baseUrl,
  contextWindow: 128000,
  maxTokens: 4096,
  apiKey: "unused",
});

const app = new Hono();
app.route("/", flue());

export default app;
