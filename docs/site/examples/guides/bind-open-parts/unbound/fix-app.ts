import { task } from "@jr2/machines";

// The Machine as it is, with no part bound. jr2 up refuses this file, and prints the line that binds one part.
export const machine = task;
