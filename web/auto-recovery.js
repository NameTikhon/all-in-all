/**
 * Decide how to recover from an incomplete stable-frame observation without
 * discarding confirmed game memory or requiring a manual correction. This
 * module does not make requests: the monitor still owns serial execution,
 * request spacing, and the total paid-request budget.
 *
 * positionKey must identify the captured position, not the model response.
 * Similar successive frame signatures must keep the same key, including while
 * an automatic retry is pending. A changing JSON answer cannot reset a limit.
 */
export function createAutoRecovery({
  maxRetriesPerPosition = 2, maxRequiredConfirmationRetries = 1, maxRememberedPositions = 64,
} = {}) {
  if (!Number.isInteger(maxRetriesPerPosition) || maxRetriesPerPosition < 0 || maxRetriesPerPosition > 2) {
    throw new RangeError('Число повторов кадра должно быть целым от 0 до 2.');
  }
  if (!Number.isInteger(maxRequiredConfirmationRetries) || maxRequiredConfirmationRetries < 0 || maxRequiredConfirmationRetries > 2) {
    throw new RangeError('Число подтверждений новой партии должно быть целым от 0 до 2.');
  }
  if (!Number.isInteger(maxRememberedPositions) || maxRememberedPositions < 1 || maxRememberedPositions > 512) {
    throw new RangeError('Неверный размер памяти автоматических повторов.');
  }

  const positions = new Map();

  function observe(result, { positionKey } = {}) {
    const validKey = (typeof positionKey === 'string' && positionKey.length > 0 && positionKey.length <= 256)
      || (Number.isSafeInteger(positionKey) && positionKey >= 0);
    if (!validKey) throw new TypeError('Для повтора нужен постоянный ключ позиции кадра.');

    const entry = positions.get(positionKey) ?? { retries: 0, resolved: false };
    // Keep a small least-recently-used ledger, with no screenshots or cards.
    positions.delete(positionKey);
    positions.set(positionKey, entry);
    while (positions.size > maxRememberedPositions) positions.delete(positions.keys().next().value);

    const reasons = Array.isArray(result?.reasons)
      ? result.reasons.filter(reason => typeof reason === 'string')
      : [];
    // A stable but incomplete read gets a small fixed allowance. Identity is
    // based on local pixels, so changing model answers cannot replenish it.
    const allowedRetries = Math.max(maxRetriesPerPosition,
      result?.retryRequired === true ? maxRequiredConfirmationRetries : 0);
    if (result?.status === 'accepted' || result?.status === 'unchanged') {
      entry.resolved = true;
      return {
        action: 'accept', retry: false,
        message: result.status === 'accepted'
          ? 'Позиция обновлена. Следим за следующим ходом.'
          : 'Карты и счётчики не изменились.',
        reasons, retriesUsed: entry.retries,
        retriesRemaining: Math.max(0, allowedRetries - entry.retries),
      };
    }

    const retry = !entry.resolved && entry.retries < allowedRetries;
    if (retry) entry.retries += 1;
    return {
      action: retry ? 'retry' : 'wait', retry,
      message: retry
        ? result?.retryRequired === true
          ? 'Автоматически подтверждаем начало новой партии.'
          : 'Кадр прочитан не полностью. Автоматически проверяем его ещё раз.'
        : 'Не удалось полностью прочитать кадр после трёх попыток. Следим за изменением карт; лишних повторов нет.',
      reasons,
      retriesUsed: entry.retries,
      retriesRemaining: Math.max(0, allowedRetries - entry.retries),
    };
  }

  return { observe, reset: () => positions.clear() };
}
