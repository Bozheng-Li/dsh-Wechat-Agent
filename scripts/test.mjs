import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).sort();
if (!tests.length) throw new Error('No plugin tests found');
// The suite includes protocol and filesystem acceptance tests whose measured
// duration/fixture state should not overlap across files on constrained hosts.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests.map(name => path.join(root, 'tests', name))],
  { cwd: root, windowsHide: true, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
