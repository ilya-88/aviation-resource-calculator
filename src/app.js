(function () {
  "use strict";

  const calc = window.AviationCalc;
  const app = document.getElementById("app");
  const STORAGE_KEY = "aviation-resource-prototype-v1";
  const DIAGNOSTIC_KEY = "aviation-resource-diagnostics-v1";
  const APP_VERSION = "0.2.35";
  let diagnostics = [];
  try {
    const saved = JSON.parse(localStorage.getItem(DIAGNOSTIC_KEY) || "[]");
    if (Array.isArray(saved)) diagnostics = saved.slice(-100);
  } catch (_) {}

  function recordDiagnostic(event, detail = "") {
    diagnostics.push({ at: new Date().toISOString(), event, detail });
    diagnostics = diagnostics.slice(-100);
    try { localStorage.setItem(DIAGNOSTIC_KEY, JSON.stringify(diagnostics)); } catch (_) {}
  }

  window.addEventListener("error", (event) => {
    const name = event.error?.name || "Error";
    recordDiagnostic("js.error", `${name} app.js:${event.lineno || 0}:${event.colno || 0}`);
  });
  window.addEventListener("unhandledrejection", () => recordDiagnostic("js.unhandled-rejection"));
  recordDiagnostic("app.start", APP_VERSION);
  for (const kind of ["touchstart", "touchend", "touchcancel"]) {
    document.addEventListener(kind, (event) => {
      if (state.view !== "aircraft" && state.view !== "aircraft-layout") return;
      const target = event.target instanceof Element && event.target.closest("[data-counter-index]") ? "tile" : "other";
      recordDiagnostic(`web.${kind}`, `view=${state.view} target=${target} fingers=${event.touches.length}`);
    }, { capture: true, passive: true });
  }
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
  const BOARD_USAGE_TYPES = ["flight", ...OPTIONAL_USAGE_TYPES];
  const CORE_USAGE_TYPES = ["flight", "runway"];
  const TIME_USAGE_TYPES = new Set(["flight", "ground", "maximum"]);
  const defaultUsageSources = () => Object.fromEntries(BOARD_USAGE_TYPES.map((key) => [key, CORE_USAGE_TYPES.includes(key)]));
  const DEFAULT_OPERATION_TYPES = ["Лётная смена", "КОД", "Руление"].map((label, index) => ({ id: String(index), label }));
  const id = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ENGINE_SOURCES = { engineMinutes: "Общая наработка двигателя, ч", starts: "Запуски", maximum: "Максимал, с", afterburner: "Форсаж, с", or: "ОР, с", combat: "Б, с", combined: "Б + УБ, с" };

  function customSources(aircraft) {
    const sources = [...(usageTypeOverride(aircraft)?.customSources || []), ...(aircraft.customUsageSources || [])];
    return [...new Map(sources.map((source) => [source.key, source])).values()].map((source) => ({
      ...source, label: usageRule(source.key, aircraft).label ?? source.label,
    }));
  }

  function usageSources(aircraft, owner) {
    const sources = [
      { key: "flight", label: `${usageRule("flight", aircraft).label}, ч` },
      ...OPTIONAL_USAGE_TYPES.map((key) => ({ key, label: usageRule(key, aircraft).label })),
      ...customSources(aircraft),
    ];
    if (owner?.kind === "engine") sources.push(...Object.entries(ENGINE_SOURCES).map(([key, label]) => ({ key, label })));
    return sources;
  }

  function sourceEnabled(aircraft, key) {
    return aircraft.enabledUsageSources?.[key] ?? (usageRule(key, aircraft).enabled !== false);
  }

  function usageSourceByName(sources, label) {
    const normalize = (value) => value.trim().replace(/\s+/g, " ").toLowerCase().replaceAll("ё", "е");
    const name = normalize(label);
    return sources.find((source) => normalize(source.label) === name) ??
      sources.find(({ key }) => (USAGE_TYPES[key] && normalize(USAGE_TYPES[key]) === name) || (key === "touch" && name === "касание"));
  }

  function sourceKind(source) {
    return source?.kind ?? (TIME_USAGE_TYPES.has(source?.key) ? "time" : "count");
  }

  function sourceDefinitionFields() {
    return `<div class="field-pair source-definition">
      <label>Тип значения<select data-source-kind><option value="count">Количество</option><option value="time">Время</option></select></label>
      <label>Коэффициент<input data-source-factor type="number" min="0" step="any" value="1" required></label>
      <label data-duration-format hidden>Формат ввода<select><option value="hours">Часы и минуты</option><option value="seconds">Минуты и секунды</option></select></label>
    </div>`;
  }

  function bindSourceDefinition(root, name, choice, resolve, getFactor) {
    const kind = root.querySelector("[data-source-kind]");
    const factor = root.querySelector("[data-source-factor]");
    const format = root.querySelector("[data-duration-format]");
    const readSelection = () => ({
      label: name.value.trim(),
      source: resolve(name.value.trim(), choice?.value),
    });
    const toggleFormat = () => { format.hidden = kind.value !== "time" || kind.disabled; };
    const update = () => {
      const { source } = readSelection();
      kind.disabled = Boolean(source);
      if (source) kind.value = sourceKind(source);
      if (!factor.dataset.edited) factor.value = source ? getFactor(source) : 1;
      toggleFormat();
    };
    name.addEventListener("input", update);
    choice?.addEventListener("change", update);
    kind.addEventListener("change", toggleFormat);
    factor.addEventListener("input", () => { factor.dataset.edited = "true"; });
    update();
    return () => {
      const { label, source } = readSelection();
      if (!label && !source) return null;
      if (factor.dataset.edited && !factor.reportValidity()) return false;
      const value = factor.dataset.edited ? factor.valueAsNumber : source ? getFactor(source) : 1;
      return { label, source, factor: value, kind: source ? sourceKind(source) : kind.value, format: format.querySelector("select").value };
    };
  }

  function newUsageSource({ label, kind, format, factor }) {
    return { key: `custom-${id()}`, label, kind, ...(kind === "time" && { format }), factor };
  }

  function calculationSourceLabel(source) {
    return source.kind === "time" ? `${source.label}, ч` : source.label;
  }

  function customWorkInput(source) {
    const { key, label, kind, format } = source;
    if (kind !== "time") return `<label>${escapeHtml(label)}<input name="${key}" type="number" min="0" step="${kind === "count" ? "1" : "any"}"></label>`;
    const [major, minor] = format === "seconds" ? ["Минуты", "Секунды"] : ["Часы", "Минуты"];
    return `<fieldset><legend>${escapeHtml(label)}</legend><div class="field-pair">
      <label>${major}<input name="${key}Major" type="number" min="0" step="1"></label>
      <label>${minor}<input name="${key}Minor" type="number" min="0" max="59" step="1"></label>
    </div></fieldset>`;
  }

  function readCustomWork(aircraft, data) {
    return customSources(aircraft).filter(({ key }) => sourceEnabled(aircraft, key)).flatMap(({ key, label, kind, format }) => {
      if (kind !== "time") {
        const value = data.get(key);
        return value != null && value !== "" ? [{ key, label, value: Number(value) }] : [];
      }
      const major = data.get(`${key}Major`);
      const minor = data.get(`${key}Minor`);
      if (!major && !minor) return [];
      const seconds = (Number(major) * 60 + Number(minor)) * (format === "seconds" ? 1 : 60);
      return [{ key, label, value: seconds / 3600, seconds, format }];
    });
  }

  function sourceCheckboxes(aircraft = {}) {
    return usageSources(aircraft).map(({ key, label }) => `
      <label class="checkbox-row"><input type="checkbox" name="usageSource" value="${key}" ${sourceEnabled(aircraft, key) ? "checked" : ""}><span>${escapeHtml(label)}</span></label>`
    ).join("");
  }

  function enabledSourcesFromForm(aircraft, data) {
    const enabled = new Set(data.getAll("usageSource"));
    return Object.fromEntries(usageSources(aircraft).map(({ key }) => [key, enabled.has(key)]));
  }

  function renderBoardUsage() {
    const aircraft = selectedAircraft();
    app.innerHTML = shell(`<form id="board-usage-form" class="shift-form">
      <fieldset><legend>Поля записи работы</legend>
        ${sourceCheckboxes(aircraft)}
        <details id="board-add-source"><summary>Добавить показатель</summary>
          <label>Название<input name="newSource" type="text" maxlength="80"></label>
          ${sourceDefinitionFields()}
        </details>
      </fieldset>
      <button class="primary-button">Сохранить показатели</button>
    </form>`, { title: "Показатели работы", back: true, settings: false });
    const form = document.getElementById("board-usage-form");
    const readSource = bindSourceDefinition(document.getElementById("board-add-source"), form.elements.newSource, null,
      (label) => usageSourceByName(usageSources(aircraft), label), ({ key }) => usageRule(key, aircraft).factor);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const source = readSource();
      if (source === false) return;
      const data = new FormData(form);
      const previous = [aircraft.enabledUsageSources, aircraft.customUsageSources, aircraft.usageFactors];
      const enabled = enabledSourcesFromForm(aircraft, data);
      if (source?.source) {
        enabled[source.source.key] = true;
        if (source.factor !== usageRule(source.source.key, aircraft).factor) {
          aircraft.usageFactors = { ...aircraft.usageFactors, [source.source.key]: source.factor };
        }
      } else if (source) {
        aircraft.customUsageSources = [...(aircraft.customUsageSources || []), newUsageSource(source)];
      }
      aircraft.enabledUsageSources = usageSourceOverrides(aircraft, enabled);
      if (saveState()) render();
      else { [aircraft.enabledUsageSources, aircraft.customUsageSources, aircraft.usageFactors] = previous; showToast("Не удалось сохранить показатели"); }
    });
  }

  function resourceOwner(aircraft, resource) {
    if (resource.objectId) return aircraft.blocks.find((block) => block.id === resource.objectId);
    return aircraft.blocks.find((block) => block.name === resource.object);
  }

  function resourceInputs(resource, owner) {
    if (resource.unit === "дн.") return {};
    if (resource.consumption) return resource.consumption;
    if (resource.unit === "ч") return { [owner?.kind === "engine" ? "engineMinutes" : "flight"]: 1 };
    if (resource.unit === "зап." && owner?.kind === "engine") return { starts: 1 };
    return {};
  }

  function resourceSourceFactor(aircraft, key, factor) {
    return key.startsWith("custom-") ? factor * usageRule(key, aircraft).factor : factor;
  }

  function blockInstalledOn(block, date) {
    const installations = (block.events || []).filter((entry) => ["install", "dismantle"].includes(entry.type) && entry.date)
      .sort((a, b) => a.date.localeCompare(b.date));
    const latest = installations.filter((entry) => entry.date <= date).at(-1);
    if (latest) return latest.type === "install";
    if (installations.length) return installations[0].type === "dismantle";
    return block.installed !== false;
  }

  function recordInstallation(block, event) {
    block.events.push(event);
    block.installed = blockInstalledOn(block, todayIso());
  }

  function countsTowardPpr(block, date) {
    if (!(block?.repairs > 0)) return false;
    const laterRepair = (block.events || []).some((event) => event.type === "repair" && event.date > date);
    return !laterRepair && !Object.values(block.historicalRepairs || {}).some((event) => event.date > date);
  }

  function resourceAccruals(aircraft, date, sources, engineUsage) {
    return aircraft.resources.flatMap((resource) => {
      const owner = resourceOwner(aircraft, resource);
      if ((!owner && resource.objectId) || (owner && !blockInstalledOn(owner, date)) ||
        (resource.installed && resource.installed > date)) return [];
      const engine = engineUsage.get(owner);
      const values = { ...sources };
      if (engine) Object.assign(values, {
        engineMinutes: engine.minutes / 60, starts: engine.starts, maximum: engine.maximumSeconds,
        afterburner: engine.afterburnerSeconds, ...engine.modes,
      });
      const inputs = Object.entries(resourceInputs(resource, owner)).map(([key, factor]) => [key, resourceSourceFactor(aircraft, key, factor)])
        .filter(([key, factor]) => factor > 0 && values[key] != null)
        .map(([key, factor]) => ({ key, input: values[key], factor, amount: values[key] * factor }));
      const amount = inputs.reduce((sum, item) => sum + item.amount, 0);
      if (!amount) return [];
      return [{ resourceId: resource.id, blockId: owner?.kind === "airframe" ? null : owner?.id, name: resource.name, object: resource.object, unit: resource.unit,
        priority: resource.priority === true,
        labels: Object.fromEntries(usageSources(aircraft, owner).map((source) => [source.key, calculationSourceLabel(source)])),
        inputs, amount, remaining: Math.max(0, resource.remaining - amount) }];
    });
  }

  const BOARD_COUNTERS = ["totalFlightMinutes", "actualLandings", "pprFlightMinutes", "pprLandings", "equivalentLandings", "arresterHooks"];
  const BLOCK_COUNTERS = ["sneMinutes", "sneLandings", "pprMinutes", "pprLandings", "starts", "pprStarts", "maximumSeconds",
    "pprMaximumSeconds", "afterburnerSeconds", "pprAfterburnerSeconds", "modesSeconds", "pprModesSeconds"];

  function usageSnapshot(aircraft) {
    const pick = (item, keys) => Object.fromEntries(keys.map((key) => [key, structuredClone(item[key] ?? null)]));
    return {
      board: pick(aircraft, BOARD_COUNTERS),
      blocks: aircraft.blocks.map((block) => ({ id: block.id, repairs: block.repairs, values: pick(block, BLOCK_COUNTERS) })),
      resources: aircraft.resources.filter((resource) => resource.unit !== "дн.").map((resource) =>
        ({ id: resource.id, limit: resource.limit, remaining: resource.remaining })),
    };
  }

  function restoreUsage(aircraft, snapshot) {
    Object.assign(aircraft, snapshot.board);
    for (const entry of snapshot.blocks) Object.assign(aircraft.blocks.find((block) => block.id === entry.id), entry.values);
    for (const entry of snapshot.resources) {
      const resource = aircraft.resources.find((item) => item.id === entry.id);
      resource.remaining = entry.remaining;
      resource.status = resourceStatus(resource.remaining, resource.limit);
    }
  }

  function canCorrectShift(aircraft, shift) {
    return Boolean(shift?.beforeUsage && shift.afterUsage && shift === aircraft.shifts.at(-1) &&
      JSON.stringify(shift.afterUsage) === JSON.stringify(usageSnapshot(aircraft)));
  }

  function usageRule(key, aircraft = selectedAircraft()) {
    const defaults = state.usageRules?.[key] ?? {
      label: USAGE_TYPES[key],
      factor: aircraft?.settings?.landingCoefficients?.[key] ?? DEFAULT_AIRCRAFT_SETTINGS.landingCoefficients[key] ?? 1,
    };
    const profile = usageTypeOverride(aircraft);
    const custom = key.startsWith("custom-") && (aircraft?.customUsageSources?.find((source) => source.key === key) ??
      profile?.customSources?.find((source) => source.key === key));
    return {
      label: profile?.labels?.[key] ?? custom?.label ?? defaults.label,
      factor: aircraft?.usageFactors?.[key] ?? profile?.factors?.[key] ?? custom?.factor ?? defaults.factor,
      enabled: profile?.enabled?.[key] ?? defaults.enabled,
    };
  }

  function usageTypeOverride(aircraft) {
    const key = aircraft?.type?.trim().toLowerCase();
    return state.usageTypeOverrides?.find((entry) => entry.type === key);
  }

  function usageSourceOverrides(aircraft, enabled) {
    return Object.fromEntries(Object.entries(enabled).filter(([key, value]) => value !== (usageRule(key, aircraft).enabled !== false)));
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
        rfNumber: "33738",
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
        aircraftTypes: state.aircraftTypes,
        archivedAircraftTypes: state.archivedAircraftTypes,
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
    normalized.usageTypeOverrides = Array.isArray(raw?.usageTypeOverrides) ? raw.usageTypeOverrides : [];
    normalized.archivedAircraftTypes = Array.isArray(raw?.archivedAircraftTypes) ? raw.archivedAircraftTypes : [];
    if (!Array.isArray(normalized.aircraft)) normalized.aircraft = [];
    normalized.aircraft = normalized.aircraft.map((aircraft) => ({
      ...aircraft,
      notifications: normalized.globalNotifications ? aircraft.notifications !== false : false,
      actualLandings: Number(aircraft.actualLandings) || 0,
      equivalentLandings: Number(aircraft.equivalentLandings) || 0,
      arresterHooks: Number(aircraft.arresterHooks) || 0,
      shifts: Array.isArray(aircraft.shifts) ? aircraft.shifts : [],
      blocks: Array.isArray(aircraft.blocks) ? aircraft.blocks.map((block) => normalizeBlock({
        ...block,
        repairs: block.kind === "airframe" && (aircraft.pprFlightMinutes != null || aircraft.pprLandings != null)
          ? Math.max(1, Number(block.repairs) || 0) : block.repairs,
      })) : [],
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
    const types = new Map();
    for (const value of [
      ...(Array.isArray(raw?.aircraftTypes) ? raw.aircraftTypes : []),
      ...normalized.aircraft.map((item) => item.type),
      ...normalized.typeSettings.map((item) => item.type),
    ]) {
      if (typeof value !== "string" || !value.trim()) continue;
      const name = value.trim();
      const key = name.toLowerCase();
      if (!types.has(key)) types.set(key, name);
    }
    normalized.aircraftTypes = [...types.values()];
    for (const key of types.keys()) {
      const profile = normalized.usageTypeOverrides.find((entry) => entry.type === key);
      if (profile?.enabled) continue;
      const enabled = defaultUsageSources();
      for (const aircraft of normalized.aircraft.filter((item) => item.type.trim().toLowerCase() === key)) {
        const overrides = { ...aircraft.enabledUsageSources };
        for (const source of BOARD_USAGE_TYPES) {
          if (Object.hasOwn(overrides, source)) continue;
          const wasEnabled = normalized.usageRules?.[source]?.enabled !== false;
          if (wasEnabled !== enabled[source]) overrides[source] = wasEnabled;
        }
        aircraft.enabledUsageSources = overrides;
      }
      const migrated = { ...profile, type: key, enabled };
      normalized.usageTypeOverrides = normalized.usageTypeOverrides.filter((entry) => entry.type !== key).concat(migrated);
    }
    return normalized;
  }

  function selectedAircraft() {
    return state.aircraft.find((item) => item.id === state.selectedAircraftId) || state.aircraft[0];
  }

  function navigateTo(view) {
    if (state.view !== view) {
      viewStack.push(state.view);
      if (view === "usage-settings") state.lastUsageType = null;
    }
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
    else if (state.view === "board-details") renderBoardDetails();
    else if (state.view === "board-image") renderBoardImage();
    else if (state.view === "block") renderBlock();
    else if (state.view === "correct-usage") renderUsageCorrection();
    else if (state.view === "usage-map") renderUsageMap();
    else if (state.view === "board-usage") renderBoardUsage();
    else if (state.view === "shift-entry") renderShiftEntry();
    else if (state.view === "resource-editor") renderResourceEditor();
    else if (state.view === "resources") renderResources();
    else if (state.view === "shift") renderShift();
    else if (state.view === "correct-shift") renderShift(true);
    else if (state.view === "reports") renderReports();
    else if (state.view === "settings") renderSettings();
    else if (state.view === "diagnostics") renderDiagnostics();
    else if (state.view === "usage-settings") renderUsageSettings();
    else if (state.view === "aircraft-types") renderAircraftTypes();
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
            ${options?.boardIds ? `<span class="board-identifiers"><span>Зав. № ${escapeHtml(options.boardIds.serialNumber || "—")}</span><span>RF ${escapeHtml(options.boardIds.rfNumber || "—")}</span></span>`
              : subtitle ? `<span>${escapeHtml(subtitle)}</span>` : ""}
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
        <article class="aircraft-list-entry"><button class="aircraft-card" data-aircraft-id="${escapeHtml(aircraft.id)}">
          <span class="aircraft-card__visual">${aircraft.cardImage?.data ? `<img alt="" class="board-image ${aircraft.cardImage.fit === "contain" ? "board-image-contain" : ""}" src="${escapeHtml(aircraft.cardImage.data)}">` : icon("plane")}</span>
          <span class="aircraft-card__body">
            <span class="aircraft-card__title">${escapeHtml(aircraft.type)} · борт ${escapeHtml(aircraft.boardNumber)}</span>
            <span class="aircraft-card__meta">Зав. № ${escapeHtml(aircraft.serialNumber)}</span>
            <span class="aircraft-card__metrics">
              <span><b>${calc.formatDuration(aircraft.totalFlightMinutes)}</b> ${escapeHtml(usageRule("flight", aircraft).label)}</span>
              <span><b>${aircraft.actualLandings}</b> посадок</span>
            </span>
          </span>
          <span class="aircraft-card__status status-${urgent ? "warning" : "ok"}">${urgent ? `${urgent} требуют внимания` : "Ресурс в норме"}</span>
        </button>
        <details class="aircraft-card-menu">
          <summary aria-label="Меню борта ${escapeHtml(aircraft.boardNumber)}">⋮</summary>
          <div class="aircraft-card-menu-panel">
            <button type="button" class="secondary-button" data-board-menu="board-details" data-board-id="${escapeHtml(aircraft.id)}">Реквизиты борта</button>
            <button type="button" class="secondary-button" data-board-menu="board-image" data-board-id="${escapeHtml(aircraft.id)}">Обновить картинку</button>
          </div>
        </details></article>`;
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

  function renderAircraft(layoutEditing = false) {
    const aircraft = selectedAircraft();
    const activeTab = state.aircraftTab || "aggregates";
    const renderBlockTile = (block) => `
      <button class="equipment-block" data-block-id="${block.id}">
        <span class="equipment-block__icon">${block.kind === "engine" ? "◉" : block.kind === "airframe" ? "△" : "⬡"}</span>
        <span class="equipment-block__body"><strong>${escapeHtml(block.name)}</strong><small>${escapeHtml(block.caption)}</small></span>
        <span class="status-dot status-${block.status}" aria-label="${statusLabel(block.status)}"></span>
        <span>${icon("chevron")}</span>
      </button>`;
    const aircraftForms = aircraft.blocks.filter((block) => block.kind === "airframe");
    const blocks = aircraft.blocks.filter((block) => block.kind !== "airframe").map(renderBlockTile).join("");

    const recentShifts = aircraft.shifts.slice(-3).reverse().map((shift) => `
      <button class="history-row" data-shift-id="${escapeHtml(shift.id)}">
        <div><strong>${formatDate(shift.date)} · ${escapeHtml(shift.operationLabel || "Лётная смена")}</strong><span>${calc.formatDuration(shift.flightMinutes)} полёта · ${shift.actualLandings} посадок</span></div>
        ${icon("chevron")}
      </button>`).join("");

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
      <div class="section-heading"><div><h2>Агрегаты</h2><p>Формуляры, двигатели и агрегаты самолёта.</p></div></div>
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
        ${aircraftForms.map(renderBlockTile).join("")}
        <button class="secondary-button" data-view="resources">${icon("resource")} Остатки ресурсов</button>
        <button class="primary-button" data-view="shift">${icon("log")} Внести работу</button>
      </div>
      <section class="aircraft-tab-panel">${tabContent}</section>
      <button class="add-block-button" data-view="usage-map">Карта наработки</button>
    `, { title: `${aircraft.type} · Борт ${aircraft.boardNumber}`, subtitle: "", boardIds: aircraft,
      singleLine: true, back: true, settings: !layoutEditing, settingsScope: "aircraft" });
    const panel = app.querySelector(".aircraft-tab-panel");
    const preview = document.createElement("div");
    preview.id = "counter-preview";
    panel.prepend(preview);
    const catalog = new Map();
    const navigation = app.querySelector(".aircraft-tabs");
    [...navigation.children].forEach((item, index) => catalog.set(boardNavigationKeys[index], item.outerHTML));
    navigation.remove();
    const items = app.querySelectorAll(".aircraft-actions > button, .aircraft-tab-panel .equipment-block, .aircraft-tab-panel .resource-row, .aircraft-tab-panel .history-row, .aircraft-tab-panel button.add-block-button");
    for (const [index, item] of [...items].entries()) {
      const resource = item.querySelector("[data-resource-id]");
      const key = "widget:" + (item.dataset.view || item.dataset.blockId || resource?.dataset.resourceId ||
        (item.dataset.shiftId ? `shift:${item.dataset.shiftId}` : "") ||
        (item.dataset.action ? item.dataset.action + ":" + activeTab : activeTab + ":" + index));
      catalog.set(key, item.outerHTML);
      item.remove();
    }
    const preferred = aircraft.boardLayouts?.[activeTab] ?? [
      ...(aircraft.counterLayout ?? defaultCounterLayout),
      ...[...catalog.keys()].filter((key) => !boardNavigationKeys.includes(key)).map((key) => ({ keys: [key], wide: false })),
    ];
    const layout = preferred.map((tile) => ({ ...tile, keys: tile.keys.filter((key) =>
      !boardNavigationKeys.includes(key) && (!key.startsWith("widget:") || catalog.has(key))) })).filter((tile) => tile.keys.length);
    for (const key of catalog.keys()) {
      if (!boardNavigationKeys.includes(key) && !layout.some((tile) => tile.keys.includes(key))) layout.push({ keys: [key], wide: false });
    }
    const legacy = aircraft.boardTabsLayout;
    const navigationLayout = aircraft.boardNavigationLayout ?? [{
      index: legacy?.index ?? 0,
      tile: { ...legacy?.tile, keys: [...boardNavigationKeys], wide: legacy?.tile?.wide ?? true },
    }];
    for (const entry of navigationLayout) layout.splice(entry.index, 0, entry.tile);
    if (!layoutEditing) {
      preview.innerHTML = counterTiles(aircraft, layout, false, catalog);
      const tiles = preview.querySelector(".counter-tiles");
      let holdTimer;
      let start;
      function stopHold() {
        clearTimeout(holdTimer);
        start?.tile.classList.remove("counter-tile-active");
        start = null;
      }
      function openHeldTile(tile) {
        if (!tile.isConnected || state.view !== "aircraft") return;
        recordDiagnostic("layout.open.request");
        activeCounterIndex = Number(tile.dataset.counterIndex);
        viewStack.push(state.view);
        state.view = "aircraft-layout";
        try {
          renderAircraftLayout({ layout, catalog, activeTab });
          recordDiagnostic("layout.open.ok", `toolbar=${Boolean(app.querySelector(".counter-gesture-toolbar"))}`);
          const toolbar = app.querySelector(".counter-gesture-toolbar");
          if (toolbar) {
            const rect = toolbar.getBoundingClientRect();
            const visible = rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
            recordDiagnostic("layout.toolbar", `visible=${visible} size=${Math.round(rect.width)}x${Math.round(rect.height)} viewport=${innerWidth}x${innerHeight}`);
            requestAnimationFrame(() => {
              if (!toolbar.isConnected) return;
              try { navigator.vibrate?.(18); } catch (_) {}
            });
          }
        } catch (error) {
          recordDiagnostic("layout.open.error", error.name);
          console.error("Не удалось открыть редактор раскладки", error);
          finishBackNavigation();
          showToast("Не удалось открыть редактор раскладки");
        }
      }
      function cancelHold(reason) {
        if (start) recordDiagnostic("layout.hold.cancelled", `${reason} ${Math.round(performance.now() - start.at)}ms`);
        stopHold();
      }
      function startHold(target, x, y, input) {
        stopHold();
        const tile = target.closest("[data-counter-index]");
        if (!tile) return;
        start = { x, y, tile, ready: false, at: performance.now() };
        recordDiagnostic("layout.hold.start", input);
        holdTimer = setTimeout(() => {
          if (!tile.isConnected || state.view !== "aircraft") return;
          start.ready = true;
          tile.classList.add("counter-tile-active");
          recordDiagnostic("layout.hold.ready");
        }, 650);
      }
      function finishHold(event) {
        const held = start;
        stopHold();
        if (!held) return;
        if (!held.ready) {
          recordDiagnostic("layout.hold.released-early", `${Math.round(performance.now() - held.at)}ms`);
          return;
        }
        recordDiagnostic("layout.hold.released");
        if (event.cancelable) event.preventDefault();
        openHeldTile(held.tile);
      }
      function trackHold(x, y) {
        if (start && Math.hypot(x - start.x, y - start.y) > 8) cancelHold("movement");
      }
      tiles.addEventListener("pointerdown", (event) => {
        if (event.pointerType !== "touch" && event.isPrimary && event.button === 0) {
          startHold(event.target, event.clientX, event.clientY, "pointer");
        }
      });
      tiles.addEventListener("pointermove", (event) => {
        if (event.pointerType !== "touch") trackHold(event.clientX, event.clientY);
      });
      tiles.addEventListener("pointerup", (event) => { if (event.pointerType !== "touch") finishHold(event); });
      for (const name of ["pointercancel", "pointerleave"]) {
        tiles.addEventListener(name, (event) => { if (event.pointerType !== "touch") cancelHold(name); });
      }
      tiles.addEventListener("touchstart", (event) => {
        if (event.touches.length !== 1) { cancelHold("multiple-touches"); return; }
        const touch = event.touches[0];
        startHold(event.target, touch.clientX, touch.clientY, "touch");
      }, { passive: true });
      tiles.addEventListener("touchmove", (event) => {
        if (event.touches.length !== 1) { cancelHold("multiple-touches"); return; }
        const touch = event.touches[0];
        trackHold(touch.clientX, touch.clientY);
      }, { passive: true });
      tiles.addEventListener("touchend", finishHold, { passive: false });
      tiles.addEventListener("touchcancel", () => cancelHold("touchcancel"));
      for (const name of ["contextmenu", "selectstart"]) tiles.addEventListener(name, (event) => event.preventDefault());
    }
    return { layout, catalog, activeTab };
  }

  const boardNavigationKeys = ["widget:board-tabs", "widget:board-aggregates", "widget:board-resources"];
  const isNavigationTile = (tile) => tile.keys.every((key) => boardNavigationKeys.includes(key));
  const defaultCounterLayout = [
    { keys: ["flightSne", "flightPpr"], wide: true },
    { keys: ["landingSne", "landingPpr"], wide: true },
  ];
  let leaveAircraftLayout;
  let activeCounterIndex = null;
  let counterGesture = "";

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

  function tileSpan(tile) {
    return Math.max(20, Math.min(120, Math.round((tile.span ?? (tile.wide ? 12 : 6)) * 10)));
  }

  function tileDensity(span) {
    return span >= 60 ? 1 + (span - 60) / 1000 : 0.75 + (span - 20) / 160;
  }

  function counterTiles(aircraft, layout, editing = false, catalog = new Map()) {
    const name = escapeHtml(usageRule("flight").label);
    const values = {
      flightSne: [name + " СНЭ", calc.formatDuration(aircraft.totalFlightMinutes)],
      flightPpr: [name + " ППР", aircraft.pprFlightMinutes == null ? "Не задано" : calc.formatDuration(aircraft.pprFlightMinutes)],
      landingSne: ["Посадки СНЭ", aircraft.actualLandings],
      landingPpr: ["Посадки ППР", aircraft.pprLandings ?? "Не задано"],
    };
    return `<section class="counter-tiles" aria-label="Наработка борта">${layout.map((tile, index) => `
      <article class="counter-tile ${editing && activeCounterIndex === index ? "counter-tile-active" : ""}" data-counter-index="${index}" data-tile-key="${escapeHtml(tile.keys[0])}" style="--tile-start:${tile.columnStart == null ? "auto" : Math.max(1, Math.min(tile.columnStart, 121 - tileSpan(tile)))};--tile-span:${tileSpan(tile)};--tile-height:${tile.height ?? 0}px;--tile-font:${tile.font ?? 1}rem;--tile-density:${tileDensity(tileSpan(tile))}">
        ${editing && activeCounterIndex === index ? `<div class="counter-gesture-toolbar">
          <button type="button" class="counter-toolbar-handle" aria-label="Передвинуть панель">⠿</button>
          <button type="button" data-gesture="move" aria-label="Переместить" aria-pressed="${counterGesture === "move"}">✥</button>
          <button type="button" data-gesture="resize" aria-label="Изменить размер" aria-pressed="${counterGesture === "resize"}">↔</button>
          <button type="button" data-gesture="font" aria-label="Размер текста" aria-pressed="${counterGesture === "font"}">Aa</button>
          <button type="button" data-layout-action="edit" data-index="${index}" aria-label="Изменить подпись">✎</button>
        </div><svg class="counter-edit-outline" aria-hidden="true"><rect pathLength="100" rx="22"/></svg>` : ""}
        <div class="${isNavigationTile(tile) && tile.keys.length > 1 ? "board-navigation-group" : "counter-group"}">
        ${tile.keys.map((key) => `<div class="counter-value">${catalog.has(key)
          ? labelledWidget(catalog.get(key), tile.labels?.[key])
          : `<span data-tile-caption>${tile.labels?.[key] ? escapeHtml(tile.labels[key]) : values[key][0]}</span> <strong>${values[key][1]}</strong>`}</div>`).join("")}</div>
        ${editing ? `<div class="counter-controls" hidden>
          ${[["up","↑","Вверх"],["down","↓","Вниз"],["left","←","Влево"],["right","→","Вправо"],["size",(tile.span ?? (tile.wide ? 12 : 6)) > 6 ? "Сузить" : "Расширить","Изменить ширину"],
            ...(index + 1 < layout.length && values[tile.keys[0]] && values[layout[index + 1].keys[0]] ? [["merge","Объединить","Объединить со следующей карточкой"]] : []),
            ...(tile.keys.length > 1 ? [["split","Разделить","Разделить показатели"]] : []),
          ].map(([action, label, title]) => `<button class="secondary-button" type="button" data-layout-action="${action}" data-index="${index}" aria-label="${title}">${label}</button>`).join("")}
        </div>` : ""}
      </article>`).join("")}</section>`;
  }

  function labelledWidget(markup, label) {
    if (!label) return markup;
    const template = document.createElement("template");
    template.innerHTML = markup;
    const widget = template.content.firstElementChild;
    const caption = widget.querySelector(".equipment-block__body strong, .resource-row__top strong, .history-row strong");
    if (caption) {
      caption.textContent = label;
    } else if (widget.matches("button")) {
      widget.textContent = label;
    } else {
      const heading = document.createElement("strong");
      heading.textContent = label;
      template.content.prepend(heading);
    }
    return template.innerHTML;
  }

  function renderAircraftLayout(existingBoard) {
    const aircraft = selectedAircraft();
    const scrollY = window.scrollY;
    activeCounterIndex ??= 0;
    counterGesture = "";
    const { layout, catalog, activeTab } = existingBoard ?? renderAircraft(true);
    let draft = structuredClone(layout);
    const initial = JSON.stringify(draft);
    const preview = document.getElementById("counter-preview");
    const surface = preview.closest("main");
    const controls = document.createElement("div");
    controls.className = "counter-save-bar";
    controls.innerHTML = `<button class="secondary-button" id="layout-default">Сброс размера</button>
      <button class="secondary-button" id="layout-group">Группа</button>
      <button class="secondary-button counter-font-reset" id="counter-font-reset" aria-label="Стандартный текст 100%" hidden>● <span id="counter-font-percent">100%</span></button>
      <button class="primary-button" id="layout-save">Готово</button>`;
    surface.after(controls);
    surface.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    const boardSettings = app.querySelector('[data-action="settings"]');
    if (boardSettings) boardSettings.disabled = true;
    const fontReset = controls.querySelector("#counter-font-reset");
    const fontPercent = controls.querySelector("#counter-font-percent");
    let toolbarOffset = { x: 0, y: 0 };
    let toolbarDrag;
    function placeToolbar() {
      const toolbar = preview.querySelector(".counter-gesture-toolbar");
      if (!toolbar) return;
      const card = toolbar.closest(".counter-tile").getBoundingClientRect();
      const width = toolbar.offsetWidth;
      const height = toolbar.offsetHeight;
      const left = Math.max(8, Math.min(innerWidth - width - 8, card.right - width + toolbarOffset.x));
      const topbarBottom = app.querySelector(".topbar").getBoundingClientRect().bottom;
      const top = Math.max(topbarBottom + 8, Math.min(innerHeight - height - 8, card.top - height + toolbarOffset.y));
      toolbar.style.left = `${left - card.left}px`;
      toolbar.style.top = `${top - card.top}px`;
    }
    function updateFontControl() {
      fontReset.hidden = counterGesture !== "font";
      controls.classList.toggle("counter-font-mode", counterGesture === "font");
      fontPercent.textContent = Math.round((draft[activeCounterIndex]?.font ?? 1) * 100) + "%";
      controls.querySelector("#layout-group").hidden = counterGesture === "font";
      controls.querySelector("#layout-group").textContent = draft[activeCounterIndex]?.keys.length > 1 ? "Разделить" : "Группа";
    }
    const paint = () => { preview.innerHTML = counterTiles(aircraft, draft, true, catalog);
      preview.querySelectorAll(".counter-value button").forEach((button) => { button.disabled = true; });
      placeToolbar();
      updateFontControl();
    };
    fontReset.onclick = () => {
      delete draft[activeCounterIndex].font;
      paint();
    };
    preview.addEventListener("pointerdown", (event) => {
      const handle = event.target.closest(".counter-toolbar-handle");
      if (!handle || !event.isPrimary || event.button !== 0) return;
      handle.setPointerCapture(event.pointerId);
      const toolbar = handle.closest(".counter-gesture-toolbar");
      const card = toolbar.closest(".counter-tile").getBoundingClientRect();
      const rect = toolbar.getBoundingClientRect();
      toolbarDrag = { pointer: event.pointerId, x: event.clientX, y: event.clientY,
        offsetX: rect.right - card.right, offsetY: rect.bottom - card.top };
    });
    preview.addEventListener("pointermove", (event) => {
      if (toolbarDrag?.pointer !== event.pointerId) return;
      toolbarOffset = { x: toolbarDrag.offsetX + event.clientX - toolbarDrag.x,
        y: toolbarDrag.offsetY + event.clientY - toolbarDrag.y };
      placeToolbar();
    });
    for (const kind of ["pointerup", "pointercancel", "lostpointercapture"]) {
      preview.addEventListener(kind, (event) => {
        if (toolbarDrag?.pointer !== event.pointerId) return;
        const toolbar = preview.querySelector(".counter-gesture-toolbar");
        if (toolbar) {
          const card = toolbar.closest(".counter-tile").getBoundingClientRect();
          const rect = toolbar.getBoundingClientRect();
          toolbarOffset = { x: rect.right - card.right, y: rect.bottom - card.top };
        }
        toolbarDrag = null;
      });
    }
    let drag;
    let hold;
    let resize;
    function clearDrag() {
      drag?.ghost?.remove();
      preview.querySelectorAll(".counter-tile").forEach((card, index) => {
        card.style.order = "";
        card.getAnimations?.().forEach((animation) => animation.cancel());
        if (index === drag?.source) {
          const tile = draft[index];
          card.style.setProperty("--tile-start", tile.columnStart ?? "auto");
        }
      });
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
      if (target < 0 || target === drag.source) return;
      if (drag.lastMove && Math.hypot(x - drag.lastMove.x, y - drag.lastMove.y) < 14) return;
      const order = drag.order ?? cards.map((_, index) => index);
      const from = order.indexOf(drag.source);
      const to = order.indexOf(target);
      if (from === to) return;
      order.splice(from, 1);
      order.splice(to, 0, drag.source);
      drag.order = order;
      drag.lastMove = { x, y };
      const before = cards.map((card) => card.getBoundingClientRect());
      cards[drag.source].style.setProperty("--tile-start", "auto");
      order.forEach((index, position) => { cards[index].style.order = String(position); });
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
        cards.forEach((card, index) => {
          if (index === drag.source) return;
          card.getAnimations?.().forEach((animation) => animation.cancel());
          const after = card.getBoundingClientRect();
          const dx = before[index].left - after.left;
          const dy = before[index].top - after.top;
          if (dx || dy) card.animate?.([{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }], { duration: 150, easing: "ease-out" });
        });
      }
    }
    preview.addEventListener("pointerup", (event) => {
      if (drag?.pointer !== event.pointerId) return;
      dropCard();
    });
    function dropCard() {
      const { source, order } = drag;
      clearDrag();
      if (!order) return;
      delete draft[source].columnStart;
      draft = order.map((index) => draft[index]);
      activeCounterIndex = order.indexOf(source);
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
    surface.addEventListener("touchstart", (event) => {
      if (hold && drag?.touch === hold.id) clearDrag();
      cancelHold();
      const card = event.target.closest(".counter-tile");
      if ((counterGesture === "resize" || counterGesture === "font") && event.touches.length === 1 && !event.target.closest("button:not(:disabled)")) {
        event.preventDefault();
        clearDrag();
        const finger = event.touches[0];
        const index = activeCounterIndex;
        const card = preview.querySelector(`[data-counter-index="${index}"]`);
        const tile = draft[index];
        const grid = card.parentElement;
        const gridLeft = grid.getBoundingClientRect().left;
        const cardLeft = card.getBoundingClientRect().left - parseFloat(getComputedStyle(card).marginLeft);
        const span = tileSpan(tile);
        const column = grid.clientWidth / 120;
        const columnStart = Math.max(1, Math.min(121 - span, Math.round((cardLeft - gridLeft) / column) + 1));
        const style = getComputedStyle(card);
        const content = card.querySelector(".counter-group, .board-navigation-group");
        const verticalInsets = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"]
          .reduce((sum, property) => sum + parseFloat(style[property]), 0);
        resize = { card, index, finger: finger.identifier, x: finger.clientX, y: finger.clientY,
          width: span, height: card.offsetHeight, minHeight: Math.ceil(content.getBoundingClientRect().height + verticalInsets),
          original: structuredClone(tile), column, columnStart, axis: counterGesture === "font" ? "font" : null,
          font: tile.font ?? 1, lastFeedback: -Infinity };
        resize.feedbackWidth = resize.width;
        resize.feedbackHeight = resize.height;
        return;
      }
      if (counterGesture !== "move" || drag || !card || Number(card.dataset.counterIndex) !== activeCounterIndex || event.target.closest("button") || event.touches.length !== 1) return;
      const touch = event.touches[0];
      hold = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
      drag = { touch: hold.id, source: activeCounterIndex, target: null };
      const rect = card.getBoundingClientRect();
      const ghost = card.cloneNode(true);
      ghost.className = "counter-tile counter-move-ghost";
      ghost.querySelector(".counter-gesture-toolbar")?.remove();
      ghost.setAttribute("aria-hidden", "true");
      ghost.style.width = `${rect.width}px`;
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      surface.append(ghost);
      drag.ghost = ghost;
      card.classList.add("counter-dragging");
    }, { passive: false });
    surface.addEventListener("touchmove", (event) => {
      if (resize) {
        const finger = [...event.touches].find((item) => item.identifier === resize.finger);
        if (!finger) return;
        if (event.cancelable) event.preventDefault();
        const { card, index } = resize;
        const dx = finger.clientX - resize.x;
        const dy = finger.clientY - resize.y;
        if (!resize.axis && Math.hypot(dx, dy) < 4) return;
        resize.axis ??= Math.abs(dx) >= Math.abs(dy) ? "width" : "height";
        const tile = draft[index];
        if (resize.axis === "font") {
          tile.font = Math.min(1.7, Math.max(0.65, Math.round(resize.font * 100 - dy / 3) / 100));
          card.style.setProperty("--tile-font", `${tile.font}rem`);
          updateFontControl();
          placeToolbar();
          return;
        }
        if (resize.axis === "width") {
          const span = Math.max(20, Math.min(120, resize.width + Math.round(dx / resize.column)));
          if (span === resize.width) {
            if (resize.original.span == null) delete tile.span;
            else tile.span = resize.original.span;
            if (resize.original.columnStart == null) delete tile.columnStart;
            else tile.columnStart = resize.original.columnStart;
          } else {
            tile.span = span / 10;
            tile.columnStart = Math.min(resize.columnStart, 121 - span);
          }
          card.style.setProperty("--tile-start", tile.columnStart ?? "auto");
          card.style.setProperty("--tile-span", span);
          card.style.setProperty("--tile-density", tileDensity(span));
        } else {
          const height = Math.min(resize.minHeight + innerHeight, Math.max(resize.minHeight, Math.round(resize.height + dy)));
          if (height === resize.minHeight) delete tile.height;
          else tile.height = height;
          card.style.setProperty("--tile-height", `${tile.height ?? 0}px`);
        }
        placeToolbar();
        const now = performance.now();
        if (now - resize.lastFeedback >= 120 &&
            (resize.axis === "width" ? tileSpan(tile) !== resize.feedbackWidth : Math.abs((tile.height ?? resize.minHeight) - resize.feedbackHeight) >= 8)) {
          resize.lastFeedback = now;
          resize.feedbackWidth = tileSpan(tile);
          resize.feedbackHeight = tile.height ?? resize.minHeight;
          try { navigator.vibrate?.(9); } catch (_) {}
        }
        return;
      }
      if (!hold) return;
      const touch = [...event.touches].find((item) => item.identifier === hold.id);
      if (!touch) return;
      if (drag?.touch === hold.id) {
        if (event.cancelable) event.preventDefault();
        if (drag.ghost) drag.ghost.style.transform = `translate(${touch.clientX - hold.x}px, ${touch.clientY - hold.y}px)`;
        markDropTarget(touch.clientX, touch.clientY);
      } else if (Math.hypot(touch.clientX - hold.x, touch.clientY - hold.y) > 8) {
        cancelHold();
      }
    }, { passive: false });
    surface.addEventListener("touchend", (event) => {
      if (resize && [...event.changedTouches].some((item) => item.identifier === resize.finger)) {
        resize = null;
        paint();
        return;
      }
      if (!hold || ![...event.changedTouches].some((item) => item.identifier === hold.id)) return;
      if (drag?.touch === hold.id) {
        if (event.cancelable) event.preventDefault();
        dropCard();
      }
      cancelHold();
    });
    surface.addEventListener("touchcancel", () => {
      if (resize) { draft[resize.index] = resize.original; resize = null; paint(); }
      if (hold && drag?.touch === hold.id) clearDrag();
      cancelHold();
    });
    preview.addEventListener("contextmenu", (event) => {
      if (event.target.closest(".counter-tile")) event.preventDefault();
    });
    function save() {
      const previous = aircraft.boardLayouts;
      const previousTabs = aircraft.boardNavigationLayout;
      aircraft.boardNavigationLayout = draft.flatMap((tile, index) => isNavigationTile(tile) ? [{ index, tile: structuredClone(tile) }] : []);
      aircraft.boardLayouts = { ...previous, [activeTab]: structuredClone(draft.filter((tile) => !isNavigationTile(tile))) };
      if (saveState()) {
        recordDiagnostic("layout.save.ok");
        const currentScroll = window.scrollY;
        finishBackNavigation();
        window.scrollTo(0, currentScroll);
      }
      else {
        recordDiagnostic("layout.save.error");
        aircraft.boardLayouts = previous;
        aircraft.boardNavigationLayout = previousTabs;
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
      const gesture = event.target.closest("[data-gesture]");
      if (gesture) {
        counterGesture = gesture.dataset.gesture;
        recordDiagnostic("layout.tool", counterGesture);
        surface.classList.toggle("counter-resize-surface", counterGesture === "resize" || counterGesture === "font");
        preview.classList.toggle("counter-move-surface", counterGesture === "move");
        paint();
        return;
      }
      const selected = event.target.closest("[data-counter-index]");
      if (selected && !event.target.closest("button")) {
        activeCounterIndex = Number(selected.dataset.counterIndex);
        paint();
        return;
      }
      const button = event.target.closest("[data-layout-action]");
      if (!button) return;
      const index = Number(button.dataset.index);
      const action = button.dataset.layoutAction;
      const tile = draft[index];
      activeCounterIndex = index;
      if (action === "edit") {
        const dialog = document.createElement("dialog");
        dialog.className = "confirm-dialog";
        const captions = [...button.closest(".counter-tile").querySelectorAll(".counter-value")];
        dialog.innerHTML = `<form method="dialog" class="shift-form"><h2>Названия показателей</h2>
          ${tile.keys.map((key, offset) => {
            const caption = captions[offset];
            const heading = caption.querySelector("[data-tile-caption], strong, button");
            const title = tile.labels?.[key] ?? (key === "widget:board-tabs" ? "Панель вкладок" : (heading ?? caption).textContent.trim());
            return `<label>${escapeHtml(title)}
            <input name="${key}" type="text" value="${escapeHtml(tile.labels?.[key] ?? "")}" placeholder="Стандартное название"></label>`;
          }).join("")}
          <button class="primary-button" value="save">Применить</button><button class="secondary-button" value="cancel">Отмена</button></form>`;
        dialog.addEventListener("close", () => {
          if (dialog.returnValue === "save") {
            const data = new FormData(dialog.querySelector("form"));
            tile.labels = Object.fromEntries([...data].map(([key, value]) => [key, value.trim()]).filter(([, value]) => value));
            paint();
          }
          dialog.remove();
        }, { once: true });
        app.append(dialog);
        dialog.showModal();
        return;
      }
      if (action === "size") {
        tile.span = (tile.span ?? (tile.wide ? 12 : 6)) > 6 ? 6 : 12;
        delete tile.columnStart;
      }
      else if (action === "split") draft.splice(index, 1, ...tile.keys.map((key) => ({ keys: [key], wide: false,
        ...(tile.labels?.[key] ? { labels: { [key]: tile.labels[key] } } : {}) })));
      else if (action === "merge") {
        tile.keys.push(...draft[index + 1].keys);
        tile.labels = { ...tile.labels, ...draft[index + 1].labels };
        tile.wide = true;
        delete tile.span;
        delete tile.columnStart;
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
    document.getElementById("layout-group").onclick = () => {
      const index = activeCounterIndex;
      const tile = draft[index];
      if (tile.keys.length > 1) {
        draft.splice(index, 1, ...tile.keys.map((key) => ({ keys: [key], wide: false,
          ...(tile.labels?.[key] ? { labels: { [key]: tile.labels[key] } } : {}) })));
        paint();
        return;
      }
      const choices = draft.flatMap((candidate, position) => {
        if (position === index || isNavigationTile(tile) !== isNavigationTile(candidate)) return [];
        const node = preview.querySelector(`[data-counter-index="${position}"] .counter-value`);
        return [[String(position), escapeHtml(node.textContent.trim().replace(/\s+/g, " ").slice(0, 70))]];
      });
      if (!choices.length) { showToast("Нет других плиток для этой группы"); return; }
      chooseLayoutAction("Добавить плитку в группу", [...choices, ["cancel","Отмена"]], (action) => {
        if (!/^\d+$/.test(action)) return;
        const position = Number(action);
        const other = draft[position];
        tile.keys.push(...other.keys);
        tile.labels = { ...tile.labels, ...other.labels };
        tile.wide = true;
        delete tile.span;
        delete tile.columnStart;
        draft.splice(position, 1);
        activeCounterIndex = draft.indexOf(tile);
        paint();
      });
    };
    document.getElementById("layout-default").onclick = () => {
      chooseLayoutAction("Сбросить размер выбранной плитки?", [["reset","Сбросить"],["cancel","Отмена"]], (action) => {
        if (action !== "reset") return;
        const tile = draft[activeCounterIndex];
        tile.wide = tile.keys.length > 1;
        delete tile.span;
        delete tile.columnStart;
        delete tile.height;
        paint();
      });
    };
    paint();
    window.scrollTo(0, scrollY);
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

  function additionalShiftEngines(aircraft) {
    return aircraft.blocks.filter((block) => block.kind === "engine" &&
      block.id !== "engine-left" && block.id !== "engine-right")
      .map((block, index) => [`extraEngine${index}`, block]);
  }

  function bindOperationPicker(aircraft, previousType) {
    const picker = document.getElementById("operation-picker");
    const form = picker.closest("form");
    form.prepend(picker);
    const options = aircraft.operationTypes || DEFAULT_OPERATION_TYPES;
    let active = options.some((item) => item.id === previousType) ? previousType : aircraft.defaultOperationType || options[0]?.id;
    const draw = () => {
      const types = aircraft.operationTypes || DEFAULT_OPERATION_TYPES;
      picker.innerHTML = `<fieldset><legend>Вид работы</legend>
        <div class="operation-tags">${types.map(({ id, label }) => `<label class="operation-tag"><input type="radio" name="operationType" value="${id}" ${active === id ? "checked" : ""} required><span>${escapeHtml(label)}</span></label>`).join("")}</div>
        <details><summary>Настроить виды работы</summary>
          <label>Название<input id="operation-label" maxlength="80"></label>
          <div class="operation-tags"><button class="secondary-button" type="button" data-type-action="add">Добавить</button>
          <button class="secondary-button" type="button" data-type-action="rename">Переименовать</button>
          <button class="secondary-button" type="button" data-type-action="default">По умолчанию</button>
          <button class="secondary-button" type="button" data-type-action="remove">Удалить</button></div>
          <small>По умолчанию: ${escapeHtml(types.find((item) => item.id === aircraft.defaultOperationType)?.label || types[0].label)}</small>
        </details></fieldset>`;
      picker.querySelectorAll('input[name="operationType"]').forEach((input) => input.addEventListener("change", () => { active = input.value; }));
      picker.querySelectorAll("[data-type-action]").forEach((button) => button.addEventListener("click", () => {
        const action = button.dataset.typeAction;
        const label = picker.querySelector("#operation-label").value.trim();
        if (["add", "rename"].includes(action) && !label) { showToast("Введи название вида работы"); return; }
        if (action === "remove" && types.length === 1) { showToast("Оставь хотя бы один вид работы"); return; }
        const backup = [aircraft.operationTypes, aircraft.defaultOperationType, active];
        if (action === "add") {
          active = id();
          aircraft.operationTypes = [...types, { id: active, label }];
        } else if (action === "rename") aircraft.operationTypes = types.map((item) => item.id === active ? { ...item, label } : item);
        else if (action === "default") aircraft.defaultOperationType = active;
        else {
          aircraft.operationTypes = types.filter((item) => item.id !== active);
          if (aircraft.defaultOperationType === active) aircraft.defaultOperationType = aircraft.operationTypes[0].id;
          active = aircraft.operationTypes[0].id;
        }
        if (!saveState()) {
          [aircraft.operationTypes, aircraft.defaultOperationType, active] = backup;
          showToast("Не удалось сохранить виды работы");
        }
        draw();
        picker.querySelector("details").open = true;
      }));
    };
    draw();
  }

  function renderShift(editing = false) {
    const aircraft = selectedAircraft();
    const correction = editing ? aircraft.shifts.find((shift) => shift.id === state.selectedShiftId) : null;
    if (editing && !canCorrectShift(aircraft, correction)) {
      showToast("Показания после этой записи уже изменились");
      navigateBack();
      return;
    }
    const typeRule = usageTypeOverride(aircraft);
    const ruleSource = typeRule ? "Правила типа" : state.sharedGround ? "Общие правила" : "Настройки борта";
    const today = new Date();
    const localDate = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    app.innerHTML = shell(`
      <section class="page-heading compact">
        <div><h1>${correction ? "Исправить запись работы" : "Новая запись работы"}</h1><p>${escapeHtml(aircraft.type)} · борт ${escapeHtml(aircraft.boardNumber)}</p><p class="field-help">${ruleSource}</p></div>
      </section>
      <form id="shift-form" class="shift-form">
        <fieldset><legend>Общие данные</legend>
          <label><span>Дата смены</span><input name="date" type="date" value="${localDate}" required></label>
          ${sourceEnabled(aircraft, "flight") ? `<div class="field-pair">
            <label><span>${escapeHtml(usageRule("flight").label)}, часы</span><input name="flightHours" type="number" min="0" value="0" step="1"></label>
            <label><span>${escapeHtml(usageRule("flight").label)}, минуты</span><input name="flightMinutes" type="number" min="0" max="59" value="0" step="1"></label>
          </div>` : ""}
        </fieldset>
        <fieldset><legend>Посадки</legend>
          <div class="landing-grid">
            ${OPTIONAL_USAGE_TYPES.filter((key) => key !== "arresterHooks" && sourceEnabled(aircraft, key)).map((key) => `<label><span>${escapeHtml(usageRule(key).label)}</span><input name="${key}" type="number" min="0" value="0"></label>`).join("")}
          </div>
          ${sourceEnabled(aircraft, "arresterHooks") ? `<label><span>${escapeHtml(usageRule("arresterHooks").label)}</span><input name="arresterHooks" type="number" min="0" value="0"></label>` : ""}
        </fieldset>
        ${customSources(aircraft).some(({ key }) => sourceEnabled(aircraft, key)) ? `<fieldset><legend>Другие показатели</legend>${customSources(aircraft)
          .filter(({ key }) => sourceEnabled(aircraft, key)).map(customWorkInput).join("")}</fieldset>` : ""}
        <div id="operation-picker"></div>
        <fieldset><legend>${escapeHtml(usageRule("ground").label)}</legend>
          <p class="field-help">Процент и округление берутся из формуляра каждого двигателя.</p>
          <div class="field-pair"><label>Левый двигатель, налёт в минутах<input name="leftFlight" type="number" min="0" step="any" placeholder="По налёту борта"></label>
          <label>Правый двигатель, налёт в минутах<input name="rightFlight" type="number" min="0" step="any" placeholder="По налёту борта"></label></div>
          <label><span>Левый двигатель, фактически</span><div class="input-with-unit"><input id="left-ground" name="leftGround" type="number" min="0" value="0"><span>мин</span></div></label>
          <div id="left-calculation" class="calculation-preview"></div>
          <label><span>Правый двигатель, фактически</span><div class="input-with-unit"><input id="right-ground" name="rightGround" type="number" min="0" value="0"><span>мин</span></div></label>
          <div id="right-calculation" class="calculation-preview"></div>
          <div class="field-pair">
            <label><span>Запуски левого двигателя</span><input name="leftStarts" type="number" min="0" value="0"></label>
            <label><span>Запуски правого двигателя</span><input name="rightStarts" type="number" min="0" value="0"></label>
          </div>
        </fieldset>
        <fieldset><legend>${escapeHtml(usageRule("maximum").label)}</legend>
          <div class="field-pair"><label>Левый двигатель, секунды<input name="leftMaximum" type="number" min="0" value="0"></label><label>Правый двигатель, секунды<input name="rightMaximum" type="number" min="0" value="0"></label></div>
          <div class="field-pair"><label>Форсаж левого двигателя, секунды<input name="leftAfterburner" type="number" min="0" value="0"></label><label>Форсаж правого двигателя, секунды<input name="rightAfterburner" type="number" min="0" value="0"></label></div>
        </fieldset>
        <fieldset><legend>Режимы левого двигателя</legend>
          <p class="field-help">Вложенные счётчики сохраняются отдельно: Б уже включает ОР, а Б + УБ уже включает Б и ОР.</p>
          <div class="mode-grid"><label><span>ОР</span><input name="leftOrMode" type="time" step="1" value="00:00:00"></label><label><span>Б, включая ОР</span><input name="leftCombatMode" type="time" step="1" value="00:00:00"></label><label><span>Б + УБ, включая Б и ОР</span><input name="leftCombinedMode" type="time" step="1" value="00:00:00"></label></div>
        </fieldset>
        <fieldset><legend>Режимы правого двигателя</legend>
          <div class="mode-grid"><label><span>ОР</span><input name="rightOrMode" type="time" step="1" value="00:00:00"></label><label><span>Б, включая ОР</span><input name="rightCombatMode" type="time" step="1" value="00:00:00"></label><label><span>Б + УБ, включая Б и ОР</span><input name="rightCombinedMode" type="time" step="1" value="00:00:00"></label></div>
        </fieldset>
        ${additionalShiftEngines(aircraft).map(([prefix, block]) => `
          <fieldset><legend>${escapeHtml(block.name)}</legend>
            <label>${escapeHtml(usageRule("ground").label)}, минут<input name="${prefix}Ground" type="number" min="0" value="0"></label>
            <label>Налёт двигателя, минут<input name="${prefix}Flight" type="number" min="0" step="any" placeholder="По налёту борта"></label>
            <label>Запуски<input name="${prefix}Starts" type="number" min="0" value="0"></label>
            <label>${escapeHtml(usageRule("maximum").label)}, секунды<input name="${prefix}Maximum" type="number" min="0" value="0"></label>
            <label>Форсаж, секунды<input name="${prefix}Afterburner" type="number" min="0" value="0"></label>
            <div class="mode-grid">
              <label>ОР<input name="${prefix}OrMode" type="time" step="1" value="00:00:00"></label>
              <label>Б, включая ОР<input name="${prefix}CombatMode" type="time" step="1" value="00:00:00"></label>
              <label>Б + УБ, включая Б и ОР<input name="${prefix}CombinedMode" type="time" step="1" value="00:00:00"></label>
            </div>
          </fieldset>`).join("")}
        <section id="shift-summary" class="shift-summary"></section>
        <button type="submit" class="primary-button wide">Сохранить работу</button>
      </form>
    `, { title: "Учёт работы", subtitle: `${aircraft.type} · борт ${aircraft.boardNumber}`, back: true, settingsScope: "aircraft" });
    bindShiftForm(correction);
  }

  function bindShiftForm(correction) {
    const form = document.getElementById("shift-form");
    const aircraft = selectedAircraft();
    bindOperationPicker(aircraft, correction?.operationType);
    if (correction) {
      for (const element of form.querySelectorAll("input[name]:not([type=radio])")) {
        element.value = correction.raw[element.name] ?? "";
      }
    }
    const extraEngines = additionalShiftEngines(aircraft);
    const leftBlock = aircraft.blocks.find((block) => block.id === "engine-left");
    const rightBlock = aircraft.blocks.find((block) => block.id === "engine-right");
    const override = usageTypeOverride(aircraft);
    const ground = override?.ground ?? state.sharedGround ?? aircraft.settings;
    const factor = (key) => usageRule(key, aircraft).factor;
    const groundOptions = {
      stepMinutes: ground.groundRoundingMinutes,
      direction: ground.groundRoundingDirection,
      percent: ground.groundPercent,
    };
    const coefficients = Object.fromEntries(["runway", "carrier", "touch", "circuit"].map((key) => [key, factor(key)]));
    function engineIncrement(data, side, block, flight) {
      const actualGround = Number(data.get(`${side}Ground`));
      const override = data.get(`${side}Flight`);
      const engineFlight = override == null || override === "" ? flight : Number(override);
      const rule = block?.groundRule;
      const result = calc.calculateEngineIncrement(engineFlight, actualGround, rule ? {
        stepMinutes: rule.groundRoundingMinutes, direction: rule.groundRoundingDirection, percent: rule.groundPercent,
      } : groundOptions);
      result.totalMinutes = engineFlight * factor("flight") + result.ground.contributionMinutes * (rule ? 1 : factor("ground"));
      result.flightMinutes = engineFlight;
      return result;
    }
    function calculate(data) {
      const flight = Number(data.get("flightHours")) * 60 + Number(data.get("flightMinutes"));
      const left = engineIncrement(data, "left", leftBlock, flight);
      const right = engineIncrement(data, "right", rightBlock, flight);
      const engineUsage = new Map();
      const date = String(data.get("date"));
      for (const [prefix, block, increment] of [["left", leftBlock, left], ["right", rightBlock, right],
        ...extraEngines.map(([key, item]) => [key, item, engineIncrement(data, key, item, flight)])]) {
        if (!block || !blockInstalledOn(block, date)) continue;
        engineUsage.set(block, {
          minutes: increment.totalMinutes, flightMinutes: increment.flightMinutes, ground: increment.ground,
          starts: Number(data.get(`${prefix}Starts`)), maximumSeconds: Number(data.get(`${prefix}Maximum`)) * factor("maximum"),
          afterburnerSeconds: Number(data.get(`${prefix}Afterburner`)), modes: readModes(data, prefix),
        });
      }
      const sources = sourceEnabled(aircraft, "flight") ? { flight: flight / 60 } : {};
      for (const key of OPTIONAL_USAGE_TYPES) {
        const value = data.get(key);
        if (value != null && value !== "") sources[key] = Number(value);
      }
      const customUsage = readCustomWork(aircraft, data);
      for (const { key, value } of customUsage) sources[key] = value;
      const sourceBoard = correction ? { ...aircraft, resources: aircraft.resources.map((resource) => ({
        ...resource, remaining: correction.beforeUsage.resources.find((item) => item.id === resource.id)?.remaining ?? resource.remaining,
      })) } : aircraft;
      const accruals = resourceAccruals(sourceBoard, date, sources, engineUsage);
      return { flight, left: engineUsage.get(leftBlock), right: engineUsage.get(rightBlock), engineUsage, accruals, customUsage };
    }
    const update = () => {
      const data = new FormData(form);
      const { left, right, engineUsage, accruals } = calculate(data);
      const equivalent = calc.calculateEquivalentLandings({ runway: data.get("runway"), carrier: data.get("carrier"), touch: data.get("touch"), circuit: data.get("circuit") }, coefficients);
      const describeGround = (usage) => usage
        ? `${usage.ground.actualMinutes} → ${usage.ground.roundedMinutes} мин → ${usage.ground.percent}% = ${formatNumber(usage.ground.contributionMinutes)} мин`
        : "Двигатель не установлен на дату работы";
      document.getElementById("left-calculation").textContent = describeGround(left);
      document.getElementById("right-calculation").textContent = describeGround(right);
      document.getElementById("shift-summary").innerHTML = `<span>Будет начислено</span><strong>Левый: ${left ? calc.formatDuration(left.minutes) : "—"} · Правый: ${right ? calc.formatDuration(right.minutes) : "—"}</strong><small>Зачёт посадок: ${equivalent.toLocaleString("ru-RU", { maximumFractionDigits: 6 })}</small>`;
      const otherEngines = [...engineUsage].filter(([block]) => block !== leftBlock && block !== rightBlock);
      if (otherEngines.length) document.getElementById("shift-summary").insertAdjacentHTML("beforeend",
        `<details><summary>Другие двигатели (${otherEngines.length})</summary><ul>${otherEngines.map(([block, usage]) =>
          `<li>${escapeHtml(block.name)} · ${calc.formatDuration(usage.minutes)}</li>`).join("")}</ul></details>`);
      if (accruals.length) document.getElementById("shift-summary").insertAdjacentHTML("beforeend", accrualSummary(accruals));
    };
    form.addEventListener("input", update);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const date = String(data.get("date"));
      const modeError = [["left", leftBlock], ["right", rightBlock], ...extraEngines]
        .filter(([, block]) => block && blockInstalledOn(block, date))
        .map(([prefix, block]) => validateNestedModes(data, prefix, block.name)).find(Boolean);
      if (modeError) {
        showToast(modeError);
        return;
      }
      const { flight, left, right, engineUsage, accruals, customUsage } = calculate(data);
      const backup = structuredClone(aircraft);
      if (correction && !canCorrectShift(aircraft, correction)) {
        showToast("Показания изменились. Открой запись заново");
        return;
      }
      if (correction) restoreUsage(aircraft, correction.beforeUsage);
      const beforeUsage = usageSnapshot(aircraft);
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
      aircraft.equivalentLandings = Math.round((aircraft.equivalentLandings + equivalent) * 1e6) / 1e6;
      aircraft.arresterHooks += arresterHooks;
      const airframe = aircraft.blocks.find((block) => block.kind === "airframe");
      if (countsTowardPpr(airframe, date) || (!airframe && (aircraft.pprFlightMinutes != null || aircraft.pprLandings != null))) {
        aircraft.pprFlightMinutes = (aircraft.pprFlightMinutes || 0) + flight;
        aircraft.pprLandings = (aircraft.pprLandings || 0) + actualLandings;
      }
      for (const [block, { minutes, starts, maximumSeconds: maximum, afterburnerSeconds: afterburner, modes }] of engineUsage) {
        const afterRepair = countsTowardPpr(block, date);
        addBlockUsage(block, minutes, actualLandings, afterRepair);
        block.starts = (block.starts || 0) + starts;
        block.maximumSeconds = (block.maximumSeconds || 0) + maximum;
        block.afterburnerSeconds = (block.afterburnerSeconds || 0) + afterburner;
        accumulateModes(block.modesSeconds ??= {}, modes);
        if (afterRepair) {
          block.pprStarts = (block.pprStarts || 0) + starts;
          block.pprMaximumSeconds = (block.pprMaximumSeconds || 0) + maximum;
          block.pprAfterburnerSeconds = (block.pprAfterburnerSeconds || 0) + afterburner;
          accumulateModes(block.pprModesSeconds ??= {}, modes);
        }
      }
      for (const block of aircraft.blocks) {
        if (block.kind === "unit" && blockInstalledOn(block, date)) addBlockUsage(block, flight, actualLandings, countsTowardPpr(block, date));
      }
      for (const entry of accruals) {
        const resource = aircraft.resources.find((item) => item.id === entry.resourceId);
        resource.remaining = entry.remaining;
        resource.status = resourceStatus(resource.remaining, resource.limit);
      }
      const operation = (aircraft.operationTypes || DEFAULT_OPERATION_TYPES).find((item) => item.id === data.get("operationType"));
      const entry = {
        id: correction?.id || id(),
        beforeUsage,
        afterUsage: usageSnapshot(aircraft),
        revisions: correction ? [...(correction.revisions || []), {
          correctedAt: new Date().toISOString(), raw: correction.raw, customUsage: correction.customUsage,
          accruals: correction.accruals, engineAccruals: correction.engineAccruals,
        }] : [],
        operationType: operation?.id,
        operationLabel: operation?.label,
        raw: Object.fromEntries(data),
        customUsage,
        sourceLabels: Object.fromEntries(usageSources(aircraft).map(({ key, label }) => [key, label])),
        accruals,
        engineAccruals: [...engineUsage].map(([block, usage]) => ({ blockId: block.id, name: block.name, ...usage })),
        date: String(data.get("date")),
        flightMinutes: flight,
        leftEngineMinutes: left?.minutes ?? 0,
        rightEngineMinutes: right?.minutes ?? 0,
        landingsByType: landings,
        landingCoefficients: { ...coefficients },
        usageRules: Object.fromEntries(Object.keys(USAGE_TYPES).map((key) => [key, { ...usageRule(key), factor: factor(key) }])),
        groundOptions: { ...groundOptions },
        weightedHooks: arresterHooks * factor("arresterHooks"),
        leftMaximumSeconds: Number(data.get("leftMaximum")),
        rightMaximumSeconds: Number(data.get("rightMaximum")),
        leftAfterburnerSeconds: Number(data.get("leftAfterburner")),
        rightAfterburnerSeconds: Number(data.get("rightAfterburner")),
        otherEngines: extraEngines.filter(([, block]) => engineUsage.has(block)).map(([, block]) => ({ blockId: block.id, ...engineUsage.get(block) })),
        actualLandings,
        equivalentLandings: equivalent,
        arresterHooks,
        leftGroundActualMinutes: left?.ground.actualMinutes ?? 0,
        leftGroundRoundedMinutes: left?.ground.roundedMinutes ?? 0,
        rightGroundActualMinutes: right?.ground.actualMinutes ?? 0,
        rightGroundRoundedMinutes: right?.ground.roundedMinutes ?? 0,
        leftStarts: left?.starts ?? 0,
        rightStarts: right?.starts ?? 0,
        leftModesSeconds: readModes(data, "left"),
        rightModesSeconds: readModes(data, "right"),
      };
      if (correction) aircraft.shifts[aircraft.shifts.length - 1] = entry;
      else {
        const previous = aircraft.shifts.at(-1);
        if (previous) { delete previous.beforeUsage; delete previous.afterUsage; }
        aircraft.shifts.push(entry);
      }
      if (!saveState()) {
        Object.assign(aircraft, backup);
        showToast("Не удалось сохранить работу");
        render();
        return;
      }
      navigateBack();
      showToast(correction ? "Запись исправлена, начисления пересчитаны" : "Работа сохранена");
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

  function addBlockUsage(block, minutes, landings, afterRepair) {
    block.sneMinutes = (block.sneMinutes || 0) + minutes;
    block.sneLandings = (block.sneLandings || 0) + landings;
    if (afterRepair) {
      block.pprMinutes = (block.pprMinutes || 0) + minutes;
      block.pprLandings = (block.pprLandings || 0) + landings;
    }
  }

  function accumulateModes(totals, modes) {
    for (const [key, seconds] of Object.entries(modes)) totals[key] = (totals[key] || 0) + seconds;
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
    const notificationConfig = aircraft.notificationConfig;
    const notificationRows = aircraft.resources.map((resource) => `
      <div class="setting-row notification-work-row" data-notification-work="${escapeHtml(`${resource.object} ${resource.name}`.toLowerCase())}">
        <span><strong>${escapeHtml(resource.name)}</strong><small>${escapeHtml(resource.object)} · ${formatNumber(resource.remaining)} ${escapeHtml(resource.unit)}</small></span>
        <span class="notification-channel-toggles"><label title="Приложение"><input data-resource-notify-app="${resource.id}" type="checkbox" ${resource.notifyApp !== false ? "checked" : ""} ${!aircraft.notifications ? "disabled" : ""}><small>Прил.</small></label><label title="Календарь"><input data-resource-notify-calendar="${resource.id}" type="checkbox" ${resource.notifyCalendar ? "checked" : ""} ${!aircraft.notifications ? "disabled" : ""}><small>Кал.</small></label></span>
      </div>`).join("");
    app.innerHTML = shell(`
      <section class="page-heading compact"><div><p class="eyebrow">${escapeHtml(aircraft.type)} · борт ${escapeHtml(aircraft.boardNumber)}</p><h1>Настройки самолёта</h1></div></section>
      <button class="setting-row" data-view="board-usage"><strong>Показатели работы этого борта</strong>${icon("chevron")}</button>
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
    document.querySelectorAll("[data-rename-block-id]").forEach((button) => button.addEventListener("click", () => renameBlockById(button.dataset.renameBlockId)));
    document.querySelectorAll("[data-remove-block-id]").forEach((button) => button.addEventListener("click", () => removeBlock(button.dataset.removeBlockId)));
  }

  function isArchivedType(name) {
    return state.archivedAircraftTypes.includes(name.trim().toLowerCase());
  }

  function activeAircraftTypes() {
    return state.aircraftTypes.filter((name) => !isArchivedType(name));
  }

  function aircraftTypeSelect(selected = "") {
    const types = state.aircraftTypes.filter((name) => !isArchivedType(name) || name.toLowerCase() === selected.trim().toLowerCase());
    return `<select name="type" required><option value="">Выбрать тип</option>${types.map((name) =>
      `<option value="${escapeHtml(name)}" ${name.toLowerCase() === selected.trim().toLowerCase() ? "selected" : ""}>${escapeHtml(name)}</option>`
    ).join("")}</select>`;
  }

  function renderBoardDetails() {
    const aircraft = selectedAircraft();
    app.innerHTML = shell(`<h1>Реквизиты борта</h1>
      <form id="board-details-form" class="shift-form settings-form">
        <label>Тип самолёта${aircraftTypeSelect(aircraft.type)}</label>
        <label>Бортовой номер<input name="boardNumber" type="text" value="${escapeHtml(aircraft.boardNumber)}" required></label>
        <label>Заводской номер<input name="serialNumber" type="text" value="${escapeHtml(aircraft.serialNumber || "")}"></label>
        <label>RF<input name="rfNumber" type="text" value="${escapeHtml(aircraft.rfNumber || "")}" placeholder="Например, 33738"></label>
        <p id="board-details-status" class="field-help" role="status"></p>
        <button class="primary-button" type="submit">Сохранить реквизиты</button>
      </form>`, { title: "Реквизиты борта", subtitle: "", back: true, settings: false });
    const form = document.getElementById("board-details-form");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, value.trim()]));
      const status = document.getElementById("board-details-status");
      if (!state.aircraftTypes.includes(data.type) || !data.boardNumber) { status.textContent = "Укажи тип и бортовой номер."; return; }
      data.rfNumber = data.rfNumber.replace(/^RF[\s-]*/i, "");
      const previous = Object.fromEntries(Object.keys(data).map((key) => [key, aircraft[key]]));
      Object.assign(aircraft, data);
      if (saveState()) navigateBack();
      else {
        Object.assign(aircraft, previous);
        status.textContent = "Не удалось сохранить реквизиты.";
      }
    });
  }

  function renderBoardImage() {
    const aircraft = selectedAircraft();
    app.innerHTML = shell(`<h1>Картинка борта</h1>
      <form id="board-image-form" class="shift-form settings-form">
        <span class="aircraft-card__visual" id="board-image-preview">${icon("plane")}</span>
        <label>Фото или эмблема<input name="picture" type="file" accept="image/*"></label>
        <label>Как показывать<select name="fit"><option value="cover">Заполнить рамку с обрезкой</option><option value="contain">Показать целиком</option></select></label>
        <p class="field-help" role="status" id="board-image-status"></p>
        <div class="aircraft-actions"><button class="primary-button" type="submit">Сохранить картинку</button>
        <button type="button" class="secondary-button" id="board-image-remove">Убрать картинку</button></div>
      </form>`, { title: "Картинка борта", subtitle: "", back: true, settings: false });
    bindBoardImageForm(aircraft);
  }

  function bindBoardImageForm(aircraft) {
    const form = document.getElementById("board-image-form");
    const preview = document.getElementById("board-image-preview");
    const status = document.getElementById("board-image-status");
    let data = aircraft.cardImage?.data ?? "";
    let selection = 0;
    form.elements.fit.value = aircraft.cardImage?.fit ?? "cover";
    function showPreview() {
      preview.innerHTML = data ? `<img class="board-image ${form.elements.fit.value === "contain" ? "board-image-contain" : ""}" src="${escapeHtml(data)}" alt="">` : icon("plane");
    }
    form.elements.fit.addEventListener("change", showPreview);
    form.elements.picture.addEventListener("change", async (event) => {
      const file = event.target.files[0];
      const current = ++selection;
      const save = form.querySelector('[type="submit"]');
      save.disabled = false;
      if (!file) return;
      if (!file.type.startsWith("image/") || file.size > 15 * 1024 * 1024) {
        event.target.value = "";
        status.textContent = "Выбери изображение размером до 15 МБ.";
        return;
      }
      save.disabled = true;
      const url = URL.createObjectURL(file);
      try {
        const picture = new Image();
        picture.src = url;
        await picture.decode();
        if (selection !== current) return;
        const scale = Math.min(1, 320 / Math.max(picture.naturalWidth, picture.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(picture.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(picture.naturalHeight * scale));
        canvas.getContext("2d").drawImage(picture, 0, 0, canvas.width, canvas.height);
        data = canvas.toDataURL("image/webp", 0.84);
        showPreview();
        status.textContent = "Картинка готова. Нажми «Сохранить картинку».";
      } catch (_) {
        if (selection === current) status.textContent = "Не удалось открыть выбранное изображение.";
      } finally {
        URL.revokeObjectURL(url);
        if (selection === current) save.disabled = false;
      }
    });
    document.getElementById("board-image-remove").onclick = () => {
      selection += 1;
      form.querySelector('[type="submit"]').disabled = false;
      form.elements.picture.value = "";
      data = "";
      showPreview();
      status.textContent = "Нажми «Сохранить картинку», чтобы убрать её с карточки.";
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const previous = aircraft.cardImage;
      aircraft.cardImage = data ? { data, fit: form.elements.fit.value } : undefined;
      if (saveState()) status.textContent = "Картинка сохранена.";
      else {
        aircraft.cardImage = previous;
        status.textContent = "Не удалось сохранить картинку. Проверь свободное место.";
      }
    });
    showPreview();
  }

  function renderBlock() {
    const aircraft = selectedAircraft();
    const block = aircraft.blocks.find((item) => item.id === state.selectedBlockId);
    if (!block) {
      state.view = "aircraft";
      renderAircraft();
      return;
    }
    const repaired = block.repairs > 0;
    const groundRule = block.groundRule ?? usageTypeOverride(aircraft)?.ground ?? state.sharedGround ?? aircraft.settings;
    const ppr = (value) => repaired && value != null ? value : "—";
    const modeRow = (label, total, sinceRepair, format) => `<div class="metric"><span>${escapeHtml(label)}</span><strong>${format(total || 0)} / ${ppr(sinceRepair == null ? null : format(sinceRepair))}</strong></div>`;
    const blockFields = block.kind !== "airframe" ? `
      <fieldset><legend>Наработка</legend>
        <div class="field-pair">
          <label><span>СНЭ, минут</span><input name="sneMinutes" type="number" min="0" step="0.01" value="${block.sneMinutes || 0}"></label>
          <label><span>ППР, минут</span><input name="pprMinutes" type="number" min="0" step="0.01" value="${repaired ? block.pprMinutes ?? "" : ""}" ${repaired ? "" : "disabled"}></label>
        </div>
        <div class="field-pair">
          <label>Посадки СНЭ<input name="sneLandings" type="number" min="0" step="1" value="${block.sneLandings || 0}"></label>
          <label>Посадки ППР<input name="pprLandings" type="number" min="0" step="1" value="${repaired ? block.pprLandings ?? "" : ""}" ${repaired ? "" : "disabled"}></label>
        </div>
        ${block.kind === "engine" ? `<label><span>Количество запусков СНЭ</span><input name="starts" type="number" min="0" step="1" value="${block.starts || 0}"></label>
        <p>Порядок значений: СНЭ / ППР</p>
        <div class="metric-grid compact-metrics">
          <div class="metric"><span>СНЭ</span><strong>${calc.formatDuration(block.sneMinutes || 0)}</strong></div>
          <div class="metric"><span>ППР</span><strong>${ppr(block.pprMinutes == null ? null : calc.formatDuration(block.pprMinutes))}</strong></div>
          ${modeRow("Запуски", block.starts, block.pprStarts, formatNumber)}
          ${modeRow("ОР", block.modesSeconds?.or, block.pprModesSeconds?.or, formatSeconds)}
          ${modeRow("Б, включая ОР", block.modesSeconds?.combat, block.pprModesSeconds?.combat, formatSeconds)}
          ${modeRow("Б + УБ", block.modesSeconds?.combined, block.pprModesSeconds?.combined, formatSeconds)}
          ${modeRow(usageRule("maximum").label, block.maximumSeconds, block.pprMaximumSeconds, formatSeconds)}
          ${modeRow("Форсаж", block.afterburnerSeconds, block.pprAfterburnerSeconds, formatSeconds)}
        </div>` : ""}
      </fieldset>` : "";
    const relatedResources = aircraft.resources.filter((resource) =>
      resourceOwner(aircraft, resource) === block || (block.kind === "airframe" && resource.object === "Самолёт")
    );
    const assemblies = aircraft.blocks.filter((item) => item.kind !== "airframe");
    const installedAssemblies = assemblies.filter((item) => blockInstalledOn(item, todayIso()));
    const assemblyHistory = assemblies.flatMap((item) =>
      item.events.filter((entry) => entry.type === "install" || entry.type === "dismantle")
        .map((entry) => ({ ...entry, name: item.name })))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const airframeFields = block.kind === "airframe" ? `
      <section class="metric-grid" aria-label="Наработка планера">
        <div class="metric"><span>${escapeHtml(usageRule("flight").label)}</span><strong>${calc.formatDuration(aircraft.totalFlightMinutes)}</strong></div>
        <div class="metric"><span>Фактические посадки</span><strong>${aircraft.actualLandings}</strong></div>
        <div class="metric"><span>Зацепы</span><strong>${aircraft.arresterHooks}</strong></div>
      </section>
      <fieldset><legend>ППР планера</legend>
        <label>${escapeHtml(usageRule("flight").label)} ППР, минут<input name="pprFlightMinutes" type="number" min="0" step="1" value="${aircraft.pprFlightMinutes ?? ""}" ${repaired ? "" : "disabled"}></label>
        <label>Посадки ППР<input name="pprLandings" type="number" min="0" step="1" value="${aircraft.pprLandings ?? ""}" ${repaired ? "" : "disabled"}></label>
      </fieldset>` : "";
    const installations = block.kind === "airframe" ? `
      <section class="section-stack settings-section-heading">
        <h2>Установленные агрегаты</h2>
        ${installedAssemblies.map((item) => {
          const entry = item.events.filter((event) => event.type === "install" && event.date <= todayIso())
            .sort((a, b) => a.date.localeCompare(b.date)).at(-1);
          return `<button class="setting-row" data-block-id="${escapeHtml(item.id)}"><span>
            <strong>${escapeHtml(item.name)}</strong>
            <small>${entry ? `Установлен ${formatOptionalDate(entry.date)}${entry.note ? ` · ${escapeHtml(entry.note)}` : ""}` : "Дата установки не указана"}</small>
          </span>${icon("chevron")}</button>`;
        }).join("") || "<p>Установленных агрегатов пока нет.</p>"}
        <h2>История установок и демонтажа</h2>
        ${assemblyHistory.map((entry) => `<article class="history-row"><div>
          <strong>${formatOptionalDate(entry.date)} · ${escapeHtml(entry.name)}</strong>
          <span>${entry.type === "install" ? "Установка" : "Демонтаж"}${entry.note ? ` · ${escapeHtml(entry.note)}` : ""}</span>
        </div></article>`).join("") || "<p>Записей пока нет.</p>"}
      </section>` : "";
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
    const historicalRows = Object.entries(block.historicalRepairs || {}).map(([number, entry]) => {
      const { sneMinutes, pprMinutes, sneLandings, pprLandings } = entry.beforeRepair;
      return `<article class="history-row"><div><strong>Ремонт № ${escapeHtml(number)}${entry.date ? ` · ${formatDate(entry.date)}` : ""}</strong>
        <span>До ремонта · СНЭ: ${sneMinutes == null ? "—" : calc.formatDuration(sneMinutes)}, посадки ${sneLandings ?? "—"}</span>
        <span>ППР: ${pprMinutes == null ? "—" : calc.formatDuration(pprMinutes)}, посадки ${pprLandings ?? "—"}</span>
        ${entry.note ? `<span>${escapeHtml(entry.note)}</span>` : ""}</div></article>`;
    }).join("");
    app.innerHTML = shell(`
      <section class="page-heading compact"><div><p class="eyebrow">${escapeHtml(aircraft.type)} · борт ${escapeHtml(aircraft.boardNumber)}</p><h1>${escapeHtml(block.name)}</h1><p>${escapeHtml(block.caption)}</p></div></section>
      <form id="block-form" class="shift-form">
        <fieldset><legend>Формуляр</legend>
          <label><span>Название</span><input name="name" type="text" value="${escapeHtml(block.name)}" required></label>
          <label><span>Описание</span><input name="caption" type="text" value="${escapeHtml(block.caption)}"></label>
          ${block.kind === "airframe" ? `
          <div class="field-pair">
            <label>Заводской номер<output>${escapeHtml(aircraft.serialNumber || "Не указан")}</output></label>
            <label>RF<output>${escapeHtml(aircraft.rfNumber || "Не указан")}</output></label>
          </div>` : `
          ${block.kind === "engine" ? "" : `<label><span>Тип/модель</span><input name="model" type="text" value="${escapeHtml(block.model || "")}"></label>`}
          <label><span>Заводской/обычный номер</span><input name="serialNumber" type="text" value="${escapeHtml(block.serialNumber || "")}"></label>
          <label><span>Чертёжный номер</span><input name="drawingNumber" type="text" value="${escapeHtml(block.drawingNumber || "")}"></label>
          <label><span>Состояние установки</span><select name="installed"><option value="true" ${blockInstalledOn(block, todayIso()) ? "selected" : ""}>Установлен</option><option value="false" ${!blockInstalledOn(block, todayIso()) ? "selected" : ""}>Демонтирован</option></select></label>`}
          <label>Количество ремонтов<output>${block.repairs}</output></label>
        </fieldset>
        ${airframeFields}
        ${blockFields}
        ${block.kind === "engine" ? `<fieldset><legend>Земная наработка этого двигателя</legend>
          <label>Доля в общей наработке, %<input name="groundPercent" type="number" min="0" max="100" step="any" value="${groundRule.groundPercent}" required></label>
          <label>Шаг округления, минут<input name="groundStep" type="number" min="1" step="1" value="${groundRule.groundRoundingMinutes}" required></label>
          <label>Направление<select name="groundDirection">${[["nearest","До ближайшего"],["up","Вверх"],["down","Вниз"]].map(([value, name]) =>
            `<option value="${value}" ${groundRule.groundRoundingDirection === value ? "selected" : ""}>${name}</option>`).join("")}</select></label>
        </fieldset>` : ""}
        <button type="submit" class="primary-button wide">Сохранить формуляр</button>
      </form>
      <button type="button" class="add-block-button" data-view="correct-usage">Уточнить показания</button>
      ${installations}
      <div class="section-heading settings-section-heading"><div><h2>Ресурсы и работы</h2><p>Связанные с этим формуляром ограничения.</p></div></div>
      <section class="resource-list">${relatedResources.length ? resourceRows(relatedResources, { editable: true }) : `<div class="empty-state compact-empty"><p>Связанных ресурсов пока нет.</p></div>`}</section>
      <button class="add-block-button" data-action="add-resource" data-resource-object="${escapeHtml(block.name)}" data-resource-owner="${escapeHtml(block.id)}">${icon("plus")} Добавить ограниченный ресурс</button>
      <div class="section-heading settings-section-heading"><div><h2>История событий</h2><p>Смены, ремонты, установки и продления.</p></div></div>
      <section class="history-list">${(eventRows + historicalRows) || `<div class="empty-state compact-empty"><p>Исторических операций для этого объекта пока нет.</p></div>`}</section>
      <form id="block-event-form" class="shift-form event-form">
        <fieldset><legend>Добавить событие</legend>
          <div class="field-pair"><label><span>Тип события</span><select name="type"><option value="repair">Ремонт</option><option value="dismantle">Демонтаж</option><option value="install">Установка</option><option value="extension">Продление ресурса</option><option value="correction">Корректировка</option></select></label><label><span>Дата</span><input name="date" type="date" value="${todayIso()}" required></label></div>
          <label><span>Цель установки, основание или примечание</span><input name="note" type="text" placeholder="Цель, номер документа или акт"></label>
          <button type="submit" class="secondary-button wide">Записать событие</button>
        </fieldset>
      </form>
    `, { title: block.name, subtitle: "Формуляр объекта", back: true, settingsScope: "aircraft" });

    document.getElementById("block-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const name = String(data.get("name")).trim();
      if (!name) { showToast("Введи название формуляра"); return; }
      const before = structuredClone(aircraft);
      updateBlockName(aircraft, block, name);
      block.caption = String(data.get("caption") || "").trim();
      if (block.kind !== "airframe") {
        if (data.has("model")) block.model = String(data.get("model")).trim();
        block.serialNumber = String(data.get("serialNumber") || "").trim();
        block.drawingNumber = String(data.get("drawingNumber") || "").trim();
        const installed = data.get("installed") === "true";
        if (blockInstalledOn(block, todayIso()) !== installed) {
          recordInstallation(block, { id: id(), type: installed ? "install" : "dismantle", date: todayIso(), note: "" });
        }
      }
      if (block.kind === "airframe" && repaired) {
        aircraft.pprFlightMinutes = data.get("pprFlightMinutes") === "" ? null : Number(data.get("pprFlightMinutes"));
        aircraft.pprLandings = data.get("pprLandings") === "" ? null : Number(data.get("pprLandings"));
      } else if (block.kind !== "airframe") {
        block.sneMinutes = Number(data.get("sneMinutes"));
        block.sneLandings = Number(data.get("sneLandings"));
        if (repaired) {
          block.pprMinutes = data.get("pprMinutes") === "" ? null : Number(data.get("pprMinutes"));
          block.pprLandings = data.get("pprLandings") === "" ? null : Number(data.get("pprLandings"));
        }
        if (block.kind === "engine") {
          block.starts = Number(data.get("starts"));
          block.groundRule = { groundPercent: Number(data.get("groundPercent")), groundRoundingMinutes: Number(data.get("groundStep")),
            groundRoundingDirection: data.get("groundDirection") };
        }
      }
      if (!saveState()) {
        Object.assign(aircraft, before);
        render();
        showToast("Не удалось сохранить формуляр");
        return;
      }
      showToast("Формуляр сохранён");
      renderBlock();
      bindCommonActions();
    });
    document.getElementById("block-event-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const type = String(data.get("type"));
      const item = { id: id(), type, date: String(data.get("date")), note: String(data.get("note") || "").trim() };
      const before = structuredClone(aircraft);
      if (type === "repair") {
        item.repairNumber = block.repairs + 1;
        item.beforeRepair = {
          sneMinutes: block.kind === "airframe" ? aircraft.totalFlightMinutes : block.sneMinutes ?? 0,
          pprMinutes: repaired ? (block.kind === "airframe" ? aircraft.pprFlightMinutes : block.pprMinutes) ?? null : null,
          sneLandings: block.kind === "airframe" ? aircraft.actualLandings : block.sneLandings ?? 0,
          pprLandings: block.kind === "airframe" ? aircraft.pprLandings ?? null : block.pprLandings ?? null,
          starts: block.starts ?? null,
          pprStarts: block.pprStarts ?? null,
          maximumSeconds: block.maximumSeconds ?? null,
          pprMaximumSeconds: block.pprMaximumSeconds ?? null,
          afterburnerSeconds: block.afterburnerSeconds ?? null,
          pprAfterburnerSeconds: block.pprAfterburnerSeconds ?? null,
          modesSeconds: structuredClone(block.modesSeconds ?? null),
          pprModesSeconds: structuredClone(block.pprModesSeconds ?? null),
          repairs: block.repairs,
        };
        block.repairs += 1;
        if (block.kind === "airframe") {
          aircraft.pprFlightMinutes = 0;
          aircraft.pprLandings = 0;
        } else {
          block.pprMinutes = 0;
          block.pprLandings = 0;
          if (block.kind === "engine") {
            block.pprStarts = 0;
            block.pprMaximumSeconds = 0;
            block.pprAfterburnerSeconds = 0;
            block.pprModesSeconds = { or: 0, combat: 0, combined: 0 };
          }
        }
      }
      if (type === "dismantle" || type === "install") recordInstallation(block, item);
      else block.events.push(item);
      if (!saveState()) {
        Object.assign(aircraft, before);
        render();
        showToast("Не удалось сохранить событие");
        return;
      }
      render();
      showToast("Событие записано в историю");
    });
  }

  function renderUsageCorrection() {
    const aircraft = selectedAircraft();
    const block = aircraft.blocks.find((item) => item.id === state.selectedBlockId);
    const airframe = block.kind === "airframe";
    const subject = airframe ? aircraft : block;
    const readCounter = (key) => {
      const [group, entry] = key.split(".");
      return entry ? subject[group]?.[entry] : subject[group];
    };
    const writeCounter = (key, value) => {
      const [group, entry] = key.split(".");
      if (entry) subject[group] = { ...subject[group], [entry]: value };
      else subject[group] = value;
    };
    const names = airframe ? ["totalFlightMinutes", "actualLandings", "pprFlightMinutes", "pprLandings"] :
      ["sneMinutes", "sneLandings", "pprMinutes", "pprLandings"];
    const labels = ["Наработка СНЭ, минут", "Посадки СНЭ", "Наработка ППР, минут", "Посадки ППР"];
    const counters = names.map((key, index) => [key, labels[index], subject[key], index >= 2]);
    if (block.kind === "engine") {
      for (const [label, total, ppr] of [
        ["Запуски", "starts", "pprStarts"], ["Максимал, с", "maximumSeconds", "pprMaximumSeconds"],
        ["Форсаж, с", "afterburnerSeconds", "pprAfterburnerSeconds"],
        ["ОР, с", "modesSeconds.or", "pprModesSeconds.or"], ["Б, с", "modesSeconds.combat", "pprModesSeconds.combat"],
        ["Б + УБ, с", "modesSeconds.combined", "pprModesSeconds.combined"],
      ]) {
        counters.push([total, `${label} · СНЭ`, readCounter(total), false], [ppr, `${label} · ППР`, readCounter(ppr), true]);
      }
    }
    const repairs = block.events.filter((entry) => entry.type === "repair");
    const imported = block.historicalRepairs || {};
    app.innerHTML = shell(`
      <form id="correct-usage-form" class="shift-form">
        <fieldset><legend>Текущие показания · ${escapeHtml(block.name)}</legend>
          <label>Количество ремонтов<input name="repairs" type="number" min="${repairs.length}" step="1" value="${block.repairs}" required></label>
          <div class="field-pair">${counters.map(([key, label, value, isPpr]) => `<label>${escapeHtml(label)}<input name="${key}" ${isPpr ? "data-ppr" : ""} type="number" min="0" step="any" value="${value ?? (isPpr ? "" : 0)}"></label>`).join("")}</div>
          <label>Основание или номер документа<input name="note"></label>
          <button class="primary-button" type="submit">Сохранить показания</button>
        </fieldset>
      </form>
      <form id="historical-repair-form" class="shift-form">
        <fieldset ${block.repairs ? "" : "disabled"}><legend>Показания до ремонта</legend>
          <p>Заполни известные данные отдельно для каждого ремонта. Пустое поле означает, что показание неизвестно.</p>
          <label>Ремонт №<input name="number" type="number" min="1" max="${block.repairs}" value="1" required></label>
          <label>Дата ремонта<input name="date" type="date"></label>
          <div class="field-pair">${counters.map(([key, label]) => `<label>${escapeHtml(label)}<input name="${key}" type="number" min="0" step="any"></label>`).join("")}</div>
          <label>Основание<input name="note"></label>
          <button class="secondary-button" type="submit">Сохранить запись о ремонте</button>
        </fieldset>
      </form>`, { title: "Уточнить показания", back: true, settings: false });
    const form = document.getElementById("correct-usage-form");
    const update = () => form.querySelectorAll("[data-ppr]").forEach((input) => { input.disabled = Number(form.elements.repairs.value) === 0; });
    form.elements.repairs.addEventListener("input", update);
    update();
    const numberOrNull = (value) => value === "" || value == null ? null : Number(value);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const previous = { repairs: block.repairs };
      const current = { repairs: Number(data.get("repairs")) };
      for (const [key, , , isPpr] of counters) {
        previous[key] = readCounter(key) ?? null;
        current[key] = isPpr ? numberOrNull(data.get(key)) : Number(data.get(key));
        writeCounter(key, current[key]);
      }
      block.repairs = current.repairs;
      block.events.push({ id: id(), type: "correction", date: todayIso(), note: data.get("note"), previous, current });
      if (saveState()) {
        render();
        showToast("Показания сохранены");
      } else {
        block.events.pop();
        block.repairs = previous.repairs;
        for (const [key] of counters) writeCounter(key, previous[key]);
        showToast("Не удалось сохранить показания");
      }
    });
    const history = document.getElementById("historical-repair-form");
    const loadRepair = () => {
      const number = Number(history.elements.number.value);
      const entry = imported[number] || repairs.find((item, index) => (item.repairNumber ?? index + 1) === number);
      history.elements.date.value = entry?.date || "";
      history.elements.note.value = entry?.note || "";
      const usage = entry?.beforeRepair || {};
      counters.forEach(([key], index) => {
        const [group, entry] = key.split(".");
        history.elements[key].value = usage[key] ?? (entry ? usage[group]?.[entry] : null) ??
          usage[["sneMinutes", "sneLandings", "pprMinutes", "pprLandings"][index]] ?? "";
      });
    };
    history.elements.number.addEventListener("input", loadRepair);
    loadRepair();
    history.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(history);
      const number = Number(data.get("number"));
      const beforeRepair = Object.fromEntries(counters.map(([key], index) => [
        ["sneMinutes", "sneLandings", "pprMinutes", "pprLandings"][index] || key, numberOrNull(data.get(key)),
      ]));
      block.historicalRepairs = { ...imported, [number]: { date: data.get("date"), note: data.get("note"), beforeRepair } };
      if (saveState()) { render(); showToast("Показания до ремонта сохранены"); }
      else { block.historicalRepairs = imported; showToast("Не удалось сохранить запись"); }
    });
  }

  function accrualSummary(entries) {
    const ordered = [...entries].sort((a, b) => Number(Boolean(b.priority)) - Number(Boolean(a.priority)));
    const row = (entry) => `<li><strong>${escapeHtml(entry.object)} · ${escapeHtml(entry.name)}</strong>
      <span>Расход ${formatNumber(entry.amount, 6)} ${escapeHtml(entry.unit)} · остаток ${formatNumber(entry.remaining, 6)}</span>
      <small>${entry.inputs.map(({ key, input, factor, amount }) =>
        `${escapeHtml(entry.labels?.[key] || ENGINE_SOURCES[key] || USAGE_TYPES[key] || "Показатель")} ${formatNumber(input, 6)} × ${formatNumber(factor, 6)} = ${formatNumber(amount, 6)}`).join(" · ")}</small></li>`;
    return `<ol class="accrual-items">${ordered.slice(0, 3).map(row).join("")}</ol>
      ${ordered.length > 3 ? `<details><summary>Остальные начисления (${ordered.length - 3})</summary><ol class="accrual-items">${ordered.slice(3).map(row).join("")}</ol></details>` : ""}`;
  }

  function renderShiftEntry() {
    const aircraft = selectedAircraft();
    const shift = aircraft.shifts.find((entry) => entry.id === state.selectedShiftId);
    if (!shift) { navigateBack(); return; }
    const engines = shift.engineAccruals || [];
    const builtIn = (key) => shift.usageRules?.[key]?.label || usageRule(key).label;
    const customRows = shift.customUsage?.map(({label, value, seconds, format}) => {
      if (seconds == null) return [label, formatNumber(value)];
      const text = format === "seconds" ? `${Math.floor(seconds / 60)} мин ${seconds % 60} с` :
        `${Math.floor(seconds / 3600)} ч ${Math.floor(seconds / 60) % 60} мин`;
      return [label, text];
    }) ?? Object.entries(shift.raw || {}).filter(([key, value]) => key.startsWith("custom-") && value !== "")
      .map(([key, value]) => [shift.sourceLabels?.[key] || key, value]);
    const rawRows = [
      [builtIn("flight"), calc.formatDuration(shift.flightMinutes)],
      ...OPTIONAL_USAGE_TYPES.filter((key) => shift.raw ? key in shift.raw : key in (shift.landingsByType || {}))
        .map((key) => [builtIn(key), shift.raw?.[key] ?? shift.landingsByType?.[key]]),
      ...customRows,
    ];
    app.innerHTML = shell(`
      <section class="section-stack"><h1>${escapeHtml(shift.operationLabel || "Лётная смена")}</h1><p>${formatDate(shift.date)}</p>
        <details open><summary>Введённые показатели</summary><dl>${rawRows.map(([label, value]) =>
          `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd>`).join("")}</dl></details>
        <details open><summary>Двигатели</summary><ol class="accrual-items">${engines.length ? engines.map((entry) =>
          `<li><strong>${escapeHtml(entry.name)} · ${calc.formatDuration(entry.minutes)}</strong><small>Налёт ${calc.formatDuration(entry.flightMinutes)} · земля ${entry.ground.actualMinutes} → ${entry.ground.roundedMinutes} мин × ${entry.ground.percent}%</small></li>`).join("") :
          `<li>Левый · ${calc.formatDuration(shift.leftEngineMinutes)}</li><li>Правый · ${calc.formatDuration(shift.rightEngineMinutes)}</li>`}</ol></details>
        <h2>Расход ресурсов</h2>
        ${shift.accruals?.length ? accrualSummary(shift.accruals) : `<p>${shift.accruals ? "Начислений по ресурсам нет." : "Для этой записи разбивка по ресурсам не сохранялась."}</p>`}
        <button class="secondary-button" id="open-shift-map">Карта начислений</button>
        ${canCorrectShift(aircraft, shift) ? `<button class="secondary-button" data-view="correct-shift">Исправить запись</button>` : ""}
        ${(shift.revisions || []).map((revision) => `<details><summary>Предыдущая версия · ${escapeHtml(new Date(revision.correctedAt).toLocaleString("ru-RU"))}</summary>
          <p>Налёт: ${calc.formatDuration(Number(revision.raw.flightHours) * 60 + Number(revision.raw.flightMinutes))}</p>
          ${accrualSummary(revision.accruals || [])}</details>`).join("")}
      </section>`, { title: "Запись работы", back: true, settings: false });
    document.getElementById("open-shift-map").addEventListener("click", () => {
      state.mapShiftId = shift.id;
      navigateTo("usage-map");
    });
  }

  function renderUsageMap() {
    const aircraft = selectedAircraft();
    const shift = aircraft.shifts.find((entry) => entry.id === state.mapShiftId);
    const blocks = aircraft.blocks.filter((block) => block.kind !== "airframe");
    const first = aircraft.blocks.find((block) => block.kind === "airframe");
    const boardNode = "__airframe";
    const resources = aircraft.resources.filter((resource) => resource.unit !== "дн.");
    const resourceEdges = shift ? (shift.accruals || []).flatMap((entry) => entry.inputs.map((input) => ({
      ...input, target: entry.blockId || boardNode, name: entry.name, enabled: true, installed: true,
    }))) : resources.flatMap((resource) => {
      const owner = resourceOwner(aircraft, resource);
      if (!owner && resource.object !== "Самолёт") return [];
      return Object.entries(resourceInputs(resource, owner)).filter(([, factor]) => factor > 0).map(([key, factor]) => ({
        key, factor: resourceSourceFactor(aircraft, key, factor), target: owner?.kind === "airframe" || !owner ? boardNode : owner.id,
        name: resource.name, enabled: sourceEnabled(aircraft, key), installed: !owner || blockInstalledOn(owner, todayIso()), installedDate: resource.installed,
      }));
    });
    const landingKeys = OPTIONAL_USAGE_TYPES.filter((key) => key !== "arresterHooks");
    const makeCounterEdge = (target, key, name, installed, condition) =>
      ({ target, key, name, installed, condition, factor: 1, counter: true, enabled: sourceEnabled(aircraft, key) });
    const pprCondition = "ППР начисляется после ремонта";
    const counterEdges = shift ? [] : [
      makeCounterEdge(boardNode, "flight", "Налёт СНЭ / ППР", true, pprCondition),
      ...landingKeys.map((key) => makeCounterEdge(boardNode, key, "Посадки СНЭ / ППР", true, pprCondition)),
      makeCounterEdge(boardNode, "arresterHooks", "Зацепы в формуляре", true),
      ...blocks.flatMap((block) => {
        const installed = blockInstalledOn(block, todayIso());
        const minutes = block.kind === "engine" ? "engineMinutes" : "flight";
        const condition = block.kind === "engine"
          ? `Налёт двигателя берётся из записи работы, по умолчанию из налёта борта. Доля и округление земли задаются в формуляре двигателя. ${pprCondition}.`
          : pprCondition;
        const keys = block.kind === "engine" ? Object.keys(ENGINE_SOURCES).filter((key) => key !== "engineMinutes") : [];
        return [
          makeCounterEdge(block.id, minutes, "Наработка СНЭ / ППР", installed, condition),
          ...landingKeys.map((key) => makeCounterEdge(block.id, key, "Посадки СНЭ / ППР", installed, pprCondition)),
          ...keys.map((key) => makeCounterEdge(block.id, key, `${ENGINE_SOURCES[key]} · СНЭ / ППР`, installed, pprCondition)),
        ];
      }),
    ];
    const edges = [...resourceEdges, ...counterEdges];
    const sourceLabels = new Map(usageSources(aircraft, { kind: "engine" }).map((source) => [source.key, calculationSourceLabel(source)]));
    for (const [key, label] of Object.entries(shift?.sourceLabels || {})) sourceLabels.set(key, label);
    for (const entry of shift?.accruals || []) {
      for (const [key, label] of Object.entries(entry.labels || {})) sourceLabels.set(key, label);
    }
    const sourceKeys = [...new Set([...(shift ? [] : usageSources(aircraft).filter(({ key }) => sourceEnabled(aircraft, key)).map(({ key }) => key)),
      ...edges.map(({ key }) => key)])];
    const node = (block) => {
      const connected = resourceEdges.some(({ target, enabled, installed, installedDate }) =>
        target === block.id && enabled && installed && (!installedDate || installedDate <= todayIso()));
      const number = block.serialNumber || resourceOwnerNumber(block);
      return `<div class="map-node ${connected ? "map-node--linked" : "map-node--unlinked"}" data-map-target="${escapeHtml(block.id)}">
        <button type="button" class="map-node-caption" data-map-select="${escapeHtml(block.id)}"><strong>${escapeHtml(block.name)}</strong><small>${escapeHtml(number || "Номер не указан")}</small></button>
        <div class="map-node-tools">${block.formId ? `<button type="button" data-block-id="${escapeHtml(block.formId)}" aria-label="Открыть формуляр">↗</button>` : ""}
        ${shift ? "" : `<button type="button" data-map-grip aria-label="Переместить блок">⠿</button>`}</div>
      </div>`;
    };
    function resourceOwnerNumber(block) {
      return resources.find((resource) => resourceOwner(aircraft, resource)?.id === block.id && resource.serialNumber)?.serialNumber;
    }
    const nodes = [{ id: boardNode, name: `${aircraft.type} · борт ${aircraft.boardNumber}`, formId: first?.id, serialNumber: aircraft.serialNumber },
      ...blocks.map((block) => ({ ...block, formId: block.id }))];
    for (const entry of shift?.accruals || []) {
      if (entry.blockId && !nodes.some((item) => item.id === entry.blockId)) nodes.push({ id: entry.blockId, name: entry.object });
    }
    app.innerHTML = shell(`
      <section class="section-stack">
        <h1>${shift ? "Карта начислений" : "Карта наработки"}</h1>
        ${shift ? `<p>${formatDate(shift.date)} · ${escapeHtml(shift.operationLabel || "Лётная смена")}</p>` : ""}
        <label class="map-zoom">Масштаб<input id="map-scale" type="range" min="45" max="150" value="100" step="5"></label>
        <div class="usage-map-scroll">
          <div class="usage-map-canvas">
            <svg class="map-wires" aria-hidden="true"><defs><marker id="map-arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8Z" fill="#728397"/></marker></defs></svg>
            <div class="map-origin">${node(nodes[0])}</div>
            <div class="map-sources">${sourceKeys.map((key) => `<button class="map-node" data-map-source="${escapeHtml(key)}">${escapeHtml(sourceLabels.get(key) || key)}</button>`).join("")}</div>
            <div class="map-targets">${nodes.slice(1).map(node).join("")}</div>
          </div>
        </div>
        <section id="map-details" aria-live="polite"><p>Нажми на показатель или агрегат, чтобы увидеть его связи и множители.</p>
        ${shift ? "" : `<p>Зелёный ореол — настроенный расход ресурса. Пунктир показывает связи со счётчиками или отключённые линии.</p>`}</section>
      </section>`, { title: "Карта наработки", back: true, settings: false });
    const canvas = document.querySelector(".usage-map-canvas");
    const zoom = document.getElementById("map-scale");
    const details = document.getElementById("map-details");
    const wires = canvas.querySelector("svg");
    const targets = new Map([...canvas.querySelectorAll("[data-map-target]")].map((item) => [item.dataset.mapTarget, item]));
    const sources = new Map([...canvas.querySelectorAll("[data-map-source]")].map((item) => [item.dataset.mapSource, item]));
    let active;
    const scale = () => Number(zoom.value) / 100;
    const position = (element, right) => {
      const rect = element.getBoundingClientRect();
      const surface = canvas.getBoundingClientRect();
      return [(rect[right ? "right" : "left"] - surface.left) / scale(), (rect.top + rect.height / 2 - surface.top) / scale()];
    };
    const draw = () => {
      wires.querySelectorAll("line").forEach((line) => line.remove());
      const connect = (from, to, muted, emphasized, counter = false) => {
        const [x1, y1] = position(from, true);
        const [x2, y2] = position(to, false);
        const wire = document.createElementNS("http://www.w3.org/2000/svg", "line");
        for (const [key, value] of Object.entries({ x1, y1, x2, y2 })) wire.setAttribute(key, value);
        wire.setAttribute("class", `map-wire ${counter ? "map-wire--counter" : ""} ${muted ? "map-wire--muted" : ""} ${emphasized ? "map-wire--selected" : ""}`);
        wire.setAttribute("marker-end", "url(#map-arrow)");
        wires.append(wire);
      };
      for (const [key, item] of sources) connect(targets.get(boardNode), item, !shift && !sourceEnabled(aircraft, key), active === key);
      const drawn = new Set();
      for (const edge of edges) {
        if (edge.target === boardNode || !targets.has(edge.target) || !sources.has(edge.key)) continue;
        const pair = JSON.stringify([edge.key, edge.target]);
        if (drawn.has(pair)) continue;
        drawn.add(pair);
        connect(sources.get(edge.key), targets.get(edge.target), !edge.enabled || !edge.installed ||
          Boolean(edge.installedDate && edge.installedDate > todayIso()), active === edge.key || active === edge.target, edge.counter);
      }
    };
    function select(key, isSource) {
      active = key;
      canvas.querySelectorAll(".map-node").forEach((element) => {
        element.classList.toggle("map-node--selected", (element.dataset.mapTarget ?? element.dataset.mapSource) === key);
      });
      const matching = edges.filter((edge) => isSource ? edge.key === key : edge.target === key);
      const heading = isSource ? sourceLabels.get(key) || key : nodes.find((item) => item.id === key)?.name;
      details.innerHTML = `<h2>${escapeHtml(heading || "")}</h2>${matching.length ? `<ul class="accrual-items">${matching.map((edge) => `<li>
        <strong>${escapeHtml(sourceLabels.get(edge.key) || edge.key)} × ${formatNumber(edge.factor)} → ${escapeHtml(nodes.find((item) => item.id === edge.target)?.name || "")} · ${escapeHtml(edge.name)}</strong>
        <small>${shift ? `${formatNumber(edge.input, 6)} × ${formatNumber(edge.factor, 6)} = ${formatNumber(edge.amount, 6)}` :
          `${edge.counter ? "Счётчик формуляра" : "Списание ресурса"} · ${!edge.enabled ? "Источник отключён" :
            !edge.installed ? "Агрегат демонтирован" : edge.target === boardNode ? "Начисляется на борт" : "Агрегат должен быть установлен на дату работы"}
            ${edge.installedDate ? ` · с ${formatDate(edge.installedDate)}` : ""}
            ${edge.condition ? ` · ${escapeHtml(edge.condition)}` : ""}`}</small></li>`).join("")}</ul>`
        : `<p>${isSource ? "Нет получателей." : "Связей нет."}</p>`}`;
      draw();
    }
    sources.forEach((element, key) => element.addEventListener("click", () => select(key, true)));
    targets.forEach((element, key) => {
      element.querySelector("[data-map-select]").addEventListener("click", () => select(key, false));
      const grip = element.querySelector("[data-map-grip]");
      if (!grip) return;
      let start;
      let point = aircraft.mapPositions?.[key] || [0, 0];
      const applyPosition = () => { element.style.translate = `${point[0]}px ${point[1]}px`; draw(); };
      element.style.translate = `${point[0]}px ${point[1]}px`;
      grip.addEventListener("pointerdown", (event) => {
        start = [event.clientX, event.clientY, ...point];
        grip.setPointerCapture(event.pointerId);
      });
      grip.addEventListener("pointermove", (event) => {
        if (!start) return;
        point = [Math.max(-80, Math.min(115, start[2] + (event.clientX - start[0]) / scale())),
          Math.max(-40, Math.min(95, start[3] + (event.clientY - start[1]) / scale()))];
        applyPosition();
      });
      for (const eventName of ["pointerup", "pointercancel"]) grip.addEventListener(eventName, () => {
        if (!start) return;
        start = null;
        aircraft.mapPositions = { ...aircraft.mapPositions, [key]: point };
        if (!saveState()) showToast("Не удалось сохранить положение");
      });
    });
    zoom.addEventListener("input", () => { canvas.style.zoom = scale(); draw(); });
    const scroll = canvas.parentElement;
    let pinch;
    const distance = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    scroll.addEventListener("touchstart", (event) => {
      if (event.touches.length === 2) pinch = { distance: distance(event.touches), scale: Number(zoom.value) };
    }, { passive: true });
    scroll.addEventListener("touchmove", (event) => {
      if (!pinch || !pinch.distance || event.touches.length !== 2) return;
      event.preventDefault();
      zoom.value = String(Math.max(Number(zoom.min), Math.min(Number(zoom.max), pinch.scale * distance(event.touches) / pinch.distance)));
      zoom.dispatchEvent(new Event("input"));
    }, { passive: false });
    for (const event of ["touchend", "touchcancel"]) scroll.addEventListener(event, () => { pinch = null; });
    requestAnimationFrame(draw);
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
    `, { title: "Отчёты", subtitle: `${aircraft.type} · борт ${aircraft.boardNumber}`, back: true, settingsScope: "aircraft" });
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
        ${rows.map((row) => `<button class="history-row" data-report-shift="${escapeHtml(row.id)}"><div><strong>${formatDate(row.date)} · ${escapeHtml(row.operationLabel || "Лётная смена")}</strong><span>${escapeHtml(usageRule("flight").label)} ${calc.formatDuration(row.flightMinutes)} · ${row.actualLandings} посадок</span></div>${icon("chevron")}</button>`).join("")}`;
    }
    output.addEventListener("click", (event) => {
      const row = event.target.closest("[data-report-shift]");
      if (!row) return;
      state.selectedShiftId = row.dataset.reportShift;
      navigateTo("shift-entry");
    });
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
      <section class="info-panel">${icon("plane")}<div><strong>Версия 0.2.35</strong><p>Локальный прототип персонального учёта ресурсов самолёта, двигателей и агрегатов.</p></div></section>
      <section class="info-panel">${icon("shield")}<div><strong>Хранение данных</strong><p>Текущая версия работает без интернета и хранит данные только на устройстве. Защищённый серверный режим ещё не включён.</p></div></section>
      <section class="info-panel">${icon("log")}<div><strong>Назначение сборки</strong><p>Эта версия предназначена для проверки структуры и расчётов и не заменяет утверждённую эксплуатационную документацию.</p></div></section>
    `, { title: "О приложении", subtitle: "Авиаресурс 0.2.35", back: true, settings: false });
  }

  function renderResourceEditor() {
    const aircraft = selectedAircraft();
    const resource = aircraft.resources.find((item) => item.id === state.selectedResourceId);
    const isNew = !resource;
    const draft = resource || {
      object: state.pendingResourceObject || "Новый агрегат",
      objectId: state.pendingResourceOwner,
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
          <label id="resource-owner-choice" hidden>Экземпляр агрегата<select name="ownerId"></select></label>
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
            <label><span>Полный ресурс</span><input name="limit" type="number" min="0" step="any" value="${draft.limit}" required></label>
          </div>
          <label><span>Остаток</span><input name="remaining" type="number" min="0" step="any" value="${draft.remaining}" required></label>
          <label class="checkbox-row"><input type="checkbox" name="priority" ${draft.priority ? "checked" : ""}><span>Показывать первым в начислениях</span></label>
        </fieldset>
        <fieldset id="resource-consumption"><legend>Расход ресурса из записи работы</legend>
          <p>Пустое поле отключает начисление. Множитель переводит показатель в единицы этого ресурса.</p>
          <div id="resource-inputs" class="field-pair"></div>
          <details id="resource-add-source-panel"><summary>Добавить показатель смены</summary>
            <label>Показатель<select id="resource-source-choice"></select></label>
            <label>Или введи название<input id="resource-source-name" type="text" maxlength="80"></label>
            ${sourceDefinitionFields()}
            <button type="button" class="secondary-button" id="resource-source-add">Добавить в смену</button>
          </details>
          ${aircraft.resources.some((item) => item !== resource) ? `<details><summary>Скопировать из другого агрегата</summary>
            <label>Ресурс<select id="resource-copy-from">
              <option value="">Выбрать</option>
              ${aircraft.resources.filter((item) => item !== resource).map((item) =>
                `<option value="${escapeHtml(item.id)}">${escapeHtml(item.object)} · ${escapeHtml(item.name)}</option>`).join("")}
            </select></label>
            <div class="operation-tags">
              <button type="button" class="secondary-button" id="resource-copy-limit">Скопировать лимит</button>
              <button type="button" class="secondary-button" id="resource-copy-inputs">Скопировать расход</button>
            </div>
          </details>` : ""}
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

    const resourceForm = document.getElementById("resource-form");
    const ownerControl = resourceForm.elements.ownerId;
    const currentOwner = () => aircraft.blocks.find((block) => block.id === ownerControl.value);
    const syncOwner = () => {
      const options = aircraft.blocks.filter((block) => block.name === resourceForm.elements.object.value.trim());
      const previous = ownerControl.value || draft.objectId;
      ownerControl.replaceChildren(...options.map((block) => new Option(block.serialNumber || block.name, block.id)));
      if (options.some((block) => block.id === previous)) ownerControl.value = previous;
      ownerControl.closest("label").hidden = options.length < 2;
    };
    syncOwner();
    const inputsRoot = document.getElementById("resource-inputs");
    const sourceChoice = document.getElementById("resource-source-choice");
    const readInputs = () => Object.fromEntries([...inputsRoot.querySelectorAll("input")].filter((input) => input.value !== "")
      .map((input) => [input.dataset.source, Number(input.value)]));
    const drawInputs = (values) => {
      inputsRoot.innerHTML = usageSources(aircraft, currentOwner()).map((source) => {
        const { key } = source;
        return `<label>${escapeHtml(calculationSourceLabel(source))}${sourceEnabled(aircraft, key) ? "" : " · отключён"}
        <input data-source="${key}" type="number" min="0" step="any" value="${values[key] ?? ""}" placeholder="—"></label>`;
      }).join("");
      sourceChoice.replaceChildren(new Option("Новый показатель", ""),
        ...usageSources(aircraft).filter(({ key }) => !sourceEnabled(aircraft, key)).map(({ key, label }) => new Option(label, key)));
      const fieldset = inputsRoot.closest("fieldset");
      fieldset.disabled = fieldset.hidden = resourceForm.elements.unit.value === "дн.";
    };
    let implicitInputs = resource?.consumption ? null : resourceInputs(draft, currentOwner());
    drawInputs(implicitInputs || resource.consumption);
    const refreshInputs = (refreshOwner = false) => {
      const current = readInputs();
      if (refreshOwner) syncOwner();
      if (implicitInputs && JSON.stringify(implicitInputs) === JSON.stringify(current)) {
        implicitInputs = resourceInputs({ unit: resourceForm.elements.unit.value }, currentOwner());
        drawInputs(implicitInputs);
      } else {
        implicitInputs = null;
        drawInputs(current);
      }
    };
    resourceForm.elements.object.addEventListener("change", () => refreshInputs(true));
    ownerControl.addEventListener("change", () => refreshInputs());
    resourceForm.elements.unit.addEventListener("change", () => refreshInputs());
    const sourceName = document.getElementById("resource-source-name");
    const readSource = bindSourceDefinition(document.getElementById("resource-add-source-panel"), sourceName, sourceChoice,
      (label, key) => label ? usageSourceByName(usageSources(aircraft), label) : usageSources(aircraft).find((item) => item.key === key),
      ({ key }) => usageRule(key, aircraft).factor);
    document.getElementById("resource-source-add").addEventListener("click", () => {
      const source = readSource();
      if (source === false) return;
      if (!source) { showToast("Выбери показатель или введи название"); return; }
      const key = source.source?.key;
      if (key && sourceEnabled(aircraft, key)) { showToast("Этот показатель уже включён в форму работы"); return; }
      const previous = [aircraft.enabledUsageSources, aircraft.customUsageSources, aircraft.usageFactors];
      if (key) {
        aircraft.enabledUsageSources = { ...aircraft.enabledUsageSources, [key]: true };
        if (source.factor !== usageRule(key, aircraft).factor) aircraft.usageFactors = { ...aircraft.usageFactors, [key]: source.factor };
      } else aircraft.customUsageSources = [...(aircraft.customUsageSources || []), newUsageSource(source)];
      if (saveState()) {
        drawInputs(readInputs());
        sourceName.value = "";
        delete resourceForm.querySelector("[data-source-factor]").dataset.edited;
        sourceName.dispatchEvent(new Event("input"));
      } else { [aircraft.enabledUsageSources, aircraft.customUsageSources, aircraft.usageFactors] = previous; showToast("Не удалось добавить показатель"); }
    });
    const selectedCopy = () => aircraft.resources.find((item) => item.id === document.getElementById("resource-copy-from")?.value);
    document.getElementById("resource-copy-limit")?.addEventListener("click", () => {
      const source = selectedCopy();
      if (!source) return;
      resourceForm.elements.limit.value = source.limit;
      if (isNew) resourceForm.elements.remaining.value = source.limit;
      resourceForm.elements.unit.value = source.unit;
      resourceForm.elements.resourceType.value = source.resourceType;
      refreshInputs();
    });
    document.getElementById("resource-copy-inputs")?.addEventListener("click", () => {
      const source = selectedCopy();
      if (!source) return;
      if (source.unit !== resourceForm.elements.unit.value) { showToast("Для копирования расхода выбери ту же единицу ресурса"); return; }
      const values = resourceInputs(source, resourceOwner(aircraft, source));
      const allowed = usageSources(aircraft, currentOwner());
      if (Object.keys(values).some((key) => !allowed.some((entry) => entry.key === key))) {
        showToast("У этого агрегата нет одного из источников исходного правила");
        return;
      }
      implicitInputs = null;
      drawInputs(values);
    });
    resourceForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const objectName = String(data.get("object")).trim();
      const name = String(data.get("name")).trim();
      if (!objectName || !name) { showToast("Введи название объекта и ресурса"); return; }
      const orphan = resource?.objectId && !resourceOwner(aircraft, resource) && objectName === resource.object && !currentOwner();
      const limit = Number(data.get("limit"));
      const remaining = Number(data.get("remaining"));
      const saved = normalizeResource({
        ...(resource || {}),
        id: resource?.id || `resource-${Date.now()}`,
        object: objectName,
        objectId: currentOwner()?.id || (orphan ? resource.objectId : null),
        consumption: data.get("unit") === "дн." ? {} : readInputs(),
        priority: data.get("priority") === "on",
        name,
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
      const previous = resource && { ...resource };
      let createdOwner;
      if (!orphan && objectName !== "Самолёт" && !aircraft.blocks.some((block) => block.name === objectName)) {
        const block = normalizeBlock({ id: id(), kind: "unit", name: objectName, caption: "Агрегат с ограниченным ресурсом", status: saved.status });
        aircraft.blocks.push(block);
        saved.objectId = block.id;
        createdOwner = block;
      }
      if (resource) Object.assign(resource, saved);
      else aircraft.resources.push(saved);
      if (!saveState()) {
        if (resource) {
          for (const key of Object.keys(saved)) if (!(key in previous)) delete resource[key];
          Object.assign(resource, previous);
        } else aircraft.resources.pop();
        if (createdOwner) aircraft.blocks.pop();
        showToast("Не удалось сохранить ресурсную карточку");
        return;
      }
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
      const previous = { history: resource.history, limit: resource.limit, remaining: resource.remaining, status: resource.status };
      resource.history = [...(resource.history || []), { ...updated, type: "extension", object: resource.object, unit: resource.unit,
        date: String(data.get("date")), basis, documentNumber, documentDate: String(data.get("documentDate")) }];
      resource.limit = updated.limit;
      resource.remaining = updated.remaining;
      resource.status = resourceStatus(updated.remaining, updated.limit);
      if (!saveState()) { Object.assign(resource, previous); showToast("Не удалось сохранить продление"); return; }
      render();
      showToast("Продление записано");
    });
    document.querySelector('[data-action="delete-resource"]')?.addEventListener("click", () => {
      if (!window.confirm(`Удалить ресурсную карточку «${draft.name}»?`)) return;
      const previous = aircraft.resources;
      aircraft.resources = previous.filter((item) => item.id !== draft.id);
      if (!saveState()) { aircraft.resources = previous; showToast("Не удалось удалить ресурсную карточку"); return; }
      state.selectedResourceId = null;
      navigateBack();
    });
  }

  function renderAircraftTypes() {
    const types = activeAircraftTypes();
    const archived = state.aircraftTypes.filter(isArchivedType);
    app.innerHTML = shell(`
      <h1>Типы самолётов</h1>
      <section class="section-stack type-usage">
        <form id="aircraft-type-form" class="shift-form settings-form">
          <label>Название нового типа<input name="type" type="text" maxlength="80" required></label>
          <button type="submit" class="primary-button">Добавить тип</button>
        </form>
        <section class="settings-list" aria-label="Доступные типы">
          ${types.map((name, index) => `<div class="setting-row"><strong>${escapeHtml(name)}</strong><button class="small-button" type="button" data-archive-type="${index}">В корзину</button></div>`).join("") || "<p>Доступных типов пока нет.</p>"}
        </section>
        <details id="aircraft-type-trash" ${types.length ? "" : "open"}><summary>Корзина (${archived.length})</summary>
          ${archived.map((name, index) => `<div class="setting-row"><strong>${escapeHtml(name)}</strong><button class="small-button" type="button" data-restore-type="${index}">Восстановить</button></div>`).join("") || "<p>Корзина пуста.</p>"}
        </details>
      </section>`, { title: "Типы самолётов", back: true, settings: false });
    document.getElementById("aircraft-type-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const name = event.currentTarget.elements.type.value.trim();
      const key = name.toLowerCase();
      if (!name) { showToast("Введи название типа"); return; }
      if (state.aircraftTypes.some((item) => item.toLowerCase() === key)) {
        showToast(isArchivedType(name) ? "Тип уже в корзине. Его можно восстановить" : "Такой тип уже есть");
        return;
      }
      state.aircraftTypes.push(name);
      state.usageTypeOverrides.push({
        type: key, labels: { flight: USAGE_TYPES.flight, runway: "Посадки" },
        enabled: defaultUsageSources(),
      });
      if (saveState()) render();
      else { state.aircraftTypes.pop(); state.usageTypeOverrides.pop(); showToast("Не удалось сохранить тип"); }
    });
    function changeArchive(name, archivedNow) {
      const previous = state.archivedAircraftTypes;
      const key = name.toLowerCase();
      state.archivedAircraftTypes = archivedNow ? [...previous, key] : previous.filter((item) => item !== key);
      if (saveState()) render();
      else { state.archivedAircraftTypes = previous; showToast("Не удалось обновить корзину"); }
    }
    app.querySelectorAll("[data-archive-type]").forEach((button) => button.addEventListener("click", () => {
      const name = types[Number(button.dataset.archiveType)];
      chooseLayoutAction("Переместить тип в корзину? Существующие борта сохранят его.",
        [["archive", "В корзину"], ["cancel", "Отмена"]], (action) => { if (action === "archive") changeArchive(name, true); });
    }));
    app.querySelectorAll("[data-restore-type]").forEach((button) => button.addEventListener("click", () => {
      changeArchive(archived[Number(button.dataset.restoreType)], false);
    }));
  }

  function renderUsageSettings() {
    const types = activeAircraftTypes();
    const type = types.includes(state.lastUsageType) ? state.lastUsageType : types[0];
    if (!type) {
      leaveUsageSettings = null;
      app.innerHTML = shell(`<h1>Виды наработки</h1>
        <p>Создать тип самолёта для того, чтобы выбрать наработки для этого типа самолёта</p>`,
        { title: "Виды наработки", back: true, settings: false });
      return;
    }
    const aircraft = state.aircraft.find((item) => item.type === type) || { type };
    const profile = usageTypeOverride(aircraft);
    const draft = structuredClone({
      labels: profile?.labels || {},
      factors: profile?.factors || {},
      enabled: profile?.enabled || {},
      customSources: profile?.customSources || [],
    });
    const initial = JSON.stringify(draft);
    const fields = () => [
      ...BOARD_USAGE_TYPES.map((key) => ({ key, label: usageRule(key, aircraft).label })),
      ...draft.customSources,
    ];
    const enabled = (key) => draft.enabled[key] ?? sourceEnabled({ type }, key);
    const options = types.map((name) =>
      `<option value="${escapeHtml(name)}" ${name === type ? "selected" : ""}>${escapeHtml(name)}</option>`).join("");
    app.innerHTML = shell(`
      <h1>Виды наработки</h1>
      <section class="section-stack type-usage">
        <label>Тип самолёта<select id="usage-aircraft-type">${options}</select></label>
        <form id="usage-settings-form" class="shift-form">
          <div id="type-usage-fields" class="section-stack"></div>
          <button type="submit" class="primary-button">Сохранить для типа</button>
        </form>
      </section>`, { title: "Виды наработки", back: true, settings: false });
    const form = document.getElementById("usage-settings-form");
    const collection = document.getElementById("type-usage-fields");
    const currentLabel = ({ key, label }) => draft.labels[key] || label;
    const draftFactor = (item) => draft.factors[item.key] ?? item.factor ?? usageRule(item.key, aircraft).factor;
    let readSource;
    function drawFields() {
      if (!collection) return;
      const current = fields();
      const available = current.filter(({ key }) => !enabled(key));
      collection.innerHTML = current.filter(({ key }) => enabled(key)).map((item) => {
        const { key } = item;
        const factor = draftFactor(item);
        return `<fieldset><legend>${escapeHtml(currentLabel(item))}</legend>
          <div class="field-pair type-usage-pair">
            <label>Название<input name="${key}Label" type="text" value="${escapeHtml(currentLabel(item))}" maxlength="80" required></label>
            <label>Коэффициент<input name="${key}Factor" type="number" min="0" step="any" value="${factor}" required></label>
          </div>
          <p class="field-help">${sourceKind(item) === "time" ? "Время" : "Количество"}</p>
          <small class="field-help">Пример: 1 × ${formatNumber(factor)} = ${formatNumber(factor)}</small>
          <button type="button" class="small-button" data-disable-source="${key}">Убрать показатель</button>
        </fieldset>`;
      }).join("") + `<details id="type-add-source"><summary>Добавить показатель</summary>
          ${available.length ? `<label>Из списка<select name="existingSource"><option value="">Выбрать</option>${available.map((item) =>
            `<option value="${item.key}">${escapeHtml(currentLabel(item))}</option>`).join("")}</select></label>` : ""}
          <label>Или введи название<input name="newSource" type="text" maxlength="80"></label>
          ${sourceDefinitionFields()}
          <button type="button" class="secondary-button" id="type-add-source-button">Добавить показатель</button>
        </details>`;
      readSource = bindSourceDefinition(collection.querySelector("#type-add-source"), form.elements.newSource, form.elements.existingSource,
        (label, key) => label ? usageSourceByName(fields().map((item) => ({ ...item, label: currentLabel(item) })), label) :
          fields().find((item) => item.key === key), draftFactor);
    }
    function readDraft() {
      if (!form) return;
      for (const item of fields().filter(({ key }) => enabled(key))) {
        const { key } = item;
        const label = form.elements.namedItem(`${key}Label`).value.trim();
        const factor = form.elements.namedItem(`${key}Factor`).valueAsNumber;
        if (label !== currentLabel(item)) draft.labels[key] = label;
        if (factor !== draftFactor(item)) draft.factors[key] = factor;
      }
    }
    function save() {
      if (!form.reportValidity()) return false;
      readDraft();
      if (fields().some(({ key }) => enabled(key) && !form.elements.namedItem(`${key}Label`).value.trim())) {
        showToast("Введи название показателя");
        return false;
      }
      if (!addSource()) return false;
      const previous = state.usageTypeOverrides;
      const key = type.toLowerCase();
      state.usageTypeOverrides = [...previous.filter((item) => item.type !== key), { ...profile, ...draft, type: key }];
      if (saveState()) return true;
      state.usageTypeOverrides = previous;
      drawFields();
      showToast("Не удалось сохранить настройки типа");
      return false;
    }
    function afterDraft(next) {
      readDraft();
      const pending = form.elements.newSource.value.trim() || form.elements.existingSource?.value;
      if (!pending && JSON.stringify(draft) === initial) { next(); return; }
      if (app.querySelector("dialog[open]")) return;
      chooseLayoutAction("Сохранить изменения наработки?", [["save", "Сохранить"], ["discard", "Выйти без сохранения"], ["cancel", "Остаться"]], (action) => {
        if (action === "discard" || (action === "save" && save())) next();
      });
    }
    leaveUsageSettings = () => { afterDraft(finishBackNavigation); return true; };
    drawFields();
    document.getElementById("usage-aircraft-type")?.addEventListener("change", (event) => {
      const selected = event.target.value;
      event.target.value = type;
      afterDraft(() => { state.lastUsageType = selected; render(); });
    });
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (save()) { render(); showToast("Настройки типа сохранены"); }
    });
    function addSource(required = false) {
      const source = readSource();
      if (source === false) return false;
      if (!source) {
        if (required) showToast("Выбери показатель или введи название");
        return !required;
      }
      const key = source.source?.key;
      if (key) {
        if (enabled(key)) { showToast("Этот показатель уже включён для выбранного типа"); return false; }
        draft.enabled[key] = true;
        if (source.factor !== draftFactor(source.source)) draft.factors[key] = source.factor;
      } else {
        const custom = newUsageSource(source);
        draft.customSources.push(custom);
        draft.enabled[custom.key] = true;
      }
      form.elements.newSource.value = "";
      if (form.elements.existingSource) form.elements.existingSource.value = "";
      return true;
    }
    collection?.addEventListener("click", (event) => {
      const disable = event.target.closest("[data-disable-source]");
      if (disable) {
        readDraft();
        draft.enabled[disable.dataset.disableSource] = false;
        drawFields();
      } else if (event.target.id === "type-add-source-button") {
        readDraft();
        if (addSource(true)) drawFields();
      }
    });
    collection?.addEventListener("input", (event) => {
      const field = event.target;
      const row = field.closest("fieldset");
      if (!row) return;
      if (field.name.endsWith("Label")) row.querySelector("legend").textContent = field.value;
      if (field.name.endsWith("Factor")) {
        const value = field.valueAsNumber;
        row.querySelector("small").textContent = Number.isFinite(value) && value >= 0 ? `Пример: 1 × ${formatNumber(value)} = ${formatNumber(value)}` : "";
      }
    });
  }

  function renderDiagnostics() {
    app.innerHTML = shell(`
      <h1>Диагностика</h1>
      <p class="field-help">Повтори сбой, затем открой этот экран и скопируй журнал. В нём нет номеров бортов и введённых значений. Хранятся последние 100 событий на устройстве.</p>
      <label>Журнал<textarea id="diagnostic-text" rows="12" readonly></textarea></label>
      <div class="aircraft-actions"><button class="primary-button" id="diagnostic-copy">Скопировать журнал</button>
      <button class="secondary-button" id="diagnostic-clear">Очистить журнал</button></div>
    `, { title: "Диагностика", subtitle: "", back: true, settings: false });
    const output = document.getElementById("diagnostic-text");
    let platform = "Веб-версия";
    try { platform = window.AndroidBridge?.getDiagnosticEnvironment?.() || platform; } catch (_) {}
    const engine = navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? "WebView: версия неизвестна";
    const update = () => {
      let native = [];
      try { native = (window.AndroidBridge?.getTouchDiagnostics?.() || "").split("\n").filter(Boolean); } catch (_) {}
      const events = [...native, ...diagnostics.map(({ at, event, detail }) => `${at} ${event}${detail ? " " + detail : ""}`)];
      events.sort((a, b) => Date.parse(a.split(" ", 1)[0]) - Date.parse(b.split(" ", 1)[0]));
      output.value = [`Авиаресурс ${APP_VERSION} | ${platform} | ${engine}`, ...events].join("\n");
    };
    update();
    document.getElementById("diagnostic-copy").onclick = async () => {
      update();
      try {
        if (window.AndroidBridge?.copyDiagnostics) {
          window.AndroidBridge.copyDiagnostics(output.value);
        } else {
          await navigator.clipboard.writeText(output.value);
        }
        showToast("Журнал скопирован");
      } catch (_) {
        output.focus();
        output.select();
        showToast("Журнал выделен. Скопируй его вручную.");
      }
    };
    document.getElementById("diagnostic-clear").onclick = () => {
      diagnostics = [];
      try { localStorage.removeItem(DIAGNOSTIC_KEY); } catch (_) {}
      try { window.AndroidBridge?.clearTouchDiagnostics?.(); } catch (_) {}
      update();
    };
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
        <button class="setting-row" data-view="usage-settings"><strong>Виды наработки</strong>${icon("chevron")}</button>
        <button class="setting-row" data-view="aircraft-types"><strong>Типы самолётов</strong>${icon("chevron")}</button>
        <button class="setting-row" data-view="diagnostics"><strong>Диагностика</strong>${icon("chevron")}</button>
        <label class="setting-row"><span><strong>Все уведомления</strong><small>Главный переключатель имеет высший приоритет</small></span><input id="global-notifications" type="checkbox" ${state.globalNotifications ? "checked" : ""}></label>
        <div class="settings-subheading">Уведомления по самолётам</div>
        ${aircraftNotificationRows}
        <button class="setting-row" data-action="calendar-settings"><span><strong>Добавить ближайшую работу в календарь</strong><small>Откроется штатный календарь Android для подтверждения</small></span>${icon("chevron")}</button>
        <button class="setting-row" data-action="notification-test"><span><strong>Проверить уведомление Android</strong><small>Запросить разрешение и показать тестовое напоминание</small></span>${icon("bell")}</button>
        <div class="setting-row" aria-disabled="true"><span><strong>Защищённый режим хранения</strong><small>В прототипе не активирован</small></span><span class="prototype-badge">Позже</span></div>
        <button class="setting-row" data-action="about"><span><strong>О приложении</strong><small>Авиаресурс · Android-прототип 0.2.35</small></span>${icon("chevron")}</button>
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
    document.querySelectorAll("[data-board-menu]").forEach((button) => button.addEventListener("click", () => {
      state.selectedAircraftId = button.dataset.boardId;
      navigateTo(button.dataset.boardMenu);
    }));
    document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.view === "usage-map") state.mapShiftId = null;
      navigateTo(button.dataset.view);
    }));
    document.querySelectorAll("[data-aircraft-id]").forEach((button) => button.addEventListener("click", () => {
      recordDiagnostic("board.open");
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
      state.pendingResourceOwner = addResource.dataset.resourceOwner || null;
      state.pendingWork = addResource.dataset.work === "true";
      navigateTo("resource-editor");
    });
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
    document.querySelectorAll("[data-shift-id]").forEach((button) => button.addEventListener("click", () => {
      state.selectedShiftId = button.dataset.shiftId;
      navigateTo("shift-entry");
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
    app.innerHTML = shell(`
      <h1>${title}</h1>
      <form id="creation-form" class="shift-form settings-form">
        ${aircraftForm ? `
          <label>Тип самолёта${aircraftTypeSelect()}</label>
          <p class="field-help">Новый тип можно добавить в общих настройках.</p>
          <label>Бортовой номер<input name="boardNumber" type="text" required></label>
          <label>Заводской номер<input name="serialNumber" type="text"></label>
          <label>RF<input name="rfNumber" type="text" placeholder="Например, 33738"></label>
          <div id="creation-usage"></div>` : `
          <label>Название<input name="name" type="text" required></label>
          <label>Тип карточки<select name="kind"><option value="unit">Агрегат</option><option value="engine">Двигатель</option><option value="airframe">Планер</option></select></label>
          <label>Номер агрегата<input name="serialNumber" type="text"></label>
          <label>Описание<input name="caption" type="text"></label>`}
        <p id="creation-error" role="alert"></p>
        <button class="primary-button" type="submit">${title}</button>
      </form>`, { title, back: true, settings: false });
    const form = document.getElementById("creation-form");
    const usage = aircraftForm ? bindCreationUsage(form) : null;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = Object.fromEntries([...new FormData(event.currentTarget)].map(([key, value]) => [key, value.trim()]));
      if (aircraftForm ? !activeAircraftTypes().includes(data.type) || !data.boardNumber : !data.name) {
        document.getElementById("creation-error").textContent = "Заполни обязательные поля.";
        return;
      }
      if (aircraftForm) createAircraft({ ...data, ...usage.read() });
      else createBlock(data);
    });
  }

  function bindCreationUsage(form) {
    const root = document.getElementById("creation-usage");
    const drafts = new Map();
    let readSource;
    const current = () => {
      const { value: type } = form.elements.type;
      if (!drafts.has(type)) drafts.set(type, { type, enabledUsageSources: {}, customUsageSources: [], usageFactors: {} });
      return drafts.get(type);
    };
    function draw() {
      const draft = current();
      if (!draft.type) { root.innerHTML = ""; return; }
      const sources = usageSources(draft);
      const available = sources.filter(({ key }) => !sourceEnabled(draft, key));
      root.innerHTML = `<fieldset><legend>Виды наработки этого борта</legend>
        ${sources.filter(({ key }) => sourceEnabled(draft, key)).map(({ key, label }) => `
          <div class="setting-row"><strong>${escapeHtml(label)}</strong><button type="button" class="small-button" data-creation-hide-source="${key}">Убрать</button></div>`).join("")}
        <details ${available.length === sources.length ? "open" : ""}><summary>Добавить показатель</summary>
          ${available.length ? `<label>Из списка<select name="existingSource"><option value="">Выбрать</option>${available.map(({ key, label }) =>
            `<option value="${key}">${escapeHtml(label)}</option>`).join("")}</select></label>` : ""}
          <label>Или введи название<input name="newSource" type="text" maxlength="80"></label>
          ${sourceDefinitionFields()}
          <button type="button" class="secondary-button" id="creation-add-source">Добавить показатель</button>
        </details></fieldset>`;
      readSource = bindSourceDefinition(root.querySelector("details"), form.elements.newSource, form.elements.existingSource,
        (label, key) => label ? usageSourceByName(usageSources(draft), label) : usageSources(draft).find((item) => item.key === key),
        ({ key }) => usageRule(key, draft).factor);
    }
    form.elements.type.addEventListener("change", draw);
    root.addEventListener("click", (event) => {
      const draft = current();
      const hide = event.target.closest("[data-creation-hide-source]");
      if (hide) {
        draft.enabledUsageSources[hide.dataset.creationHideSource] = false;
        draw();
        return;
      }
      if (event.target.id !== "creation-add-source") return;
      const source = readSource();
      if (source === false) return;
      if (!source) { showToast("Выбери показатель или введи название"); return; }
      const key = source.source?.key;
      if (key) {
        if (sourceEnabled(draft, key)) { showToast("Этот показатель уже включён для борта"); return; }
        draft.enabledUsageSources[key] = true;
        if (source.factor !== usageRule(key, draft).factor) draft.usageFactors[key] = source.factor;
      } else {
        draft.customUsageSources.push(newUsageSource(source));
      }
      draw();
    });
    draw();
    return {
      read() {
        const draft = current();
        return { enabledUsageSources: usageSourceOverrides(draft, draft.enabledUsageSources), customUsageSources: draft.customUsageSources, usageFactors: draft.usageFactors };
      },
    };
  }

  function createAircraft({ type, boardNumber, serialNumber, rfNumber, enabledUsageSources, customUsageSources, usageFactors }) {
    const template = state.typeSettings.find((entry) => entry.type.toLowerCase() === type.toLowerCase());
    const sameType = state.aircraft.find((item) => item.type.toLowerCase() === type.toLowerCase());
    const id = `aircraft-${Date.now()}`;
    state.aircraft.push({
      id,
      type: type.trim(),
      boardNumber: boardNumber.trim(),
      enabledUsageSources,
      customUsageSources,
      usageFactors,
      serialNumber: serialNumber || "Не указан",
      rfNumber: (rfNumber || "").replace(/^RF[\s-]*/i, ""),
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

  function createBlock({ name, kind, caption, serialNumber }) {
    const aircraft = selectedAircraft();
    aircraft.blocks.push(normalizeBlock({
      id: `unit-${Date.now()}`,
      kind,
      name: name.trim(),
      serialNumber,
      caption: caption.trim(),
      status: "ok",
      ...(kind === "engine" ? { sneMinutes: 0, starts: 0 } : {}),
    }));
    saveState();
    navigateBack();
    showToast("Блок добавлен");
  }

  function renameBlockById(blockId) {
    const aircraft = selectedAircraft();
    const block = aircraft.blocks.find((item) => item.id === blockId);
    if (!block) return;
    const name = window.prompt("Новое название", block.name);
    if (!name?.trim()) return;
    const before = structuredClone(aircraft);
    updateBlockName(aircraft, block, name.trim());
    if (!saveState()) { Object.assign(aircraft, before); render(); showToast("Не удалось сохранить название"); return; }
    renderAircraftSettings();
    bindCommonActions();
    showToast("Название блока сохранено");
  }

  function updateBlockName(aircraft, block, name) {
    const linked = aircraft.resources.filter((resource) => resourceOwner(aircraft, resource) === block);
    block.name = name;
    for (const resource of linked) {
      resource.objectId = block.id;
      resource.object = name;
    }
  }

  function removeBlock(blockId) {
    const aircraft = selectedAircraft();
    const block = aircraft.blocks.find((item) => item.id === blockId);
    if (!block || !window.confirm(`Удалить блок «${block.name}»? История самолёта и смены останутся.`)) return;
    const before = structuredClone(aircraft);
    updateBlockName(aircraft, block, block.name);
    aircraft.blocks = aircraft.blocks.filter((item) => item.id !== blockId);
    if (!saveState()) { Object.assign(aircraft, before); render(); showToast("Не удалось удалить блок"); return; }
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
    const { hasSne, hasPpr, ...fields } = block;
    const events = Array.isArray(block.events) ? block.events : [];
    return {
      model: "",
      serialNumber: "",
      drawingNumber: "",
      installed: true,
      ...fields,
      repairs: Math.max(Number(block.repairs) || 0, events.filter((event) => event.type === "repair").length,
        Number(block.pprMinutes > 0 || block.pprLandings > 0)),
      events,
    };
  }

  function todayIso() {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function formatNumber(value, maximumFractionDigits = 2) {
    return new Intl.NumberFormat("ru-RU", { maximumFractionDigits }).format(Number(value));
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
