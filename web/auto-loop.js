/** Compare a whole frame and overlapping local regions of a 64 × 36 thumbnail. */
export function signaturesChanged(left, right, changeThreshold = 0.018) {
  if (!left?.length || !right?.length || left.length !== right.length) return true;
  const localDifferences = left.length === 64 * 36 ? new Uint8Array(left.length) : null;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = Math.abs(left[index] - right[index]);
    difference += delta;
    if (localDifferences) localDifferences[index] = delta;
  }
  if (difference / (left.length * 255) > changeThreshold) return true;
  if (!localDifferences) return false;

  // A card corner can occupy well below 1% of a shared window. A global mean
  // dilutes it, so also compare 8 × 6 tiles with half-tile overlap. At least
  // four visibly different pixels exclude isolated pixel/cursor noise.
  const localThreshold = Math.max(0.04, changeThreshold * 2);
  for (let top = 0; top <= 30; top += 3) {
    for (let start = 0; start <= 56; start += 4) {
      let localTotal = 0;
      let significantPixels = 0;
      for (let row = top; row < top + 6; row += 1) {
        for (let column = start; column < start + 8; column += 1) {
          const delta = localDifferences[row * 64 + column];
          localTotal += delta;
          if (delta >= 16) significantPixels += 1;
        }
      }
      if (significantPixels >= 4 && localTotal / (48 * 255) > localThreshold) return true;
    }
  }
  return false;
}

let frameSequence = 0;

/**
 * Serial screen sampling and recognition. A session is one explicit start(); its
 * paid request budget resets on restart, while attempted position signatures
 * and the interval between paid starts survive restarts. Only small grayscale
 * signatures and parsed observations are remembered, never screenshot images.
 * Pass the same frameMemory array to replacement monitors after option changes.
 */
export function createAutoMonitor({
  capture,
  recognize,
  onResult,
  onStatus = () => {},
  onError = () => {},
  intervalMs = 900,
  minRequestIntervalMs = 5000,
  stableSamples = 2,
  changeThreshold = 0.018,
  maxRequests = 60,
  maxObservationRetries = 2,
  maxRememberedFrames = 64,
  frameMemory = [],
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
}) {
  if (![capture, recognize, onResult, onStatus, onError, setTimer, clearTimer, now]
    .every(value => typeof value === 'function')) {
    throw new TypeError('Не заданы функции наблюдения за окном.');
  }
  if (!(intervalMs > 0) || !(minRequestIntervalMs >= 0)
      || !Number.isInteger(stableSamples) || stableSamples < 1
      || !Number.isInteger(maxRequests) || maxRequests < 1
      || !Number.isInteger(maxObservationRetries) || maxObservationRetries < 0 || maxObservationRetries > 2
      || !Number.isInteger(maxRememberedFrames) || maxRememberedFrames < 1 || maxRememberedFrames > 512
      || !Array.isArray(frameMemory)
      || !(changeThreshold >= 0 && changeThreshold <= 1)) {
    throw new RangeError('Неверные параметры наблюдения за окном.');
  }

  let generation = 0;
  let running = false;
  let busy = false;
  let timer = null;
  let controller = null;
  let requests = 0;
  let phase = 'idle';
  let message = 'Автоматический анализ выключен.';
  let lastRequestAt = -Infinity;
  let previousSignature = null;
  let stableCount = 0;
  let consecutiveErrors = 0;
  let positionKey = null;
  let observationRetries = 0;
  let retryPending = false;
  let incompleteMessage = null;
  let appliedPositionKey = null;

  const isCurrent = token => running && token === generation;
  const getState = () => ({ running, phase, requests, message });

  function status(nextPhase, nextMessage) {
    phase = nextPhase;
    message = nextMessage;
    // A presentation callback must not strand the capture scheduler.
    try { onStatus({ phase, requests, message }); } catch { /* UI owns its errors. */ }
  }

  const changed = (left, right) => signaturesChanged(left, right, changeThreshold);

  function rememberedFrame(signature) {
    return frameMemory.find(entry => entry?.signature instanceof Uint8Array
      && !changed(signature, entry.signature));
  }

  function rememberFrame(signature) {
    const entry = {
      key: `frame:${++frameSequence}`,
      signature: new Uint8Array(signature), retries: 0, message: null,
    };
    frameMemory.push(entry);
    while (frameMemory.length > maxRememberedFrames) frameMemory.shift();
    return entry;
  }

  async function readFrame() {
    const frame = await capture();
    if (typeof frame?.image !== 'string' || !frame.image
        || !(frame.signature instanceof Uint8Array) || !frame.signature.length) {
      throw new Error('Не удалось получить кадр выбранного окна.');
    }
    // Capture implementations may reuse their pixel buffer on the next sample.
    return { image: frame.image, signature: new Uint8Array(frame.signature) };
  }

  function schedule(token, delay) {
    if (!isCurrent(token) || timer !== null || busy) return;
    timer = setTimer(() => {
      timer = null;
      return sample(token);
    }, delay);
  }

  function reachLimit() {
    running = false;
    status('limit', `Лимит сеанса: ${maxRequests} запросов. Анализ приостановлен.`);
  }

  async function sample(token) {
    if (!isCurrent(token) || busy) return;
    busy = true;
    let delay = intervalMs;
    let requestController = null;
    let requestedEntry = null;
    try {
      const frame = await readFrame();
      if (!isCurrent(token)) return;

      stableCount = changed(frame.signature, previousSignature) ? 1 : stableCount + 1;
      previousSignature = frame.signature;
      if (stableCount < stableSamples) {
        status('stabilizing', 'Ждём, пока карты перестанут двигаться.');
        return;
      }
      let entry = rememberedFrame(frame.signature);
      const newPosition = !entry;
      if (retryPending && entry?.key !== positionKey) {
        retryPending = false;
        incompleteMessage = null;
      }
      // Pause may abort an already paid read before any response arrives. Keep
      // its ordinal rather than treating the blank ledger entry as resolved.
      if (entry?.missingResponse && entry.retries < maxObservationRetries && !retryPending) {
        positionKey = entry.key;
        retryPending = true;
        incompleteMessage = 'Предыдущий запрос был прерван. Продолжаем с оставшейся попытки.';
        entry.message = incompleteMessage;
      }
      const retryThisPosition = retryPending && entry?.key === positionKey;
      if (!newPosition && !retryThisPosition) {
        // Returning to a previously read scene must restore its visible advice.
        // Only apply once per visit; repeated samples of unchanged pixels are free.
        if (entry.observation && appliedPositionKey !== entry.key) {
          const decision = await onResult(structuredClone(entry.observation), {
            positionKey: entry.key, requestNumber: requests, cached: true,
            retryAttempt: entry.retries,
          });
          if (!isCurrent(token)) return;
          appliedPositionKey = entry.key;
          const wantsRetry = decision?.retry === true || decision?.action === 'retry';
          if (wantsRetry && entry.retries < maxObservationRetries) {
            positionKey = entry.key;
            observationRetries = entry.retries;
            retryPending = true;
            incompleteMessage = decision.message || 'Автоматически перепроверяем неполный кадр.';
            entry.message = incompleteMessage;
            status('retrying', incompleteMessage);
            return;
          }
          entry.message = decision?.action === 'wait' ? decision.message : null;
        }
        const waitingMessage = entry.message;
        status(waitingMessage ? 'observing' : 'unchanged', waitingMessage || 'Эта позиция уже проверена. Новых запросов нет.');
        return;
      }

      const remaining = minRequestIntervalMs - (now() - lastRequestAt);
      if (remaining > 0) {
        delay = Math.min(intervalMs, remaining);
        status(retryThisPosition ? 'retrying' : 'watching', retryThisPosition
          ? incompleteMessage || 'Автоматически проверим неполный кадр ещё раз после паузы между запросами.'
          : 'Позиция изменилась. Ждём следующего анализа.');
        return;
      }
      if (requests >= maxRequests) {
        reachLimit();
        return;
      }

      if (newPosition) {
        entry = rememberFrame(frame.signature);
      } else {
        entry.retries += 1;
      }
      positionKey = entry.key;
      observationRetries = entry.retries;
      retryPending = false;
      incompleteMessage = null;
      // Both incomplete reads and transient transport errors may use the same
      // bounded allowance. The frame key and ordinal make retries idempotent.
      requests += 1;
      lastRequestAt = now();
      requestController = new AbortController();
      controller = requestController;
      requestedEntry = entry;
      entry.missingResponse = true;
      status('recognizing', 'Распознаём карты в выбранном окне…');
      const observation = await recognize(frame.image, {
        signal: requestController.signal, positionKey,
        requestNumber: requests, confirmation: observationRetries > 0,
        retryAttempt: observationRetries,
      });
      // A response which arrives after Pause is useful as a local cache entry,
      // but may only be applied after the scene is sampled and checked again.
      entry.observation = structuredClone(observation);
      entry.missingResponse = false;
      if (!isCurrent(token)) return;

      const current = await readFrame();
      if (!isCurrent(token)) return;
      previousSignature = current.signature;
      consecutiveErrors = 0;
      if (changed(frame.signature, current.signature)) {
        stableCount = 1;
        status('stale', 'Карты изменились во время анализа. Ждём новый кадр.');
      } else {
        stableCount = Math.max(stableCount, stableSamples);
        const decision = await onResult(observation, {
          positionKey, requestNumber: requests, retryAttempt: observationRetries, cached: false,
        });
        if (!isCurrent(token)) return;
        appliedPositionKey = positionKey;
        const wantsRetry = decision?.retry === true || decision?.action === 'retry';
        if (wantsRetry && observationRetries < maxObservationRetries) {
          retryPending = true;
          incompleteMessage = decision?.message || 'Кадр прочитан не полностью. Автоматически проверяем его ещё раз.';
          entry.message = incompleteMessage;
          status('retrying', incompleteMessage);
        } else if (wantsRetry || decision?.action === 'wait') {
          incompleteMessage = !wantsRetry && decision?.message
            ? decision.message
            : 'Пока не удалось надёжно прочитать позицию. Продолжаем наблюдение и проверим следующий изменившийся кадр.';
          entry.message = incompleteMessage;
          status('observing', incompleteMessage);
        } else {
          entry.message = null;
          status('watching', decision?.message || 'Позиция распознана. Следим за следующим ходом.');
        }
      }
      if (requests >= maxRequests) reachLimit();
    } catch (error) {
      if (!isCurrent(token)) return;
      if(error?.localOnly===true) {
        status('locating',error.message||'Ищем игровой стол локально. Платных запросов нет.');
        return;
      }
      consecutiveErrors += 1;
      const code = Number(error?.status ?? error?.statusCode);
      const fatal = [401, 402, 403, 429, 503].includes(code) || consecutiveErrors >= 3;
      if (fatal && requestedEntry) requestedEntry.missingResponse = false;
      delay = Math.max(3000, intervalMs * 3);
      // Consumers refresh their start/pause controls inside these callbacks.
      // Publish the stopped state before telling them about a fatal error.
      if (fatal) running = false;
      const failedEntry = frameMemory.find(entry => entry.key === positionKey);
      if (!fatal && failedEntry && failedEntry.retries < maxObservationRetries) {
        retryPending = true;
        incompleteMessage = 'Временная ошибка соединения. Автоматически повторим запрос после паузы.';
        failedEntry.message = incompleteMessage;
      }
      status('error', fatal
        ? 'Анализ остановлен. Проверьте подключение и настройки API.'
        : incompleteMessage || 'Не удалось обработать кадр. Ждём изменения позиции.');
      try { await onError(error, { fatal }); } catch { /* UI owns its errors. */ }
      if (!isCurrent(token)) return;
      if (requests >= maxRequests) reachLimit();
    } finally {
      if (controller === requestController) controller = null;
      busy = false;
      // stop()/start() may have replaced this session while an aborted request
      // or an asynchronous UI callback was still settling. Never overlap it.
      if (running) schedule(generation, token === generation ? delay : 0);
    }
  }

  function start() {
    if (running) return getState();
    generation += 1;
    running = true;
    requests = 0;
    previousSignature = null;
    stableCount = 0;
    consecutiveErrors = 0;
    positionKey = null;
    observationRetries = 0;
    retryPending = false;
    incompleteMessage = null;
    appliedPositionKey = null;
    status('watching', 'Следим за выбранным окном.');
    schedule(generation, 0);
    return getState();
  }

  function stop() {
    running = false;
    generation += 1;
    if (timer !== null) clearTimer(timer);
    timer = null;
    controller?.abort();
    status('idle', 'Автоматический анализ выключен.');
    return getState();
  }

  // A new capture source or an explicitly started game may reuse the same
  // pixels with different meaning. Ordinary Pause/Start must not clear this.
  function resetFrames() {
    frameMemory.length = 0;
    positionKey = null;
    observationRetries = 0;
    retryPending = false;
    incompleteMessage = null;
    appliedPositionKey = null;
    previousSignature = null;
    stableCount = 0;
  }

  return { start, stop, getState, resetFrames };
}
