#!/usr/bin/env node
/**
 * Run the whole suite.
 *
 * `node --test test/` isolates each file in a child process with a piped stdio pair, and under the
 * restricted sandbox this plugin is developed in that spawn fails outright (`spawn … EPERM`).
 * `--experimental-test-isolation=none` runs every file in one process: the same suite, the same
 * reporter, no test changes needed. None of the tests depends on process isolation, and each
 * cleans up its own temporary tree.
 *
 * Usage: node tools/test.mjs [--<flag> …] [name-filter]
 */

import { spawnSync } from 'node:child_process';

/** Bare words become `test/<word>*.test.mjs`; anything starting with `-` passes through. */
const passthrough = [];
const patterns = [];
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith('-')) passthrough.push(argument);
  else patterns.push(argument.includes('.') ? argument : `${argument}*.test.mjs`);
}

const args = [
  '--test',
  '--experimental-test-isolation=none',
  ...passthrough,
  ...(patterns.length === 0 ? ['test/'] : patterns.map((pattern) => `test/${pattern}`)),
];
const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (result.error !== undefined) {
  process.stderr.write(`could not start the test runner: ${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
