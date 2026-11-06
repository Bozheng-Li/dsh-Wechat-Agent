import React, { useCallback, useState, useSyncExternalStore } from 'react';
import { ConversationArt } from './conversation-art.jsx';

const MOTION_KEY = 'wechat-agent.visual-motion';
const reducedMotionQuery = '(prefers-reduced-motion: reduce)';
const systemReducesMotion = () => typeof window === 'undefined' || window.matchMedia(reducedMotionQuery).matches;
function subscribeToMotion(listener) {
  const query = window.matchMedia(reducedMotionQuery);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

export function useVisualMotion() {
  const systemReduced = useSyncExternalStore(subscribeToMotion, systemReducesMotion, () => true);
  const [enabled, setEnabled] = useState(() => {
    try { return window.localStorage.getItem(MOTION_KEY) !== 'off'; }
    catch { return true; }
  });
  const toggle = useCallback(() => {
    const next = !enabled;
    setEnabled(next);
    try { window.localStorage.setItem(MOTION_KEY, next ? 'on' : 'off'); } catch { /* A blocked preference store must not prevent using the page. */ }
  }, [enabled]);
  return { enabled: enabled && !systemReduced, systemReduced, toggle };
}

export function MotionControl({ motion }) {
  return <button type="button" className="wa-motion-control" data-testid="visual-motion-toggle"
    aria-label={motion.systemReduced ? '系统已减少动态效果' : motion.enabled ? '暂停界面动效' : '开启界面动效'}
    aria-pressed={motion.enabled} disabled={motion.systemReduced} onClick={motion.toggle}
    title={motion.systemReduced ? '跟随系统的减少动态效果设置' : '只调整界面动效，不影响微信连接或自动回复'}>
    <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      {motion.enabled ? <><ellipse cx="10" cy="10" rx="8" ry="3.8" transform="rotate(-35 10 10)"/><circle cx="10" cy="10" r="1.7" fill="currentColor" stroke="none"/></> : <><path d="M7.5 5.5v9M12.5 5.5v9"/><circle cx="10" cy="10" r="8"/></>}
    </svg>
    <span>动效</span><span className="wa-motion-value">{motion.systemReduced ? '跟随系统' : motion.enabled ? '开' : '关'}</span>
  </button>;
}

// Decorative geometry only. Connection and reply states remain in the account copy.
export function ConversationSculpture() {
  return <div className="wa-conversation-sculpture" aria-hidden="true" data-testid="conversation-sculpture">
    <div className="wa-sculpture-float"><ConversationArt/></div>
  </div>;
}
