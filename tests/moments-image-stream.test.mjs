import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareMomentsVisionImage } from '../modules/moments/image-stream.mjs';
import { readMomentsImageContext } from '../modules/moments/image-context.mjs';
import { inspectAssetImage } from '../modules/media/image-format.mjs';

const segment = (marker, body) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
// Structural fixture only: exercises marker boundaries, not a vision model.
const frame = segment(0xc0, Buffer.from([8, 0, 2, 0, 3, 1, 1, 0x11, 0]));
const scan = segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0]));
const start = Buffer.from([0xff, 0xd8]), end = Buffer.from([0xff, 0xd9]);
const jpeg = Buffer.concat([start, frame, scan, Buffer.from([1, 2, 3]), end]);
const trailer = Buffer.from('sns-cdn-trailer-24-bytes!');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('SNS JPEG trailers are excluded from vision without weakening generic image validation', () => {
  const source = Buffer.concat([jpeg, trailer]);
  assert.throws(() => inspectAssetImage(source), {code:'ASSET_IMAGE_INVALID'});
  const result = prepareMomentsVisionImage(source);
  assert.deepEqual(result.content, jpeg); assert.equal(result.trailerBytes, trailer.length);
  assert.equal(result.info.mediaType, 'image/jpeg'); assert.equal(result.info.width, 3); assert.equal(result.info.height, 2);
  assert.deepEqual(source, Buffer.concat([jpeg, trailer]));
  assert.equal(prepareMomentsVisionImage(jpeg).trailerBytes, 0);
});

test('JPEG metadata, byte stuffing, restart markers and progressive scans do not create false boundaries', () => {
  const metadata = segment(0xe1, Buffer.concat([Buffer.from('exif-data'), end, Buffer.from('still-exif')]));
  const progressive = Buffer.concat([start, metadata, frame, scan, Buffer.from([1, 0xff, 0, 0xd9, 2, 0xff, 0xd3, 3]),
    segment(0xc4, Buffer.from([1, 2, 3])), scan, Buffer.from([4, 5]), end]);
  assert.deepEqual(prepareMomentsVisionImage(Buffer.concat([progressive, trailer, end])).content, progressive);
});

test('truncated or malformed JPEG streams are rejected even when metadata contains an EOI pair', () => {
  const metadata = segment(0xe1, Buffer.concat([Buffer.from('exif'), end]));
  for (const bytes of [Buffer.concat([start, metadata, frame, scan, Buffer.from([1,2,3])]),
    Buffer.concat([start, frame, end]), Buffer.concat([start, Buffer.from([0xff,0xe1,0xff,0xff]), end]),
    Buffer.concat([jpeg, Buffer.alloc(64 * 1024 + 1)]), Buffer.alloc(10 * 1024 * 1024 + 1)])
    assert.throws(() => prepareMomentsVisionImage(bytes), {code:'MOMENTS_IMAGE_INVALID'});
});

test('PNG remains strict and is passed unchanged when complete', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  assert.deepEqual(prepareMomentsVisionImage(png).content, png);
  assert.throws(() => prepareMomentsVisionImage(Buffer.concat([png, trailer])), {code:'ASSET_IMAGE_INVALID'});
});

test('image context verifies the full CDN payload hash and sends the JPEG stream to vision', async () => {
  const downloaded = Buffer.concat([jpeg, trailer]);
  const post = {id:'100',author:{userId:'friend'},contentAvailable:true,text:'',createdAt:1700000000,imageCount:1,
    media:[{type:'image',id:'m1'}]};
  const item = {index:1,mediaId:'m1',data:downloaded.toString('base64'),bytes:downloaded.length,sha256:sha(downloaded),mediaType:'image/jpeg'};
  let modelCalls = 0;
  const channel = {now:()=>1700000000000,store:{modelConfig:()=>({vision:true})},
    transport:{readMomentsImages:async()=>({accountId:'self',postId:'100',post,source:'wechat-sns-images-live',complete:true,imageCount:1,items:[item]})},
    runner:{run:async request=>{modelCalls++;assert.deepEqual(Buffer.from(request.images[0].data,'base64'),jpeg);
      return {text:JSON.stringify({images:[{index:1,readable:true,description:'fixture image description'}]})};}}};
  const result = await readMomentsImageContext(channel,{accountId:'self',scopeKey:'test',postId:'100'},undefined,()=>{});
  assert(result.complete);assert.equal(result.images[0].sha256,sha(downloaded));assert.equal(modelCalls,1);
  item.sha256=sha(jpeg);
  await assert.rejects(readMomentsImageContext(channel,{accountId:'self',scopeKey:'test',postId:'100'},undefined,()=>{}),{code:'MOMENTS_IMAGE_CONTEXT'});
  assert.equal(modelCalls,1);
});
