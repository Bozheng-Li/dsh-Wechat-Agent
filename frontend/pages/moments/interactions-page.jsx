import { useEffect, useRef, useState } from 'react';
import { Button, Empty, Tag } from '../../components/workbench-ui.jsx';
import { formatTime } from '../../shared/conversations.mjs';
import { MOMENTS_INTERACTION_DEFAULTS as defaults, interactionHasComment, interactionHasLike, interactionOptions } from '../../../shared/moments-interactions.mjs';
import { useInteractions } from './use-interactions.mjs';
import { CleanupControl } from '../../components/cleanup-control.jsx';
import { InteractionAutomation } from './interaction-automation.jsx';

const actions = [['like', '只点赞'], ['comment', '只评论'], ['both', '点赞并评论']];
const modes = [['latest', '最近几条'], ['random', '随机挑选'], ['manual', '手动勾选']];
const states = { draft: '待执行', generating: '生成中', running: '执行中', completed: '本轮已结束', partial: '部分完成', failed: '未完成', cancelled: '已停止', interrupted: '已中断', discarded: '已放弃' };
const steps = { pending: '待处理', sending: '等待微信确认', succeeded: '微信已确认', existing: '已经操作', skipped: '已跳过', rejected: '未提交成功', unknown: '结果不明，未重发' };
const stamp = seconds => formatTime(seconds * 1000);
function Choices({ label, value, items, onChange, disabled }) {
  return <div className="wa-interaction-choice" role="group" aria-label={label}>{items.map(([id, text]) => <button type="button" key={id} aria-pressed={value === id} disabled={disabled} onClick={() => onChange(id)}>{text}</button>)}</div>;
}
function Receipt({ label, step }) {
  return <span className={'wa-interaction-receipt is-' + step.state} title={step.message}>{label} · {steps[step.state]}{step.result?.commentId ? ` #${step.result.commentId}` : ''}</span>;
}

export function MomentsInteractionsPage({ rpc, status, initialPost, onSeedUsed, onComments }) {
  const accountId = status.account?.id, online = status.online && !!accountId, state = useInteractions(rpc, accountId);
  const [options, setOptions] = useState({ ...defaults, postIds: [] }), [rows, setRows] = useState([]), [notice, setNotice] = useState('');
  const pendingPreview = useRef(null), seeded = useRef(null), lastRevision = useRef(null);
  const round = state.data.current, editable = round?.state === 'draft', running = ['running', 'generating'].includes(round?.state);
  const selected = rows.filter(row => row.selected), comments = interactionHasComment(round?.options.action), likes = interactionHasLike(round?.options.action);
  const edits = rows.map(row => ({ postId: row.postId, selected: row.selected, commentText: row.commentText }));
  const dirty = !!round && JSON.stringify(edits) !== JSON.stringify(round.rows.map(row => ({ postId: row.postId, selected: row.selected, commentText: row.commentText })));
  const optionsDirty = !!round && JSON.stringify(options) !== JSON.stringify(round.options);
  let valid = true; try { interactionOptions(options); } catch { valid = false; }
  useEffect(() => {
    if (round && lastRevision.current !== round.id + round.revision) {
      const different = lastRevision.current?.slice(0, 64) !== round.id;
      lastRevision.current = round.id + round.revision; setRows(round.rows);
      if (different) setOptions(round.options);
    }
  }, [round]);
  const preview = async (next = options) => {
    const signature = JSON.stringify(next);
    if (pendingPreview.current?.signature !== signature) pendingPreview.current = { signature, requestId: 'ui-moments-' + crypto.randomUUID() };
    const result = await state.execute('preview', { options: next, requestId: pendingPreview.current.requestId });
    if (result) { pendingPreview.current = null; setOptions(result.options); setNotice('已读取真实动态，本轮尚未提交点赞或评论。'); }
  };
  useEffect(() => {
    if (!initialPost || seeded.current === initialPost.key) return;
    seeded.current = initialPost.key;
    const next = { ...defaults, source: 'selected', postIds: [initialPost.postId], count: 1, action: 'comment' };
    setOptions(next); void preview(next).then(() => onSeedUsed?.());
  }, [initialPost]);
  const update = patch => { pendingPreview.current = null; setOptions(value => ({ ...value, ...patch })); setNotice(''); };
  const edit = (postId, patch) => setRows(values => values.map(row => row.postId === postId ? { ...row, ...patch } : row));
  const save = async () => dirty ? state.execute('edit', { id: round.id, revision: round.revision, rows: edits }) : round;
  const generate = async () => { const current = await save(); if (current) { const result = await state.execute('generate', { id: current.id, revision: current.revision }); if (result) setNotice('评论草稿已准备，请逐条检查或修改后执行。'); } };
  const run = async () => { const current = await save(); if (current) { const result = await state.execute('run', { id: current.id, revision: current.revision }); if (result) setNotice('已开始本轮互动，逐条结果会自动更新；离开页面后仍可回来查看。'); } };
  const missingComments = comments && selected.some(row => !row.commentText.trim() && !row.commentSkipReason);
  return <div className="wa-interactions" data-testid="moments-interactions" data-account-id={accountId}>
    <header className="wa-interaction-heading"><div><h2>给朋友一点回应</h2><p>按计划定时互动，也可以临时选一轮。点赞、接话，都有据可看。</p></div><span className="wa-interaction-limit">每轮最多 20 条</span></header>
    <InteractionAutomation state={state} status={status} />
    <header className="wa-interaction-manual-heading"><h3>手动执行一轮</h3><p>临时选择动态，先检查内容，再执行。</p></header>
    <div className="wa-interaction-workspace">
      <section className="wa-interaction-setup" aria-label="本轮互动设置">
        <div className="wa-interaction-step"><span>01</span><h3>选择范围与玩法</h3></div>
        <fieldset disabled={!!state.busy || running}><legend className="wa-sr-only">互动设置</legend>
          <Choices label="互动动作" items={actions} value={options.action} onChange={action => update({ action })} />
          <label>动态来源<select aria-label="互动动态来源" value={options.source} onChange={e => update({ source: e.target.value, postIds: [] })}>
            <option value="timeline">当前账号看到的好友动态</option><option value="user">指定一位好友</option>{options.source === 'selected' && <option value="selected">从好友动态选中的这一条</option>}</select></label>
          {options.source === 'user' && <label>好友昵称、备注或微信 ID<input aria-label="互动指定好友" value={options.user} maxLength={150} onChange={e => update({ user: e.target.value })} placeholder="输入准确昵称、备注或 ID" /></label>}
          {options.source !== 'selected' && <>
            <Choices label="动态选择方式" items={modes} value={options.mode} onChange={mode => update({ mode })} />
            <div className="wa-interaction-fields">
              {options.mode !== 'manual' && <label>本轮条数<input aria-label="本轮互动条数" type="number" min={1} max={20} value={options.count} onChange={e => update({ count: Number(e.target.value), poolSize: Math.max(options.poolSize, Number(e.target.value)) })} /></label>}
              <label>动态时间<select aria-label="互动时间范围" value={options.lookbackDays} onChange={e => update({ lookbackDays: Number(e.target.value) })}>{[[1, '最近 24 小时'], [3, '最近 3 天'], [7, '最近 7 天'], [30, '最近 30 天'], [0, '不限时间']].map(([value, text]) => <option value={value} key={value}>{text}</option>)}</select></label>
              {options.mode !== 'latest' && <label>候选动态数<input aria-label="互动候选数量" type="number" min={Math.max(1, options.count)} max={100} value={options.poolSize} onChange={e => update({ poolSize: Number(e.target.value) })} /></label>}
              {options.mode === 'random' && options.source === 'timeline' && <label>每位好友最多<input aria-label="随机每位好友上限" type="number" min={1} max={20} value={options.perFriendLimit} onChange={e => update({ perFriendLimit: Number(e.target.value) })} /></label>}
            </div>
          </>}
          {interactionHasComment(options.action) && <div className="wa-interaction-comment-options">
            <label>评论方式<select aria-label="互动评论方式" value={options.commentMode} onChange={e => update({ commentMode: e.target.value })}><option value="generated">按每条图文生成，先预览</option><option value="fixed">使用指定评论</option><option value="manual">逐条手工填写</option></select></label>
            {options.commentMode === 'generated' && <label>评论风格<textarea aria-label="互动评论风格" rows={3} maxLength={1000} value={options.instructions} onChange={e => update({ instructions: e.target.value })} /></label>}
            {options.commentMode === 'fixed' && <label>指定评论<textarea aria-label="互动指定评论" rows={3} maxLength={2000} value={options.commentText} onChange={e => update({ commentText: e.target.value })} placeholder="读完动态后，还能逐条修改" /></label>}
            <label className="wa-wb-check"><input aria-label="跳过已经评论的动态" type="checkbox" checked={options.skipCommented} onChange={e => update({ skipCommented: e.target.checked })} />跳过当前账号已经评论的动态</label>
          </div>}
          <label>每条动态之间的间隔（秒）<input aria-label="互动间隔秒数" type="number" min={0} max={60} value={options.intervalSeconds} onChange={e => update({ intervalSeconds: Number(e.target.value) })} /></label>
        </fieldset>
        <p className="wa-wb-note">{options.mode === 'random' ? '在本次可见候选中随机选取，名单生成后固定。' : options.mode === 'manual' ? '读取候选后，勾选本轮要互动的动态。' : '按发布时间选取，已点赞的条目仍占原位置。'}不足时按实际数量处理。</p>
        <Button disabled={!!state.busy || running || !online || !valid} onClick={() => preview()}>{state.busy === 'preview' ? '正在读取…' : round ? '重新读取并预览' : '读取并预览'}</Button>
      </section>
      <section className="wa-interaction-preview" aria-label="本轮互动预览">
        <header className="wa-interaction-step"><span>02</span><h3>{editable ? '检查动态与评论' : running ? '正在处理本轮' : round ? '本轮处理结果' : '预览本轮动态'}</h3>{round && <Tag state={round.state}>{states[round.state]}</Tag>}</header>
        {state.error && <p role="alert" className="wa-alert is-error">{state.error}</p>}
        {(state.refreshError || state.data.error) && <p role="alert" className="wa-alert is-error">{state.refreshError || state.data.error}</p>}
        {notice && <p role="status" className="wa-wb-note">{notice}</p>}
        {state.busy === 'generate' && <div className="wa-wb-actions"><p className="wa-wb-loading" role="status">正在读取图文并生成评论…</p><Button quiet disabled={state.cancelling} onClick={() => state.cancelGeneration(round.id)}>{state.cancelling ? '正在停止…' : '停止生成评论'}</Button></div>}
        {!round && <Empty title="先选一种互动方式">读取后会显示每条动态的作者、时间和正文。评论可以逐条修改，再执行这一轮。</Empty>}
        {round && <>
          <div className="wa-interaction-round-meta"><strong>已选 {selected.length} 条</strong><span>读取 {round.scan.scanned} 条 · 可见候选 {round.scan.poolCount} 条 · {formatTime(round.scan.fetchedAt)}</span></div>
          <p className="wa-wb-note">{round.scan.message}{round.options.mode === 'random' ? '。随机名单已固定，刷新状态不会重新抽取。' : ''}</p>
          {round.automatic && <p className="wa-wb-note">自动轮次 · 计划点赞 {round.automatic.settings.likeCount} 条、评论 {round.automatic.settings.commentCount} 条{round.phase === 'reading' ? ' · 正在筛选真实动态' : round.phase === 'reading-images' ? ' · 正在读取配图' : round.phase === 'generating' ? ' · 正在生成评论' : ''}</p>}
          {optionsDirty && editable && <p className="wa-alert">范围或玩法已更改，请重新读取预览后执行。</p>}
          {round.generationError && <p className="wa-alert is-error" role="alert">{round.generationError}</p>}
          {round.error && <p className="wa-alert is-error" role="alert">{round.error.message}</p>}
          {!rows.length && <Empty title="本次没有符合范围的动态">可以调整时间、来源或候选数量后重新读取。</Empty>}
          <div className="wa-interaction-rows">{rows.map(row => <article key={row.postId} data-interaction-post={row.postId} className={'wa-interaction-row' + (row.selected ? ' is-selected' : '')}>
            <div className="wa-interaction-original"><header><label className="wa-wb-check"><input aria-label={'选择互动动态 ' + row.postId} type="checkbox" checked={row.selected} disabled={!editable || !!state.busy || !row.selected && selected.length >= 20} onChange={e => edit(row.postId, { selected: e.target.checked })} /><span><strong>{row.nickname || row.userId}</strong><time>{stamp(row.createdAt)}</time></span></label>{editable && row.likedByCurrentAccount && <Tag state="liked">已点赞</Tag>}</header>
              <p className="wa-interaction-post-text">{row.text || '无文字动态'}</p><small>{row.imageCount > 0 && `${row.imageCount} 张图片 · `}{Number.isFinite(row.likeCount) ? `${row.likeCount} 个赞` : '赞数未知'} · {Number.isFinite(row.commentCount) ? `${row.commentCount} 条评论` : '评论数未知'}</small>
              {row.imageContext?.images?.length > 0 && <details className="wa-wb-note"><summary>已读取 {row.imageContext.images.length} 张配图{!row.imageContext.complete && ' · 部分看不清'}</summary>{row.imageContext.images.map(image => <p key={image.index}>图 {image.index}：{image.description}</p>)}</details>}
              <details className="wa-interaction-identity"><summary>动态详情</summary><small>{row.userId}<br />动态 {row.postId}</small>{onComments && <Button quiet disabled={!!state.busy} onClick={() => onComments(row.postId)}>查看评论区</Button>}</details>
            </div>
            <div className="wa-interaction-response">{comments && <>
              {editable ? <label>准备评论<textarea aria-label={'互动评论 ' + row.postId} rows={3} maxLength={2000} value={row.commentText} disabled={!!state.busy || !row.selected} placeholder={row.commentSkipReason || '生成评论，或填写你想说的话'} onChange={e => edit(row.postId, { commentText: e.target.value })} /></label> : row.commentText && <p className="wa-interaction-comment-text">{row.commentText}</p>}
              {row.commentSkipReason && !row.commentText.trim() && <p className="wa-wb-note">{row.commentSkipReason}。可手工填写明确评论。</p>}
            </>}
              {(!editable || !comments) && row.selected && <div className="wa-interaction-receipts">{likes && <Receipt label="点赞" step={row.like} />}{comments && <Receipt label="评论" step={row.comment} />}</div>}
              {!editable && [row.like, row.comment].filter(step => step.message && !['succeeded', 'sending'].includes(step.state)).map((step, i) => <p className="wa-wb-note" key={i}>{step.message}</p>)}
            </div>
          </article>)}</div>
          <footer className="wa-interaction-execute"><div className="wa-interaction-step"><span>03</span><h3>{editable ? '执行这一轮' : '微信回执'}</h3></div>
            {editable ? <><p className="wa-wb-note">{dirty ? '逐条修改会随执行一起保存。' : '检查好作者、正文和评论，再提交本轮。'}{comments && ' 生成评论会结合真实配图；图片读取失败会跳过该条评论。'}</p><div className="wa-wb-actions">
              {comments && round.options.commentMode === 'generated' && <Button quiet disabled={!!state.busy || !online || !selected.length || optionsDirty} onClick={generate}>{state.busy === 'generate' ? '正在生成评论…' : '生成逐条评论'}</Button>}
              {dirty && <Button quiet disabled={!!state.busy || !online} onClick={save}>保存逐条修改</Button>}
              <Button disabled={!!state.busy || state.data.running || !online || status.momentsWriteReady === false || !selected.length || missingComments || optionsDirty} onClick={run}>执行 {selected.length} 条 · {actions.find(([id]) => id === round.options.action)?.[1]}</Button>
              <Button quiet disabled={!!state.busy} onClick={() => state.execute('cancel', { id: round.id })}>放弃本轮</Button>
            </div>{missingComments && <p className="wa-wb-note">请先生成或填写所选动态的评论。</p>}</> : <><p className="wa-interaction-counts" aria-live="polite">新增点赞 <strong>{round.counts.liked}</strong> · 新增评论 <strong>{round.counts.commented}</strong> · 已赞 {round.counts.alreadyLiked} · 跳过评论 {round.counts.skippedComments} · 未确认 {round.counts.unknown} · 待处理 {round.counts.remaining}</p><div className="wa-wb-actions"><Button quiet disabled={!!state.busy} onClick={() => state.refresh()}>刷新本轮状态</Button>{running && <Button quiet disabled={!!state.busy} onClick={() => state.execute('cancel', { id: round.id })}>停止本轮互动</Button>}</div></>}
          </footer>
        </>}
      </section>
    </div>
    <section className="wa-interaction-history" aria-label="互动执行记录"><header className="wa-index-heading"><h2>最近的互动轮次</h2><span>{state.data.runs.length}</span></header>
      {!state.data.runs.length && <p className="wa-wb-note">预览和执行记录会保存在这里。</p>}
      {!!state.data.runs.length && <CleanupControl state={{ ...state, setNotice }} kind="moments.interactions" label="清空互动记录" />}
      {state.data.runs.slice(0, 12).map(row => <button type="button" className={'wa-interaction-history-row' + (round?.id === row.id ? ' is-selected' : '')} key={row.id} disabled={!!state.busy} onClick={async () => { if (dirty && editable && !await save()) return; setNotice(''); await state.select(row.id); }}><time>{formatTime(row.createdAt)}</time><strong>{actions.find(([id]) => id === row.options.action)?.[1]} · {row.counts.selected} 条</strong><span>{row.automatic ? '自动 · ' : ''}{modes.find(([id]) => id === row.options.mode)?.[1]}</span><Tag state={row.state}>{states[row.state]}</Tag><small>确认 {row.counts.liked} 赞 / {row.counts.commented} 评论</small></button>)}
    </section>
  </div>;
}
