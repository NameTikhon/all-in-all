import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSnapshot } from '../web/snapshot-advice.js';

const observation = (overrides = {}) => ({
  hand: ['8D', '9H', 'AC', '10S', 'QS'],
  table: [{ attack: '6C', defense: 'KC' }],
  trumpSuit: 'S', trumpCard: '7S', opponentCount: 5, stockCount: null,
  role: 'attack', action: 'finish', confidence: 'high', notes: [], ...overrides,
});

test('the reported covered first bout gets an immediate finish recommendation without history or stock count', () => {
  const result = analyzeSnapshot(null, observation());
  assert.equal(result.status, 'advisory');
  assert.equal(result.analysis.valid, true);
  assert.equal(result.analysis.recommendations[0].type, 'pass');
  assert.match(result.analysis.recommendations[0].title, /ВСЁ/);
  assert.equal(result.state.stockCount, null);
  assert.equal(result.state.discardCount, null);
  assert.equal(result.state.historyComplete, false);
  assert.deepEqual(result.state.discard, []);
  assert.equal(result.analysis.opponentTrumpProbability, null);
  assert.equal(result.analysis.expectedOpponentTrumps, null);
  assert.equal(result.analysis.unseenCount, null);
  assert.equal(result.analysis.knownCount, 8);
});

test('another deal and missed history cannot poison advice or be overwritten', () => {
  const previous = { hand: ['6H'], trumpSuit: 'H', trumpCard: 'JH', stockCount: 17,
    discard: ['6C', 'KC'], knownOpponent: ['AC'], role: 'defend' };
  const before = structuredClone(previous);
  const input = observation();
  const inputBefore = structuredClone(input);
  const result = analyzeSnapshot(previous, input);
  assert.equal(result.status, 'advisory');
  assert.equal(result.state.trumpSuit, 'S');
  assert.equal(result.state.role, 'attack');
  assert.equal(result.analysis.recommendations[0].type, 'pass');
  assert.deepEqual(previous, before);
  assert.deepEqual(input, inputBefore);
  assert.deepEqual(result.state.knownOpponent, []);
});

test('medium confidence is usable after local consistency checks, while low confidence requests another read', () => {
  assert.equal(analyzeSnapshot(null, observation({ confidence: 'medium' })).status, 'advisory');
  const result = analyzeSnapshot(null, observation({ confidence: 'low' }));
  assert.equal(result.status, 'review');
  assert.equal(result.analysis, null);
});

test('duplicate cards, impossible covers and incompatible trump are rejected before giving any advice', () => {
  for (const input of [
    observation({ hand: ['6C', '9H'] }),
    observation({ hand: ['8D', '8D'] }),
    observation({ table: [{ attack: 'AC', defense: 'KC' }] }),
    observation({ trumpCard: '7H' }),
    observation({ hand: ['7S', '8D'] }),
    observation({ opponentCount: 36 }),
  ]) {
    const result = analyzeSnapshot(null, input);
    assert.equal(result.status, 'review');
    assert.equal(result.analysis, null);
    assert.ok(result.reasons.length);
  }
});

test('finish can identify the current attacker but does not override a contradictory role or empty table', () => {
  assert.equal(analyzeSnapshot(null, observation({ role: null })).state.role, 'attack');
  assert.equal(analyzeSnapshot(null, observation({ role: 'defend' })).status, 'review');
  assert.equal(analyzeSnapshot(null, observation({ table: [] })).status, 'review');
});

test('ВСЁ also finishes adding when the opponent takes uncovered attacks', () => {
  const result = analyzeSnapshot(null, observation({ table: [{ attack: '6C', defense: null }] }));
  assert.equal(result.status, 'advisory');
  assert.equal(result.analysis.recommendations[0].type, 'pass');
  assert.match(result.analysis.recommendations[0].title, /подкидывание/);
  assert.match(result.analysis.recommendations[0].reasons.join(' '), /берёт непокрытые/);
  const ordinary = analyzeSnapshot(null, observation({ table: [{ attack: '6C', defense: null }], action: 'unknown' }));
  assert.ok(!ordinary.analysis.recommendations.some((rec) => rec.type === 'pass'));
});

test('an explicit waiting action suppresses all moves even if an old or inferred role is present', () => {
  for (const role of ['attack', 'defend', null]) {
    const result = analyzeSnapshot(null, observation({ action: 'wait', role }));
    assert.equal(result.status, 'advisory');
    assert.equal(result.analysis.waiting, true);
    assert.deepEqual(result.analysis.recommendations, []);
    assert.match(result.analysis.waitingMessage, /соперника/);
  }
});

test('attacks use visible ranks and short-handed capacity, with no made-up response probabilities', () => {
  const result = analyzeSnapshot(null, observation({
    hand: ['6H', 'KD', '8D'], opponentCount: 1, action: 'unknown',
  }));
  assert.deepEqual(result.analysis.recommendations.filter((rec) => rec.type === 'attack').map((rec) => rec.card).sort(), ['6H', 'KD']);
  assert.ok(result.analysis.recommendations.every((rec) => rec.responseProbability === null));
  const exhausted = analyzeSnapshot(null, observation({
    hand: ['6H', 'KD', '8D'], opponentCount: 0, action: 'finish',
  }));
  assert.deepEqual(exhausted.analysis.recommendations.map((rec) => rec.type), ['pass']);
});

test('defense considers complete allocation and will not strand a second pending attack', () => {
  const result = analyzeSnapshot(null, observation({
    hand: ['8S', '9C'], table: [{ attack: '7S', defense: null }, { attack: '8C', defense: null }],
    trumpCard: null, opponentCount: 4, role: 'defend', action: 'defend',
  }));
  assert.equal(result.status, 'advisory');
  const covers = result.analysis.recommendations.filter((rec) => rec.type === 'defend');
  assert.deepEqual(covers.map((rec) => [rec.card, rec.target]).sort(), [['8S', 0], ['9C', 1]]);
  assert.ok(!covers.some((rec) => rec.card === '8S' && rec.target === 1));
  assert.deepEqual(result.analysis.defensePlan.map((move) => [move.card, move.target]).sort(), [['8S', 0], ['9C', 1]]);
});

test('a defense remains usable without seeing the stock or the opponents exact hand count', () => {
  const result = analyzeSnapshot(null, observation({
    hand: ['7C', '6D'], table: [{ attack: '6C', defense: null }],
    role: null, action: 'defend', opponentCount: null,
  }));
  assert.equal(result.status, 'advisory');
  assert.equal(result.analysis.recommendations[0].type, 'defend');
  assert.equal(result.analysis.recommendations[0].card, '7C');
  assert.ok(!result.analysis.recommendations.some((rec) => rec.type === 'transfer'));
});

test('transfer needs enough accepting cards and disappears after a cover or when disabled', () => {
  const input = observation({ hand: ['6H', '8S'], table: [{ attack: '6C', defense: null }],
    role: 'defend', action: 'defend', opponentCount: 2 });
  assert.ok(analyzeSnapshot(null, input).analysis.recommendations.some((rec) => rec.type === 'transfer' && rec.card === '6H'));
  assert.ok(!analyzeSnapshot(null, { ...input, opponentCount: 1 }).analysis.recommendations.some((rec) => rec.type === 'transfer'));
  assert.ok(!analyzeSnapshot(null, input, { allowTransfer: false }).analysis.recommendations.some((rec) => rec.type === 'transfer'));
  const covered = analyzeSnapshot(null, { ...input, table: [{ attack: '6C', defense: '7C' }, { attack: '6D', defense: null }] });
  assert.ok(!covered.analysis.recommendations.some((rec) => rec.type === 'transfer'));
});

test('a former bottom trump can be in hand after observed stock exhaustion, but hidden stock is never inferred as empty', () => {
  const input = observation({ hand: ['7S'], stockCount: 0 });
  const ended = analyzeSnapshot(null, input);
  assert.equal(ended.status, 'advisory');
  assert.equal(ended.state.stockCount, 0);
  assert.equal(analyzeSnapshot(null, { ...input, stockCount: null }).status, 'review');
});

test('a fully covered defensive table waits, and current role is never inherited from stale history', () => {
  const waiting = analyzeSnapshot(null, observation({ role: 'defend', action: 'unknown' }));
  assert.equal(waiting.analysis.waiting, true);
  assert.deepEqual(waiting.analysis.recommendations, []);
  assert.equal(analyzeSnapshot({ role: 'attack' }, observation({ role: null, action: 'unknown' })).status, 'review');
});

test('HLop single-player empty table has an opening move even though its button is hidden', () => {
  const input = observation({ hand: ['6D', '9H', '10D', '10H', 'QC', 'AD'], table: [],
    trumpCard: 'KS', opponentCount: 6, role: null, action: 'unknown' });
  const before = structuredClone(input);
  for (const confidence of ['high', 'medium']) {
    const result = analyzeSnapshot(null, { ...input, confidence }, { gameProfile: 'hlop-singleplayer' });
    assert.equal(result.status, 'advisory');
    assert.equal(result.state.role, 'attack');
    assert.equal(result.state.allowTransfer, false);
    assert.equal(result.analysis.recommendations[0].type, 'attack');
    assert.equal(result.analysis.recommendations[0].card, '6D');
    assert.match(result.analysis.assumptions.join(' '), /компьютер ходит автоматически/);
  }
  assert.deepEqual(input, before);
  // The same pixels on another site's interface do not establish turn order.
  assert.equal(analyzeSnapshot(null, input).status, 'review');
  assert.equal(analyzeSnapshot(null, input, { gameProfile: 'universal-transfer' }).status, 'review');
});

test('a single-player profile does not turn unreadable cards or explicit waiting into an attack', () => {
  const input = observation({ hand: ['6D', '9H', '10D', '10H', 'QC', 'AD'], table: [],
    trumpCard: 'KS', opponentCount: 6, role: null, action: 'unknown' });
  const options = { gameProfile: 'hlop-singleplayer' };
  for (const invalid of [
    { ...input, confidence: 'low' }, { ...input, hand: null }, { ...input, table: null },
    { ...input, hand: ['6D', '6D'] }, { ...input, trumpSuit: null }, { ...input, opponentCount: null },
    { ...input, table: [{ attack: '6C', defense: null }] },
  ]) assert.equal(analyzeSnapshot(null, invalid, options).status, 'review');
  for (const explicit of [{ ...input, action: 'wait' }, { ...input, role: 'defend' }]) {
    const result = analyzeSnapshot(null, explicit, options);
    assert.equal(result.status, 'advisory');
    assert.equal(result.analysis.waiting, true);
    assert.deepEqual(result.analysis.recommendations, []);
  }
});

test('single-player site rules forbid a transfer that the generic game permits', () => {
  const input = observation({ hand: ['6H', '8S'], table: [{ attack: '6C', defense: null }],
    role: 'defend', action: 'defend', opponentCount: 2 });
  assert.ok(analyzeSnapshot(null, input).analysis.recommendations.some(move => move.type === 'transfer'));
  const result = analyzeSnapshot(null, input, { gameProfile: 'hlop-singleplayer', allowTransfer: true });
  assert.equal(result.state.allowTransfer, false);
  assert.ok(!result.analysis.recommendations.some(move => move.type === 'transfer'));
});
