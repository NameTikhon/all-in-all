import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSettingsStore, SettingsError } from '../lib/provider-settings.mjs';

async function withSettings(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'durak-settings-'));
  try { await callback(path.join(directory, '.env')); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('GenAPI defaults to GPT-6 Luna and public config never contains keys', async () => {
  const store = createSettingsStore({ provider: 'genapi', env: { GENAPI_API_KEY: 'test-secret' } });
  const config = store.publicConfig(await store.get());
  assert.equal(config.provider, 'genapi');
  assert.equal(config.providerLabel, 'GenAPI');
  assert.equal(config.model, 'gpt-6-luna');
  assert.equal(config.visionConfigured, true);
  assert.equal(config.keyConfigured, true);
  assert.equal(config.canSaveSettings, false);
  assert.ok(!JSON.stringify(config).includes('test-secret'));
});

test('legacy OpenAI environment remains supported and missing GenAPI key is explicit', async () => {
  const legacy = createSettingsStore({ provider: 'genapi', env: { OPENAI_API_KEY: 'legacy-secret', OPENAI_MODEL: 'legacy-vision' } });
  assert.equal((await legacy.get()).provider, 'openai');
  assert.equal((await legacy.get()).model, 'legacy-vision');
  const fresh = createSettingsStore({ provider: 'genapi' });
  assert.deepEqual(fresh.publicConfig(await fresh.get()).missingConfiguration, ['GENAPI_API_KEY']);
});

test('saving settings preserves comments and unrelated values, and immediately reloads', async () => {
  await withSettings(async settingsPath => {
    await writeFile(settingsPath, '# keep this comment\nPORT=9911\nOPENAI_API_KEY=other-secret\nVISION_PROVIDER=openai\nOPENAI_MODEL=other-model\n');
    const store = createSettingsStore({ provider: 'genapi', settingsPath });
    const saved = await store.save({ provider: 'genapi', model: 'gpt-6-luna', apiKey: 'new-test-secret' });
    assert.equal(saved.visionConfigured, true);
    assert.equal(saved.canSaveSettings, true);
    assert.ok(!JSON.stringify(saved).includes('new-test-secret'));
    const contents = await readFile(settingsPath, 'utf8');
    assert.match(contents, /# keep this comment\nPORT=9911/);
    assert.match(contents, /OPENAI_API_KEY=other-secret/);
    assert.match(contents, /GENAPI_API_KEY=new-test-secret/);
    assert.equal((await store.get()).provider, 'genapi');
    assert.equal((await store.get()).apiKey, 'new-test-secret');
    await store.save({ provider: 'genapi', model: 'gpt-6-luna-pro', apiKey: '' });
    assert.equal((await store.get()).apiKey, 'new-test-secret');
    assert.equal((await store.get()).model, 'gpt-6-luna-pro');
    await writeFile(settingsPath, 'VISION_PROVIDER=genapi\nGENAPI_API_KEY=manually-updated-secret\nGENAPI_MODEL=gpt-6-luna\n');
    assert.equal((await store.get()).apiKey, 'manually-updated-secret');
  });
});

test('switching providers with a blank key never copies the other provider credential', async () => {
  await withSettings(async settingsPath => {
    const store = createSettingsStore({ provider: 'openai', apiKey: 'openai-test-secret', model: 'openai-model', settingsPath });
    const config = await store.save({ provider: 'genapi', model: 'gpt-6-luna', apiKey: '' });
    assert.equal(config.keyConfigured, false);
    assert.equal((await store.get()).apiKey, '');
    assert.ok(!(await readFile(settingsPath, 'utf8')).includes('openai-test-secret'));
  });
});

test('invalid settings cannot inject environment lines, provider URLs or extra options', async () => {
  await withSettings(async settingsPath => {
    const store = createSettingsStore({ provider: 'genapi', settingsPath });
    for (const body of [null, [], {}, { provider: 'custom', model: 'x', apiKey: 'x' },
      { provider: 'genapi', model: 'x\nPORT=1234', apiKey: 'x' },
      { provider: 'genapi', model: 'x', apiKey: 'x\nPORT=1234' },
      { provider: 'genapi', model: 'x', apiKey: 'x'.repeat(513) },
      { provider: 'genapi', model: 'x', apiKey: 'x', baseUrl: 'https://attacker.example' }]) {
      await assert.rejects(store.save(body), SettingsError);
    }
  });
});

test('settings can repair an invalid stored model, and unknown env providers are refused', async () => {
  await withSettings(async settingsPath => {
    await writeFile(settingsPath, 'VISION_PROVIDER=genapi\nGENAPI_MODEL="bad model"\n');
    const store = createSettingsStore({ provider: 'genapi', settingsPath });
    await assert.rejects(store.get(), SettingsError);
    await store.save({ provider: 'genapi', model: 'gpt-6-luna', apiKey: 'test-secret' });
    assert.equal((await store.get()).model, 'gpt-6-luna');
  });
  await assert.rejects(createSettingsStore({ env: { VISION_PROVIDER: 'toString' } }).get(), SettingsError);
});
