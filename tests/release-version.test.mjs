import test from 'node:test';
import assert from 'node:assert/strict';
import manifest from '../package.json' with { type: 'json' };
import { VERSION } from '../lib/testing.js';

test('built runtime status reports the exact package version used by native upgrades', () => {
  assert.equal(VERSION, manifest.version, 'A published package must identify itself correctly to DSH and the upgrade health check');
});
