// greet — says hello. No dependencies: the flags are parsed by hand below.

export const HELP = `usage: greet [name] [--shout]

  name      who to greet (default: world)
  --shout   say it louder
  --help    show this help`;

/**
 * @param {string[]} args the command-line arguments, without `node` and the script
 * @returns {{ code: number, stdout?: string, stderr?: string }}
 */
export function greet(args) {
  if (args.includes("--help")) return { code: 0, stdout: HELP };

  const unknown = args.find((a) => a.startsWith("-") && a !== "--shout");
  if (unknown) return { code: 2, stderr: `greet: unknown flag ${unknown}\n\n${HELP}` };

  const name = args.find((a) => !a.startsWith("-")) ?? "world";
  const line = `hello, ${name}`;
  return { code: 0, stdout: args.includes("--shout") ? `${line.toUpperCase()}!` : line };
}
