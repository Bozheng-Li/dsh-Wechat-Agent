import { useSyncExternalStore } from 'react';

let now = Date.now(), timer;
const listeners = new Set();
const snapshot = () => now;
const tick = () => {
  now = Date.now();
  for (const listener of listeners) listener();
};
const subscribe = listener => {
  listeners.add(listener);
  if (listeners.size === 1) {
    now = Date.now();
    timer = setInterval(tick, 1000);
    globalThis.document?.addEventListener('visibilitychange', tick);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      globalThis.document?.removeEventListener('visibilitychange', tick);
    }
  };
};
const inactive = () => () => {};

// All visible countdowns share one clock and catch up from the actual time
// when the browser returns from the background.
export function useClock(active = true) {
  return useSyncExternalStore(active ? subscribe : inactive, snapshot, snapshot);
}
