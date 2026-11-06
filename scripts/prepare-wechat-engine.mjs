import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('请传入微信 3.9.12.51 组件目录：npm run engine:prepare -- <目录>，详见 README.md');
const source = path.resolve(process.argv[2]);
const target = path.join(root, 'runtime/wechat39-engine');
// Only the version-directory launcher and native libraries are admitted. The
// green wrapper, installers, browser/miniapp/OCR/video bundles never enter it.
const names = [
  'WeChat.exe', 'WeChatWin.dll', 'WeChatResource.dll', 'WeUIResource.dll',
  'ilink2.dll', 'andromeda.dll', 'libwxcodec.dll', 'libEGL.dll', 'libGLESv2.dll',
  'libFFmpeg.dll', 'pagengine.dll', 'owl.dll', 'wcprobe.dll',
  'mmcrashpad_client64.dll', 'mmmojo.dll', 'mmmojo_64.dll', 'ConfSdk.dll',
  'VoipEngine.dll', 'rqt.dat', 'sae.dat', 'sperqt.dat',
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestFile = path.join(target, 'manifest.json');
// The built-in 3.9 runtime is identified by the recorded WeChatWin.dll size and SHA-256.
// With an existing manifest the recorded entry is authoritative; the first prepare uses the fixed values.
const known = fs.existsSync(manifestFile)
  ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')).files.find(file => file.name === 'WeChatWin.dll')
  : { bytes: 101355616, sha256: '4b204c16d5c2d8a7af837020843cc6f16eb67b1d592c2be3695ae31f10c0e6f0' };
const core = fs.readFileSync(path.join(source, 'WeChatWin.dll'));
if (!known || core.length !== known.bytes || digest(core) !== known.sha256)
  throw new Error('WeChatWin.dll 的大小或 SHA-256 与内置 3.9.12.51 运行时清单不一致');
fs.mkdirSync(target, { recursive: true });
const files = names.map(name => {
  const bytes = fs.readFileSync(path.join(source, name));
  fs.writeFileSync(path.join(target, name), bytes);
  return { name, bytes: bytes.length, sha256: digest(bytes) };
});
// hkcu.template.dat is a historical manifest entry: it is no longer created or loaded here.
const hiveFile = path.join(target, 'hkcu.template.dat');
if (fs.existsSync(hiveFile)) {
  const hive = fs.readFileSync(hiveFile);
  files.push({ name: 'hkcu.template.dat', bytes: hive.length, sha256: digest(hive) });
}
const omitted = fs.readdirSync(source).filter(name => !names.includes(name)).map(name => ({ name, bytes: fs.statSync(path.join(source, name)).size }));
const manifest = { format: 1, coreVersion: '3.9.12.51', reportedVersion: '0xF2542033', files, omitted,
  bytes: files.reduce((n, f) => n + f.bytes, 0), omittedBytes: omitted.reduce((n, f) => n + f.bytes, 0) };
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ files: files.length, bytes: manifest.bytes, omittedBytes: manifest.omittedBytes }));
