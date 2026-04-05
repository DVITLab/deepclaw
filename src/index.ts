#!/usr/bin/env node
import { runCli } from "./cli.js";

void runCli(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
