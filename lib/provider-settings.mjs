import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const PROVIDERS = {
  genapi: { label: 'GenAPI', keyVariable: 'GENAPI_API_KEY', modelVariable: 'GENAPI_MODEL', defaultModel: 'gpt-6-luna' },
  openai: { label: 'OpenAI', keyVariable: 'OPENAI_API_KEY', modelVariable: 'OPENAI_MODEL', defaultModel: '' },
};

export class SettingsError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function safeModel(model) {
  return typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model);
}

// This store never returns a credential through its publicConfig method.
export function createSettingsStore({ apiKey = '', model = '', provider = 'openai', settingsPath = null, env = {} } = {}) {
  let saving = false;
  async function source() {
    let text = '';
    if (settingsPath) {
      try { text = await readFile(settingsPath, 'utf8'); }
      catch (error) {
        if (error.code !== 'ENOENT') throw new SettingsError('Не удалось прочитать .env. Проверьте доступ к файлу.', 503);
      }
    }
    let values;
    try { values = { ...env, ...parseEnv(text) }; }
    catch { throw new SettingsError('Не удалось прочитать настройки .env. Проверьте формат файла.', 503); }
    return { text, values };
  }
  function resolve(values, requestedProvider) {
    const selected = requestedProvider || values.VISION_PROVIDER?.trim() ||
      (values.GENAPI_API_KEY || values.GENAPI_MODEL ? 'genapi' : values.OPENAI_API_KEY || values.OPENAI_MODEL ? 'openai' : provider);
    if (!Object.hasOwn(PROVIDERS, selected)) throw new SettingsError('VISION_PROVIDER должен быть genapi или openai.', 503);
    const definition = PROVIDERS[selected];
    const key = values[definition.keyVariable]?.trim() ?? (selected === provider ? apiKey : '');
    const selectedModel = values[definition.modelVariable]?.trim() || (selected === provider ? model : '') || definition.defaultModel;
    if (selectedModel && !safeModel(selectedModel)) throw new SettingsError('Некорректное название модели в .env.', 503);
    return { provider: selected, apiKey: key, model: selectedModel, definition };
  }
  function publicConfig(config) {
    const { apiKey: key, model: selectedModel, provider: selected, definition } = config;
    return {
      visionConfigured: Boolean(key && selectedModel), keyConfigured: Boolean(key),
      provider: selected, providerLabel: definition.label, model: selectedModel || null,
      missingConfiguration: [...(!key ? [definition.keyVariable] : []), ...(!selectedModel ? [definition.modelVariable] : [])],
      envFile: '.env', canSaveSettings: Boolean(settingsPath),
    };
  }
  return {
    async get() { return resolve((await source()).values); },
    publicConfig,
    async save(body) {
      if (!settingsPath) throw new SettingsError('Сохранение настроек недоступно в этом запуске сервера.', 503);
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !['provider', 'model', 'apiKey'].includes(key)) ||
        !Object.hasOwn(PROVIDERS, body.provider) || !safeModel(body.model) ||
        typeof body.apiKey !== 'string' || body.apiKey.length > 512 || /[\x00-\x1f\x7f]/.test(body.apiKey)) {
        throw new SettingsError('Укажите сервис, название модели и API-ключ без переносов строк.');
      }
      const key = body.apiKey.trim();
      if (key && !/^[A-Za-z0-9._-]+$/.test(key)) throw new SettingsError('API-ключ содержит недопустимые символы.');
      if (saving) throw new SettingsError('Дождитесь сохранения настроек.', 429);
      saving = true;
      try {
        const { text, values } = await source();
        const definition = PROVIDERS[body.provider];
        const existing = resolve({ ...values, [definition.modelVariable]: body.model }, body.provider);
        const updates = {
          VISION_PROVIDER: body.provider,
          [definition.modelVariable]: body.model,
          ...(key ? { [definition.keyVariable]: key } : {}),
        };
        // Preserve comments, unrelated settings and the other provider's key.
        const seen = new Set();
        const lines = text.split(/\r?\n/).map(line => {
          const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
          if (!match || !Object.hasOwn(updates, match[1])) return line;
          seen.add(match[1]);
          return `${match[1]}=${updates[match[1]]}`;
        });
        for (const [name, value] of Object.entries(updates)) if (!seen.has(name)) lines.push(`${name}=${value}`);
        try { await writeFile(settingsPath, lines.join('\n').replace(/\n*$/, '\n'), { encoding: 'utf8', mode: 0o600 }); }
        catch { throw new SettingsError('Не удалось сохранить .env. Проверьте доступ к папке приложения.', 503); }
        return publicConfig({ ...existing, apiKey: key || existing.apiKey, model: body.model });
      } finally { saving = false; }
    },
  };
}
