// Shared polling helper for the panel.
//
// A background window should not keep polling at the foreground rate: while
// `document.hidden` the delay is multiplied by HIDDEN_FACTOR, and the first moment
// the window becomes visible again the poll runs immediately once instead of
// waiting for the stretched interval to elapse.
const HIDDEN_FACTOR = 5;

const hidden = () => globalThis.document?.hidden === true;

export function pollInterval(ms) {
  return hidden() ? ms * HIDDEN_FACTOR : ms;
}

// Schedules `run` after the visibility-aware delay and wakes it early when the
// window becomes visible. The returned handle owns both the timer and the
// `visibilitychange` listener, so a poll effect only needs `stopPoll(handle)`
// in its cleanup: no timer or listener is left behind after unmount.
export function pollDelay(run, ms) {
  let timer = null,
    done = false;
  function stop() {
    done = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    globalThis.document?.removeEventListener('visibilitychange', wake);
  }
  function fire() {
    if (done) return;
    stop();
    run();
  }
  function wake() {
    if (done || hidden()) return;
    fire();
  }
  timer = setTimeout(fire, pollInterval(ms));
  globalThis.document?.addEventListener('visibilitychange', wake);
  return { cancel: stop };
}

export function stopPoll(handle) {
  handle?.cancel?.();
}
