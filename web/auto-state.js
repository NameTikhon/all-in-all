import { beats, validateState } from './durak.js';

const CARD = /^(6|7|8|9|10|J|Q|K|A)[CDHS]$/;
const SUITS = new Set(['C', 'D', 'H', 'S']);
const CONFIDENCE_NOTE = 'Уверенность «high» указана самой моделью; это не измеренная точность распознавания. Позиция дополнительно проверена по правилам и памяти карт.';
const cardsOnTable = (table) => table.flatMap(({ attack, defense }) => defense === null ? [attack] : [attack, defense]);
const difference = (left, right) => left.filter((card) => !right.includes(card));
const unique = (cards) => [...new Set(cards)];
const rank = (card) => card.slice(0, -1);
const cloneState = (state) => ({ ...state, hand: [...state.hand], table: state.table.map((pair) => ({ ...pair })), discard: [...state.discard], knownOpponent: [...state.knownOpponent] });
const review = (...reasons) => ({ status: 'review', state: null, reasons: reasons.flat(), events: [] });
const canonicalTable = (table) => Array.isArray(table)
  ? table.map((pair) => pair && typeof pair === 'object' ? { attack: pair.attack, defense: pair.defense ?? null } : pair)
    .sort((left, right) => String(left?.attack).localeCompare(String(right?.attack)))
  : null;

/** Card order and descriptive notes do not constitute a new observed position. */
export function observationFingerprint(observation) {
  const value = observation && typeof observation === 'object' ? observation : {};
  return JSON.stringify({
    hand: Array.isArray(value.hand) ? [...value.hand].sort() : null,
    table: canonicalTable(value.table),
    trumpSuit: value.trumpSuit ?? null,
    trumpCard: value.trumpCard ?? null,
    opponentCount: value.opponentCount ?? null,
    stockCount: value.stockCount ?? null,
    role: value.role ?? null,
  });
}

function stateFingerprint(state) {
  return JSON.stringify({ observation: observationFingerprint(state), discard: [...state.discard].sort(), knownOpponent: [...state.knownOpponent].sort(), attackLimit: state.attackLimit, allowTransfer: state.allowTransfer });
}

function checkObservation(observation, previous) {
  const errors = [];
  if (!Array.isArray(observation.hand) || observation.hand.some((card) => !CARD.test(card))) errors.push('Не удалось полностью распознать вашу руку. Нужен кадр с открытыми картами.');
  if (!Array.isArray(observation.table) || observation.table.some((pair) => !pair || typeof pair !== 'object' || !CARD.test(pair.attack) || (pair.defense !== null && !CARD.test(pair.defense)))) errors.push('Не удалось полностью распознать стол и пары атаки / защиты.');
  if (!SUITS.has(observation.trumpSuit) && !(observation.trumpSuit == null && previous)) errors.push('Не удалось определить козырную масть.');
  if (observation.trumpCard != null && !CARD.test(observation.trumpCard)) errors.push('Не удалось распознать открытую козырную карту.');
  if (!Number.isInteger(observation.opponentCount) || observation.opponentCount < 0 || observation.opponentCount > 36) errors.push('Не видно точного количества карт соперника.');
  if (observation.stockCount != null && (!Number.isInteger(observation.stockCount) || observation.stockCount < 0 || observation.stockCount > 36)) errors.push('Количество карт в колоде распознано некорректно.');
  if (!['attack', 'defend'].includes(observation.role) && !(observation.role == null && previous)) errors.push('Не удалось определить, кто сейчас атакует.');
  return errors;
}

/** Recover a missed defense only when every missing own card covers one pending
 * attack. The identities of all discarded cards must already be known. */
function completedOwnDefense(previous, observation) {
  if (previous.role !== 'defend' || !previous.table.length || observation.table.length) return null;
  const pending = previous.table.filter((pair) => pair.defense === null);
  const lost = difference(previous.hand, observation.hand);
  if (!pending.length || lost.length !== pending.length
      || cardsOnTable(previous.table).some((card) => observation.hand.includes(card))) return null;
  const canCover = (index, remaining) => {
    if (index === pending.length) return true;
    return remaining.some((card, cardIndex) => beats(card, pending[index].attack, previous.trumpSuit)
      && canCover(index + 1, remaining.filter((_, index) => index !== cardIndex)));
  };
  if (!canCover(0, lost)) return null;

  const ownDraw = difference(observation.hand, previous.hand).length;
  const opponentDraw = observation.opponentCount - previous.opponentCount;
  const ownNeed = Math.max(0, 6 - (previous.hand.length - lost.length));
  const opponentNeed = Math.max(0, 6 - previous.opponentCount);
  if (opponentDraw < 0 || ownDraw > ownNeed || opponentDraw > opponentNeed
      || ownDraw + opponentDraw > previous.stockCount
      || (ownDraw > 0 && opponentDraw !== Math.min(previous.stockCount, opponentNeed))) return null;

  // A same-rank trump can also be a transfer. If a transfer followed by the
  // opponent picking up fits the visible counts, a hidden stock cannot decide
  // whether these cards went to discard or to the opponent's hand.
  if (previous.allowTransfer !== false && lost.length === 1
      && previous.table.every((pair) => pair.defense === null && rank(pair.attack) === rank(lost[0]))
      && previous.table.length + 1 <= Math.min(previous.attackLimit, previous.opponentCount)) {
    const pickedUpCount = cardsOnTable(previous.table).length + 1;
    const pickupOpponentDraw = observation.opponentCount - previous.opponentCount - pickedUpCount;
    const pickupDraw = ownDraw + pickupOpponentDraw;
    const stockAllowsPickup = observation.stockCount == null
      ? pickupDraw <= previous.stockCount
      : pickupDraw === previous.stockCount - observation.stockCount;
    if (pickupOpponentDraw >= 0 && stockAllowsPickup) return null;
  }
  return { cards: [...cardsOnTable(previous.table), ...lost], missingDefenses: lost };
}

function complete(state, previous, reasons, events) {
  const errors = validateState(state);
  if (errors.length) return review(errors);
  const unchanged = previous && stateFingerprint(state) === stateFingerprint(previous);
  return { status: unchanged ? 'unchanged' : 'accepted', state: cloneState(unchanged ? previous : state), reasons: [CONFIDENCE_NOTE, ...reasons], events: unchanged ? [] : events };
}

/**
 * With no earlier memory, a new-session frame may already contain the first
 * attack. Check whether the visible cards can all belong to the two original
 * six-card hands without a pickup, refill, or discarded bout. Table ordering
 * is irrelevant; transfers may change which player owns the attacking cards.
 * This proves consistency with an opening, not that no earlier game was missed.
 */
function reachableOpening(observation, allowTransfer, attackLimit) {
  const { hand, table, opponentCount, role, trumpSuit } = observation;
  const ownTarget = 6 - hand.length;
  const opponentTarget = 6 - opponentCount;
  if (ownTarget < 0 || opponentTarget < 0 || table.length > 6
      || ownTarget + opponentTarget !== cardsOnTable(table).length) return false;
  if (!table.length) return ownTarget === 0 && opponentTarget === 0;
  const allAttacks = (1 << table.length) - 1;
  const allDefenses = table.reduce((mask, pair, index) => pair.defense === null ? mask : mask | (1 << index), 0);
  const count = (mask) => { let total = 0; for (; mask; mask &= mask - 1) total++; return total; };
  const queue = [
    { attacks: 0, defenses: 0, attacker: true, ours: 0, limit: attackLimit },
    { attacks: 0, defenses: 0, attacker: false, ours: 0, limit: attackLimit },
  ];
  const seen = new Set();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const path = queue[cursor];
    const { attacks, defenses, attacker, ours, limit } = path;
    const played = count(attacks) + count(defenses);
    const theirs = played - ours;
    if (ours > ownTarget || theirs > opponentTarget) continue;
    const key = `${attacks}:${defenses}:${Number(attacker)}:${ours}:${limit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (attacks === allAttacks && defenses === allDefenses && attacker === (role === 'attack')) return true;
    const ranks = new Set();
    for (const [index, pair] of table.entries()) {
      if (attacks & (1 << index)) ranks.add(rank(pair.attack));
      if (defenses & (1 << index)) ranks.add(rank(pair.defense));
    }
    const pending = count(attacks) - count(defenses);
    const attackerRemaining = 6 - (attacker ? ours : theirs);
    const defenderRemaining = 6 - (attacker ? theirs : ours);
    for (const [index, pair] of table.entries()) {
      const bit = 1 << index;
      if (!(attacks & bit)) {
        if (attackerRemaining > 0 && count(attacks) < limit && pending < defenderRemaining
            && (!attacks || ranks.has(rank(pair.attack)))) {
          queue.push({ ...path, attacks: attacks | bit, ours: ours + Number(attacker) });
        }
        const sameRank = attacks && [...ranks].every((value) => value === rank(pair.attack));
        const receiverLimit = Math.min(attackLimit, attackerRemaining);
        if (allowTransfer && defenses === 0 && sameRank && defenderRemaining > 0
            && count(attacks) + 1 <= receiverLimit) {
          queue.push({ attacks: attacks | bit, defenses, attacker: !attacker, ours: ours + Number(!attacker), limit: receiverLimit });
        }
      } else if (!(defenses & bit) && pair.defense !== null && defenderRemaining > 0
          && beats(pair.defense, pair.attack, trumpSuit)) {
        queue.push({ ...path, defenses: defenses | bit, ours: ours + Number(!attacker) });
      }
    }
  }
  return false;
}

/**
 * Conservatively reconcile one complete, stable screen observation with memory.
 * Missing history is never assigned back to the unknown stock. Ambiguous or
 * incomplete frames leave the caller's last confirmed position untouched.
 */
export function reconcileObservation(previous, observation, { initial = false, allowTransfer = true, attackLimit = 6 } = {}) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return review('Распознавание не вернуло позицию игры.');
  if (!Number.isInteger(attackLimit) || attackLimit < 0 || attackLimit > 6) return review('Настройка лимита атаки должна быть целым числом от 0 до 6.');
  if (observation.confidence !== 'high') return review('Модель не уверена в распознавании. Дождитесь чёткого кадра или исправьте позицию вручную. Уверенность сообщает сама модель; это не измеренная точность.');
  const errors = checkObservation(observation, previous);
  if (errors.length) return review(errors);
  if (previous) {
    const previousErrors = validateState(previous);
    if (previousErrors.length) return review('Предыдущая позиция некорректна. Сначала исправьте её или начните новую партию.', previousErrors);
  }

  const reasons = [];
  const events = [];
  const recoveredDefense = previous ? completedOwnDefense(previous, observation) : null;
  let stockCount = observation.stockCount ?? null;
  if (stockCount === null && previous) {
    // Infer only from retained memory and the one observable table transition.
    // Every transition still passes all the history/ownership checks below.
    const clearedCoveredTable = previous.table.length > 0 && observation.table.length === 0 && (previous.table.every((pair) => pair.defense !== null) || recoveredDefense !== null);
    const discardCount = previous.discard.length + (clearedCoveredTable ? (recoveredDefense?.cards ?? cardsOnTable(previous.table)).length : 0);
    stockCount = 36 - observation.hand.length - cardsOnTable(observation.table).length - observation.opponentCount - discardCount;
    if (stockCount < 0 || stockCount > 36) return review('Счётчик колоды не виден, а расчёт остатка по сохранённой памяти даёт невозможное число карт. Проверьте распознавание.');
    reasons.push(`Счётчик колоды не виден. Остаток ${stockCount} вычислен из 36 карт по вашей руке, столу, числу карт соперника и сохранённому отбою${clearedCoveredTable ? ' с учётом полностью покрытого завершённого захода' : ''}. История перехода проверена отдельно.`);
  } else if (stockCount === null && initial && reachableOpening(observation, allowTransfer, attackLimit)) {
    stockCount = 24;
    reasons.push(observation.table.length === 0
      ? 'Начальная раздача: 6 карт у каждого, пустой стол, в колоде 24 карты, включая открытый козырь.'
      : 'Первый кадр новой сессии принят за первый заход: карты в руках и на столе согласуются с начальной раздачей по 6 карт и допустимыми ходами без добора, взятия или отбоя. В колоде 24 карты, включая открытый козырь. Это предположение о начале партии; по одному кадру нельзя исключить пропущенную историю.');
  }
  if (stockCount === null) return review('Не видно остатка колоды, а первый кадр не согласуется с начальной раздачей или первым заходом без добора. Нужен следующий чёткий кадр со счётчиком или сохранённая история партии.');
  const trumpSuit = observation.trumpSuit ?? previous?.trumpSuit;
  const state = {
    hand: [...observation.hand],
    table: observation.table.map((pair) => ({ attack: pair.attack, defense: pair.defense })),
    discard: previous ? [...previous.discard] : [],
    knownOpponent: previous ? [...previous.knownOpponent] : [],
    trumpSuit,
    trumpCard: observation.trumpCard ?? (previous?.trumpSuit === trumpSuit ? previous.trumpCard : null) ?? null,
    opponentCount: observation.opponentCount,
    stockCount,
    role: observation.role,
    attackLimit: previous?.attackLimit ?? attackLimit,
    allowTransfer: previous?.allowTransfer ?? allowTransfer,
  };

  if (!previous) {
    if (!initial) return review('Для первой позиции начните новую партию. История отбоя ещё неизвестна.');
    const accounted = state.hand.length + cardsOnTable(state.table).length + state.opponentCount + state.stockCount;
    if (accounted !== 36) return review(accounted < 36
      ? `Неизвестна история ${36 - accounted} карт. Начните наблюдение с раздачи или восстановите отбой вручную.`
      : `Количество карт не сходится: распознано ${accounted} вместо 36. Проверьте руку, стол и счётчики.`);
    const defendedCount = state.table.filter((pair) => pair.defense !== null).length;
    state.attackLimit = Math.min(attackLimit, (state.role === 'attack' ? state.opponentCount : state.hand.length) + defendedCount);
    if (state.stockCount === 0 && state.trumpCard && ![...state.hand, ...cardsOnTable(state.table)].includes(state.trumpCard)) state.knownOpponent = [state.trumpCard];
    return complete(state, null, reasons, ['Распознана начальная позиция; память новой партии создана.']);
  }

  if (state.trumpSuit !== previous.trumpSuit || (previous.trumpCard && observation.trumpCard && observation.trumpCard !== previous.trumpCard)) return review('Козырь изменился. Если началась новая партия, нажмите «Новая партия», чтобы явно очистить память.');
  if (state.stockCount > previous.stockCount) return review('Остаток колоды вырос. Возможна новая партия или ошибка распознавания; память автоматически не сбрасывается.');
  const beforeTable = cardsOnTable(previous.table);
  const afterTable = cardsOnTable(state.table);
  const visible = [...state.hand, ...afterTable];
  const resurrected = previous.discard.filter((card) => visible.includes(card));
  if (resurrected.length) return review(`Карты из отбоя снова появились в игре: ${resurrected.join(', ')}. Проверьте кадр или начните новую партию.`);
  const lostHand = difference(previous.hand, state.hand);
  const addedHand = difference(state.hand, previous.hand);
  const stockDraw = previous.stockCount - state.stockCount;

  if (state.role == null && observationFingerprint({ ...state, role: previous.role }) === observationFingerprint(previous)) {
    state.role = previous.role;
    reasons.push('Очередь хода не видна, но все карты и счётчики совпадают с сохранённой позицией; очередь сохранена.');
  }

  // A cleared table is the only point at which cards may leave visible play.
  if (previous.table.length && state.table.length === 0) {
    if (lostHand.length && !recoveredDefense) return review(`Пропущены ходы: карты вашей руки исчезли без подтверждённого покрытия всех атак: ${lostHand.join(', ')}. Дождитесь следующего чёткого кадра.`);
    const pickedUp = beforeTable.filter((card) => state.hand.includes(card));
    const covered = previous.table.every((pair) => pair.defense !== null) || recoveredDefense !== null;
    let opponentDraw;
    let ownDraw;
    let expectedRole;
    if (pickedUp.length === beforeTable.length && !covered && previous.role === 'defend') {
      ownDraw = addedHand.length - beforeTable.length;
      opponentDraw = state.opponentCount - previous.opponentCount;
      expectedRole = 'defend';
      events.push('Вы взяли карты со стола; карты добавлены в вашу руку.');
    } else if (pickedUp.length) {
      return review('Стол исчез, но переход всех его карт в одну руку не подтверждён. Дождитесь завершения анимации или исправьте позицию.');
    } else if (covered) {
      ownDraw = addedHand.length;
      opponentDraw = state.opponentCount - previous.opponentCount;
      expectedRole = previous.role === 'attack' ? 'defend' : 'attack';
      const discarded = recoveredDefense?.cards ?? beforeTable;
      state.discard = [...state.discard, ...discarded];
      if (recoveredDefense) events.push(`Восстановлено покрытие между кадрами: ${recoveredDefense.missingDefenses.join(', ')}. Все непокрытые атаки имеют подходящую карту защиты из вашей руки.`);
      events.push(`Полностью покрытый стол ушёл в отбой: ${discarded.join(', ')}.`);
    } else if (previous.role === 'attack') {
      ownDraw = addedHand.length;
      opponentDraw = state.opponentCount - previous.opponentCount - beforeTable.length;
      expectedRole = 'attack';
      if (opponentDraw < 0) return review('Стол исчез без покрытия, но прибавка карт соперника не подтверждает взятие. Возможно, пропущены ходы.');
      state.knownOpponent = unique([...state.knownOpponent, ...beforeTable]);
      events.push(`Соперник взял карты; запомнены: ${beforeTable.join(', ')}.`);
    } else {
      return review('Непокрытый стол исчез, но не все его карты видны в вашей руке. Исход захода неизвестен.');
    }
    if (ownDraw < 0 || opponentDraw < 0 || ownDraw + opponentDraw !== stockDraw) return review('После завершения захода не сходятся взятие и добор: изменение рук не совпадает с остатком колоды.');
    if (state.role == null) {
      state.role = expectedRole;
      reasons.push('Очередь атаки восстановлена по подтверждённому завершению захода.');
    } else if (state.role !== expectedRole) return review('После завершения захода не совпадает очередь атаки. Возможно, пропущен перевод или следующий ход.');
    const impossibleDraw = addedHand.filter((card) => !beforeTable.includes(card) && previous.knownOpponent.includes(card));
    if (impossibleDraw.length) return review(`Известные карты соперника появились в вашей руке без видимого хода: ${impossibleDraw.join(', ')}.`);
    state.attackLimit = Math.min(attackLimit, state.role === 'attack' ? state.opponentCount : state.hand.length);
  } else {
    if (state.role == null) return review('Не удалось определить, кто сейчас атакует. Изменение позиции не позволяет надёжно восстановить очередь.');
    const lostTable = difference(beforeTable, afterTable);
    if (lostTable.length) return review(`Пропущено завершение захода: со стола исчезли карты ${lostTable.join(', ')}. Память сохранена; подтвердите историю вручную.`);
    const unexplainedHand = lostHand.filter((card) => !afterTable.includes(card));
    if (unexplainedHand.length) return review(`Карты исчезли из вашей руки без видимого хода: ${unexplainedHand.join(', ')}. Они не возвращаются в неизвестную колоду.`);
    for (const pair of previous.table) {
      const current = state.table.find((entry) => entry.attack === pair.attack);
      if (!current || (pair.defense !== null && current.defense !== pair.defense)) return review('Изменились пары атаки и защиты на столе. Дождитесь чёткого кадра или исправьте пары вручную.');
    }
    const newTable = difference(afterTable, beforeTable);
    const ownPlayed = newTable.filter((card) => previous.hand.includes(card));
    const opponentPlayed = difference(newTable, ownPlayed);
    const opponentDraw = state.opponentCount - previous.opponentCount + opponentPlayed.length;
    if (opponentDraw < 0 || addedHand.length + opponentDraw !== stockDraw) return review('Не сходятся сыгранные карты и счётчики рук / колоды. Возможно, кадр снят во время анимации или пропущены ходы.');
    if (previous.table.length && (stockDraw || addedHand.length || opponentDraw)) return review('Во время незавершённого захода изменился добор из колоды. Возможно, пропущен конец захода; историю нужно подтвердить.');
    if (addedHand.some((card) => previous.knownOpponent.includes(card) || beforeTable.includes(card))) return review('Карта перешла в вашу руку без подтверждённого взятия со стола.');

    const roleChanged = state.role !== previous.role;
    if (roleChanged && state.table.length) {
      const newPairs = state.table.filter((pair) => !previous.table.some((old) => old.attack === pair.attack));
      const transfer = state.allowTransfer !== false && previous.table.length > 0 && newPairs.length > 0
        && previous.table.every((pair) => pair.defense === null) && state.table.every((pair) => pair.defense === null)
        && state.table.every((pair) => rank(pair.attack) === rank(previous.table[0].attack))
        && newPairs.every((pair) => previous.role === 'defend' ? previous.hand.includes(pair.attack) : !previous.hand.includes(pair.attack));
      if (!transfer) return review('Очередь хода изменилась без подтверждённого перевода или завершения захода.');
      state.attackLimit = Math.min(attackLimit, state.role === 'attack' ? previous.opponentCount : previous.hand.length);
      events.push('Распознан перевод; направление атаки и лимит обновлены.');
    } else if (roleChanged) {
      return review('Очередь хода изменилась при пустом столе без наблюдаемого завершения захода.');
    } else if (state.table.length) {
      const newPairs = state.table.filter((pair) => !previous.table.some((old) => old.attack === pair.attack));
      const newDefenses = state.table.filter((pair) => pair.defense !== null && !beforeTable.includes(pair.defense));
      if (newPairs.some((pair) => previous.hand.includes(pair.attack) !== (state.role === 'attack'))
        || newDefenses.some((pair) => previous.hand.includes(pair.defense) !== (state.role === 'defend'))) return review('Распознанная карта не соответствует руке игрока, который должен её сыграть. Возможно, пропущен перевод.');
      if (previous.table.length) {
        const availableRanks = new Set(beforeTable.map(rank));
        const pending = [...newPairs];
        // Pair order in vision JSON is irrelevant; process every legally reachable rank.
        for (const pair of state.table.filter((pair) => previous.table.some((old) => old.attack === pair.attack))) if (pair.defense) availableRanks.add(rank(pair.defense));
        let progress = true;
        while (pending.length && progress) {
          progress = false;
          for (let index = pending.length - 1; index >= 0; index--) {
            if (!availableRanks.has(rank(pending[index].attack))) continue;
            if (pending[index].defense) availableRanks.add(rank(pending[index].defense));
            pending.splice(index, 1); progress = true;
          }
        }
        if (pending.length) return review('Подкинутая карта не совпадает по достоинству с картами на столе. Проверьте распознавание.');
      }
    }
    state.knownOpponent = state.knownOpponent.filter((card) => !afterTable.includes(card));
    if (!state.table.length) state.attackLimit = Math.min(attackLimit, state.role === 'attack' ? state.opponentCount : state.hand.length);
    if (ownPlayed.length) events.push(`Ваши карты сыграны на стол: ${ownPlayed.join(', ')}.`);
    if (opponentPlayed.length) events.push(`Соперник сыграл: ${opponentPlayed.join(', ')}.`);
  }

  // The bottom trump is known metadata after drawing, and must remain in memory.
  if (previous.stockCount > 0 && state.stockCount === 0 && state.trumpCard && !state.hand.includes(state.trumpCard) && !afterTable.includes(state.trumpCard) && !state.discard.includes(state.trumpCard)) {
    state.knownOpponent = unique([...state.knownOpponent, state.trumpCard]);
    events.push('Колода закончилась; нижний козырь запомнен в руке соперника.');
  }
  if (stockDraw) events.push(`Из колоды добрали ${stockDraw} карт.`);
  return complete(state, previous, reasons, events);
}
