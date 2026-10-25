import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoMonitor, signaturesChanged } from '../web/auto-loop.js';
import { createAutoRecovery } from '../web/auto-recovery.js';

const settle = async () => { for (let count = 0; count < 30; count += 1) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fakeClock() {
  let time = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (callback, delay) => {
      const id = ++sequence;
      timers.set(id, { callback, at: time + delay });
      return id;
    },
    clearTimer: id => timers.delete(id),
    async tick(duration) {
      const target = time + duration;
      for (let turns = 0; turns < 10000; turns += 1) {
        await settle();
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!next) {
          time = target;
          await settle();
          if ([...timers.values()].some(timer => timer.at <= target)) continue;
          return;
        }
        time = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      throw new Error('Fake timer did not settle.');
    },
    pending: () => timers.size,
  };
}

function harness(options = {}) {
  const clock = fakeClock();
  const results = [];
  const calls = [];
  const statuses = [];
  const errors = [];
  let pixels = 0;
  let captures = 0;
  const monitor = createAutoMonitor({
    intervalMs: 100,
    maxObservationRetries: 1,
    capture: async () => {
      captures += 1;
      return { image: `frame-${pixels}`, signature: new Uint8Array(16).fill(pixels) };
    },
    recognize: async (image, { signal }) => {
      calls.push({ image, signal, at: clock.now() });
      return { hand: [image] };
    },
    onResult: async result => { results.push(result); },
    onStatus: status => statuses.push(status),
    onError: (error, details) => errors.push({ error, ...details }),
    ...options,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return {
    monitor, clock, results, calls, statuses, errors,
    change: value => { pixels = value; },
    captures: () => captures,
  };
}

test('first stable frame is recognized, while an unchanged window incurs no further calls', async () => {
  const task = harness();
  task.monitor.start();
  await task.clock.tick(0);
  assert.equal(task.calls.length, 0);
  assert.equal(task.monitor.getState().phase, 'stabilizing');
  await task.clock.tick(99);
  assert.equal(task.calls.length, 0);
  await task.clock.tick(1);
  assert.equal(task.calls.length, 1);
  assert.equal(task.results.length, 1);
  await task.clock.tick(20000);
  assert.equal(task.calls.length, 1);
  assert.equal(task.monitor.getState().phase, 'unchanged');
  assert.ok(task.statuses.every(status => !('image' in status) && !('signature' in status)));
  task.monitor.stop();
});

test('moving cards wait for stability and a new stable position is processed once', async () => {
  const task = harness({ minRequestIntervalMs: 0 });
  task.monitor.start();
  await task.clock.tick(100);
  task.change(50);
  await task.clock.tick(100);
  task.change(150);
  await task.clock.tick(100);
  assert.equal(task.calls.length, 1);
  await task.clock.tick(100);
  assert.equal(task.calls.length, 2);
  assert.equal(task.calls[1].image, 'frame-150');
  await task.clock.tick(2000);
  assert.equal(task.calls.length, 2);
  task.monitor.stop();
});

test('small pixel noise stays under the change threshold', async () => {
  const task = harness({ minRequestIntervalMs: 0 });
  task.monitor.start();
  await task.clock.tick(100);
  task.change(4);
  await task.clock.tick(1000);
  assert.equal(task.calls.length, 1);
  task.change(10);
  await task.clock.tick(200);
  assert.equal(task.calls.length, 2);
  task.monitor.stop();
});

test('a localized card change in a 64 × 36 frame is recognized despite a tiny global mean', async () => {
  const opening = new Uint8Array(64 * 36).fill(40);
  const nextCard = new Uint8Array(opening);
  // A small card corner crosses both the 8-pixel and 6-pixel tile boundaries.
  for (let row = 5; row < 8; row += 1) {
    for (let column = 7; column < 9; column += 1) nextCard[row * 64 + column] = 200;
  }
  const mean = nextCard.reduce((sum, pixel, index) => sum + Math.abs(pixel - opening[index]), 0) / (opening.length * 255);
  assert.ok(mean < 0.002, 'the card corner is too small for the global threshold');
  assert.equal(signaturesChanged(opening, nextCard), true);
  let current = opening;
  const task = harness({
    minRequestIntervalMs: 0,
    capture: async () => ({ image: current === opening ? 'opening' : 'next-card', signature: current }),
  });
  task.monitor.start();
  await task.clock.tick(100);
  current = nextCard;
  await task.clock.tick(200);
  assert.deepEqual(task.calls.map(call => call.image), ['opening', 'next-card']);
  await task.clock.tick(1000);
  assert.equal(task.calls.length, 2);
  task.monitor.stop();
});

test('localized detection ignores isolated pixel noise but detects a low-contrast card corner', () => {
  const original = new Uint8Array(64 * 36).fill(40);
  const cursorNoise = new Uint8Array(original);
  cursorNoise[6 * 64 + 8] = 255;
  assert.equal(signaturesChanged(original, cursorNoise), false);
  const movedNoise = new Uint8Array(original);
  movedNoise[6 * 64 + 9] = 255;
  assert.equal(signaturesChanged(cursorNoise, movedNoise), false);
  const cardCorner = new Uint8Array(original);
  for (let row = 5; row < 11; row += 1) {
    for (let column = 7; column < 9; column += 1) cardCorner[row * 64 + column] = 100;
  }
  assert.equal(signaturesChanged(original, cardCorner), true);
});

test('paid request starts are separated by at least five seconds', async () => {
  const task = harness();
  task.monitor.start();
  await task.clock.tick(100);
  task.change(100);
  await task.clock.tick(4999);
  assert.equal(task.calls.length, 1);
  await task.clock.tick(1);
  assert.equal(task.calls.length, 2);
  assert.equal(task.calls[1].at - task.calls[0].at, 5000);
  task.monitor.stop();
});

test('capture, recognition and asynchronous result handling never overlap', async () => {
  const recognition = deferred();
  const application = deferred();
  let recognizeCalls = 0;
  let applyCalls = 0;
  const task = harness({
    minRequestIntervalMs: 0,
    recognize: async () => { recognizeCalls += 1; return recognition.promise; },
    onResult: async () => { applyCalls += 1; return application.promise; },
  });
  task.monitor.start();
  task.monitor.start();
  await task.clock.tick(100);
  await task.clock.tick(10000);
  assert.equal(recognizeCalls, 1);
  assert.equal(task.captures(), 2);
  assert.equal(applyCalls, 0);
  recognition.resolve({ hand: [] });
  await settle();
  assert.equal(task.captures(), 3);
  assert.equal(applyCalls, 1);
  task.change(100);
  await task.clock.tick(10000);
  assert.equal(recognizeCalls, 1);
  assert.equal(task.captures(), 3);
  application.resolve();
  await settle();
  await task.clock.tick(200);
  assert.equal(recognizeCalls, 2);
  task.monitor.stop();
});

test('stop aborts the request, clears timers and ignores a late response', async () => {
  const response = deferred();
  let signal;
  const task = harness({ recognize: async (image, options) => {
    signal = options.signal;
    return response.promise;
  } });
  task.monitor.start();
  await task.clock.tick(100);
  task.monitor.stop();
  assert.equal(signal.aborted, true);
  assert.equal(task.clock.pending(), 0);
  response.resolve({ hand: ['6C'] });
  await settle();
  await task.clock.tick(10000);
  assert.deepEqual(task.results, []);
  assert.equal(task.captures(), 2);
  assert.equal(task.monitor.getState().running, false);
  assert.equal(task.monitor.getState().phase, 'idle');
});

test('restart rechecks the scene before applying a late cached result without buying it again', async () => {
  const oldResponse = deferred();
  let requests = 0;
  const task = harness({ minRequestIntervalMs: 0, recognize: async () => {
    requests += 1;
    if (requests === 1) return oldResponse.promise;
    return { hand: ['AS'] };
  } });
  task.monitor.start();
  await task.clock.tick(100);
  task.monitor.stop();
  task.monitor.start();
  await task.clock.tick(10000);
  assert.equal(requests, 1);
  oldResponse.resolve({ hand: ['6C'] });
  await settle();
  await task.clock.tick(100);
  assert.equal(requests, 1);
  assert.deepEqual(task.results, [{ hand: ['6C'] }]);
  assert.equal(task.monitor.getState().requests, 0);
  task.change(100);
  await task.clock.tick(200);
  assert.equal(requests, 2);
  assert.deepEqual(task.results, [{ hand: ['6C'] }, { hand: ['AS'] }]);
  assert.equal(task.monitor.getState().requests, 1);
  task.monitor.stop();
});

test('repeatedly pausing aborted reads keeps the same key and can never exceed ordinals 0, 1 and 2', async () => {
  const attempts = [];
  const task = harness({ minRequestIntervalMs: 0, maxObservationRetries: undefined,
    recognize: (image, context) => {
      attempts.push({ key: context.positionKey, ordinal: context.retryAttempt });
      return new Promise((resolve, reject) => context.signal.addEventListener('abort', () => {
        reject(new DOMException('Cancelled', 'AbortError'));
      }, { once: true }));
    } });
  task.monitor.start();
  await task.clock.tick(100);
  assert.equal(attempts.length, 1);
  for (let pause = 0; pause < 3; pause++) {
    task.monitor.stop();
    task.monitor.start();
    await task.clock.tick(1000);
  }
  assert.deepEqual(attempts.map(entry => entry.ordinal), [0, 1, 2]);
  assert.equal(new Set(attempts.map(entry => entry.key)).size, 1);
  await task.clock.tick(30000);
  assert.equal(attempts.length, 3);
  assert.deepEqual(task.results, []);
  task.monitor.stop();
});

test('a response is discarded if the screen changed before it arrived', async () => {
  const response = deferred();
  let requests = 0;
  const task = harness({ minRequestIntervalMs: 0, recognize: async () => {
    requests += 1;
    return requests === 1 ? response.promise : { hand: ['AS'] };
  } });
  task.monitor.start();
  await task.clock.tick(100);
  task.change(120);
  response.resolve({ hand: ['6C'] });
  await settle();
  assert.equal(task.monitor.getState().phase, 'stale');
  assert.deepEqual(task.results, []);
  await task.clock.tick(100);
  assert.equal(requests, 2);
  assert.deepEqual(task.results, [{ hand: ['AS'] }]);
  await task.clock.tick(1000);
  assert.equal(requests, 2);
  task.monitor.stop();
});

test('the configured session budget pauses monitoring after the last paid call', async () => {
  const task = harness({ maxRequests: 2, minRequestIntervalMs: 0 });
  task.monitor.start();
  await task.clock.tick(100);
  task.change(120);
  await task.clock.tick(200);
  assert.equal(task.calls.length, 2);
  assert.equal(task.results.length, 2);
  assert.equal(task.monitor.getState().running, false);
  assert.equal(task.monitor.getState().phase, 'limit');
  assert.equal(task.clock.pending(), 0);
  task.change(240);
  await task.clock.tick(10000);
  assert.equal(task.calls.length, 2);
});

for (const status of [401, 402, 403, 429, 503]) {
  test(`HTTP ${status} stops automatic analysis without retries`, async () => {
    let requests = 0;
    let stoppedWhenNotified = false;
    const task = harness({ recognize: async () => {
      requests += 1;
      throw Object.assign(new Error('Provider failure'), { status });
    }, onStatus: notification => {
      if (notification.phase === 'error') stoppedWhenNotified = !task.monitor.getState().running;
    } });
    task.monitor.start();
    await task.clock.tick(100);
    assert.equal(task.monitor.getState().running, false);
    assert.equal(task.monitor.getState().phase, 'error');
    assert.equal(task.errors[0].fatal, true);
    assert.equal(stoppedWhenNotified, true, 'start controls must see the stopped state during error callbacks');
    task.change(120);
    await task.clock.tick(20000);
    assert.equal(requests, 1);
  });
}

test('transient failures retry the same frame twice with spacing and then stop', async () => {
  let requests = 0;
  const task = harness({ minRequestIntervalMs: 0, maxObservationRetries: undefined, recognize: async () => {
    requests += 1;
    throw Object.assign(new Error('Temporary failure'), { status: 502 });
  } });
  task.monitor.start();
  await task.clock.tick(100);
  assert.equal(task.errors[0].fatal, false);
  await task.clock.tick(2999);
  assert.equal(requests, 1);
  await task.clock.tick(1);
  assert.equal(requests, 2);
  await task.clock.tick(3000);
  assert.equal(requests, 3);
  assert.equal(task.monitor.getState().running, false);
  assert.equal(task.errors.at(-1).fatal, true);
});

test('onResult may pause the monitor for user review without scheduling more work', async () => {
  let monitor;
  const task = harness({ onResult: async () => { monitor.stop(); } });
  monitor = task.monitor;
  monitor.start();
  await task.clock.tick(100);
  assert.equal(monitor.getState().phase, 'idle');
  assert.equal(task.clock.pending(), 0);
  task.change(120);
  await task.clock.tick(10000);
  assert.equal(task.calls.length, 1);
});

test('capture failure is reported and repeated capture failures stop the loop', async () => {
  const task = harness({ capture: async () => { throw new Error('Window closed'); } });
  task.monitor.start();
  await task.clock.tick(6000);
  assert.equal(task.errors.length, 3);
  assert.equal(task.monitor.getState().running, false);
  assert.equal(task.monitor.getState().requests, 0);
});

test('local game-region search keeps watching without paid attempts or transport errors', async () => {
  let located=false;
  const task=harness({capture:async()=>{
    if(!located) throw Object.assign(new Error('Ищем стол локально.'),{localOnly:true});
    return {image:'game-only',signature:new Uint8Array(16).fill(80)};
  }});
  task.monitor.start();
  await task.clock.tick(20000);
  assert.equal(task.monitor.getState().running,true);
  assert.equal(task.monitor.getState().phase,'locating');
  assert.equal(task.calls.length,0);
  assert.equal(task.errors.length,0);
  located=true;
  await task.clock.tick(200);
  assert.equal(task.calls.length,1);
  task.monitor.stop();
});

test('ordinary incomplete observations get two bounded rereads and then wait for change', async () => {
  const recovery = createAutoRecovery();
  const received = [];
  const task = harness({ minRequestIntervalMs: 0, maxObservationRetries: undefined, onResult: (observation, details) => {
    received.push({ observation, ...details });
    return recovery.observe({ status: 'review', reasons: ['Не видна одна карта.'] }, details);
  } });
  task.monitor.start();
  await task.clock.tick(100);
  assert.equal(task.monitor.getState().phase, 'retrying');
  await task.clock.tick(100);
  assert.equal(task.calls.length, 2);
  await task.clock.tick(100);
  assert.equal(task.calls.length, 3);
  assert.deepEqual(received.map(result => result.requestNumber), [1, 2, 3]);
  assert.equal(task.monitor.getState().phase, 'observing');
  assert.equal(task.monitor.getState().running, true);
  await task.clock.tick(30000);
  assert.equal(task.calls.length, 3);
  assert.equal(task.monitor.getState().phase, 'observing');
  assert.match(task.monitor.getState().message, /трёх попыток/);
  task.monitor.stop();
});

test('an automatic same-frame retry honors the configured spacing between paid request starts', async () => {
  const task = harness({ onResult: () => ({ action: 'retry', message: 'Повторяем кадр автоматически.' }) });
  task.monitor.start();
  await task.clock.tick(100);
  await task.clock.tick(4999);
  assert.equal(task.calls.length, 1);
  assert.equal(task.monitor.getState().phase, 'retrying');
  await task.clock.tick(1);
  assert.equal(task.calls.length, 2);
  assert.equal(task.calls[1].at - task.calls[0].at, 5000);
  await task.clock.tick(10000);
  assert.equal(task.calls.length, 2, 'the scheduler itself also caps identical retries');
  assert.equal(task.monitor.getState().phase, 'observing');
  task.monitor.stop();
});

test('the total session request budget includes incomplete-frame retries', async () => {
  for (const maxRequests of [1, 2]) {
    const task = harness({ maxRequests, minRequestIntervalMs: 0, onResult: () => ({ retry: true }) });
    task.monitor.start();
    await task.clock.tick(10000);
    assert.equal(task.calls.length, maxRequests);
    assert.equal(task.monitor.getState().running, false);
    assert.equal(task.monitor.getState().phase, 'limit');
    assert.equal(task.clock.pending(), 0);
  }
});

test('a real screen change replaces a pending retry with a new position key and allowance', async () => {
  const metadata = [];
  const task = harness({ onResult: (observation, details) => {
    metadata.push(details);
    return { retry: true };
  } });
  task.monitor.start();
  await task.clock.tick(100);
  task.change(120);
  await task.clock.tick(5000);
  assert.equal(task.calls.length, 2);
  assert.equal(task.calls[1].image, 'frame-120');
  assert.notEqual(metadata[0].positionKey, metadata[1].positionKey);
  await task.clock.tick(5000);
  assert.equal(task.calls.length, 3);
  assert.equal(metadata[1].positionKey, metadata[2].positionKey);
  await task.clock.tick(10000);
  assert.equal(task.calls.length, 3);
  task.monitor.stop();
});

test('small frame noise and different model answers preserve the pending position retry key', async () => {
  const keys = [];
  const task = harness({ onResult: (observation, { positionKey }) => {
    keys.push(positionKey);
    return { retry: true };
  }, recognize: async image => ({ description: `Different answer for ${image}` }) });
  task.monitor.start();
  await task.clock.tick(100);
  task.change(4);
  await task.clock.tick(5000);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  await task.clock.tick(10000);
  assert.equal(keys.length, 2);
  task.monitor.stop();
});

test('resuming an incomplete position uses its remaining bounded attempt without resetting its key', async () => {
  const metadata = [];
  const task = harness({ onResult: (observation, details) => {
    metadata.push(details);
    return { retry: true };
  } });
  task.monitor.start();
  await task.clock.tick(100);
  task.monitor.stop();
  assert.equal(task.clock.pending(), 0);
  await task.clock.tick(10000);
  assert.equal(task.calls.length, 1);
  task.monitor.start();
  await task.clock.tick(100);
  assert.equal(task.calls.length, 1);
  assert.equal(task.monitor.getState().requests, 0);
  await task.clock.tick(10000);
  assert.equal(task.calls.length, 2);
  assert.equal(metadata[0].positionKey, metadata[1].positionKey, 'cached advice is reapplied first');
  assert.equal(metadata[1].cached, true);
  assert.equal(metadata[2].positionKey, metadata[0].positionKey, 'remaining attempt keeps the original billing identity');
  await task.clock.tick(10000);
  assert.equal(task.calls.length, 2, 'Pause and Start do not replenish retries');
  task.change(100);
  await task.clock.tick(200);
  assert.equal(task.calls.length, 3);
  assert.notEqual(metadata[0].positionKey, metadata[3].positionKey);
  assert.equal(metadata[3].requestNumber, 2);
  assert.equal(task.monitor.getState().phase, 'retrying');
  task.monitor.stop();
});

test('the result callback can pause and return a retry without leaving a timer behind', async () => {
  const task = harness({ onResult: () => {
    task.monitor.stop();
    return { retry: true };
  } });
  task.monitor.start();
  await task.clock.tick(10000);
  assert.equal(task.calls.length, 1);
  assert.equal(task.clock.pending(), 0);
  assert.equal(task.monitor.getState().phase, 'idle');
});

test('a wait decision preserves its explanatory status while monitoring the unchanged window', async () => {
  const task = harness({ onResult: () => ({ action: 'wait', message: 'Продолжаем наблюдение за окном.' }) });
  task.monitor.start();
  await task.clock.tick(10000);
  assert.equal(task.calls.length, 1);
  assert.equal(task.monitor.getState().running, true);
  assert.equal(task.monitor.getState().phase, 'observing');
  assert.equal(task.monitor.getState().message, 'Продолжаем наблюдение за окном.');
  task.monitor.stop();
});

test('an accepted automatic retry returns to ordinary watching and does not repeat further', async () => {
  let observations = 0;
  const task = harness({ minRequestIntervalMs: 0, onResult: () => {
    observations += 1;
    return observations === 1 ? { retry: true } : { action: 'accept', message: 'Позиция обновлена.' };
  } });
  task.monitor.start();
  await task.clock.tick(200);
  assert.equal(task.calls.length, 2);
  assert.equal(task.monitor.getState().phase, 'watching');
  assert.equal(task.monitor.getState().message, 'Позиция обновлена.');
  await task.clock.tick(10000);
  assert.equal(task.calls.length, 2);
  assert.equal(task.monitor.getState().phase, 'unchanged');
  task.monitor.stop();
});

test('scheduler retry configuration can disable retries or explicitly permit at most two', async () => {
  for (const maxObservationRetries of [0, 2]) {
    const task = harness({ maxObservationRetries, minRequestIntervalMs: 0, onResult: () => ({ retry: true }) });
    task.monitor.start();
    await task.clock.tick(10000);
    assert.equal(task.calls.length, 1 + maxObservationRetries);
    assert.equal(task.monitor.getState().running, true);
    task.monitor.stop();
  }
  for (const maxObservationRetries of [-1, 3, 1.5]) {
    assert.throws(() => harness({ maxObservationRetries }), RangeError);
  }
});

test('resolved positions stay free and failed positions only use their remaining bounded retry after resume', async () => {
  for (const fail of [false, true]) {
    let requests = 0;
    const task = harness({ minRequestIntervalMs: 0, recognize: async () => {
      requests += 1;
      if (fail) throw Object.assign(new Error('Temporary failure'), { status: 502 });
      return { hand: ['6C'] };
    } });
    task.monitor.start();
    await task.clock.tick(100);
    task.monitor.stop();
    task.monitor.start();
    await task.clock.tick(30000);
    assert.equal(requests, fail ? 2 : 1);
    assert.equal(task.monitor.getState().requests, fail ? 1 : 0);
    task.change(4); // Small sensor/compression noise is still the same position.
    await task.clock.tick(1000);
    assert.equal(requests, fail ? 2 : 1);
    task.change(100);
    await task.clock.tick(200);
    assert.equal(requests, fail ? 3 : 2);
    task.monitor.stop();
  }
});

test('a revisited stable position restores cached advice without payment, including small pixel noise', async () => {
  const task = harness({ minRequestIntervalMs: 0 });
  task.monitor.start();
  await task.clock.tick(100);
  task.change(100);
  await task.clock.tick(200);
  assert.equal(task.calls.length, 2);
  task.change(4);
  await task.clock.tick(5000);
  assert.equal(task.calls.length, 2);
  assert.equal(task.results.length, 3);
  assert.deepEqual(task.results.at(-1), { hand: ['frame-0'] });
  assert.equal(task.monitor.getState().phase, 'unchanged');
  task.monitor.stop();
});

test('shared frame memory survives monitor recreation and contains bounded thumbnails and parsed observations', async () => {
  const frameMemory = [];
  const keys = [];
  const initial = harness({ frameMemory, minRequestIntervalMs: 0,
    onResult: (observation, { positionKey }) => { keys.push(positionKey); } });
  initial.monitor.start();
  await initial.clock.tick(100);
  initial.monitor.stop();
  const replacement = harness({ frameMemory, minRequestIntervalMs: 0,
    onResult: (observation, { positionKey }) => { keys.push(positionKey); } });
  replacement.monitor.start();
  await replacement.clock.tick(10000);
  assert.equal(replacement.calls.length, 0);
  replacement.change(100);
  await replacement.clock.tick(200);
  assert.equal(replacement.calls.length, 1);
  assert.equal(keys[0], keys[1], 'the stored result is restored locally');
  assert.notEqual(keys[0], keys[2]);
  assert.ok(frameMemory.every(entry => entry.signature instanceof Uint8Array));
  assert.ok(frameMemory.every(entry => !('image' in entry) && entry.observation));
  replacement.monitor.stop();
});

test('only explicit frame reset permits rereading an unchanged source', async () => {
  const task = harness({ minRequestIntervalMs: 0 });
  task.monitor.start();
  await task.clock.tick(100);
  task.monitor.stop();
  task.monitor.resetFrames();
  task.monitor.start();
  await task.clock.tick(100);
  assert.equal(task.calls.length, 2);
  task.monitor.stop();
});

test('frame ledger bounds retained thumbnails and evicts the oldest attempt', async () => {
  const frameMemory = [];
  const task = harness({ frameMemory, maxRememberedFrames: 2, minRequestIntervalMs: 0 });
  task.monitor.start();
  await task.clock.tick(100);
  for (const pixel of [100, 200]) {
    task.change(pixel);
    await task.clock.tick(200);
  }
  assert.equal(frameMemory.length, 2);
  task.change(0);
  await task.clock.tick(200);
  assert.equal(task.calls.length, 4);
  assert.equal(frameMemory.length, 2);
  task.monitor.stop();
  for (const maxRememberedFrames of [0, 513, 1.5]) {
    assert.throws(() => harness({ maxRememberedFrames }), RangeError);
  }
  assert.throws(() => harness({ frameMemory: {} }), RangeError);
});

test('recognizer receives a stable payment key and explicit confirmation marker', async () => {
  const metadata = [];
  const task = harness({ minRequestIntervalMs: 0,
    recognize: async (image, details) => { metadata.push(details); return {}; },
    onResult: () => ({ retry: true }) });
  task.monitor.start();
  await task.clock.tick(200);
  assert.equal(metadata.length, 2);
  assert.equal(metadata[0].positionKey, metadata[1].positionKey);
  assert.deepEqual(metadata.map(details => details.requestNumber), [1, 2]);
  assert.deepEqual(metadata.map(details => details.confirmation), [false, true]);
  assert.ok(metadata.every(details => details.signal instanceof AbortSignal));
  task.monitor.stop();
});
