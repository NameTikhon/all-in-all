import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoRecovery } from '../web/auto-recovery.js';

const incomplete = { status: 'review', state: null, reasons: ['Не видно карты.'], events: [] };
const confirmation = { ...incomplete, retryRequired: true };

test('incomplete stable frames receive exactly two automatic rereads by default', () => {
  const recovery = createAutoRecovery();
  const first = recovery.observe(incomplete, { positionKey: 1 });
  assert.equal(first.action, 'retry');
  assert.equal(first.retriesUsed, 1);
  assert.equal(first.retriesRemaining, 1);
  assert.equal(recovery.observe(incomplete, { positionKey: 1 }).action, 'retry');
  const final = recovery.observe(incomplete, { positionKey: 1 });
  assert.equal(final.action, 'wait');
  assert.equal(final.retriesUsed, 2);
  assert.equal(final.retriesRemaining, 0);
  assert.doesNotMatch(final.message, /вручную|пауз/);
  for (let index = 0; index < 100; index += 1) {
    assert.equal(recovery.observe(incomplete, { positionKey: 1 }).retry, false);
  }
});

test('changing model answers cannot replenish the stable frame retry allowance', () => {
  const recovery = createAutoRecovery();
  assert.equal(recovery.observe(confirmation, { positionKey: 'same' }).retry, true);
  assert.equal(recovery.observe({ ...incomplete, reasons: ['Другая причина.'] }, { positionKey: 'same' }).retry, true);
  assert.equal(recovery.observe(null, { positionKey: 'same' }).retry, false);
  assert.equal(recovery.observe(confirmation, { positionKey: 'new' }).retry, true);
  assert.equal(recovery.observe(confirmation, { positionKey: 'same' }).retry, false);
});

test('a successfully resolved frame never reopens paid retries', () => {
  for (const status of ['accepted', 'unchanged']) {
    const recovery = createAutoRecovery();
    recovery.observe(incomplete, { positionKey: 4 });
    const result = { status, state: { hand: ['6C'] }, reasons: ['Проверено.'] };
    const before = structuredClone(result);
    const accepted = recovery.observe(result, { positionKey: 4 });
    assert.equal(accepted.action, 'accept');
    assert.equal(accepted.retriesUsed, 1);
    accepted.reasons.push('UI annotation');
    assert.deepEqual(result, before);
    assert.equal(recovery.observe(incomplete, { positionKey: 4 }).retry, false);
  }
});

test('configuration can disable ordinary rereads while preserving one explicit new-game confirmation', () => {
  const recovery = createAutoRecovery({ maxRetriesPerPosition: 0 });
  assert.equal(recovery.observe(incomplete, { positionKey: 1 }).action, 'wait');
  assert.equal(recovery.observe(confirmation, { positionKey: 2 }).retry, true);
  assert.equal(recovery.observe(confirmation, { positionKey: 2 }).retry, false);
  for (const value of [-1, 3, 1.5, NaN]) {
    assert.throws(() => createAutoRecovery({ maxRetriesPerPosition: value }), RangeError);
    assert.throws(() => createAutoRecovery({ maxRequiredConfirmationRetries: value }), RangeError);
  }
});

test('reset is explicit and restores the allowance', () => {
  const recovery = createAutoRecovery();
  for (let count = 0; count < 3; count++) recovery.observe(incomplete, { positionKey: 'frame' });
  assert.equal(recovery.observe(incomplete, { positionKey: 'frame' }).retry, false);
  recovery.reset();
  assert.equal(recovery.observe(incomplete, { positionKey: 'frame' }).retry, true);
});

test('bounded ledger retains recently observed positions without retaining images or state', () => {
  const recovery = createAutoRecovery({ maxRememberedPositions: 2 });
  for (const positionKey of [1, 1, 2, 1, 3]) recovery.observe(incomplete, { positionKey });
  assert.equal(recovery.observe(incomplete, { positionKey: 1 }).retry, false);
  assert.equal(recovery.observe(incomplete, { positionKey: 2 }).retry, true);
  for (const maxRememberedPositions of [0, 513, 1.1, NaN]) {
    assert.throws(() => createAutoRecovery({ maxRememberedPositions }), RangeError);
  }
});

test('frame identity and malformed reasons are validated without retaining raw data', () => {
  const recovery = createAutoRecovery();
  for (const positionKey of [undefined, null, '', {}, [], NaN, -1, Infinity, 'x'.repeat(257)]) {
    assert.throws(() => recovery.observe(incomplete, { positionKey }), TypeError);
  }
  assert.deepEqual(recovery.observe({ status: 'review', reasons: [null, 'Причина.', {}] }, { positionKey: 0 }).reasons, ['Причина.']);
  assert.deepEqual(recovery.observe({}, { positionKey: 0 }).reasons, []);
});
