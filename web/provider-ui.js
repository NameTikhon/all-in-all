const PROVIDERS = {
  genapi: { label: 'GenAPI', key: 'GENAPI_API_KEY', model: 'GENAPI_MODEL' },
  openai: { label: 'OpenAI', key: 'OPENAI_API_KEY', model: 'OPENAI_MODEL' },
};

// Keep only the public fields returned by our local settings endpoint.
function publicConfig(value) {
  if (!value || !Object.hasOwn(PROVIDERS, value.provider)
      || typeof value.visionConfigured !== 'boolean'
      || typeof value.keyConfigured !== 'boolean'
      || (value.model !== null && typeof value.model !== 'string')) {
    throw new Error('Не удалось прочитать сохранённые настройки.');
  }
  return {
    provider: value.provider,
    providerLabel: PROVIDERS[value.provider].label,
    model: value.model,
    visionConfigured: value.visionConfigured,
    keyConfigured: value.keyConfigured,
    missingConfiguration: Array.isArray(value.missingConfiguration)
      ? value.missingConfiguration.filter(item => ['GENAPI_API_KEY', 'GENAPI_MODEL', 'OPENAI_API_KEY', 'OPENAI_MODEL'].includes(item))
      : [],
    envFile: '.env',
    canSaveSettings: value.canSaveSettings === true,
  };
}

function saveError(status) {
  status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  const messages = {
    400: 'Проверьте название модели и API-ключ: они должны быть без пробелов и переносов строк.',
    403: 'Сохранение доступно только из локального приложения. Откройте его и повторите.',
    409: 'Остановите анализ и дождитесь завершения текущего запроса перед сменой настроек.',
    429: 'Настройки уже сохраняются. Подождите и повторите.',
    503: 'Не удалось сохранить .env. Проверьте доступ к папке приложения.',
  };
  const error = new Error(messages[status] || 'Не удалось сохранить настройки. Проверьте, что локальный сервер запущен.');
  if (status) error.status = status;
  return error;
}

/** Credentials are sent only to the local server and never retained in UI state. */
export function setupProviderSettings({ getConfig, onConfig, onError = () => {} }) {
  const element = id => {
    const found = document.getElementById(`settings-${id}`);
    if (!found) throw new Error('Не удалось открыть интерфейс настроек ИИ.');
    return found;
  };
  const dialog = element('dialog');
  const form = element('form');
  const provider = element('provider');
  const model = element('model');
  const key = element('key');
  const keyState = element('key-state');
  const status = element('status');
  const saveButton = element('save');
  let config = null;
  let saving = false;
  let generation = 0;

  function clearKey() { key.value = ''; }

  function showStatus(text, error = false) {
    status.textContent = text;
    status.hidden = !text;
    status.classList.toggle('error', error);
    status.classList.toggle('success', Boolean(text) && !error);
  }

  function updateControls() {
    const disabled = saving || !config?.canSaveSettings;
    provider.disabled = disabled;
    model.disabled = disabled;
    key.disabled = disabled;
    saveButton.disabled = disabled;
    saveButton.textContent = saving ? 'Сохраняем…' : 'Сохранить подключение';
    form.setAttribute('aria-busy', String(saving));
  }

  function updateKeyState() {
    const definition = PROVIDERS[provider.value] || PROVIDERS.genapi;
    if (!config?.canSaveSettings) {
      keyState.textContent = `В этом запуске сохранение через интерфейс недоступно. Укажите в .env: VISION_PROVIDER=${provider.value}, ${definition.model}=${model.value || 'gpt-6-luna'}, ${definition.key}=ваш_ключ. Затем перезапустите приложение.`;
    } else if (provider.value === config.provider) {
      keyState.textContent = config.keyConfigured
        ? `Ключ ${definition.label} уже сохранён. Оставьте поле пустым, чтобы использовать его.`
        : `Ключ ${definition.label} ещё не указан. Вставьте его в поле «API-ключ».`;
    } else {
      keyState.textContent = `Вставьте ключ ${definition.label}. Пустое поле сохранит ключ этого провайдера, если он уже есть в .env.`;
    }
  }

  async function reportError(error) {
    try { await onError(error); } catch { /* Presentation errors must not retain credentials. */ }
  }

  async function open() {
    if (dialog.open) return;
    const token = ++generation;
    clearKey();
    showStatus('');
    try {
      const current = await getConfig();
      if (token !== generation) return;
      config = current && Object.hasOwn(PROVIDERS, current.provider) ? {
        provider: current.provider,
        model: typeof current.model === 'string' ? current.model : null,
        keyConfigured: current.keyConfigured === true,
        canSaveSettings: current.canSaveSettings === true,
      } : {
        provider: 'genapi', model: 'gpt-6-luna', keyConfigured: false, canSaveSettings: false,
      };
      provider.value = config.provider;
      model.value = config.model || 'gpt-6-luna';
      updateControls();
      updateKeyState();
      dialog.showModal();
      if (!saving && config.canSaveSettings && !config.keyConfigured) key.focus();
    } catch {
      const error = new Error('Не удалось открыть настройки. Проверьте, что локальный сервер запущен.');
      await reportError(error);
    }
  }

  function close() {
    generation += 1;
    clearKey();
    if (dialog.open) dialog.close();
  }

  async function save() {
    if (saving || !config?.canSaveSettings) {
      updateKeyState();
      return;
    }
    if (!form.reportValidity()) return;
    saving = true;
    updateControls();
    showStatus('');
    let saved = false;
    try {
      const request = fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: provider.value, model: model.value.trim(), apiKey: key.value.trim() }),
      });
      // The browser no longer needs the credential once the request is sent.
      clearKey();
      const response = await request;
      if (!response.ok) throw saveError(response.status);
      let next;
      try { next = publicConfig(await response.json()); }
      catch { throw saveError(); }
      config = next;
      saved = true;
      updateKeyState();
      await onConfig(next);
      showStatus(next.visionConfigured
        ? 'Подключение сохранено. Можно запускать автоанализ.'
        : 'Настройки сохранены. Добавьте API-ключ, чтобы включить анализ.');
    } catch (cause) {
      // Provider response bodies and arbitrary exception messages may contain a
      // credential. Only fixed local messages are presented or passed onward.
      const error = saved
        ? new Error('Настройки сохранены. Перезагрузите страницу, чтобы обновить подключение.')
        : saveError(cause?.status);
      showStatus(error.message, true);
      await reportError(error);
    } finally {
      clearKey();
      saving = false;
      updateControls();
    }
  }

  element('button').addEventListener('click', () => { void open(); });
  element('cancel').addEventListener('click', close);
  element('close').addEventListener('click', close);
  dialog.addEventListener('close', clearKey);
  dialog.addEventListener('cancel', clearKey);
  provider.addEventListener('change', () => {
    clearKey();
    model.value = 'gpt-6-luna';
    showStatus('');
    updateKeyState();
  });
  form.addEventListener('submit', event => { event.preventDefault(); void save(); });

  return { open, close };
}
