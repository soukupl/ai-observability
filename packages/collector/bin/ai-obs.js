#!/usr/bin/env node
// HARD RULE (BRIEF §5.6): the collector's own summarizer runs a headless harness with
// AI_OBS_SUMMARIZING=1; every hook invocation inside it must exit immediately, before any work,
// or summarizing would recurse. Keep this the first statement of the entry file.
if (process.env.AI_OBS_SUMMARIZING) process.exit(0);

const { main } = await import('../dist/cli.js');
process.exitCode = await main(process.argv.slice(2));
