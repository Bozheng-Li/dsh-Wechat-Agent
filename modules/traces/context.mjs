import { AsyncLocalStorage } from 'node:async_hooks';
const execution = new AsyncLocalStorage();
export const currentTrace = () => execution.getStore();
export const withTrace = (context, action) => execution.run(context ?? undefined, action);

// Observation must preserve return values, promise identity, cancellation and errors.
export function observeResult(value, completed, failed) {
  if (value && typeof value.then === 'function') {
    void value.then(result => { try { completed(result); } catch {} }, error => { try { failed(error); } catch {} }).catch(() => {});
  } else { try { completed(value); } catch {} }
  return value;
}
export function traceStep(title, action, options = {}) {
  const context = options.context || currentTrace();
  if (!context) return action();
  const step = context.store.startStep(context, { title, ...options });
  if (!step) return action();
  return withTrace({ ...context, parentId: step.id }, () => {
    try { return observeResult(action(), result => step.end({ output: options.output ? options.output(result) : result }), error => step.end({ error })); }
    catch (error) { step.end({ error }); throw error; }
  });
}
