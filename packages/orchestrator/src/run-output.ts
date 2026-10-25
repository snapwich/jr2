// The output of a run (ADR-0015). xstate v5 gives a Machine one output: the `output` at its root,
// beside `id` and `states`. The `output` of a final state directly below the root goes to that root
// `output` as `event.output`, and to nothing else. Thus a Machine that writes an `output` on such a
// final state and no root `output` ends with no output: its run status shows none, and the `onDone`
// of an invoke of it gets `event.output` as `undefined`. `types.output` does not stop this, so the
// load walk refuses the shape and the refusal gives the fix.
//
// A final state inside a compound state is legal: its `output` is the `event.output` of the `onDone`
// of that compound state. A Machine with no `output` anywhere is legal too: its result is in its
// `context`, and it says nothing false about an output.

import type { AnyStateMachine, StateNode } from "xstate";

/**
 * Refuse a Machine whose root has no `output` while a final state directly below the root declares
 * one (see the module comment). Thrown at build by `jr2Setup.createMachine` and at load by
 * `partsOf`, so a Machine built with xstate's own `createMachine` is refused where `jr2 up` and the
 * Orchestrator read it.
 */
export function refuseLostOutput(machine: AnyStateMachine): void {
  const root = machine.root as StateNode<any, any>;
  if (root.config.output !== undefined) return;
  const lost = Object.values(root.states as Record<string, StateNode<any, any>>).filter(
    (node) => node.type === "final" && node.config.output !== undefined,
  );
  if (!lost.length) return;
  const names = lost.map((node) => `"${node.id}"`).join(", ");
  const many = lost.length > 1;
  const [states, declare, reach, write, keep, pass] = many
    ? ["final states", "declare", "these outputs reach", "one", "them on the final states", "them"]
    : ["final state", "declares", "this output reaches", "it", "it on the final state", "it"];
  throw new Error(
    `machine "${machine.id}": ${states} ${names} ${declare} an output, and the root has no output — xstate v5 ` +
      `gives a run only its root output, so ${reach} nothing and the run ends with none: write ${write} at the ` +
      `root, as output: ({ context }) => ..., or keep ${keep} and pass ${pass} on with output: ({ event }) => ` +
      `event.output at the root`,
  );
}
