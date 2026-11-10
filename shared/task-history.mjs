const activeStates = new Set(['pending', 'running', 'paused']);
const finishedStates = new Set(['sent', 'failed', 'cancelled', 'expired', 'unknown', 'partial']);
const runTime = (run) => run.finishedAt || run.startedAt || run.scheduledAt || 0;

/** One history row per task; individual executions remain available in its details. */
export function taskViews(tasks, runs) {
  const grouped = new Map(tasks.map((task) => [task.id, []]));
  for (const run of runs) grouped.get(run.taskId)?.push(run);
  const current = [],
    history = [];
  for (const task of tasks) {
    const records = grouped.get(task.id).sort((a, b) => runTime(b) - runTime(a));
    const latest = records.find((run) => finishedStates.has(run.state));
    const inFlight = records.find((run) => run.id === task.runId && !finishedStates.has(run.state));
    if (activeStates.has(task.state)) current.push(task);
    if (activeStates.has(task.state) && !latest && !task.lastState) continue;
    const settling = task.state === 'cancelled' && !!inFlight;
    const result = settling ? 'settling' : task.lastState || latest?.state;
    const state = settling ? 'settling' : activeStates.has(task.state) ? result : task.state;
    // Completion is the actual execution result time, never the planned due time.
    const timestamp =
      task.state === 'cancelled' || result === 'expired' ? task.updatedAt : latest?.finishedAt || task.updatedAt;
    history.push({ task, runs: records, latest, state, result, timestamp: timestamp || task.createdAt || 0 });
  }
  const priority = { running: 0, pending: 1, paused: 2 };
  current.sort((a, b) => priority[a.state] - priority[b.state] || a.nextRunAt - b.nextRunAt);
  history.sort((a, b) => b.timestamp - a.timestamp || a.task.id.localeCompare(b.task.id));
  return { current, history };
}
