const { randomUUID } = require('node:crypto');

// Pure policy. Caller persists the returned state BEFORE executing lifecycle actions.
function advance(previous, sample, now, options = {}) {
  const { graceMs = 60000, failures = 3, successes = 3, stableMs = 600000, maxStarts = 4 } = options;
  const state = structuredClone(previous || { phase: 'WAITING', starts: [], due: 0 });
  const events = [];
  let action = null;
  const incident = () => {
    if (!state.incident) {
      state.incident = randomUUID();
      events.push({ id: state.incident, status: 'OPEN', kind: 'UNHEALTHY' });
    }
  };
  if (state.phase === 'HALTED') return { state, events, action };
  if (state.phase === 'WAITING') {
    if (now < state.due) return { state, events, action };
    if (state.starts.length >= maxStarts) {
      incident(); state.phase = 'HALTED';
      events.push({ id: `${state.incident}-exhausted`, status: 'OPEN', kind: 'EXHAUSTED' });
    } else {
      state.starts.push(now); state.startedAt = now; state.phase = 'RUNNING';
      state.bad = 0; state.good = 0; state.healthySince = null; action = 'START';
    }
    return { state, events, action };
  }
  if (sample.alive && sample.healthy) {
    state.bad = 0; state.good = (state.good || 0) + 1;
    state.healthySince ??= now;
    if (state.good >= successes && state.incident) {
      events.push({ id: state.incident, status: 'RECOVERED', kind: 'HEALTHY' });
      state.incident = null;
    }
    if (now - state.healthySince >= stableMs) state.starts = state.starts.slice(-1);
  } else {
    state.good = 0; state.healthySince = null;
    if (sample.alive && now - state.startedAt < graceMs) return { state, events, action };
    state.bad = (state.bad || 0) + 1;
    if (!sample.alive || state.bad >= failures) {
      incident();
      // A fresh scan reporting delivery/data errors is not a hung process.
      if (sample.restartable !== false || !sample.alive) {
        state.phase = 'WAITING'; state.due = now + Math.min(30000, 2000 * 2 ** (state.starts.length - 1));
        action = 'STOP';
      }
    }
  }
  return { state, events, action };
}
module.exports = { advance };
