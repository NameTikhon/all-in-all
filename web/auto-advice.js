import { analyzeSnapshot, deriveSnapshotRole } from './snapshot-advice.js';

/** Keep exact game memory separate from advice about the current visible scene. */
export function resolveAutomaticObservation(previous, observation, { session, recovery, ...context }) {
  const rules = { allowTransfer: context.gameProfile !== 'hlop-singleplayer', attackLimit: 6, gameProfile: context.gameProfile };
  const previousForRules = previous && !rules.allowTransfer ? { ...previous, allowTransfer: false } : previous;
  const sceneForRules = context.previousScene && !rules.allowTransfer
    ? { ...context.previousScene, allowTransfer: false } : context.previousScene;
  observation=deriveSnapshotRole(sceneForRules,observation,rules);
  let memory = session.reconcile(previousForRules, observation, {
    initial: previous === null, allowTransfer: rules.allowTransfer, attackLimit: rules.attackLimit,
    positionKey: context.positionKey,
  });
  // Generic memory treats pair order as irrelevant. On this site the next
  // legal cover depends on the current visual order, including unchanged cards.
  if (context.gameProfile === 'hlop-singleplayer' && memory.status !== 'review'
      && observation.table.some((pair, index) => memory.state.table[index]?.attack !== pair.attack)) {
    memory = { ...memory, status: 'accepted',
      state: { ...memory.state, table: observation.table.map(pair => ({ ...pair })) },
    };
  }
  // A previously saved transfer-game setting must not survive an explicit
  // single-player site profile, even when the cards themselves are unchanged.
  if (memory.status !== 'review' && previous && previous.allowTransfer !== false && !rules.allowTransfer) {
    memory = { ...memory, status: 'accepted', events: [...memory.events, 'Применены правила этого стола: подкидной дурак, без перевода.'] };
  }
  const action = observation?.action;
  const roleConflict = ['attack', 'defend'].includes(action) && observation?.role != null && observation.role !== action;
  const finishNeedsSnapshot = action === 'finish' && (observation?.role === 'defend'
    || !observation?.table?.length || observation.table.some((pair) => pair.defense === null));
  if (memory.status !== 'review' && action !== 'wait' && !finishNeedsSnapshot && !roleConflict) {
    return { memory, snapshot: null, decision: recovery.observe(memory, context) };
  }
  const snapshot = analyzeSnapshot(sceneForRules??previousForRules, observation, rules);
  if (snapshot.status === 'advisory') {
    // A missing historical transition must not buy another image read or hide
    // legal advice. This snapshot is never committed as exact game memory.
    return {
      memory, snapshot,
      decision: recovery.observe({ status: 'accepted', reasons: [] }, context),
    };
  }
  // An explicit action can contradict an otherwise balanced memory state. Do
  // not return that state as accepted: callers commit accepted memory results.
  const rejected = {
    ...memory, status: 'review', state: null, events: [],
    reasons: [...new Set([...memory.reasons, ...snapshot.reasons])],
  };
  return { memory: rejected, snapshot: null, decision: recovery.observe(rejected, context) };
}
