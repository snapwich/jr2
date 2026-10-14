#!/usr/bin/env node
import { greet } from "../src/greet.js";

const { code, stdout, stderr } = greet(process.argv.slice(2));
if (stdout) console.log(stdout);
if (stderr) console.error(stderr);
process.exit(code);
