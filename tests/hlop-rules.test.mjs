import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSnapshot } from '../web/snapshot-advice.js';
import { analyze } from '../web/durak.js';
import { resolveAutomaticObservation } from '../web/auto-advice.js';
import { createAutoSession } from '../web/auto-session.js';
import { createAutoRecovery } from '../web/auto-recovery.js';

const options = { gameProfile: 'hlop-singleplayer' };
const defending = {
  hand: ['7C', '8D', '9H', 'AC', '10S', 'QS'],
  table: [{ attack: '6C', defense: null }],
  trumpSuit: 'S', trumpCard: '7S', opponentCount: 5, stockCount: null,
  role: 'defend', action: 'defend', confidence: 'high', notes: [],
};
const pickedUp = {
  ...defending, hand: [...defending.hand, '6C'], table: [], opponentCount: 6,
  role: null, action: 'unknown',
};
const scene = observation => ({ ...observation, historyComplete: false, allowTransfer: false });

test('HLop pickup waits for the opponent, including repeated empty-table observations', () => {
  const before = structuredClone(defending);
  const input = structuredClone(pickedUp);
  const result = analyzeSnapshot(scene(defending), pickedUp, options);
  assert.equal(result.status, 'advisory');
  assert.equal(result.state.role, 'defend');
  assert.equal(result.analysis.waiting, true);
  assert.deepEqual(result.analysis.recommendations, []);
  const guessedAttack = analyzeSnapshot(scene(defending), { ...pickedUp, role: 'attack' }, options);
  assert.equal(guessedAttack.analysis.waiting, true);
  assert.deepEqual(guessedAttack.analysis.recommendations, []);
  const repeated = analyzeSnapshot(result.state, { ...pickedUp, hand: [...pickedUp.hand].reverse() }, options);
  assert.equal(repeated.analysis.waiting, true);
  assert.deepEqual(repeated.analysis.recommendations, []);
  const nextAttack = analyzeSnapshot(result.state, {
    ...pickedUp, table: [{ attack: '8C', defense: null }], opponentCount: 5,
    role: 'defend', action: 'defend',
  }, options);
  assert.equal(nextAttack.analysis.waiting, false);
  assert.ok(nextAttack.analysis.recommendations.some(move => move.type === 'defend' && move.card === 'AC'));
  assert.deepEqual(defending, before);
  assert.deepEqual(pickedUp, input);
});

test('pickup waiting works with exact memory and with incomplete history from another deal', () => {
  for (const saved of [null, {
    hand: ['JC', 'JD', 'QC', 'KS', '6H', '8H'], table: [], discard: [], knownOpponent: [],
    trumpSuit: 'H', trumpCard: 'JH', opponentCount: 6, stockCount: 24,
    role: 'attack', attackLimit: 6, allowTransfer: true,
  }]) {
    const context = { ...options, session: createAutoSession(), recovery: createAutoRecovery() };
    const first = resolveAutomaticObservation(saved, defending, { ...context, positionKey: 'before-pickup' });
    const currentMemory = first.memory.status === 'accepted' ? first.memory.state : saved;
    const previousScene = scene(first.snapshot?.state ?? first.memory.state);
    const result = resolveAutomaticObservation(currentMemory, pickedUp, {
      ...context, previousScene, positionKey: 'after-pickup',
    });
    assert.equal(result.decision.action, 'accept');
    assert.equal(result.decision.retry, false);
    assert.equal(result.snapshot.analysis.waiting, true);
    assert.equal(result.snapshot.state.role, 'defend');
    assert.deepEqual(result.snapshot.analysis.recommendations, []);
    if (saved === null) {
      assert.equal(result.memory.status, 'accepted');
      assert.equal(result.memory.state.role, 'defend');
      assert.equal(result.memory.state.stockCount, 23);
      assert.deepEqual(result.memory.state.discard, []);
    }
  }
});

test('HLop successful defense still leads to our attack, while uncertain clears do not invent it', () => {
  const afterDefense = {
    ...pickedUp, hand: ['KD', ...defending.hand.filter(card => card !== '7C')],
  };
  const result = analyzeSnapshot(scene(defending), afterDefense, options);
  assert.equal(result.state.role, 'attack');
  assert.equal(result.analysis.waiting, false);
  assert.ok(result.analysis.recommendations.some(move => move.type === 'attack'));
  const uncertain = analyzeSnapshot(scene(defending), {
    ...pickedUp, hand: ['KD', 'JD', ...defending.hand.slice(2)],
  }, options);
  assert.equal(uncertain.status, 'review');
});

test('pickup inference handles unseen matching throw-ins, partial covers, and a short hand drawing to six', () => {
  const cases = [
    [defending, { ...pickedUp, hand: [...pickedUp.hand, '6D'] }],
    [{ ...defending, hand: defending.hand.slice(1),
      table: [{ attack: '6D', defense: '7D' }, { attack: '6C', defense: null }], opponentCount: 4 },
    { ...pickedUp, hand: [...defending.hand.slice(1), '6D', '7D', '6C'] }],
    [{ ...defending, hand: ['7C', '8D'], stockCount: 20 },
    { ...pickedUp, hand: ['7C', '8D', '6C', 'KD', 'JD', 'AH'], stockCount: 16 }],
    [{ ...defending, stockCount: 0 }, { ...pickedUp, opponentCount: 5, stockCount: 0 }],
  ];
  for (const [previous, current] of cases) {
    const result = analyzeSnapshot(scene(previous), current, options);
    assert.equal(result.status, 'advisory');
    assert.equal(result.analysis.waiting, true);
    assert.deepEqual(result.analysis.recommendations, []);
  }
  const impossible = analyzeSnapshot(scene({ ...defending, stockCount: 0 }), pickedUp, options);
  assert.equal(impossible.status, 'review');
});

test('a visible opponent pickup still lets us attack the next bout', () => {
  const previous = scene({ ...defending, role: 'attack', action: 'attack' });
  const current = { ...pickedUp, hand: defending.hand, opponentCount: 6 };
  const result = analyzeSnapshot(previous, current, options);
  assert.equal(result.state.role, 'attack');
  assert.ok(result.analysis.recommendations.some(move => move.type === 'attack'));
});

const multipleAttacks = {
  ...defending, hand: ['8S', '9C'], trumpCard: '6S', opponentCount: 4,
  table: [{ attack: '7S', defense: null }, { attack: '7C', defense: null }],
};

test('HLop snapshot defense offers only the first uncovered column and retains a full defense plan', () => {
  const generic = analyzeSnapshot(null, multipleAttacks);
  assert.deepEqual(generic.analysis.recommendations.filter(move => move.type === 'defend').map(move => move.target).sort(), [0, 1]);
  const result = analyzeSnapshot(null, multipleAttacks, options);
  assert.deepEqual(result.analysis.recommendations.filter(move => move.type === 'defend').map(move => [move.card, move.target]), [['8S', 0]]);
  assert.deepEqual(result.analysis.defensePlan, [{ card: '8S', target: 0 }, { card: '9C', target: 1 }]);
  const next = analyzeSnapshot(result.state, {
    ...multipleAttacks, hand: ['9C'],
    table: [{ attack: '7S', defense: '8S' }, { attack: '7C', defense: null }],
  }, options);
  assert.deepEqual(next.analysis.recommendations.filter(move => move.type === 'defend').map(move => [move.card, move.target]), [['9C', 1]]);
});

test('HLop exact-history analysis also restricts the next cover to the leftmost uncovered column', () => {
  const state = { ...multipleAttacks, stockCount: 28, attackLimit: 6, allowTransfer: false, discard: [], knownOpponent: [] };
  const before = structuredClone(state);
  assert.equal(analyze(state).recommendations.filter(move => move.type === 'defend').length, 2);
  const result = analyze(state, options);
  assert.equal(result.valid, true);
  assert.deepEqual(result.recommendations.filter(move => move.type === 'defend').map(move => [move.card, move.target]), [['8S', 0]]);
  assert.deepEqual(result.defensePlan, [{ card: '8S', target: 0 }, { card: '9C', target: 1 }]);
  assert.deepEqual(state, before);
});

test('automatic exact memory preserves newly observed column order for otherwise unchanged cards', () => {
  const context = { ...options, session: createAutoSession(), recovery: createAutoRecovery() };
  const state = { ...multipleAttacks, stockCount: 28, attackLimit: 6, allowTransfer: false, discard: [], knownOpponent: [] };
  const input = { ...multipleAttacks, stockCount: 28, table: [...multipleAttacks.table].reverse() };
  const result = resolveAutomaticObservation(state, input, { ...context, positionKey: 'current-order' });
  assert.equal(result.memory.status, 'accepted');
  assert.deepEqual(result.memory.state.table, input.table);
  const analysis = analyze(result.memory.state, options);
  assert.deepEqual(analysis.recommendations.filter(move => move.type === 'defend').map(move => [move.card, move.target]), [['9C', 0]]);
  assert.deepEqual(state.table, multipleAttacks.table);
});

