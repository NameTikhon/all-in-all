import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../server.mjs';

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=';
const imageVariant = marker => 'data:image/png;base64,' + Buffer.concat([
  Buffer.from(IMAGE.split(',')[1], 'base64'), Buffer.from([marker]),
]).toString('base64');
const OBSERVATION = { hand: null, table: null, trumpSuit: null, trumpCard: null, opponentCount: null, stockCount: null, role: null, confidence: 'low', notes: [] };
const visionResponse = () => ({ ok: true, json: async () => ({
  status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(OBSERVATION) }] }],
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(OBSERVATION) } }],
}) });

async function withServer(options, callback) {
  const server = createAppServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await callback(base); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

const post = (base, body, headers = {}) => fetch(base + '/api/vision', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body),
});

test('config reports missing fields without exposing an API key', async () => {
  await withServer({ apiKey: 'test-secret', model: '' }, async base => {
    const response = await fetch(base + '/api/config');
    const config = await response.json();
    assert.equal(config.visionConfigured, false);
    assert.deepEqual(config.missingConfiguration, ['OPENAI_MODEL']);
    assert.ok(!JSON.stringify(config).includes('test-secret'));
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

test('unknown hosts and cross-origin requests cannot invoke a paid API', async () => {
  await withServer({}, async base => {
    // fetch owns the Host header; use an actual HTTP request for the rebinding test.
    const hostStatus = await new Promise((resolve, reject) => {
      const req = request(base + '/api/config', { headers: { Host: 'attacker.example' } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(hostStatus, 403);
    assert.equal((await post(base, { image: IMAGE }, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await fetch(base + '/api/vision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await post(base, { image: IMAGE }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  });
});

test('bad bodies and absent configuration have clear status codes', async () => {
  await withServer({}, async base => {
    assert.equal((await post(base, { image: IMAGE })).status, 503);
    assert.equal((await post(base, { image: 'not-an-image' })).status, 400);
    assert.equal((await post(base, { image: IMAGE, apiKey: 'not-accepted' })).status, 400);
    assert.equal((await post(base, { image: IMAGE }, { 'Content-Type': 'text/plain' })).status, 415);
    const malformed = await fetch(base + '/api/vision', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{' });
    assert.equal(malformed.status, 400);
  });
});

test('static server exposes web assets and never project files or traversal paths', async () => {
  await withServer({}, async base => {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await fetch(base + '/', { method: 'HEAD' })).status, 200);
    for (const pathname of ['/server.mjs', '/.env', '/package.json', '/%2e%2e%5cserver.mjs', '/%00.js', '/api/unknown']) {
      assert.equal((await fetch(base + pathname)).status, 404, pathname);
    }
  });
});

test('one recognition request at a time and completion unlocks the service', async () => {
  let release;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const observation = { hand: null, table: null, trumpSuit: null, trumpCard: null, opponentCount: null, stockCount: null, role: null, confidence: 'low', notes: [] };
  await withServer({ apiKey: 'test', model: 'test', fetchImpl: async () => {
    markStarted(); await gate;
    return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(observation) }] }] }) };
  } }, async base => {
    const first = post(base, { image: IMAGE });
    await Promise.race([started, first.then(() => { throw new Error('Request finished without calling the vision service'); })]);
    try { assert.equal((await post(base, { image: IMAGE })).status, 429); }
    finally { release(); }
    assert.equal((await first).status, 200);
    const next = await post(base, { image: IMAGE });
    assert.equal(next.status, 200);
    assert.deepEqual((await next.json()).observation, observation);
  });
});

test('API settings require a same-origin JSON request and return no credential', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'durak-server-settings-'));
  const settingsPath = path.join(directory, '.env');
  const settingsBody = { provider: 'genapi', model: 'gpt-6-luna', apiKey: 'new-test-secret' };
  try {
    await withServer({ provider: 'genapi', settingsPath }, async base => {
      const save = (body = settingsBody, headers = {}) => fetch(base + '/api/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body),
      });
      assert.equal((await save(settingsBody, { Origin: 'https://attacker.example' })).status, 403);
      assert.equal((await save(settingsBody, { 'sec-fetch-site': 'cross-site' })).status, 403);
      assert.equal((await save(settingsBody, { 'Content-Type': 'text/plain' })).status, 415);
      assert.equal((await save({ ...settingsBody, apiKey: 'bad\nPORT=1000' })).status, 400);
      const saved = await save();
      assert.equal(saved.status, 200);
      const publicConfig = await saved.json();
      assert.equal(publicConfig.visionConfigured, true);
      assert.equal(publicConfig.provider, 'genapi');
      assert.ok(!JSON.stringify(publicConfig).includes('new-test-secret'));
      assert.match(await readFile(settingsPath, 'utf8'), /GENAPI_API_KEY=new-test-secret/);
      const config = await (await fetch(base + '/api/config')).json();
      assert.deepEqual(config, publicConfig);
      assert.equal((await fetch(base + '/.env')).status, 404);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('saved GenAPI settings are used by the next frame without a server restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'durak-server-reload-'));
  const settingsPath = path.join(directory, '.env');
  const observation = { hand: null, table: null, trumpSuit: null, trumpCard: null, opponentCount: null, stockCount: null, role: null, confidence: 'low', notes: [] };
  let calls = 0;
  try {
    await withServer({ provider: 'genapi', settingsPath, fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://proxy.gen-api.ru/v1/chat/completions');
      assert.equal(options.headers.Authorization, 'Bearer updated-test-secret');
      assert.equal(JSON.parse(options.body).model, 'gpt-6-luna');
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(observation) } }] }) };
    } }, async base => {
      assert.equal((await post(base, { image: IMAGE })).status, 503);
      await writeFile(settingsPath, 'VISION_PROVIDER=genapi\nGENAPI_API_KEY=updated-test-secret\nGENAPI_MODEL=gpt-6-luna\n');
      const recognized = await post(base, { image: IMAGE });
      assert.equal(recognized.status, 200);
      assert.deepEqual((await recognized.json()).observation, observation);
      assert.equal(calls, 1);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('old capture clients are rejected before a provider request can spend credits', async () => {
  let calls = 0;
  await withServer({ apiKey: 'test', model: 'test', requiredCaptureVersion: '2', fetchImpl: async () => {
    calls += 1; return visionResponse();
  } }, async base => {
    for (const headers of [{}, { 'X-Durak-Capture-Version': '1' }]) {
      const response = await post(base, { image: IMAGE }, headers);
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.upstreamRequested, false);
      assert.equal(body.cached, false);
      assert.match(body.error, /Обновите страницу.*старый клиент/);
    }
    assert.equal(calls, 0);
    const current = await post(base, { image: IMAGE }, { 'X-Durak-Capture-Version': '2' });
    assert.equal(current.status, 200);
    assert.equal((await current.json()).upstreamRequested, true);
    assert.equal(calls, 1);
  });
});

test('identical position keys reuse observations despite image noise and permit only one explicit confirmation', async () => {
  let calls = 0;
  const noisyImage = 'data:image/png;base64,' + Buffer.concat([
    Buffer.from(IMAGE.split(',')[1], 'base64'), Buffer.from([0]),
  ]).toString('base64');
  await withServer({ apiKey: 'test', model: 'test', fetchImpl: async () => {
    calls += 1; return visionResponse();
  } }, async base => {
    const first = await (await post(base, { image: IMAGE, frameKey: 'source-1:frame-1' })).json();
    assert.deepEqual(first, { observation: OBSERVATION, cached: false, upstreamRequested: true });
    const duplicate = await (await post(base, { image: noisyImage, frameKey: 'source-1:frame-1' })).json();
    assert.deepEqual(duplicate, { observation: OBSERVATION, cached: true, upstreamRequested: false });
    assert.equal(calls, 1);
    const confirm = await (await post(base, { image: noisyImage, frameKey: 'source-1:frame-1', confirmation: true })).json();
    assert.equal(confirm.upstreamRequested, true);
    assert.equal(calls, 2);
    for (let index = 0; index < 3; index += 1) {
      const cached = await (await post(base, { image: IMAGE, frameKey: 'source-1:frame-1', confirmation: true })).json();
      assert.equal(cached.cached, true);
      assert.equal(cached.upstreamRequested, false);
    }
    assert.equal(calls, 2);
    await post(base, { image: imageVariant(2), frameKey: 'source-1:frame-2' });
    assert.equal(calls, 3, 'a new position key remains independently recognizable');
  });
});

test('image hash deduplicates legacy-compatible requests without frame metadata', async () => {
  let calls = 0;
  await withServer({ apiKey: 'test', model: 'test', fetchImpl: async () => {
    calls += 1; return visionResponse();
  } }, async base => {
    await post(base, { image: IMAGE });
    const duplicate = await (await post(base, { image: IMAGE })).json();
    assert.equal(duplicate.cached, true);
    assert.equal(duplicate.upstreamRequested, false);
    assert.equal(calls, 1);
  });
});

test('exact screenshot content deduplicates across new capture keys and shares its confirmation allowance', async () => {
  let calls = 0;
  await withServer({ apiKey: 'test', model: 'test', fetchImpl: async () => {
    calls += 1; return visionResponse();
  } }, async base => {
    await post(base, { image: IMAGE, frameKey: 'first-capture:frame-1' });
    const duplicate = await (await post(base, { image: IMAGE, frameKey: 'new-capture:frame-92' })).json();
    assert.equal(duplicate.cached, true);
    assert.equal(duplicate.upstreamRequested, false);
    assert.equal(calls, 1);
    const confirm = await (await post(base, {
      image: IMAGE, frameKey: 'third-capture:frame-120', confirmation: true,
    })).json();
    assert.equal(confirm.upstreamRequested, true);
    assert.equal(calls, 2);
    for (const frameKey of ['first-capture:frame-1', 'new-capture:frame-92', 'yet-another-key']) {
      const exhausted = await (await post(base, { image: IMAGE, frameKey, confirmation: true })).json();
      assert.equal(exhausted.cached, true);
      assert.equal(exhausted.upstreamRequested, false);
    }
    assert.equal(calls, 2);
    const different = await (await post(base, { image: imageVariant(3), frameKey: 'new-real-position' })).json();
    assert.equal(different.upstreamRequested, true);
    assert.equal(calls, 3);
  });
});

test('a failed confirmation replaces every prior frame alias with the sanitized error', async () => {
  let calls = 0;
  await withServer({ apiKey: 'test', model: 'test', fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? visionResponse() : { ok: false, status: 500 };
  } }, async base => {
    await post(base, { image: IMAGE, frameKey: 'first-alias' });
    await post(base, { image: IMAGE, frameKey: 'second-alias' });
    const failure = await post(base, { image: IMAGE, frameKey: 'third-alias', confirmation: true });
    assert.equal(failure.status, 502);
    for (const frameKey of ['first-alias', 'second-alias', 'third-alias', 'fourth-alias']) {
      const cached = await post(base, { image: IMAGE, frameKey, confirmation: true });
      assert.equal(cached.status, 502);
      assert.equal((await cached.json()).upstreamRequested, false);
    }
    assert.equal(calls, 2);
  });
});

test('failed upstream responses are sanitized and cached instead of repeatedly charging', async () => {
  let calls = 0;
  await withServer({ apiKey: 'never-expose-test-key', model: 'test', fetchImpl: async () => {
    calls += 1;
    return { ok: false, status: 500, text: async () => 'never-expose-test-key ' + IMAGE };
  } }, async base => {
    const first = await post(base, { image: IMAGE, frameKey: 'failed-frame' });
    assert.equal(first.status, 502);
    const firstBody = await first.json();
    assert.equal(firstBody.upstreamRequested, true);
    assert.equal(firstBody.cached, false);
    assert.ok(!JSON.stringify(firstBody).includes('never-expose-test-key'));
    assert.ok(!JSON.stringify(firstBody).includes(IMAGE));
    const next = await post(base, { image: IMAGE, frameKey: 'failed-frame' });
    assert.equal(next.status, 502);
    assert.deepEqual(await next.json(), { ...firstBody, cached: true, upstreamRequested: false });
    assert.equal(calls, 1);
    await post(base, { image: IMAGE, frameKey: 'failed-frame', confirmation: true });
    await post(base, { image: IMAGE, frameKey: 'failed-frame', confirmation: true });
    assert.equal(calls, 2, 'failed confirmations also consume the one-extra-read allowance');
  });
});

test('cache scope includes provider, model and credential fingerprint', async () => {
  let calls = 0;
  const env = { VISION_PROVIDER: 'openai', OPENAI_API_KEY: 'first-private-key', OPENAI_MODEL: 'first-model' };
  await withServer({ env, fetchImpl: async () => { calls += 1; return visionResponse(); } }, async base => {
    const body = { image: IMAGE, frameKey: 'shared-position' };
    await post(base, body);
    await post(base, body);
    assert.equal(calls, 1);
    env.OPENAI_MODEL = 'second-model';
    assert.equal((await (await post(base, body)).json()).upstreamRequested, true);
    env.OPENAI_API_KEY = 'second-private-key';
    assert.equal((await (await post(base, body)).json()).upstreamRequested, true);
    env.VISION_PROVIDER = 'genapi';
    env.GENAPI_MODEL = 'second-model';
    env.GENAPI_API_KEY = 'second-private-key';
    assert.equal((await (await post(base, body)).json()).upstreamRequested, true);
    assert.equal(calls, 4);
  });
});

test('global minimum paid interval blocks rapid new frames but never blocks free cache hits', async () => {
  let time = 0;
  let calls = 0;
  await withServer({ apiKey: 'test', model: 'test', minimumPaidIntervalMs: 5000, now: () => time,
    fetchImpl: async () => { calls += 1; return visionResponse(); } }, async base => {
    await post(base, { image: IMAGE, frameKey: 'first' });
    const cached = await post(base, { image: IMAGE, frameKey: 'first' });
    assert.equal(cached.status, 200);
    assert.equal((await cached.json()).upstreamRequested, false);
    for (time of [0, 4999]) {
      const rejected = await post(base, { image: imageVariant(2), frameKey: 'second' });
      assert.equal(rejected.status, 429);
      assert.equal((await rejected.json()).upstreamRequested, false);
    }
    assert.equal(calls, 1);
    time = 5000;
    const allowed = await post(base, { image: imageVariant(2), frameKey: 'second' });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).upstreamRequested, true);
    assert.equal(calls, 2);
  });
});

test('invalid metadata, images or configuration never reach the paid request path', async () => {
  let calls = 0;
  await withServer({ apiKey: 'test', model: 'test', fetchImpl: async () => { calls += 1; return visionResponse(); } }, async base => {
    for (const invalid of [
      { image: IMAGE, frameKey: '' }, { image: IMAGE, frameKey: 'x'.repeat(161) },
      { image: IMAGE, frameKey: 1 }, { image: IMAGE, frameKey: 'bad\nkey' },
      { image: IMAGE, confirmation: 1 }, { image: IMAGE, confirmation: 'true' },
      { image: IMAGE, retryAttempt: -1 }, { image: IMAGE, retryAttempt: 3 },
      { image: IMAGE, retryAttempt: 1.5 }, { image: IMAGE, retryAttempt: '1' },
      { image: IMAGE, extra: true }, { image: 'not-image', frameKey: 'good' },
    ]) {
      const response = await post(base, invalid);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).upstreamRequested, false);
    }
    assert.equal(calls, 0);
  });
  await withServer({ fetchImpl: async () => { calls += 1; return visionResponse(); } }, async base => {
    const response = await post(base, { image: IMAGE, frameKey: 'valid' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).upstreamRequested, false);
    assert.equal(calls, 0);
  });
});

test('two retry ordinals permit bounded recovery and every duplicate or image alias remains free', async () => {
  let calls = 0;
  await withServer({ apiKey: 'test', model: 'test', fetchImpl: async () => {
    calls += 1;
    return calls < 3 ? { ok: false, status: 500 } : visionResponse();
  } }, async base => {
    const frame = { image: IMAGE, frameKey: 'retry-frame' };
    for (const retryAttempt of [0, 1, 2]) {
      const read = await post(base, { ...frame, retryAttempt });
      assert.equal(read.status, retryAttempt < 2 ? 502 : 200);
      assert.equal((await read.json()).upstreamRequested, true);
      const duplicate = await post(base, { ...frame, retryAttempt });
      assert.equal((await duplicate.json()).upstreamRequested, false);
      assert.equal(calls, retryAttempt + 1);
    }
    for (const retryAttempt of [0, 1, 2, 2, 0]) {
      const cached = await post(base, { ...frame, frameKey: `alias-${retryAttempt}`, retryAttempt });
      assert.equal(cached.status, 200);
      assert.deepEqual(await cached.json(), { observation: OBSERVATION, cached: true, upstreamRequested: false });
    }
    assert.equal(calls, 3);
  });
});

test('a retry cancelled before reaching HTTP may skip ordinals without increasing its three-slot budget', async () => {
  let calls = 0;
  await withServer({ apiKey: 'test', model: 'test', fetchImpl: async () => {
    calls++; return visionResponse();
  } }, async base => {
    const frame = { image: IMAGE, frameKey: 'aborted-before-http' };
    const resumed = await post(base, { ...frame, retryAttempt: 1 });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).upstreamRequested, true);
    assert.equal(calls, 1);
    const last = await post(base, { ...frame, retryAttempt: 2 });
    assert.equal((await last.json()).upstreamRequested, true);
    for (const retryAttempt of [0, 1, 2]) {
      assert.equal((await (await post(base, { ...frame, retryAttempt })).json()).upstreamRequested, false);
    }
    assert.equal(calls, 2, 'an unsent ordinal is consumed rather than reset');
  });
});

test('a rejected early second retry preserves spacing and its remaining paid allowance', async () => {
  let time = 0, calls = 0;
  await withServer({ apiKey: 'test', model: 'test', minimumPaidIntervalMs: 5000, now: () => time,
    fetchImpl: async () => { calls++; return visionResponse(); } }, async base => {
    const frame = { image: IMAGE, frameKey: 'two-retries' };
    await post(base, { ...frame, retryAttempt: 0 });
    time = 5000;
    await post(base, { ...frame, retryAttempt: 1 });
    const early = await post(base, { ...frame, retryAttempt: 2 });
    assert.equal(early.status, 429);
    assert.equal((await early.json()).upstreamRequested, false);
    assert.equal(calls, 2);
    time = 10000;
    const final = await post(base, { ...frame, retryAttempt: 2 });
    assert.equal((await final.json()).upstreamRequested, true);
    assert.equal(calls, 3);
  });
});

test('an unpaid throttled confirmation neither bypasses spacing nor consumes its one allowance', async () => {
  let time = 0;
  let calls = 0;
  await withServer({ apiKey: 'test', model: 'test', minimumPaidIntervalMs: 5000, now: () => time,
    fetchImpl: async () => { calls += 1; return visionResponse(); } }, async base => {
    const frame = { image: IMAGE, frameKey: 'confirm-once' };
    await post(base, frame);
    const early = await post(base, { ...frame, confirmation: true });
    assert.equal(early.status, 429);
    assert.equal((await early.json()).upstreamRequested, false);
    assert.equal(calls, 1);
    time = 5000;
    const allowed = await post(base, { ...frame, confirmation: true });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).upstreamRequested, true);
    const duplicate = await post(base, { ...frame, confirmation: true });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).cached, true);
    assert.equal(calls, 2);
  });
});

test('bounded result cache evicts least recently used positions', async () => {
  let calls = 0;
  await withServer({ apiKey: 'test', model: 'test', maxCachedFrames: 2,
    fetchImpl: async () => { calls += 1; return visionResponse(); } }, async base => {
    for (const frameKey of ['first', 'second', 'first', 'third', 'second']) {
      const image = imageVariant({ first: 1, second: 2, third: 3 }[frameKey]);
      await post(base, { image, frameKey });
    }
    assert.equal(calls, 4);
  });
  for (const options of [{ maxCachedFrames: 0 }, { maxCachedFrames: 513 }, { minimumPaidIntervalMs: -1 }, { now: null }]) {
    assert.throws(() => createAppServer(options), TypeError);
  }
});
