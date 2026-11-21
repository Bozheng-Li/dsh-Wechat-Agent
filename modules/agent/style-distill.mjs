import { ChannelError } from '../../shared/contracts.mjs';
import { conversationAuthorized, personAuthorized } from '../../shared/authorization.mjs';
import { styleProfile, describeStyle } from './style-profile.mjs';
import { styleSampleEvidence, assistantTask } from './style-summary.mjs';

const MAX_PEERS = 60;
const MAX_ROWS = 1200;
const at = row => Number(row?.time ?? row?.updatedAt ?? row?.lastMessageAt) || 0;
const personAllowed = (store, accountId, senderId) =>
  !store.data.groupMemberExclusions?.[accountId]?.excludedPersonIds?.includes(senderId) && personAuthorized(store, accountId, senderId);

function authorizedPeers(store, accountId) {
  const all = store.conversations(accountId).filter(peer => peer.accountId === accountId && conversationAuthorized(store, peer))
    .sort((a,b) => at(b)-at(a));
  return { peers: all.slice(0,MAX_PEERS), omittedPeers: Math.max(0,all.length-MAX_PEERS) };
}

export function distillCandidates({ store, memory, accountId }) {
  const people = new Map(), { peers, omittedPeers } = authorizedPeers(store,accountId);
  for (const peer of peers) {
    let entries;
    try { entries = memory.view(peer).entries ?? []; } catch { continue; }
    for (const entry of [...entries].sort((a,b) => at(b)-at(a)).slice(0,MAX_ROWS)) {
      if (entry.direction !== 'incoming' || !personAllowed(store,accountId,entry.senderId) || !entry.text?.trim() || entry.mediaOnly) continue;
      const person = people.get(entry.senderId) ?? { senderId: entry.senderId, name: entry.senderName || entry.senderId,
        count: 0, chats: [], omittedPeers, lastMessageAt: at(entry) };
      if (at(entry) >= person.lastMessageAt && entry.senderName) { person.name = entry.senderName; person.lastMessageAt = at(entry); }
      person.count++;
      const chat = person.chats.find(row => row.peerId === peer.peerId && row.chatType === peer.chatType);
      if (chat) chat.count++;
      else person.chats.push({ chatType: peer.chatType, peerId: peer.peerId, name: peer.name || peer.peerId, count: 1 });
      people.set(entry.senderId,person);
    }
  }
  return [...people.values()].sort((a,b) => b.count-a.count);
}

/** Reading chat samples needs current authorization; saving the resulting editable text does not expire. */
export function distillPersona({ store, memory, accountId, senderId, name, title, warmth = 'balanced' }) {
  if (typeof senderId !== 'string' || !senderId) throw new ChannelError('PERSONA_SAMPLE_MISSING', '请选择要学习的人');
  if (!personAllowed(store,accountId,senderId)) throw new ChannelError('PERSONA_SOURCE_REVOKED', '这位人物目前未授权，无法读取聊天记录。');
  const rows = [], { peers, omittedPeers } = authorizedPeers(store,accountId);
  const current = store.persona(), exclude = [current?.name,...(current?.aliases ?? [])];
  const names = new Set([senderId]);
  for (const [peerIndex,peer] of peers.entries()) {
    let entries;
    try { entries = memory.view(peer).entries ?? []; } catch { continue; }
    for (const item of entries) if (item.senderName) names.add(item.senderName);
    for (const [index,entry] of entries.entries()) {
      if (entry.direction !== 'incoming' || entry.senderId !== senderId || !entry.text?.trim() || entry.mediaOnly) continue;
      if (assistantTask(entry.text.trim(),exclude)) continue;
      rows.push({ direction: 'incoming', text: entry.text, time: entry.time, senderId, senderName: entry.senderName, chatType: peer.chatType,
        scope: { accountId, chatType: peer.chatType, peerId: peer.peerId },
        conversation: '会话' + (peerIndex+1), context: entries.slice(Math.max(0,index-2),index)
          .filter(item=>item.text?.trim() && (item.direction === 'outgoing' || personAllowed(store,accountId,item.senderId))).map(item => ({
          speaker: item.senderId === senderId ? '目标人物' : item.direction === 'outgoing' ? '本账号' : '其他成员', text: item.text,
        })) });
    }
  }
  rows.sort((a,b) => at(b)-at(a));
  const latest = rows.slice(0,MAX_ROWS), profile = styleProfile(latest);
  const privacyEntities = [...names, ...peers.flatMap(peer=>[peer.name,peer.peerId])].filter(value=>typeof value==='string' && value.length>=2);
  const { samples, sampling } = styleSampleEvidence(latest,{exclude,entities:privacyEntities});
  if (!samples.length) throw new ChannelError('PERSONA_SAMPLE_EMPTY', '这位人物还没有可供总结的文字发言。');
  sampling.omitted += Math.max(0,rows.length-latest.length); sampling.total = rows.length; sampling.omittedPeers = omittedPeers;
  const assistant = name || current?.name || '微信助手', target = latest.find(row=>row.senderName)?.senderName || senderId;
  return { accountId, senderId, target, profile, warmth, summary: describeStyle(profile), samples, sampling, privacyEntities,
    suggestedName: title || (assistant + '·' + target + '的说话方式'),
    persona: { name: assistant, aliases: [], prompt: '', personaMode: 'standard' } };
}
