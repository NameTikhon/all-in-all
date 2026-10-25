import test from 'node:test';
import assert from 'node:assert/strict';
import { SUITS, RANKS, makeDeck, cardLabel, beats, validateState, analyze } from '../web/durak.js';

/** Build a fully conserved position, discarding all otherwise unallocated cards. */
function position(overrides = {}) {
  const state = {
    hand: ['6C'], table: [], discard: [], knownOpponent: [],
    trumpSuit: 'S', trumpCard: null, opponentCount: 6, stockCount: 0,
    role: 'attack', attackLimit: 6, allowTransfer: true, ...overrides,
  };
  if (!Object.hasOwn(overrides, 'discard')) {
    const used = new Set([...state.hand, ...state.knownOpponent,
      ...state.table.flatMap((pair) => [pair.attack, pair.defense].filter(Boolean))]);
    if (state.stockCount > 0 && state.trumpCard) used.add(state.trumpCard);
    const hiddenCount = state.opponentCount - state.knownOpponent.length
      + state.stockCount - (state.stockCount > 0 && state.trumpCard ? 1 : 0);
    const candidates = makeDeck().filter((card) => !used.has(card));
    state.discard = candidates.slice(hiddenCount);
  }
  return state;
}

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${message ?? ''}: ${actual} ≠ ${expected}`);
}

test('deck identifiers and beating rules cover all suits, ranks, and trumps', () => {
  assert.equal(makeDeck().length, 36);
  assert.equal(new Set(makeDeck()).size, 36);
  assert.equal(SUITS.length, 4);
  assert.equal(RANKS.length, 9);
  assert.equal(cardLabel('10H'), '10♥');
  assert.equal(beats('7C', '6C', 'S'), true);
  assert.equal(beats('6C', '6C', 'S'), false);
  assert.equal(beats('AC', '6H', 'S'), false);
  assert.equal(beats('6S', 'AC', 'S'), true);
  assert.equal(beats('AC', '6S', 'S'), false);
  assert.equal(beats('AS', 'KS', 'S'), true);
  assert.equal(beats('5S', '6S', 'S'), false);
});

test('validation catches bad IDs, duplicate zones, invalid covers, counts and limits', () => {
  assert.ok(validateState(position()).length === 0);
  assert.match(validateState(position({ hand: ['5C'] })).join(' '), /Некорректная карта/);
  assert.match(validateState(position({ hand: ['6C', '6C'] })).join(' '), /повторяется/);
  assert.match(validateState(position({ hand: ['6C'], knownOpponent: ['6C'] })).join(' '), /повторяется/);
  assert.match(validateState(position({ table: [{ attack: '7H', defense: '6H' }] })).join(' '), /не бьёт/);
  assert.match(validateState({ ...position(), stockCount: 1 }).join(' '), /ровно 36/);
  assert.match(validateState(position({ knownOpponent: ['7C'], opponentCount: 0 })).join(' '), /Известных карт/);
  assert.match(validateState(position({ table: [{ attack: '7H', defense: null }], attackLimit: 0 })).join(' '), /превышает лимит/);
  assert.match(validateState(position({ attackLimit: 7 })).join(' '), /Лимит атаки/);
  assert.match(validateState(position({ opponentCount: 1.5 })).join(' '), /целым числом/);
  assert.match(validateState(null).join(' '), /объектом/);
  assert.equal(analyze({}).valid, false);
  assert.deepEqual(analyze({}).recommendations, []);
});

test('six attack cards are the absolute maximum', () => {
  const table = ['6C', '6D', '6H', '6S', '7C', '7D', '7H'].map((attack) => ({ attack, defense: null }));
  assert.match(validateState(position({ table })).join(' '), /больше 6/);
});

test('the bottom trump stays in stock and is excluded from opponent sampling', () => {
  const state = position({ hand: ['6C'], opponentCount: 1, stockCount: 1, trumpCard: 'AS' });
  const result = analyze(state);
  assert.equal(result.valid, true);
  assert.equal(result.unknownCards.length, 1);
  assert.ok(!result.unknownCards.includes('AS'));
  assert.equal(result.opponentTrumpProbability, 0);
  assert.equal(result.knownCount + result.unseenCount, 36);
  const duplicated = position({ hand: ['AS'], stockCount: 1, trumpCard: 'AS' });
  assert.match(validateState(duplicated).join(' '), /одновременно/);
  assert.match(validateState(position({ stockCount: 1, trumpCard: 'AH' })).join(' '), /не совпадает/);
});

test('after stock empties, the former bottom trump is an ordinary card in any zone or the unknown pool', () => {
  const unknownTrump = {
    hand: ['6C'], table: [], knownOpponent: [], trumpSuit: 'S', trumpCard: 'AS',
    opponentCount: 1, stockCount: 0, role: 'attack', attackLimit: 1,
    discard: makeDeck().filter((card) => !['6C', 'AS'].includes(card)),
  };
  const result = analyze(unknownTrump);
  assert.equal(result.valid, true);
  assert.deepEqual(result.unknownCards, ['AS']);
  assert.equal(result.opponentTrumpProbability, 1);
  assert.equal(result.expectedOpponentTrumps, 1);
  assert.equal(analyze(position({ hand: ['AS'], trumpCard: 'AS' })).valid, true);
  assert.equal(analyze(position({ knownOpponent: ['AS'], trumpCard: 'AS' })).valid, true);
  assert.equal(analyze(position({ trumpCard: 'AS' })).valid, true);
});

test('hypergeometric probabilities use both known and unknown opponent cards exactly', () => {
  const unknown = ['7C', '8C', '6S', '7S'];
  const state = {
    hand: ['6C'], table: [], knownOpponent: [], trumpSuit: 'S', trumpCard: null,
    opponentCount: 2, stockCount: 2, role: 'attack', attackLimit: 2,
    discard: makeDeck().filter((card) => !['6C', ...unknown].includes(card)),
  };
  const result = analyze(state);
  close(result.opponentTrumpProbability, 5 / 6, 'at least one of two trumps in two draws from four');
  close(result.expectedOpponentTrumps, 1, 'expected trump count');
  assert.equal(result.recommendations.find((move) => move.card === '6C').responseProbability, 1);

  const known = { ...state, knownOpponent: ['6S'], opponentCount: 2, stockCount: 2 };
  // Marking a formerly unknown card known does not add another physical card.
  const knownResult = analyze(known);
  assert.equal(knownResult.valid, true);
  assert.equal(knownResult.opponentTrumpProbability, 1);
  close(knownResult.expectedOpponentTrumps, 4 / 3);
  assert.equal(knownResult.recommendations.find((move) => move.card === '6C').responseProbability, 1);
});

test('individual response probability is exact, and a known trump ace needs no unseen cards', () => {
  const unknown = ['7C', '8H', '6S', '7D'];
  const state = {
    hand: ['6C'], table: [], knownOpponent: [], trumpSuit: 'S', trumpCard: null,
    opponentCount: 2, stockCount: 2, role: 'attack', attackLimit: 2,
    discard: makeDeck().filter((card) => !['6C', ...unknown].includes(card)),
  };
  close(analyze(state).recommendations[0].responseProbability, 5 / 6);
  const exact = position({ hand: ['AS'], knownOpponent: ['6H'], opponentCount: 1 });
  assert.equal(analyze(exact).recommendations[0].responseProbability, 0);
  assert.equal(analyze(exact).opponentTrumpProbability, 0);
});

test('no opponent cards gives zero trump probability and no opening attack', () => {
  const result = analyze(position({ opponentCount: 0 }));
  assert.equal(result.valid, true);
  assert.equal(result.opponentTrumpProbability, 0);
  assert.equal(result.expectedOpponentTrumps, 0);
  assert.deepEqual(result.recommendations, []);
});

test('throws match attack or defense ranks, including while another attack is pending', () => {
  const state = position({
    hand: ['7D', '6D', '8D'],
    table: [{ attack: '6C', defense: '7C' }, { attack: '7H', defense: null }],
  });
  const result = analyze(state);
  assert.equal(result.valid, true);
  assert.deepEqual(result.recommendations.filter((move) => move.type === 'attack').map((move) => move.card).sort(), ['6D', '7D']);
  assert.ok(!result.recommendations.some((move) => move.type === 'pass'));
  assert.ok(!analyze({ ...state, attackLimit: 2 }).recommendations.some((move) => move.type === 'attack'));
});

test('pass requires a nonempty fully covered table and respects the frozen bout limit', () => {
  const state = position({
    hand: ['7D'], table: [{ attack: '6C', defense: '7C' }], opponentCount: 1, attackLimit: 2,
  });
  const result = analyze(state);
  assert.ok(result.recommendations.some((move) => move.type === 'attack'));
  assert.ok(result.recommendations.some((move) => move.type === 'pass'));
  assert.ok(!analyze(position()).recommendations.some((move) => move.type === 'pass'));
  assert.ok(!analyze({ ...state, attackLimit: 1 }).recommendations.some((move) => move.type === 'attack'));
});

test('throw-ins cannot exceed the receiver hand even with an oversized manual bout limit', () => {
  const state = position({
    hand: ['6D'], table: [{ attack: '6C', defense: null }], opponentCount: 1, attackLimit: 6,
  });
  const result = analyze(state);
  assert.equal(result.valid, true);
  assert.ok(!result.recommendations.some((move) => move.type === 'attack'));
});

test('full defense allocation never spends the only trump on an attack another card can beat', () => {
  const state = position({
    role: 'defend', hand: ['7C', '6S'], allowTransfer: false,
    table: [{ attack: '6C', defense: null }, { attack: '6H', defense: null }],
  });
  const result = analyze(state);
  assert.equal(result.valid, true);
  const defensive = result.recommendations.filter((move) => move.type === 'defend');
  assert.ok(defensive.some((move) => move.card === '7C' && move.target === 0));
  assert.ok(defensive.some((move) => move.card === '6S' && move.target === 1));
  assert.ok(!defensive.some((move) => move.card === '6S' && move.target === 0));
  assert.deepEqual(result.defensePlan, [{ card: '7C', target: 0 }, { card: '6S', target: 1 }]);
});

test('a large hand is allocated without duplicate cards, and impossible defense recommends take', () => {
  const table = [
    { attack: '6C', defense: '7C' }, { attack: '7D', defense: '8D' },
    ...['8C', '8H', '8S', '7H'].map((attack) => ({ attack, defense: null })),
  ];
  const state = position({ role: 'defend', table, hand: ['9C', '9H', '9S', '10S', 'JS', 'QS', 'KS', 'AS'], opponentCount: 6 });
  const result = analyze(state);
  assert.equal(result.valid, true);
  assert.equal(result.defensePlan.length, 4);
  assert.equal(new Set(result.defensePlan.map((move) => move.card)).size, 4);
  const impossible = analyze(position({ role: 'defend', hand: ['6C'], table: [{ attack: 'AS', defense: null }] }));
  assert.ok(impossible.recommendations.some((move) => move.type === 'take'));
  assert.ok(!impossible.recommendations.some((move) => move.type === 'defend'));
});

test('transfer requires a common rank, no previous defense, and capacity in the receiving hand', () => {
  const base = position({
    role: 'defend', hand: ['6H', '7D'], opponentCount: 2,
    table: [{ attack: '6C', defense: null }],
  });
  const transfers = (state) => analyze(state).recommendations.filter((move) => move.type === 'transfer');
  assert.deepEqual(transfers(base).map((move) => move.card), ['6H']);
  const insufficientReceiver = position({ role: 'defend', hand: ['6H', '7D'], opponentCount: 1,
    table: [{ attack: '6C', defense: null }] });
  assert.equal(analyze(insufficientReceiver).valid, true);
  assert.equal(transfers(insufficientReceiver).length, 0);
  assert.equal(transfers({ ...base, allowTransfer: false }).length, 0);
  assert.equal(transfers(position({ role: 'defend', hand: ['6H'], table: [{ attack: '6C', defense: '7C' }, { attack: '6D', defense: null }] })).length, 0);
  assert.equal(transfers(position({ role: 'defend', hand: ['6H'], table: [{ attack: '6C', defense: null }, { attack: '7C', defense: null }] })).length, 0);
  const defaultVariant = { ...base };
  delete defaultVariant.allowTransfer;
  assert.equal(transfers(defaultVariant).length, 1);
});

test('repeated transfers are permitted and use the new receiver capacity, not the old bout limit', () => {
  const state = position({
    role: 'defend', hand: ['6S'], opponentCount: 3, attackLimit: 2,
    table: [{ attack: '6C', defense: null }, { attack: '6D', defense: null }],
  });
  assert.equal(analyze(state).valid, true);
  assert.ok(analyze(state).recommendations.some((move) => move.type === 'transfer' && move.card === '6S'));
});

test('empty and last-card positions are handled without inventing a move', () => {
  const empty = analyze(position({ hand: [], opponentCount: 0 }));
  assert.equal(empty.valid, true);
  assert.deepEqual(empty.recommendations, []);
  const lastCover = analyze(position({
    hand: [], role: 'attack', opponentCount: 0,
    table: [{ attack: '6C', defense: '7C' }], attackLimit: 1,
  }));
  assert.deepEqual(lastCover.recommendations.map((move) => move.type), ['pass']);
  const lastDefense = analyze(position({ hand: ['7C'], role: 'defend', opponentCount: 0,
    table: [{ attack: '6C', defense: null }], attackLimit: 1 }));
  assert.ok(lastDefense.recommendations.some((move) => move.type === 'defend'));
});

test('empty-stock final-card transfer, cover, and attack take priority over preserving card strength', () => {
  const transfer = analyze(position({
    hand: ['6D'], table: [{ attack: '6C', defense: null }], knownOpponent: ['6H', 'AS'],
    opponentCount: 2, stockCount: 0, role: 'defend', attackLimit: 1,
  }));
  assert.equal(transfer.valid, true);
  assert.equal(transfer.recommendations[0].type, 'transfer');
  assert.equal(transfer.recommendations[0].card, '6D');
  assert.equal(transfer.recommendations[0].score, 100);

  const cover = analyze(position({
    hand: ['AS'], table: [{ attack: 'KS', defense: null }], knownOpponent: ['6H'],
    opponentCount: 1, stockCount: 0, role: 'defend', attackLimit: 1,
  }));
  assert.equal(cover.valid, true);
  assert.equal(cover.recommendations[0].type, 'defend');
  assert.equal(cover.recommendations[0].card, 'AS');
  assert.equal(cover.recommendations[0].score, 100);

  const attack = analyze(position({
    hand: ['KS'], table: [{ attack: 'KC', defense: 'AC' }], knownOpponent: ['AS'],
    opponentCount: 1, stockCount: 0, role: 'attack', attackLimit: 2,
  }));
  assert.equal(attack.valid, true);
  assert.equal(attack.recommendations[0].type, 'attack');
  assert.equal(attack.recommendations[0].card, 'KS');
  assert.equal(attack.recommendations[0].score, 100);
});

test('analysis never mutates a supplied position, even when allocating many defenses', () => {
  const state = position({ role: 'defend', hand: ['8C', '7C', '6S'],
    table: [{ attack: '6C', defense: null }, { attack: '6H', defense: null }] });
  const snapshot = structuredClone(state);
  Object.freeze(state.hand);
  state.table.forEach(Object.freeze);
  Object.freeze(state.table);
  Object.freeze(state);
  assert.equal(analyze(state).valid, true);
  assert.deepEqual(state, snapshot);
});
