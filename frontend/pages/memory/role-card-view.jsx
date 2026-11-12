import { Button } from '../../components/button.jsx';
import { Glyph } from '../../components/glyph.jsx';
import { ROLE_CARD_FIELDS, ROLE_CARD_LABELS } from '../../../shared/role-card.mjs';
import { ScheduleCountdown } from '../../components/schedule-countdown.jsx';

export const roleDate = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未整理';
export const roleStateLabel = {
  updating: '正在后台整理', queued: '等待后台整理', retrying: '整理失败，等待重试', ready: '已整理',
  disabled: '自动整理已关闭', collecting: '正在累计新消息', scheduled: '等待到期整理',
};
const compactState = { updating: '整理中', queued: '等待整理', retrying: '等待重试', ready: '已整理',
  disabled: '自动整理已关闭', collecting: '累计消息中', scheduled: '等待整理' };

export function roleTone(personId) {
  return Array.from(personId).reduce((hash, letter) => (hash * 31 + letter.codePointAt(0)) >>> 0, 0) % 4;
}

export function roleSource(encounters = []) {
  const privateChat = encounters.some(row => row.chatType === 'private');
  const groupChat = encounters.some(row => row.chatType === 'group');
  const moments = encounters.some(row => row.chatType === 'moments');
  if (moments) return [privateChat && '私聊', groupChat && '群聊', '朋友圈'].filter(Boolean).join('与');
  return privateChat && groupChat ? '私聊与群聊' : groupChat ? '群聊中认识' : privateChat ? '私聊中认识' : '已有资料';
}
const roleEvidenceSourceLabel = source => source.chatType === 'moments' ? '朋友圈' : source.chatType === 'group' ? '群聊' : '私聊';

export function RoleAvatar({ name, large = false }) {
  const initials = /^[a-z]/i.test(name.trim()) ? name.trim().slice(0, 2).toUpperCase() : Array.from(name.trim())[0] || '友';
  return <span className={'wa-role-avatar' + (large ? ' is-large' : '')} aria-hidden="true">{initials}</span>;
}

export function RolePersonCard({ person, duplicate, onOpen, status }) {
  const preview = person.preview || {};
  const summaryField = ['preferences', 'background', 'notes'].find(field => preview[field]);
  const state = person.error ? 'retrying' : person.state;
  return <article className="wa-role-card" data-tone={roleTone(person.personId)} data-person-id={person.personId} role="listitem">
    <div className="wa-role-card-cover">
      <span className="wa-role-source"><Glyph name={person.encounters.some(row => row.chatType === 'group') ? 'people' : 'chat'} size={13} />{roleSource(person.encounters)}</span>
    </div>
    <header className="wa-role-card-identity">
      <RoleAvatar name={person.name} />
      <div><h3 title={person.name}>{person.name}</h3><p>{preview.addressAs ? '称呼 · ' + preview.addressAs : '称呼待了解'}</p></div>
    </header>
    <div className="wa-role-card-copy">
      <p className={'wa-role-relationship' + (!preview.relationship ? ' is-empty' : '')}>{preview.relationship || '相处关系待了解'}</p>
      <div className="wa-role-card-summary">
        <span>{summaryField ? ROLE_CARD_LABELS[summaryField] : '人物印象'}</span>
        <p className={!summaryField ? 'is-empty' : ''}>{summaryField ? preview[summaryField] : '聊得更多以后，新的了解会记录在这里。'}</p>
      </div>
      <div className="wa-role-card-meta"><span>{person.filledFields} / {Object.keys(ROLE_CARD_FIELDS).length} 项资料</span>
        {!!person.conflictCount && <span className="wa-role-conflict">{person.conflictCount} 项待核对</span>}
        {duplicate && <span className="wa-role-card-id">{person.personId}</span>}
      </div>
    </div>
    <footer className="wa-role-card-footer">
      <div className="wa-role-card-status"><span className="wa-role-state" data-state={state}><span aria-hidden="true" />{compactState[state] || '等待整理'}</span>
        {(person.nextAt || person.state === 'updating') && <ScheduleCountdown at={person.nextAt} enabled={person.state !== 'disabled'}
          running={person.state === 'updating'} status={status} action={person.state === 'retrying' ? '重试' : '整理'} />}</div>
      <button type="button" className="wa-role-card-open" aria-haspopup="dialog" aria-label={'查看' + person.name + '的角色卡'} onClick={onOpen}>
        查看卡片<Glyph name="arrow" size={13} />
      </button>
    </footer>
  </article>;
}

export function RoleCardDetails({ doc, draft, editing, busy, dirty, status, onChange, onRefresh, onEdit, onSave, onCancel }) {
  return <>
    <div className="wa-role-detail-status" role="status">
      <span className="wa-role-state" data-state={doc.error ? 'retrying' : doc.state}><span aria-hidden="true" />{roleStateLabel[doc.state] || '等待整理'}</span>
      <span>最近整理：{roleDate(doc.reviewedAt)}</span><span>待整理消息：{doc.pendingCount}</span>
      {(doc.nextAt || doc.state === 'updating') && <span className="wa-schedule-time"><span>下次整理：{doc.nextAt ? roleDate(doc.nextAt) : '本轮正在处理'}</span>
        <ScheduleCountdown at={doc.nextAt} enabled={doc.state !== 'disabled'} running={doc.state === 'updating'} status={status}
          action={doc.state === 'retrying' ? '重试' : '整理'} /></span>}
    </div>
    {doc.error && <p className="wa-alert is-error" role="alert">{doc.error}</p>}
    <div className="wa-role-detail-tools">
      <h3>{editing ? '纠正人物资料' : '关于这个人'}</h3>
      {!editing && <div className="wa-row">
        <Button icon="refresh" disabled={busy} onClick={onRefresh}>根据来源更新</Button>
        <Button primary disabled={busy} onClick={onEdit}>纠正资料</Button>
      </div>}
    </div>
    <div className="wa-role-fields">
      {Object.entries(ROLE_CARD_LABELS).map(([field, label]) => <div className={'wa-role-field' + (['style', 'notes'].includes(field) ? ' is-wide' : '')} key={field}>
        <label className="wa-label" htmlFor={'role-' + field}>{label}</label>
        {editing ? <textarea id={'role-' + field} className="wa-textarea" aria-label={label}
          rows={field === 'label' || field === 'addressAs' ? 1 : 3} maxLength={ROLE_CARD_FIELDS[field]}
          value={draft[field]} disabled={busy} onChange={event => onChange(field, event.target.value)} /> :
          <p id={'role-' + field} className={!doc.card[field] ? 'is-empty' : ''}>{doc.card[field] || '尚无足够的原文依据'}</p>}
        {doc.conflicts.filter(row => row.field === field).map((row, index) => <p className="wa-alert" key={index}>资料有矛盾，暂不作为确定信息：{row.note}</p>)}
        {!editing && doc.evidence[field] && <details className="wa-role-evidence">
          <summary>{doc.evidence[field].origin === 'agent' ? '查看原文依据' : '管理员补充或纠正'}</summary>
          {(doc.evidence[field].sources || []).map((source, index) => <p key={index}>
            <span>{roleEvidenceSourceLabel(source)} · {doc.encounters.find(row => row.chatType === source.chatType && row.peerId === source.peerId)?.name || source.peerId} · {roleDate(source.time)}
              {source.postId && <> · 动态 {source.postId}{source.commentId ? ' · 评论 ' + source.commentId : ''}</>}</span><br />
            {source.senderName}：{source.quote}
          </p>)}
        </details>}
      </div>)}
    </div>
    {editing && <div className="wa-role-edit-actions">
      <p>{dirty ? '有未保存的纠正' : '修改后可保存'} · 保存或取消后可关闭卡片</p>
      <div className="wa-row">
        <Button primary loading={busy} disabled={busy || !dirty} onClick={onSave}>保存纠正</Button>
        <Button disabled={busy} onClick={onCancel}>取消编辑</Button>
      </div>
    </div>}
    <details className="wa-role-history"><summary>资料来源与更新记录</summary>
      <p>人物标识：<span className="wa-mono">{doc.personId}</span>。同一微信身份的资料共用，同名人物分别记录。</p>
      {doc.encounters.map(row => <p key={row.chatType + ':' + row.peerId}>{roleEvidenceSourceLabel(row)} · {row.name}</p>)}
      {doc.changes.slice(-8).reverse().map((change, index) => <p key={index}>{roleDate(change.at)} · {change.origin === 'agent' ? 'Agent 整理' : '管理员纠正'} · {ROLE_CARD_LABELS[change.field]}：{change.after || '已清空'}</p>)}
    </details>
  </>;
}
