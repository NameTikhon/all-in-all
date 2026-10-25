import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import { recognizeFrame, validateImage, VisionError } from './lib/vision.mjs';
import { createSettingsStore, SettingsError } from './lib/provider-settings.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(ROOT, 'web');
const MAX_BODY = 8_100_000;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function json(res, status, data) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readJson(req, limit = MAX_BODY) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new VisionError('Нужен Content-Type application/json.', 415);
  if (Number(req.headers['content-length']) > limit) throw new VisionError('Запрос слишком большой.', 413);
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw new VisionError('Запрос слишком большой.', 413);
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new VisionError('Не удалось прочитать JSON запроса.', 400); }
}

export function createAppServer({
  apiKey = '', model = '', provider = 'openai', fetchImpl = fetch, settingsPath = null, env = {},
  requiredCaptureVersion = '', minimumPaidIntervalMs = 0, maxCachedFrames = 64, now = Date.now,
} = {}) {
  if (typeof requiredCaptureVersion !== 'string' || requiredCaptureVersion.length > 32
    || !Number.isFinite(minimumPaidIntervalMs) || minimumPaidIntervalMs < 0
    || !Number.isInteger(maxCachedFrames) || maxCachedFrames < 1 || maxCachedFrames > 512
    || typeof now !== 'function') throw new TypeError('Некорректные настройки защиты запросов.');
  const settings = createSettingsStore({ apiKey, model, provider, settingsPath, env });
  let visionInFlight = false;
  let lastPaidStartAt = -Infinity;
  const frameCache = new Map();
  const imageCache = new Map();
  const hash = value => createHash('sha256').update(value).digest('hex');
  const scopedCacheKey = (config, identifier) => hash(JSON.stringify([
    config.provider, config.model, hash(config.apiKey), identifier,
  ]));
  function rememberResult(key, imageKey, result) {
    frameCache.delete(key);
    frameCache.set(key, result);
    while (frameCache.size > maxCachedFrames) frameCache.delete(frameCache.keys().next().value);
    // An independent bounded index prevents a caller's new capture nonce or
    // frame key from buying the very same screenshot again. Both indices share
    // result objects, including the bounded paid-read counter.
    imageCache.delete(imageKey);
    imageCache.set(imageKey, result);
    while (imageCache.size > maxCachedFrames) imageCache.delete(imageCache.keys().next().value);
  }
  function errorResult(error) {
    const expected = error instanceof VisionError || error instanceof SettingsError;
    return { status: expected ? error.status : 500,
      body: { error: expected ? error.message : 'Не удалось обработать запрос.' } };
  }
  const sendError = (res, error) => {
    const result = errorResult(error);
    if (!res.destroyed) json(res, result.status, result.body);
  };
  return http.createServer(async (req, res) => {
    const port = req.socket.localPort;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowedHosts.has(req.headers.host)) return json(res, 403, { error: 'Доступ разрешён только через localhost.' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Межсайтовые запросы запрещены.' });
    let url;
    try { url = new URL(req.url, `http://${req.headers.host}`); }
    catch { return json(res, 400, { error: 'Некорректный адрес.' }); }
    if (url.pathname === '/api/config' && req.method === 'GET') {
      try { return json(res, 200, settings.publicConfig(await settings.get())); }
      catch (error) { return sendError(res, error); }
    }
    if (url.pathname === '/api/settings' && req.method === 'POST') {
      if (req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'Настройки можно сохранить только из этого приложения.' });
      if (visionInFlight) return json(res, 409, { error: 'Остановите анализ и дождитесь текущего запроса перед сменой настроек.' });
      try {
        const body = await readJson(req, 16_000);
        return json(res, 200, await settings.save(body));
      } catch (error) { return sendError(res, error); }
    }
    if (url.pathname === '/api/vision' && req.method === 'POST') {
      const rejectUnpaid = (status, error) => json(res, status, { error, cached: false, upstreamRequested: false });
      if (req.headers.origin !== `http://${req.headers.host}`) return rejectUnpaid(403, 'Запрос распознавания должен поступать из этого приложения.');
      if (requiredCaptureVersion && req.headers['x-durak-capture-version'] !== requiredCaptureVersion) {
        return rejectUnpaid(503, 'Обновите страницу приложения: старый клиент остановлен, чтобы не тратить средства на лишние кадры.');
      }
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      let acquired = false;
      let upstreamRequested = false;
      let cacheKey;
      let imageKey;
      let cacheEntry = null;
      let retryAttempt = 0;
      try {
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some(key => !['image', 'frameKey', 'confirmation', 'retryAttempt'].includes(key))
          || (Object.hasOwn(body, 'frameKey') && (typeof body.frameKey !== 'string'
            || !body.frameKey.length || body.frameKey.length > 160 || /[\x00-\x1f\x7f]/.test(body.frameKey)))
          || (Object.hasOwn(body, 'confirmation') && typeof body.confirmation !== 'boolean')
          || (Object.hasOwn(body, 'retryAttempt') && (!Number.isInteger(body.retryAttempt)
            || body.retryAttempt < 0 || body.retryAttempt > 2))) {
          throw new VisionError('Ожидается image, ключ frameKey до 160 символов, confirmation true/false и номер retryAttempt от 0 до 2.', 400);
        }
        validateImage(body.image);
        const config = await settings.get();
        if (!config.apiKey || !config.model) throw new VisionError(`Для распознавания заполните настройки ${config.definition.label} в приложении или файле .env.`, 503);
        imageKey = scopedCacheKey(config, `image:${hash(body.image)}`);
        cacheKey = body.frameKey ? scopedCacheKey(config, `frame:${body.frameKey}`) : imageKey;
        const cached = frameCache.get(cacheKey) || imageCache.get(imageKey);
        cacheEntry = cached || null;
        retryAttempt = Object.hasOwn(body, 'retryAttempt') ? body.retryAttempt
          : cached && body.confirmation === true ? 1 : 0;
        // Retry ordinals are idempotency tokens. An old ordinal always returns
        // the latest cached response, including errors, without another charge.
        // A noisy image or a fresh capture key cannot reset shared attempts.
        if (cached && retryAttempt < cached.reads) {
          rememberResult(cacheKey, imageKey, cached);
          if (!res.destroyed) json(res, cached.status, { ...cached.body, cached: true, upstreamRequested: false });
          return;
        }
        // The browser may abort an ordinal before HTTP reaches this process.
        // Allow skipped ordinals: consuming their slots can only reduce the
        // maximum of three paid reads, while rejecting them would strand Pause.
        if (visionInFlight) return rejectUnpaid(429, 'Дождитесь текущего распознавания.');
        if (now() - lastPaidStartAt < minimumPaidIntervalMs) {
          return rejectUnpaid(429, 'Слишком частые запросы: подождите перед отправкой нового кадра. Предыдущая позиция сохранена.');
        }
        visionInFlight = true;
        acquired = true;
        const observation = await recognizeFrame({
          image: body.image, apiKey: config.apiKey, model: config.model, provider: config.provider,
          retryAttempt,
          fetchImpl: (...args) => {
            // This is the only path that can spend provider credits. Neither
            // validation failures nor cache hits consume a request allowance.
            upstreamRequested = true;
            lastPaidStartAt = now();
            cacheEntry ||= { reads: 0 };
            cacheEntry.reads = retryAttempt + 1;
            return fetchImpl(...args);
          },
          signal: controller.signal,
        });
        const result = Object.assign(cacheEntry || {}, { status: 200, body: { observation } });
        if (upstreamRequested) rememberResult(cacheKey, imageKey, result);
        if (!res.destroyed) json(res, 200, { ...result.body, cached: false, upstreamRequested });
      } catch (error) {
        const result = errorResult(error);
        if (upstreamRequested && cacheKey) rememberResult(cacheKey, imageKey, Object.assign(cacheEntry || {}, result));
        if (!res.destroyed) json(res, result.status, { ...result.body, cached: false, upstreamRequested });
      } finally { if (acquired) visionInFlight = false; }
      return;
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Такого API нет.' });
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Метод не поддерживается.' });
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: 'Некорректный путь.' }); }
    if (pathname.includes('\\') || pathname.includes('\0')) return json(res, 404, { error: 'Файл не найден.' });
    const filename = path.resolve(WEB, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(WEB, filename);
    const extension = path.extname(filename);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !MIME[extension]) return json(res, 404, { error: 'Файл не найден.' });
    try {
      const bytes = await readFile(filename);
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[extension], 'Content-Length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { json(res, 404, { error: 'Файл не найден.' }); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const envPath = path.join(ROOT, '.env');
  let fileEnv = {};
  try { fileEnv = parseEnv(await readFile(envPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') { console.error('Не удалось прочитать .env. Проверьте формат файла.'); process.exit(1); }
  }
  const port = Number(fileEnv.PORT || process.env.PORT || 8765);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error('PORT должен быть целым числом от 1024 до 65535.'); process.exit(1);
  }
  const app = createAppServer({
    provider: 'genapi', settingsPath: envPath, env: { ...process.env },
    requiredCaptureVersion: '3', minimumPaidIntervalMs: 5000,
  });
  app.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Порт ${port} занят. Остановите другую копию или измените PORT в .env.` : 'Не удалось запустить локальный сервер.');
    process.exitCode = 1;
  });
  app.listen(port, '127.0.0.1', () => {
    console.log(`ALL IN ALL — http://127.0.0.1:${port}`);
    console.log('Переводной Дурак · 36 карт · 1 на 1');
    console.log('Остановка: Ctrl+C');
  });
}
