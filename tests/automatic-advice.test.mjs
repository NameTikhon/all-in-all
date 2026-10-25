import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAutomaticObservation } from '../web/auto-advice.js';
import { createAutoRecovery } from '../web/auto-recovery.js';
import { createAutoSession } from '../web/auto-session.js';
import { analyze, validateState } from '../web/durak.js';
import { createAutoMonitor } from '../web/auto-loop.js';

// The response actually obtained from GenAPI for the user's latest supplied
// screenshot. Keep the fixture here so tests never need artifacts, secrets or
// another paid API request.
const LATEST_PAID_OBSERVATION = {
  action: 'finish', confidence: 'high', hand: ['8D', '9H', 'AC', '10S', 'QS'],
  notes: ['Счётчик колоды не виден.'], opponentCount: 5, role: 'attack', stockCount: null,
  table: [{ attack: '6C', defense: 'KC' }], trumpCard: '7S', trumpSuit: 'S',
};
const OLD_MEMORY = {
  hand: ['JC', 'JD', 'QC', 'KS', '6H', '8H'], table: [], discard: [], knownOpponent: [],
  trumpSuit: 'H', trumpCard: 'JH', opponentCount: 6, stockCount: 24,
  role: 'attack', attackLimit: 6, allowTransfer: true,
};
const makeContext = () => ({ session: createAutoSession(), recovery: createAutoRecovery(), positionKey: 'stable-current-frame' });
const displayAnalysis = (result) => result.snapshot?.analysis ?? analyze(result.memory.state);

test('latest reported empty opening produces advice on the first read for the configured site', () => {
  const input = { confidence: 'high', action: 'unknown', hand: ['6D', '9H', '10D', '10H', 'QC', 'AD'],
    table: [], trumpSuit: 'S', trumpCard: 'KS', opponentCount: 6, stockCount: null, role: null, notes: [] };
  for (const previous of [null, OLD_MEMORY]) {
    const result = resolveAutomaticObservation(previous, input, { ...makeContext(), gameProfile: 'hlop-singleplayer' });
    assert.equal(result.decision.action, 'accept');
    assert.equal(result.decision.retry, false);
    assert.equal(displayAnalysis(result).recommendations[0].card, '6D');
    assert.equal((result.snapshot?.state ?? result.memory.state).allowTransfer, false);
  }
  const generic = resolveAutomaticObservation(null, input, makeContext());
  assert.equal(generic.snapshot, null);
  assert.equal(generic.memory.status, 'review');
});

test('site rules replace a stale transfer setting in exact memory without mutating saved data', () => {
  const input = { confidence: 'high', action: 'defend', hand: ['6D', '7C', '10D', '10H', 'QC', 'AD'],
    table: [{ attack: '6C', defense: null }], trumpSuit: 'S', trumpCard: 'KS', opponentCount: 5,
    stockCount: 24, role: 'defend', notes: [] };
  const previous = { ...OLD_MEMORY, ...input, discard: [], knownOpponent: [], allowTransfer: true };
  const before = structuredClone(previous);
  assert.ok(analyze(previous).recommendations.some(move => move.type === 'transfer'));
  const result = resolveAutomaticObservation(previous, input, { ...makeContext(), gameProfile: 'hlop-singleplayer' });
  assert.equal(result.memory.status, 'accepted');
  assert.equal(result.memory.state.allowTransfer, false);
  assert.ok(!displayAnalysis(result).recommendations.some(move => move.type === 'transfer'));
  assert.deepEqual(previous, before);
});

test('partial current scenes continue after our missed defense even while exact saved memory belongs to another deal',()=>{
  const context=makeContext();
  const first={confidence:'high',action:'defend',hand:['7S','KS','KD','AD','10C','JC'],table:[{attack:'6H',defense:null}],trumpSuit:'C',trumpCard:'AC',opponentCount:5,stockCount:null,role:'defend',notes:[]};
  const current=resolveAutomaticObservation(OLD_MEMORY,first,context);
  assert.equal(current.snapshot.analysis.recommendations[0].card,'10C');
  const after={...first,action:'unknown',role:null,table:[],hand:['7S','8H','KS','KD','AD','JC'],opponentCount:6};
  const next=resolveAutomaticObservation(OLD_MEMORY,after,{...context,positionKey:'after-defense',previousScene:current.snapshot.state});
  assert.equal(next.decision.retry,false);
  assert.equal(next.snapshot.state.role,'attack');
  assert.ok(next.snapshot.analysis.recommendations.some(move=>move.type==='attack'));
  assert.equal(next.snapshot.state.stockCount,null);
  assert.equal(next.snapshot.analysis.opponentTrumpProbability,null);
});

test('partial temporal role inference rejects changed trump, unexplained losses and ambiguous transfer',()=>{
  const context=makeContext();
  const previousScene={historyComplete:false,hand:['10C','7S','KS','KD','AD','JC'],table:[{attack:'6H',defense:null}],trumpSuit:'C',trumpCard:'AC',opponentCount:5,stockCount:null,role:'defend',allowTransfer:true};
  const after={confidence:'high',action:'unknown',hand:['8H','7S','KS','KD','AD','JC'],table:[],trumpSuit:'C',trumpCard:'AC',opponentCount:6,stockCount:null,role:null,notes:[]};
  for(const observation of [{...after,trumpCard:'KC'},{...after,hand:['8H','7S','KS','KD','AD','9D']}]) {
    const result=resolveAutomaticObservation(OLD_MEMORY,observation,{...makeContext(),previousScene});
    assert.equal(result.snapshot,null);
    assert.equal(result.decision.retry,true);
  }
  const ambiguousScene={...previousScene,hand:['6C','7S','KS','KD','AD','JC']};
  const ambiguous=resolveAutomaticObservation(OLD_MEMORY,after,{...context,previousScene:ambiguousScene});
  assert.equal(ambiguous.snapshot,null);
  assert.equal(ambiguous.decision.retry,true);
});

test('the real paid observation produces finish advice on its first read without manual data', () => {
  const result = resolveAutomaticObservation(null, structuredClone(LATEST_PAID_OBSERVATION), makeContext());
  assert.equal(result.decision.action, 'accept');
  assert.equal(result.decision.retry, false);
  assert.equal(displayAnalysis(result).recommendations[0].type, 'pass');
  assert.deepEqual(result.memory.state.hand, LATEST_PAID_OBSERVATION.hand);
  assert.deepEqual(validateState(result.memory.state), []);
});

test('old saved trump cannot hide current advice or force a paid confirmation for readable cards', () => {
  const previous = structuredClone(OLD_MEMORY);
  const before = structuredClone(previous);
  const result = resolveAutomaticObservation(previous, LATEST_PAID_OBSERVATION, makeContext());
  assert.equal(result.memory.status, 'review');
  assert.equal(result.memory.retryRequired, true, 'exact-history session would normally ask for another new-game confirmation');
  assert.equal(result.memory.state, null);
  assert.equal(result.snapshot.status, 'advisory');
  assert.equal(result.snapshot.state.trumpCard, '7S');
  assert.equal(result.snapshot.state.stockCount, null);
  assert.equal(result.snapshot.analysis.recommendations[0].type, 'pass');
  assert.equal(result.decision.action, 'accept');
  assert.equal(result.decision.retry, false);
  assert.deepEqual(previous, before);
});

test('a skipped clear plus the next attack gives current legal defense without rewriting confirmed history', () => {
  const context = makeContext();
  const first = resolveAutomaticObservation(null, LATEST_PAID_OBSERVATION, context);
  const previous = structuredClone(first.memory.state);
  const before = structuredClone(previous);
  const next = {
    ...LATEST_PAID_OBSERVATION, action: 'defend', role: 'defend',
    hand: ['8D', '9H', 'AC', '10S', 'QS', '6H'],
    table: [{ attack: '7C', defense: null }], opponentCount: 5,
  };
  const result = resolveAutomaticObservation(previous, next, { ...context, positionKey: 'next-attack' });
  assert.equal(result.memory.status, 'review');
  assert.equal(result.snapshot.status, 'advisory');
  assert.equal(result.snapshot.state.role, 'defend');
  assert.deepEqual(result.snapshot.state.table, next.table);
  assert.equal(result.snapshot.analysis.recommendations[0].type, 'defend');
  assert.equal(result.snapshot.analysis.recommendations[0].card, 'AC');
  assert.equal(result.snapshot.analysis.recommendations[0].target, 0);
  assert.equal(result.decision.retry, false);
  assert.equal(result.snapshot.analysis.opponentTrumpProbability, null);
  assert.deepEqual(previous, before);
  // Model the UI ownership rule: only exact accepted states may be committed.
  let confirmedMemory = previous;
  if (result.memory.status === 'accepted') confirmedMemory = result.memory.state;
  assert.equal(confirmedMemory, previous);
  assert.notEqual(confirmedMemory, result.snapshot.state);
});

test('readable medium-confidence current cards resolve immediately without spending the retry allowance', () => {
  const context = makeContext();
  const result = resolveAutomaticObservation(OLD_MEMORY, { ...LATEST_PAID_OBSERVATION, confidence: 'medium' }, context);
  assert.equal(result.memory.status, 'review');
  assert.equal(result.snapshot.status, 'advisory');
  assert.equal(result.decision.action, 'accept');
  assert.equal(result.decision.retriesUsed, 0);
});

test('waiting suppresses moves even when the scene is compatible with exact game memory', () => {
  const context = makeContext();
  const result = resolveAutomaticObservation(null, { ...LATEST_PAID_OBSERVATION, action: 'wait' }, context);
  assert.equal(result.memory.status, 'accepted');
  assert.equal(result.snapshot.analysis.waiting, true);
  assert.deepEqual(result.snapshot.analysis.recommendations, []);
  assert.equal(result.decision.action, 'accept');
  assert.equal(result.decision.retry, false);
});

test('a visible finish button allows ending a take even when exact memory has pending attacks', () => {
  const result = resolveAutomaticObservation(null, {
    ...LATEST_PAID_OBSERVATION, table: [{ attack: '6C', defense: null }], opponentCount: 6,
  }, makeContext());
  assert.equal(result.memory.status, 'accepted');
  assert.equal(result.snapshot.status, 'advisory');
  const finish = result.snapshot.analysis.recommendations[0];
  assert.equal(finish.type, 'pass');
  assert.match(finish.title, /ВСЁ/);
  assert.match(finish.reasons.join(' '), /берёт непокрытые/);
  assert.equal(result.decision.retry, false);
});

test('an explicit role/action contradiction cannot be committed even when card counts balance', () => {
  const result = resolveAutomaticObservation(null, {
    ...LATEST_PAID_OBSERVATION,
    hand: ['8D', '9H', 'AC', '10S', 'QS', '6H'],
    table: [{ attack: '6C', defense: null }], role: 'defend', action: 'attack',
  }, makeContext());
  assert.equal(result.memory.status, 'review');
  assert.equal(result.memory.state, null);
  assert.equal(result.snapshot, null);
  assert.equal(result.decision.action, 'retry');
  assert.match(result.decision.reasons.join(' '), /согласуется/);
});

test('genuinely unreadable current cards get two bounded rereads, while preserving prior memory', () => {
  const context = makeContext();
  const previous = structuredClone(OLD_MEMORY);
  const before = structuredClone(previous);
  const unreadable = { ...LATEST_PAID_OBSERVATION, hand: null, confidence: 'low' };
  const decisions = Array.from({ length: 4 }, () => resolveAutomaticObservation(previous, unreadable, context));
  assert.deepEqual(decisions.map((result) => result.decision.action), ['retry', 'retry', 'wait', 'wait']);
  assert.ok(decisions.every((result) => result.memory.state === null && result.snapshot === null));
  assert.deepEqual(previous, before);
});

test('monitor restores readable current advice from its cache after a failed scene without extra paid reads', async () => {
  let time = 0, timerId = 0, scene = 0, calls = 0;
  const timers = new Map();
  const tick = async (duration) => {
    const target = time + duration;
    for (let turns = 0; turns < 1000; turns++) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) { time = target; return; }
      time = next[1].at; timers.delete(next[0]); await next[1].callback();
    }
    throw new Error('Monitor failed to settle.');
  };
  const context = makeContext();
  let confirmed = structuredClone(OLD_MEMORY), visible = null;
  const original = structuredClone(confirmed);
  const observations = [LATEST_PAID_OBSERVATION, { ...LATEST_PAID_OBSERVATION, hand: null, confidence: 'low' }];
  const applied = [];
  const monitor = createAutoMonitor({
    intervalMs: 1, minRequestIntervalMs: 1, stableSamples: 1, maxRequests: 10,
    now: () => time,
    setTimer: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimer: (id) => timers.delete(id),
    capture: async () => ({ image: `scene-${scene}`, signature: new Uint8Array(64 * 36).fill(scene ? 220 : 30) }),
    recognize: async (image) => { calls++; return structuredClone(observations[Number(image.slice(-1))]); },
    onResult: (observation, frameContext) => {
      const result = resolveAutomaticObservation(confirmed, observation, { ...context, ...frameContext });
      if (result.memory.status === 'accepted') confirmed = result.memory.state;
      visible = result.snapshot;
      applied.push({ cached: frameContext.cached, result });
      return result.decision;
    },
  });
  monitor.start();
  try {
    await tick(5);
    assert.equal(calls, 1);
    assert.equal(visible.analysis.recommendations[0].type, 'pass');
    scene = 1;
    await tick(8);
    assert.equal(calls, 4, 'the unreadable scene receives only its two allowed rereads');
    assert.equal(visible, null);
    scene = 0;
    await tick(5);
    assert.equal(calls, 4, 'returning to a previously readable scene is free');
    assert.equal(visible.analysis.recommendations[0].type, 'pass');
    assert.equal(applied.at(-1).cached, true);
    assert.deepEqual(visible.state.hand, LATEST_PAID_OBSERVATION.hand);
    assert.deepEqual(confirmed, original, 'all snapshot advice leaves the old exact history intact');
  } finally { monitor.stop(); }
});
