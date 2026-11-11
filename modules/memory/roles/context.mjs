import { projectMemory } from './retrieval.mjs';
import { conversationPeople } from './people.mjs';
import { factEvidence } from './references.mjs';

export function roleMemoryData(memory, input, { document, history = [], persona, text = '', beforeTime } = {}) {
  const scope = memory.selector(input), doc = document || memory.document(scope.accountId),
    at = memory.now(), cutoff = Number.isFinite(beforeTime) ? beforeTime : at,
    section = doc.sections.find(section => section.key === scope.key),
    facts = (section?.facts || []).filter(fact => Number.isFinite(fact.createdAt) && fact.createdAt <= cutoff),
    speaker = { id: input.senderId || (scope.chatType === 'private' ? scope.peerId : ''), name: input.senderName || input.sender || '' },
    people = conversationPeople(memory.store, scope, { entries: history, facts, speaker, beforeTime: cutoff });
  let saved;
  try { saved = memory.store.roleCards?.view(scope); } catch { /* The owner sees the card error; global expression remains usable. */ }
  return { scope, now: at, query: text, history, speaker, people, persona: persona || memory.store.conversationPersona(scope.accountId, scope.chatType, scope.peerId),
    personaHasCard: true, card: saved ? { ...saved.card, scope, ownerAuthored: true } : null,
    roleId: saved?.roleId || memory.store.roleCards?.identity(scope),
    globalNotes: doc.globalNotesExpired ? '' : doc.globalNotes,
    facts: facts.map(fact => ({ ...fact, scope, subjectId: fact.subjectId || 'conversation',
      ...(fact.reviewedAt > cutoff && fact.decision === 'accept' ? { state: 'pending', confirmation: undefined } : {}) })),
  };
}

export function projectConversationRole(memory, input, options) {
  const data = roleMemoryData(memory, input, options), result = projectMemory(data);
  // Older Markdown facts remain in their original conversation. They have no
  // reliable person id and must not silently become the current speaker's card.
  const legacy = memory.usableFacts(data.facts).filter(fact => fact.subjectId === 'conversation');
  return { ...result, roleId: data.roleId, legacyMemory: legacy.map(fact => JSON.stringify({
    id: fact.id, who: '原会话资料，人物尚未确认；不能默认属于当前发言者', text: fact.text,
    sources: fact.sources.map(({ senderId, sender, quote }) => ({ senderId, sender, quote })),
  })).join('\n') };
}

export function roleFactLine(fact, includeSources = false) {
  return JSON.stringify({ id: fact.id,
    who: fact.subjectId === 'group' ? '本群共同事项' : fact.subjectId && fact.subjectId !== 'conversation'
      ? `${fact.subjectName || fact.subjectId}[${fact.subjectId}]` : '原会话资料，人物尚未确认；不能默认属于当前发言者',
    ...factEvidence(fact),
    ...(fact.confirmation?.by === 'owner' ? { status: '管理员已确认适用；引文中的未核实限定是采集时状态' } : {}),
    ...(includeSources ? { sources: fact.sources.map(({ senderId, sender, time, quote }) => ({ senderId, sender, time, quote })) } : {}),
  });
}
