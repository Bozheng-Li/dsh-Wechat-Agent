import { useState } from 'react';
import { conversationKey, matchesSearch, peerName, peerType } from "../shared/conversations.mjs";
import { samePeer } from "../shared/peers.mjs";
import { Glyph } from './glyph.jsx';

export function RoomPicker({ rows, value, onChange, authorizedOnly = false, disabled = false }) {
  const [query, setQuery] = useState('');
  const filtered = rows.filter((peer) => (!authorizedOnly || peer.authorized) && matchesSearch(peer, query));
  return (
    <div className="wa-room-picker">
      <div className="wa-room-picker-search"><Glyph name="search" className="wa-icon-small" /><input
        className="wa-input"
        aria-label="按名字筛选会话"
        disabled={disabled}
        placeholder="输入群名或微信名查找"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      /></div>
      <select
        className="wa-select"
        aria-label="选择会话"
        disabled={disabled}
        value={value ? conversationKey(value) : ''}
        onChange={(event) => onChange(rows.find((peer) => conversationKey(peer) === event.target.value) || null)}
      >
        <option value="">请选择一个会话</option>
        {value && !filtered.some((peer) => samePeer(value, peer)) && (
          <option value={conversationKey(value)}>{peerName(value)}</option>
        )}
        {filtered.map((peer) => (
          <option key={conversationKey(peer)} value={conversationKey(peer)}>
            {peerType(peer) === 'group' ? '群聊' : '私聊'} · {peerName(peer)}
            {peer.authorized ? '' : ' · 已撤销授权'}
          </option>
        ))}
      </select>
    </div>
  );
}
