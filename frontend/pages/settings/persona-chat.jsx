import { useEffect, useRef, useState } from 'react';
import { splitLines } from '../../shared/conversations.mjs';
import { Button } from '../../components/button.jsx';
import { splitChatReply } from '../../../shared/chat-reply-split.mjs';

const suggestions = ['刚把桌子收拾干净，结果找不到笔了。', '别老这么一本正经的，随便聊两句。', '刚才那个数字错了，应该是 16。'];

export function PersonaChat({ draft, rpc, disabled }) {
  const [messages, setMessages] = useState([]), [input, setInput] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const running = useRef(null), bottom = useRef(null), signature = JSON.stringify(draft);
  const current = useRef(signature); current.current = signature;
  useEffect(() => () => running.current?.abort(), []);
  useEffect(() => {
    running.current?.abort(); running.current = null; setBusy(false); setError('');
    setMessages(rows => rows.filter(row => !row.pending));
  }, [signature]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }); }, [messages.length, busy]);
  const clear = () => {
    running.current?.abort(); running.current = null;
    setMessages([]); setBusy(false); setError('');
  };
  const send = async event => {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy || disabled || !rpc || running.current) return;
    const controller = new AbortController(); running.current = controller;
    const history = messages.filter(row => !row.failed).slice(-12).map(({ role, content }) => ({ role, content }));
    setMessages(rows => [...rows, { role: 'user', content: text, pending: true }]);
    setInput(''); setError(''); setBusy(true);
    try {
      const result = await rpc('persona.chat', { text, messages: history, persona: {
        name: draft.name.trim(), aliases: splitLines(draft.aliases), prompt: draft.prompt,
        personaMode: draft.personaMode || 'standard',
      } }, controller.signal);
      if (controller.signal.aborted || current.current !== signature) return;
      const bubbles = splitChatReply(result.text);
      setMessages(rows => [...rows.map(row => row.pending ? { ...row, pending: false } : row), { role: 'assistant', content: bubbles.join('\n'), bubbles, name: draft.name,
        elapsedMs: result.elapsedMs, mode: result.personaMode }]);
    } catch (failure) {
      if (!controller.signal.aborted && current.current === signature) {
        setError(failure.message || '本次试聊没有完成，可重试。'); setInput(text);
        setMessages(rows => rows.slice(0, -1));
      }
    } finally {
      if (running.current === controller) { running.current = null; setBusy(false); }
    }
  };
  return <section className="wa-persona-chat" data-testid="persona-chat" aria-label="管理员人设试聊">
    <header><div><h2>试聊</h2><p>当前人设草稿 · {draft.personaMode === 'high-precision' ? '高精度模式' : '标准模式'}</p></div>
      <Button quiet onClick={clear} disabled={!messages.length && !busy}>清空对话</Button></header>
    <p className="wa-help">在这里看看它会怎么接话。仅模拟显式分泡；不发送到微信、不模拟服务端回执或媒体投递、不写入会话记忆。修改人设后，下一条就用新设定。</p>
    <div className="wa-persona-chat-log" role="log" aria-label="试聊消息" aria-relevant="additions" aria-busy={busy}>
      {!messages.length && <div className="wa-persona-chat-empty"><p>从一句日常的话开始</p>
        {suggestions.map(text => <button type="button" key={text} disabled={busy || disabled} onClick={() => setInput(text)}>{text}</button>)}
      </div>}
      {messages.flatMap((row, index) => (row.bubbles || [row.content]).map((content, bubbleIndex) => <div key={`${index}:${bubbleIndex}`} className="wa-persona-chat-message" data-role={row.role} data-turn={index} data-bubble={bubbleIndex}>
        <small>{row.role === 'user' ? '管理员' : row.name || '助手'}</small><p>{content}</p>
        {row.role === 'assistant' && <small>分泡模拟 · 无微信回执 · {row.mode === 'high-precision' ? '高精度' : '标准'}{Number.isFinite(row.elapsedMs) ? ` · ${(row.elapsedMs / 1000).toFixed(1)} 秒` : ''}</small>}
      </div>))}
      {busy && <p className="wa-help" role="status">正在回复…</p>}
      <div ref={bottom} />
    </div>
    {error && <p className="wa-alert is-error" role="alert">{error}</p>}
    <form className="wa-persona-chat-compose" onSubmit={send}>
      <textarea className="wa-textarea" aria-label="试聊输入" placeholder="说点什么，看看当前人设怎么回答…" rows={3} maxLength={6000}
        value={input} disabled={busy || disabled} onChange={event => setInput(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} />
      <div><small>Enter 发送 · Shift + Enter 换行</small>{busy
        ? <Button type="button" quiet onClick={() => { running.current?.abort(); running.current = null;
            setMessages(rows => rows.filter(row => !row.pending)); setBusy(false); }}>停止</Button>
        : <Button type="submit" disabled={disabled || !input.trim() || !rpc}>发送</Button>}</div>
    </form>
  </section>;
}
