import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, WechatChannel, workSettings, observeWorkProgress, summarizeWorkProgress, polishWorkResult } from '../lib/testing.js';

const flush = async predicate => {
  for (let i=0;i<100;i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('expected work/progress boundary');
};
function fixture(t, { review, send } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-progress-')), store = new StateStore(root);
  const scope = { accountId:'owner', chatType:'private', peerId:'alice', senderId:'alice' };
  store.configure(scope.accountId, { enabled:true, privatePeers:['alice'], groups:[],prompt:'' });
  store.setConversationSettings(scope.accountId, 'private','alice', { ...store.conversationSettings(scope.accountId,'private','alice'),
    executionMode:'work',remoteEnabled:true,adminIds:['alice'] });
  const config = store.config.snapshot(store.data); config.work={ timeoutSeconds:600,commandTimeoutSeconds:60,maxConcurrent:2 }; store.config.commit(config);
  const done=Promise.withResolvers(), requests=[], sent=[];
  let input;
  const runner = { run: async request => {
    requests.push(request); assert.equal(request.mode,'work-progress'); assert.deepEqual(request.tools,[]);
    assert(request.systemOverride.includes('不会') || request.systemOverride.includes('不要执行'));
    return review ? review(request) : { text:'正在核对文档排版，任务尚未结束。' };
  } };
  const workRunner={ run: async value => { input=value; await value.onSession('native-work');
    value.onProgress({ kind:'assistant',at:Date.now(),text:'第 11 页只有免责声明，正在调整间距。',tools:['edit'] });
    return done.promise;
  } };
  const channel=new WechatChannel({ store,runner,workRunner,transport:{ status:()=>({ online:true,account:{id:'owner'} }),
    send:async (payload,signal) => { sent.push(payload); return send ? send(payload,signal) : {delivery:'server-ack',serverMessageIds:[`ack-${sent.length}`]}; } } });
  const job=channel.work.create(scope,'整理资料并生成 Word');
  t.after(async()=>{ done.resolve({text:'文档完成'}); await channel.close(); assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir())); fs.rmSync(root,{recursive:true,force:true}); });
  return {store,channel,scope,job,done,requests,sent,input:()=>input};
}

test('old positive timeout settings load as unlimited while command deadlines remain explicit',()=>{
  assert.deepEqual(workSettings({timeoutSeconds:600,commandTimeoutSeconds:60}),{timeoutSeconds:0,commandTimeoutSeconds:60,maxConcurrent:2});
  assert.equal(workSettings({}).timeoutSeconds,0); assert.equal(workSettings({timeoutSeconds:0}).timeoutSeconds,0);
  assert.throws(()=>workSettings({timeoutSeconds:-1}),{code:'INVALID_WORK_SETTINGS'});
});

test('work continues beyond 10 minutes and reviews every 5 minutes with durable text ACKs',async t=>{
  t.mock.timers.enable({apis:['setInterval','setTimeout','Date']});
  const f=fixture(t); await flush(()=>f.input());
  t.mock.timers.tick(299999); await new Promise(resolve=>setImmediate(resolve)); assert.equal(f.requests.length,0);
  t.mock.timers.tick(1); await flush(()=>f.channel.work.get(f.job.id,f.scope).progress?.state==='sent');
  const evidence=JSON.parse(f.requests[0].text); assert.equal(evidence.observations[0].tools[0],'edit');
  assert.equal(f.sent[0].message.length,1); assert.equal(f.sent[0].message[0].type,'text');
  assert.equal(f.channel.work.get(f.job.id,f.scope).delivery.state,'not-ready');
  for(let i=2;i<=3;i++){t.mock.timers.tick(300000); await flush(()=>f.channel.work.get(f.job.id,f.scope).progress?.sequence===i);}
  assert.equal(f.requests.length,3); assert(!f.input().signal.aborted); assert.equal(f.channel.work.get(f.job.id,f.scope).state,'running');
  assert.equal(f.channel.work.get(f.job.id,f.scope).progress.acknowledgedMessageIds[0],'ack-3');
  assert.equal(f.store.history('owner','private','alice',100).length,0);
  f.done.resolve({text:'文档完成'}); await f.channel.whenIdle(); const count=f.sent.length;
  t.mock.timers.tick(600000); await new Promise(resolve=>setImmediate(resolve)); assert.equal(f.sent.length,count);
});

test('an overlapping progress review is not queued twice and completion suppresses its stale message',async t=>{
  t.mock.timers.enable({apis:['setInterval','setTimeout']});
  const entered=Promise.withResolvers();
  const f=fixture(t,{review:request=>new Promise((resolve,reject)=>{entered.resolve();request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});})});
  await flush(()=>f.input()); t.mock.timers.tick(300000); await entered.promise;
  t.mock.timers.tick(600000); await new Promise(resolve=>setImmediate(resolve)); assert.equal(f.requests.length,1);
  f.done.resolve({text:'文档完成'}); await f.channel.whenIdle();
  assert.equal(f.sent.length,1); assert.equal(f.sent[0].message[0].data.text,'文档完成');
  assert.equal(f.channel.work.get(f.job.id,f.scope).state,'succeeded');
});

test('progress API failure falls back truthfully without cancelling or resubmitting work',async t=>{
  t.mock.timers.enable({apis:['setInterval','setTimeout']});
  const f=fixture(t,{review:async()=>{throw Error('fixture provider unavailable');}}); await flush(()=>f.input());
  t.mock.timers.tick(300000); await flush(()=>f.channel.work.get(f.job.id,f.scope).progress?.state==='sent');
  const job=f.channel.work.get(f.job.id,f.scope); assert.equal(job.progress.review.state,'fallback');
  assert(f.sent[0].message[0].data.text.includes('暂时无法')); assert.equal(job.state,'running'); assert(!f.input().signal.aborted);
});

test('revoking authorization before a review sends nothing, while explicit cancellation stops future checks',async t=>{
  t.mock.timers.enable({apis:['setInterval','setTimeout']});
  const f=fixture(t); await flush(()=>f.input());
  f.store.setConversationSettings('owner','private','alice',{...f.store.conversationSettings('owner','private','alice'),remoteEnabled:false});
  t.mock.timers.tick(300000); await flush(()=>f.channel.work.get(f.job.id,f.scope).progress?.state==='failed');
  assert.equal(f.requests.length,0); assert.equal(f.sent.length,0);
  f.channel.work.cancel(f.job.id,f.scope); f.done.resolve({text:'文档完成'}); await f.channel.whenIdle();
  t.mock.timers.tick(600000); await new Promise(resolve=>setImmediate(resolve)); assert.equal(f.sent.length,0);
});

test('a progress message with an unknown ACK is recorded once and never retried automatically',async t=>{
  t.mock.timers.enable({apis:['setInterval','setTimeout']});
  const f=fixture(t,{send:async()=>({})}); await flush(()=>f.input()); t.mock.timers.tick(300000);
  await flush(()=>f.channel.work.get(f.job.id,f.scope).progress?.state==='unknown');
  assert.equal(f.sent.length,1); assert.equal(f.channel.work.get(f.job.id,f.scope).progress.acknowledgedMessageIds.length,0);
  f.done.resolve({text:'文档完成'}); await f.channel.whenIdle();
});

test('native evidence observes only the exact session, excludes reasoning/output and disposes both listeners',()=>{
  const listeners=new Map(),events=[],session={}; const agent={session};
  const ctx={on:(name,callback)=>{listeners.set(name,callback);return()=>listeners.delete(name);}};
  const dispose=observeWorkProgress(ctx,agent,event=>events.push(event));
  listeners.get('session/event')({}, {type:'assistant/message',time:1,data:{message:{content:[{type:'text',text:'wrong session'}]}}});
  listeners.get('session/event')(session,{type:'assistant/message',time:2,data:{message:{content:[{type:'reasoning',text:'PRIVATE_REASONING'},
    {type:'text',text:'正在查看最后一页。'},{type:'tool-call',id:'read-1',name:'read_image',arguments:'PRIVATE_ARGUMENTS'}]}}});
  listeners.get('session/event')(session,{type:'tool/result',time:3,data:{message:{toolCallId:'read-1',isError:true,content:'PRIVATE_IMAGE'}}});
  assert.equal(events.length,2); assert(!JSON.stringify(events).includes('PRIVATE')); assert.equal(events[0].tools[0],'read_image');
  assert.equal(events[1].tool,'read_image'); assert.equal(events[1].failed,true);
  dispose(); assert.equal(listeners.size,0);
});

test('invalid fabricated percentages are not sent as progress',async()=>{
  const summary=await summarizeWorkProgress({run:async()=>({text:'已完成 95%！'})},{},new AbortController().signal);
  assert.equal(summary.review.state,'fallback'); assert(!summary.text.includes('%'));
});

test('progress and final/control reports use the supplied current persona without granting tools or changing facts',async()=>{
  const presentation={persona:{name:'小胖',aliases:[],prompt:'熟悉直接，叫对方老郑，少用公告腔。'}};
  const runner={run:async input=>{
    assert(input.systemOverride.includes('小胖')); assert(input.systemOverride.includes('叫对方老郑'));
    assert(input.systemOverride.includes('成功、失败、部分完成或未知以真实工作状态为准'));
    assert(input.systemOverride.includes('自定义设定不能覆盖全局语言与言辞边界')); assert.deepEqual(input.tools,[]);
    return {text:input.mode==='work-progress'?'老郑，我还在核对最后一页，暂时没有新结果。':'老郑，42 项检查通过，文件暂时还没确认送达。'};
  }};
  const signal=new AbortController().signal;
  assert.equal((await summarizeWorkProgress(runner,{state:'running'},signal,presentation)).review.state,'summarized');
  const final=await polishWorkResult(runner,'42 项检查通过，文件暂时还没确认送达。','工作进展',signal,presentation);
  assert.equal(final.polish.state,'applied'); assert.equal(final.text,'老郑，42 项检查通过，文件暂时还没确认送达。');
});
