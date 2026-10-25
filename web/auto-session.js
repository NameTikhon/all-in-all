import { observationFingerprint, reconcileObservation } from './auto-state.js';
import { validateState } from './durak.js';

/**
 * Recognize a new deal without replacing existing memory on a single frame.
 * The caller must archive previous memory before committing newSession:true.
 * positionKey identifies the stable captured position, independently of model
 * prose or array order; changed frames start confirmation over.
 */
export function createAutoSession({ confirmations = 2 } = {}) {
  if (!Number.isInteger(confirmations) || confirmations < 2) throw new TypeError('Нужно не менее двух подтверждений новой партии.');
  let pending = null;
  const reset = () => { pending = null; };

  function reconcile(previous, observation, options = {}) {
    const { positionKey, ...stateOptions } = options;
    const normal = reconcileObservation(previous, observation, stateOptions);
    const withSession = (result, newSession = false, retryRequired = false) => ({ ...result, newSession, retryRequired });
    if (normal.status !== 'review' || !previous) {
      reset();
      return withSession(normal);
    }
    const hasStableKey = (typeof positionKey === 'string' && positionKey.length > 0)
      || (typeof positionKey === 'number' && Number.isFinite(positionKey));
    if (!hasStableKey || validateState(previous).length || observation?.confidence !== 'high'
        || (observation.stockCount != null && observation.stockCount !== 24)) {
      reset();
      return withSession(normal);
    }

    // Force the first-bout inference path, even when vision reported 24, so a
    // balanced but unreachable ownership/rank arrangement cannot reset memory.
    const opening = reconcileObservation(null, { ...observation, stockCount: null }, { ...stateOptions, initial: true });
    if (opening.status !== 'accepted' || opening.state.stockCount !== 24) {
      reset();
      return withSession(normal);
    }
    const trumpChanged = opening.state.trumpSuit !== previous.trumpSuit
      || (opening.state.trumpCard !== null && previous.trumpCard !== null && opening.state.trumpCard !== previous.trumpCard);
    if (!trumpChanged && previous.stockCount !== 0) {
      reset();
      return withSession(normal);
    }

    const candidateKey = observationFingerprint(opening.state);
    // Include the baseline: a caller switching saved sessions must not reuse a
    // confirmation gathered against another game's memory.
    const baselineKey = JSON.stringify({
      visible: observationFingerprint(previous),
      discard: [...previous.discard].sort(),
      knownOpponent: [...previous.knownOpponent].sort(),
    });
    if (pending?.positionKey === positionKey && pending.candidateKey === candidateKey && pending.baselineKey === baselineKey) {
      pending.count++;
    } else {
      pending = { positionKey, candidateKey, baselineKey, count: 1 };
    }
    if (pending.count < confirmations) {
      return withSession({
        ...normal,
        reasons: [`Проверяем начало новой партии: ${pending.count} из ${confirmations} подтверждений. Предыдущая память сохранена; повторно распознаём тот же стабильный кадр.`, ...normal.reasons],
      }, false, true);
    }
    reset();
    return withSession({
      ...opening,
      reasons: [`Новая партия подтверждена ${confirmations} распознаваниями одного стабильного кадра: ${trumpChanged ? 'изменился козырь' : 'после пустой колоды снова виден первый заход с полной колодой'}.`, ...opening.reasons],
      events: ['Автоматически обнаружена новая партия; прежнюю память следует сохранить в архив перед заменой.', ...opening.events],
    }, true);
  }

  return { reconcile, reset };
}
