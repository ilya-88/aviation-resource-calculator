(function () {
  "use strict";

  const calc = window.AviationCalc;
  const app = document.getElementById("app");
  const STORAGE_KEY = "aviation-resource-prototype-v1";
  const DEFAULT_AIRCRAFT_SETTINGS = {
    groundRoundingMinutes: 5,
    groundRoundingDirection: "nearest",
    groundPercent: 20,
    landingCoefficients: { runway: 1, carrier: 2, touch: 0.6, circuit: 0.6 },
  };
  const USAGE_TYPES = {
    flight: "Налёт", ground: "Наработка на земле", maximum: "Максимал",
    runway: "БВПП", carrier: "Корабельные посадки", touch: "Касания",
    circuit: "Конвейер", arresterHooks: "Зацепы за аэрофинишер",
  };
  const OPTIONAL_USAGE_TYPES = ["runway", "carrier", "touch", "circuit", "arresterHooks"];

  function usageRule(key) {
    return state.usageRules?.[key] ?? {
      label: USAGE_TYPES[key],
      factor: DEFAULT_AIRCRAFT_SETTINGS.landingCoefficients[key] ?? 1,
    };
  }

  function usageTypeOverride(aircraft) {
    return state.usageTypeOverrides?.find((entry) => entry.type === aircraft.type.trim().toLowerCase());
  }
  const DEFAULT_NOTIFICATION_CONFIG = {
    mode: "all",
    leadDays: 3,
    categories: { workUsage: true, workDate: true, resourceUsage: true, resourceDate: true },
  };

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
        arresterHooks: 0,
        settings: structuredClone(DEFAULT_AIRCRAFT_SETTINGS),
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
  const viewStack = [];

  function loadState() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return normalizeState(JSON.parse(stored));
    } catch (_) {
      // Прототип остаётся работоспособным, даже если хранилище браузера недоступно.
    }
    return normalizeState(structuredClone(seedState));
  }

  function saveState() {
    try {
      const persisted = {
        globalNotifications: state.globalNotifications,
        selectedAircraftId: state.selectedAircraftId,
        typeSettings: state.typeSettings,
        usageRules: state.usageRules,
        sharedGround: state.sharedGround,
        usageTypeOverrides: state.usageTypeOverrides,
        aircraft: state.aircraft,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
      return true;
    } catch (_) {
      return false;
    }
  }

  function normalizeState(raw) {
    const normalized = Object.assign({}, structuredClone(seedState), raw || {}, { view: "home" });
    normalized.typeSettings = Array.isArray(raw?.typeSettings) ? raw.typeSettings : [];
    if (!Array.isArray(normalized.aircraft)) normalized.aircraft = [];
    normalized.aircraft = normalized.aircraft.map((aircraft) => ({
      ...aircraft,
      notifications: normalized.globalNotifications ? aircraft.notifications !== false : false,
      actualLandings: Number(aircraft.actualLandings) || 0,
      equivalentLandings: Number(aircraft.equivalentLandings) || 0,
      arresterHooks: Number(aircraft.arresterHooks) || 0,
      shifts: Array.isArray(aircraft.shifts) ? aircraft.shifts : [],
      blocks: Array.isArray(aircraft.blocks) ? aircraft.blocks.map(normalizeBlock) : [],
      resources: Array.isArray(aircraft.resources) ? aircraft.resources.map(normalizeResource) : [],
      settings: {
        ...structuredClone(DEFAULT_AIRCRAFT_SETTINGS),
        ...(aircraft.settings || {}),
        landingCoefficients: {
          ...DEFAULT_AIRCRAFT_SETTINGS.landingCoefficients,
          ...(aircraft.settings?.landingCoefficients || {}),
        },
      },
      notificationConfig: {
        ...structuredClone(DEFAULT_NOTIFICATION_CONFIG),
        ...(aircraft.notificationConfig || {}),
        categories: {
          ...DEFAULT_NOTIFICATION_CONFIG.categories,
          ...(aircraft.notificationConfig?.categories || {}),
        },
      },
    }));
    if (!normalized.aircraft.some((item) => item.id === normalized.selectedAircraftId)) {
      normalized.selectedAircraftId = normalized.aircraft[0]?.id || null;
    }
    return normalized;
  }

  function selectedAircraft() {
    return state.aircraft.find((item) => item.id === state.selectedAircraftId) || state.aircraft[0];
  }

  function navigateTo(view) {
    if (state.view !== view) viewStack.push(state.view);
    state.view = view;
    render();
  }

  let leaveUsageSettings;
  function navigateBack() {
    if (state.view === "usage-settings" && leaveUsageSettings?.()) return;
    if (state.view === "aircraft-layout" && leaveAircraftLayout?.()) return;
    finishBackNavigation();
  }

  function finishBackNavigation() {
    const fallback = state.view === "aircraft" ? "home" : "aircraft";
    state.view = viewStack.pop() || fallback;
    render();
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
    if (state.view === "add-aircraft" || state.view === "add-block") {
      renderCreationForm();
      bindCommonActions();
      return;
    }
    if (state.view === "aircraft") renderAircraft();
    else if (state.view === "aircraft-settings") renderAircraftSettings();
    else if (state.view === "block") renderBlock();
    else if (state.view === "resource-editor") renderResourceEditor();
    else if (state.view === "resources") renderResources();
    else if (state.view === "shift") renderShift();
    else if (state.view === "reports") renderReports();
    else if (state.view === "settings") renderSettings();
    else if (state.view === "usage-settings") renderUsageSettings();
    else if (state.view === "type-usage-settings") renderTypeUsageSettings();
    else if (state.view === "aircraft-layout") renderAircraftLayout();
    else if (state.view === "about") renderAbout();
    else renderHome();
    bindCommonActions();
  }

  function shell(content, options) {
    const title = options?.title || "Авиаресурс";
    const subtitle = options?.subtitle ?? "Инженерный учёт ресурсов";
    const back = options?.back;
    const settingsScope = options?.settingsScope || "general";
    const settingsControl = options?.settings === false
      ? `<span class="topbar-spacer" aria-hidden="true"></span>`
      : `<button class="icon-button" data-action="settings" data-settings-scope="${settingsScope}" aria-label="Настройки">${icon("settings")}</button>`;
    return `
      <header class="topbar">
        <div class="topbar__inner">
          ${back ? `<button class="icon-button" data-action="back" aria-label="Назад">${icon("back")}</button>` : `<div class="brand-mark">${icon("plane")}</div>`}
          <div class="title-group">
            ${options?.singleLine ? `<h1 class="compact-bort-title">${escapeHtml(title)}</h1>` : `<strong>${escapeHtml(title)}</strong>`}
            ${subtitle ? `<span>${escapeHtml(subtitle)}</span>` : ""}
          </div>
          ${settingsControl}
        </div>
      </header>
      <main class="content">${content}</main>`;
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
              <span><b>${calc.formatDuration(aircraft.totalFlightMinutes)}</b> ${escapeHtml(usageRule("flight").label)}</span>
              <span><b>${aircraft.actualLandings}</b> посадок</span>
            </span>
          </span>
          <span class="aircraft-card__status status-${urgent ? "warning" : "ok"}">${urgent ? `${urgent} требуют внимания` : "Ресурс в норме"}</span>
          <span class="aircraft-card__chevron">${icon("chevron")}</span>
        </button>`;
    }).join("");

    const nearest = state.aircraft.flatMap((aircraft) => aircraft.resources
      .filter((resource) => resource.unit === "дн.")
      .map((resource) => ({ aircraft, resource })))
      .sort((a, b) => a.resource.remaining - b.resource.remaining)[0];
    const nearestNote = nearest
      ? `<section class="quick-note">${icon("bell")}<div><strong>Ближайшая работа через ${nearest.resource.remaining} дн.</strong><span>${escapeHtml(nearest.resource.object)} · ${escapeHtml(nearest.resource.name)} · ${escapeHtml(nearest.aircraft.type)}, борт ${escapeHtml(nearest.aircraft.boardNumber)}</span></div></section>`
      : "";

    app.innerHTML = shell(`
      <section class="hero">
        <div>
          <h1>Самолёты</h1>
          <p>Выберите борт или добавьте самолёт.</p>
        </div>
        <button class="primary-button" data-action="add-aircraft">${icon("plus")} Добавить самолёт</button>
      </section>
      <section class="section-stack" aria-label="Список самолётов">
        ${aircraftCards || `<div class="empty-state"><h2>Самолётов пока нет</h2><p>Добавьте первый борт, чтобы начать учёт.</p></div>`}
      </section>
      ${nearestNote}
    `, { title: "Самолёты", subtitle: "Авиаресурс" });
  }

  function renderAircraft() {
    const aircraft = selectedAircraft();
    const activeTab = state.aircraftTab || "aggregates";
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

    const isWork = (item) => item.notificationCategory === "workUsage" || item.notificationCategory === "workDate";
    const leastReliableResources = aircraft.resources
      .filter((resource) => resource.object !== "Самолёт" && resource.limit > 0 && !isWork(resource))
      .sort((a, b) => (a.remaining / a.limit) - (b.remaining / b.limit));

    const works = aircraft.resources.filter(isWork);
    const worksTab = `
      <div class="section-heading"><h2>Регламентные работы</h2></div>
      <section class="resource-list">${works.length ? resourceRows(works, { editable: true }) : `<div class="empty-state compact-empty"><p>Регламентных работ пока нет.</p></div>`}</section>
      <button class="add-block-button" data-action="add-resource" data-work="true">${icon("plus")} Добавить регламентную работу</button>
      <div class="section-heading history-heading"><div><h2>Последние смены</h2><p>Сохранённые начисления по выбранному борту.</p></div></div>
      <section class="history-list">${recentShifts || `<div class="empty-state compact-empty"><p>Смен пока нет. Добавьте первую запись.</p></div>`}</section>
      <button class="add-block-button" data-view="reports">Отчёты по сменам</button>`;

    const aggregatesTab = `
      <div class="section-heading"><div><h2>Агрегаты</h2><p>Формуляры, двигатели и агрегаты самолёта.</p></div><button class="text-button" data-action="edit-blocks">Изменить</button></div>
      <section class="equipment-list">${blocks || `<div class="empty-state compact-empty"><p>Агрегатов пока нет.</p></div>`}</section>
      <button class="add-block-button" data-action="add-block">${icon("plus")} Добавить агрегат или формуляр</button>`;

    const leastReliableTab = `
      <div class="section-heading"><div><h2>Агрегаты с наименее надёжным ресурсом</h2><p>Сначала показаны агрегаты с наименьшей долей оставшегося ресурса.</p></div></div>
      <section class="resource-list">${leastReliableResources.length ? resourceRows(leastReliableResources, { editable: true }) : `<div class="empty-state compact-empty"><p>Агрегатов с ограниченным ресурсом пока нет.</p></div>`}</section>
      <button class="add-block-button" data-action="add-resource">${icon("plus")} Добавить агрегат с ограниченным ресурсом</button>`;

    const tabContent = activeTab === "aggregates"
      ? aggregatesTab
      : activeTab === "least-reliable"
        ? leastReliableTab
        : worksTab;

    const tabs = `<nav class="aircraft-tabs" aria-label="Разделы самолёта">
        <button class="aircraft-tab ${activeTab === "works" ? "is-active" : ""}" data-aircraft-tab="works" aria-selected="${activeTab === "works"}">Работы</button>
        <button class="aircraft-tab ${activeTab === "aggregates" ? "is-active" : ""}" data-aircraft-tab="aggregates" aria-selected="${activeTab === "aggregates"}">Агрегаты</button>
        <button class="aircraft-tab ${activeTab === "least-reliable" ? "is-active" : ""}" data-aircraft-tab="least-reliable" aria-selected="${activeTab === "least-reliable"}">Агрегаты с наименее надёжным ресурсом</button>
      </nav>`;
    app.innerHTML = shell(`
      ${tabs}
      <div class="aircraft-actions">
        <button class="secondary-button" data-view="resources">${icon("resource")} Остатки ресурсов</button>
        <button class="primary-button" data-view="shift">${icon("log")} Внести лётную смену</button>
      </div>
      <button class="text-button" data-view="aircraft-layout">Настроить раскладку</button>
      ${aircraft.counterLayout ? counterTiles(aircraft, aircraft.counterLayout) : `<table class="aircraft-counters" aria-label="Наработка борта">
        <thead><tr><th scope="col">Показатель</th><th scope="col">СНЭ</th><th scope="col">ППР</th></tr></thead>
        <tbody>
          <tr><th scope="row">${escapeHtml(usageRule("flight").label)}</th><td>${calc.formatDuration(aircraft.totalFlightMinutes)}</td><td>${aircraft.pprFlightMinutes == null ? "Не задано" : calc.formatDuration(aircraft.pprFlightMinutes)}</td></tr>
          <tr><th scope="row">Посадки</th><td>${aircraft.actualLandings}</td><td>${aircraft.pprLandings ?? "Не задано"}</td></tr>
        </tbody>
      </table>`}
      <section class="aircraft-tab-panel">${tabContent}</section>
    `, { title: `${aircraft.type} · Борт ${aircraft.boardNumber}`, subtitle: "", singleLine: true, back: true, settingsScope: "aircraft" });
  }

  const defaultCounterLayout = [
    { keys: ["flightSne", "flightPpr"], wide: true },
    { keys: ["landingSne", "landingPpr"], wide: true },
  ];
  let leaveAircraftLayout;

  function chooseLayoutAction(title, choices, onChoose) {
    const dialog = document.createElement("dialog");
    dialog.className = "confirm-dialog";
    dialog.innerHTML = `<form method="dialog"><h2>${title}</h2>
      ${choices.map(([value, label]) => `<button class="secondary-button" value="${value}">${label}</button>`).join("")}</form>`;
    app.append(dialog);
    dialog.addEventListener("close", () => {
      const value = dialog.returnValue;
      dialog.remove();
      onChoose(value);
    }, { once: true });
    dialog.showModal();
  }

  function counterTiles(aircraft, layout, editing = false) {
    const name = escapeHtml(usageRule("flight").label);
    const values = {
      flightSne: [name + " СНЭ", calc.formatDuration(aircraft.totalFlightMinutes)],
      flightPpr: [name + " ППР", aircraft.pprFlightMinutes == null ? "Не задано" : calc.formatDuration(aircraft.pprFlightMinutes)],
      landingSne: ["Посадки СНЭ", aircraft.actualLandings],
      landingPpr: ["Посадки ППР", aircraft.pprLandings ?? "Не задано"],
    };
    return `<section class="counter-tiles" aria-label="Наработка борта">${layout.map((tile, index) => `
      <article class="counter-tile ${tile.wide ? "counter-tile-wide" : ""}">
        ${editing ? `<button type="button" class="counter-drag-handle" data-drag-index="${index}" aria-label="Перетащить карточку">⠿</button>` : ""}
        ${tile.keys.map((key) => `<div>${values[key][0]} <strong>${values[key][1]}</strong></div>`).join("")}
        ${editing ? `<div class="counter-controls">
          ${[["up","↑","Вверх"],["down","↓","Вниз"],["left","←","Влево"],["right","→","Вправо"],["size",tile.wide ? "Сузить" : "Расширить","Изменить ширину"],
            ...(index + 1 < layout.length ? [["merge","Объединить","Объединить со следующей карточкой"]] : []),
            ...(tile.keys.length > 1 ? [["split","Разделить","Разделить показатели"]] : []),
          ].map(([action, label, title]) => `<button class="secondary-button" type="button" data-layout-action="${action}" data-index="${index}" aria-label="${title}">${label}</button>`).join("")}
        </div>` : ""}
      </article>`).join("")}</section>`;
  }

  function renderAircraftLayout() {
    const aircraft = selectedAircraft();
    let draft = structuredClone(aircraft.counterLayout ?? defaultCounterLayout);
    const initial = JSON.stringify(draft);
    app.innerHTML = shell(`<h1>Раскладка карточки</h1>
      <p class="field-help">Потяни карточку за ручку ⠿. Порядок, ширина и группировка сохраняются для этого борта.</p>
      <div id="counter-preview"></div>
      <div class="aircraft-actions"><button class="primary-button" id="layout-save">Сохранить</button>
      <button class="secondary-button" id="layout-default">Восстановить по умолчанию</button></div>`,
    { title: "Раскладка карточки", subtitle: "", back: true, settings: false });
    const preview = document.getElementById("counter-preview");
    const paint = () => { preview.innerHTML = counterTiles(aircraft, draft, true); };
    let drag;
    let hold;
    function clearDrag() {
      preview.querySelector(".counter-dragging")?.classList.remove("counter-dragging");
      preview.querySelector(".counter-drop-target")?.classList.remove("counter-drop-target");
      drag = null;
    }
    preview.addEventListener("pointerdown", (event) => {
      const handle = event.target.closest("[data-drag-index]");
      if (!handle || !event.isPrimary || event.button !== 0) return;
      handle.setPointerCapture(event.pointerId);
      drag = { pointer: event.pointerId, source: Number(handle.dataset.dragIndex), target: null };
      handle.closest(".counter-tile").classList.add("counter-dragging");
    });
    preview.addEventListener("pointermove", (event) => {
      if (drag?.pointer !== event.pointerId) return;
      markDropTarget(event.clientX, event.clientY);
    });
    function markDropTarget(x, y) {
      const cards = [...preview.querySelectorAll(".counter-tile")];
      const underPointer = document.elementFromPoint(x, y)?.closest(".counter-tile");
      const target = cards.indexOf(underPointer);
      drag.target = target >= 0 && target !== drag.source ? target : null;
      cards.forEach((card, index) => card.classList.toggle("counter-drop-target", index === drag.target));
    }
    preview.addEventListener("pointerup", (event) => {
      if (drag?.pointer !== event.pointerId) return;
      dropCard();
    });
    function dropCard() {
      const { source, target } = drag;
      clearDrag();
      if (target == null) return;
      [draft[source], draft[target]] = [draft[target], draft[source]];
      paint();
    }
    function cancelPointerDrag(event) {
      if (drag?.pointer === event.pointerId) clearDrag();
    }
    preview.addEventListener("pointercancel", cancelPointerDrag);
    preview.addEventListener("lostpointercapture", cancelPointerDrag);
    function cancelHold() {
      if (hold) clearTimeout(hold.timer);
      hold = null;
    }
    preview.addEventListener("touchstart", (event) => {
      if (hold && drag?.touch === hold.id) clearDrag();
      cancelHold();
      const card = event.target.closest(".counter-tile");
      if (drag || !card || event.target.closest("button") || event.touches.length !== 1) return;
      const touch = event.touches[0];
      hold = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
      hold.timer = setTimeout(() => {
        if (!card.isConnected) return;
        const cards = [...preview.querySelectorAll(".counter-tile")];
        drag = { touch: hold.id, source: cards.indexOf(card), target: null };
        card.classList.add("counter-dragging");
      }, 450);
    }, { passive: true });
    preview.addEventListener("touchmove", (event) => {
      if (!hold) return;
      const touch = [...event.touches].find((item) => item.identifier === hold.id);
      if (!touch) return;
      if (drag?.touch === hold.id) {
        if (event.cancelable) event.preventDefault();
        markDropTarget(touch.clientX, touch.clientY);
      } else if (Math.hypot(touch.clientX - hold.x, touch.clientY - hold.y) > 8) {
        cancelHold();
      }
    }, { passive: false });
    preview.addEventListener("touchend", (event) => {
      if (!hold || ![...event.changedTouches].some((item) => item.identifier === hold.id)) return;
      if (drag?.touch === hold.id) {
        if (event.cancelable) event.preventDefault();
        dropCard();
      }
      cancelHold();
    });
    preview.addEventListener("touchcancel", () => {
      if (hold && drag?.touch === hold.id) clearDrag();
      cancelHold();
    });
    preview.addEventListener("contextmenu", (event) => {
      if (event.target.closest(".counter-tile")) event.preventDefault();
    });
    function save() {
      const previous = aircraft.counterLayout;
      aircraft.counterLayout = JSON.stringify(draft) === JSON.stringify(defaultCounterLayout) ? undefined : structuredClone(draft);
      if (saveState()) finishBackNavigation();
      else {
        aircraft.counterLayout = previous;
        showToast("Не удалось сохранить раскладку");
      }
    }
    leaveAircraftLayout = () => {
      if (JSON.stringify(draft) === initial) return false;
      chooseLayoutAction("Сохранить изменения раскладки?", [["save","Сохранить"],["discard","Выйти без сохранения"],["cancel","Остаться"]], (action) => {
        if (action === "save") save();
        if (action === "discard") finishBackNavigation();
      });
      return true;
    };
    preview.addEventListener("click", (event) => {
      const button = event.target.closest("[data-layout-action]");
      if (!button) return;
      const index = Number(button.dataset.index);
      const action = button.dataset.layoutAction;
      const tile = draft[index];
      if (action === "size") tile.wide = !tile.wide;
      else if (action === "split") draft.splice(index, 1, ...tile.keys.map((key) => ({ keys: [key], wide: false })));
      else if (action === "merge") {
        tile.keys.push(...draft[index + 1].keys);
        tile.wide = true;
        draft.splice(index + 1, 1);
      } else {
        const cards = [...preview.querySelectorAll(".counter-tile")];
        const reference = cards[index].getBoundingClientRect();
        const horizontal = action === "left" || action === "right";
        const sign = action === "left" || action === "up" ? -1 : 1;
        const [candidate] = cards.map((card, target) => {
          const rect = card.getBoundingClientRect();
          return { target, dx: rect.left - reference.left, dy: rect.top - reference.top };
        }).filter(({ dx, dy }) => horizontal ? Math.abs(dy) < 1 && dx * sign > 0 : dy * sign > 0)
          .sort((a, b) => horizontal ? Math.abs(a.dx) - Math.abs(b.dx) : Math.abs(a.dy) - Math.abs(b.dy) || Math.abs(a.dx) - Math.abs(b.dx));
        if (candidate) [draft[index], draft[candidate.target]] = [draft[candidate.target], draft[index]];
      }
      paint();
    });
    document.getElementById("layout-save").onclick = save;
    document.getElementById("layout-default").onclick = () => {
      chooseLayoutAction("Восстановить стандартную раскладку?", [["reset","Восстановить"],["cancel","Отмена"]], (action) => {
        if (action !== "reset") return;
        draft = structuredClone(defaultCounterLayout);
        paint();
      });
    };
    paint();
  }

  function renderResources() {
    const aircraft = selectedAircraft();
    const resources = aircraft.resources.filter((item) => !["workUsage", "workDate"].includes(item.notificationCategory));
    const initialResources = [...resources].sort(calc.compareResourceRemaining);
    app.innerHTML = shell(`
      <section class="page-heading">
        <div><p class="eyebrow">${escapeHtml(aircraft.type)} · борт ${escapeHtml(aircraft.boardNumber)}</p><h1>Остатки ресурсов</h1></div>
        <label class="search-field">${icon("search")}<input id="resource-search" type="search" placeholder="Поиск по объектам и работам"></label>
      </section>
      <div class="filter-row" role="group" aria-label="Сортировка ресурсов">
        <button class="filter-chip is-active" data-sort="remaining">По доле остатка</button>
        <button class="filter-chip" data-sort="installed">По установке</button>
        <button class="filter-chip" data-sort="produced">По производству</button>
        <button class="filter-chip" data-sort="used">По наработке</button>
        <button class="filter-chip" data-sort="flightRemaining">Остаток по наработке</button>
        <button class="filter-chip" data-sort="calendarRemaining">Календарный остаток</button>
      </div>
      <section id="resource-list" class="resource-list">${resourceRows(initialResources, { editable: true })}</section>
      <button class="add-block-button" data-action="add-resource">${icon("plus")} Добавить ресурсный объект</button>
    `, { title: "Остатки ресурсов", subtitle: "Самолёт, двигатели и агрегаты", back: true, settingsScope: "aircraft" });

    const search = document.getElementById("resource-search");
    let key = "remaining";
    function updateList() {
      const query = search.value.trim().toLowerCase();
      let sorted = resources.filter((item) => `${item.object} ${item.name}`.toLowerCase().includes(query));
      if (key === "installed" || key === "produced") {
        sorted.sort((a, b) => (a[key] || "9999-12-31").localeCompare(b[key] || "9999-12-31"));
      } else if (key === "used") {
        sorted = sorted.filter((item) => item.unit === "ч")
          .sort((a, b) => (b.limit - b.remaining) - (a.limit - a.remaining));
      } else if (key === "flightRemaining") {
        sorted = sorted.filter((item) => item.unit === "ч").sort((a, b) => a.remaining - b.remaining);
      } else if (key === "calendarRemaining") {
        sorted = sorted.filter((item) => item.unit === "дн.").sort((a, b) => a.remaining - b.remaining);
      } else {
        sorted.sort(calc.compareResourceRemaining);
      }
      document.getElementById("resource-list").innerHTML = resourceRows(sorted, { editable: true });
      bindResourceButtons();
    }
    search.addEventListener("input", updateList);
    document.querySelectorAll("[data-sort]").forEach((button) => button.addEventListener("click", () => {
      document.querySelectorAll("[data-sort]").forEach((item) => item.classList.toggle("is-active", item === button));
      key = button.dataset.sort;
      updateList();
    }));
  }

  function resourceRows(resources, options = {}) {
    if (!resources.length) return `<div class="empty-state"><h2>Ничего не найдено</h2><p>Измените поисковый запрос.</p></div>`;
    return resources.map((resource) => {
      const percent = resource.limit > 0 ? Math.max(0, Math.min(100, resource.remaining / resource.limit * 100)) : null;
      return `<article class="resource-row">
        <div class="resource-row__top"><div><span>${escapeHtml(resource.object)}</span><strong>${escapeHtml(resource.name)}</strong></div><span class="resource-value status-text-${resource.status}">${formatNumber(resource.remaining)} ${escapeHtml(resource.unit)}</span></div>
        ${percent == null ? "" : `<div class="progress-track"><span class="progress-fill status-bg-${resource.status}" style="width:${percent}%"></span></div>
        <p class="field-help">Остаток: ${formatNumber(percent)}% от ${formatNumber(resource.limit)} ${escapeHtml(resource.unit)}</p>`}
        <div class="resource-row__meta"><span>Установлен: ${formatOptionalDate(resource.installed)}</span><span>Изготовлен: ${formatOptionalDate(resource.produced)}</span></div>
        ${options.editable ? `<button class="resource-edit-button" data-resource-id="${resource.id}">Открыть карточку</button>` : ""}
      </article>`;
    }).join("");
  }

  function renderShift() {
    const aircraft = selectedAircraft();
    const ground = usageTypeOverride(aircraft)?.ground ?? state.sharedGround ?? aircraft.settings;
    const today = new Date();
    const localDate = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    app.innerHTML = shell(`
      <section class="page-heading compact">
        <div><p class="eyebrow">Новая запись</p><h1>Лётная смена</h1><p>${escapeHtml(aircraft.type)} · борт ${escapeHtml(aircraft.boardNumber)}</p></div>
      </section>
      <form id="shift-form" class="shift-form">
        <fieldset><legend>Общие данные</legend>
          <label><span>Дата смены</span><input name="date" type="date" value="${localDate}" required></label>
          <div class="field-pair">
            <label><span>${escapeHtml(usageRule("flight").label)}, часы</span><input name="flightHours" type="number" min="0" value="1" step="1"></label>
            <label><span>${escapeHtml(usageRule("flight").label)}, минуты</span><input name="flightMinutes" type="number" min="0" max="59" value="0" step="1"></label>
          </div>
        </fieldset>
        <fieldset><legend>Посадки</legend>
          <div class="landing-grid">
            ${OPTIONAL_USAGE_TYPES.filter((key) => key !== "arresterHooks" && usageRule(key).enabled !== false).map((key) => `<label><span>${escapeHtml(usageRule(key).label)}</span><input name="${key}" type="number" min="0" value="${key === "runway" ? 1 : 0}"></label>`).join("")}
          </div>
          ${usageRule("arresterHooks").enabled !== false ? `<label><span>${escapeHtml(usageRule("arresterHooks").label)}</span><input name="arresterHooks" type="number" min="0" value="0"></label>` : ""}
        </fieldset>
        <fieldset><legend>${escapeHtml(usageRule("ground").label)}</legend>
          <p class="field-help">Шаг округления: ${ground.groundRoundingMinutes} мин. В наработку двигателя идёт ${ground.groundPercent}% от округлённого времени.</p>
          <label><span>Левый двигатель, фактически</span><div class="input-with-unit"><input id="left-ground" name="leftGround" type="number" min="0" value="13"><span>мин</span></div></label>
          <div id="left-calculation" class="calculation-preview"></div>
          <label><span>Правый двигатель, фактически</span><div class="input-with-unit"><input id="right-ground" name="rightGround" type="number" min="0" value="13"><span>мин</span></div></label>
          <div id="right-calculation" class="calculation-preview"></div>
          <div class="field-pair">
            <label><span>Запуски левого двигателя</span><input name="leftStarts" type="number" min="0" value="0"></label>
            <label><span>Запуски правого двигателя</span><input name="rightStarts" type="number" min="0" value="0"></label>
          </div>
        </fieldset>
        <fieldset><legend>${escapeHtml(usageRule("maximum").label)}</legend>
          <div class="field-pair"><label>Левый двигатель, секунды<input name="leftMaximum" type="number" min="0" value="0"></label><label>Правый двигатель, секунды<input name="rightMaximum" type="number" min="0" value="0"></label></div>
        </fieldset>
        <fieldset><legend>Режимы левого двигателя</legend>
          <p class="field-help">Вложенные счётчики сохраняются отдельно: Б уже включает ОР, а Б + УБ уже включает Б и ОР.</p>
          <div class="mode-grid"><label><span>ОР</span><input name="leftOrMode" type="time" step="1" value="00:00:00"></label><label><span>Б, включая ОР</span><input name="leftCombatMode" type="time" step="1" value="00:00:00"></label><label><span>Б + УБ, включая Б и ОР</span><input name="leftCombinedMode" type="time" step="1" value="00:00:00"></label></div>
        </fieldset>
        <fieldset><legend>Режимы правого двигателя</legend>
          <div class="mode-grid"><label><span>ОР</span><input name="rightOrMode" type="time" step="1" value="00:00:00"></label><label><span>Б, включая ОР</span><input name="rightCombatMode" type="time" step="1" value="00:00:00"></label><label><span>Б + УБ, включая Б и ОР</span><input name="rightCombinedMode" type="time" step="1" value="00:00:00"></label></div>
        </fieldset>
        <section id="shift-summary" class="shift-summary"></section>
        <button type="submit" class="primary-button wide">Рассчитать и сохранить смену</button>
      </form>
    `, { title: "Лётная смена", subtitle: `${aircraft.type} · борт ${aircraft.boardNumber}`, back: true, settingsScope: "aircraft" });
    bindShiftForm();
  }

  function bindShiftForm() {
    const form = document.getElementById("shift-form");
    const aircraft = selectedAircraft();
    const override = usageTypeOverride(aircraft);
    const ground = override?.ground ?? state.sharedGround ?? aircraft.settings;
    const factor = (key) => override?.factors[key] ?? usageRule(key).factor;
    const groundOptions = {
      stepMinutes: ground.groundRoundingMinutes,
      direction: ground.groundRoundingDirection,
      percent: ground.groundPercent,
    };
    const coefficients = state.usageRules || override
      ? Object.fromEntries(["runway", "carrier", "touch", "circuit"].map((key) => [key, factor(key)]))
      : aircraft.settings.landingCoefficients;
    function engineIncrement(flight, actualGround) {
      const result = calc.calculateEngineIncrement(flight, actualGround, groundOptions);
      result.totalMinutes = flight * factor("flight") + result.ground.contributionMinutes * factor("ground");
      return result;
    }
    const update = () => {
      const data = new FormData(form);
      const flight = Number(data.get("flightHours")) * 60 + Number(data.get("flightMinutes"));
      const left = engineIncrement(flight, Number(data.get("leftGround")));
      const right = engineIncrement(flight, Number(data.get("rightGround")));
      const equivalent = calc.calculateEquivalentLandings({ runway: data.get("runway"), carrier: data.get("carrier"), touch: data.get("touch"), circuit: data.get("circuit") }, coefficients);
      document.getElementById("left-calculation").textContent = `${left.ground.actualMinutes} → ${left.ground.roundedMinutes} мин → ${left.ground.percent}% = ${formatNumber(left.ground.contributionMinutes)} мин`;
      document.getElementById("right-calculation").textContent = `${right.ground.actualMinutes} → ${right.ground.roundedMinutes} мин → ${right.ground.percent}% = ${formatNumber(right.ground.contributionMinutes)} мин`;
      document.getElementById("shift-summary").innerHTML = `<span>Будет начислено</span><strong>Левый: ${calc.formatDuration(left.totalMinutes)} · Правый: ${calc.formatDuration(right.totalMinutes)}</strong><small>Зачёт посадок: ${equivalent.toLocaleString("ru-RU", { maximumFractionDigits: 6 })}</small>`;
    };
    form.addEventListener("input", update);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const modeError = validateNestedModes(data, "left", "левого") || validateNestedModes(data, "right", "правого");
      if (modeError) {
        showToast(modeError);
        return;
      }
      const flight = Number(data.get("flightHours")) * 60 + Number(data.get("flightMinutes"));
      const left = engineIncrement(flight, Number(data.get("leftGround")));
      const right = engineIncrement(flight, Number(data.get("rightGround")));
      const landings = {
        runway: Number(data.get("runway")),
        carrier: Number(data.get("carrier")),
        touch: Number(data.get("touch")),
        circuit: Number(data.get("circuit")),
      };
      const actualLandings = Object.values(landings).reduce((sum, value) => sum + value, 0);
      const equivalent = calc.calculateEquivalentLandings(landings, coefficients);
      const arresterHooks = Number(data.get("arresterHooks"));

      aircraft.totalFlightMinutes += flight;
      aircraft.actualLandings += actualLandings;
      if (aircraft.pprFlightMinutes != null) aircraft.pprFlightMinutes += flight;
      if (aircraft.pprLandings != null) aircraft.pprLandings += actualLandings;
      aircraft.equivalentLandings = Math.round((aircraft.equivalentLandings + equivalent) * 1e6) / 1e6;
      aircraft.arresterHooks += arresterHooks;
      const leftBlock = aircraft.blocks.find((block) => block.id === "engine-left");
      const rightBlock = aircraft.blocks.find((block) => block.id === "engine-right");
      if (leftBlock?.installed) {
        if (leftBlock.hasSne) leftBlock.sneMinutes = (leftBlock.sneMinutes || 0) + left.totalMinutes;
        if (leftBlock.hasPpr) leftBlock.pprMinutes = (leftBlock.pprMinutes || 0) + left.totalMinutes;
        leftBlock.starts = (leftBlock.starts || 0) + Number(data.get("leftStarts"));
        accumulateModes(leftBlock, data, "left");
        leftBlock.maximumSeconds = (leftBlock.maximumSeconds ?? 0) + Number(data.get("leftMaximum")) * factor("maximum");
      }
      if (rightBlock?.installed) {
        if (rightBlock.hasSne) rightBlock.sneMinutes = (rightBlock.sneMinutes || 0) + right.totalMinutes;
        if (rightBlock.hasPpr) rightBlock.pprMinutes = (rightBlock.pprMinutes || 0) + right.totalMinutes;
        rightBlock.starts = (rightBlock.starts || 0) + Number(data.get("rightStarts"));
        accumulateModes(rightBlock, data, "right");
        rightBlock.maximumSeconds = (rightBlock.maximumSeconds ?? 0) + Number(data.get("rightMaximum")) * factor("maximum");
      }
      aircraft.resources.forEach((resource) => {
        const owner = aircraft.blocks.find((block) => block.name === resource.object);
        if (owner?.installed === false) return;
        const side = owner === leftBlock && leftBlock ? "left" : owner === rightBlock && rightBlock ? "right" : null;
        let spent;
        if (resource.unit === "ч") {
          if (owner?.kind === "engine" && !side) return;
          spent = (side === "left" ? left.totalMinutes : side === "right" ? right.totalMinutes : flight) / 60;
        } else if (resource.unit === "зап." && side) {
          spent = Number(data.get(`${side}Starts`));
        } else {
          return;
        }
        resource.remaining = Math.max(0, resource.remaining - spent);
        resource.status = resourceStatus(resource.remaining, resource.limit);
      });
      aircraft.shifts.push({
        id: `shift-${Date.now()}`,
        date: String(data.get("date")),
        flightMinutes: flight,
        leftEngineMinutes: left.totalMinutes,
        rightEngineMinutes: right.totalMinutes,
        landingsByType: landings,
        landingCoefficients: { ...coefficients },
        usageRules: Object.fromEntries(Object.keys(USAGE_TYPES).map((key) => [key, { ...usageRule(key), factor: factor(key) }])),
        groundOptions: { ...groundOptions },
        weightedHooks: arresterHooks * factor("arresterHooks"),
        leftMaximumSeconds: Number(data.get("leftMaximum")),
        rightMaximumSeconds: Number(data.get("rightMaximum")),
        actualLandings,
        equivalentLandings: equivalent,
        arresterHooks,
        leftGroundActualMinutes: left.ground.actualMinutes,
        leftGroundRoundedMinutes: left.ground.roundedMinutes,
        rightGroundActualMinutes: right.ground.actualMinutes,
        rightGroundRoundedMinutes: right.ground.roundedMinutes,
        leftStarts: Number(data.get("leftStarts")),
        rightStarts: Number(data.get("rightStarts")),
        leftModesSeconds: readModes(data, "left"),
        rightModesSeconds: readModes(data, "right"),
      });
      saveState();
      state.view = "aircraft";
      if (viewStack.at(-1) === "aircraft") viewStack.pop();
      render();
      showToast(`Смена сохранена: левый ${calc.formatDuration(left.totalMinutes)}, правый ${calc.formatDuration(right.totalMinutes)}.`);
    });
    update();
  }

  function timeToSeconds(value) {
    return calc.parseClockDuration(value);
  }

  function readModes(data, side) {
    return {
      or: timeToSeconds(data.get(`${side}OrMode`)),
      combat: timeToSeconds(data.get(`${side}CombatMode`)),
      combined: timeToSeconds(data.get(`${side}CombinedMode`)),
    };
  }

  function validateNestedModes(data, side, label) {
    const modes = readModes(data, side);
    const error = calc.validateNestedEngineModes(modes);
    if (error === "combat_lt_or") return `Режим Б ${label} двигателя не может быть меньше ОР: Б уже включает ОР.`;
    if (error === "combined_lt_combat") return `Режим Б + УБ ${label} двигателя не может быть меньше Б: он уже включает Б и ОР.`;
    return "";
  }

  function accumulateModes(block, data, side) {
    const modes = readModes(data, side);
    block.modesSeconds = block.modesSeconds || { or: 0, combat: 0, combined: 0 };
    block.modesSeconds.or += modes.or;
    block.modesSeconds.combat += modes.combat;
    block.modesSeconds.combined += modes.combined;
  }

  function renderAircraftSettings() {
    const aircraft = selectedAircraft();
    const blockRows = aircraft.blocks.map((block) => `
      <div class="setting-row block-setting-row">
        <span><strong>${escapeHtml(block.name)}</strong><small>${escapeHtml(block.caption)}</small></span>
        <span class="inline-actions">
          <button type="button" class="small-button" data-rename-block-id="${block.id}">Переименовать</button>
          <button type="button" class="small-button danger-button" data-remove-block-id="${block.id}">Удалить</button>
        </span>
      </div>`).join("");
    const coefficients = aircraft.settings.landingCoefficients;
    const notificationConfig = aircraft.notificationConfig;
    const notificationRows = aircraft.resources.map((resource) => `
      <div class="setting-row notification-work-row" data-notification-work="${escapeHtml(`${resource.object} ${resource.name}`.toLowerCase())}">
        <span><strong>${escapeHtml(resource.name)}</strong><small>${escapeHtml(resource.object)} · ${formatNumber(resource.remaining)} ${escapeHtml(resource.unit)}</small></span>
        <span class="notification-channel-toggles"><label title="Приложение"><input data-resource-notify-app="${resource.id}" type="checkbox" ${resource.notifyApp !== false ? "checked" : ""} ${!aircraft.notifications ? "disabled" : ""}><small>Прил.</small></label><label title="Календарь"><input data-resource-notify-calendar="${resource.id}" type="checkbox" ${resource.notifyCalendar ? "checked" : ""} ${!aircraft.notifications ? "disabled" : ""}><small>Кал.</small></label></span>
      </div>`).join("");
    app.innerHTML = shell(`
      <section class="page-heading compact"><div><p class="eyebrow">${escapeHtml(aircraft.type)} · борт ${escapeHtml(aircraft.boardNumber)}</p><h1>Настройки самолёта</h1></div></section>
      <section class="settings-list">
        <label class="setting-row"><span><strong>Уведомления этого самолёта</strong><small>${state.globalNotifications ? "Работы и ресурсы выбранного борта" : "Общие уведомления приложения выключены"}</small></span><input id="aircraft-notifications" type="checkbox" ${aircraft.notifications ? "checked" : ""} ${!state.globalNotifications ? "disabled" : ""}></label>
      </section>
      <form id="notification-config-form" class="shift-form settings-form">
        <fieldset ${!aircraft.notifications ? "disabled" : ""}><legend>Отбор уведомлений</legend>
          <div class="field-pair"><label><span>Режим</span><select name="mode"><option value="all" ${notificationConfig.mode === "all" ? "selected" : ""}>Все уведомления самолёта</option><option value="selected" ${notificationConfig.mode === "selected" ? "selected" : ""}>Только выбранные категории и работы</option></select></label><label><span>По умолчанию заранее, дней</span><input name="leadDays" type="number" min="0" step="1" value="${notificationConfig.leadDays}"></label></div>
          <div class="category-grid">
            <label class="checkbox-row"><input name="workUsage" type="checkbox" ${notificationConfig.categories.workUsage ? "checked" : ""}><span>Работы по наработке</span></label>
            <label class="checkbox-row"><input name="workDate" type="checkbox" ${notificationConfig.categories.workDate ? "checked" : ""}><span>Работы по дате</span></label>
            <label class="checkbox-row"><input name="resourceUsage" type="checkbox" ${notificationConfig.categories.resourceUsage ? "checked" : ""}><span>Ресурс по наработке</span></label>
            <label class="checkbox-row"><input name="resourceDate" type="checkbox" ${notificationConfig.categories.resourceDate ? "checked" : ""}><span>Ресурс по дате</span></label>
          </div>
          <button type="submit" class="secondary-button wide">Сохранить отбор уведомлений</button>
        </fieldset>
      </form>
      <div class="section-heading settings-section-heading"><div><h2>Конкретные работы</h2><p>Независимые каналы приложения и штатного календаря.</p></div></div>
      <label class="search-field notification-search">${icon("search")}<input id="notification-work-search" type="search" placeholder="Поиск по работам и объектам"></label>
      <section class="settings-list notification-work-list">${notificationRows || `<div class="empty-state compact-empty"><p>Ресурсных работ пока нет.</p></div>`}</section>
      <form id="aircraft-rules-form" class="shift-form settings-form">
        <fieldset><legend>Пересчёт земной наработки</legend>
          <div class="field-pair">
            <label><span>Шаг округления, минут</span><input name="groundRoundingMinutes" type="number" min="1" step="1" value="${aircraft.settings.groundRoundingMinutes}" required></label>
            <label><span>Направление округления</span><select name="groundRoundingDirection">${[["nearest", "До ближайшего"], ["up", "Вверх"], ["down", "Вниз"]].map(([value, label]) => `<option value="${value}" ${aircraft.settings.groundRoundingDirection === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
            <label><span>Доля в общей наработке, %</span><input name="groundPercent" type="number" min="0" step="0.1" value="${aircraft.settings.groundPercent}" required></label>
          </div>
        </fieldset>
        <fieldset><legend>Коэффициенты приведённых посадок</legend>
          <div class="landing-grid">
            <label><span>БВПП</span><input name="runway" type="number" min="0" step="0.1" value="${coefficients.runway}" required></label>
            <label><span>Корабль</span><input name="carrier" type="number" min="0" step="0.1" value="${coefficients.carrier}" required></label>
            <label><span>Касание</span><input name="touch" type="number" min="0" step="0.1" value="${coefficients.touch}" required></label>
            <label><span>Конвейер</span><input name="circuit" type="number" min="0" step="0.1" value="${coefficients.circuit}" required></label>
          </div>
        </fieldset>
        <button type="submit" class="primary-button wide">Сохранить расчётные настройки</button>
      </form>
      <div class="section-heading settings-section-heading"><div><h2>Формуляры и агрегаты</h2><p>Добавление, переименование и удаление блоков.</p></div></div>
      <section class="settings-list">${blockRows || `<div class="empty-state compact-empty"><p>Блоков пока нет.</p></div>`}</section>
      <button class="add-block-button" data-action="add-block">${icon("plus")} Добавить блок</button>
    `, { title: "Настройки самолёта", subtitle: `${aircraft.type} · борт ${aircraft.boardNumber}`, back: true, settings: false });

    document.getElementById("aircraft-notifications").addEventListener("change", (event) => {
      aircraft.notifications = state.globalNotifications && event.target.checked;
      saveState();
      showToast(`Уведомления борта ${aircraft.boardNumber} ${aircraft.notifications ? "включены" : "выключены"}`);
      render();
    });
    document.getElementById("notification-config-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      aircraft.notificationConfig = {
        mode: String(data.get("mode")),
        leadDays: Number(data.get("leadDays")),
        categories: {
          workUsage: data.get("workUsage") === "on",
          workDate: data.get("workDate") === "on",
          resourceUsage: data.get("resourceUsage") === "on",
          resourceDate: data.get("resourceDate") === "on",
        },
      };
      saveState();
      showToast("Отбор уведомлений сохранён");
    });
    document.getElementById("notification-work-search").addEventListener("input", (event) => {
      const query = event.target.value.trim().toLowerCase();
      document.querySelectorAll("[data-notification-work]").forEach((row) => { row.hidden = !row.dataset.notificationWork.includes(query); });
    });
    document.querySelectorAll("[data-resource-notify-app],[data-resource-notify-calendar]").forEach((toggle) => toggle.addEventListener("change", (event) => {
      const id = event.target.dataset.resourceNotifyApp || event.target.dataset.resourceNotifyCalendar;
      const resource = aircraft.resources.find((item) => item.id === id);
      if (!resource) return;
      if (event.target.dataset.resourceNotifyApp) resource.notifyApp = event.target.checked;
      else resource.notifyCalendar = event.target.checked;
      saveState();
    }));
    document.getElementById("aircraft-rules-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      aircraft.settings.groundRoundingMinutes = Number(data.get("groundRoundingMinutes"));
      aircraft.settings.groundRoundingDirection = String(data.get("groundRoundingDirection"));
      aircraft.settings.groundPercent = Number(data.get("groundPercent"));
      aircraft.settings.landingCoefficients = {
        runway: Number(data.get("runway")),
        carrier: Number(data.get("carrier")),
        touch: Number(data.get("touch")),
        circuit: Number(data.get("circuit")),
      };
      const key = aircraft.type.trim().toLowerCase();
      state.typeSettings = state.typeSettings.filter((entry) => entry.type.toLowerCase() !== key);
      state.typeSettings.push({ type: aircraft.type, settings: structuredClone(aircraft.settings) });
      saveState();
      showToast("Настройки сохранены для борта и новых самолётов этого типа");
    });
    document.querySelectorAll("[data-rename-block-id]").forEach((button) => button.addEventListener("click", () => renameBlockById(button.dataset.renameBlockId)));
    document.querySelectorAll("[data-remove-block-id]").forEach((button) => button.addEventListener("click", () => removeBlock(button.dataset.removeBlockId)));
  }

  function renderBlock() {
    const aircraft = selectedAircraft();
    const block = aircraft.blocks.find((item) => item.id === state.selectedBlockId);
    if (!block) {
      state.view = "aircraft";
      renderAircraft();
      return;
    }
    const engineFields = block.kind === "engine" ? `
      <fieldset><legend>Наработка двигателя</legend>
        <div class="field-pair"><label class="checkbox-row"><input name="hasSne" type="checkbox" ${block.hasSne ? "checked" : ""}><span>Вести СНЭ</span></label><label class="checkbox-row"><input name="hasPpr" type="checkbox" ${block.hasPpr ? "checked" : ""}><span>Вести ППР</span></label></div>
        <div class="field-pair">
          <label><span>СНЭ, минут</span><input name="sneMinutes" type="number" min="0" step="0.01" value="${block.sneMinutes || 0}"></label>
          <label><span>ППР, минут</span><input name="pprMinutes" type="number" min="0" step="0.01" value="${block.pprMinutes || 0}"></label>
        </div>
        <label><span>Количество запусков</span><input name="starts" type="number" min="0" step="1" value="${block.starts || 0}"></label>
        <div class="metric-grid compact-metrics">
          <div class="metric"><span>СНЭ</span><strong>${calc.formatDuration(block.sneMinutes || 0)}</strong></div>
          <div class="metric"><span>ППР</span><strong>${calc.formatDuration(block.pprMinutes || 0)}</strong></div>
          <div class="metric"><span>ОР</span><strong>${formatSeconds(block.modesSeconds?.or || 0)}</strong></div>
          <div class="metric"><span>Б, включая ОР</span><strong>${formatSeconds(block.modesSeconds?.combat || 0)}</strong></div>
          <div class="metric"><span>Б + УБ</span><strong>${formatSeconds(block.modesSeconds?.combined || 0)}</strong></div>
          <div class="metric"><span>${escapeHtml(usageRule("maximum").label)}</span><strong>${formatSeconds(block.maximumSeconds ?? 0)}</strong></div>
        </div>
      </fieldset>` : "";
    const relatedResources = aircraft.resources.filter((resource) =>
      resource.object === block.name || (block.kind === "airframe" && resource.object === "Самолёт")
    );
    const airframeFields = block.kind === "airframe" ? `
      <section class="metric-grid" aria-label="Наработка планера">
        <div class="metric"><span>${escapeHtml(usageRule("flight").label)}</span><strong>${calc.formatDuration(aircraft.totalFlightMinutes)}</strong></div>
        <div class="metric"><span>Фактические посадки</span><strong>${aircraft.actualLandings}</strong></div>
        <div class="metric"><span>Зацепы</span><strong>${aircraft.arresterHooks}</strong></div>
      </section>
      <fieldset><legend>ППР планера</legend>
        <p>Заводской № ${escapeHtml(aircraft.serialNumber)}</p>
        <label>${escapeHtml(usageRule("flight").label)} ППР, минут<input name="pprFlightMinutes" type="number" min="0" step="1" value="${aircraft.pprFlightMinutes ?? ""}"></label>
        <label>Посадки ППР<input name="pprLandings" type="number" min="0" step="1" value="${aircraft.pprLandings ?? ""}"></label>
      </fieldset>` : "";
    const eventLabels = { repair: "Ремонт", dismantle: "Демонтаж", install: "Установка", extension: "Продление ресурса", correction: "Корректировка" };
    const eventRows = block.events.slice().reverse().map((item) => {
      const before = item.beforeRepair;
      const counters = before ? [
        before.sneMinutes != null ? `СНЭ ${calc.formatDuration(before.sneMinutes)}` : "",
        before.pprMinutes != null ? `ППР ${calc.formatDuration(before.pprMinutes)}` : "",
        before.starts != null ? `Запуски: ${formatNumber(before.starts)}` : "",
      ].filter(Boolean).join(" · ") : "";
      return `<article class="history-row"><div><strong>${formatOptionalDate(item.date)}</strong>
        <span>${eventLabels[item.type] || "Событие"}${item.note ? ` · ${escapeHtml(item.note)}` : ""}</span>
        ${counters ? `<span>До ремонта: ${counters}</span>` : ""}</div></article>`;
    }).join("");
    app.innerHTML = shell(`
      <section class="page-heading compact"><div><p class="eyebrow">${escapeHtml(aircraft.type)} · борт ${escapeHtml(aircraft.boardNumber)}</p><h1>${escapeHtml(block.name)}</h1><p>${escapeHtml(block.caption)}</p></div></section>
      <form id="block-form" class="shift-form">
        <fieldset><legend>Формуляр</legend>
          <label><span>Название</span><input name="name" type="text" value="${escapeHtml(block.name)}" required></label>
          <label><span>Описание</span><input name="caption" type="text" value="${escapeHtml(block.caption)}"></label>
          <div class="field-pair"><label><span>Тип/модель</span><input name="model" type="text" value="${escapeHtml(block.model || "")}"></label><label><span>Заводской/обычный номер</span><input name="serialNumber" type="text" value="${escapeHtml(block.serialNumber || "")}"></label></div>
          <label><span>Чертёжный номер</span><input name="drawingNumber" type="text" value="${escapeHtml(block.drawingNumber || "")}"></label>
          <div class="field-pair"><label><span>Количество ремонтов</span><input name="repairs" type="number" min="0" step="1" value="${block.repairs || 0}"></label><label><span>Состояние установки</span><select name="installed"><option value="true" ${block.installed ? "selected" : ""}>Установлен</option><option value="false" ${!block.installed ? "selected" : ""}>Демонтирован</option></select></label></div>
        </fieldset>
        ${airframeFields}
        ${engineFields}
        <button type="submit" class="primary-button wide">Сохранить формуляр</button>
      </form>
      <div class="section-heading settings-section-heading"><div><h2>Ресурсы и работы</h2><p>Связанные с этим формуляром ограничения.</p></div></div>
      <section class="resource-list">${relatedResources.length ? resourceRows(relatedResources, { editable: true }) : `<div class="empty-state compact-empty"><p>Связанных ресурсов пока нет.</p></div>`}</section>
      <button class="add-block-button" data-action="add-resource" data-resource-object="${escapeHtml(block.name)}">${icon("plus")} Добавить ограниченный ресурс</button>
      <div class="section-heading settings-section-heading"><div><h2>История событий</h2><p>Смены, ремонты, установки и продления.</p></div></div>
      <section class="history-list">${eventRows || `<div class="empty-state compact-empty"><p>Исторических операций для этого объекта пока нет.</p></div>`}</section>
      <form id="block-event-form" class="shift-form event-form">
        <fieldset><legend>Добавить событие</legend>
          <div class="field-pair"><label><span>Тип события</span><select name="type"><option value="repair">Ремонт</option><option value="dismantle">Демонтаж</option><option value="install">Установка</option><option value="extension">Продление ресурса</option><option value="correction">Корректировка</option></select></label><label><span>Дата</span><input name="date" type="date" value="${todayIso()}" required></label></div>
          <label><span>Основание, документ или примечание</span><input name="note" type="text" placeholder="Номер бюллетеня, решения или акта"></label>
          <button type="submit" class="secondary-button wide">Записать событие</button>
        </fieldset>
      </form>
    `, { title: block.name, subtitle: "Формуляр объекта", back: true, settingsScope: "aircraft" });

    document.getElementById("block-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const oldName = block.name;
      block.name = String(data.get("name")).trim();
      block.caption = String(data.get("caption") || "").trim();
      block.model = String(data.get("model") || "").trim();
      block.serialNumber = String(data.get("serialNumber") || "").trim();
      block.drawingNumber = String(data.get("drawingNumber") || "").trim();
      block.repairs = Number(data.get("repairs"));
      block.installed = data.get("installed") === "true";
      if (block.kind === "airframe") {
        aircraft.pprFlightMinutes = data.get("pprFlightMinutes") === "" ? null : Number(data.get("pprFlightMinutes"));
        aircraft.pprLandings = data.get("pprLandings") === "" ? null : Number(data.get("pprLandings"));
      }
      if (block.kind === "engine") {
        block.hasSne = data.get("hasSne") === "on";
        block.hasPpr = data.get("hasPpr") === "on";
        block.sneMinutes = Number(data.get("sneMinutes"));
        block.pprMinutes = Number(data.get("pprMinutes"));
        block.starts = Number(data.get("starts"));
      }
      aircraft.resources.forEach((resource) => { if (resource.object === oldName) resource.object = block.name; });
      saveState();
      showToast("Формуляр сохранён");
      renderBlock();
      bindCommonActions();
    });
    document.getElementById("block-event-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const type = String(data.get("type"));
      const item = { id: `event-${Date.now()}`, type, date: String(data.get("date")), note: String(data.get("note") || "").trim() };
      if (type === "repair") {
        item.beforeRepair = {
          sneMinutes: block.hasSne ? block.sneMinutes ?? 0 : null,
          pprMinutes: block.hasPpr ? block.pprMinutes ?? 0 : null,
          starts: block.starts ?? null,
          repairs: block.repairs,
        };
        block.repairs += 1;
        if (block.hasPpr) block.pprMinutes = 0;
      } else if (type === "dismantle") {
        block.installed = false;
      } else if (type === "install") {
        block.installed = true;
      }
      block.events.push(item);
      saveState();
      render();
      showToast("Событие записано в историю");
    });
  }

  function renderReports() {
    const aircraft = selectedAircraft();
    const today = todayIso();
    app.innerHTML = shell(`
      <h1>Отчёты по сменам</h1>
      <form id="report-form" class="shift-form settings-form">
        <fieldset><legend>Период</legend>
          <label><span>Вид отчёта</span><select name="period"><option value="month">Месяц</option><option value="year">Год</option><option value="custom">Произвольный период</option></select></label>
          <div class="field-pair"><label><span>С</span><input name="from" type="date" value="${today}" required></label><label><span>По</span><input name="to" type="date" value="${today}" required></label></div>
          <button type="submit" class="primary-button">Показать отчёт</button>
        </fieldset>
      </form>
      <section id="report-results" class="history-list" aria-live="polite"></section>
    `, { title: "Отчёты", subtitle: `${aircraft.type} · борт ${aircraft.boardNumber}`, back: true });
    const form = document.getElementById("report-form");
    const output = document.getElementById("report-results");
    function showReport() {
      const { period, from, to } = form.elements;
      to.disabled = period.value !== "custom";
      const [year, month] = from.value.split("-").map(Number);
      let start = from.value;
      let end = to.value;
      if (period.value === "year") {
        start = `${year}-01-01`;
        end = `${year}-12-31`;
      } else if (period.value === "month") {
        start = `${from.value.slice(0, 7)}-01`;
        end = `${from.value.slice(0, 7)}-${new Date(year, month, 0).getDate()}`;
      }
      if (!from.value || !end || start > end) {
        output.textContent = "Укажи корректный период.";
        return;
      }
      const { rows, totals } = calc.summarizeShifts(aircraft.shifts, start, end);
      output.innerHTML = `<h2>${formatDate(start)} — ${formatDate(end)}</h2>
        <p>Смен: ${rows.length} · ${escapeHtml(usageRule("flight").label)}: ${calc.formatDuration(totals.flightMinutes)} · Посадки: ${totals.actualLandings} / ${formatNumber(totals.equivalentLandings)} в зачёт · Зацепы: ${totals.arresterHooks}</p>
        <p>Левый двигатель: ${calc.formatDuration(totals.leftEngineMinutes)}, запусков: ${totals.leftStarts}. Правый двигатель: ${calc.formatDuration(totals.rightEngineMinutes)}, запусков: ${totals.rightStarts}.</p>
        ${rows.map((row) => `<article class="history-row"><div><strong>${formatDate(row.date)}</strong><span>${escapeHtml(usageRule("flight").label)} ${calc.formatDuration(row.flightMinutes)} · ${row.actualLandings} посадок</span></div></article>`).join("")}`;
    }
    form.addEventListener("change", showReport);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      showReport();
    });
    showReport();
  }

  function renderAbout() {
    app.innerHTML = shell(`
      <section class="page-heading compact"><div><p class="eyebrow">Авиаресурс</p><h1>О приложении</h1></div></section>
      <section class="info-panel">${icon("plane")}<div><strong>Версия 0.2.7</strong><p>Локальный прототип персонального учёта ресурсов самолёта, двигателей и агрегатов.</p></div></section>
      <section class="info-panel">${icon("shield")}<div><strong>Хранение данных</strong><p>Текущая версия работает без интернета и хранит данные только на устройстве. Защищённый серверный режим ещё не включён.</p></div></section>
      <section class="info-panel">${icon("log")}<div><strong>Назначение сборки</strong><p>Эта версия предназначена для проверки структуры и расчётов и не заменяет утверждённую эксплуатационную документацию.</p></div></section>
    `, { title: "О приложении", subtitle: "Авиаресурс 0.2.7", back: true, settings: false });
  }

  function renderResourceEditor() {
    const aircraft = selectedAircraft();
    const resource = aircraft.resources.find((item) => item.id === state.selectedResourceId);
    const isNew = !resource;
    const draft = resource || {
      object: state.pendingResourceObject || "Новый агрегат",
      name: state.pendingWork ? "" : "Ограниченный ресурс",
      unit: "ч",
      remaining: 0,
      limit: 0,
      installed: "",
      produced: "",
      resourceType: "assigned",
      serialNumber: "",
      drawingNumber: "",
      repairs: 0,
      expiryDate: "",
      notificationCategory: state.pendingWork ? "workUsage" : "resourceUsage",
      notifyApp: true,
      notifyCalendar: false,
      advanceValue: 3,
      notifyOnDue: true,
    };
    const objectOptions = ["Самолёт", ...aircraft.blocks.map((block) => block.name)]
      .map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
    app.innerHTML = shell(`
      <section class="page-heading compact"><div><p class="eyebrow">${escapeHtml(aircraft.type)} · борт ${escapeHtml(aircraft.boardNumber)}</p><h1>${isNew ? "Новый ресурсный агрегат" : escapeHtml(draft.name)}</h1></div></section>
      <form id="resource-form" class="shift-form">
        <fieldset><legend>Агрегат и идентификация</legend>
          <label><span>Агрегат или объект</span><input name="object" type="text" list="resource-objects" value="${escapeHtml(draft.object)}" required><datalist id="resource-objects">${objectOptions}</datalist></label>
          <label><span>Наименование ограничения или работы</span><input name="name" type="text" value="${escapeHtml(draft.name)}" required></label>
          <div class="field-pair">
            <label><span>Заводской/обычный номер</span><input name="serialNumber" type="text" value="${escapeHtml(draft.serialNumber || "")}"></label>
            <label><span>Чертёжный номер</span><input name="drawingNumber" type="text" value="${escapeHtml(draft.drawingNumber || "")}"></label>
          </div>
          <label><span>Количество ремонтов</span><input name="repairs" type="number" min="0" step="1" value="${Number(draft.repairs) || 0}"></label>
        </fieldset>
        <fieldset><legend>Ограничение ресурса</legend>
          <label><span>Вид ограничения</span><select name="resourceType"><option value="assigned" ${draft.resourceType === "assigned" ? "selected" : ""}>Назначенный ресурс</option><option value="overhaul" ${draft.resourceType === "overhaul" ? "selected" : ""}>Межремонтный ресурс</option><option value="extension" ${draft.resourceType === "extension" ? "selected" : ""}>Ресурс до продления</option></select></label>
          <div class="field-pair">
            <label><span>Единица</span><select name="unit"><option value="ч" ${draft.unit === "ч" ? "selected" : ""}>Часы</option><option value="пос." ${draft.unit === "пос." ? "selected" : ""}>Посадки</option><option value="зап." ${draft.unit === "зап." ? "selected" : ""}>Запуски</option><option value="сраб." ${draft.unit === "сраб." ? "selected" : ""}>Срабатывания</option><option value="дн." ${draft.unit === "дн." ? "selected" : ""}>Календарные дни</option></select></label>
            <label><span>Полный ресурс</span><input name="limit" type="number" min="0" step="0.01" value="${draft.limit}" required></label>
          </div>
          <label><span>Остаток</span><input name="remaining" type="number" min="0" step="0.01" value="${draft.remaining}" required></label>
        </fieldset>
        <fieldset><legend>Даты</legend>
          <div class="field-pair"><label><span>Дата изготовления</span><input name="produced" type="date" value="${draft.produced || ""}"></label><label><span>Дата установки</span><input name="installed" type="date" value="${draft.installed || ""}"></label></div>
          <label><span>Дата окончания календарного ресурса</span><input name="expiryDate" type="date" value="${draft.expiryDate || ""}"></label>
        </fieldset>
        <fieldset><legend>Уведомления этой работы</legend>
          <label><span>Категория</span><select name="notificationCategory"><option value="workUsage" ${draft.notificationCategory === "workUsage" ? "selected" : ""}>Работы по наработке</option><option value="workDate" ${draft.notificationCategory === "workDate" ? "selected" : ""}>Работы по дате</option><option value="resourceUsage" ${draft.notificationCategory === "resourceUsage" ? "selected" : ""}>Ресурс по наработке</option><option value="resourceDate" ${draft.notificationCategory === "resourceDate" ? "selected" : ""}>Ресурс по дате</option></select></label>
          <div class="field-pair"><label class="checkbox-row"><input name="notifyApp" type="checkbox" ${draft.notifyApp !== false ? "checked" : ""}><span>Уведомление приложения</span></label><label class="checkbox-row"><input name="notifyCalendar" type="checkbox" ${draft.notifyCalendar ? "checked" : ""}><span>Штатный календарь</span></label></div>
          <div class="field-pair"><label><span>Предварительно за</span><input name="advanceValue" type="number" min="0" step="0.01" value="${draft.advanceValue ?? 3}"></label><label class="checkbox-row"><input name="notifyOnDue" type="checkbox" ${draft.notifyOnDue !== false ? "checked" : ""}><span>Повторить в день/момент выполнения</span></label></div>
        </fieldset>
        <button type="submit" class="primary-button wide">${isNew ? "Добавить агрегат с ограниченным ресурсом" : "Сохранить карточку"}</button>
        ${isNew ? "" : `<button type="button" class="secondary-button wide danger-button" data-action="delete-resource">Удалить ресурсную карточку</button>`}
      </form>
      ${resource && resource.unit !== "дн." ? `
        <form id="extension-form" class="shift-form event-form">
          <fieldset><legend>Продлить ресурс</legend>
            <label>Дата продления<input name="date" type="date" value="${todayIso()}" required></label>
            <label>Новый полный ресурс, ${escapeHtml(resource.unit)}<input name="limit" type="number" min="0" step="any" required></label>
            <label>Основание<input name="basis" type="text" required></label>
            <label>Номер документа<input name="documentNumber" type="text" required></label>
            <label>Дата документа<input name="documentDate" type="date" required></label>
            <button type="submit" class="primary-button">Записать продление</button>
          </fieldset>
        </form>` : ""}
      ${resource?.history?.some((entry) => entry.type === "extension") ? `<section class="history-list"><h2>История продлений</h2>
        ${resource.history.filter((entry) => entry.type === "extension").slice().reverse().map((entry) => `
          <details class="resource-row"><summary>${formatDate(entry.date)} · ${formatNumber(entry.previousLimit)} → ${formatNumber(entry.limit)} (+${formatNumber(entry.increase)}) ${escapeHtml(entry.unit)}</summary>
            <p>${escapeHtml(entry.object)} · ${escapeHtml(entry.basis)}</p>
            <p>Документ № ${escapeHtml(entry.documentNumber)} от ${formatDate(entry.documentDate)}</p>
          </details>`).join("")}</section>` : ""}
    `, { title: "Ресурсный агрегат", subtitle: isNew ? "Новая карточка" : draft.object, back: true, settingsScope: "aircraft" });

    document.getElementById("resource-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const objectName = String(data.get("object")).trim();
      const limit = Number(data.get("limit"));
      const remaining = Number(data.get("remaining"));
      const saved = normalizeResource({
        ...(resource || {}),
        id: resource?.id || `resource-${Date.now()}`,
        object: objectName,
        name: String(data.get("name")).trim(),
        serialNumber: String(data.get("serialNumber") || "").trim(),
        drawingNumber: String(data.get("drawingNumber") || "").trim(),
        repairs: Number(data.get("repairs")),
        resourceType: String(data.get("resourceType")),
        unit: String(data.get("unit")),
        limit,
        remaining,
        installed: String(data.get("installed") || ""),
        produced: String(data.get("produced") || ""),
        expiryDate: String(data.get("expiryDate") || ""),
        notificationCategory: String(data.get("notificationCategory")),
        notifyApp: data.get("notifyApp") === "on",
        notifyCalendar: data.get("notifyCalendar") === "on",
        advanceValue: Number(data.get("advanceValue")),
        notifyOnDue: data.get("notifyOnDue") === "on",
        history: Array.isArray(resource?.history) ? resource.history : [],
      });
      if (resource) Object.assign(resource, saved);
      else aircraft.resources.push(saved);
      if (objectName !== "Самолёт" && !aircraft.blocks.some((block) => block.name === objectName)) {
        aircraft.blocks.push(normalizeBlock({ id: `unit-${Date.now()}`, kind: "unit", name: objectName, caption: "Агрегат с ограниченным ресурсом", status: saved.status }));
      }
      saveState();
      state.selectedResourceId = saved.id;
      state.pendingResourceObject = null;
      showToast("Ресурсная карточка сохранена");
      render();
    });
    document.getElementById("extension-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const basis = String(data.get("basis")).trim();
      const documentNumber = String(data.get("documentNumber")).trim();
      if (!basis || !documentNumber) {
        showToast("Укажи основание и номер документа");
        return;
      }
      let updated;
      try {
        updated = calc.extendUsageResource(resource, data.get("limit"));
      } catch (error) {
        showToast(error.message);
        return;
      }
      resource.history ??= [];
      resource.history.push({ ...updated, type: "extension", object: resource.object, unit: resource.unit,
        date: String(data.get("date")), basis, documentNumber, documentDate: String(data.get("documentDate")) });
      resource.limit = updated.limit;
      resource.remaining = updated.remaining;
      resource.status = resourceStatus(updated.remaining, updated.limit);
      saveState();
      render();
      showToast("Продление записано");
    });
    document.querySelector('[data-action="delete-resource"]')?.addEventListener("click", () => {
      if (!window.confirm(`Удалить ресурсную карточку «${draft.name}»?`)) return;
      aircraft.resources = aircraft.resources.filter((item) => item.id !== draft.id);
      saveState();
      state.selectedResourceId = null;
      navigateBack();
    });
  }

  function renderTypeUsageSettings() {
    const aircraftTypes = new Map(state.aircraft.map((aircraft) => [aircraft.type.trim().toLowerCase(), aircraft]));
    app.innerHTML = shell(`
      <form id="type-usage-form" class="shift-form settings-form">
        <label>Тип самолёта<select name="type" required>
          <option value="">Выбрать тип</option>
          ${[...aircraftTypes].map(([key, aircraft]) => `<option value="${escapeHtml(key)}">${escapeHtml(aircraft.type)}</option>`).join("")}
        </select></label>
        <p class="field-help">Настройки типа применяются ко всем его бортам. Общие правила действуют для остальных типов.</p>
        <div id="type-usage-fields"></div>
      </form>`, { title: "Коэффициенты по типу", subtitle: "", back: true, settings: false });
    const form = document.getElementById("type-usage-form");
    const fields = document.getElementById("type-usage-fields");
    function showFields() {
      const aircraft = aircraftTypes.get(form.elements.type.value);
      if (!aircraft) { fields.innerHTML = ""; return; }
      const rule = usageTypeOverride(aircraft);
      const ground = rule?.ground ?? state.sharedGround ?? aircraft.settings;
      fields.innerHTML = `<fieldset><legend>Коэффициенты и земная наработка</legend>
        ${Object.keys(USAGE_TYPES).map((key) => `<label>${escapeHtml(usageRule(key).label)}<input name="${key}" type="number" min="0" step="any" value="${rule?.factors[key] ?? (state.usageRules ? usageRule(key).factor : aircraft.settings.landingCoefficients[key] ?? 1)}" required></label>`).join("")}
        <label>Процент земли<input name="percent" type="number" min="0" max="100" step="any" value="${ground.groundPercent}" required></label>
        <label>Шаг округления, минут<input name="step" type="number" min="1" step="1" value="${ground.groundRoundingMinutes}" required></label>
        <label>Направление<select name="direction">${[["nearest","До ближайшего"],["up","Вверх"],["down","Вниз"]].map(([value, name]) => `<option value="${value}" ${ground.groundRoundingDirection === value ? "selected" : ""}>${name}</option>`).join("")}</select></label>
        <button class="primary-button" type="submit">Сохранить для типа</button>
        ${rule ? `<button class="secondary-button" type="button" id="remove-type-rule">Вернуть общие правила</button>` : ""}
      </fieldset>`;
    }
    function saveRules(next) {
      const previous = state.usageTypeOverrides;
      state.usageTypeOverrides = next;
      if (!saveState()) {
        state.usageTypeOverrides = previous;
        showToast("Не удалось сохранить настройки");
        return;
      }
      showFields();
      showToast("Настройки сохранены");
    }
    form.elements.type.addEventListener("change", showFields);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const type = String(data.get("type"));
      if (!aircraftTypes.has(type)) return;
      const next = (state.usageTypeOverrides ?? []).filter((entry) => entry.type !== type);
      next.push({ type, factors: Object.fromEntries(Object.keys(USAGE_TYPES).map((key) => [key, Number(data.get(key))])),
        ground: { groundPercent: Number(data.get("percent")), groundRoundingMinutes: Number(data.get("step")),
          groundRoundingDirection: String(data.get("direction")) } });
      saveRules(next);
    });
    fields.addEventListener("click", (event) => {
      if (event.target.id !== "remove-type-rule") return;
      const type = form.elements.type.value;
      chooseLayoutAction("Вернуть общие правила для этого типа?", [["reset","Вернуть"],["cancel","Отмена"]], (action) => {
        if (action === "reset") saveRules(state.usageTypeOverrides.filter((entry) => entry.type !== type));
      });
    });
  }

  function renderUsageSettings() {
    const ground = state.sharedGround ?? DEFAULT_AIRCRAFT_SETTINGS;
    const groups = [
      ["Наработка", ["flight", "ground", "maximum"]],
      ["Посадки и зацепы", OPTIONAL_USAGE_TYPES],
    ];
    const usageRows = (keys) => keys.map((key) => {
      const rule = usageRule(key);
      return `<fieldset data-usage-row="${key}" ${rule.enabled === false ? "hidden" : ""}><legend data-usage-title="${key}">${escapeHtml(rule.label)}</legend><div class="field-pair">
        <label>Наименование<input type="text" name="${key}Label" value="${escapeHtml(rule.label)}" required></label>
        <label>Коэффициент<input type="number" name="${key}Factor" value="${rule.factor}" min="0" step="any" required></label>
      </div>
      ${OPTIONAL_USAGE_TYPES.includes(key) ? `<input type="hidden" name="${key}Enabled" value="${rule.enabled !== false}"><button type="button" class="secondary-button" data-usage-toggle="${key}" data-enable="false">Скрыть вид</button>` : ""}
      <p class="field-help" data-usage-example="${key}"></p></fieldset>`;
    }).join("");
    app.innerHTML = shell(`
      <form id="usage-settings-form" class="shift-form settings-form">
        <div class="usage-heading"><h1>Виды наработки</h1>
          <button type="button" class="usage-hidden-button" aria-label="Скрытые виды" title="Скрытые виды" aria-controls="hidden-usage" aria-expanded="false">♲</button>
        </div>
        <section id="hidden-usage" class="usage-hidden-panel" hidden aria-label="Скрытые виды">
          <h2>Скрытые виды</h2><p id="hidden-usage-empty">Скрытых видов нет.</p>
          ${OPTIONAL_USAGE_TYPES.map((key) => `<div data-usage-restore="${key}" ${usageRule(key).enabled !== false ? "hidden" : ""}><button type="button" class="secondary-button" data-usage-toggle="${key}" data-enable="true">Вернуть «${escapeHtml(usageRule(key).label)}»</button></div>`).join("")}
        </section>
        <p class="field-help">Настройки для всех бортов. Коэффициенты меняют зачёт, фактическое количество сохраняется.</p>
        ${groups.map(([label, keys]) => `<section class="usage-group"><h2>${label}</h2>${usageRows(keys)}</section>`).join("")}
        <fieldset><legend>Пересчёт земли для двигателей</legend>
          <label>Процент от округлённой земли<input name="percent" type="number" min="0" max="100" step="any" value="${ground.groundPercent}" required></label>
          <label>Шаг округления, минут<input name="step" type="number" min="1" step="1" value="${ground.groundRoundingMinutes}" required></label>
          <label>Направление<select name="direction">${[["nearest","До ближайшего"],["up","Вверх"],["down","Вниз"]].map(([value, label]) => `<option value="${value}" ${ground.groundRoundingDirection === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
          <p id="ground-example" class="field-help"></p>
        </fieldset>
        <button class="primary-button" type="submit">Сохранить</button>
        <button class="secondary-button" type="button" id="usage-default">Восстановить по умолчанию</button>
      </form>`, { title: "Виды наработки", subtitle: "", back: true, settings: false });
    const form = document.getElementById("usage-settings-form");
    const formSnapshot = () => JSON.stringify([...new FormData(form)]);
    const initialSnapshot = formSnapshot();
    leaveUsageSettings = () => {
      if (formSnapshot() === initialSnapshot) return false;
      if (app.querySelector("dialog[open]")) return true;
      const dialog = document.createElement("dialog");
      dialog.className = "confirm-dialog";
      dialog.innerHTML = `<form method="dialog">
        <h2>Сохранить изменения?</h2>
        <p>Настройки видов наработки ещё не сохранены.</p>
        <button class="primary-button" value="save">Сохранить</button>
        <button class="secondary-button" value="discard">Выйти без сохранения</button>
        <button class="secondary-button" value="cancel" autofocus>Остаться</button>
      </form>`;
      app.append(dialog);
      dialog.addEventListener("close", () => {
        const action = dialog.returnValue;
        dialog.remove();
        if (action === "save") form.requestSubmit();
        if (action === "discard") finishBackNavigation();
      }, { once: true });
      dialog.showModal();
      return true;
    };
    const hiddenPanel = form.querySelector("#hidden-usage");
    const hiddenButton = form.querySelector(".usage-hidden-button");
    function updateHiddenCount() {
      const count = hiddenPanel.querySelectorAll("[data-usage-restore]:not([hidden])").length;
      form.querySelector("#hidden-usage-empty").hidden = count > 0;
      hiddenButton.textContent = count ? `♲ ${count}` : "♲";
    }
    hiddenButton.addEventListener("click", () => {
      hiddenPanel.hidden = !hiddenPanel.hidden;
      hiddenButton.setAttribute("aria-expanded", String(!hiddenPanel.hidden));
    });
    updateHiddenCount();
    form.querySelectorAll("[data-usage-toggle]").forEach((button) => button.addEventListener("click", () => {
      const { usageToggle: key, enable } = button.dataset;
      form.elements.namedItem(`${key}Enabled`).value = enable;
      const row = form.querySelector(`[data-usage-row="${key}"]`);
      if (enable === "false") {
        const rule = usageRule(key);
        const label = form.elements.namedItem(`${key}Label`);
        const factor = form.elements.namedItem(`${key}Factor`);
        if (!label.validity.valid) label.value = rule.label;
        if (!factor.validity.valid) factor.value = rule.factor;
      }
      row.hidden = enable === "false";
      form.querySelector(`[data-usage-restore="${key}"]`).hidden = enable === "true";
      updateHiddenCount();
    }));
    function updateExamples() {
      for (const output of form.querySelectorAll("[data-usage-example]")) {
        const key = output.dataset.usageExample;
        const factor = form.elements.namedItem(`${key}Factor`).valueAsNumber;
        const input = key === "flight" ? 60 : key === "ground" ? 13 : key === "maximum" ? 30 : key === "arresterHooks" ? 2 : 1;
        const unit = key === "flight" || key === "ground" ? " мин" : key === "maximum" ? " с" : "";
        output.textContent = Number.isFinite(factor) && factor >= 0
          ? `Ввод: ${input}${unit} → после коэффициента: ${formatNumber(input * factor)}${unit}`
          : "";
        if (key === "ground" && output.textContent) output.textContent += " (пример только для коэффициента)";
      }
      const { percent, step, direction, groundFactor } = form.elements;
      const output = document.getElementById("ground-example");
      output.textContent = "";
      if (![percent, step, groundFactor].every((field) => field.validity.valid)) return;
      const example = calc.calculateGroundContribution(13, { stepMinutes: step.valueAsNumber, percent: percent.valueAsNumber, direction: direction.value });
      const contribution = example.contributionMinutes * groundFactor.valueAsNumber;
      output.textContent = `Ввод: 13 мин → округление: ${example.roundedMinutes} мин → ${example.percent}%: ${formatNumber(example.contributionMinutes)} мин → в наработку двигателя: ${formatNumber(contribution)} мин (с коэффициентом земли).`;
    }
    form.addEventListener("input", updateExamples);
    form.querySelector("#usage-default").addEventListener("click", () => {
      chooseLayoutAction("Восстановить стандартные виды и коэффициенты?", [["reset","Восстановить"],["cancel","Отмена"]], (action) => {
        if (action !== "reset") return;
        form.elements.percent.value = DEFAULT_AIRCRAFT_SETTINGS.groundPercent;
        form.elements.step.value = DEFAULT_AIRCRAFT_SETTINGS.groundRoundingMinutes;
        form.elements.direction.value = DEFAULT_AIRCRAFT_SETTINGS.groundRoundingDirection;
        for (const [key, title] of Object.entries(USAGE_TYPES)) {
          const label = form.elements.namedItem(`${key}Label`);
          label.value = title;
          form.elements.namedItem(`${key}Factor`).value = DEFAULT_AIRCRAFT_SETTINGS.landingCoefficients[key] ?? 1;
          label.dispatchEvent(new Event("input", { bubbles: true }));
          if (OPTIONAL_USAGE_TYPES.includes(key)) form.querySelector(`[data-usage-toggle="${key}"][data-enable="true"]`).click();
        }
        updateExamples();
      });
    });
    form.addEventListener("input", (event) => {
      const row = event.target.closest("[data-usage-row]");
      if (!row || event.target.name !== `${row.dataset.usageRow}Label`) return;
      const key = row.dataset.usageRow;
      const label = event.target.value.trim() || USAGE_TYPES[key];
      row.querySelector("[data-usage-title]").textContent = label;
      const restore = hiddenPanel.querySelector(`[data-usage-toggle="${key}"]`);
      if (restore) restore.textContent = `Вернуть «${label}»`;
    });
    updateExamples();
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const previousRules = state.usageRules;
      const previousGround = state.sharedGround;
      state.usageRules = Object.fromEntries(Object.keys(USAGE_TYPES).map((key) => [key, {
        label: String(data.get(`${key}Label`)).trim() || USAGE_TYPES[key],
        factor: Number(data.get(`${key}Factor`)),
        enabled: !OPTIONAL_USAGE_TYPES.includes(key) || data.get(`${key}Enabled`) === "true",
      }]));
      state.sharedGround = { groundPercent: Number(data.get("percent")), groundRoundingMinutes: Number(data.get("step")),
        groundRoundingDirection: String(data.get("direction")) };
      if (!saveState()) {
        state.usageRules = previousRules;
        state.sharedGround = previousGround;
        showToast("Не удалось сохранить настройки на устройстве. Изменения остались в форме.");
        return;
      }
      finishBackNavigation();
      showToast("Виды наработки сохранены для всех бортов");
    });
  }

  function renderSettings() {
    const aircraft = selectedAircraft();
    const aircraftNotificationRows = state.aircraft.map((item) => `
      <label class="setting-row">
        <span><strong>${escapeHtml(item.type)} · борт ${escapeHtml(item.boardNumber)}</strong><small>Работы и ресурсы этого самолёта</small></span>
        <input data-aircraft-notification-id="${item.id}" type="checkbox" ${item.notifications ? "checked" : ""} ${!state.globalNotifications ? "disabled" : ""}>
      </label>`).join("");
    app.innerHTML = shell(`
      <section class="page-heading compact"><div><p class="eyebrow">Приложение</p><h1>Настройки</h1></div></section>
      <section class="settings-list">
        <button class="setting-row" data-view="usage-settings"><strong>Виды наработки · общие</strong>${icon("chevron")}</button>
        <button class="setting-row" data-view="type-usage-settings"><strong>Коэффициенты по типу самолёта</strong>${icon("chevron")}</button>
        <label class="setting-row"><span><strong>Все уведомления</strong><small>Главный переключатель имеет высший приоритет</small></span><input id="global-notifications" type="checkbox" ${state.globalNotifications ? "checked" : ""}></label>
        <div class="settings-subheading">Уведомления по самолётам</div>
        ${aircraftNotificationRows}
        <button class="setting-row" data-action="calendar-settings"><span><strong>Добавить ближайшую работу в календарь</strong><small>Откроется штатный календарь Android для подтверждения</small></span>${icon("chevron")}</button>
        <button class="setting-row" data-action="notification-test"><span><strong>Проверить уведомление Android</strong><small>Запросить разрешение и показать тестовое напоминание</small></span>${icon("bell")}</button>
        <div class="setting-row" aria-disabled="true"><span><strong>Защищённый режим хранения</strong><small>В прототипе не активирован</small></span><span class="prototype-badge">Позже</span></div>
        <button class="setting-row" data-action="about"><span><strong>О приложении</strong><small>Авиаресурс · Android-прототип 0.2.7</small></span>${icon("chevron")}</button>
      </section>
      <section class="info-panel">${icon("shield")}<div><strong>Данные этого прототипа</strong><p>Сохраняются только в локальном хранилище браузера. Серверная синхронизация и шифрование пока не реализованы.</p></div></section>
    `, { title: "Общие настройки", subtitle: "Приложение и все самолёты", back: true, settings: false });

    function setAllNotifications(enabled) {
      state.globalNotifications = enabled;
      state.aircraft.forEach((item) => { item.notifications = enabled; });
      saveState();
      render();
      showToast(enabled ? "Уведомления всех самолётов включены" : "Уведомления всех самолётов выключены");
    }
    document.getElementById("global-notifications").addEventListener("change", (event) => {
      if (event.target.checked) {
        setAllNotifications(true);
        return;
      }
      event.target.checked = true;
      const dialog = document.createElement("dialog");
      dialog.className = "confirm-dialog";
      dialog.innerHTML = `<form method="dialog"><h2>Отключить все уведомления?</h2>
        <p>Галочки уведомлений будут сняты у всех самолётов.</p>
        <button class="secondary-button" value="cancel" autofocus>Отмена</button>
        <button class="primary-button" value="disable">Отключить</button></form>`;
      app.append(dialog);
      dialog.addEventListener("close", () => {
        const confirmed = dialog.returnValue === "disable";
        dialog.remove();
        if (confirmed) setAllNotifications(false);
      }, { once: true });
      dialog.showModal();
    });
    document.querySelectorAll("[data-aircraft-notification-id]").forEach((toggle) => {
      toggle.addEventListener("change", (event) => {
        const targetAircraft = state.aircraft.find((item) => item.id === event.target.dataset.aircraftNotificationId);
        if (!targetAircraft) return;
        targetAircraft.notifications = event.target.checked;
        saveState();
        showToast(`${targetAircraft.type}, борт ${targetAircraft.boardNumber}: уведомления ${targetAircraft.notifications ? "включены" : "выключены"}`);
      });
    });
  }

  function bindCommonActions() {
    document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
      navigateTo(button.dataset.view);
    }));
    document.querySelectorAll("[data-aircraft-id]").forEach((button) => button.addEventListener("click", () => {
      state.selectedAircraftId = button.dataset.aircraftId;
      state.aircraftTab = "aggregates";
      navigateTo("aircraft");
    }));
    document.querySelectorAll("[data-aircraft-tab]").forEach((button) => button.addEventListener("click", () => {
      state.aircraftTab = button.dataset.aircraftTab;
      render();
    }));
    const settings = document.querySelector("[data-action='settings']");
    if (settings) settings.addEventListener("click", () => navigateTo(settings.dataset.settingsScope === "aircraft" ? "aircraft-settings" : "settings"));
    const back = document.querySelector("[data-action='back']");
    if (back) back.addEventListener("click", navigateBack);

    const addAircraft = document.querySelector("[data-action='add-aircraft']");
    if (addAircraft) addAircraft.addEventListener("click", () => navigateTo("add-aircraft"));
    const addBlock = document.querySelector("[data-action='add-block']");
    if (addBlock) addBlock.addEventListener("click", () => navigateTo("add-block"));
    const addResource = document.querySelector("[data-action='add-resource']");
    if (addResource) addResource.addEventListener("click", () => {
      state.selectedResourceId = null;
      state.pendingResourceObject = addResource.dataset.resourceObject || null;
      state.pendingWork = addResource.dataset.work === "true";
      navigateTo("resource-editor");
    });
    const editBlocks = document.querySelector("[data-action='edit-blocks']");
    if (editBlocks) editBlocks.addEventListener("click", renameBlock);
    const calendar = document.querySelector("[data-action='calendar-settings']");
    if (calendar) calendar.addEventListener("click", addNearestWorkToCalendar);
    const notificationTest = document.querySelector("[data-action='notification-test']");
    if (notificationTest) notificationTest.addEventListener("click", testAndroidNotification);
    const about = document.querySelector("[data-action='about']");
    if (about) about.addEventListener("click", () => navigateTo("about"));
    document.querySelectorAll("[data-block-id]").forEach((button) => button.addEventListener("click", () => {
      state.selectedBlockId = button.dataset.blockId;
      navigateTo("block");
    }));
    bindResourceButtons();
  }

  function bindResourceButtons() {
    document.querySelectorAll("[data-resource-id]").forEach((button) => button.addEventListener("click", () => {
      state.selectedResourceId = button.dataset.resourceId;
      navigateTo("resource-editor");
    }));
  }

  function renderCreationForm() {
    const aircraftForm = state.view === "add-aircraft";
    const title = aircraftForm ? "Добавить самолёт" : "Добавить агрегат";
    const knownTypes = [...new Set([...state.typeSettings, ...state.aircraft].map((item) => item.type))];
    app.innerHTML = shell(`
      <h1>${title}</h1>
      <form id="creation-form" class="shift-form settings-form">
        ${aircraftForm ? `
          <label>Тип самолёта<input name="type" type="text" list="known-aircraft-types" required></label>
          <datalist id="known-aircraft-types">${knownTypes.map((type) => `<option value="${escapeHtml(type)}"></option>`).join("")}</datalist>
          <label>Бортовой номер<input name="boardNumber" type="text" required></label>
          <label>Заводской номер<input name="serialNumber" type="text"></label>` : `
          <label>Название<input name="name" type="text" required></label>
          <label>Тип карточки<select name="kind"><option value="unit">Агрегат</option><option value="engine">Двигатель</option><option value="airframe">Планер</option></select></label>
          <label>Описание<input name="caption" type="text"></label>`}
        <p id="creation-error" role="alert"></p>
        <button class="primary-button" type="submit">${title}</button>
      </form>`, { title, back: true, settings: false });
    document.getElementById("creation-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const data = Object.fromEntries([...new FormData(event.currentTarget)].map(([key, value]) => [key, value.trim()]));
      if (aircraftForm ? !data.type || !data.boardNumber : !data.name) {
        document.getElementById("creation-error").textContent = "Заполни обязательные поля.";
        return;
      }
      if (aircraftForm) createAircraft(data);
      else createBlock(data);
    });
  }

  function createAircraft({ type, boardNumber, serialNumber }) {
    const template = state.typeSettings.find((entry) => entry.type.toLowerCase() === type.toLowerCase());
    const sameType = state.aircraft.find((item) => item.type.toLowerCase() === type.toLowerCase());
    const id = `aircraft-${Date.now()}`;
    state.aircraft.push({
      id,
      type: type.trim(),
      boardNumber: boardNumber.trim(),
      serialNumber: serialNumber || "Не указан",
      notifications: state.globalNotifications,
      totalFlightMinutes: 0,
      actualLandings: 0,
      equivalentLandings: 0,
      arresterHooks: 0,
      settings: structuredClone(template?.settings ?? sameType?.settings ?? DEFAULT_AIRCRAFT_SETTINGS),
      notificationConfig: structuredClone(DEFAULT_NOTIFICATION_CONFIG),
      shifts: [],
      blocks: [
        { id: "airframe", kind: "airframe", name: "Формуляр самолёта", caption: "Планер и общая наработка" },
        { id: "engine-left", kind: "engine", name: "Левый двигатель", caption: "Формуляр двигателя" },
        { id: "engine-right", kind: "engine", name: "Правый двигатель", caption: "Формуляр двигателя" },
        { id: "vka", kind: "unit", name: "ВКА", caption: "Выносная коробка агрегатов" },
        { id: "gtde", kind: "unit", name: "ГТДЭ / ВСУ", caption: "Вспомогательная энергоустановка" },
      ].map((block) => normalizeBlock({ status: "ok", ...block })),
      resources: [],
    });
    state.selectedAircraftId = id;
    state.aircraftTab = "aggregates";
    state.view = "aircraft";
    saveState();
    render();
    showToast("Самолёт добавлен");
  }

  function createBlock({ name, kind, caption }) {
    const aircraft = selectedAircraft();
    aircraft.blocks.push(normalizeBlock({
      id: `unit-${Date.now()}`,
      kind,
      name: name.trim(),
      caption: caption.trim(),
      status: "ok",
      ...(kind === "engine" ? { sneMinutes: 0, pprMinutes: 0, starts: 0, modesSeconds: { or: 0, combat: 0, combined: 0 } } : {}),
    }));
    saveState();
    navigateBack();
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
    const oldName = block.name;
    block.name = name.trim();
    aircraft.resources.forEach((resource) => { if (resource.object === oldName) resource.object = block.name; });
    saveState();
    render();
    showToast("Название блока сохранено");
  }

  function renameBlockById(blockId) {
    const aircraft = selectedAircraft();
    const block = aircraft.blocks.find((item) => item.id === blockId);
    if (!block) return;
    const name = window.prompt("Новое название", block.name);
    if (!name?.trim()) return;
    const oldName = block.name;
    block.name = name.trim();
    aircraft.resources.forEach((resource) => { if (resource.object === oldName) resource.object = block.name; });
    saveState();
    renderAircraftSettings();
    bindCommonActions();
    showToast("Название блока сохранено");
  }

  function removeBlock(blockId) {
    const aircraft = selectedAircraft();
    const block = aircraft.blocks.find((item) => item.id === blockId);
    if (!block || !window.confirm(`Удалить блок «${block.name}»? История самолёта и смены останутся.`)) return;
    aircraft.blocks = aircraft.blocks.filter((item) => item.id !== blockId);
    saveState();
    renderAircraftSettings();
    bindCommonActions();
    showToast("Блок удалён");
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
    const scheduledDate = nearest.expiryDate
      ? new Date(`${nearest.expiryDate}T09:00:00`)
      : new Date();
    if (!nearest.expiryDate) {
      scheduledDate.setDate(scheduledDate.getDate() + nearest.remaining);
      scheduledDate.setHours(9, 0, 0, 0);
    }
    const start = scheduledDate.getTime();
    if (!Number.isFinite(start)) {
      showToast("Проверь дату окончания ресурса в карточке");
      return;
    }
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
    if (!state.globalNotifications) {
      showToast("Общие уведомления приложения выключены");
      return;
    }
    if (!aircraft?.notifications) {
      showToast("Уведомления выбранного самолёта выключены");
      return;
    }
    const nearest = [...aircraft.resources].sort((a, b) => a.remaining - b.remaining)[0];
    const body = nearest
      ? `${aircraft.type}, борт ${aircraft.boardNumber}: ${nearest.name}, остаток ${formatNumber(nearest.remaining)} ${nearest.unit}`
      : `${aircraft.type}, борт ${aircraft.boardNumber}: уведомления включены`;
    if (window.AndroidBridge?.showNotification) {
      window.AndroidBridge.showNotification("Авиаресурс", body);
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

  function formatOptionalDate(value) {
    return value ? formatDate(value) : "не указана";
  }

  function resourceStatus(remaining, limit) {
    if (!(limit > 0)) return "ok";
    const percent = remaining / limit * 100;
    return percent <= 5 ? "danger" : percent <= 20 ? "warning" : "ok";
  }

  function normalizeResource(resource) {
    const normalized = {
      resourceType: "assigned",
      serialNumber: "",
      drawingNumber: "",
      repairs: 0,
      expiryDate: "",
      history: [],
      notificationCategory: "resourceUsage",
      notifyApp: true,
      notifyCalendar: false,
      advanceValue: 3,
      notifyOnDue: true,
      ...resource,
    };
    if (normalized.unit === "дн." && normalized.expiryDate) {
      const end = Date.parse(normalized.expiryDate);
      if (Number.isFinite(end)) {
        normalized.remaining = Math.max(0, (end - Date.parse(todayIso())) / 86400000);
      }
    }
    normalized.status = resourceStatus(Number(normalized.remaining), Number(normalized.limit));
    return normalized;
  }

  function normalizeBlock(block) {
    return {
      model: "",
      serialNumber: "",
      drawingNumber: "",
      repairs: 0,
      installed: true,
      hasSne: block.kind === "engine",
      hasPpr: block.kind === "engine",
      events: [],
      ...block,
      events: Array.isArray(block.events) ? block.events : [],
    };
  }

  function todayIso() {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(Number(value));
  }

  function formatSeconds(totalSeconds) {
    const value = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const seconds = value % 60;
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js").catch(() => {}));
  }

  window.handleAndroidBack = function () {
    const dialog = document.querySelector("dialog[open]");
    if (dialog) {
      dialog.close();
      return true;
    }
    if (state.view === "home") return false;
    navigateBack();
    return true;
  };

  render();
})();
