import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rolldown } from 'rolldown';
import { BuiltinStickerCatalog } from '../src/builtin-stickers.mjs';
import { inspectAssetImage } from '../src/media-library.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = root;
const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
const alias = { '@napcat-wechat/protocol': path.join(root, 'src/wechat/types.ts') };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bundledPackages = new Set();
const builtinStickers = new BuiltinStickerCatalog();
for (const pack of builtinStickers.packs) for (const item of pack.items) {
  const image = inspectAssetImage(builtinStickers.read(pack.id, item.id).content);
  if (image.mediaType !== item.mediaType || image.width !== item.width || image.height !== item.height) throw new Error(`Invalid built-in sticker: ${item.file}`);
}
if (!fs.readFileSync(builtinStickers.localFile(builtinStickers.source.licenseFile), 'utf8').includes('Copyright (c) Microsoft Corporation.')) throw new Error('Missing built-in sticker attribution');
function recordModules(output) {
  for (const chunk of output) {
    if (chunk.type !== 'chunk') continue;
    for (const id of chunk.moduleIds) {
      if (!path.isAbsolute(id)) continue;
      const relative = path.relative(root, id);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Build dependency is outside this repository: ${id}. Run npm ci here.`);
      const normalized = id.replaceAll('\\', '/');
      const marker = normalized.lastIndexOf('/node_modules/');
      if (marker < 0) continue;
      const parts = normalized.slice(marker + 14).split('/');
      const name = parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/');
      bundledPackages.add(normalized.slice(0, marker + 14) + name);
    }
  }
}
async function bundle(input, output, format, extra = {}) {
  const build = await rolldown({ input, platform: 'node', resolve: { alias }, ...extra });
  try { recordModules((await build.write({ file: output, format, sourcemap: false })).output); } finally { await build.close(); }
}
fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
await bundle(path.join(pkg, 'src/index.mjs'), path.join(pkg, 'lib/index.js'), 'esm');
await bundle(path.join(pkg, 'src/worker.mjs'), path.join(pkg, 'lib/worker.cjs'), 'cjs');
await bundle(path.join(pkg, 'src/testing.mjs'), path.join(pkg, 'lib/testing.js'), 'esm');
const client = await rolldown({ input: path.join(pkg, 'src/client.jsx'), platform: 'browser', external: ['react', 'react/jsx-runtime'] });
try {
  const { output } = await client.generate({ format: 'cjs' });
  recordModules(output);
  if (output.length !== 1 || output[0].type !== 'chunk') throw new Error('Unexpected client bundle output');
  fs.writeFileSync(path.join(pkg, 'lib/client.js'), `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${output[0].code}\nreturn module.exports;}});\n`);
} finally { await client.close(); }
console.log(`DSH plugin code built: ${manifest.name}@${manifest.version}`);

if (process.argv.includes('--pack')) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('完整插件包需要在 Windows x64 上构建');
  const engineSource = path.join(root, 'runtime/wechat39-engine');
  if (!fs.existsSync(path.join(engineSource, 'manifest.json'))) throw new Error('缺少微信登录组件，请先运行 npm run engine:prepare -- <微信组件目录>，详见 README.md');
  const run = (exe, args, cwd = root, timeout = 180000) => {
    const result = spawnSync(exe, args, { cwd, windowsHide: true, stdio: 'inherit', shell: exe.endsWith('.cmd'), timeout });
    if (result.status !== 0) throw new Error(`${path.basename(exe)} failed (${result.status ?? result.error?.message})`);
  };
  function copy(from, to) {
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error('Release inputs must not be symlinks');
    if (stat.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from)) if (name !== '__pycache__' && name !== 'bin' && !name.endsWith('.pyc')) copy(path.join(from, name), path.join(to, name));
    } else { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
  }
  const cache = path.join(root, 'storage/cache');
  const python = path.join(cache, 'dsh-plugin-python-3.13.9-v1');
  const zip = path.join(cache, 'python-3.13.9-embed-amd64.zip');
  const pythonHash = '91d828c2da3a029b41699e918674a0cb379c02cf20dab9c501306885f837402a';
  fs.mkdirSync(cache, { recursive: true });
  if (!fs.existsSync(zip)) {
    try {
      const response = await fetch('https://www.python.org/ftp/python/3.13.9/python-3.13.9-embed-amd64.zip', { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`Python download: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (hash(bytes) !== pythonHash) throw new Error('Python download hash mismatch');
      fs.writeFileSync(zip, bytes);
    } catch (cause) {
      throw new Error('无法下载已验证的 Python 运行时。请检查网络，或将官方 python-3.13.9-embed-amd64.zip 放入 storage/cache/ 后重试；仍会校验 SHA-256。', { cause });
    }
  }
  if (hash(fs.readFileSync(zip)) !== pythonHash) throw new Error('Embedded Python hash mismatch');
  if (!fs.existsSync(path.join(python, 'ready.json'))) {
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(python)} -Force`]);
    fs.writeFileSync(path.join(python, 'python313._pth'), 'python313.zip\n.\n..\nLib/site-packages\nimport site\n');
    run('python', ['-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', '--target', path.join(python, 'Lib/site-packages'), '--python-version', '3.13', '--platform', 'win_amd64', '--implementation', 'cp', '--abi', 'cp313', '-r', path.join(root, 'runtime/requirements.txt')], root, 300000);
    run(path.join(python, 'python.exe'), ['-c', 'import cryptography,PIL,frida; assert cryptography.__version__=="50.0.0"; assert PIL.__version__=="12.3.0"; assert frida.__version__=="17.24.3"; print("Plugin Python verified")']);
    fs.writeFileSync(path.join(python, 'ready.json'), JSON.stringify({ pythonHash, dependencies: ['cryptography==50.0.0', 'Pillow==12.3.0', 'frida==17.24.3'] }));
  }
  // A new staging directory prevents stale/developer files entering the tarball.
  const stage = fs.mkdtempSync(path.join(cache, 'dsh-plugin-package-'));
  const { scripts, devDependencies, private: privateSource, ...distribution } = manifest;
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(distribution, null, 2) + '\n');
  for (const file of ['lib/index.js', 'lib/client.js', 'lib/worker.cjs', 'cordis.patch.yml', 'README.md']) copy(path.join(pkg, file), path.join(stage, file));
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md']) copy(path.join(root, file), path.join(stage, file));
  // Ship only catalogued artwork and its original license, never cached downloads.
  for (const file of ['manifest.json', builtinStickers.source.licenseFile, ...builtinStickers.packs.flatMap(pack => pack.items.map(item => item.file))])
    copy(builtinStickers.localFile(file), path.join(stage, 'assets/stickers', file));
  for (const directory of bundledPackages) {
    const dependency = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    // This npm version omits its upstream license; retain the matching gitHead copy.
    const licenseDirectory = dependency.name === '@nodable/entities' && dependency.version === '3.1.0'
      ? path.join(root, 'third-party/nodable-entities') : directory;
    const licenses = fs.readdirSync(licenseDirectory).filter(name => /^(?:licen[cs]e|copying)(?:[.-]|$)/i.test(name));
    if (!licenses.length) throw new Error(`Missing bundled dependency license: ${dependency.name}`);
    if (licenseDirectory !== directory) licenses.push('NOTICE.md');
    for (const file of licenses) copy(path.join(licenseDirectory, file), path.join(stage, 'licenses', dependency.name.replaceAll('/', '__'), file));
  }
  for (const file of ['native_login_worker.py', 'native_login_agent.js', 'native_engine.py', 'prepare_reply_image.py']) copy(path.join(root, 'runtime', file), path.join(stage, 'runtime', file));
  copy(path.join(root, 'runtime/wechat39/proto'), path.join(stage, 'runtime/wechat39/proto'));
  const engine = JSON.parse(fs.readFileSync(path.join(engineSource, 'manifest.json'), 'utf8'));
  for (const file of engine.files) {
    if (path.basename(file.name) !== file.name) throw new Error('Invalid engine manifest path');
    const input = fs.readFileSync(path.join(engineSource, file.name));
    if (input.length !== file.bytes || hash(input) !== file.sha256) throw new Error(`Engine hash mismatch: ${file.name}`);
    copy(path.join(engineSource, file.name), path.join(stage, 'runtime/wechat39-engine', file.name));
  }
  // Omitted source directory names are build-machine details, not runtime inputs.
  fs.writeFileSync(path.join(stage, 'runtime/wechat39-engine/manifest.json'), JSON.stringify({ format: engine.format, coreVersion: engine.coreVersion, reportedVersion: engine.reportedVersion, files: engine.files }, null, 2));
  copy(python, path.join(stage, 'runtime/python'));
  fs.unlinkSync(path.join(stage, 'runtime/python/ready.json'));
  run(path.join(stage, 'runtime/python/python.exe'), ['-B', path.join(stage, 'runtime/native_login_worker.py'), '--help'], stage);
  const outputFlag = process.argv.indexOf('--output-dir');
  if (outputFlag >= 0 && (!process.argv[outputFlag + 1] || process.argv[outputFlag + 1].startsWith('--'))) throw new Error('--output-dir requires a directory');
  const release = outputFlag >= 0 ? path.resolve(root, process.argv[outputFlag + 1]) : path.join(root, 'release'); fs.mkdirSync(release, { recursive: true });
  if (!process.env.npm_execpath) throw new Error('Run packaging through npm run pack:plugin so the current npm executable is explicit');
  run(process.execPath, [process.env.npm_execpath, 'pack', '--silent', '--ignore-scripts', '--pack-destination', release], stage);
  const tarball = path.join(release, `${manifest.name}-${manifest.version}.tgz`);
  const digest = hash(fs.readFileSync(tarball));
  fs.writeFileSync(tarball + '.sha256', `${digest}  ${path.basename(tarball)}\n`);
  fs.writeFileSync(path.join(release, 'build.json'), JSON.stringify({ name: manifest.name, version: manifest.version, testedDsh: '0.2.1-rc.5', bytes: fs.statSync(tarball).size, sha256: digest, stage, at: new Date().toISOString() }, null, 2));
  console.log(`Installable DSH plugin: ${tarball}`);
}
