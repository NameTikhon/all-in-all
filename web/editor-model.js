import { makeDeck, beats, validateState } from './durak.js';

const DECK = new Set(makeDeck());
const SUIT_SYMBOLS = { C: '♣', D: '♦', H: '♥', S: '♠' };
const ARRAY_ZONES = { hand: 'Ваша рука', discard: 'Отбой', knownOpponent: 'Карты соперника' };
const cardName = (card) => `${card.slice(0, -1)}${SUIT_SYMBOLS[card.slice(-1)]}`;
const rank = (card) => card.slice(0, -1);

/** The bottom trump is part of stock; known opponent cards are a hand subset. */
export function remainingStock(state) {
  return 36 - state.hand.length - state.discard.length - state.opponentCount
    - state.table.reduce((count, pair) => count + 1 + (pair.defense == null ? 0 : 1), 0);
}

/** Find the physical location of a card, retaining an exhausted trump as metadata. */
export function cardLocation(state, card) {
  const handIndex = state.hand.indexOf(card);
  if (handIndex !== -1) return { zone: 'hand', index: handIndex, label: ARRAY_ZONES.hand };
  for (const [index, pair] of state.table.entries()) {
    if (pair.attack === card) return { zone: 'attack', index, label: `Атака № ${index + 1}` };
    if (pair.defense === card) return { zone: 'defense', index, label: `Покрытие № ${index + 1}` };
  }
  const discardIndex = state.discard.indexOf(card);
  if (discardIndex !== -1) return { zone: 'discard', index: discardIndex, label: ARRAY_ZONES.discard };
  const opponentIndex = state.knownOpponent.indexOf(card);
  if (opponentIndex !== -1) return { zone: 'opponent', index: opponentIndex, label: ARRAY_ZONES.knownOpponent };
  if (state.trumpCard === card && remainingStock(state) > 0) {
    return { zone: 'trump', index: null, label: 'Открытый козырь' };
  }
  return null;
}

function cloneDraft(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
      || !['hand', 'discard', 'knownOpponent', 'table'].every((key) => Array.isArray(state[key]))) {
    throw new Error('Не удалось прочитать позицию. Начните новую партию.');
  }
  return {
    ...state,
    hand: [...state.hand],
    discard: [...state.discard],
    knownOpponent: [...state.knownOpponent],
    table: state.table.map((pair) => ({ ...pair })),
  };
}

function checkCard(card) {
  if (!DECK.has(card)) throw new Error('Выберите карту из колоды на 36 карт.');
}

function checkFree(state, card, zone, index = null, stockAfter = remainingStock(state)) {
  const location = cardLocation(state, card);
  // Drawing the final stock card releases the formerly reserved bottom trump.
  if (location?.zone === 'trump' && stockAfter === 0) return;
  if (location && (location.zone !== zone || location.index !== index)) {
    throw new Error(`Карта ${cardName(card)} уже находится в зоне «${location.label}». Сначала уберите её оттуда.`);
  }
}

function checkPairIndex(state, index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.table.length) {
    throw new Error('Сначала выберите атаку на столе.');
  }
}

/** Check physical cards immediately while allowing other incomplete draft fields. */
function finishDraft(next) {
  if (!Number.isInteger(next.opponentCount) || next.opponentCount < 0 || next.opponentCount > 36) {
    throw new Error('Укажите количество карт соперника от 0 до 36.');
  }
  next.stockCount = remainingStock(next);
  if (next.stockCount < 0) throw new Error('Получилось больше 36 карт. Уменьшите количество карт соперника или уберите лишние карты.');
  if (next.knownOpponent.length > next.opponentCount) {
    throw new Error('Известных карт соперника больше, чем карт в его руке. Увеличьте количество карт соперника.');
  }
  if (next.table.length > 6) throw new Error('На столе может быть не больше шести атак.');
  const seen = new Set();
  const register = (card) => {
    checkCard(card);
    if (seen.has(card)) throw new Error(`Карта ${cardName(card)} выбрана дважды. Уберите повтор.`);
    seen.add(card);
  };
  next.hand.forEach(register);
  next.discard.forEach(register);
  next.knownOpponent.forEach(register);
  next.table.forEach((pair, index) => {
    register(pair.attack);
    if (pair.defense != null) {
      register(pair.defense);
      if (!beats(pair.defense, pair.attack, next.trumpSuit)) {
        throw new Error(`${cardName(pair.defense)} не бьёт ${cardName(pair.attack)}. Выберите другое покрытие в паре № ${index + 1}.`);
      }
    }
  });
  if (next.trumpCard != null) {
    checkCard(next.trumpCard);
    if (next.stockCount > 0 && seen.has(next.trumpCard)) {
      throw new Error(`Открытый козырь ${cardName(next.trumpCard)} ещё в колоде. Он не может находиться в другой зоне.`);
    }
  }
  return next;
}

/** Select or unselect a visible card without moving it out of another zone. */
export function updateSelection(state, { zone, card, index } = {}) {
  checkCard(card);
  const next = cloneDraft(state);
  if (Object.hasOwn(ARRAY_ZONES, zone)) {
    const current = next[zone].indexOf(card);
    if (current !== -1) next[zone].splice(current, 1);
    else {
      checkFree(next, card, zone === 'knownOpponent' ? 'opponent' : zone, null,
        remainingStock(next) - (zone === 'knownOpponent' ? 0 : 1));
      next[zone].push(card);
    }
  } else if (zone === 'trump') {
    if (next.trumpCard === card) next.trumpCard = null;
    else {
      checkFree(next, card, 'trump');
      next.trumpCard = card;
      next.trumpSuit = card.slice(-1);
    }
  } else if (zone === 'attack') {
    if (index !== undefined) {
      checkPairIndex(next, index);
      checkFree(next, card, 'attack', index);
      next.table[index].attack = card;
    } else {
      if (next.table.length >= 6) throw new Error('На столе уже шесть атак. Уберите одну, чтобы добавить другую.');
      checkFree(next, card, 'attack', null, remainingStock(next) - 1);
      next.table.push({ attack: card, defense: null });
    }
  } else if (zone === 'defense') {
    checkPairIndex(next, index);
    if (next.table[index].defense === card) next.table[index].defense = null;
    else {
      checkFree(next, card, 'defense', index,
        remainingStock(next) - (next.table[index].defense === null ? 1 : 0));
      if (!beats(card, next.table[index].attack, next.trumpSuit)) {
        throw new Error(`${cardName(card)} не бьёт ${cardName(next.table[index].attack)}. Выберите старшую карту той же масти или подходящий козырь.`);
      }
      next.table[index].defense = card;
    }
  } else {
    throw new Error('Выберите, куда добавить карту.');
  }
  return finishDraft(next);
}

/** Explicitly play a card from hand; unlike selection this really moves a card. */
export function playFromHand(state, card, { type, target } = {}) {
  checkCard(card);
  const next = finishDraft(cloneDraft(state));
  const errors = validateState(next);
  if (errors.length) throw new Error(errors[0]);
  const handIndex = next.hand.indexOf(card);
  if (handIndex === -1) throw new Error(`Карты ${cardName(card)} нет в вашей руке.`);
  if (type === 'attack') {
    if (next.role !== 'attack') throw new Error('Сейчас вы защищаетесь. Выберите покрытие или перевод.');
    const pending = next.table.filter((pair) => pair.defense === null).length;
    if (next.table.length >= Math.min(6, next.attackLimit) || pending >= next.opponentCount) {
      throw new Error('Достигнут лимит атаки или у соперника недостаточно карт для ещё одной атаки.');
    }
    const tableRanks = new Set(next.table.flatMap((pair) => [pair.attack, pair.defense].filter(Boolean)).map(rank));
    if (next.table.length && !tableRanks.has(rank(card))) throw new Error('Подкинуть можно только карту того достоинства, которое уже есть на столе.');
    next.table.push({ attack: card, defense: null });
  } else if (type === 'defend') {
    if (next.role !== 'defend') throw new Error('Сейчас вы атакуете. Покрывать карты должен соперник.');
    checkPairIndex(next, target);
    if (next.table[target].defense !== null) throw new Error('Эта атака уже покрыта. Выберите непокрытую карту.');
    if (!beats(card, next.table[target].attack, next.trumpSuit)) {
      throw new Error(`${cardName(card)} не бьёт ${cardName(next.table[target].attack)}.`);
    }
    next.table[target].defense = card;
  } else if (type === 'transfer') {
    if (next.role !== 'defend') throw new Error('Перевод возможен, когда вы защищаетесь.');
    if (next.allowTransfer === false) throw new Error('Переводы отключены в настройках партии.');
    if (!next.table.length || next.table.some((pair) => pair.defense !== null || rank(pair.attack) !== rank(card))) {
      throw new Error('Перевести можно картой того же достоинства, пока ни одна атака не покрыта.');
    }
    const transferLimit = Math.min(6, next.opponentCount);
    if (next.table.length + 1 > transferLimit) throw new Error('У соперника недостаточно карт, чтобы принять перевод.');
    next.table.push({ attack: card, defense: null });
    next.role = 'attack';
    next.attackLimit = transferLimit;
  } else {
    throw new Error('Выберите действие: атаковать, покрыть или перевести.');
  }
  next.hand.splice(handIndex, 1);
  finishDraft(next);
  const resultErrors = validateState(next);
  if (resultErrors.length) throw new Error(resultErrors[0]);
  return next;
}
