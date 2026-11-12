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
  const channel = {now:()=>1700000000000,store:{data:{},settings:()=>({privatePeers:['friend'],groups:[]}),modelConfig:()=>({vision:true})},
    transport:{readMomentsImages:async()=>({accountId:'self',postId:'100',post,source:'wechat-sns-images-live',complete:true,imageCount:1,items:[item]})},
    runner:{run:async request=>{modelCalls++;assert.deepEqual(Buffer.from(request.images[0].data,'base64'),jpeg);
      return {text:JSON.stringify({images:[{index:1,readable:true,description:'fixture image description'}]})};}}};
  const result = await readMomentsImageContext(channel,{accountId:'self',scopeKey:'test',postId:'100'},undefined,()=>{});
  assert(result.complete);assert.equal(result.images[0].sha256,sha(downloaded));assert.equal(modelCalls,1);
  item.sha256=sha(jpeg);
  const damaged = await readMomentsImageContext(channel,{accountId:'self',scopeKey:'test',postId:'100'},undefined,()=>{});
  assert.equal(damaged.complete,false); assert.equal(damaged.images[0].error.code,'MOMENTS_IMAGE_INVALID');
  assert.equal(modelCalls,1);
});

function imageContextFixture(count = 9) {
  const payloads = Array.from({ length: count }, (_, index) => { const bytes = Buffer.from(jpeg); bytes[bytes.length - 5] = index + 1; return bytes; });
  const post = { id:'100',author:{userId:'friend'},contentAvailable:true,text:'旅行随记',createdAt:1700000000,imageCount:count,
    media:payloads.map((_,index)=>({type:'image',id:'m'+(index+1)})) };
  const items = payloads.map((bytes,index)=>({index:index+1,mediaId:post.media[index].id,data:bytes.toString('base64'),bytes:bytes.length,sha256:sha(bytes),mediaType:'image/jpeg'}));
  const requests = [], observed = [];
  const channel = { now:()=>1700000000000,store:{data:{},settings:()=>({privatePeers:['friend'],groups:[]}),modelConfig:()=>({vision:true})},
    transport:{readMomentsImages:async()=>({accountId:'self',postId:'100',post,source:'wechat-sns-images-live',complete:items.every(item=>!item.error),imageCount:count,items})},
    runner:{run:async request=>{
      requests.push(request);
      // Reproduce a provider that admits at most eight images in one request.
      const images = request.images.slice(0,8).map((image,index)=>{const original = Buffer.from(image.data,'base64').at(-5);observed.push(original);
        return {index:index+1,readable:true,description:'画面 '+original};});
      return {text:JSON.stringify({images})};
    }} };
  return {channel,items,requests,observed,read:(signal,check=()=>{})=>readMomentsImageContext(channel,{accountId:'self',scopeKey:'test',postId:'100'},signal,check)};
}

test('all nine images reach an eight-image provider in small batches with their original order and hashes',async()=>{
  const f=imageContextFixture(),result=await f.read();
  assert.equal(result.complete,true);assert.equal(result.readableImageCount,9);assert.equal(result.failedImageCount,0);
  assert.equal(f.requests.length,3);assert(f.requests.every(request=>request.images.length===3&&JSON.parse(request.text).imageCount===3));
  assert.deepEqual(f.observed,[1,2,3,4,5,6,7,8,9]);
  assert.deepEqual(result.images.map(image=>[image.index,image.mediaId,image.sha256,image.description]),
    f.items.map(item=>[item.index,item.mediaId,item.sha256,'画面 '+item.index]));
});

test('a failed vision batch records only its images and keeps earlier and later readable pictures',async()=>{
  const f=imageContextFixture(),run=f.channel.runner.run;let calls=0;
  f.channel.runner.run=async request=>{calls++;if(calls===2)throw Error('https://private.invalid/?token=SECRET');return run(request);};
  const result=await f.read();assert.equal(result.complete,false);assert.equal(result.readableImageCount,6);assert.equal(calls,3);
  assert.deepEqual(result.images.filter(image=>image.readable).map(image=>image.index),[1,2,3,7,8,9]);
  assert(result.images.slice(3,6).every(image=>image.error.stage==='vision'&&image.error.code==='OPERATION_FAILED'));
  assert(!JSON.stringify(result).includes('SECRET'));assert(!JSON.stringify(result).includes('private.invalid'));
});

test('missing, duplicate and invalid descriptions do not discard other usable image descriptions',async()=>{
  const f=imageContextFixture(3);
  f.channel.runner.run=async()=>({text:JSON.stringify({images:[{index:3,readable:true,description:'第三张的实际画面'},
    {index:1,readable:true,description:'第一张的实际画面'},{index:2,readable:true,description:'重复一'},{index:2,readable:true,description:'重复二'}]})});
  const result=await f.read();assert.equal(result.readableImageCount,2);
  assert.deepEqual(result.images.filter(image=>image.readable).map(image=>image.index),[1,3]);
  assert.equal(result.images[1].error.code,'MOMENTS_IMAGE_DESCRIPTION');
  f.channel.runner.run=async()=>({text:'{"images":[{"index":1,"readable":true,"description":"第一张"},{"index":2,"readable":"yes","description":"无效"}]}'});
  const missing=await f.read();assert.equal(missing.readableImageCount,1);assert.equal(missing.failedImageCount,2);
});

test('download failures and corrupted payloads are excluded from vision while remaining images keep their original indexes',async()=>{
  const f=imageContextFixture(4);
  f.items[1]={index:2,mediaId:'m2',error:{code:'ERR_MOMENTS_IMAGE_READ',message:'图片已过期，已跳过'}};
  f.items[2].sha256='a'.repeat(64);
  const result=await f.read();assert.equal(result.readableImageCount,2);assert.equal(f.requests.length,1);
  assert.deepEqual(f.observed,[1,4]);assert.deepEqual(result.images.filter(image=>image.readable).map(image=>image.index),[1,4]);
  assert.equal(result.images[1].error.stage,'download');assert.equal(result.images[2].error.stage,'prepare');
});

test('cancellation and account checks discard an in-flight batch and prevent later batches',async()=>{
  for(const mode of ['cancel','account']) {
    const f=imageContextFixture(),controller=new AbortController();let changed=false,calls=0;
    const run=f.channel.runner.run;f.channel.runner.run=async request=>{calls++;const value=await run(request);if(mode==='cancel')controller.abort();else changed=true;return value;};
    await assert.rejects(f.read(controller.signal,()=>{if(changed)throw Object.assign(new Error('account changed'),{code:'ACCOUNT_CHANGED'});}));
    assert.equal(calls,1);
  }
});
