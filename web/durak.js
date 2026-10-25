/**
 * Local, dependency-free analysis for a 36-card, two-player Durak game.
 * Probabilities are exact for the stated uniform hidden-card model. Move scores
 * are deliberately heuristics, not probabilities of winning the game.
 */
export const SUITS = Object.freeze([
  Object.freeze({ id: 'C', symbol: '♣', name: 'Трефы' }),
  Object.freeze({ id: 'D', symbol: '♦', name: 'Бубны' }),
  Object.freeze({ id: 'H', symbol: '♥', name: 'Червы' }),
  Object.freeze({ id: 'S', symbol: '♠', name: 'Пики' }),
]);

export const RANKS = Object.freeze(['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']);

const CARD_PATTERN = /^(6|7|8|9|10|J|Q|K|A)(C|D|H|S)$/;
const SUIT_IDS = new Set(SUITS.map((suit) => suit.id));

export function makeDeck() {
  return SUITS.flatMap((suit) => RANKS.map((rank) => `${rank}${suit.id}`));
}

function parseCard(card) {
  if (typeof card !== 'string') return null;
  const match = CARD_PATTERN.exec(card);
  return match ? { rank: match[1], suit: match[2], strength: RANKS.indexOf(match[1]) } : null;
}

export function cardLabel(card) {
  const parsed = parseCard(card);
  if (!parsed) return card == null ? '—' : String(card);
  return `${parsed.rank}${SUITS.find((suit) => suit.id === parsed.suit).symbol}`;
}

export function beats(defense, attack, trumpSuit) {
  const defending = parseCard(defense);
  const attacking = parseCard(attack);
  if (!defending || !attacking || !SUIT_IDS.has(trumpSuit)) return false;
  if (defending.suit === attacking.suit) return defending.strength > attacking.strength;
  return defending.suit === trumpSuit && attacking.suit !== trumpSuit;
}

/** Returns human-readable validation errors without changing the input. */
export function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return ['Состояние игры должно быть объектом.'];
  }
  const errors = [];
  const zones = new Map();
  const register = (card, zone) => {
    if (!parseCard(card)) {
      errors.push(`Некорректная карта в зоне «${zone}»: ${String(card)}.`);
      return;
    }
    if (zones.has(card)) {
      errors.push(`Карта ${cardLabel(card)} повторяется: «${zones.get(card)}» и «${zone}».`);
    } else {
      zones.set(card, zone);
    }
  };
  const cardArray = (key, label) => {
    if (!Array.isArray(state[key])) {
      errors.push(`Поле «${label}» должно быть списком карт.`);
      return [];
    }
    state[key].forEach((card) => register(card, label));
    return state[key];
  };

  const hand = cardArray('hand', 'Ваша рука');
  const discard = cardArray('discard', 'Отбой');
  const knownOpponent = cardArray('knownOpponent', 'Известные карты соперника');
  const table = Array.isArray(state.table) ? state.table : [];
  if (!Array.isArray(state.table)) errors.push('Стол должен быть списком пар «атака / защита».');
  let tableCardCount = 0;
  for (const [index, pair] of table.entries()) {
    if (!pair || typeof pair !== 'object' || Array.isArray(pair)) {
      errors.push(`Некорректная пара на столе № ${index + 1}.`);
      continue;
    }
    register(pair.attack, `Атака № ${index + 1}`);
    tableCardCount += 1;
    if (pair.defense !== null) {
      register(pair.defense, `Защита № ${index + 1}`);
      tableCardCount += 1;
      if (parseCard(pair.attack) && parseCard(pair.defense) && SUIT_IDS.has(state.trumpSuit)
          && !beats(pair.defense, pair.attack, state.trumpSuit)) {
        errors.push(`${cardLabel(pair.defense)} не бьёт ${cardLabel(pair.attack)} в паре № ${index + 1}.`);
      }
    }
  }

  if (!SUIT_IDS.has(state.trumpSuit)) errors.push('Выберите козырную масть: C, D, H или S.');
  if (state.role !== 'attack' && state.role !== 'defend') errors.push('Роль должна быть attack или defend.');
  if (state.allowTransfer !== undefined && typeof state.allowTransfer !== 'boolean') {
    errors.push('Разрешение перевода должно быть true или false.');
  }
  const opponentValid = Number.isInteger(state.opponentCount) && state.opponentCount >= 0 && state.opponentCount <= 36;
  const stockValid = Number.isInteger(state.stockCount) && state.stockCount >= 0 && state.stockCount <= 36;
  const limitValid = Number.isInteger(state.attackLimit) && state.attackLimit >= 0 && state.attackLimit <= 6;
  if (!opponentValid) errors.push('Количество карт соперника должно быть целым числом от 0 до 36.');
  if (!stockValid) errors.push('Количество карт в колоде должно быть целым числом от 0 до 36.');
  if (!limitValid) errors.push('Лимит атаки должен быть целым числом от 0 до 6.');
  if (table.length > 6) errors.push('На столе не может быть больше 6 атакующих карт.');
  if (limitValid && table.length > state.attackLimit) {
    errors.push('Количество атак на столе превышает лимит текущего захода.');
  }
  if (opponentValid && knownOpponent.length > state.opponentCount) {
    errors.push('Известных карт соперника больше, чем карт в его руке.');
  }
  if (state.trumpCard !== null && !parseCard(state.trumpCard)) {
    errors.push('Открытый козырь должен быть корректной картой или null.');
  }
  if (parseCard(state.trumpCard)) {
    if (state.trumpCard.slice(-1) !== state.trumpSuit) {
      errors.push('Масть открытого козыря не совпадает с козырной мастью.');
    }
    if (stockValid && state.stockCount > 0 && zones.has(state.trumpCard)) {
      errors.push(`Открытый козырь ${cardLabel(state.trumpCard)} ещё в колоде и не может одновременно находиться в другой зоне.`);
    }
  }
  if (opponentValid && stockValid) {
    // knownOpponent is a visible subset of opponentCount, not an extra zone.
    const total = hand.length + tableCardCount + discard.length + state.opponentCount + state.stockCount;
    if (total !== 36) {
      errors.push(`В учёте должно быть ровно 36 карт; сейчас ${total}. Открытый козырь входит в число карт колоды.`);
    }
  }
  return errors;
}

function cardCost(card, trumpSuit) {
  const parsed = parseCard(card);
  return parsed.strength * 2 + (parsed.suit === trumpSuit ? 16 : 0);
}

function roundedScore(score) {
  return Math.round(Math.max(0, Math.min(100, score)) * 10) / 10;
}

/** Hypergeometric P(at least one matching card), accounting for known cards. */
function probabilityInOpponent(state, unknownCards, predicate) {
  if (state.knownOpponent.some(predicate)) return 1;
  const draws = state.opponentCount - state.knownOpponent.length;
  const population = unknownCards.length;
  const matching = unknownCards.filter(predicate).length;
  if (draws <= 0 || matching === 0 || population === 0) return 0;
  if (draws > population - matching) return 1;
  let none = 1;
  for (let index = 0; index < draws; index += 1) {
    none *= (population - matching - index) / (population - index);
  }
  return Math.max(0, Math.min(1, 1 - none));
}

/**
 * Minimum-cost complete bipartite matching. The subset mask covers attacks,
 * not cards, so at most 64 states are needed even with a large player hand.
 */
function findDefensePlan(hand, pending, trumpSuit) {
  if (pending.length === 0) return { cost: 0, moves: [] };
  let possibilities = new Map([[0, { cost: 0, moves: [] }]]);
  const orderedHand = [...hand].sort((left, right) => cardCost(left, trumpSuit) - cardCost(right, trumpSuit)
    || left.localeCompare(right));
  for (const card of orderedHand) {
    const next = new Map(possibilities);
    for (const [mask, plan] of possibilities) {
      pending.forEach((pair, index) => {
        const bit = 1 << index;
        if ((mask & bit) !== 0 || !beats(card, pair.attack, trumpSuit)) return;
        const targetMask = mask | bit;
        const cost = plan.cost + cardCost(card, trumpSuit);
        if (!next.has(targetMask) || cost < next.get(targetMask).cost) {
          next.set(targetMask, { cost, moves: [...plan.moves, { card, target: pair.target }] });
        }
      });
    }
    possibilities = next;
  }
  const result = possibilities.get((1 << pending.length) - 1);
  return result ? { cost: result.cost, moves: [...result.moves].sort((left, right) => left.target - right.target) } : null;
}

function baseAssumptions(state) {
  return [
    `Два игрока, 36 карт; ${state.allowTransfer === false ? 'подкидной дурак, переводы отключены.' : 'переводной дурак. Перевод возможен до первого покрытия, в том числе повторный.'}`,
    'Неизвестные карты равномерно распределены между неизвестной частью руки соперника и закрытой частью колоды; привычки соперника не моделируются.',
    'Вероятность ответа означает наличие хотя бы одной карты, бьющей одну указанную карту. Это не вероятность победы или полного отбоя.',
    'Оценки ходов от 0 до 100 — эвристика: учитываются возможность полного покрытия, сила и сохранение козырей. Оптимальная стратегия не доказана.',
    'Лимит атаки фиксируется в начале захода; после расходования карт на защиту он не уменьшается. По умолчанию разрешено до 6 атак и перевод с первого захода.',
    'Открытый нижний козырь входит в число карт колоды. Пока колода не пуста, он исключён из неизвестной руки соперника.',
  ];
}

export function analyze(state, { gameProfile = null } = {}) {
  const errors = validateState(state);
  if (errors.length > 0) {
    return {
      valid: false, errors, unknownCards: [], unseenCount: 0, knownCount: 0,
      opponentTrumpProbability: null, expectedOpponentTrumps: null,
      recommendations: [], defensePlan: [], assumptions: [],
    };
  }

  const visible = new Set([
    ...state.hand, ...state.discard, ...state.knownOpponent,
    ...state.table.flatMap((pair) => pair.defense === null ? [pair.attack] : [pair.attack, pair.defense]),
  ]);
  if (state.stockCount > 0 && state.trumpCard !== null) visible.add(state.trumpCard);
  const unknownCards = makeDeck().filter((card) => !visible.has(card));
  const isTrump = (card) => card.slice(-1) === state.trumpSuit;
  const opponentTrumpProbability = probabilityInOpponent(state, unknownCards, isTrump);
  const unknownOpponentCount = state.opponentCount - state.knownOpponent.length;
  const expectedOpponentTrumps = state.knownOpponent.filter(isTrump).length
    + (unknownCards.length === 0 ? 0
      : unknownOpponentCount * unknownCards.filter(isTrump).length / unknownCards.length);
  const responseTo = (card) => probabilityInOpponent(state, unknownCards,
    (opponentCard) => beats(opponentCard, card, state.trumpSuit));
  const recommendations = [];
  const pending = state.table.map((pair, target) => ({ ...pair, target })).filter((pair) => pair.defense === null);
  let defensePlan = [];

  if (state.role === 'attack') {
    const tableRanks = new Set(state.table.flatMap((pair) => pair.defense === null
      ? [parseCard(pair.attack).rank] : [parseCard(pair.attack).rank, parseCard(pair.defense).rank]));
    const canAdd = state.table.length < state.attackLimit && pending.length < state.opponentCount;
    if (canAdd) {
      for (const card of state.hand) {
        const parsed = parseCard(card);
        if (state.table.length > 0 && !tableRanks.has(parsed.rank)) continue;
        const responseProbability = responseTo(card);
        const sameRankInHand = state.hand.filter((other) => parseCard(other).rank === parsed.rank).length - 1;
        const emptiesHand = state.stockCount === 0 && state.hand.length === 1;
        recommendations.push({
          type: 'attack', card, target: null,
          score: emptiesHand ? 100
            : roundedScore(95 - responseProbability * 45 - cardCost(card, state.trumpSuit) * 0.7 + sameRankInHand * 2),
          responseProbability,
          title: `${state.table.length === 0 ? 'Атаковать' : 'Подкинуть'} ${cardLabel(card)}`,
          reasons: [
            state.table.length === 0 ? 'Допустимый первый ход в этом заходе.' : 'Ранг уже есть на столе; лимит захода допускает ещё одну атаку.',
            `Вероятность хотя бы одной бьющей карты у соперника: ${(responseProbability * 100).toFixed(1)}%.`,
            parsed.suit === state.trumpSuit ? 'Расходует козырь; эвристическая оценка учитывает его ценность.' : 'Сохраняет козыри для защиты.',
            ...(emptiesHand ? ['После хода рука пуста, добора из колоды нет; это получает приоритет в оценке.'] : []),
          ],
        });
      }
    }
    if (state.table.length > 0 && pending.length === 0) {
      recommendations.push({
        type: 'pass', card: null, target: null,
        score: roundedScore(68 + state.table.length * 2), responseProbability: null,
        title: 'Завершить заход: отбой',
        reasons: ['Все атаки покрыты. Можно завершить заход и не расходовать дополнительные карты.'],
      });
    }
  } else if (pending.length > 0) {
    const completePlan = findDefensePlan(state.hand, pending, state.trumpSuit);
    if (completePlan) {
      defensePlan = completePlan.moves;
      const playable = gameProfile === 'hlop-singleplayer' ? pending.slice(0, 1) : pending;
      for (const pair of playable) {
        for (const card of state.hand) {
          if (!beats(card, pair.attack, state.trumpSuit)) continue;
          const rest = findDefensePlan(state.hand.filter((other) => other !== card),
            pending.filter((other) => other.target !== pair.target), state.trumpSuit);
          // Do not recommend a superficially legal cover that strands another
          // attack when a complete allocation exists.
          if (!rest) continue;
          const totalCost = cardCost(card, state.trumpSuit) + rest.cost;
          const trumpsUsed = [card, ...rest.moves.map((move) => move.card)].filter(isTrump).length;
          const emptiesHand = state.stockCount === 0 && pending.length === state.hand.length;
          recommendations.push({
            type: 'defend', card, target: pair.target,
            score: emptiesHand ? 100 : roundedScore(92 - totalCost / pending.length * 1.1 - trumpsUsed * 1.5
              - cardCost(card, state.trumpSuit) * 0.03),
            responseProbability: null,
            title: `Покрыть ${cardLabel(pair.attack)} картой ${cardLabel(card)}`,
            reasons: [
              `${cardLabel(card)} бьёт ${cardLabel(pair.attack)} по правилам.`,
              pending.length === 1 ? 'Закрывает последнюю непокрытую атаку.' : 'После этого остаётся полный план покрытия остальных атак.',
              `Полный план использует козырей: ${trumpsUsed}. Сила потраченных карт учтена эвристически.`,
              ...(emptiesHand ? ['Полный план покрытия расходует всю руку; колода пуста, поэтому такой план получает приоритет.'] : []),
            ],
          });
        }
      }
    }

    recommendations.push({
      type: 'take', card: null, target: null,
      score: completePlan ? roundedScore(40 + completePlan.cost / pending.length * 0.5
        + (state.stockCount > 0 ? 5 : 0) - state.hand.length * 0.2) : 94,
      responseProbability: null, title: 'Взять карты со стола',
      reasons: completePlan
        ? ['Взятие допустимо и сохраняет карты для следующих заходов.', 'Полный отбой возможен; сравнение с ним зависит от эвристической ценности карт.']
        : ['Полностью покрыть все текущие атаки имеющимися картами нельзя.', 'Взятие допустимо; при наличии перевода он рассматривается отдельно.'],
    });

    const transferRank = parseCard(pending[0].attack).rank;
    const canTransfer = state.allowTransfer !== false
      && state.table.every((pair) => pair.defense === null && parseCard(pair.attack).rank === transferRank)
      && state.table.length + 1 <= Math.min(6, state.opponentCount);
    if (canTransfer) {
      for (const card of state.hand) {
        if (parseCard(card).rank !== transferRank) continue;
        const responseProbability = responseTo(card);
        const emptiesHand = state.stockCount === 0 && state.hand.length === 1;
        recommendations.push({
          type: 'transfer', card, target: null,
          score: emptiesHand ? 100
            : roundedScore(92 + state.table.length * 2 - cardCost(card, state.trumpSuit) * 0.8 - responseProbability * 5),
          responseProbability,
          title: `Перевести картой ${cardLabel(card)}`,
          reasons: [
            'Все атаки одного ранга; ни одна карта ещё не покрыта.',
            `После перевода атак будет ${state.table.length + 1}; у принимающего соперника ${state.opponentCount} карт.`,
            'Вероятность ответа относится только к добавляемой карте. Выгодность перевода оценена эвристически.',
            ...(emptiesHand ? ['После перевода рука пуста, добора из колоды нет; это получает приоритет в оценке.'] : []),
          ],
        });
      }
    }
  }

  recommendations.sort((left, right) => right.score - left.score
    || (left.card ?? '').localeCompare(right.card ?? '') || (left.target ?? -1) - (right.target ?? -1));
  return {
    valid: true, errors: [], unknownCards,
    unseenCount: unknownCards.length, knownCount: 36 - unknownCards.length,
    opponentTrumpProbability, expectedOpponentTrumps,
    recommendations, defensePlan, assumptions: baseAssumptions(state),
  };
}
