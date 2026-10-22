// The engine this Harness runs (ADR-0027): the one place that chooses the adapter. The Turn
// (`turn.ts`) runs it unless a rig passes another (`TurnDeps.engineAdapter`). A second engine is a
// second adapter, named here.

import type { EngineAdapter } from "./engine.ts";
import { piAdapter } from "./pi-engine.ts";

export const ENGINE_ADAPTER: EngineAdapter = piAdapter;
