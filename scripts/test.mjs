import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).sort();
if (!tests.length) throw new Error('No plugin tests found');
const result = spawnSync(process.execPath, ['--test', ...tests.map(name => path.join(root, 'tests', name))], { cwd: root, windowsHide: true, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
