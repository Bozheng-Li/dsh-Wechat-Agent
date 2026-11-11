import { createHash } from 'node:crypto';
import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { momentsId } from '../../shared/moments.mjs';
import { identity } from '../../backend/storage/keys.mjs';
import { readPrompt } from '../../prompts/loader.mjs';
import { personaInstructions } from '../../prompts/reply/compose.mjs';
import { publicLanguageInstructions } from '../../prompts/reply/language.mjs';
import { readInteractionPool, readInteractionDetail, interactionContentHash } from './interaction-read.mjs';
import { readMomentsImageContext } from './image-context.mjs';

const key = (accountId, postId, commentId = '') => identity([accountId, postId, commentId]);
const blocked = state => ['sent', 'existing', 'sending', 'unknown', 'rejected', 'skipped'].includes(state);
const fail = message => { throw new ChannelError('MOMENTS_REPLY_READ', message); };
const commentData = row => ({ id: row.id, userId: row.userId, text: row.text, createdAt: row.createdAt,
  replyToCommentId: row.replyToCommentId, replyToUserId: row.replyToUserId });
const threadHash = (post, own, incoming) => createHash('sha256').update(JSON.stringify([
  interactionContentHash(post), commentData(own), commentData(incoming)])).digest('hex');

export function validateFriendReplies(data) {
  if (!data.friendPosts || typeof data.friendPosts !== 'object' || Array.isArray(data.friendPosts)) throw Error('Invalid tracked posts');
  for (const [id, row] of Object.entries(data.friendPosts)) if (!row || !momentsId(row.id) || typeof row.accountId !== 'string' ||
      !row.accountId || id !== key(row.accountId, row.id) || !Number.isSafeInteger(row.commentedAt) || row.commentedAt < 0) throw Error('Invalid tracked post ownership');
  for (const [id, row] of Object.entries(data.replies)) if (row.origin === 'friend') {
    if (id !== key(row.accountId, row.postId, row.commentId) || typeof row.postAuthorId !== 'string' || !row.postAuthorId || row.postAuthorId === row.accountId ||
        !momentsId(row.ourComment?.id) || row.ourComment.userId !== row.accountId || row.incomingReply?.id !== row.commentId ||
        typeof row.ourComment.text !== 'string' || typeof row.incomingReply.text !== 'string' ||
        !row.incomingReply.userId || row.incomingReply.userId === row.accountId || row.incomingReply.replyToCommentId !== row.ourComment.id ||
        row.incomingReply.replyToUserId && row.incomingReply.replyToUserId !== row.accountId ||
        !/^[a-f0-9]{64}$/.test(row.threadHash)) throw Error('Invalid friend reply ownership');
    if (row.state === 'sent' && (!momentsId(row.replyId) || row.replyToUserId !== row.incomingReply.userId ||
        !['server-ack','verified-existing'].includes(row.delivery))) throw Error('Invalid friend reply receipt');
  }
}

async function commentsFor(channel, context, postId, signal, check) {
  const comments = [], ids = new Set(), cursors = new Set(); let cursor, expected;
  for (let page = 0; page < 10; page++) {
    check();
    const result = await channel.transport.readMoments({ accountId: context.accountId, scopeKey: context.scopeKey,
      query: { action: 'comments', postId, limit: 50, ...(cursor ? { cursor } : {}) } }, signal);
    check();
    if (result?.accountId !== context.accountId || result.source !== 'wechat-sns-live' || result.action !== 'comments' || result.postId !== postId ||
        !Array.isArray(result.items) || result.items.length > 50 || !Number.isSafeInteger(result.visibleCommentEntries) || result.visibleCommentEntries < 0 ||
        result.items.some(row => !row || typeof row.userId !== 'string' || !row.userId || typeof row.text !== 'string' || typeof row.deleted !== 'boolean' ||
          row.id !== undefined && !momentsId(row.id) || row.replyToCommentId !== undefined && !momentsId(row.replyToCommentId) ||
          row.replyToUserId !== undefined && (typeof row.replyToUserId !== 'string' || !row.replyToUserId)))
      fail('评论区的账号、动态或内容不完整，未自动回复');
    if (expected === undefined) expected = result.visibleCommentEntries;
    else if (result.visibleCommentEntries !== expected) fail('评论区分页内容发生变化，留待下次读取');
    for (const row of result.items) {
      if (row.id && ids.has(row.id)) fail('评论区包含重复编号，未自动回复');
      if (row.id) ids.add(row.id); comments.push(row);
    }
    if (!result.nextCursor) {
      if (expected !== comments.length) fail('评论区尚未完整返回，未自动回复');
      return comments;
    }
    cursor = result.nextCursor;
    if (typeof cursor !== 'string' || cursors.has(cursor)) fail('评论区分页没有推进，未自动回复');
    cursors.add(cursor);
  }
  fail('评论区超过本轮读取范围，未自动回复');
}

// Match an exact parent written by the current account. A nickname, mention,
// nearby comment or reply to another participant cannot establish ownership.
export function friendReplyParent(accountId, incoming, comments) {
  if (!momentsId(incoming?.id) || !incoming.userId || incoming.userId === accountId || incoming.deleted ||
      !momentsId(incoming.replyToCommentId) || incoming.replyToUserId && incoming.replyToUserId !== accountId) return null;
  return comments.find(row => row.id === incoming.replyToCommentId && row.userId === accountId && !row.deleted && typeof row.text === 'string') ?? null;
}
const alreadyReplied = (comments, accountId, incoming) => comments.find(row => !row.deleted && row.userId === accountId &&
  row.replyToCommentId === incoming.id && (!row.replyToUserId || row.replyToUserId === incoming.userId));

function watchedPosts(manager, accountId, posts, threshold) {
  const known = new Map();
  for (const row of Object.values(manager.data.friendPosts)) if (row.accountId === accountId && row.commentedAt >= threshold && !manager.data.posts[key(accountId,row.id)])
    known.set(row.id, {id:row.id,commentedAt:row.commentedAt});
  for (const run of Object.values(manager.interactions.data.runs)) if (run.accountId === accountId)
    for (const row of run.rows) if (row.createdAt*1000 >= threshold && ['succeeded','existing'].includes(row.comment.state) && row.userId !== accountId && !known.has(row.postId))
      known.set(row.postId,{id:row.postId,commentedAt:run.updatedAt??run.createdAt});
  const ordered=[...known.values()].sort((a,b)=>b.commentedAt-a.commentedAt);
  for (const post of posts) if (!known.has(post.id)) ordered.push(post);
  return ordered.slice(0,100);
}

async function generateReply(manager, accountId, rule, row, post, context, signal, check) {
  const {channel}=manager; let imageContext;
  if (post.imageCount>0) {
    imageContext=await readMomentsImageContext(channel,{accountId,scopeKey:context.scopeKey,postId:post.id,expectedHash:interactionContentHash(post)},signal,check);
    if(!imageContext.complete)throw new ChannelError('MOMENTS_REPLY_IMAGE','配图未能完整读取，已跳过这条回复');
  }
  check();
  const response=await channel.runner.run({mode:'moments-reply',tools:[],signal:AbortSignal.any([signal,AbortSignal.timeout(45000)]),
    systemOverride:[readPrompt('moments/friend-reply.md'),personaInstructions(channel.store.persona()),publicLanguageInstructions()].join('\n\n'),
    text:JSON.stringify({currentAccountId:accountId,post:{id:post.id,author:post.author,text:post.text,createdAt:post.createdAt},
      ourComment:row.ourComment,incomingReply:row.incomingReply,
      imageContext:imageContext?.images.map(image=>({index:image.index,description:image.description}))??[],instruction:rule.settings.replyInstructions})});
  check();let value;
  try{value=JSON.parse(String(response?.text??'').trim().replace(/^```(?:json)?\s*\n?/i,'').replace(/\n?```$/,'').trim());}catch{}
  if(!value||Array.isArray(value)||Object.keys(value).some(k=>!['text','skipReason'].includes(k))||
      typeof value.text!=='string'||value.text.length>500||typeof value.skipReason!=='string'||value.skipReason.length>200||
      !!value.text.trim()===!!value.skipReason.trim())throw new ChannelError('MOMENTS_REPLY_CONTENT','未生成有效的接续回复，未提交微信');
  return {text:value.text.trim(),skipReason:value.skipReason.trim(),imageContext};
}

export async function runFriendReplies(manager, accountId, rule, signal, check, counts) {
  const {channel}=manager, context=manager.interactions.context(accountId), threshold=channel.now()-rule.settings.lookbackDays*86400000;
  const since=rule.settings.includeExisting?threshold:Math.max(rule.friendEnabledAt,threshold);
  let posts=[];
  try {
    ({posts}=await readInteractionPool(channel,{source:'timeline',mode:'manual',poolSize:100,lookbackDays:rule.settings.lookbackDays},context,signal,check));
  }catch(error){check();counts.readFailed++;counts.lastError=publicError(error,'好友动态未能读取').message;}
  for(const observed of watchedPosts(manager,accountId,posts,threshold)){
    check();if(counts.attempted>=rule.settings.maxFriendRepliesPerRun)break;
    let post,comments;
    try{
      post=await readInteractionDetail(channel,context,observed.id,signal,check);
      if(post.deleted||!post.contentAvailable||post.author.userId===accountId||post.createdAt*1000<threshold||post.createdAt*1000>channel.now()+60000||
          observed.author&&observed.author.userId!==post.author.userId)continue;
      comments=await commentsFor(channel,context,post.id,signal,check);counts.scanned+=comments.length;
    }catch(error){check();counts.readFailed++;counts.lastError=publicError(error,'评论区未能读取').message;continue;}
    const own=comments.filter(row=>row.userId===accountId&&!row.deleted);
    if(own.length){
      const watched=key(accountId,post.id),commentedAt=Math.max(post.createdAt*1000,...own.map(row=>Number.isSafeInteger(row.createdAt)?row.createdAt*1000:0));
      if(!manager.data.friendPosts[watched]||manager.data.friendPosts[watched].commentedAt<commentedAt){manager.data.friendPosts[watched]={accountId,id:post.id,commentedAt};manager.save();}
    }
    const incoming=comments.filter(row=>friendReplyParent(accountId,row,comments)&&Number.isSafeInteger(row.createdAt)&&
      row.createdAt*1000>=since&&row.createdAt*1000<=channel.now()+60000).sort((a,b)=>a.createdAt-b.createdAt||(BigInt(a.id)<BigInt(b.id)?-1:1));
    for(const reply of incoming){
      check();if(counts.attempted>=rule.settings.maxFriendRepliesPerRun)break;
      const id=key(accountId,post.id,reply.id),previous=manager.data.replies[id];
      if(blocked(previous?.state)){counts.skipped++;continue;}
      const parent=friendReplyParent(accountId,reply,comments);
      const row={origin:'friend',accountId,postId:post.id,postAuthorId:post.author.userId,postNickname:post.author.nickname??'',postText:post.text,
        commentId:reply.id,author:reply.nickname||reply.userId,commentText:reply.text,ourComment:commentData(parent),incomingReply:commentData(reply),
        threadHash:threadHash(post,parent,reply),text:'',state:'generating',updatedAt:channel.now()};
      const existing=alreadyReplied(comments,accountId,reply);
      if(existing){
        manager.data.replies[id]={...row,state:'existing',replyId:existing.id,text:existing.text,error:'评论区已有我方回复，已跳过'};
        manager.save();counts.skipped++;continue;
      }
      counts.attempted++;manager.data.replies[id]=row;manager.save();let submitting=false,confirmed=false;
      try{
        const generated=await generateReply(manager,accountId,rule,row,post,context,signal,check);check();
        // A manual reply can arrive while the model is running. Keep its real
        // receipt, including the sender and confirmed comment ID.
        if(blocked(manager.data.replies[id]?.state)){counts.skipped++;continue;}
        row.text=generated.text;if(generated.imageContext)row.imageContext=generated.imageContext;
        if(generated.skipReason){row.state='skipped';row.error=generated.skipReason;counts.skipped++;manager.save();continue;}
        const latest=await readInteractionDetail(channel,context,post.id,signal,check);
        const fresh=await commentsFor(channel,context,post.id,signal,check),target=fresh.find(item=>item.id===reply.id),original=friendReplyParent(accountId,target,fresh);
        if(blocked(manager.data.replies[id]?.state)){counts.skipped++;continue;}
        if(latest.deleted||!latest.contentAvailable||latest.author.userId!==row.postAuthorId||!original||threadHash(latest,original,target)!==row.threadHash){
          row.state='skipped';row.error='动态、原评论或回复关系已变化，本次未提交';counts.skipped++;manager.save();continue;
        }
        const answered=alreadyReplied(fresh,accountId,target);
        if(answered){
          Object.assign(row,{state:'existing',replyId:answered.id,text:answered.text,error:'已回复这条评论，本次未重复提交'});
          counts.skipped++;manager.save();continue;
        }
        check();row.state='sending';row.updatedAt=channel.now();manager.save();submitting=true;
        const result=await channel.moments.writeOwner({action:'comment',postId:post.id,replyToCommentId:reply.id,text:row.text},accountId,
          'moments-friend-auto:'+post.id+':'+reply.id,signal,check);
        if(result.replyToUserId!==reply.userId){
          manager.data.replies[id]={...row,state:'unknown',error:'回复回执的接收者不匹配，结果不明，未重发'};manager.save();
          throw new ChannelError('MOMENTS_RESULT_UNKNOWN','回复回执的接收者不匹配，结果不明，未重发');
        }
        manager.data.replies[id]={...row,state:'sent',replyId:result.commentId,replyToUserId:result.replyToUserId,delivery:result.delivery,error:null,updatedAt:channel.now()};
        manager.save();counts.replied++;confirmed=true;check();
      }catch(error){
        if(blocked(manager.data.replies[id]?.state)&&manager.data.replies[id]!==row){
          const saved=manager.data.replies[id];
          if(saved.state==='sent'){if(submitting&&!confirmed)counts.replied++;else if(!submitting)counts.skipped++;}
          else if(submitting&&saved.state==='unknown')counts.unknown++;
          else counts.skipped++;
          check();if(submitting&&saved.state!=='sent')return counts;continue;
        }
        const rejected=['not-sent','rejected'].includes(error?.details?.snsDelivery);
        const state=submitting?rejected?'rejected':'unknown':'failed';
        manager.data.replies[id]={...row,state,error:publicError(error,'本条回复未完成').message,updatedAt:channel.now()};manager.save();
        if(state==='unknown')counts.unknown++;else counts.failed++;
        check();if(submitting)return counts;
      }
    }
  }
  return counts;
}
