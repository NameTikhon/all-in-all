import { analyze, validateState, RANKS } from './durak.js';
import { remainingStock, cardLocation, updateSelection, playFromHand } from './editor-model.js';
import { mountModesUI } from './modes-ui.js';
import { createAutoMonitor, signaturesChanged } from './auto-loop.js';
import { setupProviderSettings } from './provider-ui.js';
import { createAutoRecovery } from './auto-recovery.js';
import { createAutoSession } from './auto-session.js';
import { detectGameRegion } from './game-region.js';
import { resolveAutomaticObservation } from './auto-advice.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'allinall.durak.session.v1';
const DRAFT_KEY = 'allinall.durak.draft.v1';
const AUTO_STORE_KEY = 'allinall.durak.auto.session.v1';
let mode = 'auto';
let autoReady = false;
let autoFresh = false;
let autoSnapshot = null;
let lastCurrentScene = null;
const sessions = { auto: null, manual: null };
let monitor = null;
let requestController = null;
let captureGeneration = 0;
let reviewObservation = null;
let correctionBaseline = null;
let autoEvents = [];
let settingsUI;
let lastRequestAt = -Infinity;
let requestTail = Promise.resolve();
let monitorOptions = '';
let confirmedSignature = null;
const autoRecovery = createAutoRecovery();
const autoSessionTracker = createAutoSession();
const automaticArchives = [];
let singleFrameSequence = 0;
const autoFrameMemory = [];
let gameRegion = null;
let gameProfile = 'hlop-singleplayer';
let captureSize = '';
let providerRequests = 0;
let cachedRecognitions = 0;
const pageCaptureId = crypto.randomUUID();
const SUITS = { C: { symbol: '♣', name: 'Трефы' }, D: { symbol: '♦', name: 'Бубны' }, H: { symbol: '♥', name: 'Червы' }, S: { symbol: '♠', name: 'Пики' } };
const CARD_PATTERN = /^(6|7|8|9|10|J|Q|K|A)[CDHS]$/;
const DEMO = { hand: ['6C', '9C', '10D', 'QH', 'KS', 'AS'], table: [{ attack: '8C', defense: null }], discard: [], knownOpponent: [], trumpSuit: 'H', trumpCard: '6H', opponentCount: 5, stockCount: 24, role: 'defend', attackLimit: 6, allowTransfer: true };
const EMPTY = { hand: [], table: [], discard: [], knownOpponent: [], trumpSuit: 'H', trumpCard: null, opponentCount: 6, stockCount: 30, role: 'attack', attackLimit: 6, allowTransfer: true };
const clone = (value) => JSON.parse(JSON.stringify(value));
let state = clone(EMPTY);
let source = 'empty';
let history = [];
let draftDirty = false;
let stream = null;
let config = { visionConfigured: false, model: null };
let recognitionBusy = false;
let visionProposal = null;
let selectedRecommendation = 0;
let noticeTimer;
let restorationFailed = false;
let pickerDraft = null;
let pickerTarget = null;
let pickerDirty = false;
const RANK_NAMES = {6:'Шестёрка',7:'Семёрка',8:'Восьмёрка',9:'Девятка',10:'Десятка',J:'Валет',Q:'Дама',K:'Король',A:'Туз'};
const SUIT_NAMES = {C:'треф',D:'бубен',H:'червей',S:'пик'};

function buildVisualEditor() {
  const dashboard=document.querySelector('.dashboard-grid');
  for(const section of ['position','advice','capture','memory']) dashboard.append(document.querySelector(`.${section}-panel`));
  for(const [section,number] of [['position','01'],['advice','02'],['capture','03'],['memory','04']]) document.querySelector(`.${section}-panel .section-number`).textContent=number;
  document.querySelector('h1').innerHTML = 'Выберите карты.<br><span>Получите совет.</span>';
  document.querySelector('.page-header > div > p').textContent = 'Карты выбираются кликами. Остаток колоды считаем за вас.';
  $('start-button').textContent = 'Начать свою партию ↗';
  $('edit-button').textContent = 'Параметры ↗';
  $('capture-title').textContent = 'Демонстрация экрана';
  $('editor-details').open = true;
  $('editor-details').querySelector('summary').innerHTML = 'Параметры партии <span>Выберите козырь и укажите карты соперника</span>';
  const form = $('position-form');
  const grid = form.querySelector('.form-grid');
  const advanced = document.createElement('details'); advanced.className = 'advanced-editor';
  advanced.innerHTML = '<summary>Дополнительные настройки и ввод кодами</summary><p class="small-help">Обычно эти поля не нужны. Карты можно выбрать кнопками выше.</p><div class="form-grid"></div>';
  const advancedGrid = advanced.querySelector('.form-grid');
  for (const id of ['hand','table','trumpCard','discard','knownOpponent','trumpSuit','stockCount','attackLimit']) advancedGrid.append($(`field-${id}`).closest('label'));
  advanced.append($('field-allowTransfer').closest('label'));
  const autoLabel = document.createElement('label'); autoLabel.className = 'checkbox-field';
  autoLabel.innerHTML = '<input id="field-autoStock" type="checkbox" checked> Автоматически считать оставшиеся карты в колоде';
  advanced.prepend(autoLabel);
  const visual = document.createElement('div'); visual.className = 'visual-config';
  visual.innerHTML = '<div class="visual-field"><span>Козырь</span><button type="button" id="trump-picker-button" class="zone-select-button" data-pick-zone="trump">Выбрать козырь</button></div>';
  const roleLabel = $('field-role').closest('label');
  roleLabel.firstChild.textContent = 'Сейчас ваш ход';
  $('field-role').options[0].textContent = 'Защищаюсь'; $('field-role').options[1].textContent = 'Атакую / подкидываю';
  visual.append(roleLabel);
  const opponentLabel = $('field-opponentCount').closest('label');
  opponentLabel.firstChild.textContent = 'Сколько карт у соперника';
  $('field-opponentCount').setAttribute('aria-label','Сколько карт у соперника');
  const counter = document.createElement('div'); counter.className = 'counter-control';
  counter.innerHTML = '<button type="button" data-count-delta="-1" aria-label="У соперника на карту меньше">−</button>';
  counter.append($('field-opponentCount'));
  counter.insertAdjacentHTML('beforeend','<button type="button" data-count-delta="1" aria-label="У соперника на карту больше">+</button>');
  opponentLabel.append(counter); visual.append(opponentLabel);
  visual.insertAdjacentHTML('beforeend','<div class="stock-readout"><span>Осталось в колоде</span><b class="stock-total" id="auto-stock-total">—</b><small id="stock-explanation">Считается автоматически, включая открытый козырь.</small></div>');
  grid.replaceWith(visual);
  form.querySelector('.editor-intro').remove();
  form.querySelector('.form-footer').before(advanced);
  form.querySelector('button[type="submit"]').textContent = 'Сохранить и рассчитать ↗';
  $('field-stockCount').readOnly = true;
  $('field-stockCount').closest('label').firstChild.textContent = 'Остаток колоды (автоматически)';
  document.querySelector('.cards-area').insertAdjacentHTML('afterbegin','<div class="card-zone-actions"><button type="button" class="zone-select-button" data-pick-zone="hand">＋ Выбрать свои карты</button><span class="inline-guidance">Откройте колоду и нажмите нужные карты.</span></div>');
  document.querySelector('.table-area').insertAdjacentHTML('afterbegin','<div class="card-zone-actions"><button type="button" class="add-card-button" data-pick-zone="attack">＋ Добавить атаку</button><span class="inline-guidance">Покрытие выбирается справа от карты атаки.</span></div>');
  $('opponent-cards').before(makeZoneButton('knownOpponent','＋ Известные карты соперника'));
  $('discard-cards').before(makeZoneButton('discard','＋ Выбрать отбой'));
  const dialog = document.createElement('dialog'); dialog.id = 'card-picker-dialog'; dialog.className = 'modal card-picker-modal';
  dialog.setAttribute('aria-labelledby','picker-title');
  dialog.innerHTML = '<div class="modal-heading picker-heading"><div><span class="eyebrow">ВЫБОР КАРТ КЛИКОМ</span><h2 id="picker-title">Выберите карты</h2></div><button type="button" id="picker-close" class="icon-button" aria-label="Закрыть выбор карт">×</button></div><p id="picker-instruction" class="picker-instruction"></p><div class="picker-toolbar"><span id="picker-count" class="picker-count"></span><button type="button" id="picker-clear" class="text-button">Очистить выбор</button></div><div id="picker-selected" class="picker-selected"></div><div id="picker-suits" class="picker-suits"></div><p id="picker-error" class="picker-error" role="alert" hidden></p><div class="picker-footer"><button type="button" id="picker-cancel" class="text-button">Отмена</button><button type="button" id="picker-done" class="primary-button">Готово</button></div>';
  document.body.append(dialog);
  const quickApply=document.createElement('div'); quickApply.id='quick-apply'; quickApply.className='quick-apply'; quickApply.hidden=true;
  quickApply.innerHTML='<span>Позиция изменена</span><button type="submit" form="position-form" class="primary-button">Сохранить и рассчитать</button>';
  document.body.append(quickApply);
  document.querySelector('.help-steps').innerHTML='<li><b>Выберите свою руку кликами.</b><p>Нажмите «Выбрать свои карты», отметьте карты из вашей руки и нажмите «Готово». Повторный клик снимает выбор.</p></li><li><b>Выберите козырь и число карт соперника.</b><p>Нажмите кнопку козыря и выберите открытую карту. У соперника в начале обычно 6 карт. Оставшиеся карты в колоде считаются автоматически.</p></li><li><b>Сохраните позицию и посмотрите совет.</b><p>Нажмите «Сохранить и рассчитать». Чтобы отметить сыгранную своей картой атаку или защиту, выберите вариант совета и нажмите «Я так походил».</p></li><li><b>Обновляйте стол и память.</b><p>Атаку добавляйте кнопкой «Добавить атаку», покрытие — в слоте справа от неё. Укажите текущее число карт у соперника. После кона нажмите «В отбой», «Я взял» или «Соперник взял», затем подтвердите добор и новый ход.</p></li>';
  $('picker-suits').innerHTML = Object.entries(SUITS).map(([suit,info]) => `<div class="picker-suit-row"><div class="picker-suit-label ${['D','H'].includes(suit)?'red':''}">${info.symbol}<span>${info.name}</span></div><div class="picker-cards">${RANKS.map(rank=>`<button type="button" class="pick-card ${['D','H'].includes(suit)?'red':''}" data-pick-card="${rank+suit}" aria-label="${RANK_NAMES[rank]} ${SUIT_NAMES[suit]}" aria-pressed="false"><span class="pick-rank">${rank}</span><span class="pick-suit" aria-hidden="true">${info.symbol}</span><small></small></button>`).join('')}</div></div>`).join('');
}
function makeZoneButton(zone,label) { const button = document.createElement('button'); button.type='button'; button.className='zone-select-button'; button.dataset.pickZone=zone; button.textContent=label; return button; }
function persistDraft() {
  try {
    const values = Object.fromEntries([...$('position-form').querySelectorAll('input,select,textarea')].filter(el=>el.id).map(el=>[el.id,el.type==='checkbox'?el.checked:el.value]));
    if(mode==='manual') localStorage.setItem(DRAFT_KEY,JSON.stringify({version:1,values}));
  } catch { /* The normal save warning and JSON export remain available. */ }
}
function clearSavedDraft() { if(mode!=='manual') return; try { localStorage.removeItem(DRAFT_KEY); } catch { /* Browser storage can be disabled. */ } }
function loadDraft() {
  if(mode!=='manual') return;
  try {
    const raw=localStorage.getItem(DRAFT_KEY); if(!raw || raw.length>100000) return;
    const saved=JSON.parse(raw); if(saved.version!==1 || !saved.values || typeof saved.values!=='object') return;
    for(const el of $('position-form').querySelectorAll('input,select,textarea')) {
      if(!Object.hasOwn(saved.values,el.id)) continue;
      if(el.type==='checkbox') el.checked=saved.values[el.id]===true;
      else if(typeof saved.values[el.id]==='string' && saved.values[el.id].length<10000) el.value=saved.values[el.id];
    }
    markDraft(); showNotice('Восстановлены незавершённые правки. Проверьте карты и сохраните позицию.');
  } catch { showNotice('Черновик не удалось восстановить. Подтверждённая позиция сохранена.',true); }
}
function syncAutoStock() {
  $('field-stockCount').readOnly=$('field-autoStock').checked;
  try {
    const draft=readForm(); if($('field-autoStock').checked) $('field-stockCount').value=draft.stockCount;
    $('auto-stock-total').textContent=String(draft.stockCount);
    $('stock-explanation').textContent=$('field-autoStock').checked ? `36 − ваша рука (${draft.hand.length}) − стол (${allTableCards(draft).length}) − отбой (${draft.discard.length}) − соперник (${draft.opponentCount}).` : 'Указано вручную. Открытый козырь входит в это число.';
  } catch { $('auto-stock-total').textContent='—'; }
}
function isPickerSelected(id) {
  const {zone,index}=pickerTarget;
  if(['hand','discard','knownOpponent'].includes(zone)) return pickerDraft[zone].includes(id);
  if(zone==='trump') return pickerDraft.trumpCard===id;
  if(zone==='attack') return Number.isInteger(index) && pickerDraft.table[index]?.attack===id;
  return pickerDraft.table[index]?.defense===id;
}
function pickerCandidate(id) {
  if(pickerTarget.zone==='attack' && isPickerSelected(id)) {
    const next=clone(pickerDraft); next.table.splice(pickerTarget.index,1); next.stockCount=remainingStock(next); return next;
  }
  return updateSelection(pickerDraft,{...pickerTarget,card:id});
}
function renderPicker() {
  const {zone,index}=pickerTarget;
  const titles={hand:'Выберите свои карты',discard:'Выберите карты отбоя',knownOpponent:'Какие карты соперника известны?',trump:'Выберите открытый козырь',attack:'Карта атаки',defense:`Чем покрыта ${pickerDraft.table[index] ? cardName(pickerDraft.table[index].attack) : 'атака'}?`};
  $('picker-title').textContent=titles[zone];
  $('picker-instruction').textContent=['hand','discard','knownOpponent'].includes(zone) ? 'Нажимайте карты, чтобы добавить их. Повторное нажатие убирает карту. Занятые карты подписаны.' : zone==='defense' ? 'Выберите карту покрытия. Подойдут старшие карты той же масти или козыри. Это редактор видимого стола.' : 'Нажмите нужную карту. Занятые карты сначала уберите из другой зоны.';
  const selected=[];
  $('picker-suits').querySelectorAll('[data-pick-card]').forEach(button=>{
    const id=button.dataset.pickCard; const selectedHere=isPickerSelected(id); let problem='';
    try { pickerCandidate(id); } catch(error) { problem=error.message; }
    const location=cardLocation(pickerDraft,id);
    button.disabled=Boolean(problem); button.classList.toggle('selected',selectedHere); button.classList.toggle('unavailable',Boolean(problem)); button.setAttribute('aria-pressed',String(selectedHere));
    const shortLocation=location?.zone==='hand'?'в руке':location?.zone==='trump'?'козырь':location?.zone==='discard'?'отбой':location?.zone==='opponent'?'соперник':location?'на столе':'';
    button.querySelector('small').textContent=selectedHere?'':problem?(shortLocation || 'не бьёт'):'';
    button.title=problem || `${RANK_NAMES[id.slice(0,-1)]} ${SUIT_NAMES[id.slice(-1)]}${selectedHere?' — убрать':' — выбрать'}`;
    if(selectedHere) selected.push(id);
  });
  $('picker-selected').innerHTML=selected.length?selected.map(id=>`<button type="button" class="picker-selection-chip ${isRed(id)?'red':''}" data-pick-card="${id}" aria-label="Убрать ${cardName(id)}">${cardName(id)} <span class="remove-icon">×</span></button>`).join(''):'<span class="inline-guidance">Пока ничего не выбрано</span>';
  $('picker-count').textContent=`Выбрано: ${selected.length} · в колоде останется ${remainingStock(pickerDraft)}`;
  $('picker-clear').disabled=!selected.length;
}
function openPicker(zone,index) {
  if(mode!=='manual') return;
  try {
    pickerDraft=readForm(); pickerTarget={zone,...(Number.isInteger(index)?{index}:{})}; pickerDirty=false;
    $('picker-error').hidden=true; renderPicker(); $('card-picker-dialog').showModal();
  } catch(error) { showNotice(`Не удалось открыть выбор: ${error.message} Сбросьте ошибочные правки в дополнительных настройках.`,true); }
}
function selectPickerCard(id) {
  try {
    const wasSelected=isPickerSelected(id); const beforeLength=pickerDraft.table.length;
    pickerDraft=pickerCandidate(id); pickerDirty=true;
    if(pickerTarget.zone==='attack') {
      if(wasSelected) delete pickerTarget.index;
      else if(!Number.isInteger(pickerTarget.index) && pickerDraft.table.length>beforeLength) pickerTarget.index=pickerDraft.table.length-1;
    }
    $('picker-error').hidden=true; renderPicker();
  } catch(error) { $('picker-error').textContent=error.message; $('picker-error').hidden=false; }
}
function closePicker() { pickerDirty=false; $('card-picker-dialog').close(); }
function finishPicker() {
  if(pickerDirty) { writeForm(pickerDraft); markDraft(); }
  closePicker();
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function cardName(id) { return `${id.slice(0, -1)}${SUITS[id.slice(-1)]?.symbol || '?'}`; }
function isRed(id) { return /[DH]$/.test(id); }
function cardHtml(id, extra = '') {
  if (!CARD_PATTERN.test(id)) return '';
  const rank = escapeHtml(id.slice(0, -1)); const suit = SUITS[id.slice(-1)].symbol;
  return `<div class="playing-card ${isRed(id) ? 'red' : ''} ${extra}" title="${cardName(id)}" aria-label="${cardName(id)}"><span class="card-corner">${rank}<small>${suit}</small></span><span class="card-suit" aria-hidden="true">${suit}</span><span class="card-corner bottom-corner" aria-hidden="true">${rank}<small>${suit}</small></span></div>`;
}
function miniCardHtml(id) { return `<span class="mini-card ${isRed(id) ? 'red' : ''}" title="${cardName(id)}">${escapeHtml(id.slice(0, -1))}<span>${SUITS[id.slice(-1)].symbol}</span></span>`; }
function allTableCards(value = state) { return value.table.flatMap((pair) => [pair.attack, pair.defense].filter(Boolean)); }
function percent(value) { return Number.isFinite(value) ? `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` : '—'; }
function showNotice(message, isError = false) {
  clearTimeout(noticeTimer); $('notice').textContent = message; $('notice').classList.toggle('error', isError); $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 9500);
}
function showErrors(id, messages) {
  const element = $(id); element.hidden = !messages.length;
  element.innerHTML = messages.length ? `<ul>${messages.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul>` : '';
}
function getErrors(value) {
  try { return validateState(value); } catch (error) { return [`Не удалось проверить позицию: ${error.message}`]; }
}
function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Ожидается объект позиции.');
  const next = {};
  for (const key of ['hand', 'discard', 'knownOpponent']) {
    if (!Array.isArray(raw[key]) || raw[key].length > 36 || raw[key].some((id) => typeof id !== 'string' || !CARD_PATTERN.test(id))) throw new Error(`Поле ${key}: ожидается массив корректных карт (например, 6C).`);
    next[key] = [...raw[key]];
  }
  if (!Array.isArray(raw.table) || raw.table.length > 6) throw new Error('Поле table: ожидается массив до шести пар карт.');
  next.table = raw.table.map((pair) => {
    if (!pair || typeof pair !== 'object' || !CARD_PATTERN.test(pair.attack) || (pair.defense !== null && !CARD_PATTERN.test(pair.defense))) throw new Error('Каждая пара на столе должна содержать attack и defense (карта или null).');
    return { attack: pair.attack, defense: pair.defense };
  });
  if (!Object.hasOwn(SUITS, raw.trumpSuit)) throw new Error('Некорректная козырная масть.');
  if (raw.trumpCard !== null && (typeof raw.trumpCard !== 'string' || !CARD_PATTERN.test(raw.trumpCard))) throw new Error('Некорректный открытый козырь.');
  if (!['attack', 'defend'].includes(raw.role)) throw new Error('Роль должна быть attack или defend.');
  if (typeof raw.allowTransfer !== 'boolean') throw new Error('allowTransfer должен быть true или false.');
  for (const key of ['opponentCount', 'stockCount', 'attackLimit']) {
    if (!Number.isInteger(raw[key]) || raw[key] < 0 || raw[key] > 36) throw new Error(`Поле ${key}: ожидается целое число от 0 до 36.`);
    next[key] = raw[key];
  }
  Object.assign(next, { trumpSuit: raw.trumpSuit, trumpCard: raw.trumpCard, role: raw.role, allowTransfer: raw.allowTransfer });
  const errors = getErrors(next); if (errors.length) throw new Error(errors.join(' '));
  return next;
}
function loadSession() {
  try {
    const raw = localStorage.getItem(mode==='auto'?AUTO_STORE_KEY:STORE_KEY); if (!raw) return;
    if (raw.length > 200000) throw new Error('Сохранение слишком большое.');
    const saved = JSON.parse(raw); state = normalizeState(saved.state); source = mode==='auto'?'auto':saved.source === 'demo' ? 'demo' : 'manual';
    if(mode==='auto') autoReady=true;
  } catch (error) { restorationFailed = true; showNotice(`Не удалось восстановить сохранение. Исходный файл в браузере не перезаписан. ${error.message}`, true); }
}
function saveSession() {
  if(mode==='auto'&&!autoReady) return;
  try { localStorage.setItem(mode==='auto'?AUTO_STORE_KEY:STORE_KEY, JSON.stringify({ version: 1, state, source, updatedAt: new Date().toISOString() })); $('saved-indicator').textContent = 'Сохранено на устройстве'; }
  catch { $('saved-indicator').textContent = 'Автосохранение недоступно'; showNotice('Браузер не разрешил локальное сохранение. Скачайте JSON через «Экспорт», чтобы сохранить партию.', true); }
}
function writeForm(value, discardDraft = true) {
  $('field-hand').value = value.hand.join(', ');
  $('field-table').value = value.table.map((pair) => pair.defense ? `${pair.attack} > ${pair.defense}` : pair.attack).join('; ');
  $('field-discard').value = value.discard.join(', '); $('field-knownOpponent').value = value.knownOpponent.join(', ');
  for (const key of ['trumpSuit', 'role', 'opponentCount', 'stockCount', 'attackLimit']) $(`field-${key}`).value = value[key];
  $('field-trumpCard').value = value.trumpCard || ''; $('field-allowTransfer').checked = value.allowTransfer;
  draftDirty = false; $('draft-label').textContent = 'Данные сохранены локально'; showErrors('form-errors', []);
  if(discardDraft) clearSavedDraft(); syncAutoStock();
}
function parseCards(text, label) {
  const ids = text.trim().toUpperCase().split(/[\s,;]+/).filter(Boolean);
  const wrong = ids.filter((id) => !CARD_PATTERN.test(id));
  if (wrong.length) throw new Error(`${label}: неизвестные карты ${wrong.join(', ')}. Используйте 6–10, J, Q, K, A и C, D, H, S.`);
  return ids;
}
function readForm() {
  const next = clone(state);
  next.hand = parseCards($('field-hand').value, 'Ваша рука'); next.discard = parseCards($('field-discard').value, 'Отбой'); next.knownOpponent = parseCards($('field-knownOpponent').value, 'Карты соперника');
  const tableText = $('field-table').value.trim().toUpperCase();
  next.table = tableText ? tableText.split(/[;\n]+/).filter((line) => line.trim()).map((line) => {
    const cards = line.trim().split(/\s*(?:>|→|\/|:)\s*/);
    if (cards.length > 2 || !CARD_PATTERN.test(cards[0]) || (cards[1] && !CARD_PATTERN.test(cards[1]))) throw new Error('Стол: используйте формат «8C > 9C; QH». Слева атака, справа покрытие; непокрытую атаку укажите одной картой.');
    return { attack: cards[0], defense: cards[1] || null };
  }) : [];
  next.trumpCard = $('field-trumpCard').value.trim().toUpperCase() || null;
  if (next.trumpCard && !CARD_PATTERN.test(next.trumpCard)) throw new Error('Открытый козырь: укажите одну карту, например 6H, или оставьте поле пустым.');
  for (const key of ['trumpSuit', 'role']) next[key] = $(`field-${key}`).value;
  for (const key of ['opponentCount', 'stockCount', 'attackLimit']) {
    const input = $(`field-${key}`);
    if(key==='stockCount' && $('field-autoStock').checked) continue;
    if (input.value.trim() === '') throw new Error('Заполните количество карт и лимит атаки.'); next[key] = Number(input.value);
  }
  next.allowTransfer = $('field-allowTransfer').checked;
  if($('field-autoStock').checked) next.stockCount=remainingStock(next);
  return next;
}
function markDraft() {
  draftDirty = true; $('draft-label').textContent = 'Черновик — нажмите «Сохранить и рассчитать»'; $('saved-indicator').textContent = 'Есть неподтверждённые правки';
  syncAutoStock();
  try { showErrors('form-errors', getErrors(readForm())); } catch (error) { showErrors('form-errors', [error.message]); }
  persistDraft(); render();
}
function commit(next, nextSource = 'manual', message = '') {
  const errors = getErrors(next); if (errors.length) { showErrors('form-errors', errors); return false; }
  history.push({ state: clone(state), source }); if (history.length > 50) history.shift();
  state = clone(next); source = nextSource; selectedRecommendation = 0; writeForm(state); saveSession(); render();
  if (message) showNotice(message); return true;
}
function render() {
  $('quick-apply').hidden=mode!=='manual'||!draftDirty;
  $('demo-banner').hidden = mode!=='manual'||source !== 'demo'; $('undo-button').disabled = history.length === 0 || mode==='auto';
  let view=mode==='auto'&&autoSnapshot?autoSnapshot.state:state; if(draftDirty) { try { view=readForm(); } catch { /* The raw input error is shown next to Apply. */ } }
  const trump = SUITS[view.trumpSuit];
  $('trump-picker-button').textContent=view.trumpCard ? `${cardName(view.trumpCard)} · ${trump.name} · изменить` : `${trump.symbol} Выбрать карту козыря`;
  $('position-stats').innerHTML = `<div class="position-stat"><span>КОЗЫРЬ</span><b class="${['D', 'H'].includes(view.trumpSuit) ? 'trump-symbol' : ''}">${trump.symbol}</b><small>${view.trumpCard ? cardName(view.trumpCard) : (view.stockCount > 0 ? 'выберите карту' : 'карта не видна')}</small></div><div class="position-stat"><span>У СОПЕРНИКА</span><b>${view.opponentCount??'—'}</b><small>карт</small></div><div class="position-stat"><span>В КОЛОДЕ</span><b>${view.stockCount??'—'}</b><small>${view.stockCount===null?'счётчик не виден':'карт'}</small></div><div class="position-stat"><span>ЛИМИТ АТАКИ</span><b>${view.attackLimit}</b><small>карт</small></div>`;
  $('hand-count').textContent = String(view.hand.length); $('turn-label').textContent = mode==='auto'&&autoSnapshot?.analysis.waiting?'Ход соперника':view.role === 'defend' ? 'Защищаюсь' : 'Атакую / подкидываю';
  $('hand-cards').innerHTML = view.hand.length ? view.hand.map(id=>`<button type="button" class="clickable-card" data-pick-zone="hand" aria-label="Изменить свои карты: ${cardName(id)}">${cardHtml(id)}</button>`).join('') : '<button type="button" class="empty-zone-button" data-pick-zone="hand">＋ Открыть колоду и выбрать свои карты</button>';
  $('table-count').textContent = String(allTableCards(view).length);
  $('table-cards').innerHTML = view.table.length ? view.table.map((pair,index) => `<div class="table-edit-pair"><button type="button" class="clickable-card table-slot" data-pick-zone="attack" data-pick-index="${index}" aria-label="Изменить атаку ${cardName(pair.attack)}">${cardHtml(pair.attack)}</button><span class="pair-arrow" aria-hidden="true">→</span><button type="button" class="clickable-card table-slot ${pair.defense?'':'empty'}" data-pick-zone="defense" data-pick-index="${index}" aria-label="${pair.defense?`Изменить покрытие ${cardName(pair.defense)}`:`Выбрать покрытие для ${cardName(pair.attack)}`}">${pair.defense?cardHtml(pair.defense):'<span>＋<small>Покрыть</small></span>'}</button><button type="button" class="table-remove" data-remove-pair="${index}" aria-label="Убрать ошибочно добавленную пару ${index+1}" title="Убрать ошибочно добавленную пару">×</button></div>`).join('') : '<span class="zone-empty">Стол пуст. Если на вас пошли — нажмите «Добавить атаку».</span>';
  $('known-opponent-count').textContent = String(view.knownOpponent.length); $('discard-count').textContent = view.historyComplete===false?'—':String(view.discard.length);
  $('opponent-cards').innerHTML = view.knownOpponent.length ? view.knownOpponent.map(miniCardHtml).join('') : '<span class="zone-empty">Можно оставить пустым, пока карты неизвестны</span>';
  $('discard-cards').innerHTML = view.historyComplete===false?'<span class="zone-empty">История неполная. Совет рассчитан по текущим картам; прежняя память сохранена.</span>':view.discard.length ? view.discard.map(miniCardHtml).join('') : '<span class="zone-empty">В начале партии здесь пусто</span>';
  const tableEmpty = !state.table.length;
  $('discard-button').disabled = draftDirty || tableEmpty || state.table.some((pair) => !pair.defense); $('opponent-took-button').disabled = draftDirty || tableEmpty; $('i-took-button').disabled = draftDirty || tableEmpty;
  renderAdvice();
  renderMode();
}
function renderAdvice() {
  $('hand-cards').querySelectorAll('.recommended').forEach((card) => card.classList.remove('recommended'));
  if(mode==='auto'&&(!(autoReady||autoSnapshot)||!autoFresh||!$('auto-review').hidden)) {
    $('memory-count').textContent=autoReady?'Последняя подтверждённая позиция':'Ожидает первого кадра';
    $('probability-stats').innerHTML='<div><b>—</b><span>расчёт появится после<br>проверки позиции</span></div>';
    $('advice-content').innerHTML=!$('auto-review').hidden?`<div class="empty-advice"><span>◉</span><h3>${escapeHtml($('auto-review-title').textContent)}</h3><p>${escapeHtml($('auto-review-message').textContent)}</p></div>`:!(autoReady||autoSnapshot)?'<div class="empty-advice"><span>◉</span><h3>Совет появится автоматически</h3><p>Выберите окно игры. Карты, козырь и текущий ход помощник определит сам.</p></div>':'<div class="empty-advice"><h3>Ожидаем актуальный кадр</h3><p>Карты изменились или наблюдение остановлено. Совет обновится после проверки текущего окна.</p></div>';
    return;
  }
  let analysis;
  const adviceState=mode==='auto'&&autoSnapshot?autoSnapshot.state:state;
  try { analysis = mode==='auto'&&autoSnapshot?autoSnapshot.analysis:analyze(state, { gameProfile: mode === 'auto' ? gameProfile : null }); } catch (error) { $('advice-content').innerHTML = `<div class="advice-errors">Не удалось рассчитать позицию: ${escapeHtml(error.message)}</div>`; return; }
  $('memory-count').textContent = `${analysis.knownCount ?? '—'} карт известны`;
  $('probability-stats').innerHTML = `<div><b>${analysis.unseenCount ?? '—'}</b><span>неизвестных карт<br>в руке соперника и колоде</span></div><div><b>${percent(analysis.opponentTrumpProbability)}</b><span>вероятность хотя бы одного<br>козыря у соперника</span></div>`;
  if(analysis.historyComplete===false) {
    $('memory-count').textContent='Совет по текущему кадру';
    $('probability-stats').innerHTML='<div><b>◉</b><span>Карты распознаны<br>совет доступен</span></div><div><b>—</b><span>История неполная<br>вероятности не вычисляются</span></div>';
  }
  if (draftDirty) {
    $('memory-count').textContent = 'Ожидает подтверждения';
    $('probability-stats').innerHTML = '<div><b>—</b><span>неизвестные карты<br>после подтверждения</span></div><div><b>—</b><span>вероятность козыря<br>после подтверждения</span></div>';
    $('advice-content').innerHTML = '<div class="draft-waiting"><h3>Позиция редактируется</h3><p>Проверьте данные и нажмите «Сохранить и рассчитать». Рекомендации появятся после подтверждения корректной позиции.</p></div>'; return;
  }
  if (!analysis.valid) { $('advice-content').innerHTML = `<div class="advice-errors">Уточните позицию в редакторе.<ul>${(analysis.errors || []).map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul></div>`; return; }
  if(analysis.waiting) { $('advice-content').innerHTML=`<div class="empty-advice"><span>◉</span><h3>Ожидайте ход соперника</h3><p>${escapeHtml(analysis.waitingMessage||'Наблюдение продолжается. При изменении карт совет обновится автоматически.')}</p></div>`; return; }
  if (!adviceState.hand.length && adviceState.stockCount === 0) { $('advice-content').innerHTML = '<div class="empty-advice"><span>✧</span><h3>Ваша рука пуста</h3><p>Добора больше нет. Результат зависит от оставшихся карт соперника и завершения защиты.</p></div>'; return; }
  if (!adviceState.hand.length && !adviceState.table.length) { $('advice-content').innerHTML = mode==='auto'?'<div class="empty-advice"><h3>Ожидаем раздачу</h3><p>Наблюдение продолжается автоматически.</p></div>':'<div class="empty-advice"><span>✧</span><h3>Начнём с вашей руки</h3><p>Выберите свои карты, козырь и сохраните позицию.</p></div>'; return; }
  const recs = analysis.recommendations || [];
  if (!recs.length) { $('advice-content').innerHTML = '<div class="empty-advice"><span>✧</span><h3>Нужна новая позиция</h3><p>Для текущего состояния нет рассчитанных действий. Уточните ход, стол и карты в руке.</p></div>'; return; }
  selectedRecommendation = Math.min(selectedRecommendation, recs.length - 1);
  const best = recs[selectedRecommendation];
  const actionNames = { attack: 'Атака', defend: 'Защита', transfer: 'Перевод', take: 'Взять карты', pass: 'Завершить подкидывание' };
  const safeTitle = escapeHtml(best.title || actionNames[best.type] || 'Рекомендация');
  const probabilityLabel = best.type === 'attack' ? 'Вероятность, что у соперника есть карта для покрытия этой атаки' : 'Вероятность, что у соперника есть карта для покрытия только добавленной карты';
  const probability = best.responseProbability == null ? '' : `<div class="probability-callout"><p>${probabilityLabel}</p><b>${percent(best.responseProbability).replace('%', '<small>%</small>')}</b></div>`;
  const renderAlternative = (rec, index) => `<button class="alternative" data-recommendation="${index}" aria-pressed="${index === selectedRecommendation}"><span class="alternative-number">${String(index + 1).padStart(2, '0')}</span>${rec.card ? miniCardHtml(rec.card) : ''}<span class="alternative-title">${escapeHtml(rec.title || actionNames[rec.type] || 'Ход')}</span><span class="alternative-score">${Number.isFinite(rec.score) ? rec.score.toFixed(1) : '—'}</span><span class="alternative-arrow" aria-hidden="true">↗</span></button>`;
  const remainingAlternatives = recs.length > 5 ? `<details class="more-alternatives"><summary>Ещё ${recs.length - 5} вариантов <span>Все ходы: ${recs.length}</span></summary><div>${recs.slice(5).map((rec, index) => renderAlternative(rec, index + 5)).join('')}</div></details>` : '';
  $('advice-content').innerHTML = `<div class="best-label"><span>✧</span> ${selectedRecommendation === 0 ? 'РЕКОМЕНДУЕМЫЙ ВАРИАНТ' : 'ВЫБРАННЫЙ ВАРИАНТ'}</div><div class="best-recommendation">${best.card ? `<div class="recommendation-card">${cardHtml(best.card, 'large')}</div>` : ''}<div><h3 class="recommendation-title">${safeTitle}</h3><div class="recommendation-action">${escapeHtml(actionNames[best.type] || '')}${Number.isInteger(best.target) && adviceState.table[best.target] ? ` · против ${cardName(adviceState.table[best.target].attack)}` : ''}</div></div></div><ul class="reason-list">${(best.reasons || []).slice(0, 3).map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>${probability}<div class="alternative-header"><span>ВАРИАНТЫ ХОДА</span><span>ОЦЕНКА ЭВРИСТИКИ</span></div>${recs.slice(0, 5).map(renderAlternative).join('')}${remainingAlternatives}<div class="assumption-note">${escapeHtml((analysis.assumptions || []).slice(0, 1).join(' '))}</div>`;
  $('hand-cards').querySelectorAll('.playing-card').forEach((card, index) => card.classList.toggle('recommended', adviceState.hand[index] === best.card));
  if(mode==='manual'&&['attack','defend','transfer'].includes(best.type)) {
    const record=document.createElement('button'); record.type='button'; record.className='secondary-button record-move-button'; record.textContent='Я так походил — обновить позицию';
    record.addEventListener('click',()=>{try { const next=playFromHand(state,best.card,{type:best.type,...(best.target!==null?{target:best.target}:{})}); commit(next,'manual','Ход отмечен: карта перенесена из вашей руки на стол. Теперь укажите ответ соперника.'); } catch(error) {showNotice(error.message,true);} });
    $('advice-content').querySelector('.alternative-header').before(record);
  }
}
function openEditor() { if(mode!=='manual') return; $('editor-details').open = true; $('editor-details').scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => $('field-opponentCount').focus({ preventScroll: true }), 100); }
function prepareRound(kind) {
  if (draftDirty && !confirm('В редакторе есть неподтверждённые правки. Заменить их результатом взятки?')) return;
  const next = clone(state); const cards = allTableCards(next); if (!cards.length) return;
  if (kind === 'discard' && next.table.some((pair) => !pair.defense)) { showNotice('В отбой можно отправить только полностью покрытый стол.', true); return; }
  if (kind === 'discard') next.discard.push(...cards);
  if (kind === 'opponent') { next.knownOpponent.push(...cards); next.opponentCount += cards.length; }
  if (kind === 'me') next.hand.push(...cards);
  next.table = [];
  writeForm(next); markDraft(); openEditor();
  showNotice('Результат взятки добавлен в черновик. Проверьте добор, количество карт и следующий ход, затем примените позицию.');
}
function newSession() {
  if(mode==='auto') {
    if(autoReady&&!confirm('Начать наблюдение за новой партией? Память автоматической партии будет очищена.')) return;
    pauseAuto(); autoSnapshot=null; lastCurrentScene=null; autoRecovery.reset(); autoSessionTracker.reset(); monitor?.resetFrames(); requestController?.abort(); captureGeneration++; confirmedSignature=null; autoReady=false; state=clone(EMPTY); source='empty'; history=[]; autoEvents=[]; reviewObservation=null; correctionBaseline=null; $('auto-review').hidden=true;
    try {localStorage.removeItem(AUTO_STORE_KEY);} catch { /* Storage may be disabled. */ }
    writeForm(state); render(); renderAutoEvents(); setAutoStatus('idle','Новая партия. Запустите автоанализ с начала раздачи.'); return;
  }
  const hasCards = state.hand.length || state.discard.length || state.table.length || state.knownOpponent.length;
  if ((hasCards || draftDirty) && !confirm('Начать новую партию с пустой позицией? Текущую позицию можно вернуть кнопкой «Отменить».')) return;
  commit(clone(EMPTY), 'manual', 'Выберите свои карты, затем козырь. У соперника по умолчанию 6 карт, остаток колоды считается автоматически.'); openPicker('hand');
}
async function startCapture() {
  if (!navigator.mediaDevices?.getDisplayMedia) { showNotice('В этом браузере захват экрана недоступен. Откройте приложение в современном Chrome или Edge через localhost. Ручной ввод работает без захвата.', true); return; }
  try {
    const selected = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    pauseAuto(); autoSnapshot=null; lastCurrentScene=null; $('snapshot-preview').hidden=true; requestController?.abort(); captureGeneration++; confirmedSignature=null;
    gameRegion=null; captureSize=''; autoFrameMemory.length=0; providerRequests=0; cachedRecognitions=0; renderAutoCounters();
    if (stream) stream.getTracks().forEach((track) => track.stop()); stream = selected;
    $('screen-video').srcObject = stream; $('screen-video').hidden = false; $('screen-placeholder').hidden = true; $('screen-live-label').hidden = false; $('stop-button').hidden = false;
    $('stop-button').textContent='Остановить';
    $('capture-status').textContent = 'ПРЕДПРОСМОТР ВКЛЮЧЁН'; $('capture-status').classList.add('live');
    stream.getVideoTracks()[0].addEventListener('ended', () => { if (stream === selected) stopCapture(); });
    await $('screen-video').play(); applyConfig(config);
    if(mode==='auto'&&config.visionConfigured) await startAuto();
  } catch (error) { if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') showNotice(`Не удалось открыть демонстрацию: ${error.message}`, true); }
}
function stopCapture() {
  pauseAuto(); requestController?.abort(); captureGeneration++;
  if (stream) stream.getTracks().forEach((track) => track.stop()); stream = null;
  $('screen-video').srcObject = null; $('screen-video').hidden = true; $('screen-placeholder').hidden = false; $('screen-live-label').hidden = true; $('stop-button').hidden = true;
  $('snapshot-preview').hidden=true;$('snapshot-preview').removeAttribute('src');
  $('capture-status').textContent = 'ОКНО НЕ ВЫБРАНО'; $('capture-status').classList.remove('live'); updateRecognizeButton();
  gameRegion=null; captureSize=''; $('game-region-status').textContent='Окно не выбрано. Платные запросы не выполняются.';
}
function updateRecognizeButton() {
  const running=monitor?.getState().running===true;
  $('recognize-button').disabled = mode!=='auto'||!stream || !config.visionConfigured || recognitionBusy || running;
  $('recognize-button').innerHTML = recognitionBusy ? '<span class="busy-icon">✧</span> Читаем карты…' : '<span aria-hidden="true">✧</span> Проверить один кадр';
  $('auto-start').disabled=mode!=='auto'||!stream||!config.visionConfigured||recognitionBusy||running;
  $('auto-pause').hidden=!running; $('auto-start').hidden=running;
  $('auto-interval').disabled=running; $('auto-budget').disabled=running;
  $('auto-retry').disabled=!stream||!config.visionConfigured||recognitionBusy||running;
  $('mode-stop-window').hidden=!stream;
}
async function loadConfig() {
  try {
    const response = await fetch('/api/config'); if (!response.ok) throw new Error('Сервер настроек недоступен'); config = await response.json();
    applyConfig(config);
  } catch { $('vision-config').textContent = 'Нет связи с локальным сервером. Выбор карт и расчёты работают в этом окне.'; }
  updateRecognizeButton();
}
async function recognizeFrame() {
  if (mode!=='auto'||!stream || !config.visionConfigured || recognitionBusy || monitor?.getState().running) return;
  const token=captureGeneration; const controller = new AbortController(); requestController=controller;
  recognitionBusy = true; updateRecognizeButton();
  try {
    const frame=captureFrame(); setAutoStatus('recognizing','Читаем текущий кадр…');
    const observation=await requestObservation(frame.image,{signal:controller.signal});
    if(mode==='auto'&&token===captureGeneration&&!controller.signal.aborted) {
      if(signaturesChanged(frame.signature,captureFrame().signature)) {setAutoStatus('stale','Окно изменилось, пока модель отвечала. Повторите анализ текущего кадра.');return;}
      handleAutoObservation(observation);
    }
  } catch (error) { if(token===captureGeneration) {setAutoStatus('error','Не удалось распознать кадр. Позиция сохранена.');showNotice(error.name === 'AbortError' ? 'Время ожидания распознавания истекло. Позиция не изменена; попробуйте ещё раз.' : `Распознавание не выполнено: ${error.message}`, true);} }
  finally { if(requestController===controller) requestController=null; recognitionBusy = false; updateRecognizeButton(); }
}
function invalidateVision() { visionProposal = null; $('apply-vision-button').disabled = true; $('vision-review').hidden = true; showErrors('vision-errors', []); }
function readObservation() {
  const text = $('vision-json').value; if (text.length > 100000) throw new Error('Результат распознавания слишком большой.');
  const obs = JSON.parse(text); if (!obs || typeof obs !== 'object' || Array.isArray(obs)) throw new Error('Ожидается JSON-объект распознанной позиции.');
  const missing = ['hand', 'table', 'trumpSuit', 'opponentCount', 'stockCount', 'role'].filter((key) => obs[key] === null || obs[key] === undefined);
  if (missing.length) throw new Error(`Уточните нераспознанные поля: ${missing.join(', ')}. Значение null не заменяется нулём или пустой рукой.`);
  if (!Object.hasOwn(obs, 'trumpCard')) throw new Error('Добавьте trumpCard: карту открытого козыря или null, если карта не распознана.');
  if (!Array.isArray(obs.hand) || obs.hand.length > 36 || obs.hand.some((id) => typeof id !== 'string' || !CARD_PATTERN.test(id))) throw new Error('hand: нужен массив корректных карт, например ["6C", "AS"].');
  if (!Array.isArray(obs.table) || obs.table.length > 6 || obs.table.some((pair) => !pair || !CARD_PATTERN.test(pair.attack) || (pair.defense !== null && !CARD_PATTERN.test(pair.defense)))) throw new Error('table: нужны пары {"attack":"8C","defense":null}, не более шести.');
  if (!Object.hasOwn(SUITS, obs.trumpSuit) || !['attack', 'defend'].includes(obs.role)) throw new Error('Уточните trumpSuit (C/D/H/S) и role (attack/defend).');
  if (obs.trumpCard !== null && !CARD_PATTERN.test(obs.trumpCard)) throw new Error('trumpCard должен быть корректной картой или null.');
  for (const key of ['stockCount', 'opponentCount']) if (!Number.isInteger(obs[key]) || obs[key] < 0 || obs[key] > 36) throw new Error(`${key}: нужно целое число от 0 до 36.`);
  return obs;
}
function prepareVision() {
  invalidateVision();
  try {
    const obs = readObservation(); const replacingDemo = source === 'demo'; const candidate = clone(replacingDemo ? EMPTY : state);
    const retainedTrump = obs.trumpCard === null && obs.stockCount > 0 && candidate.trumpCard !== null;
    const observedTrump = obs.trumpCard === null && obs.stockCount > 0 ? candidate.trumpCard : obs.trumpCard;
    Object.assign(candidate, { hand: [...obs.hand], table: obs.table.map((pair) => ({ attack: pair.attack, defense: pair.defense })), trumpSuit: obs.trumpSuit, trumpCard: observedTrump, opponentCount: obs.opponentCount, stockCount: obs.stockCount, role: obs.role });
    const visible = new Set([...candidate.hand, ...allTableCards(candidate)]);
    const movedKnown = candidate.knownOpponent.filter((id) => visible.has(id)); candidate.knownOpponent = candidate.knownOpponent.filter((id) => !visible.has(id));
    const vanished = [...new Set(replacingDemo ? [] : [...state.hand, ...allTableCards(state)])].filter((id) => !visible.has(id) && !candidate.discard.includes(id) && !candidate.knownOpponent.includes(id));
    visionProposal = { candidate, vanished, movedKnown };
    $('vision-review').className = 'vision-review'; $('vision-review').hidden = false;
    $('vision-review').innerHTML = `<h3>Проверьте обновление памяти</h3>${replacingDemo ? '<p>Демонстрационный пример будет заменён вашей позицией. Карты примера не добавляются в память партии.</p>' : ''}<p>Рука: ${candidate.hand.length} · на столе: ${allTableCards(candidate).length} · у соперника: ${candidate.opponentCount} · в колоде: ${candidate.stockCount}.</p>${retainedTrump ? `<p>Открытый козырь не распознан. Сохраняется ранее подтверждённая карта <b>${cardName(candidate.trumpCard)}</b>. Если она изменилась, исправьте trumpCard в JSON.</p>` : obs.trumpCard === null && obs.stockCount > 0 ? '<p>Открытый козырь неизвестен. Укажите его в JSON, если карта видна: это сделает вероятности точнее.</p>' : ''}<label class="field">Лимит атак в текущем заходе<select id="vision-limit">${[0, 1, 2, 3, 4, 5, 6].map((limit) => `<option value="${limit}" ${candidate.attackLimit === limit ? 'selected' : ''}>${limit} карт</option>`).join('')}</select></label><p class="small-help">После перевода или нового захода проверьте лимит: он зависит от руки принимающего в начале захода.</p>${movedKnown.length ? `<p>Из известных карт соперника в видимые зоны переходят: <b>${movedKnown.map(cardName).join(', ')}</b>. Они будут убраны из списка его руки.</p>` : ''}${vanished.length ? '<p>Эти карты исчезли из руки или со стола. Для каждой укажите фактическое местонахождение:</p>' : '<p>Ни одна прежняя карта руки или стола не потеряна. Отбой сохраняется.</p>'}${vanished.map((id) => `<label class="reconcile-row"><span>${miniCardHtml(id)}</span><select data-reconcile="${id}" aria-label="Куда перешла ${cardName(id)}"><option value="">Уточните местонахождение</option><option value="discard">В отбой</option><option value="opponent">У соперника</option><option value="hand">Осталась у меня</option></select></label>`).join('')}<p class="small-help">Если карта всё ещё на столе, добавьте её в table в JSON и проверьте позицию заново. Память нельзя пополнять предположениями.</p>`;
    refreshVisionValidation();
  } catch (error) { showErrors('vision-errors', [error.message]); }
}
function reconciledVisionState() {
  if (!visionProposal) throw new Error('Сначала проверьте позицию.');
  const next = clone(visionProposal.candidate); const unresolved = [];
  next.attackLimit = Number($('vision-limit').value);
  $('vision-review').querySelectorAll('[data-reconcile]').forEach((select) => {
    const id = select.dataset.reconcile;
    if (!select.value) unresolved.push(cardName(id));
    if (select.value === 'discard') next.discard.push(id);
    if (select.value === 'opponent') next.knownOpponent.push(id);
    if (select.value === 'hand') next.hand.push(id);
  });
  if (unresolved.length) throw new Error(`Укажите местонахождение исчезнувших карт: ${unresolved.join(', ')}.`);
  return next;
}
function refreshVisionValidation() {
  try { const next = reconciledVisionState(); const errors = getErrors(next); showErrors('vision-errors', errors); $('apply-vision-button').disabled = errors.length > 0; }
  catch (error) { showErrors('vision-errors', [error.message]); $('apply-vision-button').disabled = true; }
}

function renderMode() {
  document.body.dataset.mode=mode; document.body.dataset.autoReady=String(autoReady||Boolean(autoSnapshot));
  $('mode-auto').setAttribute('aria-selected',String(mode==='auto')); $('mode-manual').setAttribute('aria-selected',String(mode==='manual'));
  $('mode-auto').tabIndex=mode==='auto'?0:-1; $('mode-manual').tabIndex=mode==='manual'?0:-1;
  $('manual-mode-note').hidden=mode!=='manual'; $('auto-empty').hidden=mode!=='auto'||autoReady||Boolean(autoSnapshot);
  document.querySelector('h1').innerHTML=mode==='auto'?'Откройте игру.<br><span>Помощник следит за картами.</span>':'Выберите карты.<br><span>Получите совет.</span>';
  document.querySelector('.page-header > div > p').textContent=mode==='auto'?`Автоматический анализ выбранного окна · ${gameProfile==='hlop-singleplayer'?'durak.hlop.de · с компьютером':'переводной дурак'} · 36 карт`:'Запасной режим. Карты выбираются кликами, колода считается автоматически.';
  $('position-title').textContent=mode==='auto'?'Распознанная позиция':'Ваша позиция';
  document.querySelector('.memory-note').textContent=mode==='auto'?'Память обновляется автоматически. Нечёткие кадры перепроверяются; подтверждённые карты сохраняются.':'Уточняйте отбой и известные карты соперника кликами после каждого кона.';
  for(const button of document.querySelectorAll('[data-pick-zone],[data-remove-pair]')) button.disabled=mode==='auto';
  if(mode==='auto'&&(autoReady||autoSnapshot)&&!(autoSnapshot?.state??state).table.length) $('table-cards').innerHTML='<span class="zone-empty">Стол пуст. Ожидаем следующий ход в выбранном окне.</span>';
  updateRecognizeButton();
}
function switchMode(nextMode) {
  if(nextMode===mode) return;
  if(pickerDirty) finishPicker(); else if($('card-picker-dialog').open) closePicker();
  if(draftDirty) persistDraft();
  sessions[mode]={state:clone(state),source,history:clone(history),restorationFailed};
  pauseAuto(); requestController?.abort(); captureGeneration++;
  mode=nextMode; const cached=sessions[mode];
  state=clone(cached?.state||EMPTY); source=cached?.source||'empty'; history=clone(cached?.history||[]); restorationFailed=cached?.restorationFailed||false;
  if(!cached) loadSession();
  writeForm(state,false); loadDraft(); render();
  const dashboard=document.querySelector('.dashboard-grid');
  for(const name of mode==='auto'?['capture','advice','position','memory']:['position','advice','memory','capture']) dashboard.append(document.querySelector(`.${name}-panel`));
  for(const [index,name] of (mode==='auto'?['capture','advice','position','memory']:['position','advice','memory','capture']).entries()) document.querySelector(`.${name}-panel .section-number`).textContent=String(index+1).padStart(2,'0');
}
function setAutoStatus(phase,message) {
  $('auto-status').dataset.phase=phase;
  if(['idle','stabilizing','recognizing','stale','error','retrying','observing','locating'].includes(phase)) {
    autoFresh=false;if(mode==='auto')renderAdvice();
  }
  let summary='';
  if(mode==='auto'&&autoFresh&&['watching','unchanged','limit'].includes(phase)) {
    const current=autoSnapshot?.analysis??(autoReady?analyze(state, { gameProfile }):null);
    summary=current?.waiting?'Ожидайте ход соперника':current?.recommendations?.[0]?.title??'';
  }
  $('auto-status').textContent=summary?`Совет: ${summary}${phase==='limit'?`. ${message}`:''}`:message;
}
function applyConfig(next) {
  config=next; const provider=config.providerLabel||'GenAPI';
  $('auto-provider').textContent=`${provider} · ${config.model||'gpt-6-luna'}`;
  $('vision-config').textContent=config.visionConfigured?`Отправит один текущий кадр в ${provider}. Запрос оплачивается отдельно.`:'Подключите ключ в «Настройки ИИ», затем выберите окно игры.';
  $('auto-disclosure').textContent=`В ${provider} передаётся область игрового стола. Неизменившаяся распознанная позиция не оплачивается повторно. Если карты прочитаны не полностью, помощник сделает до двух дополнительных платных проверок в пределах лимита. Неполная история партии не мешает совету по видимым картам.`;
  document.querySelector('.capture-footer p').innerHTML='Предпросмотр работает локально.<small>После запуска анализа кадры выбранного окна передаются выбранному провайдеру ИИ.</small>';
  if(!monitor?.getState().running&&$('auto-review').hidden) setAutoStatus('idle',!config.visionConfigured?'Добавьте API-ключ через «Настройки ИИ».':!stream?'Ключ подключён. Выберите окно игры — анализ начнётся автоматически.':'Окно подключено. Можно продолжить автоанализ.');
  updateRecognizeButton();
}
function captureFrame() {
  const video=$('screen-video');
  if(!stream||!video.videoWidth||!video.videoHeight) throw new Error('Предпросмотр ещё не готов. Выберите окно и дождитесь изображения.');
  const dimensions=`${video.videoWidth}:${video.videoHeight}`;
  if(dimensions!==captureSize) {gameRegion=null;captureSize=dimensions;}
  if(!gameRegion) {
    const scan=document.createElement('canvas'); const scale=Math.min(1,640/video.videoWidth);
    scan.width=Math.round(video.videoWidth*scale); scan.height=Math.round(video.videoHeight*scale);
    const context=scan.getContext('2d',{willReadFrequently:true});context.drawImage(video,0,0,scan.width,scan.height);
    gameRegion=detectGameRegion(context.getImageData(0,0,scan.width,scan.height)); scan.width=0;
    if(!gameRegion) {
      $('game-region-status').textContent='Ищем игровой стол локально. Пока стол не найден, запросов в ИИ нет.';
      throw Object.assign(new Error('Игровой стол пока не найден. Наблюдаем локально без платных запросов.'),{localOnly:true});
    }
    $('game-region-status').textContent='Игровой стол найден. Для сравнения и отправки используется только эта область.';
  }
  return encodeGameFrame(video,video.videoWidth,video.videoHeight,gameRegion);
}
function encodeGameFrame(surface,surfaceWidth,surfaceHeight,region) {
  const x=Math.floor(region.x*surfaceWidth), y=Math.floor(region.y*surfaceHeight);
  const width=Math.min(surfaceWidth-x,Math.ceil(region.width*surfaceWidth));
  const height=Math.min(surfaceHeight-y,Math.ceil(region.height*surfaceHeight));
  const canvas=document.createElement('canvas'); const factor=Math.min(1,1600/Math.max(width,height));
  canvas.width=Math.round(width*factor); canvas.height=Math.round(height*factor);
  canvas.getContext('2d').drawImage(surface,x,y,width,height,0,0,canvas.width,canvas.height);
  const image=canvas.toDataURL('image/jpeg',.84);
  const small=document.createElement('canvas'); small.width=64; small.height=36;
  const context=small.getContext('2d',{willReadFrequently:true}); context.drawImage(canvas,0,0,64,36);
  const pixels=context.getImageData(0,0,64,36).data; const signature=new Uint8Array(64*36);
  for(let i=0;i<signature.length;i++) signature[i]=Math.round(.299*pixels[i*4]+.587*pixels[i*4+1]+.114*pixels[i*4+2]);
  canvas.width=0; small.width=0; return {image,signature};
}
async function recognizeScreenshot(file) {
  if(!file||mode!=='auto'||recognitionBusy) return;
  await loadConfig();
  if(!config.visionConfigured) {showNotice('Сначала подключите ИИ в настройках.',true);return;}
  pauseAuto(); requestController?.abort();
  recognitionBusy=true; updateRecognizeButton();
  const controller=new AbortController(); requestController=controller;
  const positionKey=`snapshot:${++singleFrameSequence}`;
  let bitmap;
  try {
    if(file.size>12_000_000) throw new Error('Снимок должен быть не больше 12 МБ.');
    bitmap=await createImageBitmap(file);
    const scan=document.createElement('canvas'),scale=Math.min(1,640/bitmap.width);
    scan.width=Math.round(bitmap.width*scale);scan.height=Math.round(bitmap.height*scale);
    const context=scan.getContext('2d',{willReadFrequently:true});context.drawImage(bitmap,0,0,scan.width,scan.height);
    const region=detectGameRegion(context.getImageData(0,0,scan.width,scan.height));scan.width=0;
    if(!region) throw new Error('На снимке не найден игровой стол. Выберите снимок с видимыми картами и столом.');
    const frame=encodeGameFrame(bitmap,bitmap.width,bitmap.height,region);
    $('snapshot-preview').src=frame.image;$('snapshot-preview').hidden=false;
    $('screen-video').hidden=true;$('screen-placeholder').hidden=true;
    $('screen-live-label').hidden=true;$('stop-button').hidden=false;$('stop-button').textContent='Закрыть снимок';
    $('capture-status').textContent='СНИМОК ИГРЫ';$('capture-status').classList.remove('live');
    $('game-region-status').textContent='Анализ снимка: игровой стол найден автоматически.';
    autoRecovery.reset();
    for(let retryAttempt=0;retryAttempt<=2;retryAttempt++) {
      setAutoStatus('recognizing',retryAttempt?'Повторно проверяем карты на снимке…':'Распознаём карты на снимке…');
      const observation=await requestObservation(frame.image,{signal:controller.signal,positionKey,retryAttempt,confirmation:retryAttempt>0});
      if(controller.signal.aborted||mode!=='auto') return;
      const decision=handleAutoObservation(observation,{positionKey,signature:frame.signature});
      if(!decision?.retry) break;
    }
  } catch(error) {if(error.name!=='AbortError') {setAutoStatus('error',error.message);showNotice(error.message,true);}}
  finally {bitmap?.close();if(requestController===controller)requestController=null;recognitionBusy=false;updateRecognizeButton();}
}
function renderAutoCounters() {
  $('auto-counters').textContent=`Запросов к ИИ: ${providerRequests} · из кеша: ${cachedRecognitions} · лимит: ${$('auto-budget').value}`;
}
async function requestObservation(image,{signal,positionKey,confirmation=false,retryAttempt=confirmation?1:0}={}) {
  let release; const previous=requestTail;
  requestTail=new Promise(resolve=>{release=resolve;});
  const controller=new AbortController(); const abort=()=>controller.abort();
  if(signal?.aborted) controller.abort(); else signal?.addEventListener('abort',abort,{once:true});
  const timeout=setTimeout(abort,95000);
  try {
    await previous;
    const wait=Math.max(0,Number($('auto-interval').value)-(Date.now()-lastRequestAt));
    if(wait) await new Promise((resolve,reject)=>{
      const cancelled=()=>{clearTimeout(timer);reject(new DOMException('Отменено','AbortError'));};
      const timer=setTimeout(()=>{controller.signal.removeEventListener('abort',cancelled);resolve();},wait);
      if(controller.signal.aborted) cancelled(); else controller.signal.addEventListener('abort',cancelled,{once:true});
    });
    if(controller.signal.aborted) throw new DOMException('Отменено','AbortError');
    if(providerRequests>=Number($('auto-budget').value)) throw Object.assign(new Error('Достигнут лимит запросов для этого подключения окна.'),{status:429});
    lastRequestAt=Date.now();
    const frameKey=`${pageCaptureId}:${captureGeneration}:${positionKey??`single-${++singleFrameSequence}`}`;
    // Count an in-flight/aborted attempt conservatively: a provider may already
    // have accepted it even if the browser never receives its response.
    providerRequests++; renderAutoCounters();
    const response=await fetch('/api/vision',{method:'POST',headers:{'Content-Type':'application/json','X-Durak-Capture-Version':'3'},body:JSON.stringify({image,frameKey,confirmation,retryAttempt}),signal:controller.signal});
    const result=await response.json();
    if(result.upstreamRequested===false) providerRequests=Math.max(0,providerRequests-1);
    if(result.cached===true) cachedRecognitions++;
    renderAutoCounters();
    if(!response.ok) { const error=new Error(typeof result.error==='string'?result.error:'Сервер не смог распознать кадр.'); error.status=response.status; throw error; }
    if(!result.observation||typeof result.observation!=='object') throw new Error('Сервер вернул пустое распознавание.');
    return result.observation;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort',abort); release(); }
}
function renderAutoEvents() { $('auto-events').innerHTML=autoEvents.length?autoEvents.map(line=>`<li>${escapeHtml(line)}</li>`).join(''):'<li>Пока нет изменений.</li>'; }
function archiveAutomaticPosition() {
  const entry={version:1,state:clone(state),source,updatedAt:new Date().toISOString(),reason:'automatic-new-game'};
  automaticArchives.push(entry);
  try {localStorage.setItem(`${AUTO_STORE_KEY}.archive.${Date.now()}.${automaticArchives.length}`,JSON.stringify(entry));}
  catch {showNotice('Предыдущая партия сохранена в памяти этого окна. Браузер не разрешил записать её архив на устройство.',true);}
}
function handleAutoObservation(observation, frameContext) {
  if(mode!=='auto') return;
  const context=frameContext||{positionKey:`single:${++singleFrameSequence}`};
  const {memory:result,snapshot,decision}=resolveAutomaticObservation(autoReady?state:null,observation,{session:autoSessionTracker,recovery:autoRecovery,previousScene:lastCurrentScene,...context,gameProfile});
  if(result.status==='review'&&!snapshot) {
    autoSnapshot=null; confirmedSignature=null;
    reviewObservation=clone(observation); correctionBaseline=autoReady?clone(state):null;
    autoFresh=false; $('auto-review-reasons').innerHTML=decision.reasons.map(reason=>`<li>${escapeHtml(reason)}</li>`).join(''); $('auto-review').hidden=false;
    $('auto-review-title').textContent=decision.retry?'Автоматически перечитываем карты':'Не удалось прочитать карты после трёх проверок';
    $('auto-review-message').textContent=decision.message;
    setAutoStatus(decision.retry?'retrying':'observing',$('auto-review-message').textContent); render(); return decision;
  }
  $('auto-review').hidden=true; reviewObservation=null; correctionBaseline=null;
  autoSnapshot=snapshot;
  lastCurrentScene={...clone(snapshot?.state??result.state??state),historyComplete:false};
  autoFresh=true;
  confirmedSignature=context.signature??captureFrame().signature;
  selectedRecommendation=0;
  if(snapshot) {
    if(result.status==='accepted') {
      if(result.newSession) archiveAutomaticPosition();
      autoReady=true; commit(result.state,'auto');
    }
    const message=snapshot.analysis.waiting?'Карты распознаны. Ожидайте ход соперника.':'Карты распознаны. Совет рассчитан по текущему столу.';
    autoEvents=[message,...autoEvents].slice(0,12); renderAutoEvents();
    setAutoStatus('watching',message); render(); return {...decision,message};
  }
  if(result.status==='accepted') {
    if(result.newSession) archiveAutomaticPosition();
    autoReady=true; commit(result.state,'auto');
    const events=result.newSession?['Новая партия определена автоматически. Предыдущая позиция сохранена в архив.',...result.events.filter(line=>!line.includes('следует сохранить'))]:result.events;
    autoEvents=[...events,...autoEvents].slice(0,12); renderAutoEvents();
    setAutoStatus('watching','Позиция обновлена. Следим за следующим ходом.');
  } else { setAutoStatus('unchanged','Карты и счётчики не изменились.'); renderAdvice(); }
  return decision;
}
function pauseAuto() { autoFresh=false; monitor?.stop(); if(mode==='auto')renderAdvice(); updateRecognizeButton(); }
async function startAuto() {
  await loadConfig();
  if(mode!=='auto'||!stream||!config.visionConfigured||recognitionBusy||monitor?.getState().running) return;
  $('snapshot-preview').hidden=true;$('screen-video').hidden=false;
  $('auto-review').hidden=true; autoFresh=false; renderAdvice();
  autoRecovery.reset();
  autoSessionTracker.reset();
  const options=`${$('auto-interval').value}:${$('auto-budget').value}`;
  if(!monitor||monitorOptions!==options) monitor=createAutoMonitor({
    capture:captureFrame, recognize:requestObservation, onResult:handleAutoObservation,
    frameMemory:autoFrameMemory,
    minRequestIntervalMs:Number($('auto-interval').value), maxRequests:Number($('auto-budget').value),
    onStatus:({phase,requests,message})=>{
      setAutoStatus(phase,message);
      if(phase==='unchanged'&&(autoReady||autoSnapshot)&&confirmedSignature&&$('auto-review').hidden&&mode==='auto') {
        try {autoFresh=!signaturesChanged(confirmedSignature,captureFrame().signature);renderAdvice();} catch {autoFresh=false;}
      }
      renderAutoCounters(); updateRecognizeButton();
    },
    onError:(error,{fatal})=>{showNotice(`Автоанализ: ${error.message}`,true); if(fatal) setAutoStatus('error',error.message);updateRecognizeButton();}
  });
  monitorOptions=options;
  monitor.start(); updateRecognizeButton();
}
function correctObservationManually() {
  const observed=reviewObservation; const baseline=correctionBaseline;
  switchMode('manual');
  if(!observed) return;
  const draft=clone(baseline||EMPTY);
  for(const key of ['hand','table','trumpSuit','opponentCount','stockCount','role']) if(observed[key]!==null&&observed[key]!==undefined) draft[key]=clone(observed[key]);
  if(observed.trumpCard!==null&&observed.trumpCard!==undefined) draft.trumpCard=observed.trumpCard;
  const visible=new Set([...draft.hand,...allTableCards(draft)]); draft.knownOpponent=draft.knownOpponent.filter(card=>!visible.has(card));
  // Conflicting memory is left visible for correction, never silently erased.
  writeForm(draft,false); markDraft();
  showNotice('Кадр перенесён в ручной черновик. Проверьте карты, отбой, козырь и счётчики. Затем используйте позицию в автоанализе.');
  openEditor();
}
function useManualInAuto() {
  try {
    const next=draftDirty?readForm():clone(state); const errors=getErrors(next); if(errors.length) throw new Error(errors.join(' '));
    const known=new Set([...next.hand,...allTableCards(next),...next.discard,...next.knownOpponent]);
    const before=correctionBaseline;
    const missing=before?[...new Set([...before.hand,...allTableCards(before),...before.discard,...before.knownOpponent])].filter(card=>!known.has(card)):[];
    if(missing.length) throw new Error(`Укажите, куда перешли карты: ${missing.map(cardName).join(', ')}. Добавьте их в руку, на стол, в отбой или к известным картам соперника.`);
    if(draftDirty&&!commit(next,'manual')) return;
    switchMode('auto'); pauseAuto(); confirmedSignature=null; autoReady=true; $('auto-review').hidden=true; reviewObservation=null; correctionBaseline=null;
    autoSnapshot=null; commit(next,'auto','Ручная позиция принята. Чтобы продолжить наблюдение, нажмите «Начать автоанализ».');
    setAutoStatus('idle','Позиция уточнена. Можно продолжить автоанализ.');
  } catch(error) {showNotice(error.message,true); showErrors('form-errors',[error.message]);openEditor();}
}

buildVisualEditor();
mountModesUI();
try {if(localStorage.getItem('allinall.gameProfile')==='generic-transfer')gameProfile='generic-transfer';}catch{}
$('auto-game-profile').value=gameProfile;
function updateProfileNote() {
  $('auto-profile-note').textContent=gameProfile==='hlop-singleplayer'
    ?'После взятия карт атакует соперник. Покрывать нужно первую непокрытую карту слева направо. Кнопки «Беру» и «Всё» определяют защиту и завершение захода. Перевод недоступен.'
    :'Перевод разрешён. Очередь хода определяется по кнопкам и изменениям карт; особенности durak.hlop.de не применяются.';
}
updateProfileNote();
$('auto-game-profile').addEventListener('change',()=>{
  const resume=Boolean(monitor?.getState().running);
  pauseAuto();requestController?.abort();captureGeneration++;monitor?.resetFrames();
  gameProfile=$('auto-game-profile').value;
  try {localStorage.setItem('allinall.gameProfile',gameProfile);}catch{}
  autoSnapshot=null;lastCurrentScene=null;confirmedSignature=null;
  autoRecovery.reset();autoSessionTracker.reset();$('auto-review').hidden=true;
  updateProfileNote();render();if(resume)void startAuto();
});
settingsUI=setupProviderSettings({getConfig:async()=>{pauseAuto();requestController?.abort();await loadConfig();return config;},onConfig:async next=>{applyConfig(next);if(mode==='auto'&&stream&&config.visionConfigured&&!recognitionBusy)await startAuto();},onError:error=>showNotice(error.message,true)});
$('mode-auto').addEventListener('click',()=>switchMode('auto')); $('mode-manual').addEventListener('click',()=>switchMode('manual'));
for(const id of ['mode-auto','mode-manual']) $(id).addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const target=event.key==='Home'?'auto':event.key==='End'?'manual':mode==='auto'?'manual':'auto';switchMode(target);$(`mode-${target}`).focus();}});
$('auto-start').addEventListener('click',startAuto); $('auto-pause').addEventListener('click',()=>{pauseAuto();setAutoStatus('idle','Автоанализ на паузе. Предпросмотр остаётся включён.');});
$('auto-review-manual').addEventListener('click',correctObservationManually); $('auto-retry').addEventListener('click',recognizeFrame);
$('use-manual-auto').addEventListener('click',useManualInAuto); $('mode-stop-window').addEventListener('click',stopCapture);
document.querySelector('.help-steps').innerHTML='<li><b>Подключите ИИ один раз.</b><p>В «Настройки ИИ» выберите GenAPI, модель gpt-6-luna и вставьте ключ GenAPI. Ключ сохранится в локальный .env.</p></li><li><b>Выберите окно игры.</b><p>Игровой стол находится локально. В API передаётся только его область; пока стол не найден, платных запросов нет.</p></li><li><b>Играйте и следите за советом.</b><p>Карты и завершение захода отслеживаются автоматически. Повторные кадры и изменения панели помощника не покупают новое распознавание. Нечёткий кадр перечитывается автоматически до двух раз. Неполная история не блокирует совет по текущим картам.</p></li><li><b>Ручной режим — запасной.</b><p>У него отдельная позиция и черновик. Чтобы продолжить наблюдение с исправленного состояния, нажмите «Использовать эту позицию в автоанализе».</p></li>';
renderAutoEvents();
for(const [index,name] of ['capture','advice','position','memory'].entries()) {document.querySelector('.dashboard-grid').append(document.querySelector(`.${name}-panel`));document.querySelector(`.${name}-panel .section-number`).textContent=String(index+1).padStart(2,'0');}
document.addEventListener('click',event=>{
  const select=event.target.closest('[data-pick-zone]');
  if(select) { openPicker(select.dataset.pickZone,select.dataset.pickIndex===undefined?undefined:Number(select.dataset.pickIndex)); return; }
  const card=event.target.closest('[data-pick-card]'); if(card && $('card-picker-dialog').open) { selectPickerCard(card.dataset.pickCard); return; }
  const count=event.target.closest('[data-count-delta]');
  if(count) { const input=$('field-opponentCount'); input.value=Math.max(0,Math.min(36,(Number(input.value)||0)+Number(count.dataset.countDelta))); markDraft(); return; }
  const remove=event.target.closest('[data-remove-pair]');
  if(remove) { try { const next=readForm(); next.table.splice(Number(remove.dataset.removePair),1); next.stockCount=remainingStock(next); writeForm(next); markDraft(); } catch(error) {showNotice(error.message,true);} }
});
$('picker-done').addEventListener('click',finishPicker);
$('picker-close').addEventListener('click',closePicker); $('picker-cancel').addEventListener('click',closePicker);
$('card-picker-dialog').addEventListener('cancel',event=>{event.preventDefault();closePicker();});
$('picker-clear').addEventListener('click',()=>{
  const {zone,index}=pickerTarget;
  if(['hand','discard','knownOpponent'].includes(zone)) pickerDraft[zone]=[];
  else if(zone==='trump') pickerDraft.trumpCard=null;
  else if(zone==='attack' && Number.isInteger(index)) {pickerDraft.table.splice(index,1);delete pickerTarget.index;}
  else if(zone==='defense') pickerDraft.table[index].defense=null;
  pickerDraft.stockCount=remainingStock(pickerDraft); pickerDirty=true; $('picker-error').hidden=true; renderPicker();
});
$('field-trumpSuit').addEventListener('change',()=>{
  const card=$('field-trumpCard'); if(card.value && card.value.slice(-1)!==$('field-trumpSuit').value) { card.value=''; showNotice('Масть изменена. Выберите карту открытого козыря.'); }
});
$('position-form').addEventListener('input', markDraft); $('position-form').addEventListener('change', markDraft);
$('position-form').addEventListener('submit', (event) => {
  event.preventDefault(); try { const next = readForm(); commit(next, 'manual', 'Позиция сохранена. Рекомендации пересчитаны.'); } catch (error) { showErrors('form-errors', [error.message]); }
});
$('cancel-edit-button').addEventListener('click', () => { writeForm(state); $('saved-indicator').textContent = 'Сохранено на устройстве'; render(); });
$('edit-button').addEventListener('click', openEditor); $('reset-button').addEventListener('click', newSession); $('start-button').addEventListener('click', newSession);
$('discard-button').addEventListener('click', () => prepareRound('discard')); $('opponent-took-button').addEventListener('click', () => prepareRound('opponent')); $('i-took-button').addEventListener('click', () => prepareRound('me'));
$('undo-button').addEventListener('click', () => {
  if (!history.length) return; if (draftDirty && !confirm('Отменить неподтверждённые правки и вернуться к предыдущей позиции?')) return;
  const previous = history.pop(); state = previous.state; source = previous.source; selectedRecommendation = 0; writeForm(state); saveSession(); render(); showNotice('Предыдущая позиция восстановлена.');
});
$('advice-content').addEventListener('click', (event) => { const button = event.target.closest('[data-recommendation]'); if (!button) return; selectedRecommendation = Number(button.dataset.recommendation); renderAdvice(); });
$('capture-button').addEventListener('click', startCapture); $('stop-button').addEventListener('click', stopCapture); $('recognize-button').addEventListener('click', recognizeFrame);
$('screenshot-file').addEventListener('change',async event=>{await recognizeScreenshot(event.target.files[0]);event.target.value='';});
$('export-button').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ format: 'allinall-durak', version: 1, exportedAt: new Date().toISOString(), state }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `allinall-durak-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  if (draftDirty) showNotice('Экспортирована последняя подтверждённая позиция. Правки редактора в файл не включены.');
});
$('import-button').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 200000) throw new Error('Размер JSON не должен превышать 200 КБ.');
    const raw = JSON.parse(await file.text());
    if (raw.format && raw.format !== 'allinall-durak') throw new Error('Этот формат файла не поддерживается.');
    if (raw.version !== undefined && raw.version !== 1) throw new Error('Версия сохранения не поддерживается.');
    const next = normalizeState(raw.state || raw);
    if ((draftDirty || state.hand.length || state.table.length) && !confirm('Заменить текущую позицию данными из файла? Предыдущее состояние можно вернуть кнопкой «Отменить».')) return;
    if(mode==='auto') { pauseAuto(); requestController?.abort(); captureGeneration++; confirmedSignature=null; autoReady=true; $('auto-review').hidden=true;reviewObservation=null;correctionBaseline=null; }
    commit(next, mode==='auto'?'auto':'import', 'Позиция импортирована и проверена.');
  } catch (error) { showNotice(`Не удалось импортировать файл: ${error.message}`, true); }
  finally { event.target.value = ''; }
});
$('help-button').addEventListener('click', () => $('help-dialog').showModal()); $('close-help-button').addEventListener('click', () => $('help-dialog').close());
for (const id of ['close-vision-button', 'cancel-vision-button']) $(id).addEventListener('click', () => $('vision-dialog').close());
$('vision-json').addEventListener('input', invalidateVision); $('prepare-vision-button').addEventListener('click', prepareVision); $('vision-review').addEventListener('change', refreshVisionValidation);
$('apply-vision-button').addEventListener('click', () => {
  try {
    const next = reconciledVisionState();
    if (draftDirty && !confirm('Заменить неподтверждённые правки редактора распознанной позицией?')) return;
    if (commit(next, 'vision', 'Распознанная позиция подтверждена. Память обновлена по вашим указаниям.')) $('vision-dialog').close();
  } catch (error) { showErrors('vision-errors', [error.message]); }
});
for (const id of ['vision-dialog', 'help-dialog']) $(id).addEventListener('click', (event) => { if (event.target === $(id)) { const rect = $(id).getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $(id).close(); } });
window.addEventListener('beforeunload', (event) => { if (draftDirty || pickerDirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide',()=>{pauseAuto();requestController?.abort();});
loadSession(); writeForm(state,false); render(); if (!restorationFailed && !draftDirty) saveSession(); loadConfig();


