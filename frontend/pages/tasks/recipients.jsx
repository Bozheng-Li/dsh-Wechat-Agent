import { useEffect, useState } from 'react';
import { peerId, peerType, searchText } from "../../shared/conversations.mjs";
import { Button, Alert } from "../../components/automation-ui.jsx";

export function TaskRecipients({ rpc, accountId, peer, value, onChange, disabled }) {
  const [members, setMembers] = useState([]),
    [query, setQuery] = useState(''),
    [error, setError] = useState('');
  const [loading, setLoading] = useState(false),
    [loaded, setLoaded] = useState(false),
    [revision, setRevision] = useState(0);
  const groupId = peer && peerType(peer) === 'group' ? peerId(peer) : '';
  useEffect(() => {
    if (!accountId || !groupId) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const result = await rpc('members', { accountId, chatType: 'group', peerId: groupId }, controller.signal);
        if (controller.signal.aborted) return;
        if (result?.accountId !== accountId || result?.peerId !== groupId || !Array.isArray(result.members))
          throw new Error('群成员名单与当前账号或会话不匹配，请刷新后重试');
        const unique = new Map(
          result.members
            .filter((member) => member?.id && (!member.groupId || member.groupId === groupId))
            .map((member) => [member.id, member])
        );
        setMembers(
          [...unique.values()].sort((left, right) =>
            (left.name || left.id).localeCompare(right.name || right.id, 'zh-CN')
          )
        );
        setLoaded(true);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [accountId, groupId, revision]);
  if (!groupId) return peer ? <p className="wa-help">私聊任务会直接发送给对方，无需选择 @ 对象。</p> : null;
  const words = searchText(query).split(' ').filter(Boolean);
  const matching = members.filter((member) =>
    words.every((word) =>
      searchText([member.name, member.card, member.nickname, member.remark, member.alias].join(' ')).includes(word)
    )
  );
  const duplicate = (name) => members.filter((member) => (member.name || member.id) === name).length > 1;
  const toggle = (member) =>
    onChange(
      value.some((target) => target.id === member.id)
        ? value.filter((target) => target.id !== member.id)
        : [...value, { id: member.id, name: member.name || member.id }]
    );
  const missing = loaded && value.some((target) => !members.some((member) => member.id === target.id));
  return (
    <div className="wa-field wa-automation-field" data-testid="task-recipients">
      <div className="wa-between">
        <span className="wa-label">提醒对象（可选，可多选）</span>
        <Button disabled={disabled || loading} onClick={() => setRevision(revision + 1)}>
          {loading ? '正在读取…' : '刷新成员'}
        </Button>
      </div>
      <p className="wa-help">
        按群昵称、微信昵称或备注搜索，选中后到期会真正 @ 对方。不选择则发送普通消息，不 @ 所有人。
      </p>
      <input
        className="wa-input"
        aria-label="按名称查找提醒对象"
        placeholder="输入成员姓名，可模糊查找"
        value={query}
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
      />
      <Alert text={error} />
      <div className="wa-recipient-list" role="group" aria-label="群成员提醒对象">
        {matching.slice(0, 60).map((member) => {
          const name = member.name || member.id,
            checked = value.some((target) => target.id === member.id);
          return (
            <label className="wa-row" key={member.id} data-member-id={member.id}>
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled || (!checked && value.length >= 20)}
                onChange={() => toggle(member)}
              />
              <span>
                {name}
                {member.remark && member.remark !== name ? ` · 备注：${member.remark}` : ''}
                {duplicate(name) ? <small className="wa-help"> · 成员标识：{member.id}</small> : null}
              </span>
            </label>
          );
        })}
        {!loading && !matching.length && (
          <p className="wa-help">{query ? '已同步名单中没有匹配成员，请换个名字或刷新。' : '暂未同步到群成员。'}</p>
        )}
      </div>
      {matching.length > 60 && (
        <p className="wa-help">还有 {matching.length - 60} 位匹配成员，请输入更完整的名字缩小范围。</p>
      )}
      <div aria-live="polite">
        <p className="wa-help">已选提醒对象：{value.length ? `${value.length} / 20 位` : '未选择'}</p>
        {value.length > 0 && (
          <div className="wa-row">
            {value.map((target) => (
              <Button
                key={target.id}
                disabled={disabled}
                aria-label={'移除提醒对象 ' + target.name}
                onClick={() => onChange(value.filter((item) => item.id !== target.id))}
              >
                @{members.find((member) => member.id === target.id)?.name || target.name} ×
              </Button>
            ))}
          </div>
        )}
      </div>
      {missing && <p className="wa-task-warning">有已选成员暂不在这份名单中，请刷新并核对；保存时不会忽略失效对象。</p>}
      <p className="wa-help">
        这里只显示当前账号在此群已同步的成员，名单可能不完整。未出现的成员可先在群内发言，等待同步后刷新。发送前会再次核对。
      </p>
    </div>
  );
}
