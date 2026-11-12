import { mentionedPeople, nameMentioned, referenceMatches } from './references.mjs';

const instant = value => Number(value) < 1e12 ? Number(value) * 1000 : Number(value);

/** Names come from this conversation's observed authors, never from a model. */
export function conversationPeople(store, scope, { entries = [], facts = [], speaker, beforeTime = Infinity } = {}) {
  const people = new Map();
  const add = (id, name, reference) => {
    if (typeof id !== 'string' || !id || id === scope.accountId || ['group', 'conversation'].includes(id)) return;
    const value = String(name || id).slice(0, 80), previous = people.get(id);
    people.set(id, { accountId: scope.accountId, id, name: value,
      aliases: [...new Set([...(previous?.aliases || []), previous?.name].filter(alias => alias && alias !== value))].slice(-8),
      ...((reference || previous?.reference) ? { reference: reference || previous.reference } : {}) });
  };
  if (scope.chatType === 'private') {
    const peer = store.conversations(scope.accountId).find(row => row.chatType === scope.chatType && row.peerId === scope.peerId);
    add(scope.peerId, peer?.name);
  }
  for (const fact of facts) {
    if (fact.subjectId) add(fact.subjectId, fact.subjectName, fact.subjectReference);
    for (const source of fact.sources || []) add(source.senderId, source.sender);
  }
  for (const entry of entries) {
    if (entry.direction !== 'incoming' || instant(entry.time) > beforeTime) continue;
    add(entry.senderId, entry.senderName || entry.sender);
  }
  if (speaker) add(speaker.id, speaker.name);
  for (const person of people.values()) if (person.reference) {
    const owner = people.get(person.reference.ownerId);
    if (owner) person.aliases = [...new Set([...person.aliases, owner.name + '的' + person.reference.relationship])];
  }
  return [...people.values()];
}

export function extractionPeople(people, sources, scope) {
  const authors = new Set(sources.map(source => source.senderId));
  const text = sources.map(source => source.text).join('\n');
  const all = new Map([...people, ...mentionedPeople(people, sources, scope)].map(person => [person.id, person]));
  return [...all.values()].filter(person => authors.has(person.id) || [person.name, ...person.aliases].some(name => nameMentioned(text, name)) ||
    sources.some(source => referenceMatches(person, source.text, source.senderId)));
}

