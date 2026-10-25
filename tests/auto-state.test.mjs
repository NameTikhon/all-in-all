import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileObservation, observationFingerprint } from '../web/auto-state.js';
import { analyze, makeDeck, validateState } from '../web/durak.js';

const OPEN_HAND = ['6C', '7C', '8C', '9D', 'QH', 'AS'];
function position(overrides = {}) {
  const state = { hand: [...OPEN_HAND], table: [], discard: [], knownOpponent: [], trumpSuit: 'H', trumpCard: '6H', opponentCount: 6, stockCount: 24, role: 'attack', attackLimit: 6, allowTransfer: true, ...overrides };
  if (!Object.hasOwn(overrides, 'stockCount')) state.stockCount = 36 - state.hand.length - state.table.flatMap((pair) => [pair.attack, pair.defense].filter(Boolean)).length - state.discard.length - state.opponentCount;
  assert.deepEqual(validateState(state), [], 'test fixture must represent a valid position');
  return state;
}
function observe(state, overrides = {}) {
  return { hand: [...state.hand], table: state.table.map((pair) => ({ ...pair })), trumpSuit: state.trumpSuit, trumpCard: state.trumpCard, opponentCount: state.opponentCount, stockCount: state.stockCount, role: state.role, confidence: 'high', notes: [], ...overrides };
}
function accepted(result) {
  assert.equal(result.status, 'accepted', result.reasons.join('\n'));
  assert.deepEqual(validateState(result.state), []);
  return result.state;
}

test('opening observation establishes all memory and infers only the opening stock', () => {
  const initial = position();
  const result = reconcileObservation(null, observe(initial, { stockCount: null }), { initial: true });
  const state = accepted(result);
  assert.equal(state.stockCount, 24);
  assert.deepEqual(state.discard, []);
  assert.deepEqual(state.knownOpponent, []);
  assert.match(result.reasons.join(' '), /самой моделью/);
});

test('first observation needs an explicit new party and cannot invent unseen late discard', () => {
  assert.equal(reconcileObservation(null, observe(position())).status, 'review');
  const late = observe(position(), { hand: ['6C', '7C'], opponentCount: 2, stockCount: 20 });
  const result = reconcileObservation(null, late, { initial: true });
  assert.equal(result.status, 'review');
  assert.match(result.reasons.join(' '), /история 12 карт/);
  assert.equal(result.state, null);
});

test('exact initial snapshot with a first visible attack has no unknown discard', () => {
  const state = position({ hand: OPEN_HAND.slice(1), table: [{ attack: '6C', defense: null }], attackLimit: 6 });
  assert.deepEqual(accepted(reconcileObservation(null, observe(state), { initial: true })), state);
});

test('first opponent attack from the reported screenshot bootstraps without a visible stock counter', () => {
  const observation = {
    hand: ['7S', 'KS', 'KD', 'AD', '10C', 'JC'],
    table: [{ attack: '6H', defense: null }],
    trumpSuit: 'C', trumpCard: 'AC', opponentCount: 5, stockCount: null,
    role: 'defend', confidence: 'high', notes: [],
  };
  const result = reconcileObservation(null, observation, { initial: true });
  const state = accepted(result);
  assert.equal(state.stockCount, 24);
  assert.equal(state.hand.length + state.opponentCount + 1 + state.stockCount, 36);
  assert.deepEqual(state.discard, []);
  assert.equal(state.attackLimit, 6);
  assert.match(result.reasons.join(' '), /предположение о начале партии/);
  const defenses = analyze(state).recommendations.filter((move) => move.type === 'defend').map((move) => move.card).sort();
  assert.deepEqual(defenses, ['10C', 'JC']);
  assert.equal(reconcileObservation(null, observation).status, 'review', 'opening inference requires explicit new-session initialization');
});

test('unknown opening stock supports our first attack and either player covering it', () => {
  for (const state of [
    position({ hand: OPEN_HAND.slice(1), table: [{ attack: '6C', defense: null }] }),
    position({ hand: OPEN_HAND.slice(1), table: [{ attack: '6C', defense: 'AC' }], opponentCount: 5 }),
    position({ hand: OPEN_HAND.slice(1), table: [{ attack: '6D', defense: '6C' }], opponentCount: 5, role: 'defend', trumpSuit: 'C', trumpCard: 'AC' }),
  ]) {
    const after = accepted(reconcileObservation(null, observe(state, { stockCount: null }), { initial: true }));
    assert.equal(after.stockCount, 24);
    assert.equal(after.attackLimit, 6, 'covered cards still count toward receiver hand at start of the bout');
  }
});

test('opening reachability handles multiple attacks and covers regardless of pair ordering', () => {
  const state = position({ hand: ['8D', '9D', 'QH', 'AD'], opponentCount: 4,
    table: [{ attack: '7S', defense: 'AS' }, { attack: '6C', defense: '7C' }] });
  const after = accepted(reconcileObservation(null, observe(state, { stockCount: null }), { initial: true }));
  assert.equal(after.stockCount, 24);
  assert.equal(after.attackLimit, 6);
});

test('opening transfer ownership is inferred from hands and reachable transfer chains', () => {
  const state = position({ hand: ['7C', '8C', '9D', 'QH', 'AS'], opponentCount: 5,
    table: [{ attack: '6H', defense: null }, { attack: '6D', defense: null }], role: 'attack', trumpCard: 'AH' });
  const transferred = accepted(reconcileObservation(null, observe(state, { stockCount: null }), { initial: true }));
  assert.equal(transferred.stockCount, 24);
  assert.equal(transferred.attackLimit, 5);
  assert.equal(reconcileObservation(null, observe(state, { stockCount: null }), { initial: true, allowTransfer: false }).status, 'review');
  const returned = position({ ...state, opponentCount: 4,
    table: [...state.table, { attack: '6S', defense: null }], role: 'defend' });
  assert.equal(accepted(reconcileObservation(null, observe(returned, { stockCount: null }), { initial: true })).attackLimit, 5);
});

test('twelve visible-and-held opening cards do not suffice with impossible ownership or rank additions', () => {
  const state = position();
  for (const overrides of [
    { hand: OPEN_HAND.slice(1), opponentCount: 6, role: 'defend', table: [{ attack: '6C', defense: null }] },
    { hand: OPEN_HAND.slice(2), opponentCount: 5, role: 'attack', table: [{ attack: '6C', defense: '7C' }, { attack: 'KS', defense: null }] },
    { hand: [...OPEN_HAND, 'KS'], opponentCount: 4, role: 'defend', table: [{ attack: '6S', defense: null }] },
  ]) {
    const result = reconcileObservation(null, observe(state, { ...overrides, stockCount: null }), { initial: true });
    assert.equal(result.status, 'review');
    assert.equal(result.state, null);
  }
});

test('fingerprints and unchanged positions ignore hand/table order without changing target order', () => {
  const state = position({ table: [{ attack: '6D', defense: '7D' }, { attack: '7S', defense: null }], opponentCount: 3 });
  const observation = observe(state, { hand: [...state.hand].reverse(), table: [...state.table].reverse(), notes: ['different description'] });
  assert.equal(observationFingerprint(observe(state)), observationFingerprint(observation));
  const result = reconcileObservation(state, observation);
  assert.equal(result.status, 'unchanged', result.reasons.join(' '));
  assert.deepEqual(result.state, state);
  assert.notEqual(result.state, state);
  assert.notEqual(result.state.table, state.table);
});

test('missing full fields and low or medium self-reported confidence need review', () => {
  const state = position();
  for (const overrides of [{ hand: null }, { table: null }, { opponentCount: null }, { confidence: 'low' }, { confidence: 'medium' }]) {
    const result = reconcileObservation(state, observe(state, overrides));
    assert.equal(result.status, 'review', JSON.stringify(overrides));
    assert.equal(result.state, null);
  }
  const nonOpening = observe(state, { hand: OPEN_HAND.slice(1), opponentCount: 7, stockCount: null });
  assert.equal(reconcileObservation(null, nonOpening, { initial: true }).status, 'review');
  assert.equal(reconcileObservation(null, observe(state, { role: null }), { initial: true }).status, 'review');
  assert.equal(reconcileObservation(state, observe(state, { role: null })).status, 'unchanged');
  assert.equal(reconcileObservation(state, observe(state, { role: null, hand: OPEN_HAND.slice(1), table: [{ attack: '6C', defense: null }] })).status, 'review');
});

test('reported post-move screenshot recovers our missed defense, refill and next attack', () => {
  const opening = {
    hand: ['7S', 'KS', 'KD', 'AD', '10C', 'JC'], table: [{ attack: '6H', defense: null }],
    trumpSuit: 'C', trumpCard: 'AC', opponentCount: 5, stockCount: null, role: 'defend', confidence: 'high', notes: [],
  };
  const before = accepted(reconcileObservation(null, opening, { initial: true }));
  const next = { ...opening, hand: ['7S', '8H', 'KS', 'KD', 'AD', 'JC'], table: [], opponentCount: 6, role: null };
  for (const overrides of [{}, { role: 'attack' }, { stockCount: 22 }]) {
    const result = reconcileObservation(before, { ...next, ...overrides });
    const after = accepted(result);
    assert.deepEqual(after.hand, next.hand);
    assert.deepEqual(after.discard, ['6H', '10C']);
    assert.equal(after.stockCount, 22);
    assert.equal(after.role, 'attack');
    assert.equal(after.attackLimit, 6);
    assert.equal(after.hand.length + after.opponentCount + after.discard.length + after.stockCount, 36);
    assert.match(result.events.join(' '), /Восстановлено покрытие между кадрами/);
    assert.ok(analyze(after).recommendations.some((move) => move.type === 'attack'), 'the recovered position must provide the next actionable advice');
  }
  assert.deepEqual(before.hand, opening.hand, 'recovery must preserve the last confirmed snapshot');
  assert.deepEqual(before.discard, []);
});

test('missed multiple own covers use a complete matching rather than greedy pairing', () => {
  const before = position({ hand: ['7H', '7C', '8D', '9D', 'QH', 'AS'],
    table: [{ attack: '6C', defense: null }, { attack: '6S', defense: null }], opponentCount: 4, role: 'defend', trumpCard: 'AH' });
  const result = reconcileObservation(before, observe(before, { hand: ['8D', '9D', 'QH', 'AS', 'JD', 'JS'], table: [], opponentCount: 6, stockCount: null, role: null }));
  const after = accepted(result);
  assert.deepEqual(after.discard, ['6C', '6S', '7H', '7C']);
  assert.equal(after.stockCount, before.stockCount - 4);
  assert.equal(after.role, 'attack');
});

test('missed last own cover retains already covered cards and older discard', () => {
  const before = position({ hand: ['7C', '8C', '9D', 'QH', 'AS', '10D'],
    table: [{ attack: '6D', defense: '7D' }, { attack: '6S', defense: null }], opponentCount: 4, role: 'defend', discard: ['KC'] });
  const after = accepted(reconcileObservation(before, observe(before, { hand: ['7C', '8C', '9D', 'QH', '10D', 'JD'], table: [], opponentCount: 6, stockCount: null, role: null })));
  assert.deepEqual(after.discard, ['KC', '6D', '7D', '6S', 'AS']);
  assert.equal(after.stockCount, before.stockCount - 3);
});

test('recovery rejects invalid, incomplete, unexplained or contradictory vanished own cards', () => {
  const before = position({ hand: ['7S', 'KS', 'KD', 'AD', '10C', 'JC'], table: [{ attack: '6H', defense: null }],
    trumpSuit: 'C', trumpCard: 'AC', opponentCount: 5, role: 'defend' });
  const hand = ['7S', '8H', 'KS', 'KD', 'AD', 'JC'];
  for (const overrides of [
    { hand: ['8H', 'KS', 'KD', 'AD', '10C', 'JC'] }, // 7S cannot cover 6H.
    { hand: ['7S', '8H', 'KS', 'KD', 'AD', '9C'] }, // Two missing cards for one attack.
    { hand: ['7S', '6H', 'KS', 'KD', 'AD', 'JC'] }, // Partial / contradictory pickup.
    { role: 'defend' },
    { stockCount: 23 },
    { opponentCount: 4 },
    { opponentCount: 7 }, // A covered-bout refill cannot increase the opponent beyond six.
    { hand: [...hand, '9C'] }, // One lost covering card permits at most one own draw.
  ]) {
    const result = reconcileObservation(before, observe(before, { hand, table: [], stockCount: null, opponentCount: 6, role: null, ...overrides }));
    assert.equal(result.status, 'review', JSON.stringify(overrides));
    assert.equal(result.state, null);
  }
});

test('a missed same-rank trump is ambiguous with transfer and pickup without a stock counter', () => {
  const before = position({ hand: ['6H', '7C', '8C', '9D', 'QH', 'AS'], table: [{ attack: '6S', defense: null }], opponentCount: 4, role: 'defend', trumpCard: 'AH' });
  const next = observe(before, { hand: ['7C', '8C', '9D', 'QH', 'AS', 'JD'], table: [], opponentCount: 6, stockCount: null, role: null });
  assert.equal(reconcileObservation(before, next).status, 'review');
  const covered = accepted(reconcileObservation(before, { ...next, stockCount: before.stockCount - 3 }));
  assert.deepEqual(covered.discard, ['6S', '6H']);
  assert.equal(covered.role, 'attack');
});

test('a vanished opponent defense is never invented when we were the attacker', () => {
  const before = position({ hand: OPEN_HAND.slice(1), table: [{ attack: '6C', defense: null }], opponentCount: 6 });
  const result = reconcileObservation(before, observe(before, { hand: [...before.hand, 'JD'], table: [], opponentCount: 6, stockCount: null, role: null }));
  assert.equal(result.status, 'review');
  assert.equal(result.state, null);
});

test('our played card moves from hand to table without changing stock', () => {
  const before = position();
  const after = accepted(reconcileObservation(before, observe(before, { hand: OPEN_HAND.slice(1), table: [{ attack: '6C', defense: null }] })));
  assert.equal(after.stockCount, before.stockCount);
  assert.deepEqual(after.hand, OPEN_HAND.slice(1));
  assert.deepEqual(after.table, [{ attack: '6C', defense: null }]);
});

test('a hidden stock counter is inferred from confirmed memory for either player move', () => {
  const attack = position();
  const ourMove = reconcileObservation(attack, observe(attack, { stockCount: null, hand: OPEN_HAND.slice(1), table: [{ attack: '6C', defense: null }] }));
  assert.equal(accepted(ourMove).stockCount, attack.stockCount);
  assert.match(ourMove.reasons.join(' '), /Счётчик колоды не виден.*вычислен/);
  const defend = position({ role: 'defend' });
  const opponentMove = reconcileObservation(defend, observe(defend, { stockCount: null, table: [{ attack: '6S', defense: null }], opponentCount: 5 }));
  assert.equal(accepted(opponentMove).stockCount, defend.stockCount);
  assert.equal(reconcileObservation(attack, observe(attack, { stockCount: null })).status, 'unchanged');
});

test('a hidden stock counter accounts for newly covered discard before calculating draws', () => {
  const before = position({ hand: OPEN_HAND.slice(1), table: [{ attack: '6C', defense: 'AC' }], opponentCount: 5, discard: ['KS'] });
  const result = reconcileObservation(before, observe(before, { stockCount: null, hand: [...before.hand, 'JD'], table: [], opponentCount: 6, role: 'defend' }));
  const after = accepted(result);
  assert.deepEqual(after.discard, ['KS', '6C', 'AC']);
  assert.equal(after.stockCount, before.stockCount - 2);
  assert.match(result.reasons.join(' '), /полностью покрытого завершённого захода/);
});

test('a hidden stock counter supports provable pickup by either player without adding discard', () => {
  const ourBefore = position({ role: 'defend', table: [{ attack: '6S', defense: null }], opponentCount: 5 });
  const ours = accepted(reconcileObservation(ourBefore, observe(ourBefore, { stockCount: null, hand: [...ourBefore.hand, '6S'], table: [], opponentCount: 6 })));
  assert.equal(ours.stockCount, ourBefore.stockCount - 1);
  assert.deepEqual(ours.discard, []);
  const opponentBefore = position({ hand: OPEN_HAND.slice(1), table: [{ attack: '6C', defense: null }] });
  const theirs = accepted(reconcileObservation(opponentBefore, observe(opponentBefore, { stockCount: null, hand: [...opponentBefore.hand, 'JD'], table: [], opponentCount: 7 })));
  assert.equal(theirs.stockCount, opponentBefore.stockCount - 1);
  assert.deepEqual(theirs.knownOpponent, ['6C']);
  assert.deepEqual(theirs.discard, []);
});

test('stock inference cannot hide missing moves, partial pickup, or new-game resets', () => {
  const before = position();
  const missingCard = reconcileObservation(before, observe(before, { stockCount: null, hand: OPEN_HAND.slice(1), opponentCount: 7 }));
  assert.equal(missingCard.status, 'review');
  const covered = position({ hand: OPEN_HAND.slice(1), table: [{ attack: '6C', defense: 'AC' }], opponentCount: 5 });
  assert.equal(reconcileObservation(covered, observe(covered, { stockCount: null, table: [{ attack: 'KS', defense: null }], opponentCount: 4, role: 'defend' })).status, 'review');
  assert.equal(reconcileObservation(before, observe(before, { stockCount: null, hand: OPEN_HAND.slice(1) })).status, 'review');
  const uncovered = position({ hand: ['7C', '8C'], role: 'defend', table: [{ attack: '6C', defense: 'AC' }, { attack: '6S', defense: null }], opponentCount: 4 });
  assert.equal(reconcileObservation(uncovered, observe(uncovered, { stockCount: null, hand: [...uncovered.hand, '6C'], table: [] })).status, 'review');
});

test('our covering card moves to the existing pair; attack limit stays fixed', () => {
  const before = position({ role: 'defend', table: [{ attack: '6S', defense: null }], opponentCount: 5 });
  const after = accepted(reconcileObservation(before, observe(before, { hand: OPEN_HAND.filter((card) => card !== 'AS'), table: [{ attack: '6S', defense: 'AS' }] })));
  assert.equal(after.attackLimit, 6);
});

test('known opponent card is removed from that memory only when visibly played', () => {
  const before = position({ knownOpponent: ['AC', 'KS'] });
  const after = accepted(reconcileObservation(before, observe(before, { table: [{ attack: '6C', defense: 'AC' }], hand: OPEN_HAND.slice(1), opponentCount: 5 })));
  assert.deepEqual(after.knownOpponent, ['KS']);
});

test('covered clear table is uniquely accounted for as discard, including refill', () => {
  const before = position({ hand: OPEN_HAND.slice(1), table: [{ attack: '6C', defense: 'AC' }], opponentCount: 5, knownOpponent: ['KS'] });
  const after = accepted(reconcileObservation(before, observe(before, { hand: [...before.hand, 'JD'], table: [], stockCount: before.stockCount - 2, opponentCount: 6, role: 'defend' })));
  assert.deepEqual(after.discard, ['6C', 'AC']);
  assert.deepEqual(after.knownOpponent, ['KS']);
  assert.equal(after.attackLimit, 6);
});

test('uncovered table is remembered in opponent hand only with matching pickup and draws', () => {
  const before = position({ hand: OPEN_HAND.slice(1), table: [{ attack: '6C', defense: null }], knownOpponent: ['KS'] });
  const after = accepted(reconcileObservation(before, observe(before, { hand: [...before.hand, 'JD'], table: [], stockCount: before.stockCount - 1, opponentCount: 7 })));
  assert.deepEqual(after.discard, []);
  assert.deepEqual(after.knownOpponent, ['KS', '6C']);
  const missingCount = reconcileObservation(before, observe(before, { table: [] }));
  assert.equal(missingCount.status, 'review');
});

test('our pickup must show every former table card in our hand', () => {
  const before = position({ role: 'defend', table: [{ attack: '6S', defense: null }], opponentCount: 5 });
  const after = accepted(reconcileObservation(before, observe(before, { hand: [...before.hand, '6S'], table: [] })));
  assert.deepEqual(after.discard, []);
  assert.ok(after.hand.includes('6S'));
  assert.equal(reconcileObservation(before, observe(before, { table: [] })).status, 'review');
});

test('uncertain vanished cards cannot silently return to unknown stock', () => {
  const before = position();
  const result = reconcileObservation(before, observe(before, { hand: OPEN_HAND.slice(1), opponentCount: 7 }));
  assert.equal(result.status, 'review');
  assert.match(result.reasons.join(' '), /исчезли.*не возвращаются/);
  assert.equal(result.state, null);
});

test('skipping a table clear and new attack requires history correction', () => {
  const before = position({ hand: OPEN_HAND.slice(1), table: [{ attack: '6C', defense: 'AC' }], opponentCount: 5 });
  const result = reconcileObservation(before, observe(before, { table: [{ attack: 'KS', defense: null }], opponentCount: 4, role: 'defend' }));
  assert.equal(result.status, 'review');
  assert.match(result.reasons.join(' '), /завершение захода/);
});

test('contradictory totals, duplicate cards, and invalid defense cannot be auto-applied', () => {
  const state = position();
  for (const overrides of [
    { stockCount: 23 },
    { hand: ['6C', '6C', ...OPEN_HAND.slice(2)] },
    { hand: OPEN_HAND.slice(1), table: [{ attack: '6C', defense: '6D' }], opponentCount: 5 },
  ]) assert.equal(reconcileObservation(state, observe(state, overrides)).status, 'review');
});

test('unseen bottom trump remains known while it stays in the stock', () => {
  const before = position();
  const after = reconcileObservation(before, observe(before, { trumpCard: null, trumpSuit: null }));
  assert.equal(after.status, 'unchanged', after.reasons.join(' '));
  assert.equal(after.state.trumpCard, '6H');
  assert.equal(after.state.trumpSuit, 'H');
});

test('bottom trump becomes known opponent card after the last stock draw', () => {
  const discard = makeDeck().filter((card) => !['6C', '7C', '6H', 'AC'].includes(card));
  const before = position({ hand: ['6C'], discard, opponentCount: 1, stockCount: 2, knownOpponent: ['AC'], attackLimit: 1 });
  const after = accepted(reconcileObservation(before, observe(before, { hand: ['6C', '7C'], opponentCount: 2, stockCount: 0, trumpCard: null })));
  assert.equal(after.trumpCard, '6H');
  assert.deepEqual(after.knownOpponent, ['AC', '6H']);
});

test('a new empty-table bout limit grows after the receiver refills, while an active limit is fixed', () => {
  const before = position({ hand: ['6C', '7C', '8C'], opponentCount: 3, attackLimit: 3 });
  const after = accepted(reconcileObservation(before, observe(before, { opponentCount: 6, stockCount: before.stockCount - 3 })));
  assert.equal(after.attackLimit, 6);
});

test('our last-stock trump stays in our hand and is not falsely assigned to opponent', () => {
  const discard = makeDeck().filter((card) => !['6C', '6H', 'AC'].includes(card));
  const before = position({ hand: ['6C'], discard, opponentCount: 1, stockCount: 1, knownOpponent: ['AC'], attackLimit: 1 });
  const after = accepted(reconcileObservation(before, observe(before, { hand: ['6C', '6H'], stockCount: 0, trumpCard: null })));
  assert.deepEqual(after.knownOpponent, ['AC']);
  assert.equal(after.trumpCard, '6H');
});

test('a transferred attack switches role and fixes the new receiver limit', () => {
  const before = position({ hand: ['6C', '7C', '8C'], table: [{ attack: '6S', defense: null }], opponentCount: 2, role: 'defend', attackLimit: 3 });
  const after = accepted(reconcileObservation(before, observe(before, { hand: ['7C', '8C'], table: [{ attack: '6S', defense: null }, { attack: '6C', defense: null }], role: 'attack' })));
  assert.equal(after.attackLimit, 2);
  const disabled = { ...before, allowTransfer: false };
  assert.equal(reconcileObservation(disabled, observe(after)).status, 'review');
});

test('configured attack ceiling applies to new bouts and transfers, while active limits stay frozen', () => {
  const active = position({ role: 'defend', table: [{ attack: '6S', defense: null }], opponentCount: 5 });
  const defended = accepted(reconcileObservation(active, observe(active, { stockCount: null, hand: active.hand.filter((card) => card !== 'AS'), table: [{ attack: '6S', defense: 'AS' }] }), { attackLimit: 4 }));
  assert.equal(defended.attackLimit, 6);
  const nextBout = accepted(reconcileObservation(defended, observe(defended, { stockCount: null, table: [], role: 'attack' }), { attackLimit: 4 }));
  assert.equal(nextBout.attackLimit, 4);
  const transferBefore = position({ hand: ['6C', '7C', '8C'], table: [{ attack: '6S', defense: null }], opponentCount: 6, role: 'defend', attackLimit: 3 });
  const transferred = accepted(reconcileObservation(transferBefore, observe(transferBefore, { stockCount: null, hand: ['7C', '8C'], table: [{ attack: '6S', defense: null }, { attack: '6C', defense: null }], role: 'attack' }), { attackLimit: 4 }));
  assert.equal(transferred.attackLimit, 4);
  for (const attackLimit of [-1, 7, NaN, null]) assert.equal(reconcileObservation(active, observe(active), { attackLimit }).status, 'review');
});

test('opponent transfer switches the receiver to our hand and respects the new limit', () => {
  const before = position({ hand: ['7C', '8C'], table: [{ attack: '6S', defense: null }], opponentCount: 4, role: 'attack', attackLimit: 4 });
  const after = accepted(reconcileObservation(before, observe(before, { table: [{ attack: '6S', defense: null }, { attack: '6D', defense: null }], opponentCount: 3, role: 'defend' })));
  assert.equal(after.attackLimit, 2);
});

test('covered table cannot be treated as transfer, and illegal additions are rejected', () => {
  const before = position({ hand: OPEN_HAND.slice(1), table: [{ attack: '6C', defense: 'AC' }], opponentCount: 5 });
  assert.equal(reconcileObservation(before, observe(before, { hand: before.hand.filter((card) => card !== '7C'), table: [...before.table, { attack: '7C', defense: null }] })).status, 'review');
  assert.equal(reconcileObservation(before, observe(before, { role: 'defend' })).status, 'review');
});

test('discard resurrection and changed trump require explicit new party instead of a reset', () => {
  const before = position({ discard: ['AC'] });
  const resurrected = reconcileObservation(before, observe(before, { hand: [...before.hand, 'AC'], stockCount: before.stockCount - 1 }));
  assert.equal(resurrected.status, 'review');
  assert.match(resurrected.reasons.join(' '), /отбоя снова/);
  for (const overrides of [{ trumpSuit: 'S', trumpCard: '6S' }, { stockCount: before.stockCount + 1 }]) assert.equal(reconcileObservation(before, observe(before, overrides)).status, 'review');
});

test('reconciliation never mutates either input, including rejection and output changes', () => {
  const before = position({ knownOpponent: ['AC'] });
  const observation = observe(before, { hand: OPEN_HAND.slice(1), table: [{ attack: '6C', defense: 'AC' }], opponentCount: 5 });
  const savedBefore = structuredClone(before);
  const savedObservation = structuredClone(observation);
  const after = accepted(reconcileObservation(before, observation));
  after.hand.push('KH'); after.table[0].defense = 'KD'; after.discard.push('AH');
  reconcileObservation(before, { ...observation, confidence: 'low' });
  assert.deepEqual(before, savedBefore);
  assert.deepEqual(observation, savedObservation);
});
