import { useState, useSyncExternalStore } from 'react';

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
  const [enabled] = useState(() => {
    try {
      return window.localStorage.getItem(MOTION_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  // Honor saved preferences from earlier versions without retaining an extra setting.
  return { enabled: enabled && !systemReduced, systemReduced };
}
