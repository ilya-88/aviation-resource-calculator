(function () {
  "use strict";

  const calc = window.AviationCalc;
  const app = document.getElementById("app");
  const STORAGE_KEY = "aviation-resource-prototype-v1";

  const seedState = {
    view: "home",
    globalNotifications: true,
    selectedAircraftId: "su33-85",
    aircraft: [
      {
        id: "su33-85",
        type: "Су-33",
        boardNumber: "85",
        serialNumber: "49051002905",
        notifications: true,
        totalFlightMinutes: 742 * 60 + 18,
        actualLandings: 386,
        equivalentLandings: 421.6,
        shifts: [],
        blocks: [
          { id: "airframe", kind: "airframe", name: "Формуляр самолёта", caption: "Планер и общая наработка", status: "ok" },
          { id: "engine-left", kind: "engine", name: "Левый двигатель", caption: "АЛ-31Ф · № 904118", status: "warning", sneMinutes: 22640, pprMinutes: 7460 },
          { id: "engine-right", kind: "engine", name: "Правый двигатель", caption: "АЛ-31Ф · № 904127", status: "ok", sneMinutes: 21975, pprMinutes: 6795 },
          { id: "vka", kind: "unit", name: "ВКА", caption: "Выносная коробка агрегатов", status: "ok" },
          { id: "gtde", kind: "unit", name: "ГТДЭ / ВСУ", caption: "Вспомогательная энергоустановка", status: "warning" },
        ],
        resources: [
          { id: "r1", object: "Самолёт", name: "Календарный срок", unit: "дн.", remaining: 412, limit: 3650, installed: "2017-08-14", produced: "2016-12-09", status: "ok" },
          { id: "r2", object: "Левый двигатель", name: "Ресурс до продления", unit: "ч", remaining: 18.4, limit: 100, installed: "2025-04-11", produced: "2020-06-03", status: "warning" },
          { id: "r3", object: "Правый двигатель", name: "Ресурс ППР", unit: "ч", remaining: 63.8, limit: 200, installed: "2025-04-11", produced: "2020-07-21", status: "ok" },
          { id: "r4", object: "ГТДЭ / ВСУ", name: "Работа 60 дней", unit: "дн.", remaining: 3, limit: 60, installed: "2026-09-24", produced: "2023-03-18", status: "danger" },
          { id: "r5", object: "ВКА", name: "Ресурс по налёту", unit: "ч", remaining: 44.2, limit: 500, installed: "2024-10-02", produced: "2022-01-17", status: "ok" },
        ],
      },
    ],
  };

  let state = loadState();

  state.aircraft.forEach((aircraft) => {
    if (!Array.isArray(aircraft.shifts)) aircraft.shifts = [];
  });

  function loadState() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return Object.assign({}, seedState, JSON.parse(stored));
    } catch (_) {
      // Прототип остаётся работоспособным, даже если хранилище браузера недоступно.
    }
    return structuredClone(seedState);
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {}
  }

  function selectedAircraft() {
    return state.aircraft.find((item) => item.id === state.selectedAircraftId) || state.aircraft[0];
  }

  function icon(name) {
    const icons = {
      plane: "✈",
      settings: "⚙",
      bell: "◉",
      plus: "+",
      back: "‹",
      resource: "◔",
      log: "＋",
      search: "⌕",
      calendar: "▣",
      shield: "◇",
      chevron: "›",
    };
    return `<span aria-hidden="true">${icons[name] || "•"}</span>`;
  }

  function statusLabel(status) {
    return status === "danger" ? "Критично" : status === "warning" ? "Внимание" : "Норма";
  }

  function render() {
    if (state.view === "aircraft") renderAircraft();
    else if (state.view === "resources") renderResources();
    else if (state.view === "shift") renderShift();
    else if (state.view === "settings") renderSettings();
    else renderHome();
    bindCommonActions();
  }

  function shell(content, options) {
    const title = options?.title || "Авиаресурс";
    const subtitle = options?.subtitle || "Инженерный учёт ресурсов";
    const back = options?.back;
    return `
      <header class="topbar">
        <div class="topbar__inner">
          ${back ? `<button class="icon-button" data-action="back" aria-label="Назад">${icon("back")}</button>` : `<div class="brand-mark">${icon("plane")}</div>`}
          <div class="title-group">
            <strong>${escapeHtml(title)}</strong>
            <span>${escapeHtml(subtitle)}</span>
          </div>
          <button class="icon-button" data-action="settings" aria-label="Настройки">${icon("settings")}</button>
        </div>
      </header>
      <main class="content">${content}</main>
      <nav class="bottom-nav" aria-label="Основная навигация">
        <button class="bottom-nav__item ${state.view === "home" ? "is-active" : ""}" data-view="home">${icon("plane")}<span>Самолёты</span></button>
        <button class="bottom-nav__item ${state.view === "shift" ? "is-active" : ""}" data-view="shift">${icon("log")}<span>Смена</span></button>
        <button class="bottom-nav__item ${state.view === "resources" ? "is-active" : ""}" data-view="resources">${icon("resource")}<span>Ресурсы</span></button>
      </nav>`;
  }

  function renderHome() {
    const aircraftCards = state.aircraft.map((aircraft) => {
      const urgent = aircraft.resources.filter((resource) => resource.status !== "ok").length;
      return `
        <button class="aircraft-card" data-aircraft-id="${aircraft.id}">
          <span class="aircraft-card__visual">${icon("plane")}</span>
          <span class="aircraft-card__body">
            <span class="aircraft-card__title">${escapeHtml(aircraft.type)} · борт ${escapeHtml(aircraft.boardNumber)}</span>
            <span class="aircraft-card__meta">Зав. № ${escapeHtml(aircraft.serialNumber)}</span>
            <span class="aircraft-card__metrics">
              <span><b>${calc.formatDuration(aircraft.totalFlightMinutes)}</b> налёт</span>
              <span><b>${aircraft.actualLandings}</b> посадок</span>
            </span>
          </span>
          <span class="aircraft-card__status status-${urgent ? "warning" : "ok"}">${urgent ? `${urgent} требуют внимания` : "Ресурс в норме"}</span>
          <span class="aircraft-card__chevron">${icon("chevron")}</span>
        </button>`;
    }).join("");

    app.innerHTML = shell(`
      <section class="hero">
        <div>
          <p class="eyebrow">Главный экран</p>
          <h1>Мои самолёты</h1>
          <p>Выберите борт или добавьте новый экземпляр.</p>
        </div>
        <button class="primary-button" data-action="add-aircraft">${icon("plus")} Добавить самолёт</button>
      </section>
      <section class="section-stack" aria-label="Список самолётов">
        ${aircraftCards || `<div class="empty-state"><h2>Самолётов пока нет</h2><p>Добавьте первый борт, чтобы начать учёт.</p></div>`}
      </section>
      <section class="quick-note">
        ${icon("bell")}
        <div><strong>Ближайшая работа через 3 дня</strong><span>ГТДЭ / ВСУ · работа 60 дней · Су-33, борт 85</span></div>
      </section>
    `);
  }

  function renderAircraft() {
    const aircraft = selectedAircraft();
    const blocks = aircraft.blocks.map((block) => `
      <button class="equipment-block" data-block-id="${block.id}">
        <span class="equipment-block__icon">${block.kind === "engine" ? "◉" : block.kind === "airframe" ? "△" : "⬡"}</span>
        <span class="equipment-block__body"><strong>${escapeHtml(block.name)}</strong><small>${escapeHtml(block.caption)}</small></span>
        <span class="status-dot status-${block.status}" aria-label="${statusLabel(block.status)}"></span>
        <span>${icon("chevron")}</span>
      </button>`).join("");

    const recentShifts = aircraft.shifts.slice(-3).reverse().map((shift) => `
      <article class="history-row">
        <div><strong>${formatDate(shift.date)}</strong><span>${calc.formatDuration(shift.flightMinutes)} полёта · ${shift.actualLandings} посадок</span></div>
        <div class="history-row__value">+${calc.formatDuration(shift.leftEngineMinutes)}</div>
      </article>`).join("");

    app.innerHTML = shell(`
      <section class="aircraft-heading">
        <div>
          <p class="eyebrow">${escapeHtml(aircraft.type)}</p>
          <h1>Борт ${escapeHtml(aircraft.boardNumber)}</h1>
          <p>Заводской № ${escapeHtml(aircraft.serialNumber)}</p>
        </div>
        <button class="secondary-button" data-view="resources">${icon("resource")} Остатки ресурсов</button>
      </section>
      <section class="metric-grid">
        <div class="metric"><span>Налёт</span><strong>${calc.formatDuration(aircraft.totalFlightMinutes)}</strong><small>СНЭ</small></div>
        <div class="metric"><span>Посадки</span><strong>${aircraft.actualLandings}</strong><small>фактические</small></div>
        <div class="metric"><span>Приведённые</span><strong>${aircraft.equivalentLandings.toFixed(1)}</strong><small>посадки</small></div>
      </section>
      <div class="section-heading"><div><h2>Формуляры и агрегаты</h2><p>Состав и названия блоков можно настраивать.</p></div><button class="text-button" data-action="edit-blocks">Изменить</button></div>
      <section class="equipment-list">${blocks}</section>
      <button class="add-block-button" data-action="add-block">${icon("plus")} Добавить блок</button>
      <div class="section-heading history-heading"><div><h2>Последние смены</h2><p>Сохранённые начисления по выбранному борту.</p></div></div>
      <section class="history-list">${recentShifts || `<div class="empty-state compact-empty"><p>Смен пока нет. Добавьте первую запись.</p></div>`}</section>
      <button class="floating-action" data-view="shift">${icon("log")} Внести лётную смену</button>
    `, { title: `${aircraft.type} · ${aircraft.boardNumber}`, subtitle: "Карточка самолёта", back: true });
  }

  function renderResources() {
    const aircraft = selectedAircraft();
    app.innerHTML = shell(`
      <section class="page-heading">
        <div><p class="eyebrow">${escapeHtml(aircraft.type)} · борт ${escapeHtml(aircraft.boardNumber)}</p><h1>Остатки ресурсов</h1></div>
        <label class="search-field">${icon("search")}<input id="resource-search" type="search" placeholder="Поиск по объектам и работам"></label>
      </section>
      <div class="filter-row" role="group" aria-label="Сортировка ресурсов">
        <button class="filter-chip is-active" data-sort="remaining">По остатку</button>
        <button class="filter-chip" data-sort="installed">По установке</button>
        <button class="filter-chip" data-sort="produced">По производству</button>
        <button class="filter-chip" data-sort="object">По объекту</button>
      </div>
      <section id="resource-list" class="resource-list">${resourceRows(aircraft.resources)}</section>
    `, { title: "Остатки ресурсов", subtitle: "Самолёт, двигатели и агрегаты", back: true });

    const search = document.getElementById("resource-search");
    search.addEventListener("input", () => {
      const query = search.value.trim().toLowerCase();
      const filtered = aircraft.resources.filter((item) => `${item.object} ${item.name}`.toLowerCase().includes(query));
      document.getElementById("resource-list").innerHTML = resourceRows(filtered);
    });
    document.querySelectorAll("[data-sort]").forEach((button) => button.addEventListener("click", () => {
      document.querySelectorAll("[data-sort]").forEach((item) => item.classList.remove("is-active"));
      button.classList.add("is-active");
      const key = button.dataset.sort;
      const sorted = [...aircraft.resources].sort((a, b) => key === "remaining" ? a.remaining - b.remaining : String(a[key]).localeCompare(String(b[key]), "ru"));
      document.getElementById("resource-list").innerHTML = resourceRows(sorted);
    }));
  }

  function resourceRows(resources) {
    if (!resources.length) return `<div class="empty-state"><h2>Ничего не найдено</h2><p>Измените поисковый запрос.</p></div>`;
    return resources.map((resource) => {
      const percent = Math.max(2, Math.min(100, resource.remaining / resource.limit * 100));
      return `<article class="resource-row">
        <div class="resource-row__top"><div><span>${escapeHtml(resource.object)}</span><strong>${escapeHtml(resource.name)}</strong></div><span class="resource-value status-text-${resource.status}">${resource.remaining} ${resource.unit}</span></div>
        <div class="progress-track"><span class="progress-fill status-bg-${resource.status}" style="width:${percent}%"></span></div>
        <div class="resource-row__meta"><span>Установлен: ${formatDate(resource.installed)}</span><span>Изготовлен: ${formatDate(resource.produced)}</span></div>
      </article>`;
    }).join("");
  }

  function renderShift() {
    const aircraft = selectedAircraft();
    app.innerHTML = shell(`
      <section class="page-heading compact">
        <div><p class="eyebrow">Новая запись</p><h1>Лётная смена</h1><p>${escapeHtml(aircraft.type)} · борт ${escapeHtml(aircraft.boardNumber)}</p></div>
      </section>
      <form id="shift-form" class="shift-form">
        <fieldset><legend>Общие данные</legend>
          <label><span>Дата смены</span><input name="date" type="date" value="2026-11-20" required></label>
          <div class="field-pair">
            <label><span>Полёт, часы</span><input name="flightHours" type="number" min="0" value="1" step="1"></label>
            <label><span>Полёт, минуты</span><input name="flightMinutes" type="number" min="0" max="59" value="0" step="1"></label>
          </div>
        </fieldset>
        <fieldset><legend>Посадки</legend>
          <div class="landing-grid">
            <label><span>БВПП · ×1,0</span><input name="runway" type="number" min="0" value="1"></label>
            <label><span>Корабль · ×2,0</span><input name="carrier" type="number" min="0" value="0"></label>
            <label><span>Касания · ×0,6</span><input name="touch" type="number" min="0" value="0"></label>
            <label><span>Конвейер · ×0,6</span><input name="circuit" type="number" min="0" value="0"></label>
          </div>
        </fieldset>
        <fieldset><legend>Наработка двигателей на земле</legend>
          <p class="field-help">Округление до ближайших 5 минут, затем в общую наработку идёт 20%.</p>
          <label><span>Левый двигатель, фактически</span><div class="input-with-unit"><input id="left-ground" name="leftGround" type="number" min="0" value="13"><span>мин</span></div></label>
          <div id="left-calculation" class="calculation-preview"></div>
          <label><span>Правый двигатель, фактически</span><div class="input-with-unit"><input id="right-ground" name="rightGround" type="number" min="0" value="13"><span>мин</span></div></label>
          <div id="right-calculation" class="calculation-preview"></div>
        </fieldset>
        <fieldset><legend>Режимы двигателя</legend>
          <div class="mode-grid"><label><span>ОР</span><input name="orMode" type="time" step="1" value="00:00:00"></label><label><span>Б, включая ОР</span><input name="combatMode" type="time" step="1" value="00:00:00"></label><label><span>Б + УБ, включая ОР</span><input name="combinedMode" type="time" step="1" value="00:00:00"></label></div>
        </fieldset>
        <section id="shift-summary" class="shift-summary"></section>
        <button type="submit" class="primary-button wide">Рассчитать и сохранить смену</button>
      </form>
    `, { title: "Лётная смена", subtitle: `${aircraft.type} · борт ${aircraft.boardNumber}`, back: true });
    bindShiftForm();
  }

  function bindShiftForm() {
    const form = document.getElementById("shift-form");
    const update = () => {
      const data = new FormData(form);
      const flight = Number(data.get("flightHours")) * 60 + Number(data.get("flightMinutes"));
      const left = calc.calculateEngineIncrement(flight, Number(data.get("leftGround")));
      const right = calc.calculateEngineIncrement(flight, Number(data.get("rightGround")));
      const equivalent = calc.calculateEquivalentLandings({ runway: data.get("runway"), carrier: data.get("carrier"), touch: data.get("touch"), circuit: data.get("circuit") }, { runway: 1, carrier: 2, touch: 0.6, circuit: 0.6 });
      document.getElementById("left-calculation").textContent = `${left.ground.actualMinutes} → ${left.ground.roundedMinutes} мин → 20% = ${left.ground.contributionMinutes} мин`;
      document.getElementById("right-calculation").textContent = `${right.ground.actualMinutes} → ${right.ground.roundedMinutes} мин → 20% = ${right.ground.contributionMinutes} мин`;
      document.getElementById("shift-summary").innerHTML = `<span>Будет начислено</span><strong>Левый: ${calc.formatDuration(left.totalMinutes)} · Правый: ${calc.formatDuration(right.totalMinutes)}</strong><small>Приведённые посадки: ${equivalent.toFixed(1)}</small>`;
    };
    form.addEventListener("input", update);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const aircraft = selectedAircraft();
      const flight = Number(data.get("flightHours")) * 60 + Number(data.get("flightMinutes"));
      const left = calc.calculateEngineIncrement(flight, Number(data.get("leftGround")));
      const right = calc.calculateEngineIncrement(flight, Number(data.get("rightGround")));
      const landings = {
        runway: Number(data.get("runway")),
        carrier: Number(data.get("carrier")),
        touch: Number(data.get("touch")),
        circuit: Number(data.get("circuit")),
      };
      const actualLandings = Object.values(landings).reduce((sum, value) => sum + value, 0);
      const equivalent = calc.calculateEquivalentLandings(landings, { runway: 1, carrier: 2, touch: 0.6, circuit: 0.6 });

      aircraft.totalFlightMinutes += flight;
      aircraft.actualLandings += actualLandings;
      aircraft.equivalentLandings = Math.round((aircraft.equivalentLandings + equivalent) * 10) / 10;
      const leftBlock = aircraft.blocks.find((block) => block.id === "engine-left");
      const rightBlock = aircraft.blocks.find((block) => block.id === "engine-right");
      if (leftBlock) {
        leftBlock.sneMinutes = (leftBlock.sneMinutes || 0) + left.totalMinutes;
        leftBlock.pprMinutes = (leftBlock.pprMinutes || 0) + left.totalMinutes;
      }
      if (rightBlock) {
        rightBlock.sneMinutes = (rightBlock.sneMinutes || 0) + right.totalMinutes;
        rightBlock.pprMinutes = (rightBlock.pprMinutes || 0) + right.totalMinutes;
      }
      aircraft.resources.forEach((resource) => {
        if (resource.unit !== "ч") return;
        const spent = resource.object === "Левый двигатель"
          ? left.totalMinutes / 60
          : resource.object === "Правый двигатель"
            ? right.totalMinutes / 60
            : flight / 60;
        resource.remaining = Math.max(0, Math.round((resource.remaining - spent) * 10) / 10);
        resource.status = resource.remaining <= 5 ? "danger" : resource.remaining <= 20 ? "warning" : "ok";
      });
      aircraft.shifts.push({
        id: `shift-${Date.now()}`,
        date: String(data.get("date")),
        flightMinutes: flight,
        leftEngineMinutes: left.totalMinutes,
        rightEngineMinutes: right.totalMinutes,
        actualLandings,
        equivalentLandings: equivalent,
      });
      saveState();
      state.view = "aircraft";
      render();
      showToast(`Смена сохранена: левый ${calc.formatDuration(left.totalMinutes)}, правый ${calc.formatDuration(right.totalMinutes)}.`);
    });
    update();
  }

  function renderSettings() {
    const aircraft = selectedAircraft();
    app.innerHTML = shell(`
      <section class="page-heading compact"><div><p class="eyebrow">Приложение</p><h1>Настройки</h1></div></section>
      <section class="settings-list">
        <label class="setting-row"><span><strong>Все уведомления</strong><small>Главный переключатель имеет высший приоритет</small></span><input id="global-notifications" type="checkbox" ${state.globalNotifications ? "checked" : ""}></label>
        <label class="setting-row"><span><strong>${escapeHtml(aircraft.type)} · борт ${escapeHtml(aircraft.boardNumber)}</strong><small>Работы и ресурсы этого самолёта</small></span><input id="aircraft-notifications" type="checkbox" ${aircraft.notifications ? "checked" : ""} ${!state.globalNotifications ? "disabled" : ""}></label>
        <button class="setting-row" data-action="calendar-settings"><span><strong>Календарь и напоминания</strong><small>Добавление, поиск и удаление событий приложения</small></span>${icon("chevron")}</button>
        <button class="setting-row" data-action="notification-test"><span><strong>Проверить уведомление Android</strong><small>Запросить разрешение и показать тестовое напоминание</small></span>${icon("bell")}</button>
        <button class="setting-row" data-action="storage-mode"><span><strong>Защищённый режим хранения</strong><small>В прототипе не активирован</small></span><span class="prototype-badge">Позже</span></button>
        <button class="setting-row" data-action="about"><span><strong>О приложении</strong><small>Авиаресурс · Android-прототип 0.2.0</small></span>${icon("chevron")}</button>
      </section>
      <section class="info-panel">${icon("shield")}<div><strong>Данные этого прототипа</strong><p>Сохраняются только в локальном хранилище браузера. Серверная синхронизация и шифрование пока не реализованы.</p></div></section>
    `, { title: "Настройки", subtitle: "Приложение и выбранный самолёт", back: true });

    document.getElementById("global-notifications").addEventListener("change", (event) => {
      if (!event.target.checked && !window.confirm("Отключить уведомления приложения и сбросить настройки всех самолётов?")) {
        event.target.checked = true;
        return;
      }
      state.globalNotifications = event.target.checked;
      if (!state.globalNotifications) state.aircraft.forEach((item) => { item.notifications = false; });
      saveState();
      renderSettings();
      showToast(state.globalNotifications ? "Общие уведомления включены" : "Уведомления всех самолётов выключены");
    });
    document.getElementById("aircraft-notifications").addEventListener("change", (event) => {
      aircraft.notifications = event.target.checked;
      saveState();
      showToast("Настройки самолёта сохранены");
    });
  }

  function bindCommonActions() {
    document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
      state.view = button.dataset.view;
      render();
    }));
    document.querySelectorAll("[data-aircraft-id]").forEach((button) => button.addEventListener("click", () => {
      state.selectedAircraftId = button.dataset.aircraftId;
      state.view = "aircraft";
      render();
    }));
    const settings = document.querySelector("[data-action='settings']");
    if (settings) settings.addEventListener("click", () => { state.view = "settings"; render(); });
    const back = document.querySelector("[data-action='back']");
    if (back) back.addEventListener("click", () => { state.view = state.view === "aircraft" ? "home" : "aircraft"; render(); });

    const addAircraft = document.querySelector("[data-action='add-aircraft']");
    if (addAircraft) addAircraft.addEventListener("click", createAircraft);
    const addBlock = document.querySelector("[data-action='add-block']");
    if (addBlock) addBlock.addEventListener("click", createBlock);
    const editBlocks = document.querySelector("[data-action='edit-blocks']");
    if (editBlocks) editBlocks.addEventListener("click", renameBlock);
    const calendar = document.querySelector("[data-action='calendar-settings']");
    if (calendar) calendar.addEventListener("click", addNearestWorkToCalendar);
    const notificationTest = document.querySelector("[data-action='notification-test']");
    if (notificationTest) notificationTest.addEventListener("click", testAndroidNotification);
    document.querySelectorAll("[data-action='storage-mode'],[data-action='about'],[data-block-id]").forEach((button) => button.addEventListener("click", () => showToast("Раздел включён в структуру. Подробные поля будут добавляться по мере согласования формуляров.")));
  }

  function createAircraft() {
    const type = window.prompt("Тип самолёта", "Су-33");
    if (!type) return;
    const boardNumber = window.prompt("Бортовой номер", "");
    if (!boardNumber) return;
    const serialNumber = window.prompt("Заводской номер", "Не указан") || "Не указан";
    const id = `aircraft-${Date.now()}`;
    state.aircraft.push({
      id,
      type: type.trim(),
      boardNumber: boardNumber.trim(),
      serialNumber: serialNumber.trim(),
      notifications: state.globalNotifications,
      totalFlightMinutes: 0,
      actualLandings: 0,
      equivalentLandings: 0,
      shifts: [],
      blocks: [
        { id: `airframe-${Date.now()}`, kind: "airframe", name: "Формуляр самолёта", caption: "Планер и общая наработка", status: "ok" },
      ],
      resources: [],
    });
    state.selectedAircraftId = id;
    state.view = "aircraft";
    saveState();
    render();
    showToast("Самолёт добавлен");
  }

  function createBlock() {
    const aircraft = selectedAircraft();
    const name = window.prompt("Название блока или агрегата", "Новый агрегат");
    if (!name) return;
    const caption = window.prompt("Краткое описание", "Формуляр и ресурсные показатели") || "Формуляр и ресурсные показатели";
    aircraft.blocks.push({
      id: `unit-${Date.now()}`,
      kind: "unit",
      name: name.trim(),
      caption: caption.trim(),
      status: "ok",
    });
    saveState();
    render();
    showToast("Блок добавлен");
  }

  function renameBlock() {
    const aircraft = selectedAircraft();
    const numbered = aircraft.blocks.map((block, index) => `${index + 1}. ${block.name}`).join("\n");
    const selected = Number(window.prompt(`Какой блок переименовать?\n${numbered}`, "1"));
    if (!Number.isInteger(selected) || selected < 1 || selected > aircraft.blocks.length) return;
    const block = aircraft.blocks[selected - 1];
    const name = window.prompt("Новое название", block.name);
    if (!name) return;
    block.name = name.trim();
    saveState();
    render();
    showToast("Название блока сохранено");
  }

  function addNearestWorkToCalendar() {
    const aircraft = selectedAircraft();
    const nearest = [...aircraft.resources]
      .filter((resource) => resource.unit === "дн.")
      .sort((a, b) => a.remaining - b.remaining)[0];
    if (!nearest) {
      showToast("Для самолёта пока нет календарных работ");
      return;
    }
    const start = Date.now() + nearest.remaining * 24 * 60 * 60 * 1000;
    const title = `${nearest.name} · ${aircraft.type}, борт ${aircraft.boardNumber}`;
    const description = `${nearest.object}. Событие подготовлено приложением «Авиаресурс».`;
    if (window.AndroidBridge?.openCalendarEvent) {
      window.AndroidBridge.openCalendarEvent(title, description, start);
    } else {
      showToast(`В Android откроется календарь: ${title}`);
    }
  }

  function testAndroidNotification() {
    const aircraft = selectedAircraft();
    if (window.AndroidBridge?.showNotification) {
      window.AndroidBridge.showNotification("Авиаресурс", `${aircraft.type}, борт ${aircraft.boardNumber}: ближайшая работа через 3 дня`);
    } else {
      showToast("Тестовое Android-уведомление доступно в APK");
    }
  }

  function showToast(message) {
    document.querySelector(".toast")?.remove();
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${value}T00:00:00`));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js").catch(() => {}));
  }

  window.handleAndroidBack = function () {
    if (state.view === "home") return false;
    state.view = state.view === "aircraft" ? "home" : "aircraft";
    render();
    return true;
  };

  render();
})();
