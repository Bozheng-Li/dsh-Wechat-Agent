import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  StateStore, WechatChannel, resolveMomentsQuery, momentsTool, momentsWriteTools, momentsLikeRequestTool
} from '../lib/testing.js';





const scope = { accountId:'subject-bot', chatType:'private', peerId:'subject-speaker', senderId:'subject-speaker', senderName:'当前朋友' };
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-moments-subject-')), store=new StateStore(root);
  store.configure(scope.accountId,{enabled:true,privatePeers:[scope.peerId],groups:[],prompt:''});
  const config=store.config.snapshot(store.data); config.remote={globalAdminIds:[scope.senderId]}; store.config.commit(config);
  store.setConversationSettings(scope.accountId,scope.chatType,scope.peerId,{...store.conversationSettings(scope.accountId,scope.chatType,scope.peerId),remoteEnabled:true});
  const reads=[],writes=[], status={online:true,account:{id:scope.accountId,nickname:'机器人名字'},momentsReadReady:true,momentsWriteReady:true};
  const people=[{id:scope.senderId,name:scope.senderName},{id:'subject-li',name:'小李'}];
  const authors={'101':scope.accountId,'102':scope.senderId,'103':'subject-li'};
  const post=(id)=>({id,author:{userId:authors[id],nickname:'动态作者'},createdAt:1700000000+Number(id),text:'真实读取内容',deleted:false,contentAvailable:true,likedByCurrentAccount:false});
  const transport={status:()=>status,call:async()=>({privatePeers:people}),
    readMoments:async request=>{reads.push(request);const id=request.query.postId??Object.keys(authors).find(id=>authors[id]===request.query.userId);
      return {accountId:scope.accountId,action:request.query.action,userId:request.query.userId,source:'wechat-sns-live',items:id?[post(id)]:[],nextCursor:null};},
    writeMoments:async request=>{writes.push(request);return {accountId:scope.accountId,action:'like',postId:request.query.postId,liked:true,delivery:'server-ack'};}};
  const channel=new WechatChannel({store,transport,runner:{run:async()=>({text:''})}}),signal=new AbortController().signal;
  t.after(async()=>{await channel.close();const resolved=fs.realpathSync(root);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert.match(path.basename(resolved),/^wechat-moments-subject-/);fs.rmSync(resolved,{recursive:true,force:true});});
  return {channel,transport,reads,writes,people,signal};
}

test('semantic role selection keeps speaker, executing account and named contact distinct without guessing pronouns',async t=>{
  const f=fixture(t);
  for(const [subject,user,expected] of [['speaker',undefined,scope.senderId],['account',undefined,scope.accountId],['contact','小李','subject-li']]) {
    const query=await resolveMomentsQuery(f.transport,{action:'user',subject,...(user?{user}:{})},scope,f.signal,()=>{});
    assert.equal(query.userId,expected);assert.equal(query.subject,undefined);
  }
  for(const user of ['我','你','自己','他','她']) await assert.rejects(resolveMomentsQuery(f.transport,{action:'user',user},scope,f.signal,()=>{}),{code:'MOMENTS_SUBJECT_REQUIRED'});
  for(const user of ['我','发起人','sender','机器人','account']) {
    await assert.rejects(resolveMomentsQuery(f.transport,{action:'user',subject:'contact',user},scope,f.signal,()=>{}),{code:'MOMENTS_SUBJECT_INVALID'});
    await assert.rejects(f.channel.moments.likeRecent({subject:'contact',user},scope,'alias-'+user,'帮我给这位朋友的朋友圈点赞',f.signal),{code:'MOMENTS_SUBJECT_INVALID'});
  }
  await assert.rejects(resolveMomentsQuery(f.transport,{action:'user'},scope,f.signal,()=>{}),{code:'MOMENTS_SUBJECT_REQUIRED'});
  await assert.rejects(resolveMomentsQuery(f.transport,{action:'user',subject:'speaker',user:'小李'},scope,f.signal,()=>{}),{code:'MOMENTS_SUBJECT_INVALID'});
  assert.equal(f.reads.length,0);assert.equal(f.writes.length,0);
});

test('latest-like subject comes from explicit contextual role rather than the beneficiary phrase',async t=>{
  const f=fixture(t);
  for(const [text,args,id] of [
    ['你帮我点赞我第一条朋友圈看看',{subject:'speaker'},'102'],
    ['帮我给你自己的最新一条朋友圈点赞',{subject:'account'},'101'],
    ['帮我给小李的最新一条朋友圈点赞',{subject:'contact',user:'小李'},'103'],
    ['给他最新那条朋友圈点赞',{subject:'contact',user:'小李'},'103'],
  ]) {
    const value=await f.channel.moments.likeRecent(args,scope,'semantic-'+text,text,f.signal);
    assert.equal(value.results[0].postId,id);assert.equal(f.writes.at(-1).query.postId,id);
  }
});

test('generic like verifies the selected author and blocks a robot post when the requester was intended',async t=>{
  const f=fixture(t),tool=momentsWriteTools({subjects:f.channel.moments.subjects(scope),write:(query,signal)=>f.channel.moments.write(query,scope,'generic-semantic',signal)})[0];
  const mismatch=JSON.parse(await tool.execute({postId:'101',subject:'speaker'},{signal:f.signal}));
  assert.equal(mismatch.code,'MOMENTS_SUBJECT_MISMATCH');assert.equal(mismatch.delivery,'not-sent');assert.equal(f.writes.length,0);
  const success=JSON.parse(await tool.execute({postId:'102',subject:'speaker'},{signal:f.signal}));
  assert.equal(success.ok,true);assert.equal(f.writes.length,1);assert.equal(f.writes[0].query.subject,undefined);
  const missing=JSON.parse(await tool.execute({postId:'101'},{signal:f.signal}));assert.equal(missing.ok,false);assert.equal(f.writes.length,1);
  const recent=momentsLikeRequestTool({like:()=>{throw Error('must not execute without a subject');}});
  assert.equal(JSON.parse(await recent.execute({},{signal:f.signal})).code,'MOMENTS_SUBJECT_REQUIRED');
});

test('chat and work tool descriptions carry verified role identities and reject nickname ambiguity',async t=>{
  const f=fixture(t),subjects=f.channel.moments.subjects(scope);
  for(const tool of [momentsTool({subjects,read:()=>{}}),momentsLikeRequestTool({subjects,like:()=>{}}),...momentsWriteTools({subjects,write:()=>{}}).slice(0,1)]) {
    assert(tool.description.includes(scope.senderId));assert(tool.description.includes(scope.accountId));
  }
  f.people.push({id:'subject-other-li',name:'小李'});
  await assert.rejects(f.channel.moments.read({action:'user',subject:'contact',user:'小李'},scope,f.signal),{code:'MOMENTS_USER_AMBIGUOUS'});
  assert.equal(f.reads.length,0);
});
