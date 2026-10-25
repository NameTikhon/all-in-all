import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck, validateState } from '../web/durak.js';
import { remainingStock, cardLocation, updateSelection, playFromHand } from '../web/editor-model.js';

function draft(overrides = {}) {
  const state = {
    hand: [], table: [], discard: [], knownOpponent: [],
    trumpSuit: 'H', trumpCard: null, opponentCount: 6,
    stockCount: 30, role: 'attack', attackLimit: 6, allowTransfer: true,
    ...overrides,
  };
  state.stockCount = remainingStock(state);
  return state;
}

test('clicking six opening cards calculates stock as 24, including the bottom trump', () => {
  let state = draft({ trumpCard: 'JH' });
  for (const card of ['JC', 'JD', 'QC', 'KS', '6H', '8H']) {
    state = updateSelection(state, { zone: 'hand', card });
  }
  assert.equal(state.stockCount, 24);
  assert.deepEqual(validateState(state), []);
});

test('selection toggles without mutating input and known opponent cards do not use extra stock', () => {
  const state = draft({ hand: ['6C'] });
  const before = structuredClone(state);
  const removed = updateSelection(state, { zone: 'hand', card: '6C' });
  assert.deepEqual(state, before);
  assert.deepEqual(removed.hand, []);
  assert.equal(removed.stockCount, 30);
  const known = updateSelection(state, { zone: 'knownOpponent', card: '7C' });
  assert.equal(known.stockCount, state.stockCount);
  assert.equal(known.opponentCount, 6);
  assert.deepEqual(updateSelection(known, { zone: 'knownOpponent', card: '7C' }).knownOpponent, []);
  const discarded = updateSelection(state, { zone: 'discard', card: '8C' });
  assert.equal(discarded.stockCount, state.stockCount - 1);
  assert.deepEqual(updateSelection(discarded, { zone: 'discard', card: '8C' }).discard, []);
});

test('cards cannot silently move between zones, including the reserved bottom trump', () => {
  const state = draft({ hand: ['6C'], trumpCard: 'AH' });
  assert.throws(() => updateSelection(state, { zone: 'discard', card: '6C' }), /уже находится.*Ваша рука/);
  assert.throws(() => updateSelection(state, { zone: 'attack', card: '6C' }), /Сначала уберите/);
  assert.throws(() => updateSelection(state, { zone: 'hand', card: 'AH' }), /Открытый козырь/);
  assert.throws(() => updateSelection(state, { zone: 'trump', card: '6C' }), /Ваша рука/);
  assert.deepEqual(cardLocation(state, 'AH'), { zone: 'trump', index: null, label: 'Открытый козырь' });
});

test('trump replacement changes suit, frees old card, and same selection clears it', () => {
  const state = draft({ trumpCard: 'AH' });
  const next = updateSelection(state, { zone: 'trump', card: 'KS' });
  assert.equal(next.trumpCard, 'KS');
  assert.equal(next.trumpSuit, 'S');
  assert.equal(cardLocation(next, 'AH'), null);
  assert.equal(updateSelection(next, { zone: 'trump', card: 'KS' }).trumpCard, null);
});

test('exhausted bottom trump remains metadata and normal card location wins', () => {
  const state = draft({ hand: ['AH'], trumpCard: 'AH', opponentCount: 35 });
  assert.equal(state.stockCount, 0);
  assert.equal(cardLocation(state, 'AH').zone, 'hand');
  const movedOut = updateSelection(state, { zone: 'hand', card: 'AH' });
  assert.equal(movedOut.trumpCard, 'AH');
  assert.equal(movedOut.stockCount, 1);
  assert.equal(cardLocation(movedOut, 'AH').zone, 'trump');
  const unknown = draft({ trumpCard: 'AH', opponentCount: 36 });
  assert.equal(cardLocation(unknown, 'AH'), null);
});

test('drawing the final bottom trump releases its reservation only when stock reaches zero', () => {
  const lastCard = draft({ opponentCount: 35, trumpCard: '6H' });
  const drawn = updateSelection(lastCard, { zone: 'hand', card: '6H' });
  assert.equal(drawn.stockCount, 0);
  assert.deepEqual(drawn.hand, ['6H']);
  assert.equal(drawn.trumpCard, '6H');
  assert.equal(cardLocation(drawn, '6H').zone, 'hand');
  assert.deepEqual(validateState(drawn), []);
  assert.equal(lastCard.stockCount, 1);
  assert.deepEqual(lastCard.hand, []);
  assert.throws(() => updateSelection(draft({ opponentCount: 34, trumpCard: '6H' }),
    { zone: 'hand', card: '6H' }), /Открытый козырь/);
});

test('invalid cover and attack replacement fail safely; valid replacements free old cards', () => {
  const state = draft({ table: [{ attack: '8C', defense: '9C' }] });
  const before = structuredClone(state);
  assert.throws(() => updateSelection(state, { zone: 'defense', index: 0, card: '7C' }), /не бьёт/);
  assert.throws(() => updateSelection(state, { zone: 'attack', index: 0, card: '10C' }), /не бьёт/);
  assert.deepEqual(state, before);
  const replaced = updateSelection(state, { zone: 'defense', index: 0, card: 'AC' });
  assert.equal(replaced.table[0].defense, 'AC');
  assert.equal(cardLocation(replaced, '9C'), null);
  assert.equal(replaced.stockCount, state.stockCount);
  const uncovered = updateSelection(replaced, { zone: 'defense', index: 0, card: 'AC' });
  assert.equal(uncovered.table[0].defense, null);
  assert.equal(uncovered.stockCount, state.stockCount + 1);
});

test('adding table cards requires a valid pair for defense and never exceeds six attacks', () => {
  assert.throws(() => updateSelection(draft(), { zone: 'defense', index: 0, card: 'AC' }), /выберите атаку/);
  let state = draft();
  for (const card of ['6C', '6D', '6H', '6S', '7C', '7D']) state = updateSelection(state, { zone: 'attack', card });
  assert.equal(state.table.length, 6);
  assert.throws(() => updateSelection(state, { zone: 'attack', card: '7H' }), /шесть атак/);
  const replacement = updateSelection(state, { zone: 'attack', index: 2, card: '7H' });
  assert.equal(replacement.table[2].attack, '7H');
  assert.equal(cardLocation(replacement, '6H'), null);
});

test('negative stock, overfull known hand and invalid cards produce actionable errors', () => {
  const state = draft({ opponentCount: 36 });
  assert.throws(() => updateSelection(state, { zone: 'hand', card: '6C' }), /больше 36/);
  assert.equal(state.hand.length, 0);
  assert.throws(() => updateSelection(draft({ opponentCount: 0 }), { zone: 'knownOpponent', card: '6C' }), /Увеличьте количество/);
  assert.throws(() => updateSelection(draft(), { zone: 'hand', card: '5C' }), /36 карт/);
});

test('explicit attack and cover move cards out of hand and conserve stock', () => {
  const initial = draft({ hand: ['6C', '9C'] });
  const attacking = playFromHand(initial, '6C', { type: 'attack' });
  assert.deepEqual(attacking.hand, ['9C']);
  assert.deepEqual(attacking.table, [{ attack: '6C', defense: null }]);
  assert.equal(attacking.stockCount, initial.stockCount);
  assert.deepEqual(initial.hand, ['6C', '9C']);
  const defending = { ...attacking, role: 'defend' };
  const covered = playFromHand(defending, '9C', { type: 'defend', target: 0 });
  assert.deepEqual(covered.hand, []);
  assert.equal(covered.table[0].defense, '9C');
  assert.equal(covered.stockCount, initial.stockCount);
  assert.deepEqual(validateState(covered), []);
});

test('transfer moves from hand, switches role and resets the limit to receiving hand capacity', () => {
  const state = draft({ hand: ['8D', 'AS'], table: [{ attack: '8C', defense: null }], role: 'defend', opponentCount: 3 });
  const next = playFromHand(state, '8D', { type: 'transfer' });
  assert.deepEqual(next.hand, ['AS']);
  assert.equal(next.table.length, 2);
  assert.equal(next.role, 'attack');
  assert.equal(next.attackLimit, 3);
  assert.equal(next.stockCount, state.stockCount);
  assert.deepEqual(validateState(next), []);
  assert.equal(state.table.length, 1);
  assert.equal(state.role, 'defend');
});

test('explicit plays enforce transfer rules, table ranks, role and defense legality', () => {
  const transfer = draft({ hand: ['8D', '9C'], table: [{ attack: '8C', defense: null }], role: 'defend' });
  assert.throws(() => playFromHand({ ...transfer, allowTransfer: false }, '8D', { type: 'transfer' }), /отключены/);
  assert.throws(() => playFromHand({ ...transfer, opponentCount: 1 }, '8D', { type: 'transfer' }), /недостаточно карт/);
  assert.throws(() => playFromHand(transfer, '9C', { type: 'transfer' }), /того же достоинства/);
  assert.throws(() => playFromHand(transfer, '8D', { type: 'attack' }), /защищаетесь/);
  assert.throws(() => playFromHand(transfer, '8D', { type: 'defend', target: 0 }), /не бьёт/);
  assert.throws(() => playFromHand({ ...transfer, role: 'attack' }, '9C', { type: 'attack' }), /достоинства/);
  assert.throws(() => playFromHand({ ...transfer, role: 'attack', attackLimit: 1 }, '8D', { type: 'attack' }), /лимит атаки/);
  assert.throws(() => playFromHand({ ...transfer, table: [{ attack: '8C', defense: '10C' }] }, '8D', { type: 'transfer' }), /пока ни одна атака/);
});

test('selection catches preexisting duplicate cards instead of committing an invalid draft', () => {
  const state = draft({ hand: ['6C', '6C'] });
  assert.throws(() => updateSelection(state, { zone: 'hand', card: '7C' }), /дважды/);
  const fixed = updateSelection(state, { zone: 'hand', card: '6C' });
  assert.deepEqual(fixed.hand, ['6C']);
});

test('all 36 card identifiers can be picked without text entry', () => {
  let state = draft({ opponentCount: 0 });
  for (const card of makeDeck()) state = updateSelection(state, { zone: 'discard', card });
  assert.equal(state.discard.length, 36);
  assert.equal(state.stockCount, 0);
  assert.deepEqual(validateState(state), []);
});
