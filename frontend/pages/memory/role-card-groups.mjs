import { compareRoleCardPeople } from '../../../shared/role-card.mjs';

export function roleCardGroups(people, audience, query = '') {
  const ready = audience?.source === 'wechat-contacts-live' && audience.membershipComplete === true;
  const labels = ready ? audience.labels : [], byLabel = new Map(labels.map(row => [row.id, row]));
  const contacts = new Map(ready ? audience.contacts.map(row => [row.id, row]) : []);
  const memberships = new Map(people.map(person => [person.personId,
    [...new Set(contacts.get(person.personId)?.labelIds || [])].filter(id => byLabel.has(id))]));
  const search = query.trim().toLocaleLowerCase();
  const filtered = people.filter(person => [person.name, person.personId, ...(person.aliases || []),
    ...Object.values(person.preview || {}), ...memberships.get(person.personId).map(id => byLabel.get(id).name),
    ready && !memberships.get(person.personId).length ? '未标签' : '']
    .join('\n').toLocaleLowerCase().includes(search)).sort(compareRoleCardPeople);
  if (!ready) return { filtered, groups: filtered.length ? [{ id: 'pending', name: '标签待读取', people: filtered }] : [] };
  const groups = labels.map(label => ({ id: label.id, name: label.name,
    people: filtered.filter(person => memberships.get(person.personId).includes(label.id)) }));
  groups.push({ id: 'untagged', name: '未标签', people: filtered.filter(person => !memberships.get(person.personId).length) });
  return { filtered, groups: groups.filter(group => group.people.length) };
}
