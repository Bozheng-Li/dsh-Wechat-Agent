import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSync } from 'rolldown/utils';
import { packageRoot, resourcePath } from "../backend/platform/resources.mjs";

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = root;
const sourceDirectories = ['frontend', 'backend', 'modules', 'shared', 'prompts'];
const files = (directory) =>
  fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]
    )
    .filter((file) => /\.(mjs|jsx|ts)$/.test(file));

test('source dependencies resolve, remain acyclic and respect browser and storage boundaries', () => {
  const graph = new Map();
  for (const file of sourceDirectories.flatMap(directory => files(path.join(root, directory)))) {
    const parsed = parseSync(file, fs.readFileSync(file, 'utf8'));
    assert.deepEqual(parsed.errors, [], file);
    const relative = path.relative(sourceRoot, file).replaceAll('\\', '/');
    const dependencies = [];
    for (const node of parsed.program.body) {
      const typeOnly = node.importKind === 'type' || node.exportKind === 'type';
      const specifier = node.source?.value;
      if (!specifier) continue;
      if (!specifier.startsWith('.')) {
        if (relative.startsWith('frontend/') || relative.startsWith('prompts/personas/')) assert(!specifier.startsWith('node:'), `${relative} imports a Node API`);
        continue;
      }
      let target = path.resolve(path.dirname(file), specifier);
      if (!fs.existsSync(target) && target.endsWith('.js')) target = target.slice(0, -3) + '.ts';
      assert(fs.existsSync(target), `${relative}: missing ${specifier}`);
      if (typeOnly) continue;
      const destination = path.relative(sourceRoot, target).replaceAll('\\', '/');
      if (relative.startsWith('frontend/') || relative.startsWith('prompts/personas/'))
        assert(/^(frontend|shared|prompts\/personas)\//.test(destination), `${relative} crosses into ${destination}`);
      if (relative.startsWith('shared/'))
        assert(
          /^(shared|prompts\/personas)\//.test(destination) || destination === 'prompts/memory/compaction.mjs' || destination === 'package.json',
          `${relative} depends on ${destination}`
        );
      if (relative.startsWith('backend/storage/') || relative.startsWith('backend/config/'))
        assert(/^(backend\/(storage|config|platform)|shared|prompts\/personas)\//.test(destination), `${relative} depends on ${destination}`);
      if (relative.startsWith('modules/'))
        assert(!/^(backend\/(app|rpc)|frontend)\//.test(destination), `${relative} depends on ${destination}`);
      dependencies.push(target);
    }
    graph.set(file, dependencies);
  }
  const complete = new Set();
  function visit(file, stack = []) {
    assert(
      !stack.includes(file),
      `Circular dependency: ${[...stack, file].map((name) => path.relative(root, name)).join(' -> ')}`
    );
    if (complete.has(file)) return;
    for (const dependency of graph.get(file) || []) visit(dependency, [...stack, file]);
    complete.add(file);
  }
  for (const file of graph.keys()) visit(file);
});

test('resource paths resolve from nested source, built entry and installed package independently of cwd', (t) => {
  const expected = path.resolve(root);
  assert.equal(packageRoot(), expected);
  assert.equal(packageRoot(new URL('../lib/index.js', import.meta.url)), expected);
  assert.equal(resourcePath('CHANGELOG.md'), path.join(expected, 'CHANGELOG.md'));
  assert(!fs.existsSync(resourcePath('assets', 'stickers', 'manifest.json')), 'retired internet artwork is no longer packaged');
  assert(fs.existsSync(resourcePath('prompts', 'vision', 'requests.json')));
  assert(fs.existsSync(resourcePath('runtime', 'requirements.txt')));
  const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-package-resources-'));
  t.after(() => fs.rmSync(installed, { recursive: true, force: true }));
  fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: 'dsh-plugin-wechat-agent' }));
  assert.equal(packageRoot(pathToFileURL(path.join(installed, 'lib/index.js'))), installed);
  assert.equal(packageRoot(pathToFileURL(path.join(installed, 'modules/media/library.mjs'))), installed);
});
