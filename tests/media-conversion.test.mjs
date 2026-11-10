import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MediaLibrary } from "../modules/media/library.mjs";
import { inspectAssetImage } from "../modules/media/image-format.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), temporary = path.join(repo, 'storage/tmp');
const embedded = path.join(repo, 'storage/cache/dsh-plugin-python-3.13.9-v1/python.exe');
const python = process.env.WECHAT_TEST_PYTHON || (fs.existsSync(embedded) ? embedded : 'python');
// Python fixture startup can exceed five seconds during Windows parallel runs.
const pythonFixtureTimeoutMs = 30000;
const pythonReady = spawnSync(python, ['-c', 'import PIL'], { windowsHide: true, timeout: pythonFixtureTimeoutMs, stdio: 'ignore' }).status === 0;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC', 'base64');
function fixture(t, options = {}) {
  fs.mkdirSync(temporary, { recursive: true }); const root = fs.mkdtempSync(path.join(temporary, 'asset-conversion-'));
  const library = new MediaLibrary({ root, data: { storeId: 'asset-conversion-fixture' } }, { pythonPath: python, ...options }), account = 'conversion-owner';
  t.after(() => { library.close(); const absolute = fs.realpathSync(root), relative = path.relative(temporary, absolute); assert(relative.startsWith('asset-conversion-') && !relative.includes('..')); fs.rmSync(absolute, { recursive: true, force: true }); });
  return { library, account, add(data, name) { return library.import(account, { name, data: data.toString('base64'), kind: 'sticker' }).assetIds[0]; } };
}
function makeImage(format) {
  const source = format === 'GIF'
    ? "from PIL import Image; import io,sys; data=io.BytesIO(); frames=[Image.new('RGB',(8,6),(255,0,0)),Image.new('RGB',(8,6),(0,0,255))]; frames[0].save(data,format='GIF',save_all=True,append_images=frames[1:],duration=50,loop=0); sys.stdout.buffer.write(data.getvalue())"
    : "from PIL import Image; import io,sys; data=io.BytesIO(); Image.new('RGB',(8,6),(10,20,30)).save(data,format='WEBP',lossless=True); sys.stdout.buffer.write(data.getvalue())";
  const result = spawnSync(python, ['-c', source], { windowsHide: true, timeout: pythonFixtureTimeoutMs }); assert.equal(result.status, 0); return result.stdout;
}

test('PNG send preparation preserves original bytes without requiring a Python installation', async t => {
  const f = fixture(t, { pythonPath: path.join(repo, 'storage/tmp/does-not-exist.exe') }), id = f.add(png, '方块.png');
  const result = await f.library.prepareSendContent(f.account, id, new AbortController().signal);
  assert.equal(result.mediaType, 'image/png'); assert.equal(result.data, png.toString('base64')); assert.equal(result.staticFrame, undefined);
});

test('GIF/WebP send preparation uses a static PNG first frame and preserves the original animated asset', { skip: !pythonReady && 'Pillow is required for native image conversion checks' }, async t => {
  const f = fixture(t), animated = makeImage('GIF'), id = f.add(animated, '红蓝动画.gif');
  const result = await f.library.prepareSendContent(f.account, id, new AbortController().signal);
  assert.equal(result.mediaType, 'image/png'); assert.equal(result.sourceMediaType, 'image/gif'); assert.equal(result.staticFrame, true);
  assert.deepEqual(inspectAssetImage(Buffer.from(result.data, 'base64')), { mediaType: 'image/png', extension: 'png', width: 8, height: 6 });
  const pixel = spawnSync(python, ['-c', "from PIL import Image; import io,sys; print(Image.open(io.BytesIO(sys.stdin.buffer.read())).getpixel((0,0)))"], { input: Buffer.from(result.data, 'base64'), windowsHide: true, timeout: pythonFixtureTimeoutMs });
  assert.equal(pixel.status, 0); assert.equal(pixel.stdout.toString().trim(), '(255, 0, 0, 255)');
  assert.equal(f.library.getContent(f.account, id).data, animated.toString('base64'));
  const webp = makeImage('WEBP'), webpId = f.add(webp, '无损图片.webp'), converted = await f.library.prepareSendContent(f.account, webpId, new AbortController().signal);
  assert.equal(converted.mediaType, 'image/png'); assert.equal(converted.sourceMediaType, 'image/webp'); assert.equal(converted.width, 8);
});

test('conversion cancellation and timeout return before any send and retain the source asset', { skip: !pythonReady && 'Pillow is required for native image conversion checks' }, async t => {
  const f = fixture(t), gif = makeImage('GIF'), id = f.add(gif, '动图.gif'), controller = new AbortController();
  const pending = f.library.prepareSendContent(f.account, id, controller.signal); setTimeout(() => controller.abort(), 1);
  await assert.rejects(pending); assert.equal(f.library.getContent(f.account, id).data, gif.toString('base64'));
  const timed = fixture(t, { conversionTimeoutMs: 1 }), timedId = timed.add(gif, '超时.gif');
  await assert.rejects(timed.library.prepareSendContent(timed.account, timedId, new AbortController().signal), { code: 'ASSET_CONVERSION_TIMEOUT' });
});

test('conversion helper rejects unsupported input without exposing its contents or a traceback', { skip: !pythonReady && 'Pillow is required for native image conversion checks' }, () => {
  const result = spawnSync(python, ['-B', path.join(repo, 'runtime/prepare_reply_image.py')], { input: Buffer.from('private fixture body must not appear in errors'), windowsHide: true, timeout: pythonFixtureTimeoutMs });
  assert.equal(result.status, 1); assert.equal(result.stdout.length, 0); assert.equal(result.stderr.toString().trim(), 'IMAGE_CONVERSION_FAILED');
});
