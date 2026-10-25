import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoSession } from '../web/auto-session.js';
import { makeDeck, validateState } from '../web/durak.js';

const OLD = {
  hand: ['JC', 'JD', 'QC', 'KS', '6H', '8H'], table: [], discard: [], knownOpponent: [],
  trumpSuit: 'H', trumpCard: 'JH', opponentCount: 6, stockCount: 24,
  role: 'attack', attackLimit: 6, allowTransfer: true,
};
const FIRST_ATTACK = {
  hand: ['7S', 'KS', 'KD', 'AD', '10C', 'JC'], table: [{ attack: '6H', defense: null }],
  trumpSuit: 'C', trumpCard: 'AC', opponentCount: 5, stockCount: null,
  role: 'defend', confidence: 'high', notes: [],
};
const read = (session, previous = OLD, observation = FIRST_ATTACK, options = {}) => session.reconcile(previous, observation, { positionKey: 'stable-frame-a', ...options });

test('two readings of the first attack replace an old saved game only after confirmation', () => {
  const session = createAutoSession();
  const saved = structuredClone(OLD);
  const first = read(session);
  assert.equal(first.status, 'review');
  assert.equal(first.newSession, false);
  assert.equal(first.retryRequired, true);
  assert.equal(first.state, null);
  assert.match(first.reasons.join(' '), /Проверяем начало новой партии/);
  const second = read(session);
  assert.equal(second.status, 'accepted', second.reasons.join('\n'));
  assert.equal(second.newSession, true);
  assert.equal(second.retryRequired, false);
  assert.equal(second.state.stockCount, 24);
  assert.deepEqual(validateState(second.state), []);
  assert.deepEqual(OLD, saved, 'caller retains the old game for archival');
});

test('new-session confirmation ignores descriptive prose, hand order, table order and inferred stock', () => {
  const session = createAutoSession();
  read(session);
  const repeated = { ...FIRST_ATTACK, hand: [...FIRST_ATTACK.hand].reverse(), stockCount: 24, notes: ['Different wording.'] };
  assert.equal(read(session, OLD, repeated).newSession, true);
});

test('a different frame, candidate, or saved baseline starts confirmation over', () => {
  const session = createAutoSession();
  read(session);
  assert.equal(read(session, OLD, FIRST_ATTACK, { positionKey: 'stable-frame-b' }).newSession, false);
  const changedHand = { ...FIRST_ATTACK, hand: ['7S', 'KS', 'KD', 'AD', '10C', 'QC'] };
  assert.equal(read(session, OLD, changedHand, { positionKey: 'stable-frame-b' }).newSession, false);
  const otherOld = { ...OLD, hand: ['JC', 'JD', 'QC', 'QS', '6H', '8H'] };
  assert.equal(read(session, otherOld, changedHand, { positionKey: 'stable-frame-b' }).newSession, false);
  assert.equal(read(session, otherOld, changedHand, { positionKey: 'stable-frame-b' }).newSession, true);
});

test('normal accepted and unchanged observations do not start a new session', () => {
  const session = createAutoSession();
  const opening = session.reconcile(null, FIRST_ATTACK, { initial: true });
  assert.equal(opening.status, 'accepted');
  assert.equal(opening.newSession, false);
  const same = { ...FIRST_ATTACK, stockCount: 24 };
  assert.equal(read(session, opening.state, same).status, 'unchanged');
  assert.equal(read(session, opening.state, same).newSession, false);
});

test('same-trump hand changes do not erase ongoing history even when they resemble a deal', () => {
  const session = createAutoSession();
  const sameTrump = { ...FIRST_ATTACK, trumpSuit: 'H', trumpCard: 'JH' };
  for (let index = 0; index < 3; index++) {
    const result = read(session, OLD, sameTrump);
    assert.equal(result.status, 'review');
    assert.equal(result.newSession, false);
    assert.equal(result.retryRequired, false);
  }
});

test('a finished empty-stock game can confirm a new deal with the same trump', () => {
  const oldCards = ['6C', '7C', 'JH'];
  const ended = { ...OLD, hand: ['6C'], opponentCount: 2, stockCount: 0, knownOpponent: ['JH'],
    discard: makeDeck().filter((card) => !oldCards.includes(card)), attackLimit: 2 };
  assert.deepEqual(validateState(ended), []);
  const sameTrump = { ...FIRST_ATTACK, trumpSuit: 'H', trumpCard: 'JH' };
  const session = createAutoSession();
  assert.equal(read(session, ended, sameTrump).retryRequired, true);
  assert.equal(read(session, ended, sameTrump).newSession, true);
});

test('missing stable frame keys, uncertain vision and late-game counts cannot confirm new games', () => {
  for (const [observation, options] of [
    [FIRST_ATTACK, { positionKey: null }],
    [FIRST_ATTACK, { positionKey: '' }],
    [{ ...FIRST_ATTACK, confidence: 'medium' }, {}],
    [{ ...FIRST_ATTACK, stockCount: 23 }, {}],
    [{ ...FIRST_ATTACK, hand: FIRST_ATTACK.hand.slice(1), opponentCount: 4, stockCount: 26 }, {}],
    [{ ...FIRST_ATTACK, role: 'attack' }, {}],
  ]) {
    const session = createAutoSession();
    for (let index = 0; index < 3; index++) {
      const result = read(session, OLD, observation, options);
      assert.equal(result.status, 'review');
      assert.equal(result.newSession, false);
      assert.equal(result.retryRequired, false);
    }
  }
});

test('reset and unrelated uncertain observations invalidate pending confirmation', () => {
  const session = createAutoSession();
  read(session);
  session.reset();
  assert.equal(read(session).retryRequired, true);
  read(session, OLD, { ...FIRST_ATTACK, confidence: 'low' });
  assert.equal(read(session).newSession, false);
  assert.equal(read(session).newSession, true);
});

test('confirmation count is configurable but cannot bypass repeated reads', () => {
  const session = createAutoSession({ confirmations: 3 });
  assert.equal(read(session).newSession, false);
  assert.equal(read(session).newSession, false);
  assert.equal(read(session).newSession, true);
  for (const confirmations of [0, 1, 1.5, NaN]) assert.throws(() => createAutoSession({ confirmations }), TypeError);
});
