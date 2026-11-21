import { compareRoleCardPeople } from '../../../shared/role-card.mjs';

const audienceReady = audience => ['wechat-role-labels-live', 'wechat-contacts-live'].includes(audience?.source) &&
  audience.membershipComplete === true && Array.isArray(audience.contacts) && Array.isArray(audience.labels);

export function rolePersonDisplayName(person, audience) {
  if (person?.name && person.name !== person.personId) return person.name;
  const contact = audienceReady(audience) ? audience.contacts.find(row => row.id === person?.personId) : undefined;
  return contact?.remark || contact?.nickname || contact?.name || person?.name || person?.personId || '';
}

export function roleCardGroups(people, audience, query = '') {
  const scoped = audience?.source === 'wechat-role-labels-live';
  const ready = audienceReady(audience);
  const labels = ready ? audience.labels : [], byLabel = new Map(labels.map(row => [row.id, row]));
  const contacts = new Map(ready ? audience.contacts.map(row => [row.id, row]) : []);
  const displayPeople = people.map(person => ({ ...person, name: rolePersonDisplayName(person, audience) }));
  const memberships = new Map(people.map(person => [person.personId,
    [...new Set(contacts.get(person.personId)?.labelIds || [])].filter(id => byLabel.has(id))]));
  const search = query.trim().toLocaleLowerCase();
  const filtered = displayPeople.filter(person => [person.name, person.personId, ...(person.aliases || []),
    ...Object.values(person.preview || {}), ...memberships.get(person.personId).map(id => byLabel.get(id).name),
    ready && (!scoped || contacts.has(person.personId)) && !memberships.get(person.personId).length ? '未标签' : '']
    .join('\n').toLocaleLowerCase().includes(search)).sort(compareRoleCardPeople);
  if (!ready) return { filtered, groups: filtered.length ? [{ id: 'pending', name: '标签待读取', people: filtered }] : [] };
  const groups = labels.map(label => ({ id: label.id, name: label.name,
    people: filtered.filter(person => memberships.get(person.personId).includes(label.id)) }));
  groups.push({ id: 'untagged', name: '未标签', people: filtered.filter(person => (!scoped || contacts.has(person.personId)) && !memberships.get(person.personId).length) });
  if (scoped) groups.push({ id: 'pending', name: '标签待读取', people: filtered.filter(person => !contacts.has(person.personId)) });
  return { filtered, groups: groups.filter(group => group.people.length) };
}
