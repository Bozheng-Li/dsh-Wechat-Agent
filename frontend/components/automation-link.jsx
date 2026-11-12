import { Button } from './button.jsx';
import { conversationKey } from '../shared/conversations.mjs';

export function AutomationLink({ onNavigate, from, section, peer, children = '自动功能设置' }) {
  return <Button quiet icon="settings" onClick={() => onNavigate('automation', from, {
    section, ...(peer ? { peerKey: conversationKey(peer) } : {}),
  })}>{children}</Button>;
}
