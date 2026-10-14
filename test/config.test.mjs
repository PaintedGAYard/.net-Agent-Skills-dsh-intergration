/**
 * Configuration parsing — the parts that hold without a host.
 *
 * `lib/config.js` has two jobs: declare the schema (only when schemastery resolves, which it usually
 * does not) and resolve the row's configuration either way. The fallback path is the one that always
 * runs, so it is the one worth asserting directly rather than through `apply()`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULTS, probeOverrides, resolveConfig } from '../lib/config.js';

test('probeOverrides reports the keys a configuration actually sets', () => {
  // The point of reading the raw configuration: after `resolveConfig` every key has a default, so
  // "the user asked for this" is no longer distinguishable from "nobody said anything".
  assert.deepEqual(probeOverrides({ probe: { enabled: false, maxFiles: 10 } }), ['probe.enabled', 'probe.maxFiles']);
  assert.deepEqual(probeOverrides({ probe: { maxDepth: 3 } }), ['probe.maxDepth']);
  assert.deepEqual(probeOverrides({ probe: {} }), []);
  assert.deepEqual(probeOverrides({}), []);
  assert.deepEqual(probeOverrides(undefined), []);
  // A malformed `probe` is still a setting that is present, so it is named rather than ignored.
  assert.deepEqual(probeOverrides({ probe: true }), ['probe']);
  assert.deepEqual(probeOverrides({ probe: ['enabled'] }), ['probe']);
});

test('resolveConfig fills defaults and keeps the probe object complete', () => {
  const config = resolveConfig({});
  assert.deepEqual(config.probe, DEFAULTS.probe);
  const partial = resolveConfig({ probe: { maxDepth: 3 } });
  assert.deepEqual(partial.probe, { enabled: true, maxFiles: 20000, maxDepth: 3 });
});

test('resolveConfig reports the fields it refuses instead of dropping them quietly', () => {
  const warnings = [];
  const config = resolveConfig({ rank: 'high', catalogTokenBudget: -1, madeUp: true }, (line) => warnings.push(line));
  assert.equal(config.rank, DEFAULTS.rank);
  assert.equal(config.catalogTokenBudget, DEFAULTS.catalogTokenBudget);
  assert.equal(warnings.length, 3, warnings.join(' | '));
  assert.match(warnings.join('\n'), /rank high is not a number/);
  assert.match(warnings.join('\n'), /catalogTokenBudget must be a non-negative number/);
  assert.match(warnings.join('\n'), /unknown configuration field "madeUp"/);
});
