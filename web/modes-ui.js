/** Mount the two independent workspaces; callbacks live in the app controller. */
export function mountModesUI() {
  const $=id=>document.getElementById(id);
  const dashboard=document.querySelector('.dashboard-grid');
  dashboard.insertAdjacentHTML('beforebegin',`
    <div class="mode-switch" role="tablist" aria-label="Режим работы">
      <button class="mode-tab" id="mode-auto" type="button" role="tab" aria-selected="true"><span>◉ Автоматически</span><small>Основной режим · анализ выбранного окна</small></button>
      <button class="mode-tab" id="mode-manual" type="button" role="tab" aria-selected="false"><span>♠ Вручную</span><small>Запасной режим · выбор карт кликами</small></button>
    </div>
    <div id="manual-mode-note" hidden><p>Ручная позиция сохраняется отдельно от наблюдения за окном. Передача кадров в этом режиме остановлена.</p><button id="use-manual-auto" class="secondary-button" type="button">Использовать эту позицию в автоанализе</button><button id="mode-stop-window" class="text-button" type="button" hidden>Остановить демонстрацию</button></div>
  `);
  document.querySelector('.vision-controls').insertAdjacentHTML('beforebegin',`
    <div id="auto-controls">
      <div class="provider-line"><span class="provider-badge" id="auto-provider">GenAPI · GPT-6 Luna</span><button class="settings-button secondary-button" id="settings-button" type="button">Настройки ИИ</button></div>
      <label class="field">Игра и правила<select id="auto-game-profile"><option value="hlop-singleplayer">durak.hlop.de · с компьютером · без перевода</option><option value="generic-transfer">Другая игра · переводной дурак</option></select></label>
      <p id="auto-profile-note" class="small-help">После взятия карт атакует соперник. Покрывать нужно первую непокрытую карту слева направо. Кнопки «Беру» и «Всё» определяют защиту и завершение захода.</p>
      <p id="auto-status" class="auto-status" role="status">Выберите окно игры и подключите API-ключ.</p>
      <div class="auto-actions"><button id="auto-start" type="button" class="primary-button" disabled>Начать автоанализ</button><button id="auto-pause" type="button" class="secondary-button" hidden>Пауза</button></div>
      <div class="auto-options"><label>Пауза между запросами<select id="auto-interval"><option value="5000">Не менее 5 секунд</option><option value="10000" selected>Не менее 10 секунд</option><option value="15000">Не менее 15 секунд</option></select></label><label>Лимит запросов<select id="auto-budget"><option value="30">30 запросов</option><option value="60" selected>60 запросов</option><option value="120">120 запросов</option></select></label></div>
      <p id="game-region-status" class="snapshot-status" role="status">Окно не выбрано. Платные запросы не выполняются.</p>
      <p id="auto-counters">Запросов к ИИ: 0 · из кеша: 0</p>
      <p class="auto-disclosure" id="auto-disclosure">После запуска изменившиеся кадры выбранного окна отправляются в GenAPI. Запросы оплачиваются по тарифу вашего аккаунта. Неизменившийся экран и анимации пропускаются.</p>
      <p class="settings-note">Начальная раздача и первый ход определяются автоматически. Для полной памяти лучше включать помощника с начала партии.</p>
    </div>
    <div id="auto-review" hidden><h3 id="auto-review-title">Перепроверяем распознавание карт</h3><p id="auto-review-message">Наблюдение продолжается локально. Подтверждённая память сохранена.</p><details><summary>Подробности распознавания</summary><ul id="auto-review-reasons"></ul></details><div class="auto-review-actions"><button id="auto-review-manual" class="text-button" type="button">Исправить вручную (необязательно)</button><button id="auto-retry" class="text-button" type="button">Проверить сейчас</button></div></div>
    <details class="auto-events"><summary>Последние изменения</summary><ul id="auto-events"></ul></details>
  `);
  document.querySelector('.position-panel .position-stats').insertAdjacentHTML('beforebegin','<div id="auto-empty" class="auto-empty"><h3>Пока нет распознанной позиции</h3><p>Выберите окно игры. После первого уверенно распознанного кадра здесь появятся карты и счётчики.</p></div>');
  const dialog=document.createElement('dialog'); dialog.id='settings-dialog'; dialog.className='modal'; dialog.setAttribute('aria-labelledby','settings-title');
  dialog.innerHTML=`<div class="modal-heading"><div><span class="eyebrow">ПОДКЛЮЧЕНИЕ РАСПОЗНАВАНИЯ</span><h2 id="settings-title">Настройки ИИ</h2></div><button id="settings-close" class="icon-button" type="button" aria-label="Закрыть настройки ИИ">×</button></div>
    <form id="settings-form"><label class="field">Провайдер<select id="settings-provider"><option value="genapi">GenAPI</option><option value="openai">OpenAI напрямую</option></select></label><label class="field">Модель<input id="settings-model" value="gpt-6-luna" autocomplete="off" spellcheck="false" required maxlength="120"></label><label class="field">API-ключ<input id="settings-key" type="password" autocomplete="off" spellcheck="false" maxlength="512" placeholder="Вставьте ключ выбранного провайдера"></label><p id="settings-key-state" class="settings-note">Ключ ещё не указан.</p><p class="settings-note">Ключ хранится в файле .env на вашем компьютере. Сервер не возвращает его браузеру. В экспорт партий и в код ключ не включается. Пустое поле сохраняет уже настроенный ключ этого провайдера.</p><p class="settings-note">Ключ GenAPI используется только для GenAPI; ключ OpenAI — только для прямого подключения OpenAI.</p><p id="settings-status" role="status" hidden></p><div class="modal-footer"><button id="settings-cancel" class="text-button" type="button">Отмена</button><button id="settings-save" class="primary-button" type="submit">Сохранить подключение</button></div></form>`;
  document.body.append(dialog);
  const connection=document.querySelector('#auto-controls .provider-line');
  connection.classList.add('capture-connection');
  $('screen-stage').before(connection);
  $('screen-video').insertAdjacentHTML('afterend','<img id="snapshot-preview" hidden alt="Игровой стол из выбранного снимка" style="width:100%;height:100%;object-fit:contain;position:absolute;inset:0">');
  document.querySelector('.vision-controls').insertAdjacentHTML('afterend','<details class="snapshot-source"><summary>Проверить снимок игры</summary><p class="small-help">Дополнительный способ проверить распознавание: выберите скриншот, карты определятся автоматически. Кадр отправляется в подключённый ИИ.</p><input id="screenshot-file" type="file" accept="image/png,image/jpeg,image/webp" aria-label="Снимок игры для автоматического распознавания"></details>');
  $('recognize-button').textContent='Проверить один кадр';
  $('capture-button').innerHTML='<span aria-hidden="true">▣</span> Выбрать окно и начать';
  document.querySelector('.screen-placeholder p').innerHTML='Выберите окно или вкладку с игрой.<br>Анализ начнётся автоматически после подключения.';
  document.querySelector('.vision-controls b').textContent='Разовая проверка';
  document.body.dataset.mode='auto'; document.body.dataset.autoReady='false';
}
