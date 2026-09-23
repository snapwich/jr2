#!/usr/bin/env node
// greet — says hello. No dependencies: the flags are parsed by hand below.

const HELP = `usage: greet [name] [--shout]

  name      who to greet (default: world)
  --shout   say it louder
  --help    show this help`;

const args = process.argv.slice(2);

if (args.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}

const unknown = args.find((a) => a.startsWith("-") && a !== "--shout");
if (unknown) {
  console.error(`greet: unknown flag ${unknown}\n\n${HELP}`);
  process.exit(2);
}

const name = args.find((a) => !a.startsWith("-")) ?? "world";
const line = `hello, ${name}`;
console.log(args.includes("--shout") ? `${line.toUpperCase()}!` : line);
