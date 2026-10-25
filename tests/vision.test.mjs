import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGenApiVisionRequest, buildVisionRequest, recognizeFrame, validateImage, validateObservation, VisionError } from '../lib/vision.mjs';

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=';
const observation = () => ({
  hand: ['6C', 'AS'], table: [{ attack: '7D', defense: null }],
  trumpSuit: 'H', trumpCard: '6H', opponentCount: 6, stockCount: null,
  role: null, confidence: 'medium', notes: ['Счётчик колоды не виден.'],
});
const responseFor = value => ({ ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }) });

test('vision request sends one image, disables response storage and requires a strict schema', () => {
  const request = buildVisionRequest(IMAGE, 'test-vision');
  assert.equal(request.model, 'test-vision');
  assert.equal(request.store, false);
  assert.equal(request.input[0].content.filter(item => item.type === 'input_image').length, 1);
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.schema.additionalProperties, false);
  assert.match(request.instructions, /untrusted/);
  assert.match(request.instructions, /Do not infer history/);
});

test('image validation refuses URLs, wrong signatures and malformed base64', () => {
  assert.equal(validateImage(IMAGE), IMAGE);
  for (const input of ['https://example.com/secret.png', 'data:image/png;base64,aGVsbG8=', 'data:image/jpeg;base64,@@@@', null]) {
    assert.throws(() => validateImage(input), { status: 400 });
  }
});

test('unknown observed values stay null; visible zero is a separate value', () => {
  const value = observation();
  assert.equal(validateObservation(value).stockCount, null);
  value.stockCount = 0;
  assert.equal(validateObservation(value).stockCount, 0);
});

test('a clear first attack does not require the screenshot to expose a hidden stock counter', async () => {
  const firstAttack = {
    hand: ['7S', 'KS', 'KD', 'AD', '10C', 'JC'],
    table: [{ attack: '6H', defense: null }],
    trumpSuit: 'C', trumpCard: 'AC', opponentCount: 5, stockCount: null,
    role: 'defend', confidence: 'high', notes: ['Счётчик колоды не показан.'],
  };
  for (const provider of ['openai', 'genapi']) {
    const result = await recognizeFrame({ image: IMAGE, apiKey: 'test-secret', model: 'test-model', provider,
      fetchImpl: async () => provider === 'openai' ? responseFor(firstAttack) : ({
        ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(firstAttack) } }] }),
      }),
    });
    assert.deepEqual(result, firstAttack);
    assert.equal(result.stockCount, null, 'The vision layer must not invent the hidden counter.');
    assert.equal(result.confidence, 'high', 'An absent hidden counter must not downgrade clear visible evidence.');
  }
});

test('a visible finish action survives both provider protocols without requiring a stock counter', async () => {
  const coveredAttack = {
    hand: ['8D', '9H', 'AC', '10S', 'QS'],
    table: [{ attack: '6C', defense: 'KC' }],
    trumpSuit: 'S', trumpCard: '7S', opponentCount: 5, stockCount: null,
    role: 'attack', action: 'finish', confidence: 'high', notes: [],
  };
  for (const provider of ['openai', 'genapi']) {
    const result = await recognizeFrame({ image: IMAGE, apiKey: 'test-secret', model: 'test-model', provider,
      fetchImpl: async () => provider === 'openai' ? responseFor(coveredAttack) : ({
        ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(coveredAttack) } }] }),
      }),
    });
    assert.deepEqual(result, coveredAttack);
    assert.equal(result.action, 'finish', 'The enabled ВСЁ control is actionable even on a covered table.');
    assert.equal(result.stockCount, null, 'A stock back must not be interpreted as a visible card count.');
  }
});

test('new observations require an action in provider schemas and old observations remain readable', () => {
  for (const request of [buildVisionRequest(IMAGE, 'test-model'), buildGenApiVisionRequest(IMAGE, 'test-model')]) {
    const schema = request.text?.format.schema ?? request.response_format.json_schema.schema;
    assert.ok(schema.required.includes('action'));
    assert.deepEqual(schema.properties.action.enum, ['attack', 'defend', 'finish', 'wait', 'unknown']);
  }
  assert.deepEqual(validateObservation(observation()), observation(), 'Saved observations without the new field must retain their exact data.');
  for (const action of ['attack', 'defend', 'finish', 'wait', 'unknown']) {
    assert.equal(validateObservation({ ...observation(), action }).action, action);
  }
  for (const action of [null, true, 'take', 'stop', {}]) {
    assert.throws(() => validateObservation({ ...observation(), action }), VisionError);
  }
});

test('bounded rereads change visual inspection instructions without changing model, schema or image', () => {
  for (const build of [buildVisionRequest, buildGenApiVisionRequest]) {
    const requests = [0, 1, 2].map(retryAttempt => build(IMAGE, 'test-model', { retryAttempt }));
    const instructions = request => request.instructions ?? request.messages[0].content;
    const userContent = request => request.input?.[0].content ?? request.messages[1].content;
    assert.doesNotMatch(instructions(requests[0]), /SECOND READING|FINAL VISUAL AUDIT/);
    assert.match(instructions(requests[1]), /SECOND READING/);
    assert.match(instructions(requests[1]), /BOTH corners|ВСЁ|БЕРУ/);
    assert.match(instructions(requests[2]), /FINAL VISUAL AUDIT/);
    assert.match(instructions(requests[2]), /accidental duplicate card identities/);
    assert.notEqual(userContent(requests[0])[0].text, userContent(requests[1])[0].text);
    assert.notEqual(userContent(requests[1])[0].text, userContent(requests[2])[0].text);
    for (const request of requests) {
      assert.equal(request.model, 'test-model');
      assert.deepEqual(userContent(request)[1], userContent(requests[0])[1]);
      assert.deepEqual(request.text?.format.schema ?? request.response_format.json_schema.schema,
        requests[0].text?.format.schema ?? requests[0].response_format.json_schema.schema);
    }
    assert.deepEqual(build(IMAGE, 'test-model', { retryAttempt: 100 }), requests[2]);
    assert.deepEqual(build(IMAGE, 'test-model', { retryAttempt: -1 }), requests[0]);
    assert.deepEqual(build(IMAGE, 'test-model', { retryAttempt: '1' }), requests[0]);
  }
});

test('recognition forwards the retry ordinal to each provider in exactly one upstream call', async () => {
  for (const provider of ['openai', 'genapi']) {
    let calls = 0;
    await recognizeFrame({ image: IMAGE, apiKey: 'test-secret', model: 'test-model', provider, retryAttempt: 2,
      fetchImpl: async (_url, options) => {
        calls++;
        const request = JSON.parse(options.body);
        assert.match(request.instructions ?? request.messages[0].content, /FINAL VISUAL AUDIT/);
        return provider === 'openai' ? responseFor(observation()) : ({
          ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(observation()) } }] }),
        });
      },
    });
    assert.equal(calls, 1, 'Only the outer automatic recovery loop may schedule another paid attempt.');
  }
});

test('runtime validation rejects invalid cards, duplicates, unexpected fields and invalid counters', () => {
  for (const modify of [
    value => { value.hand = ['2H']; },
    value => { value.hand = ['6C', '6C']; },
    value => { value.hand = ['7D']; },
    value => { value.opponentCount = -1; },
    value => { value.stockCount = 4.5; },
    value => { value.role = 'unknown'; },
    value => { value.confidence = 0.99; },
    value => { value.trumpSuit = 'S'; },
    value => { value.extra = 'ignored?'; },
    value => { delete value.table; },
  ]) {
    const value = observation(); modify(value);
    assert.throws(() => validateObservation(value), VisionError);
  }
});

test('recognition parses actual Responses output and only sends credentials upstream', async () => {
  let upstream;
  const result = await recognizeFrame({ image: IMAGE, apiKey: 'secret-test-key', model: 'test-model', fetchImpl: async (url, options) => {
    upstream = { url, options };
    return responseFor(observation());
  } });
  assert.equal(upstream.url, 'https://api.openai.com/v1/responses');
  assert.equal(upstream.options.headers.Authorization, 'Bearer secret-test-key');
  assert.equal(JSON.parse(upstream.options.body).model, 'test-model');
  assert.deepEqual(result, observation());
  assert.ok(!JSON.stringify(result).includes('secret-test-key'));
});

test('missing configuration never calls the network', async () => {
  await assert.rejects(recognizeFrame({ image: IMAGE, apiKey: '', model: '', fetchImpl: () => { throw new Error('must not call'); } }), { status: 503 });
});

test('provider errors and unexpected bodies are not echoed to the browser', async () => {
  await assert.rejects(recognizeFrame({ image: IMAGE, apiKey: 'key', model: 'model', fetchImpl: async () => ({
    ok: false, status: 401, json: () => { throw new Error('must not read upstream body'); },
  }) }), error => error.status === 401 && !error.message.includes('key'));
  await assert.rejects(recognizeFrame({ image: IMAGE, apiKey: 'key', model: 'model', fetchImpl: async () => ({
    ok: true, json: async () => ({ status: 'incomplete', output: [] }),
  }) }), /не завершено/);
});

test('refusals, invalid JSON and impossible observed duplicates cannot become state', async () => {
  const payloads = [
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'not-json' }] }] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ ...observation(), hand: ['7D'] }) }] }] },
  ];
  for (const payload of payloads) {
    await assert.rejects(recognizeFrame({ image: IMAGE, apiKey: 'key', model: 'model', fetchImpl: async () => ({ ok: true, json: async () => payload }) }), VisionError);
  }
});

test('network failures return actionable messages without network details', async () => {
  await assert.rejects(recognizeFrame({ image: IMAGE, apiKey: 'key', model: 'model', fetchImpl: async () => { throw new Error('private internals'); } }), /Проверьте подключение/);
});

test('GenAPI uses the official Chat Completions endpoint, image_url and strict structured output', async () => {
  const request = buildGenApiVisionRequest(IMAGE, 'gpt-6-luna');
  assert.equal(request.model, 'gpt-6-luna');
  assert.equal(request.stream, false);
  assert.equal(request.response_format.json_schema.strict, true);
  assert.match(request.messages[0].content, /untrusted/);
  assert.deepEqual(request.messages[1].content[1], { type: 'image_url', image_url: { url: IMAGE, detail: 'high' } });
  let calls = 0;
  const result = await recognizeFrame({ image: IMAGE, apiKey: 'test-secret', model: 'gpt-6-luna', provider: 'genapi', fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://proxy.gen-api.ru/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert.deepEqual(JSON.parse(options.body), request);
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(observation()) } }] }) };
  } });
  assert.deepEqual(result, observation());
  assert.equal(calls, 1);
});

test('GenAPI authentication, balance and rate limit errors are sanitized and never retried', async () => {
  for (const [status, pattern, expectedStatus] of [[401, /GenAPI не принял/, 401], [402, /недостаточно средств/, 402], [403, /недоступны/, 403], [429, /лимиты и баланс/, 429]]) {
    let calls = 0;
    await assert.rejects(recognizeFrame({ image: IMAGE, apiKey: 'test-secret', model: 'gpt-6-luna', provider: 'genapi', fetchImpl: async () => {
      calls++;
      return { ok: false, status, json: () => { throw new Error('upstream body must not be read'); } };
    } }), error => error.status === expectedStatus && pattern.test(error.message) && !error.message.includes('test-secret'));
    assert.equal(calls, 1);
  }
});

test('OpenAI account errors preserve actionable HTTP status codes as well', async () => {
  for (const status of [401, 402, 403, 429]) {
    await assert.rejects(recognizeFrame({ image: IMAGE, apiKey: 'test-secret', model: 'test-model', fetchImpl: async () => ({
      ok: false, status, json: () => { throw new Error('must not read provider body'); },
    }) }), error => error.status === status && !error.message.includes('test-secret'));
  }
});

test('GenAPI malformed, refused, truncated and invalid observations are rejected', async () => {
  const completion = (content, finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { content } }] });
  for (const payload of [null, {}, { choices: [null] }, completion('{}', 'length'), completion('{}', 'content_filter'),
    { choices: [{ finish_reason: 'stop', message: { content: '{}', refusal: 'no' } }] },
    completion('not JSON'), completion('{}'), completion(JSON.stringify({ ...observation(), hand: ['7D'] })), completion(null)]) {
    await assert.rejects(recognizeFrame({ image: IMAGE, apiKey: 'test-secret', model: 'gpt-6-luna', provider: 'genapi', fetchImpl: async () => ({ ok: true, json: async () => payload }) }), VisionError);
  }
});

test('aborted requests never start and upstream timeouts return a sanitized error', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(recognizeFrame({ image: IMAGE, apiKey: 'key', model: 'gpt-6-luna', provider: 'genapi', signal: controller.signal,
    fetchImpl: () => { throw new Error('must not call'); } }), { status: 499 });
  await assert.rejects(recognizeFrame({ image: IMAGE, apiKey: 'key', model: 'gpt-6-luna', provider: 'genapi',
    fetchImpl: async () => { throw new DOMException('private timeout details', 'TimeoutError'); } }), { status: 504 });
  await assert.rejects(recognizeFrame({ image: IMAGE, apiKey: 'key', model: 'gpt-6-luna', provider: 'genapi',
    fetchImpl: async () => ({ ok: true, json: async () => { throw new DOMException('private timeout details', 'AbortError'); } }) }), { status: 504 });
});
