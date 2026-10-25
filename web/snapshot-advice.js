import { beats, cardLabel, RANKS } from './durak.js';

const CARD = /^(6|7|8|9|10|J|Q|K|A)[CDHS]$/;
const SUITS = new Set(['C', 'D', 'H', 'S']);
const rank = (card) => card.slice(0, -1);
const cardCost = (card, trumpSuit) => RANKS.indexOf(rank(card)) * 2 + (card.endsWith(trumpSuit) ? 16 : 0);
const score = (value) => Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
const review = (...reasons) => ({ status: 'review', state: null, analysis: null, reasons: reasons.flat(), events: [] });

/** Infer only visible, conserved changes between current scenes, never old saved memory. */
export function deriveSnapshotRole(previous, observation, { gameProfile = null } = {}) {
  // A turn guessed without an available action must not override a visible
  // pickup on this site. Explicit action buttons still take precedence.
  const candidate = gameProfile === 'hlop-singleplayer' && observation?.table?.length === 0
    && (!observation.action || observation.action === 'unknown')
    ? { ...observation, role: null } : observation;
  const temporal = deriveTemporalRole(previous, candidate);
  if (temporal !== candidate) return temporal;
  const sameDeal = previous?.historyComplete === false && previous.trumpSuit === observation?.trumpSuit
    && (!previous.trumpCard || !observation?.trumpCard || previous.trumpCard === observation.trumpCard);
  // In this specific single-player implementation the bot places its first
  // attack synchronously. With no related observed bout, a stable, dealt, empty
  // table establishes the human's opening turn despite the hidden action button.
  // Do not apply this convention to other sites or override explicit actions.
  // Verified against https://durak.hlop.de/assets/js/sp.js: gameInit,
  // compHod, showWorkCards, and clickCard (the latter has no transfer action).
  if (gameProfile === 'hlop-singleplayer' && !sameDeal && observation
      && observation.role == null && (!observation.action || observation.action === 'unknown')
      && ['high', 'medium'].includes(observation.confidence)
      && Array.isArray(observation.hand) && observation.hand.length > 0
      && observation.hand.every(card => typeof card === 'string' && CARD.test(card))
      && Array.isArray(observation.table) && observation.table.length === 0
      && Number.isInteger(observation.opponentCount) && observation.opponentCount > 0
      && SUITS.has(observation.trumpSuit)) {
    return { ...observation, role: 'attack', roleSource: 'hlop-singleplayer-empty-table' };
  }
  return observation;
}

function deriveTemporalRole(previous, observation) {
  if (!previous || previous.historyComplete !== false || !observation
      || ['attack','defend'].includes(observation.role)
      || ['attack','defend','finish','wait'].includes(observation.action)
      || previous.trumpSuit !== observation.trumpSuit
      || (previous.trumpCard && observation.trumpCard && previous.trumpCard !== observation.trumpCard)
      || !['attack','defend'].includes(previous.role)
      || !Array.isArray(previous.hand) || !Array.isArray(previous.table)
      || !Array.isArray(observation.hand) || !Array.isArray(observation.table)) return observation;
  const sameCards = (a,b) => a.length===b.length && a.every(card=>b.includes(card));
  const sameTable = (a,b) => a.length===b.length && a.every(pair=>b.some(other=>pair.attack===other.attack&&pair.defense===other.defense));
  const withRole = role => ({ ...observation, role,
    ...(role === 'defend' && observation.table.length === 0 ? { action: 'wait' } : {}),
  });
  if(sameCards(previous.hand,observation.hand)&&sameTable(previous.table,observation.table)
      &&previous.opponentCount===observation.opponentCount) return withRole(previous.role);
  if(observation.table.length || !previous.table.length) return observation;
  const oldTable=previous.table.flatMap(pair=>pair.defense?[pair.attack,pair.defense]:[pair.attack]);
  const lost=previous.hand.filter(card=>!observation.hand.includes(card));
  const pending=previous.table.filter(pair=>pair.defense===null);
  if (previous.role === 'defend' && pending.length && !lost.length
      && Number.isInteger(previous.opponentCount) && Number.isInteger(observation.opponentCount)
      && oldTable.every(card => observation.hand.includes(card))) {
    // The bot may throw extra matching cards after Take, before the next frame.
    // Test possible throw/draw counts without inventing those missing moves in
    // confirmed history. Every previously visible table card is now in our hand.
    const added = observation.hand.filter(card => !previous.hand.includes(card) && !oldTable.includes(card));
    const tableRanks = new Set(oldTable.map(rank));
    const maxThrows = Math.min(6 - previous.table.length, previous.opponentCount,
      added.filter(card => tableRanks.has(rank(card))).length);
    for (let thrown = 0; thrown <= maxThrows; thrown++) {
      const ownDraw = added.length - thrown;
      const ownNeed = Math.max(0, 6 - previous.hand.length - oldTable.length - thrown);
      const opponentBeforeDraw = previous.opponentCount - thrown;
      const opponentDraw = observation.opponentCount - opponentBeforeDraw;
      if (ownDraw < 0 || ownDraw > ownNeed || opponentDraw < 0
          || opponentDraw > Math.max(0, 6 - opponentBeforeDraw)) continue;
      const draws = ownDraw + opponentDraw;
      if (previous.stockCount != null && (draws > previous.stockCount
          || (observation.stockCount != null && draws !== previous.stockCount - observation.stockCount))) continue;
      return withRole('defend');
    }
    return observation;
  }
  if(observation.hand.some(card=>oldTable.includes(card))) return observation;
  const drawn=observation.hand.filter(card=>!previous.hand.includes(card));
  const refillFits=(before,after)=>Number.isInteger(before)&&Number.isInteger(after)&&after>=before&&after<=Math.max(6,before);
  if (previous.role === 'attack' && pending.length && !lost.length
      && refillFits(previous.opponentCount + oldTable.length, observation.opponentCount)
      && refillFits(previous.hand.length, observation.hand.length)
      && (previous.stockCount !== 0 || (!drawn.length && observation.opponentCount === previous.opponentCount + oldTable.length))) {
    return withRole('attack');
  }
  if(!refillFits(previous.hand.length-lost.length,observation.hand.length)
      || !refillFits(previous.opponentCount,observation.opponentCount)
      || (previous.stockCount===0&&(drawn.length||previous.opponentCount!==observation.opponentCount))) return observation;
  if(!pending.length && !lost.length) return withRole(previous.role==='defend'?'attack':'defend');
  if(previous.role!=='defend'||lost.length!==pending.length) return observation;
  // A same-rank trump could have been used for a transfer; do not confuse that
  // with a completed defense when no intermediate frame was captured.
  if(previous.allowTransfer!==false&&previous.table.every(pair=>pair.defense===null&&rank(pair.attack)===rank(pending[0].attack))
      && lost.some(card=>rank(card)===rank(pending[0].attack))) return observation;
  const plan=defensePlan(lost,pending.map((pair,target)=>({...pair,target})),previous.trumpSuit);
  return plan?withRole('attack'):observation;
}

// Each card is considered once. The mask represents attacks, so the search has
// at most 64 states even when a player has picked up a large hand.
function defensePlan(hand, pending, trumpSuit) {
  let plans = new Map([[0, { cost: 0, moves: [] }]]);
  for (const card of [...hand].sort((a, b) => cardCost(a, trumpSuit) - cardCost(b, trumpSuit) || a.localeCompare(b))) {
    const next = new Map(plans);
    for (const [mask, plan] of plans) {
      pending.forEach((pair, index) => {
        const bit = 1 << index;
        if (mask & bit || !beats(card, pair.attack, trumpSuit)) return;
        const nextMask = mask | bit;
        const candidate = { cost: plan.cost + cardCost(card, trumpSuit), moves: [...plan.moves, { card, target: pair.target }] };
        if (!next.has(nextMask) || next.get(nextMask).cost > candidate.cost) next.set(nextMask, candidate);
      });
    }
    plans = next;
  }
  return plans.get((1 << pending.length) - 1) ?? null;
}

/**
 * Advise from cards visible now, without pretending that a missed bout has been
 * reconstructed. The returned state is a VIEW, never a conserved game state to
 * pass to commit(), analyze(), or a confirmed-history store. Empty discard and
 * knownOpponent arrays are known subsets; discardCount:null means unknown.
 * Previous memory is deliberately not inherited: it may belong to another deal.
 */
export function analyzeSnapshot(previous, observation, { allowTransfer = true, attackLimit = 6, gameProfile = null } = {}) {
  if (gameProfile === 'hlop-singleplayer') {
    allowTransfer = false;
    if (previous) previous = { ...previous, allowTransfer: false };
  }
  observation=deriveSnapshotRole(previous,observation,{ gameProfile });
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return review('Не получен читаемый кадр игры.');
  if (!['high', 'medium'].includes(observation.confidence)) return review('Карты пока распознаны недостаточно уверенно; нужен повторный анализ кадра.');
  const errors = [];
  if (!Array.isArray(observation.hand) || observation.hand.some((card) => typeof card !== 'string' || !CARD.test(card))) errors.push('Не удалось прочитать все карты в вашей руке.');
  if (!Array.isArray(observation.table) || observation.table.some((pair) => !pair || typeof pair !== 'object' || Array.isArray(pair)
      || !CARD.test(pair.attack) || (pair.defense !== null && !CARD.test(pair.defense)))) errors.push('Не удалось прочитать пары атаки и защиты на столе.');
  if (!SUITS.has(observation.trumpSuit)) errors.push('Не удалось прочитать козырную масть.');
  if (observation.trumpCard != null && (typeof observation.trumpCard !== 'string' || !CARD.test(observation.trumpCard))) errors.push('Открытый козырь прочитан некорректно.');
  for (const key of ['opponentCount', 'stockCount']) {
    if (observation[key] != null && (!Number.isInteger(observation[key]) || observation[key] < 0 || observation[key] > 36)) errors.push(`Некорректное количество карт: ${key === 'opponentCount' ? 'у соперника' : 'в колоде'}.`);
  }
  if (errors.length) return review(errors);

  const hand = [...observation.hand];
  const table = observation.table.map((pair) => ({ attack: pair.attack, defense: pair.defense }));
  const tableCards = table.flatMap((pair) => pair.defense ? [pair.attack, pair.defense] : [pair.attack]);
  const currentCards = [...hand, ...tableCards];
  const seen = new Set();
  for (const card of currentCards) {
    if (seen.has(card)) errors.push(`Карта ${cardLabel(card)} одновременно прочитана в нескольких местах.`);
    seen.add(card);
  }
  if (table.length > 6) errors.push('Прочитано больше шести атак в одном заходе.');
  for (const pair of table) {
    if (pair.defense && !beats(pair.defense, pair.attack, observation.trumpSuit)) errors.push(`${cardLabel(pair.defense)} не может покрывать ${cardLabel(pair.attack)}.`);
  }
  const trumpCard = observation.trumpCard ?? null;
  const stockCount = observation.stockCount ?? null;
  const opponentCount = observation.opponentCount ?? null;
  if (trumpCard && !trumpCard.endsWith(observation.trumpSuit)) errors.push('Масть открытого козыря не совпадает с козырной мастью.');
  if (trumpCard && stockCount !== 0 && seen.has(trumpCard)) errors.push('Открытый козырь под колодой одновременно прочитан в руке или на столе.');
  if (currentCards.length + (opponentCount ?? 0) + (stockCount ?? 0) > 36) errors.push('На кадре прочитано больше карт, чем есть в колоде из 36 карт.');

  const pending = table.map((pair, target) => ({ ...pair, target })).filter((pair) => pair.defense === null);
  const action = observation.action ?? 'unknown';
  let role = observation.role;
  if (action === 'finish') {
    if (!table.length) errors.push('Кнопка завершения захода не согласуется с пустым столом.');
    if (role === 'defend') errors.push('Завершение подкидывания не согласуется с ролью защищающегося.');
    role = 'attack';
  } else if (action === 'attack' || action === 'defend') {
    if (role && role !== action) errors.push('Прочитанный ход не согласуется с доступным действием.');
    role = action;
  }
  if (!['attack', 'defend'].includes(role) && action !== 'wait') errors.push('Не удалось определить, чьё действие сейчас доступно.');
  if (errors.length) return review(errors);

  // The fixed limit can only be lower than six in a short-handed bout. Current
  // defender cards plus cards already spent on covering reconstruct that bound
  // without relying on how many cards were seen in an earlier API response.
  const coveredCount = table.length - pending.length;
  const configuredLimit = Number.isInteger(attackLimit) && attackLimit >= 0 && attackLimit <= 6 ? attackLimit : 6;
  const capacity = role === 'attack' && opponentCount !== null ? opponentCount + coveredCount
    : role === 'defend' ? hand.length + coveredCount : 6;
  const effectiveLimit = Math.max(table.length, Math.min(configuredLimit, capacity));
  const state = {
    hand, table, trumpSuit: observation.trumpSuit, trumpCard, opponentCount, stockCount,
    role: role ?? null, attackLimit: effectiveLimit, allowTransfer: allowTransfer !== false,
    discard: [], knownOpponent: [], discardCount: null, historyComplete: false,
  };
  const recommendations = [];
  const analysis = {
    valid: true, errors: [], unknownCards: [], unseenCount: null,
    knownCount: new Set([...currentCards, ...(trumpCard && stockCount !== 0 ? [trumpCard] : [])]).size,
    opponentTrumpProbability: null, expectedOpponentTrumps: null,
    recommendations, defensePlan: [], historyComplete: false, waiting: false,
    assumptions: ['Совет рассчитан по видимым картам. История неполная: вероятности скрытых карт не вычисляются. Оценки ходов — эвристика, не вероятность победы.'],
  };
  if (gameProfile === 'hlop-singleplayer') {
    analysis.assumptions.push('На этом столе игра с компьютером идёт по подкидным правилам; перевод отключён.');
  }
  if (observation.roleSource === 'hlop-singleplayer-empty-table') {
    analysis.assumptions.push('Очередь определена по правилам интерфейса этой игры: компьютер ходит автоматически, поэтому устойчивый пустой стол означает ваш первый ход в заходе.');
  }

  if (action === 'wait' || (role === 'defend' && pending.length === 0)) {
    analysis.waiting = true;
    analysis.waitingMessage = 'Сейчас ожидаем действие соперника. Помощник продолжит после изменения карт.';
  } else if (role === 'attack') {
    const tableRanks = new Set(tableCards.map(rank));
    if (opponentCount !== null && opponentCount > pending.length && table.length < effectiveLimit) {
      for (const card of hand) {
        if (table.length && !tableRanks.has(rank(card))) continue;
        const duplicates = hand.filter((other) => rank(other) === rank(card)).length - 1;
        recommendations.push({
          type: 'attack', card, target: null, responseProbability: null,
          score: stockCount === 0 && hand.length === 1 ? 100 : score(88 - cardCost(card, state.trumpSuit) * 1.3 + duplicates * 3),
          title: `${table.length ? 'Подкинуть' : 'Атаковать'} ${cardLabel(card)}`,
          reasons: [table.length ? 'Ранг карты уже есть на столе; текущий лимит позволяет подкинуть.' : 'Допустимый первый ход в текущем заходе.',
            card.endsWith(state.trumpSuit) ? 'Козырь ценен для защиты; его расход снижает оценку.' : 'Позволяет сохранить козыри для защиты.',
            'Вероятность ответа неизвестна: история вышедших карт не восстановлена.'],
        });
      }
    }
    if (table.length && (pending.length === 0 || action === 'finish')) recommendations.push({
      type: 'pass', card: null, target: null, responseProbability: null, score: 76,
      title: pending.length === 0 ? 'Завершить заход: нажмите «ВСЁ»' : 'Завершить подкидывание: нажмите «ВСЁ»',
      reasons: pending.length === 0 ? ['Все атакующие карты покрыты.', 'Можно закончить заход и сохранить оставшиеся карты.']
        : ['Кнопка «ВСЁ» доступна: соперник берёт непокрытые карты.', 'Можно завершить подкидывание и сохранить оставшиеся карты.'],
    });
    if (!recommendations.length) {
      analysis.waiting = true;
      analysis.waitingMessage = opponentCount === null ? 'Не видно количества карт соперника; ожидаем читаемый кадр для проверки допустимой атаки.'
        : 'Допустимых карт для подкидывания сейчас нет. Ожидаем ответ соперника или завершение захода.';
    }
  } else {
    const fullPlan = defensePlan(hand, pending, state.trumpSuit);
    if (fullPlan) {
      analysis.defensePlan = gameProfile === 'hlop-singleplayer'
        ? [...fullPlan.moves].sort((left, right) => left.target - right.target) : fullPlan.moves;
      const playable = gameProfile === 'hlop-singleplayer' ? pending.slice(0, 1) : pending;
      for (const pair of playable) {
        for (const card of hand) {
          if (!beats(card, pair.attack, state.trumpSuit)) continue;
          const rest = defensePlan(hand.filter((other) => other !== card), pending.filter((other) => other.target !== pair.target), state.trumpSuit);
          if (!rest) continue;
          const totalCost = cardCost(card, state.trumpSuit) + rest.cost;
          recommendations.push({
            type: 'defend', card, target: pair.target, responseProbability: null,
            score: stockCount === 0 && pending.length === hand.length ? 100 : score(93 - totalCost / pending.length * 1.1),
            title: `Покрыть ${cardLabel(pair.attack)} картой ${cardLabel(card)}`,
            reasons: [`${cardLabel(card)} бьёт ${cardLabel(pair.attack)} по правилам.`,
              pending.length === 1 ? 'Закрывает последнюю непокрытую атаку.' : 'После этого остаётся полный план покрытия остальных атак.',
              'Оценка учитывает силу расходуемых карт и сохранение козырей.'],
          });
        }
      }
    }
    recommendations.push({
      type: 'take', card: null, target: null, responseProbability: null,
      score: fullPlan ? score(40 + fullPlan.cost / pending.length * 0.5 - hand.length * 0.2) : 94,
      title: 'Взять карты со стола',
      reasons: fullPlan ? ['Взятие допустимо и сохраняет сильные карты.', 'Полное покрытие также возможно; сравнение основано на эвристике.']
        : ['Полностью покрыть текущие атаки картами в руке нельзя.', 'При наличии допустимого перевода он оценивается отдельно.'],
    });
    const transferRank = rank(pending[0].attack);
    if (allowTransfer !== false && opponentCount !== null
        && table.every((pair) => pair.defense === null && rank(pair.attack) === transferRank)
        && table.length + 1 <= Math.min(6, opponentCount)) {
      for (const card of hand.filter((candidate) => rank(candidate) === transferRank)) recommendations.push({
        type: 'transfer', card, target: null, responseProbability: null,
        score: stockCount === 0 && hand.length === 1 ? 100 : score(92 + table.length * 2 - cardCost(card, state.trumpSuit) * 0.8),
        title: `Перевести картой ${cardLabel(card)}`,
        reasons: ['Все атакующие карты одного ранга и ещё не покрыты.',
          `После перевода атак будет ${table.length + 1}; у принимающего соперника ${opponentCount} карт.`,
          'Перевод сохраняет карты для последующей защиты.'],
      });
    }
  }
  recommendations.sort((a, b) => b.score - a.score || (a.card ?? '').localeCompare(b.card ?? '') || (a.target ?? -1) - (b.target ?? -1));
  return {
    status: 'advisory', state, analysis,
    reasons: [observation.confidence === 'medium' ? 'Карты распознаны со средней уверенностью и проверены по правилам.' : 'Видимые карты проверены по правилам.',
      'Совет доступен по текущему столу; подтверждённая память предыдущих ходов сохранена отдельно.'],
    events: [],
  };
}
