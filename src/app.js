(function () {
  "use strict";

  const calc = window.AviationCalc;
  const app = document.getElementById("app");
  const STORAGE_KEY = "aviation-resource-prototype-v1";
  const DIAGNOSTIC_KEY = "aviation-resource-diagnostics-v1";
  const APP_VERSION = "0.2.38-exp.35";
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
      if (!["aircraft", "aircraft-layout", "block", "block-layout"].includes(state.view)) return;
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
  const USAGE_INHERITANCE_VERSION = 1;
  const TIME_USAGE_TYPES = new Set(["flight", "ground", "maximum"]);
  const defaultUsageSources = () => Object.fromEntries(BOARD_USAGE_TYPES.map((key) => [key, CORE_USAGE_TYPES.includes(key)]));
  const DEFAULT_OPERATION_TYPES = ["Лётная смена", "Контрольное опробование", "Руление"].map((label, index) => ({ id: String(index), label }));
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
    sources.push(...localWorkSources(aircraft, owner).map((key) => ({ key, label: ENGINE_SOURCES[key] })));
    return sources;
  }

  function templatePositionFor(aircraft, block) {
    return block?.templateSlotId && aircraft.workTemplate?.positions.find((position) => position.id === block.templateSlotId);
  }

  function onlyStarts(fields) {
    return fields.length === 1 && fields[0].role === "starts";
  }

  function localWorkSources(aircraft, owner) {
    const position = templatePositionFor(aircraft, owner);
    if (!position) return owner?.kind === "engine" ? Object.keys(ENGINE_SOURCES) : [];
    const roles = new Set(aircraftTemplates.positionCounters(aircraft.workTemplate, position).map((field) => field.role));
    return Object.keys(ENGINE_SOURCES)
      .filter((key) => roles.has({ engineMinutes: "total", maximum: "combined" }[key] || key));
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

  function keepBuiltInKind(control, source) {
    const expected = sourceKind(source);
    if (control.value === expected) return;
    control.value = expected;
    showToast(expected === "time"
      ? "У показателя задан идентификатор подсчёта времени. Его нельзя считать в штуках."
      : "У показателя задан идентификатор подсчёта количества. Его нельзя использовать для учёта времени.");
  }

  function usageKindOptions(selected) {
    return [["count", "Количество"], ["time", "Время"]].map(([value, name]) =>
      `<option value="${value}" ${value === selected ? "selected" : ""}>${name}</option>`).join("");
  }

  function durationOptions(selected) {
    return [["hours", "Часы и минуты"], ["seconds", "Минуты и секунды"]].map(([value, name]) =>
      `<option value="${value}" ${value === selected ? "selected" : ""}>${name}</option>`).join("");
  }

  function sourceDefinitionFields(nameInput, choice = "") {
    return `<div class="usage-source-grid source-definition">
      ${choice}
      ${nameInput}
      <label class="usage-coefficient">Коэффициент<input data-source-factor type="number" min="0" step="any" value="1" required></label>
      <label>Категория<select data-source-kind>${usageKindOptions("count")}</select></label>
      <label data-duration-format hidden>Формат ввода<select>${durationOptions("hours")}</select></label>
      <small class="field-help usage-example" data-source-example></small>
    </div>`;
  }

  function bindSourceDefinition(root, name, choice, resolve, getFactor) {
    const kind = root.querySelector("[data-source-kind]");
    const factor = root.querySelector("[data-source-factor]");
    const format = root.querySelector("[data-duration-format]");
    const example = root.querySelector("[data-source-example]");
    const readSelection = () => ({
      label: name.value.trim(),
      source: resolve(name.value.trim(), choice?.value),
    });
    const toggleFormat = () => { format.hidden = kind.value !== "time" || Boolean(readSelection().source); };
    const updateExample = () => { example.textContent = usageFactorExample(factor.valueAsNumber); };
    const update = () => {
      const { source } = readSelection();
      kind.disabled = Boolean(source?.key.startsWith("custom-"));
      if (source) kind.value = sourceKind(source);
      if (!factor.dataset.edited) factor.value = source ? getFactor(source) : 1;
      toggleFormat();
      updateExample();
    };
    name.addEventListener("input", update);
    choice?.addEventListener("change", update);
    kind.addEventListener("change", () => {
      const { source } = readSelection();
      if (source && !source.key.startsWith("custom-")) keepBuiltInKind(kind, source);
      toggleFormat();
    });
    factor.addEventListener("input", () => { factor.dataset.edited = "true"; updateExample(); });
    update();
    return () => {
      const { label, source } = readSelection();
      if (!label && !source) return null;
      if (factor.dataset.edited && !factor.reportValidity()) return false;
      const value = factor.dataset.edited ? factor.valueAsNumber : source ? getFactor(source) : 1;
      return { label, source, factor: value, kind: source ? sourceKind(source) : kind.value, format: format.querySelector("select").value };
    };
  }

  function usageFactorExample(value) {
    return Number.isFinite(value) && value >= 0 ? `Пример: 1 × ${formatNumber(value, 6)} = ${formatNumber(value, 6)}` : "";
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

  const AGGREGATE_UNITS = aircraftTemplates.aggregateUnits;
  function cellOptions(current) {
    const groups = [
      ["Количество", {"шт.": "Штуки", "пос.": "Посадки", "зап.": "Запуски", "сраб.": "Срабатывания"}],
      ["Длительность", {"ч": "Часы", "мин": "Минуты", "с": "Секунды"}],
      ["Календарь", {"дата": "Дата", "дн.": "Период в днях"}],
      ["Текст", {"текст": "Текстовая запись"}],
    ];
    return groups.map(([label, options]) => `<optgroup label="${label}">${Object.entries(options).map(([unit, name]) =>
      `<option value="${unit}"${unit === current ? " selected" : ""}>${name}</option>`).join("")}</optgroup>`).join("");
  }
  const classicEngineUnits = { engineMinutes: "ч", starts: "зап.", maximum: "с", afterburner: "с", or: "с", combat: "с", combined: "с" };
  const classicEngineValues = (usage) => {
    const values = { engineMinutes: usage.minutes / 60, starts: usage.starts, maximum: usage.maximumSeconds,
      afterburner: usage.afterburnerSeconds, ...usage.modes };
    return usage.reported ? Object.fromEntries(usage.reported.map(key => [key, values[key]])) : values;
  };
  const manualCounterName = (counter) => `aggregate-input:${counter.id}`;
  const aggregateRuleInputs = ({ source, factor, sourceLabel, additionalInputs }) =>
    [{ source, factor, sourceLabel }, ...(additionalInputs || [])];

  function aggregateUsageSources(aircraft, includeDisabled = false, owner) {
    const sources = [{ key: "manual", label: "Новое поле ввода в записи о работе" }];
    for (const source of usageSources(aircraft).filter(({ key }) => includeDisabled || sourceEnabled(aircraft, key))) {
      const unit = sourceKind(source) === "time" ? "ч" : source.key.startsWith("custom-") ? "шт." : "пос.";
      sources.push({ key: `board:${source.key}`, label: `Самолёт · ${usageRule(source.key, aircraft).label} (${unit})`, unit });
    }
    if (aircraft.workTemplate) {
      const { positions, engineCounters, rules } = aircraft.workTemplate;
      for (const position of positions.filter((item) => item.kind === "engine")) {
        for (const field of engineCounters.filter((item) => rules.some((rule) => rule.target === item.id))) {
          const unit = field.type === "count" ? (field.role === "starts" ? "зап." : "шт.") : field.format === "HH:MM:SS" ? "с" : "ч";
          sources.push({ key: `position:${position.id}:${field.id}`, label: `${position.label} · ${field.label} (${unit})`, unit });
        }
      }
    } else {
      for (const block of aircraft.blocks.filter((item) => item.kind === "engine")) {
        for (const [key, unit] of Object.entries(classicEngineUnits)) {
          sources.push({ key: `engine:${block.id}:${key}`, label: `${block.name} · ${ENGINE_SOURCES[key]}`, unit });
        }
      }
    }
    for (const field of owner?.usageCounters || []) {
      if (field.fieldKey && field.source === "manual") sources.push({
        key: "local:" + field.fieldKey, unit: field.unit, label: `Запись о работе · ${owner.name} · ${field.name}`,
      });
    }
    sources.push({ key: "work:landings", label: "Сумма посадок за работу", unit: "пос." }, { key: "work:date", label: "Дата записи о работе", unit: "дата" },
      { key: "work:type", label: "Название вида работы", unit: "текст" });
    if (aircraft.workTemplate) sources.push(...aircraftTemplates.rawSourceList(aircraft.workTemplate)
      .filter(item => !aircraft.workTemplate.inputs.some(f => item.key === `raw:board:${f.id}` && f.role && !sourceEnabled(aircraft, f.role))));
    return sources;
  }

  function aggregateRuleFields() {
    return `<p class="field-help">Выбери поле записи о работе или создай новое поле ввода для этого формуляра.</p>
      <div class="section-stack" data-aggregate-rules></div>
      <button type="button" class="secondary-button" data-aggregate-rule-add>Добавить показатель</button>
      <div data-aggregate-rule-copy hidden></div>`;
  }

  function aggregateRuleIdentity(rule) {
    const inputs = aggregateRuleInputs(rule).map(({ source, factor }) => [source, factor]);
    inputs.sort(([left], [right]) => left.localeCompare(right));
    return JSON.stringify([rule.name.trim().toLocaleLowerCase("ru-RU"), rule.unit, rule.workMode || "", inputs, rule.formula || null, rule.workTypeId || ""]);
  }

  function bindAggregateRules(root, aircraft, block) {
    const sources = aggregateUsageSources(aircraft, false, block);
    const list = root.querySelector("[data-aggregate-rules]");
    const recorded = new Set(block ? aircraft.shifts.flatMap((shift) => (shift.aggregateAccruals || [])
      .filter((entry) => entry.blockId === block.id && (entry.amount !== 0 || entry.workMode)).map((entry) => entry.counterId)) : []);
    for (const event of [...(block?.events || []), ...Object.values(block?.historicalRepairs || {})]) {
      for (const rule of event.beforeRepair?.aggregate || []) {
        if (rule.sne || rule.ppr) recorded.add(rule.id);
      }
    }
    const savedRules = new Map((block?.usageCounters || []).map((rule) => [rule.id, rule]));
    const sourceLabels = new Map();
    const editors = new WeakMap();
    function formulaCatalog() {
      const rows = [...list.children].map(row => ({ id: row.dataset.columnKey,
        name: row.querySelector("[data-rule=name]").value || "Новая графа", unit: row.querySelector("[data-rule=unit]").value }));
      return formulas.catalog(rows, sources);
    }
    function readFields(row) {
      const standard = Object.fromEntries([...row.querySelectorAll("[data-rule]")].map((input) =>
        [input.dataset.rule, input.type === "number" ? input.valueAsNumber : input.value.trim()]));
      const additionalInputs = [...row.querySelectorAll("[data-rule-input]")].map((part) => ({
        source: part.querySelector("[data-additional-source]").value,
        factor: part.querySelector("[data-additional-factor]").valueAsNumber,
      }));
      if (row.dataset.boardCounter) standard.boardCounter = row.dataset.boardCounter;
      if (standard.source === "formula") return { ...standard, factor: 1, formula: editors.get(row).expression };
      return { ...standard, ...(additionalInputs.length && { additionalInputs }) };
    }
    function unitLocked(ruleId) {
      const totals = block?.usageTotals?.[ruleId];
      return !savedRules.get(ruleId)?.boardCounter && (recorded.has(ruleId) || Boolean(totals?.sne || totals?.ppr));
    }
    function add(rule = { id: id(), name: "", source: "manual", unit: "шт.", factor: 1, workMode: "entry" }) {
      const row = document.createElement("fieldset");
      row.className = "form-grid";
      row.dataset.ruleId = rule.id;
      if (rule.boardCounter) row.dataset.boardCounter = rule.boardCounter;
      row.dataset.columnKey = formulas.columnKey(rule);
      if (rule.workMode) row.dataset.fieldKey = rule.fieldKey || id();
      sourceLabels.set(rule.id, new Map(aggregateRuleInputs(rule).map(({ source, sourceLabel }) => [source, sourceLabel])));
      function sourceOptions({ source, sourceLabel }) {
        const allowed = rule.workMode ? [...sources, { key: "formula", label: "Формула из граф" }] : sources.filter(item => !item.key.startsWith("raw:") && !item.key.startsWith("work:") && item.unit !== "текст");
        const choices = allowed.some(({ key }) => key === source) ? allowed :
          [...allowed, { key: source, label: `${sourceLabel || "Исходный показатель"} · недоступен` }];
        return choices.map(({ key, label }) => `<option value="${escapeHtml(key)}"${key === source ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
      }
      row.innerHTML = `
        <label class="form-span">Показатель<input data-rule="name" type="text" maxlength="80" required value="${escapeHtml(rule.name)}" placeholder="Например, циклы"></label>
        <label>${rule.workMode ? "Тип ячейки и единица" : "Единица итога"}<select data-rule="unit"${unitLocked(rule.id) ? " disabled" : ""}>${rule.workMode ? cellOptions(rule.unit) : AGGREGATE_UNITS.map(unit => `<option${unit === rule.unit ? " selected" : ""}>${unit}</option>`).join("")}</select></label>
        ${rule.workMode ? `<label>Запись в формуляр<select data-rule="workMode">
          <option value="entry" ${rule.workMode === "entry" ? "selected" : ""}>Значение за работу</option>
          <option value="total" ${rule.workMode === "total" ? "selected" : ""}>Прибавлять к наработке</option></select></label>` : ""}
        <label>Из каких работ брать данные<select data-rule="workTypeId"><option value="">Любая работа</option>${(aircraft.operationTypes || DEFAULT_OPERATION_TYPES).map(item =>
          `<option value="${escapeHtml(item.id)}"${item.id === rule.workTypeId ? " selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select></label>
        <label class="form-span">Откуда брать значение<select data-rule="source">${sourceOptions(rule)}</select></label>
        ${rule.workMode ? '<section class="form-span formula-editor" data-formula hidden></section>' : ""}
        <label>Коэффициент<input data-rule="factor" type="number" min="0" max="1000000" step="any" value="${rule.factor}" required></label>
        <div class="form-span section-stack" data-rule-inputs hidden></div>
        <button type="button" class="small-button" data-rule-add-input>Добавить источник</button>
        <label>Текущее СНЭ<input data-rule="sne" type="number" min="0" max="1000000000" step="any" value="${block?.usageTotals?.[rule.id]?.sne ?? 0}" required></label>
        ${block?.repairs ? `<label>Текущее ППР<input data-rule="ppr" type="number" min="0" max="1000000000" step="any" value="${block.usageTotals?.[rule.id]?.ppr ?? 0}" required></label>` : ""}
        <p class="form-span field-help" data-rule-example></p>
        ${unitLocked(rule.id) ? '<p class="form-span field-help">По показателю уже есть наработка. Для другой единицы добавь новый показатель.</p>' : ""}
        <button type="button" class="small-button danger-button" data-rule-remove>Убрать показатель</button>`;
      const factor = row.querySelector('[data-rule="factor"]');
      const unit = row.querySelector('[data-rule="unit"]');
      const additional = row.querySelector("[data-rule-inputs]");
      const panel = row.querySelector("[data-formula]");
      if (panel) {
        const editor = attachFormulaEditor(panel, rule.formula, formulaCatalog, "cell:" + row.dataset.columnKey, () => unit.value, escapeHtml);
        editors.set(row, editor);
      }
      function updateExample() {
        const picker = row.querySelector("[data-rule=source]");
        const isText = unit.value === "текст";
        const mode = row.querySelector("[data-rule=workMode]");
        if (mode) {
          mode.disabled = Boolean(rule.boardCounter) || isText || unit.value === "дата";
          if (mode.disabled) mode.value = "entry";
          for (const option of picker.options) {
            const source = sources.find(item => item.key === option.value);
            option.disabled = option.value !== "manual" && (isText ? source?.unit !== "текст" : source?.unit === "текст");
          }
          if (picker.selectedOptions[0]?.disabled) picker.value = "manual";
          if (isText) {
            factor.value = "1";
            additional.replaceChildren();
            for (const input of row.querySelectorAll("[data-rule=sne], [data-rule=ppr]")) input.closest("label").hidden = true;
          }
        }
        const isFormula = picker.value === "formula";
        if (panel) {
          panel.hidden = !isFormula;
          factor.closest("label").hidden = isFormula || isText;
          row.querySelector("[data-rule-add-input]").hidden = isFormula || isText;
          additional.hidden = isFormula || isText || !additional.children.length;
          row.querySelector("[data-rule-example]").hidden = isFormula || isText;
          if (isFormula) { editors.get(row).refresh(); return; }
          if (isText) return;
        }
        const factors = [factor, ...additional.querySelectorAll("[data-additional-factor]")];
        const settings = readFields(row);
        const hint = row.querySelector("[data-rule-example]");
        try {
          if (unit.value === "дата" && (settings.workMode !== "entry" || factors.length !== 1 || settings.factor !== 1))
            throw new Error("Дату можно только записать без коэффициента.");
          let total = 0;
          const terms = aggregateRuleInputs(settings).map(part => {
            const source = sources.find(item => item.key === part.source);
            const from = source?.unit || unit.value;
            const scale = settings.workMode ? aircraftTemplates.unitScale(from, unit.value) : 1;
            total += 2 * scale * part.factor;
            return `2 ${from} × ${formatNumber(part.factor, 6)}`;
          });
          hint.textContent = unit.value === "дата" ? "Дата записи переносится в графу без изменений." :
            `Пример: ${terms.join(" + ")} → ${formatNumber(total, 6)} ${unit.value}`;
        } catch (error) { hint.textContent = error.message; }
      }
      function addInput(input) {
        const part = document.createElement("div");
        part.className = "form-grid";
        part.dataset.ruleInput = "";
        part.innerHTML = `<label class="form-span">Источник<select data-additional-source>${sourceOptions(input)}</select></label>
          <label>Коэффициент<input data-additional-factor type="number" min="0" max="1000000" step="any" value="${input.factor}" required></label>
          <button type="button" class="small-button" data-remove-input>Убрать источник</button>`;
        part.querySelector("[data-additional-source]").addEventListener("change", updateExample);
        part.querySelector("[data-additional-factor]").addEventListener("input", updateExample);
        part.querySelector("[data-remove-input]").onclick = () => {
          part.remove();
          additional.hidden = !additional.children.length;
          updateExample();
        };
        additional.append(part);
        additional.hidden = false;
        updateExample();
      }
      for (const input of rule.additionalInputs || []) addInput(input);
      row.querySelector("[data-rule-add-input]").onclick = () => {
        const selected = new Set(aggregateRuleInputs(readFields(row)).map(({ source }) => source));
        const next = sources.find(({ key, unit }) => unit !== "текст" && !selected.has(key) && (rule.workMode || (!key.startsWith("raw:") && !key.startsWith("work:"))));
        if (next) addInput({ source: next.key, factor: 1 });
        else showToast("Все доступные источники уже добавлены");
      };
      row.querySelector('[data-rule="source"]').addEventListener("change", (event) => {
        const source = sources.find(({ key }) => key === event.target.value);
        if (!rule.boardCounter && source?.unit && !unit.disabled && (!rule.name || rule.workMode)) unit.value = source.unit;
        updateExample();
      });
      factor.addEventListener("input", updateExample);
      unit.addEventListener("change", syncMode);
      updateExample();
      row.querySelector("[data-rule-remove]").onclick = () => row.remove();
      function syncMode() {
        updateExample();
        const entryOnly = row.querySelector("[data-rule=workMode]")?.value === "entry";
        for (const control of row.querySelectorAll("[data-rule=sne], [data-rule=ppr]")) control.closest("label").hidden = entryOnly;
      }
      row.querySelector("[data-rule=workMode]")?.addEventListener("change", syncMode);
      syncMode();
      list.append(row);
    }
    for (const rule of block?.usageCounters || []) add(rule);
    function refreshFormulas() {
      for (const row of list.children) if (row.querySelector("[data-rule=source]").value === "formula") editors.get(row)?.refresh();
    }
    refreshFormulas();
    list.addEventListener("input", event => {
      if (event.target.matches("[data-rule=name], [data-rule=unit]")) refreshFormulas();
    });
    list.addEventListener("click", event => { if (event.target.closest("[data-rule-remove]")) refreshFormulas(); });
    root.querySelector("[data-aggregate-rule-add]").onclick = () => add();
    const candidates = aircraft.blocks.filter((item) => item !== block && item.usageCounters?.length);
    if (candidates.length) {
      const copy = root.querySelector("[data-aggregate-rule-copy]");
      copy.hidden = false;
      copy.innerHTML = `<details class="form-details"><summary>Скопировать показатели</summary>
        <label>Из другого формуляра<select data-aggregate-copy-source><option value="">Выбрать</option>${candidates.map((item) =>
          `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}${item.serialNumber ? ` · № ${escapeHtml(item.serialNumber)}` : ""}</option>`).join("")}</select></label>
        <button type="button" class="small-button" data-aggregate-copy-apply disabled>Скопировать настройки</button>
        <small class="field-help" data-aggregate-copy-result role="status"></small>
      </details>`;
      const select = copy.querySelector("[data-aggregate-copy-source]");
      const button = copy.querySelector("[data-aggregate-copy-apply]");
      const result = copy.querySelector("[data-aggregate-copy-result]");
      select.onchange = () => { button.disabled = !select.value; result.textContent = ""; };
      button.onclick = () => {
        const source = candidates.find(({ id }) => id === select.value);
        if (!source) return;
        const existing = new Map([...list.children].map(row => [aggregateRuleIdentity(readFields(row)), row.dataset.columnKey]));
        const remap = new Map(source.usageCounters.map(rule => [formulas.refKey(rule), existing.get(aggregateRuleIdentity(rule)) || id()]));
        const present = new Set(existing.keys());
        let copied = 0;
        for (const rule of source.usageCounters) {
          const key = aggregateRuleIdentity(rule);
          if (present.has(key)) continue;
          const clone = structuredClone(rule);
          if (clone.formula) for (const token of clone.formula.tokens) {
            if (remap.has(token?.ref)) token.ref = "cell:" + remap.get(token.ref);
          }
          delete clone.boardCounter;
          add({ ...clone, id: id(), columnKey: remap.get(formulas.refKey(rule)) });
          present.add(key);
          copied += 1;
        }
        refreshFormulas();
        result.textContent = copied ? `Скопировано показателей: ${copied}. Начальные показания: 0.` : "Эти показатели уже есть в форме.";
      };
    }
    const draft = () => [...list.children].map((row) => [row.dataset.ruleId, JSON.stringify(editors.get(row)?.expression),
      ...[...row.querySelectorAll("[data-rule], [data-additional-source], [data-additional-factor]")].map((input) => [input.value, input.validity.badInput])]);
    function read() {
      const rows = [...list.children].map((row) => {
      const values = readFields(row);
      if (!values.name) throw new Error("Укажи название показателя");
      if (row.querySelector("input[type=number]:invalid")) throw new Error("Проверь коэффициент и начальные показания");
      const inputs = aggregateRuleInputs(values);
      if (new Set(inputs.map(({ source }) => source)).size !== inputs.length) throw new Error(`У показателя «${values.name}» источник указан дважды`);
      function named(input) {
        const label = sources.find(({ key }) => key === input.source)?.label || sourceLabels.get(row.dataset.ruleId)?.get(input.source);
        return { source: input.source, factor: input.factor, sourceLabel: label || "Исходный показатель" };
      }
      const previous = savedRules.get(row.dataset.ruleId);
      if (values.boardCounter) {
        aircraftTemplates.unitScale(values.unit, aircraftTemplates.boardCards[values.boardCounter].unit);
        if (values.workMode !== "entry") throw new Error("Для счётчика укажи начисление за работу");
      }
      if (values.source === "formula") {
        if (previous && unitLocked(row.dataset.ruleId) && (values.unit !== previous.unit || values.workMode !== previous.workMode))
          throw new Error("У накопленных данных нельзя менять единицу и назначение");
        return { id: row.dataset.ruleId, columnKey: row.dataset.columnKey, ...values, sourceLabel: "Формула из граф" };
      }
      if (values.workMode) {
        if (["дата", "текст"].includes(values.unit) && (values.workMode !== "entry" || inputs.length !== 1 || values.factor !== 1))
          throw new Error("Дата или текст записываются за работу из одного источника без коэффициента");
        for (const input of inputs) {
          if (input.source.startsWith("local:")) {
            const ownerRow = [...list.children].find(other => other.dataset.fieldKey === input.source.slice(6));
            if (!ownerRow || ownerRow === row || readFields(ownerRow).source !== "manual" || readFields(ownerRow).unit !== sources.find(item => item.key === input.source)?.unit)
              throw new Error("Графа ссылается на отсутствующее или изменённое поле ввода");
          }
          const src = sources.find(item => item.key === input.source);
          if (!src) throw new Error(`«${values.name}»: источник недоступен`);
          if (src.unit) aircraftTemplates.unitScale(src.unit, values.unit);
        }
        if (previous && unitLocked(row.dataset.ruleId) && values.workMode !== previous.workMode)
          throw new Error("Для изменения способа накопления создай отдельную графу");
      }
      if (unitLocked(row.dataset.ruleId) && previous?.unit !== values.unit) throw new Error("Единица накопленной наработки закреплена за показателем");
      return { id: row.dataset.ruleId, columnKey: row.dataset.columnKey, ...values, ...(values.workMode && values.source === "manual" && { fieldKey: row.dataset.fieldKey }), sourceLabel: named(inputs[0]).sourceLabel,
        ...(inputs.length > 1 && { additionalInputs: inputs.slice(1).map(named) }) };
      });
      formulas.order(rows, formulas.catalog(rows, sources));
      return rows;
    }
    return { draft, read };
  }

  function storedCounterRules(rows) {
    return rows.map(({ sne, ppr, ...rule }) => rule);
  }

  function initialCounterTotals(rows, previous = {}) {
    return { ...previous, ...Object.fromEntries(rows.filter(row => row.workMode !== "entry").map(({ id, sne, ppr }) => [id, { sne, ppr: ppr ?? null }])) };
  }

  function manualWorkField(rule) {
    const key = escapeHtml(manualCounterName(rule));
    const title = escapeHtml(rule.name);
    if (rule.workMode && rule.unit === "текст") return `<label>${title}<input name="${key}" type="text" maxlength="500"></label>`;
    if (rule.workMode && rule.unit === "дата") return `<label>${title}<input type="date" name="${key}"></label>`;
    if (rule.workMode && rule.unit === "дн.") return `<fieldset><legend>${title}</legend><div class="field-pair">
      <label>С даты<input type="date" name="${key}-start"></label><label>До даты<input type="date" name="${key}-end"></label></div></fieldset>`;
    return `<label>${title} (${escapeHtml(rule.unit)})<input name="${key}" type="number" min="0" max="1000000000" step="any"></label>`;
  }

  function calendarDay(value) {
    return value ? Date.parse(value + "T00:00:00Z") / 86400000 : null;
  }

  function manualWorkValue(rule, data) {
    const key = manualCounterName(rule);
    if (rule.workMode && rule.unit === "текст") return data.get(key)?.trim() || null;
    if (rule.workMode && rule.unit === "дата") return calendarDay(data.get(key));
    if (rule.workMode && rule.unit === "дн.") {
      const from = calendarDay(data.get(key + "-start"));
      const until = calendarDay(data.get(key + "-end"));
      if (from === null && until === null) return null;
      if (from === null || until === null || until < from) throw new Error(`«${rule.name}»: укажи обе даты периода, конец не может быть раньше начала`);
      return until - from;
    }
    return data.get(key);
  }

  function matchesWork(rule, type) {
    return !rule.workTypeId || rule.workTypeId === type;
  }

  function hasManualReading(block, data) {
    return (block?.usageCounters || []).some(rule => matchesWork(rule, data.get("operationType")) &&
      aggregateRuleInputs(rule).some(input => input.source === "manual") &&
      [manualCounterName(rule), manualCounterName(rule) + "-start", manualCounterName(rule) + "-end"].some(key => String(data.get(key) ?? "").trim() !== ""));
  }

  function aggregateManualInputs(aircraft) {
    const rows = aircraft.blocks.flatMap((block) => {
      const manual = (block.usageCounters || []).filter((rule) => aggregateRuleInputs(rule).some(({ source }) => source === "manual"));
      return manual.length ? `<fieldset class="form-grid" data-aggregate-manual-block="${escapeHtml(block.id)}"><legend>${escapeHtml(block.name)}</legend>
        ${manual.map(rule => `<div data-manual-type="${escapeHtml(rule.workTypeId || "")}">${manualWorkField(rule)}</div>`).join("")}
      </fieldset>` : [];
    });
    return rows.length ? `<details class="form-details" data-aggregate-manual><summary>Показания агрегатов</summary>${rows.join("")}</details>` : "";
  }

  function bindAggregateManualInputs(form, aircraft) {
    const section = form.querySelector("[data-aggregate-manual]");
    if (!section) return;
    const groups = [...section.querySelectorAll("[data-aggregate-manual-block]")];
    function sync() {
      for (const group of groups) {
        const block = aircraft.blocks.find((item) => item.id === group.dataset.aggregateManualBlock);
        const type = form.querySelector('[name="operationType"]:checked')?.value;
        for (const field of group.querySelectorAll("[data-manual-type]")) {
          field.hidden = !!field.dataset.manualType && field.dataset.manualType !== type;
          for (const input of field.querySelectorAll("input")) input.disabled = field.hidden;
        }
        group.hidden = group.disabled = !blockInstalledOn(block, form.elements.date.value) || !group.querySelector("[data-manual-type]:not([hidden])");
      }
      section.hidden = groups.every((group) => group.hidden);
    }
    form.addEventListener("input", sync);
    form.elements.date.addEventListener("change", sync);
    form.elements.date.addEventListener("input", sync);
    sync();
  }

  function aggregateAccruals(aircraft, date, sources, workData, engineUsage, templateEngines, boardValues = {}, inactive = new Set()) {
    const values = new Map(Object.entries(sources).map(([key, value]) => [`board:${key}`, value]));
    const units = new Map(aggregateUsageSources(aircraft).map(item => [item.key, item.unit]));
    const landingReadings = OPTIONAL_USAGE_TYPES.filter(key => key !== "arresterHooks" && Object.hasOwn(sources, key));
    if (landingReadings.length) values.set("work:landings", landingReadings.reduce((sum, key) => sum + sources[key], 0));
    values.set("work:date", calendarDay(date));
    values.set("work:type", (aircraft.operationTypes || DEFAULT_OPERATION_TYPES).find(item => item.id === workData.get("operationType"))?.label);
    for (const [key, value] of Object.entries(boardValues)) values.set(`raw:board:${key}`, value);
    if (templateEngines) {
      for (const entry of templateEngines.filter(item => item.blockId)) {
        for (const [key, value] of Object.entries(entry.reportedValues || entry.values)) values.set(`raw:${entry.slotId}:${key}`, value);
      }
      for (const entry of templateEngines.filter(({ blockId }) => blockId)) {
        for (const field of aircraft.workTemplate.engineCounters) {
          const value = entry.counters[field.id];
          if (value != null) values.set(`position:${entry.slotId}:${field.id}`, value / (field.format === "HH:MM" ? 3600 : 1));
        }
      }
    } else {
      for (const [block, usage] of engineUsage) {
        for (const [key, value] of Object.entries(classicEngineValues(usage))) values.set(`engine:${block.id}:${key}`, value);
      }
    }
    return aircraft.blocks.flatMap((block) => {
      if (inactive.has(block.id) || !block.usageCounters?.length || !blockInstalledOn(block, date)) return [];
      const localFields = new Map(block.usageCounters.filter(rule => rule.fieldKey && rule.source === "manual" && matchesWork(rule, workData.get("operationType")))
        .map(rule => ["local:" + rule.fieldKey, rule]));
      const hasFormulas = block.usageCounters.some(rule => rule.source === "formula");
      const catalog = hasFormulas ? formulas.catalog(block.usageCounters, aggregateUsageSources(aircraft, true, block)) : null;
      const ordered = hasFormulas ? formulas.order(block.usageCounters, catalog) : block.usageCounters;
      const results = new Map();
      const resultKeys = new Map(block.usageCounters.map(item => [formulas.refKey(item), aggregateResourceKey(item.id)]));
      function flowKey(source, rule) {
        if (source === "manual") return block.id + ":input:" + rule.id;
        if (localFields.has(source)) return block.id + ":input:" + localFields.get(source).id;
        return resultKeys.get(source) || source;
      }
      return ordered.flatMap((rule) => {
        if (!matchesWork(rule, workData.get("operationType")) || (rule.boardCounter?.startsWith("ppr") && !countsTowardPpr(block, date))) return [];
        if (rule.unit === "текст") {
          const manual = rule.source === "manual" ? rule : localFields.get(rule.source);
          const textValue = manual ? manualWorkValue(manual, workData) : values.get(rule.source);
          if (!textValue) return [];
          return [{ blockId: block.id, blockName: block.name, serialNumber: block.serialNumber, counterId: rule.id,
            name: rule.name, unit: rule.unit, workMode: "entry", flowKey: flowKey(rule.source, rule), sourceKey: rule.source, source: rule.sourceLabel, textValue }];
        }
        if (rule.source === "formula") {
          const read = key => {
            if (key.startsWith("cell:")) return results.get(key);
            if (localFields.has(key)) {
              const raw = manualWorkValue(localFields.get(key), workData);
              return raw == null || raw === "" ? null : Number(raw);
            }
            return values.get(key);
          };
          let result;
          try { result = formulas.calculate(rule.formula, rule.unit, catalog, read); }
          catch (error) { throw new Error(rule.name + ": " + error.message); }
          if (result.amount == null) return [];
          if ((rule.boardCounter || rule.workMode === "total") && result.amount < 0) throw new Error(rule.name + ": отрицательное начисление");
          results.set(formulas.refKey(rule), result.amount);
          return [{ blockId: block.id, blockName: block.name, serialNumber: block.serialNumber, counterId: rule.id,
            unit: rule.unit, name: rule.name, ...result, inputs: result.inputs.map(part => ({ ...part, flowKey: flowKey(part.sourceKey, rule) })), workMode: rule.workMode,
            expression: formulas.describe(rule.formula, catalog), ppr: countsTowardPpr(block, date) }];
        }
        const inputs = aggregateRuleInputs(rule).flatMap(({ source, factor, sourceLabel }) => {
          const local = localFields.get(source);
          const entered = source === "manual" ? manualWorkValue(rule, workData) : local ? manualWorkValue(local, workData) : values.get(source);
          const input = entered == null || entered === "" ? null : Number(entered);
          if (!Number.isFinite(input) || (input < 0 && rule.unit !== "дата")) return [];
          const sourceUnit = local?.unit || units.get(source) || rule.unit;
          const scale = rule.workMode ? aircraftTemplates.unitScale(sourceUnit, rule.unit) : 1;
          const amount = input * scale * factor;
          if (!Number.isFinite(amount)) return [];
          return [{ flowKey: flowKey(source, rule), sourceKey: source, source: sourceLabel, input, factor, amount,
            ...(rule.workMode && { sourceUnit }) }];
        });
        if (!inputs.length) return [];
        const amount = inputs.reduce((sum, item) => sum + item.amount, 0);
        if (!Number.isFinite(amount)) return [];
        results.set(formulas.refKey(rule), amount);
        return [{ blockId: block.id, blockName: block.name, serialNumber: block.serialNumber, counterId: rule.id, name: rule.name, unit: rule.unit,
          ...(rule.additionalInputs?.length ? { inputs } : inputs[0]), amount, ...(rule.workMode && { workMode: rule.workMode }),
          ppr: countsTowardPpr(block, date) }];
      });
    });
  }

  function applyAggregateAccruals(aircraft, entries) {
    for (const entry of entries) {
      if (entry.workMode === "entry") continue;
      const block = aircraft.blocks.find(({ id }) => id === entry.blockId);
      const totals = (block.usageTotals ??= {});
      const previous = totals[entry.counterId] || { sne: 0, ppr: null };
      const next = { sne: previous.sne + entry.amount, ppr: entry.ppr ? (previous.ppr ?? 0) + entry.amount : previous.ppr };
      totals[entry.counterId] = next;
      entry.balances = { sne: [previous.sne, next.sne], ...(entry.ppr && { ppr: [previous.ppr ?? 0, next.ppr] }) };
    }
  }

  function aggregateAccrualSummary(entries) {
    if (!entries?.length) return "";
    return `<details><summary>Наработка агрегатов (${entries.length})</summary><ul class="accrual-items">
      ${entries.map((entry) => `<li><strong>${escapeHtml(entry.blockName)} · ${escapeHtml(entry.name)}</strong>
        ${aggregateAccrualCalculation(entry)}</li>`).join("")}
    </ul></details>`;
  }

  function formValue(amount, unit) {
    if (unit === "текст") return String(amount);
    if (unit === "дата") return formatDate(new Date(amount * 86400000).toISOString().slice(0, 10));
    return formatNumber(amount, 6) + " " + unit;
  }

  function aggregateAccrualCalculation(entry) {
    if (entry.unit === "текст") return `<small>${escapeHtml(entry.textValue)}</small>`;
    if (entry.expression) return `<small>${escapeHtml(entry.expression)} = ${escapeHtml(formValue(entry.amount, entry.unit))}</small>` +
      entry.inputs.map(part => `<small>${escapeHtml(part.source)}: ${part.input == null ? "пусто (0)" : escapeHtml(formValue(part.input, part.sourceUnit))}</small>`).join("");
    if (entry.workMode) {
      return (entry.inputs || [entry]).map(part => `<small>${escapeHtml(part.source || entry.name)} · ${escapeHtml(formValue(part.input, part.sourceUnit || entry.unit))}
        ${entry.unit === "дата" ? "" : ` × ${formatNumber(part.factor, 6)} → ${escapeHtml(formValue(part.amount, entry.unit))}`}</small>`).join("") +
        (entry.inputs ? `<small>Сумма: ${escapeHtml(formValue(entry.amount, entry.unit))}</small>` : "");
    }
    const unit = escapeHtml(entry.unit);
    const parts = (entry.inputs || [entry]).map(({ source, input, factor, amount }) =>
      `<small>${escapeHtml(source)} · ${formatNumber(input, 6)} × ${formatNumber(factor, 6)} = ${formatNumber(amount, 6)} ${unit}</small>`);
    return parts.join("") + (entry.inputs ? `<small>Итого ${formatNumber(entry.amount, 6)} ${unit}</small>` : "");
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
    const typeKeys = new Set([...BOARD_USAGE_TYPES, ...(usageTypeOverride(aircraft)?.customSources || []).map(({ key }) => key)]);
    const hasOverrides = Object.keys(aircraft.enabledUsageSources || {}).some((key) => typeKeys.has(key));
    app.innerHTML = shell(`<form id="board-usage-form" class="shift-form">
      <fieldset><legend>Поля записи работы</legend>
        ${sourceCheckboxes(aircraft)}
        <details id="board-add-source"><summary>Добавить показатель</summary>
          ${sourceDefinitionFields('<label>Название<input name="newSource" type="text" maxlength="80"></label>')}
        </details>
      </fieldset>
      <button class="primary-button">Сохранить показатели</button>
      ${hasOverrides ? `<button type="button" class="secondary-button" id="inherit-type-usage">Использовать набор типа</button>` : ""}
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
    document.getElementById("inherit-type-usage")?.addEventListener("click", () => {
      const previous = aircraft.enabledUsageSources;
      aircraft.enabledUsageSources = Object.fromEntries(Object.entries(previous).filter(([key]) => !typeKeys.has(key)));
      if (saveState()) { render(); showToast("Восстановлен набор показателей типа"); }
      else { aircraft.enabledUsageSources = previous; showToast("Не удалось сохранить показатели"); }
    });
  }

  function resourceOwner(aircraft, resource) {
    if (resource.objectId) return aircraft.blocks.find((block) => block.id === resource.objectId);
    return aircraft.blocks.find((block) => block.name === resource.object);
  }

  function resourceFormOwner(aircraft, resource) {
    return resourceOwner(aircraft, resource) || (!resource.objectId && resource.object === "Самолёт"
      ? aircraft.blocks.find((block) => block.kind === "airframe") : undefined);
  }

  function resourceInputs(resource, owner, aircraft) {
    if (resource.unit === "дн.") return {};
    if (resource.consumption) return resource.consumption;
    const sources = localWorkSources(aircraft, owner);
    if (resource.unit === "ч") {
      if (sources.includes("engineMinutes")) return { engineMinutes: 1 };
      return templatePositionFor(aircraft, owner)?.engineLink ? {} : { flight: 1 };
    }
    if (resource.unit === "зап." && sources.includes("starts")) return { starts: 1 };
    return {};
  }

  const aggregateResourceKey = (id) => `aggregate:${id}`;

  function resourceSources(aircraft, owner) {
    const sources = usageSources(aircraft, owner).map((source) => ({
      ...source, enabled: sourceEnabled(aircraft, source.key),
    }));
    if (!owner?.usageCounters?.length) return sources;
    const available = new Set(aggregateUsageSources(aircraft, false, owner).map(({ key }) => key));
    return [...sources, ...owner.usageCounters.filter(rule => !["дата", "текст"].includes(rule.unit)).map((rule) => ({
      key: aggregateResourceKey(rule.id), label: `Формуляр · ${rule.name} (${rule.unit})`,
      enabled: rule.source === "formula" || aggregateRuleInputs(rule).some(({ source, factor }) => factor > 0 && available.has(source)),
    }))];
  }

  function resourceSourceFactor(aircraft, key, factor) {
    return key.startsWith("custom-") ? factor * usageRule(key, aircraft).factor : factor;
  }

  function blockInstallationOn(block, date) {
    const installations = (block.events || []).filter((entry) => ["install", "dismantle"].includes(entry.type) && entry.date)
      .sort((a, b) => a.date.localeCompare(b.date));
    const latest = installations.filter((entry) => entry.date <= date).at(-1);
    if (latest) return latest.type === "install" ? latest.date : undefined;
    const initiallyInstalled = installations.length ? installations[0].type === "dismantle" : block.installed !== false;
    return initiallyInstalled ? null : undefined;
  }

  function blockInstalledOn(block, date) {
    return blockInstallationOn(block, date) !== undefined;
  }

  function enginePositionOccupied(aircraft, slotId, date, exceptId) {
    return aircraft.blocks.some((block) => block.kind === "engine" && block.id !== exceptId &&
      block.templateSlotId === slotId && blockInstalledOn(block, date));
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

  function resourceAccruals(aircraft, date, sources, engineUsage, aggregateUsage, inactive = new Set()) {
    const aggregateByOwner = new Map();
    for (const entry of aggregateUsage) {
      if (entry.unit === "текст" || entry.unit === "дата") continue;
      if (!aggregateByOwner.has(entry.blockId)) aggregateByOwner.set(entry.blockId, {});
      aggregateByOwner.get(entry.blockId)[aggregateResourceKey(entry.counterId)] = entry.amount;
    }
    return aircraft.resources.flatMap((resource) => {
      const owner = resourceOwner(aircraft, resource);
      if (inactive.has(owner?.id) || (!owner && resource.objectId) || (owner && !blockInstalledOn(owner, date)) ||
        (resource.installed && resource.installed > date)) return [];
      const engine = engineUsage.get(owner);
      const values = { ...sources, ...aggregateByOwner.get(owner?.id) };
      const engineValues = engine ? classicEngineValues(engine) : {};
      Object.assign(values, engineValues);
      const inputs = Object.entries(resourceInputs(resource, owner, aircraft)).map(([key, factor]) => [key, resourceSourceFactor(aircraft, key, factor)])
        .filter(([key, factor]) => factor > 0 && values[key] != null)
        .map(([key, factor]) => ({ key, input: values[key], factor, amount: values[key] * factor,
          flowKey: Object.hasOwn(engineValues, key) ? engine.flowKeys?.[key] || `engine:${owner.id}:${key}` :
            Object.hasOwn(sources, key) ? "board:" + key : key }));
      const amount = inputs.reduce((sum, item) => sum + item.amount, 0);
      if (!amount) return [];
      return [{ resourceId: resource.id, blockId: owner?.kind === "airframe" ? null : owner?.id, name: resource.name, object: resource.object, unit: resource.unit,
        priority: resource.priority === true,
        labels: Object.fromEntries(resourceSources(aircraft, owner).map((source) => [source.key, calculationSourceLabel(source)])),
        inputs, amount, before: resource.remaining, remaining: Math.max(0, resource.remaining - amount) }];
    });
  }

  const BOARD_COUNTERS = ["totalFlightMinutes", "actualLandings", "pprFlightMinutes", "pprLandings", "equivalentLandings", "arresterHooks"];
  const BLOCK_COUNTERS = ["sneMinutes", "sneLandings", "pprMinutes", "pprLandings", "starts", "pprStarts", "maximumSeconds",
    "pprMaximumSeconds", "afterburnerSeconds", "pprAfterburnerSeconds", "modesSeconds", "pprModesSeconds"];

  function usageSnapshot(aircraft) {
    const pick = (item, keys) => Object.fromEntries(keys.map((key) => [key, structuredClone(item[key] ?? null)]));
    return {
      board: pick(aircraft, BOARD_COUNTERS),
      blocks: aircraft.blocks.map((block) => ({
        id: block.id, repairs: block.repairs, values: pick(block, BLOCK_COUNTERS),
        ...(block.usageCounters?.length && { aggregate: structuredClone({ rules: block.usageCounters, totals: block.usageTotals }) }),
      })),
      resources: aircraft.resources.filter((resource) => resource.unit !== "дн.").map((resource) =>
        ({ id: resource.id, limit: resource.limit, remaining: resource.remaining })),
    };
  }

  function restoreUsage(aircraft, snapshot) {
    Object.assign(aircraft, snapshot.board);
    for (const entry of snapshot.blocks) {
      const block = aircraft.blocks.find(({ id }) => id === entry.id);
      Object.assign(block, entry.values);
      if (entry.aggregate) block.usageTotals = structuredClone(entry.aggregate.totals);
    }
    for (const entry of snapshot.resources) {
      const resource = aircraft.resources.find((item) => item.id === entry.id);
      resource.remaining = entry.remaining;
      resource.status = resourceStatus(resource.remaining, resource.limit);
    }
  }

  function canCorrectShift(aircraft, shift) {
    return Boolean(shift?.beforeUsage && shift.afterUsage && shift === aircraft.shifts.at(-1) &&
      !shift.resourceAssignmentChanged && sameRecordedUsageKinds(aircraft, shift) &&
      JSON.stringify(shift.afterUsage) === JSON.stringify(usageSnapshot(aircraft)));
  }

  function sameRecordedUsageKinds(aircraft, shift) {
    const recorded = shift.customUsage ?? Object.entries(shift.raw || {})
      .filter(([key, value]) => key.startsWith("custom-") && value !== "").map(([key]) => ({ key }));
    return recorded.every(({ key, seconds, format }) => {
      const source = customSources(aircraft).find((item) => item.key === key);
      return source && sourceEnabled(aircraft, key) &&
        (seconds == null ? sourceKind(source) === "count" : source.kind === "time" && source.format === format);
    });
  }

  function usageRule(key, aircraft = selectedAircraft()) {
    const defaults = state.usageRules?.[key] ?? {
      label: USAGE_TYPES[key],
      factor: aircraft?.settings?.landingCoefficients?.[key] ?? DEFAULT_AIRCRAFT_SETTINGS.landingCoefficients[key] ?? 1,
    };
    const profile = usageTypeOverride(aircraft);
    const custom = key.startsWith("custom-") && (aircraft?.customUsageSources?.find((source) => source.key === key) ??
      profile?.customSources?.find((source) => source.key === key));
    const enabledByDefault = profile?.enabled && BOARD_USAGE_TYPES.includes(key) ? CORE_USAGE_TYPES.includes(key) : defaults.enabled;
    const label = profile?.labels?.[key] ?? custom?.label ?? defaults.label;
    return {
      label: key === "flight" ? aircraftTemplates.normalizeFlightLabel(label) : label,
      factor: aircraft?.usageFactors?.[key] ?? profile?.factors?.[key] ?? custom?.factor ?? defaults.factor,
      enabled: profile?.enabled?.[key] ?? enabledByDefault,
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

  const seedState = { view: "home", globalNotifications: true, aircraft: [] };

  let state = loadState();
  const viewStack = [];

  function loadState() {
    try {
      const stored = window.AndroidBridge?.readSavedState?.() || localStorage.getItem(STORAGE_KEY);
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
        removedAircraftTypes: state.removedAircraftTypes,
        usageRules: state.usageRules,
        usageInheritanceVersion: USAGE_INHERITANCE_VERSION,
        sharedGround: state.sharedGround,
        usageTypeOverrides: state.usageTypeOverrides,
        templateCatalog: state.templateCatalog,
        aircraft: state.aircraft,
      };
      const json = JSON.stringify(persisted);
      if (window.AndroidBridge?.storeState) {
        if (!window.AndroidBridge.storeState(json)) return false;
        try { localStorage.setItem(STORAGE_KEY, json); } catch (_) { /* The Android copy is committed. */ }
      } else localStorage.setItem(STORAGE_KEY, json);
    } catch (_) {
      return false;
    }
    syncAndroidReminders();
    return true;
  }

  function normalizeState(raw) {
    const normalized = Object.assign({}, structuredClone(seedState), raw || {}, { view: "home" });
    normalized.typeSettings = Array.isArray(raw?.typeSettings) ? raw.typeSettings : [];
    normalized.usageTypeOverrides = Array.isArray(raw?.usageTypeOverrides) ? raw.usageTypeOverrides.map((profile) => {
      const current = profile.labels?.flight;
      const flight = aircraftTemplates.normalizeFlightLabel(current);
      return flight === current ? profile : { ...profile, labels: { ...profile.labels, flight } };
    }) : [];
    normalized.templateCatalog = Array.isArray(raw?.templateCatalog) ? raw.templateCatalog
      .map(aircraftTemplates.upgradeLegacySu33).map(aircraftTemplates.normalizeTemplateFlightLabel) : [];
    normalized.archivedAircraftTypes = Array.isArray(raw?.archivedAircraftTypes) ? raw.archivedAircraftTypes : [];
    normalized.removedAircraftTypes = Array.isArray(raw?.removedAircraftTypes) ? raw.removedAircraftTypes : [];
    if (!Array.isArray(normalized.aircraft)) normalized.aircraft = [];
    normalized.aircraft = normalized.aircraft.map(upgradeAircraftTemplate).map((aircraft) => ({
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
    if (raw?.usageInheritanceVersion !== USAGE_INHERITANCE_VERSION) migrateUsageSourceInheritance(normalized);
    const types = new Map();
    for (const value of [
      ...(Array.isArray(raw?.aircraftTypes) ? raw.aircraftTypes : []),
      ...normalized.aircraft.map((item) => item.type),
      ...normalized.typeSettings.map((item) => item.type),
    ]) {
      if (typeof value !== "string" || !value.trim()) continue;
      const name = value.trim();
      const key = name.toLowerCase();
      if (!types.has(key) && !normalized.removedAircraftTypes.includes(key)) types.set(key, name);
    }
    normalized.aircraftTypes = [...types.values()];
    for (const key of types.keys()) {
      const profile = normalized.usageTypeOverrides.find((entry) => entry.type === key);
      if (profile?.enabled) continue;
      const enabled = defaultUsageSources();
      const migrated = { ...profile, type: key, enabled };
      normalized.usageTypeOverrides = normalized.usageTypeOverrides.filter((entry) => entry.type !== key).concat(migrated);
    }
    return normalized;
  }

  function upgradeAircraftTemplate(aircraft) {
    const previous = aircraft.workTemplate;
    const upgraded = aircraftTemplates.upgradeLegacySu33(previous);
    const workTemplate = aircraftTemplates.normalizeTemplateFlightLabel(upgraded);
    if (previous === upgraded) return workTemplate === previous ? aircraft : { ...aircraft, workTemplate };
    const renamed = new Map();
    const blocks = (aircraft.blocks || []).map((block) => {
      if (block.kind !== "unit" || block.templateSlotId) return block;
      const slot = previous.positions.find((position) => position.kind === "unit" &&
        block.name === position.label && block.model === position.model);
      if (!slot) return block;
      const position = upgraded.positions.find((item) => item.id === slot.id);
      renamed.set(block.id, position.label);
      return { ...block, name: position.label, templateSlotId: position.id };
    });
    const resources = (aircraft.resources || []).map((resource) => {
      const owner = resourceOwner(aircraft, resource);
      if (!renamed.has(owner?.id)) return resource;
      return { ...resource, objectId: owner.id, object: renamed.get(owner.id) };
    });
    return { ...aircraft, workTemplate, blocks, resources };
  }

  function migrateUsageSourceInheritance(data) {
    const defaults = defaultUsageSources();
    const old = Object.fromEntries(BOARD_USAGE_TYPES.map((key) => [key, data.usageRules?.[key]?.enabled !== false]));
    const migrationKeys = BOARD_USAGE_TYPES.filter((key) => old[key] !== defaults[key]);
    for (const aircraft of data.aircraft) {
      const overrides = aircraft.enabledUsageSources;
      if (!overrides) continue;
      const type = aircraft.type.trim().toLowerCase();
      const profile = data.usageTypeOverrides.find((item) => item.type === type);
      const copiedFullList = BOARD_USAGE_TYPES.every((key) => Object.hasOwn(overrides, key));
      // Older versions copied enabled defaults into every existing board when introducing type settings.
      const copiedOptional = migrationKeys.length > 1 && migrationKeys.every((key) =>
        overrides[key] === old[key] || (!Object.hasOwn(overrides, key) && profile?.enabled?.[key] === old[key]));
      const copiedKeys = copiedFullList ? BOARD_USAGE_TYPES : copiedOptional ? migrationKeys : [];
      aircraft.enabledUsageSources = Object.fromEntries(Object.entries(overrides).filter(([key, enabled]) =>
        !copiedKeys.includes(key) || old[key] !== enabled));
    }
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
  let leaveTemplateEditor;
  let leaveAggregateRules;
  function navigateBack() {
    if (state.view === "usage-settings" && leaveUsageSettings?.()) return;
    if (["aircraft-layout", "block-layout"].includes(state.view) && leaveAircraftLayout?.()) return;
    if (state.view === "template-editor" && leaveTemplateEditor?.()) return;
    if (state.view === "block-usage-rules" && leaveAggregateRules?.()) return;
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
    else if (state.view === "block-usage-rules") renderAggregateRules();
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
    else if (state.view === "template-editor") renderTemplateEditor();
    else if (state.view === "aircraft-layout") renderAircraftLayout();
    else if (state.view === "block-layout") renderAircraftLayout(renderBlock(true));
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
            <span class="aircraft-card__title">${escapeHtml(aircraft.type.replace(/\s*·\s*формуляры$/iu, ""))} · борт ${escapeHtml(aircraft.boardNumber)}</span>
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
            <button type="button" class="secondary-button danger-button" data-board-menu="delete-board" data-board-id="${escapeHtml(aircraft.id)}">Удалить борт</button>
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
      ${aircraftImportControls()}
      <section class="section-stack aircraft-list" aria-label="Список самолётов">
        ${aircraftCards || `<div class="empty-state"><h2>Самолётов пока нет</h2><p>Добавьте первый борт, чтобы начать учёт.</p></div>`}
      </section>
      ${nearestNote}
    `, { title: "Самолёты", subtitle: "Авиаресурс" });
    bindTemplateImport();
  }

  function componentSerialLine(block) {
    const serial = String(block.serialNumber ?? "").trim();
    return block.kind !== "airframe" && serial ? `<small class="component-serial">Зав. № ${escapeHtml(serial)}</small>` : "";
  }

  function renderAircraft(layoutEditing = false) {
    const aircraft = selectedAircraft();
    const activeTab = state.aircraftTab || "aggregates";
    const resourceStatuses = new Map();
    for (const resource of aircraft.resources) {
      if (!(resource.limit > 0)) continue;
      const owner = resourceFormOwner(aircraft, resource);
      if (!owner) continue;
      const previous = resourceStatuses.get(owner.id);
      if (!previous || resource.status === "danger" || (resource.status === "warning" && previous === "ok")) {
        resourceStatuses.set(owner.id, resource.status);
      }
    }
    const renderBlockTile = (block) => {
      const status = resourceStatuses.get(block.id) ?? block.status ?? "ok";
      return `
      <button class="equipment-block" data-block-id="${block.id}">
        <span class="equipment-block__icon">${block.kind === "engine" ? "◉" : block.kind === "airframe" ? "△" : "⬡"}</span>
        <span class="equipment-block__body"><strong>${escapeHtml(block.name)}</strong>${componentSerialLine(block)}${block.caption ? `<small>${escapeHtml(block.caption)}</small>` : ""}</span>
        <span class="status-dot status-${status}" aria-label="${statusLabel(status)}"></span>
        <span>${icon("chevron")}</span>
      </button>`;
    };
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
      bindTileHold(preview, "aircraft", (index) => {
        activeCounterIndex = index;
        viewStack.push(state.view);
        state.view = "aircraft-layout";
        renderAircraftLayout({ layout, catalog, activeTab });
      });
    }
    return { layout, catalog, activeTab };
  }

  function bindTileHold(preview, sourceView, open) {
    const tiles = preview.querySelector(".counter-tiles");
    let holdTimer;
    let start;
    function stopHold() {
      clearTimeout(holdTimer);
      start?.tile.classList.remove("counter-tile-active");
      start = null;
    }
    function openHeldTile(tile) {
      if (!tile.isConnected || state.view !== sourceView) return;
      recordDiagnostic("layout.open.request");
      try {
        open(Number(tile.dataset.counterIndex));
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
      if (sourceView === 'block' && target.closest('input, select, textarea')) return;
      const tile = target.closest("[data-counter-index]");
      if (!tile) return;
      start = { x, y, tile, ready: false, at: performance.now() };
      recordDiagnostic("layout.hold.start", input);
      holdTimer = setTimeout(() => {
        if (!tile.isConnected || state.view !== sourceView) return;
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
    for (const name of ["contextmenu", "selectstart"]) {
      tiles.addEventListener(name, (event) => {
        if (sourceView === "aircraft" || !event.target.closest("input, textarea")) event.preventDefault();
      });
    }
  }

  const boardNavigationKeys = ["widget:board-tabs", "widget:board-aggregates", "widget:board-resources"];
  const isNavigationTile = (tile) => tile.keys.every((key) => boardNavigationKeys.includes(key));

  function remapTemplateTiles(tiles, toKey) {
    return tiles.flatMap((tile) => {
      const entries = tile.keys.map((key) => [key, toKey(key)]).filter(([, mapped]) => mapped);
      if (!entries.length) return [];
      const { labels, ...dimensions } = tile;
      return [{ ...dimensions, keys: entries.map(([, mapped]) => mapped), ...(labels && {
        labels: Object.fromEntries(entries.filter(([key]) => labels[key]).map(([key, mapped]) => [mapped, labels[key]])),
      }) }];
    });
  }

  function remapFormLayout(layout, toKey) {
    return { tiles: remapTemplateTiles(layout.tiles, toKey), hidden: (layout.hidden || []).map(toKey).filter(Boolean) };
  }

  function formCounterKeys(block, reverse = false) {
    return new Map((block.usageCounters || []).map(({ id }, index) => {
      const keys = [`form:aggregate-counter:${id}`, `form:aggregate-counter-index:${index}`];
      return reverse ? keys.reverse() : keys;
    }));
  }

  function boardTemplate(aircraft, currentBlocks = new Map()) {
    const template = structuredClone(aircraft.workTemplate);
    template.operationTypes = structuredClone(aircraft.operationTypes || DEFAULT_OPERATION_TYPES);
    template.defaultOperationType = aircraft.defaultOperationType || template.operationTypes[0].id;
    const airframe = template.positions.find((position) => position.kind === "airframe");
    for (const block of aircraft.blocks) {
      const slot = block.templateSlotId || (block.kind === "airframe" ? airframe.id : null);
      if (slot && (!currentBlocks.has(slot) || blockInstalledOn(block, todayIso()))) currentBlocks.set(slot, block);
      if (!slot && block.kind === "unit") {
        let next = template.positions.length + 1;
        while (template.positions.some((position) => position.id === `unit-${next}`)) next += 1;
        const key = `unit-${next}`;
        template.positions.push({ id: key, kind: "unit", label: block.name, model: block.model });
        currentBlocks.set(key, block);
      }
    }
    const toSlot = new Map([...currentBlocks].map(([slot, block]) => [`widget:${block.id}`, `slot:${slot}`]));
    const toAssemblySlot = new Map([...currentBlocks].filter(([, block]) => block.kind !== "airframe")
      .map(([slot, block]) => [`form:assembly:${block.id}`, `form:assembly-slot:${slot}`]));
    for (const position of template.positions) {
      const block = currentBlocks.get(position.id);
      if (block) {
        position.label = block.name;
        position.model = block.model;
        if (block.usageCounters) {
          position.usageCounters = block.usageCounters.map(({ name, source, unit, factor, additionalInputs, workMode, fieldKey, columnKey, id, formula, workTypeId, boardCounter }) => ({
            name, source, unit, factor, ...(boardCounter && { boardCounter }), ...(workTypeId && { workTypeId }), columnKey: columnKey || id, ...(formula && { formula }), ...(workMode && { workMode }), ...(fieldKey && { fieldKey }),
            ...(additionalInputs?.length && { additionalInputs: additionalInputs.map(({ source, factor }) => ({ source, factor })) }),
          }));
        }
        if (block.formLayout) {
          const toCounterIndex = formCounterKeys(block);
          position.formLayout = remapFormLayout(block.formLayout, (key) => toCounterIndex.get(key) ||
            (block.kind === "airframe" && toAssemblySlot.get(key)) || (aircraftTemplates.isFormKey(key) ? key : null));
          for (const tile of position.formLayout.tiles) {
            if (rfInCaption(tile.labels?.["form-field:rfNumber"])) tile.labels["form-field:rfNumber"] = "RF";
          }
        }
      }
    }
    template.boardUsage = usageSources(aircraft).map(({ key, kind, format }) => {
      const { label, factor } = usageRule(key, aircraft);
      return { key, label, factor, enabled: sourceEnabled(aircraft, key), kind, format };
    });
    const tabLayouts = aircraft.boardLayouts ?? (aircraft.counterLayout && Object.fromEntries(
      ["works", "aggregates", "least-reliable"].map((tab) => [tab, aircraft.counterLayout])));
    const tabs = Object.fromEntries(Object.entries(tabLayouts || {}).map(([tab, tiles]) =>
      [tab, remapTemplateTiles(tiles, (key) => toSlot.get(key) || (aircraftTemplates.layoutKeys.includes(key) ? key : null))]));
    const navigation = aircraft.boardNavigationLayout ?? (aircraft.boardTabsLayout && [{
      index: aircraft.boardTabsLayout.index,
      tile: { ...aircraft.boardTabsLayout.tile, keys: [...boardNavigationKeys] },
    }]);
    template.layout = { tabs, ...(navigation && { navigation }) };
    return template;
  }

  function applyTemplateLayout(aircraft, template) {
    if (!template.layout) return;
    const bySlot = new Map(aircraft.blocks.map((block) => [`slot:${block.templateSlotId}`, `widget:${block.id}`]));
    aircraft.boardLayouts = Object.fromEntries(Object.entries(template.layout.tabs).map(([tab, tiles]) =>
      [tab, remapTemplateTiles(tiles, (key) => key.startsWith("slot:") ? bySlot.get(key) : key)]));
    if (template.layout.navigation) aircraft.boardNavigationLayout = structuredClone(template.layout.navigation);
  }

  function applyTemplateFormLayouts(aircraft) {
    const bySlot = new Map(aircraft.blocks.map((block) => [`form:assembly-slot:${block.templateSlotId}`, `form:assembly:${block.id}`]));
    for (const block of aircraft.blocks) {
      const layout = templatePositionFor(aircraft, block)?.formLayout;
      if (!layout) continue;
      const byIndex = formCounterKeys(block, true);
      block.formLayout = remapFormLayout(layout, (key) => byIndex.get(key) || bySlot.get(key) ||
        (aircraftTemplates.isFormKey(key) ? key : null));
    }
  }

  function exportTemplate(template) {
    let clean;
    try { clean = aircraftTemplates.validateTemplate(template); }
    catch (error) { showToast(error.message); return; }
    downloadAircraftFile(clean, `${clean.id}.json`);
  }

  function downloadAircraftFile(documentData, filename) {
    const json = JSON.stringify(documentData, null, 2) + "\n";
    if (new TextEncoder().encode(json).length > 256 * 1024) { showToast("Шаблон превышает 256 КБ"); return; }
    if (typeof window.AndroidBridge?.saveAircraftTemplate === "function") {
      window.AndroidBridge.saveAircraftTemplate(filename, json);
      return;
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function landingCount(aircraft, key) {
    return (aircraft.initialLandingCounts?.[key] ?? 0) + aircraft.shifts.reduce((sum, shift) =>
      sum + Number(shift.landingsByType?.[key] ?? shift.raw?.[key] ?? 0), 0);
  }

  function presentReadings(item, keys) {
    return Object.fromEntries(keys.filter((key) => item[key] != null).map((key) => [key, item[key]]));
  }

  function exportStartingAircraft(board) {
    const slots = new Map();
    const template = boardTemplate(board, slots);
    if (slots.size !== board.blocks.length || board.blocks.some((block) => !blockInstalledOn(block, todayIso()))) {
      throw new Error("Начальный состав можно экспортировать, когда у каждого экземпляра есть своя установленная позиция");
    }
    const byBlock = new Map([...slots].map(([slot, block]) => [block.id, slot]));
    const blocks = [...slots].map(([position, block]) => ({
      position, serialNumber: block.serialNumber, manufactureDate: block.manufactureDate, repairs: block.repairs,
      lastRepairDate: block.historicalRepairs?.[block.repairs]?.date || block.events.filter((e) => e.type === "repair").at(-1)?.date,
      readings: presentReadings(block, ["sneMinutes", "pprMinutes", "sneLandings", "pprLandings", "starts", "pprStarts"]),
      totals: (block.usageCounters || []).map((rule, counter) => ({ counter,
        ...presentReadings(block.usageTotals?.[rule.id] || {}, ["sne", "ppr"]) })),
    }));
    const resources = board.resources.map((resource) => {
      const owner = resourceOwner(board, resource) || (!resource.objectId && resource.object === "Самолёт"
        ? board.blocks.find((b) => b.kind === "airframe") : null);
      if (!owner || !byBlock.has(owner.id)) throw new Error(`Укажи формуляр для ресурса «${resource.name}»`);
      const inputs = Object.entries(resourceInputs(resource, owner, board)).map(([key, factor]) => {
        if (!key.startsWith("aggregate:")) return { source: key, factor };
        const index = (owner.usageCounters || []).findIndex((rule) => aggregateResourceKey(rule.id) === key);
        if (index < 0) throw new Error(`Проверь источник ресурса «${resource.name}»`);
        return { source: `counter:${index}`, factor };
      });
      return { position: byBlock.get(owner.id), name: resource.name, unit: resource.unit, limit: resource.limit,
        remaining: resource.remaining, inputs, installed: resource.installed, produced: resource.produced, expiryDate: resource.expiryDate };
    });
    return aircraftTemplates.validateStartingAircraft({ kind: "aircraft-start", version: 1, template,
      aircraft: { boardNumber: board.boardNumber, serialNumber: board.serialNumber, rfNumber: board.rfNumber,
        readings: presentReadings(board, BOARD_COUNTERS), blocks, resources,
        landingCounts: Object.fromEntries(OPTIONAL_USAGE_TYPES.filter((key) => key !== "arresterHooks" &&
          (board.initialLandingCounts?.[key] != null || board.shifts.some((shift) => shift.landingsByType?.[key] != null || shift.raw?.[key] != null)))
          .map((key) => [key, landingCount(board, key)])) } });
  }

  function importStartingAircraft({ template, aircraft: data }) {
    const fold = (value) => (value || "").trim().toLowerCase();
    if (state.aircraft.some((other) => (fold(other.type) === fold(template.name) && fold(other.boardNumber) === fold(data.boardNumber)) ||
        (data.serialNumber && data.serialNumber !== "Не указан" && fold(other.serialNumber) === fold(data.serialNumber)))) {
      throw new Error("Этот борт уже есть. Существующие показания сохранены");
    }
    const existing = state.templateCatalog.find((t) => t.id === template.id && t.name === template.name);
    if (isArchivedType(template.name) || (!existing && (templateNameTaken(template.name) || templateIdTaken(template.id)))) {
      throw new Error("Имя или идентификатор типа уже занят другим типом");
    }
    const previous = { aircraftTypes: state.aircraftTypes, templateCatalog: state.templateCatalog, usageTypeOverrides: state.usageTypeOverrides };
    try {
      if (!existing) registerTemplate(template);
      const sources = template.boardUsage || [];
      const enabled = Object.fromEntries(BOARD_USAGE_TYPES.map((key) => [key, template.inputs.some((field) => field.role === key)]));
      for (const source of sources) enabled[source.key] = source.enabled;
      const board = buildAircraft({ ...data, type: template.name, enabledUsageSources: enabled,
        customUsageSources: sources.filter((source) => source.key.startsWith("custom-")),
        usageFactors: Object.fromEntries(sources.map((source) => [source.key, source.factor])) }, template);
      Object.assign(board, data.readings, { initialLandingCounts: data.landingCounts });
      const slots = new Map(board.blocks.map((block) => [block.templateSlotId, block]));
      for (const row of data.blocks) {
        const block = slots.get(row.position);
        Object.assign(block, row.readings, { serialNumber: row.serialNumber, manufactureDate: row.manufactureDate, repairs: row.repairs });
        if (row.lastRepairDate) block.historicalRepairs = { [row.repairs]: { date: row.lastRepairDate, beforeRepair: {} } };
        for (const { counter, sne, ppr } of row.totals) block.usageTotals[block.usageCounters[counter].id] = { sne: sne ?? 0, ppr: ppr ?? null };
      }
      board.resources = data.resources.map(({ position, inputs, ...resource }) => {
        const owner = slots.get(position);
        const allowed = new Set(resourceSources(board, owner).map((source) => source.key));
        const consumption = Object.fromEntries(inputs.map(({ source, factor }) => {
          const key = source.startsWith("counter:") ? aggregateResourceKey(owner.usageCounters[Number(source.slice(8))].id) : source;
          if (!allowed.has(key)) throw new Error(`Неизвестный источник расхода у «${resource.name}»`);
          return [key, factor];
        }));
        return normalizeResource({ ...resource, id: id(), objectId: owner.id, object: owner.name, consumption });
      });
      if (!finishAircraftCreation(board)) throw new Error("Не удалось сохранить борт");
    } catch (error) {
      Object.assign(state, previous);
      throw error;
    }
  }
  const defaultCounterLayout = [
    { keys: ["flightSne", "flightPpr"], wide: true },
    { keys: ["landingSne", "landingPpr"], wide: true },
  ];
  let leaveAircraftLayout;
  let activeCounterIndex = null;
  let counterGesture = "";

  function chooseLayoutAction(title, choices, onChoose, description) {
    const dialog = document.createElement("dialog");
    dialog.className = "confirm-dialog";
    dialog.innerHTML = `<form method="dialog"><h2>${title}</h2>
      ${description ? `<p>${escapeHtml(description)}</p>` : ""}
      ${choices.map(([value, label, style = ""]) => `<button class="secondary-button ${style}" value="${value}">${label}</button>`).join("")}</form>`;
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

  function flightCounterValue(minutes) {
    return minutes ? calc.formatDuration(minutes) : "0";
  }

  const formIdentifierFields = new Map([
    ["form-field:serialNumber", "serialNumber"], ["form-field:rfNumber", "rfNumber"],
  ]);

  function rfInCaption(label) {
    return /^RF[\s:-]+(\d(?:[\d\s-]*\d)?)$/i.exec(label || "")?.[1];
  }

  function normalizeIdentifier(field, value) {
    const text = value.trim();
    return field === "rfNumber" ? text.replace(/^RF[\s:-]*/i, "") : text;
  }

  function counterTiles(aircraft, layout, editing = false, catalog = new Map(), removable) {
    const name = escapeHtml(usageRule("flight", aircraft).label);
    const values = {
      flightSne: [name + " СНЭ", flightCounterValue(aircraft.totalFlightMinutes)],
      flightPpr: [name + " ППР", aircraft.pprFlightMinutes == null ? "—" : flightCounterValue(aircraft.pprFlightMinutes)],
      landingSne: ["Посадки СНЭ", aircraft.actualLandings],
      landingPpr: ["Посадки ППР", aircraft.pprLandings ?? "—"],
    };
    return `<section class="counter-tiles" aria-label="Наработка борта">${layout.map((tile, index) => `
      <article class="counter-tile ${editing && activeCounterIndex === index ? "counter-tile-active" : ""}" data-counter-index="${index}" data-tile-key="${escapeHtml(tile.keys[0])}" style="--tile-start:${tile.columnStart == null ? "auto" : Math.max(1, Math.min(tile.columnStart, 121 - tileSpan(tile)))};--tile-span:${tileSpan(tile)};--tile-height:${tile.height ?? 0}px;--tile-font:${tile.font ?? 1}rem;--tile-density:${tileDensity(tileSpan(tile))}">
        ${editing && activeCounterIndex === index ? `<div class="counter-gesture-toolbar">
          <button type="button" class="counter-toolbar-handle" aria-label="Передвинуть панель">⠿</button>
          <button type="button" data-gesture="move" aria-label="Переместить" aria-pressed="${counterGesture === "move"}">✥</button>
          <button type="button" data-gesture="resize" aria-label="Изменить размер" aria-pressed="${counterGesture === "resize"}">↔</button>
          <button type="button" data-gesture="font" aria-label="Размер текста" aria-pressed="${counterGesture === "font"}">Aa</button>
          <button type="button" data-layout-action="edit" data-index="${index}" aria-label="Изменить подпись">✎</button>
          ${removable && tile.keys.some(removable) ? `<button type="button" data-layout-action="hide" data-index="${index}" aria-label="Убрать карточку">×</button>` : ""}
        </div><svg class="counter-edit-outline" aria-hidden="true"><rect pathLength="100" rx="22"/></svg>` : ""}
        <div class="${isNavigationTile(tile) && tile.keys.length > 1 ? "board-navigation-group" : "counter-group"}">
        ${tile.keys.map((key) => `<div class="counter-value">${catalog.has(key)
          ? labelledWidget(catalog.get(key), key === "form-field:rfNumber" && rfInCaption(tile.labels?.[key]) ? "RF" : tile.labels?.[key])
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
    const caption = widget.matches("[data-tile-caption]") ? widget :
      widget.querySelector("[data-tile-caption], .equipment-block__body strong, .resource-row__top strong, .history-row strong");
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
    const { layout, catalog, activeTab, formBlock, hidden = [] } = existingBoard ?? renderAircraft(true);
    const removable = formBlock ? () => true : undefined;
    let draft = structuredClone(layout);
    const removed = new Set(hidden);
    const identifiers = new Map();
    const snapshot = () => JSON.stringify([draft, [...removed], [...identifiers]]);
    const initial = snapshot();
    const preview = document.getElementById("counter-preview");
    const surface = preview.closest("main");
    const controls = document.createElement("div");
    controls.className = "counter-save-bar";
    controls.innerHTML = `<button class="secondary-button" id="layout-default">Сброс размера</button>
      <button class="secondary-button" id="layout-group">Группа</button>
      ${formBlock ? '<button class="secondary-button" id="layout-restore" hidden>Вернуть карточку</button>' : ""}
      <button class="secondary-button counter-font-reset" id="counter-font-reset" aria-label="Стандартный текст 100%" hidden>● <span id="counter-font-percent">100%</span></button>
      <button class="primary-button" id="layout-save">Готово</button>`;
    surface.after(controls);
    if (formBlock) preview.parentElement.querySelectorAll(":scope > label[hidden]").forEach((label) => label.remove());
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
      controls.querySelector("#layout-group").disabled = controls.querySelector("#layout-default").disabled = !draft.length;
      const restore = controls.querySelector("#layout-restore");
      if (restore) restore.hidden = removed.size === 0;
    }
    const paint = () => { preview.innerHTML = counterTiles(aircraft, draft, true, catalog, removable);
      if (formBlock) restoreFormInputDraft(formBlock);
      for (const [field, value] of identifiers) {
        const input = preview.querySelector(`input[name="${field}"]`);
        if (input) input.value = value;
      }
      preview.querySelectorAll(".counter-value :is(button,input,select,textarea)").forEach((button) => { button.disabled = true; });
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
    let selectionTouch;
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
      selectionTouch = null;
      if (hold && drag?.touch === hold.id) clearDrag();
      cancelHold();
      const targetCard = event.target.closest(".counter-tile");
      if ((counterGesture === "resize" || counterGesture === "font") && event.touches.length === 1 && !event.target.closest("button:not(:disabled)")) {
        const finger = event.touches[0];
        if (targetCard && Number(targetCard.dataset.counterIndex) !== activeCounterIndex) {
          selectionTouch = { index: Number(targetCard.dataset.counterIndex), id: finger.identifier, x: finger.clientX, y: finger.clientY };
          return;
        }
        event.preventDefault();
        clearDrag();
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
      if (counterGesture !== "move" || drag || !targetCard || Number(targetCard.dataset.counterIndex) !== activeCounterIndex || event.target.closest("button") || event.touches.length !== 1) return;
      const touch = event.touches[0];
      hold = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
      drag = { touch: hold.id, source: activeCounterIndex, target: null };
      const rect = targetCard.getBoundingClientRect();
      const ghost = targetCard.cloneNode(true);
      ghost.className = "counter-tile counter-move-ghost";
      ghost.querySelector(".counter-gesture-toolbar")?.remove();
      ghost.setAttribute("aria-hidden", "true");
      ghost.style.width = `${rect.width}px`;
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      surface.append(ghost);
      drag.ghost = ghost;
      targetCard.classList.add("counter-dragging");
    }, { passive: false });
    surface.addEventListener("touchmove", (event) => {
      if (selectionTouch) {
        const touch = [...event.touches].find((item) => item.identifier === selectionTouch.id);
        if (!touch || Math.hypot(touch.clientX - selectionTouch.x, touch.clientY - selectionTouch.y) > 8) selectionTouch = null;
        return;
      }
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
      if (selectionTouch && [...event.changedTouches].some((item) => item.identifier === selectionTouch.id)) {
        if (event.cancelable) event.preventDefault();
        activeCounterIndex = selectionTouch.index;
        selectionTouch = null;
        paint();
        return;
      }
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
      selectionTouch = null;
      if (resize) { draft[resize.index] = resize.original; resize = null; paint(); }
      if (hold && drag?.touch === hold.id) clearDrag();
      cancelHold();
    });
    preview.addEventListener("contextmenu", (event) => {
      if (event.target.closest(".counter-tile")) event.preventDefault();
    });
    function save() {
      if (formBlock && snapshot() === initial) {
        finishBackNavigation();
        return;
      }
      const previous = aircraft.boardLayouts;
      const previousTabs = aircraft.boardNavigationLayout;
      const previousForm = formBlock?.formLayout;
      const owner = formBlock?.kind === "airframe" ? aircraft : formBlock;
      const previousIdentifiers = Object.fromEntries([...identifiers.keys()].map((field) => [field, owner[field]]));
      if (formBlock) {
        const tiles = structuredClone(draft);
        for (const [index, tile] of (previousForm?.tiles || []).entries()) {
          const absent = tile.keys.filter((key) => !catalog.has(key));
          if (absent.length) tiles.splice(index, 0, { ...tile, keys: absent });
        }
        const dormant = (previousForm?.hidden || []).filter((key) => !catalog.has(key));
        formBlock.formLayout = { tiles, hidden: [...removed, ...dormant] };
      }
      else {
        aircraft.boardNavigationLayout = draft.flatMap((tile, index) => isNavigationTile(tile) ? [{ index, tile: structuredClone(tile) }] : []);
        aircraft.boardLayouts = { ...previous, [activeTab]: structuredClone(draft.filter((tile) => !isNavigationTile(tile))) };
      }
      if (identifiers.size) Object.assign(owner, Object.fromEntries(identifiers));
      if (saveState()) {
        if (identifiers.size && formInputDraft?.blockId === formBlock.id) {
          Object.assign(formInputDraft.values["block-form"], Object.fromEntries(identifiers));
        }
        recordDiagnostic("layout.save.ok");
        const currentScroll = window.scrollY;
        finishBackNavigation();
        window.scrollTo(0, currentScroll);
      }
      else {
        recordDiagnostic("layout.save.error");
        if (formBlock) {
          formBlock.formLayout = previousForm;
          Object.assign(owner, previousIdentifiers);
        }
        else {
          aircraft.boardLayouts = previous;
          aircraft.boardNavigationLayout = previousTabs;
        }
        showToast("Не удалось сохранить раскладку");
      }
    }
    leaveAircraftLayout = () => {
      if (snapshot() === initial) return false;
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
      if (selected && !event.target.closest("button:not(:disabled)")) {
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
      if (action === "hide" && removable) {
        if (tile.keys.includes("form-field:name") && !formInputDraft?.values["block-form"]?.name?.trim()) {
          showToast("Сначала введи название формуляра");
          return;
        }
        for (const key of tile.keys.filter(removable)) removed.add(key);
        tile.keys = tile.keys.filter((key) => !removable(key));
        if (!tile.keys.length) draft.splice(index, 1);
        activeCounterIndex = Math.max(0, Math.min(index, draft.length - 1));
        counterGesture = "";
        surface.classList.remove("counter-resize-surface");
        preview.classList.remove("counter-move-surface");
        paint();
        return;
      }
      if (action === "edit") {
        const dialog = document.createElement("dialog");
        dialog.className = "confirm-dialog";
        const captions = [...button.closest(".counter-tile").querySelectorAll(".counter-value")];
        const originalValues = new Map();
        dialog.innerHTML = `<form method="dialog" class="shift-form"><h2>Редактировать карточку</h2>
          ${tile.keys.map((key, offset) => {
            const caption = captions[offset];
            const heading = caption.querySelector("[data-tile-caption], strong, button");
            const field = formBlock && formIdentifierFields.get(key);
            const alias = key === "form-field:rfNumber" && rfInCaption(tile.labels?.[key]) ? "RF" : tile.labels?.[key];
            const title = alias ?? (key === "widget:board-tabs" ? "Панель вкладок" : (heading ?? caption).textContent.trim());
            if (field) originalValues.set(field, caption.querySelector("input").value);
            return `<label>${field ? "Подпись" : escapeHtml(title)}
            <input name="${escapeHtml(key)}" type="text" value="${escapeHtml(alias ?? "")}" placeholder="${field ? escapeHtml(title) : "Стандартное название"}"></label>
            ${field ? `<label>Значение<input name="identifier:${field}" type="text" value="${escapeHtml(originalValues.get(field))}"></label>` : ""}`;
          }).join("")}
          <button class="primary-button" value="save">Применить</button><button class="secondary-button" value="cancel">Отмена</button></form>`;
        dialog.addEventListener("close", () => {
          if (dialog.returnValue === "save") {
            const data = new FormData(dialog.querySelector("form"));
            const labels = tile.keys.map((key) => {
              const label = String(data.get(key) || "").trim();
              const field = formBlock && formIdentifierFields.get(key);
              const embedded = field === "rfNumber" ? rfInCaption(label) : undefined;
              if (field) {
                const entered = String(data.get(`identifier:${field}`) || "");
                if (entered !== originalValues.get(field) || embedded) {
                  identifiers.set(field, normalizeIdentifier(field, entered !== originalValues.get(field) ? entered : embedded));
                }
              }
              return [key, embedded ? "RF" : label];
            });
            tile.labels = Object.fromEntries(labels.filter(([, value]) => value));
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
        if (candidate) {
          [draft[index], draft[candidate.target]] = [draft[candidate.target], draft[index]];
          activeCounterIndex = candidate.target;
        }
      }
      paint();
    });
    document.getElementById("layout-save").onclick = save;
    controls.querySelector("#layout-restore")?.addEventListener("click", () => {
      const choices = [...removed].filter((key) => catalog.has(key)).map((key) => {
        const node = document.createElement("template");
        node.innerHTML = catalog.get(key);
        const caption = node.content.querySelector("[data-tile-caption], strong, button");
        return [escapeHtml(key), escapeHtml((caption?.textContent || node.content.textContent).trim().slice(0, 100))];
      });
      chooseLayoutAction("Вернуть карточку", [...choices, ["cancel", "Отмена"]], (key) => {
        if (!removed.delete(key)) return;
        draft.push({ keys: [key], wide: key === "form:journal" });
        activeCounterIndex = draft.length - 1;
        paint();
      });
    });
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
        if (action === "remove" && aircraft.blocks.some(block => block.usageCounters?.some(rule => rule.workTypeId === active))) {
          showToast("Этот вид выбран в графе формуляра. Сначала измени её настройку."); return;
        }
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
        form.dispatchEvent(new Event("input", { bubbles: true }));
        picker.querySelector("details").open = true;
      }));
    };
    draw();
  }

  function renderShift(editing = false) {
    const aircraft = selectedAircraft();
    if (aircraft.workTemplate && !editing) { renderTemplateWork(aircraft); return; }
    const correction = editing ? aircraft.shifts.find((shift) => shift.id === state.selectedShiftId) : null;
    if (editing && !canCorrectShift(aircraft, correction)) {
      showToast("Показания после этой записи уже изменились");
      navigateBack();
      return;
    }
    const typeRule = usageTypeOverride(aircraft);
    const ruleSource = Object.keys(aircraft.enabledUsageSources || {}).length ? "Правила типа и настройки борта" :
      typeRule ? "Правила типа" : state.sharedGround ? "Общие правила" : "Настройки борта";
    const landingKeys = OPTIONAL_USAGE_TYPES.filter((key) => key !== "arresterHooks" && sourceEnabled(aircraft, key));
    const showHooks = sourceEnabled(aircraft, "arresterHooks");
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
            <label><span>${escapeHtml(usageRule("flight").label)}, часы</span><input name="flightHours" type="number" min="0" step="1"></label>
            <label><span>${escapeHtml(usageRule("flight").label)}, минуты</span><input name="flightMinutes" type="number" min="0" max="59" step="1"></label>
          </div>` : ""}
        </fieldset>
        ${landingKeys.length || showHooks ? `<fieldset><legend>${showHooks ? (landingKeys.length ? "Посадки и зацепы" : "Зацепы") : "Посадки"}</legend>
          ${landingKeys.length ? `<div class="landing-grid">
            ${landingKeys.map((key) => `<label><span>${escapeHtml(usageRule(key).label)}</span><input name="${key}" type="number" min="0"></label>`).join("")}
          </div>` : ""}
          ${showHooks ? `<label><span>${escapeHtml(usageRule("arresterHooks").label)}</span><input name="arresterHooks" type="number" min="0"></label>` : ""}
        </fieldset>` : ""}
        ${customSources(aircraft).some(({ key }) => sourceEnabled(aircraft, key)) ? `<fieldset class="form-grid"><legend>Другие показатели</legend>${customSources(aircraft)
          .filter(({ key }) => sourceEnabled(aircraft, key)).map(customWorkInput).join("")}</fieldset>` : ""}
        <div id="operation-picker"></div>
        <fieldset><legend>${escapeHtml(usageRule("ground").label)}</legend>
          <p class="field-help">Процент и округление берутся из формуляра каждого двигателя.</p>
          <div class="field-pair">${participationControl("leftUseBoard", "Левый · применять данные борта")}${participationControl("rightUseBoard", "Правый · применять данные борта")}</div>
          <div class="field-pair"><label>Левый двигатель, налёт в минутах<input name="leftFlight" type="number" min="0" step="any" placeholder="Минуты"></label>
          <label>Правый двигатель, налёт в минутах<input name="rightFlight" type="number" min="0" step="any" placeholder="Минуты"></label></div>
          <div class="field-pair">
            <label><span>Левый двигатель, фактически</span><div class="input-with-unit"><input id="left-ground" name="leftGround" type="number" min="0"><span>мин</span></div></label>
            <label><span>Правый двигатель, фактически</span><div class="input-with-unit"><input id="right-ground" name="rightGround" type="number" min="0"><span>мин</span></div></label>
            <div id="left-calculation" class="calculation-preview"></div>
            <div id="right-calculation" class="calculation-preview"></div>
          </div>
          <div class="field-pair">
            <label><span>Запуски левого двигателя</span><input name="leftStarts" type="number" min="0"></label>
            <label><span>Запуски правого двигателя</span><input name="rightStarts" type="number" min="0"></label>
          </div>
        </fieldset>
        <fieldset><legend>${escapeHtml(usageRule("maximum").label)}</legend>
          <div class="field-pair"><label>Левый двигатель, секунды<input name="leftMaximum" type="number" min="0"></label><label>Правый двигатель, секунды<input name="rightMaximum" type="number" min="0"></label></div>
          <div class="field-pair"><label>Форсаж левого двигателя, секунды<input name="leftAfterburner" type="number" min="0"></label><label>Форсаж правого двигателя, секунды<input name="rightAfterburner" type="number" min="0"></label></div>
        </fieldset>
        <fieldset><legend>Режимы левого двигателя</legend>
          <p class="field-help">Вложенные счётчики сохраняются отдельно: Б уже включает ОР, а Б + УБ уже включает Б и ОР.</p>
          <div class="mode-grid"><label><span>ОР</span><input name="leftOrMode" type="time" step="1"></label><label><span>Б, включая ОР</span><input name="leftCombatMode" type="time" step="1"></label><label><span>Б + УБ, включая Б и ОР</span><input name="leftCombinedMode" type="time" step="1"></label></div>
        </fieldset>
        <fieldset><legend>Режимы правого двигателя</legend>
          <div class="mode-grid"><label><span>ОР</span><input name="rightOrMode" type="time" step="1"></label><label><span>Б, включая ОР</span><input name="rightCombatMode" type="time" step="1"></label><label><span>Б + УБ, включая Б и ОР</span><input name="rightCombinedMode" type="time" step="1"></label></div>
        </fieldset>
        ${additionalShiftEngines(aircraft).map(([prefix, block]) => `
          <fieldset class="form-grid"><legend>${escapeHtml(block.name)}</legend>${participationControl(prefix + "UseBoard", "Применять данные борта")}
            <label>${escapeHtml(usageRule("ground").label)}, минут<input name="${prefix}Ground" type="number" min="0"></label>
            <label>Налёт двигателя, минут<input name="${prefix}Flight" type="number" min="0" step="any" placeholder="Минуты"></label>
            <label>Запуски<input name="${prefix}Starts" type="number" min="0"></label>
            <label>${escapeHtml(usageRule("maximum").label)}, секунды<input name="${prefix}Maximum" type="number" min="0"></label>
            <label>Форсаж, секунды<input name="${prefix}Afterburner" type="number" min="0"></label>
            <div class="mode-grid">
              <label>ОР<input name="${prefix}OrMode" type="time" step="1"></label>
              <label>Б, включая ОР<input name="${prefix}CombatMode" type="time" step="1"></label>
              <label>Б + УБ, включая Б и ОР<input name="${prefix}CombinedMode" type="time" step="1"></label>
            </div>
          </fieldset>`).join("")}
        ${aggregateManualInputs(aircraft)}
        <section id="shift-summary" class="shift-summary"></section>
        <button type="submit" class="primary-button wide">Сохранить работу</button>
      </form>
    `, { title: "Учёт работы", subtitle: `${aircraft.type} · борт ${aircraft.boardNumber}`, back: true, settingsScope: "aircraft" });
    bindShiftForm(correction);
  }

  function participationControl(name, label) {
    return `<label class="checkbox-row"><input type="checkbox" name="${escapeHtml(name)}" value="yes"><span>${escapeHtml(label)}</span></label>`;
  }

  function templateFieldMarkup(field) {
    const attributes = field.type === "count" ? 'type="number" step="1" min="0"' :
      `type="text" maxlength="12" placeholder="${field.format === "HH:MM:SS" ? "00:00:00" : "00:00"}"`;
    return `<label>${escapeHtml(field.label)}<input data-template-field="${field.id}" ${attributes}></label>`;
  }

  function templateScopeMarkup(template, scope, position = null) {
    const inputs = template.inputs.filter((field) => field.scope === scope);
    const groups = new Map(template.repeatGroups.map((group) => [group.id, group]));
    const renderedGroups = new Set();
    const fields = inputs.map((field) => {
      if (!field.group) return templateFieldMarkup(field);
      if (renderedGroups.has(field.group)) return "";
      renderedGroups.add(field.group);
      const group = groups.get(field.group);
      return `<section class="template-repeat" data-template-group="${group.id}">
        <strong>${escapeHtml(group.label)}</strong>
        <div class="template-rows"></div>
        <button type="button" class="secondary-button" data-template-add>Добавить строку</button>
      </section>`;
    });
    return `<fieldset class="template-scope" data-template-scope="${position?.id || "board"}">
      <legend>${escapeHtml(position?.label || "Данные борта")}</legend>
      ${position ? participationControl("use-board:" + position.id, "Участвовал · применять данные борта") : ""}
      <div class="field-pair template-inputs">${fields.join("")}</div>
    </fieldset>`;
  }

  function resolveTemplateBlock(aircraft, position, date) {
    const candidates = aircraft.blocks.filter((block) => block.kind === position.kind &&
      block.templateSlotId === position.id && blockInstalledOn(block, date));
    return candidates.length === 1 ? candidates[0] : null;
  }

  function linkedWorkEntries(aircraft, template, engines, date, flow) {
    const blocks = new Map(aircraft.blocks.map((block) => [block.id, block]));
    return template.positions.filter((position) => position.engineLink).flatMap((position) => {
      const engine = engines.find((entry) => entry.slotId === position.engineLink.source);
      const engineBlock = blocks.get(engine?.blockId);
      const block = resolveTemplateBlock(aircraft, position, date);
      if (!engineBlock || !block || blockInstallationOn(block, date) !== blockInstallationOn(engineBlock, date)) return [];
      const fields = aircraftTemplates.positionCounters(template, position);
      const counters = Object.fromEntries(fields.map(({ id }) => [id, engine.counters[id]]));
      if (!Object.values(counters).some((value) => value != null)) return [];
      for (const field of fields.filter(item => counters[item.id] != null)) {
        const unit = field.type === "duration" ? "с" : "шт.";
        flow.push({ owner: block.id, ownerName: block.name, output: `position:${position.id}:${field.id}`,
          name: field.label, amount: counters[field.id], unit, inputs: [{ key: `position:${engine.slotId}:${field.id}`,
            source: engine.blockName + " · " + field.label, value: counters[field.id], unit }] });
      }
      return [{ slotId: position.id, blockId: block.id, counters,
        repairNumber: countsTowardPpr(block, date) ? block.repairs : null }];
    });
  }

  function renderTemplateWork(aircraft) {
    const stored = aircraft.workTemplate;
    const inputs = stored.inputs.filter((field) => !field.role || sourceEnabled(aircraft, field.role))
      .map((field) => field.role ? { ...field, label: usageRule(field.role, aircraft).label } : field);
    for (const role of OPTIONAL_USAGE_TYPES) {
      if (sourceEnabled(aircraft, role) && !inputs.some((field) => field.role === role)) {
        inputs.push({ id: `board-extra-${role}`, scope: "board", type: "count", format: "count", role, label: usageRule(role, aircraft).label });
      }
    }
    const template = { ...stored, inputs, repeatGroups: stored.repeatGroups.filter((group) => inputs.some((field) => field.group === group.id)) };
    const positions = template.positions.filter((position) => position.kind === "engine");
    const flightField = aircraftTemplates.engineFlightInput(template);
    app.innerHTML = shell(`
      <h1>${escapeHtml(template.workTitle)}</h1>
      <form id="template-work-form" class="shift-form">
        <div id="operation-picker"></div>
        <label>Дата работы<input name="date" type="date" required value="${todayIso()}"></label>
        ${templateScopeMarkup(template, "board")}
        ${customSources(aircraft).some(({ key }) => sourceEnabled(aircraft, key)) ? `<fieldset class="form-grid"><legend>Другие показатели</legend>${customSources(aircraft)
          .filter(({ key }) => sourceEnabled(aircraft, key)).map(customWorkInput).join("")}</fieldset>` : ""}
        ${positions.map((position) => templateScopeMarkup(template, "engine", position)).join("")}
        ${aggregateManualInputs(aircraft)}
        <section id="template-preview" class="shift-summary" aria-live="polite"></section>
        <button class="primary-button" type="submit">Сохранить работу</button>
      </form>`, { title: template.workTitle, subtitle: `${aircraft.type} · борт ${aircraft.boardNumber}`, back: true, settingsScope: "aircraft" });
    const form = document.getElementById("template-work-form");
    const preview = document.getElementById("template-preview");
    const scopes = new Map([...form.querySelectorAll("[data-template-scope]")].map((element) => [element.dataset.templateScope, element]));
    bindOperationPicker(aircraft);
    bindAggregateManualInputs(form, aircraft);
    function addRow(group) {
      const inputs = template.inputs.filter((field) => field.group === group.dataset.templateGroup);
      group.querySelector(".template-rows").insertAdjacentHTML("beforeend", `<div class="field-pair template-row" data-template-row>
        ${inputs.map(templateFieldMarkup).join("")}
        <button type="button" class="small-button" data-template-remove>Убрать строку</button>
      </div>`);
    }
    form.querySelectorAll("[data-template-group]").forEach(addRow);
    const inputValues = (element) => Object.fromEntries([...element.querySelectorAll(":scope > label > [data-template-field]")]
      .map((input) => [input.dataset.templateField, input.value.trim()]));
    function readScope(element) {
      return {
        fields: inputValues(element.querySelector(".template-inputs")),
        groups: Object.fromEntries([...element.querySelectorAll("[data-template-group]")].map((group) => [
          group.dataset.templateGroup, [...group.querySelectorAll("[data-template-row]")].map(inputValues)
            .filter((row) => Object.values(row).some(Boolean)),
        ])),
      };
    }
    function calculate() {
      const date = form.elements.date.value;
      const boardInputs = readScope(scopes.get("board"));
      const data = new FormData(form);
      const flow = [];
      const boardResult = aircraftTemplates.calculate(template, boardInputs, "board", { partial: true });
      const boardValues = boardResult.values;
      const inactive = new Set(aircraft.blocks.filter(block => block.kind === "engine" && !hasManualReading(block, data)).map(block => block.id));
      const boardUsage = Object.fromEntries(template.inputs.filter(({ role, id }) => role && boardValues[id] != null)
        .map(({ role, id }) => [role, boardValues[id]]));
      const boardField = template.inputs.find(field => field.role === "flight");
      for (const field of template.inputs.filter(item => item.role && boardValues[item.id] != null)) {
        const unit = field.type === "duration" ? "с" : "шт.";
        flow.push({ output: "board:" + field.role, name: field.label, unit, amount: boardValues[field.id],
          inputs: [{ key: "raw:board:" + field.id, source: field.label, value: boardValues[field.id], unit }] });
      }
      const engines = positions.map((position) => {
        const raw = readScope(scopes.get(position.id));
        const installed = resolveTemplateBlock(aircraft, position, date);
        const useBoard = data.has("use-board:" + position.id);
        const boardSeconds = installed && useBoard ? boardUsage.flight : null;
        const result = aircraftTemplates.calculate(template, raw, "engine", { field: flightField, boardSeconds, partial: true,
          onResult: (counter, amount, operands, values, inherited) => {
            if (!installed) return;
            const field = template.engineCounters.find(item => item.id === counter);
            flow.push({ owner: installed.id, ownerName: installed.name, output: `position:${position.id}:${counter}`,
              name: field.label, amount, unit: field.type === "duration" ? "с" : "шт.", inputs: operands.map(key => {
                const source = template.inputs.find(item => item.id === key);
                const fromBoard = inherited && key === flightField?.id;
                return { key: fromBoard ? "board:flight" : `raw:${position.id}:${key}`, source: fromBoard ? boardField?.label || "Налёт" : position.label + " · " + source.label,
                  value: values[key], unit: source.type === "duration" ? "с" : "шт." };
              }) });
          } });
        if (flightField) {
          const input = scopes.get(position.id).querySelector(`[data-template-field="${flightField.id}"]`);
          input.placeholder = boardSeconds == null ? flightField.format : `${aircraftTemplates.formatValue(flightField, boardSeconds)} · с борта`;
        }
        const hasInput = Object.values(result.values).some(value => value != null) || !!result.incomplete?.length ||
          hasManualReading(installed, data) || useBoard;
        if (hasInput && installed) inactive.delete(installed.id);
        const block = hasInput ? installed : null;
        return { slotId: position.id, slotLabel: position.label, blockId: block?.id,
          blockName: block?.name, serialNumber: block?.serialNumber, repairNumber: block && countsTowardPpr(block, date) ? block.repairs : null,
          raw, ...result, ...(result.inheritedFlight && { reportedValues: { ...result.values, [flightField.id]: null } }),
          participation: hasInput ? (useBoard ? "board" : "input") : "none", pending: hasInput && !block };
      });
      for (const position of template.positions.filter(item => item.engineLink)) {
        const parent = engines.find(entry => entry.slotId === position.engineLink.source);
        const unit = resolveTemplateBlock(aircraft, position, date);
        if (unit && !parent?.blockId && !hasManualReading(unit, data)) inactive.add(unit.id);
      }
      const work = { date, boardInputs, boardUsage, boardIncomplete: boardResult.incomplete, engines, units: linkedWorkEntries(aircraft, template, engines, date, flow),
        customUsage: readCustomWork(aircraft, data),
        boardFields: template.inputs.filter((field) => field.scope === "board") };
      const sources = templateWorkSources(work);
      const aggregateUsage = aggregateAccruals(aircraft, date, sources, data, null, engines, boardValues, inactive);
      const engineUsage = templateEngineUsage(aircraft, template, work);
      const accruals = resourceAccruals(aircraft, date, sources, engineUsage, aggregateUsage, inactive);
      return { work, aggregateUsage, engineUsage, accruals, flow };
    }
    function update() {
      try {
        const { work, aggregateUsage, accruals } = calculate();
        preview.innerHTML = `<strong>Предпросмотр</strong>${incompleteNotice(template, work.boardIncomplete)}${work.engines.filter(engine => engine.participation !== "none").map((engine) =>
          `<details${engine.pending ? " open" : ""}><summary>${escapeHtml(engine.slotLabel)}${engine.pending ? " · ожидает привязки" : ""}</summary>
            ${engine.inheritedFlight ? "<p>Время в воздухе взято из налёта борта.</p>" : ""}
            ${incompleteNotice(template, engine.incomplete)}${templateCounterValues(template, engine.counters)}
            ${templateCalculationSteps(template, engine.steps)}
          </details>`).join("")}${aggregateAccrualSummary(aggregateUsage)}
          ${accruals.length ? `<details><summary>Расход ресурсов</summary>${accrualSummary(accruals)}</details>` : ""}`;
      } catch (error) {
        preview.textContent = error.message;
      }
    }
    form.addEventListener("input", update);
    form.addEventListener("click", (event) => {
      if (event.target.closest("[data-template-add]")) {
        const group = event.target.closest("[data-template-group]");
        addRow(group);
        group.querySelector("[data-template-row]:last-child input")?.focus();
      } else if (event.target.closest("[data-template-remove]")) {
        event.target.closest("[data-template-row]").remove();
      } else return;
      update();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      let calculated;
      try { calculated = calculate(); }
      catch (error) { preview.textContent = error.message; showToast(error.message); return; }
      const { work, aggregateUsage } = calculated;
      if (!Object.values(work.boardInputs.fields).some(Boolean) && !Object.values(work.boardInputs.groups).some((rows) => rows.length) &&
          !work.customUsage.length && !aggregateUsage.some(entry => !["work:date", "work:type"].includes(entry.sourceKey)) && !work.engines.some((engine) => Object.values(engine.values).some((value) => value != null) || engine.incomplete?.length)) {
        showToast("Введи данные работы");
        return;
      }
      saveTemplateWork(aircraft, calculated, new FormData(form).get("operationType"));
    });
    update();
  }

  function incompleteNotice(template, fields) {
    if (!fields?.length) return "";
    const labels = fields.map(id => template.inputs.find(field => field.id === id)?.label || id);
    return `<p>Неполные строки: ${escapeHtml(labels.join(", "))}. В журнал попадают введённые строки. Итог по неполному показателю остаётся пустым.</p>`;
  }

  function templateCounterValues(template, values) {
    return `<dl class="template-values">${template.engineCounters.map((field) =>
      `<dt>${escapeHtml(field.label)}</dt><dd>${aircraftTemplates.formatValue(field, values[field.id])}</dd>`).join("")}</dl>`;
  }

  function templateCalculationSteps(template, steps) {
    const entries = Object.entries(steps);
    if (!entries.length) return "";
    return `<ul class="accrual-items">${entries.map(([key, step]) => {
      const field = template.engineCounters.find((counter) => counter.id === key);
      const format = (seconds) => aircraftTemplates.formatValue(field, seconds);
      return `<li>${escapeHtml(field.label)}: земля ${format(step.ground)} → ${format(step.rounded)} × ${step.percent}% = ${format(step.credit)}.
        Полёт ${format(step.flight)} + ${format(step.credit)} = ${format(step.flight + step.credit)}.</li>`;
    }).join("")}</ul>`;
  }

  function templateWorkSources(work) {
    const sources = { ...work.boardUsage };
    if (Object.hasOwn(sources, "flight")) sources.flight /= 3600;
    for (const { key, value } of work.customUsage) sources[key] = value;
    return sources;
  }

  function templateEngineUsage(aircraft, template, work) {
    const engineUsage = new Map();
    for (const entry of [...work.engines, ...work.units].filter((item) => item.blockId)) {
      const block = aircraft.blocks.find((item) => item.id === entry.blockId);
      const fields = aircraftTemplates.positionCounters(template, templatePositionFor(aircraft, block));
      const byRole = (role) => entry.counters[fields.find((field) => field.role === role)?.id] ?? 0;
      const modes = { or: byRole("or"), combat: byRole("combat"), combined: byRole("combined") };
      const flowKeys = Object.fromEntries([["engineMinutes", "total"], ["starts", "starts"], ["maximum", "combined"],
        ...Object.keys(modes).map(key => [key, key])].flatMap(([key, role]) => {
          const field = fields.find(item => item.role === role);
          return field && entry.counters[field.id] != null ? [[key, `position:${entry.slotId}:${field.id}`]] : [];
        }));
      engineUsage.set(block, { flowKeys, minutes: byRole("total") / 60, flightMinutes: byRole("flight") / 60, starts: byRole("starts"),
        maximumSeconds: modes.combined, afterburnerSeconds: 0, modes, startsOnly: block.kind === "unit" && onlyStarts(fields) });
    }
    return engineUsage;
  }

  function saveTemplateWork(aircraft, { work, engineUsage, aggregateUsage, accruals, flow }, operationType) {
    const flight = (work.boardUsage.flight || 0) / 60;
    const landings = Object.fromEntries(OPTIONAL_USAGE_TYPES.filter((key) => key !== "arresterHooks")
      .map((key) => [key, work.boardUsage[key] || 0]));
    const arresterHooks = work.boardUsage.arresterHooks || 0;
    const actualLandings = Object.values(landings).reduce((sum, value) => sum + value, 0);
    const coefficients = Object.fromEntries(Object.keys(landings).map((key) => [key, usageRule(key, aircraft).factor]));
    const equivalent = calc.calculateEquivalentLandings(landings, coefficients);
    const backup = structuredClone(aircraft);
    applyWorkUsage(aircraft, { flight, actualLandings, equivalent, arresterHooks, date: work.date, engineUsage, accruals, aggregateUsage, flow, sources: templateWorkSources(work), accrueUnits: false });
    applyAggregateAccruals(aircraft, aggregateUsage);
    const operation = (aircraft.operationTypes || DEFAULT_OPERATION_TYPES).find((item) => item.id === operationType);
    const previous = aircraft.shifts.at(-1);
    if (previous) { delete previous.beforeUsage; delete previous.afterUsage; }
    aircraft.shifts.push({
      id: id(), date: work.date, flightMinutes: flight, operationType, operationLabel: operation?.label, templateWork: work, flow,
      actualLandings, equivalentLandings: equivalent, arresterHooks, landingsByType: landings, accruals, aggregateAccruals: aggregateUsage,
    });
    if (!saveState()) { Object.assign(aircraft, backup); showToast("Не удалось сохранить работу"); return; }
    navigateBack();
    showToast(work.engines.some((engine) => engine.pending) ? "Работа сохранена. Есть данные без привязки двигателя" : "Работа сохранена");
  }

  function bindShiftForm(correction) {
    const form = document.getElementById("shift-form");
    const aircraft = selectedAircraft();
    bindOperationPicker(aircraft, correction?.operationType);
    if (correction) {
      for (const element of form.querySelectorAll("input[name]:not([type=radio])")) {
        if (element.type === "checkbox") element.checked = correction.workInputVersion ? Object.hasOwn(correction.raw, element.name) : element.name.endsWith("UseBoard");
        else element.value = correction.raw[element.name] ?? "";
      }
    }
    const extraEngines = additionalShiftEngines(aircraft);
    bindAggregateManualInputs(form, aircraft);
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
      const engineFlight = override == null || override === "" ? (data.has(side + "UseBoard") ? flight : 0) : Number(override);
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
      const supplied = key => String(data.get(key) ?? "").trim() !== "";
      const hasBoardTime = supplied("flightHours") || supplied("flightMinutes");
      const flow = [];
      const inactive = new Set();
      const left = engineIncrement(data, "left", leftBlock, flight);
      const right = engineIncrement(data, "right", rightBlock, flight);
      const engineUsage = new Map();
      const date = String(data.get("date"));
      for (const [prefix, block, increment] of [["left", leftBlock, left], ["right", rightBlock, right],
        ...extraEngines.map(([key, item]) => [key, item, engineIncrement(data, key, item, flight)])]) {
        if (!block || !blockInstalledOn(block, date)) continue;
        const fields = ["Flight", "Ground", "Starts", "Maximum", "Afterburner", "OrMode", "CombatMode", "CombinedMode"];
        if (!fields.some(key => supplied(prefix + key)) && !data.has(prefix + "UseBoard") && !hasManualReading(block, data)) {
          inactive.add(block.id);
          continue;
        }
        const reportKeys = { starts: "Starts", maximum: "Maximum", afterburner: "Afterburner", or: "OrMode", combat: "CombatMode", combined: "CombinedMode" };
        const reported = Object.keys(reportKeys).filter(key => supplied(prefix + reportKeys[key]));
        if (supplied(prefix + "Ground") || supplied(prefix + "Flight") || (data.has(prefix + "UseBoard") && hasBoardTime)) reported.push("engineMinutes");
        if (reported.includes("engineMinutes")) {
          const inputs = [];
          if (supplied(prefix + "Flight")) inputs.push({ key: "entry:" + prefix + "Flight", source: block.name + " · время в воздухе", value: increment.flightMinutes, unit: "мин" });
          else if (data.has(prefix + "UseBoard") && hasBoardTime) inputs.push({ key: "board:flight", source: usageRule("flight", aircraft).label, value: flight, unit: "мин" });
          if (supplied(prefix + "Ground")) inputs.push({ key: "entry:" + prefix + "Ground", source: block.name + " · время на земле", value: Number(data.get(prefix + "Ground")), unit: "мин" });
          flow.push({ owner: block.id, ownerName: block.name, output: "engine:" + block.id + ":engineMinutes",
            name: "Общая наработка за работу", unit: "мин", amount: increment.totalMinutes, inputs });
        }
        engineUsage.set(block, { reported, useBoard: data.has(prefix + "UseBoard"),
          minutes: increment.totalMinutes, flightMinutes: increment.flightMinutes, ground: increment.ground,
          starts: Number(data.get(`${prefix}Starts`)), maximumSeconds: Number(data.get(`${prefix}Maximum`)) * factor("maximum"),
          afterburnerSeconds: Number(data.get(`${prefix}Afterburner`)), modes: readModes(data, prefix),
        });
      }
      const sources = hasBoardTime && sourceEnabled(aircraft, "flight") ? { flight: flight / 60 } : {};
      for (const key of OPTIONAL_USAGE_TYPES) {
        const value = data.get(key);
        if (value != null && value !== "") sources[key] = Number(value);
      }
      const customUsage = readCustomWork(aircraft, data);
      for (const { key, value } of customUsage) sources[key] = value;
      const sourceBoard = correction ? { ...aircraft, resources: aircraft.resources.map((resource) => ({
        ...resource, remaining: correction.beforeUsage.resources.find((item) => item.id === resource.id)?.remaining ?? resource.remaining,
      })) } : aircraft;
      const aggregateUsage = aggregateAccruals(aircraft, date, sources, data, engineUsage, null, {}, inactive);
      const accruals = resourceAccruals(sourceBoard, date, sources, engineUsage, aggregateUsage, inactive);
      return { flight, sources, flow, left: engineUsage.get(leftBlock), right: engineUsage.get(rightBlock), engineUsage, accruals, customUsage, aggregateUsage };
    }
    const update = () => {
      const data = new FormData(form);
      let computed;
      try { computed = calculate(data); } catch (error) { document.getElementById("shift-summary").textContent = error.message; return; }
      const { left, right, engineUsage, accruals, aggregateUsage } = computed;
      const equivalent = calc.calculateEquivalentLandings({ runway: data.get("runway"), carrier: data.get("carrier"), touch: data.get("touch"), circuit: data.get("circuit") }, coefficients);
      const describeGround = (usage) => usage
        ? `${usage.ground.actualMinutes} → ${usage.ground.roundedMinutes} мин → ${usage.ground.percent}% = ${formatNumber(usage.ground.contributionMinutes)} мин`
        : "Нет показаний двигателя";
      document.getElementById("left-calculation").textContent = describeGround(left);
      document.getElementById("right-calculation").textContent = describeGround(right);
      document.getElementById("shift-summary").innerHTML = `<span>Будет начислено</span><strong>Левый: ${left ? calc.formatDuration(left.minutes) : "—"} · Правый: ${right ? calc.formatDuration(right.minutes) : "—"}</strong><small>Зачёт посадок: ${equivalent.toLocaleString("ru-RU", { maximumFractionDigits: 6 })}</small>`;
      const otherEngines = [...engineUsage].filter(([block]) => block !== leftBlock && block !== rightBlock);
      if (otherEngines.length) document.getElementById("shift-summary").insertAdjacentHTML("beforeend",
        `<details><summary>Другие двигатели (${otherEngines.length})</summary><ul>${otherEngines.map(([block, usage]) =>
          `<li>${escapeHtml(block.name)} · ${calc.formatDuration(usage.minutes)}</li>`).join("")}</ul></details>`);
      if (accruals.length) document.getElementById("shift-summary").insertAdjacentHTML("beforeend", accrualSummary(accruals));
      if (aggregateUsage.length) document.getElementById("shift-summary").insertAdjacentHTML("beforeend", aggregateAccrualSummary(aggregateUsage));
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
      let computed;
      try { computed = calculate(data); } catch (error) { showToast(error.message); return; }
      const { flight, left, right, engineUsage, accruals, customUsage, aggregateUsage } = computed;
      if (!["flightHours", "flightMinutes", ...OPTIONAL_USAGE_TYPES].some(key => data.has(key) && data.get(key) !== "") &&
          !engineUsage.size && !customUsage.length && !aggregateUsage.some(row => !["work:date", "work:type"].includes(row.sourceKey))) {
        showToast("Введи хотя бы одно показание"); return;
      }
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

      const flow = computed.flow;
      applyWorkUsage(aircraft, { flight, actualLandings, equivalent, arresterHooks, date, engineUsage, accruals, aggregateUsage, flow, sources: computed.sources });
      applyAggregateAccruals(aircraft, aggregateUsage);
      const operation = (aircraft.operationTypes || DEFAULT_OPERATION_TYPES).find((item) => item.id === data.get("operationType"));
      const entry = {
        workInputVersion: 2, flow, id: correction?.id || id(),
        beforeUsage,
        afterUsage: usageSnapshot(aircraft),
        revisions: correction ? [...(correction.revisions || []), {
          correctedAt: new Date().toISOString(), flow: correction.flow, raw: correction.raw, customUsage: correction.customUsage,
          accruals: correction.accruals, engineAccruals: correction.engineAccruals, aggregateAccruals: correction.aggregateAccruals,
        }] : [],
        operationType: operation?.id,
        operationLabel: operation?.label,
        raw: Object.fromEntries(data),
        customUsage,
        sourceLabels: Object.fromEntries(usageSources(aircraft).map(({ key, label }) => [key, label])),
        accruals,
        aggregateAccruals: aggregateUsage,
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

  function applyWorkUsage(aircraft, { flight, actualLandings, equivalent, arresterHooks, date, engineUsage, accruals, aggregateUsage, flow, sources, accrueUnits = true }) {
    const airframe = aircraft.blocks.find(block => block.kind === "airframe");
    const amounts = new Map((aggregateUsage || []).filter(entry => entry.blockId === airframe?.id).map(entry => [entry.counterId, entry.amount]));
    const increments = { totalFlightMinutes: flight, actualLandings, pprFlightMinutes: flight, pprLandings: actualLandings };
    for (const rule of airframe?.usageCounters || []) {
      if (rule.boardCounter) increments[rule.boardCounter] = (amounts.get(rule.id) ?? 0) *
        aircraftTemplates.unitScale(rule.unit, aircraftTemplates.boardCards[rule.boardCounter].unit);
    }
    const landingInputs = OPTIONAL_USAGE_TYPES.filter(key => key !== "arresterHooks" && Object.hasOwn(sources, key))
      .map(key => ({ key: "board:" + key, source: usageRule(key, aircraft).label, value: sources[key], unit: "пос." }));
    if (landingInputs.length) flow.push({ output: "work:landings", name: "Сумма посадок за работу", amount: actualLandings, unit: "пос.", inputs: landingInputs });
    function postBalance(key) {
      const spec = aircraftTemplates.boardCards[key];
      const previous = aircraft[key] ?? 0;
      aircraft[key] = previous + increments[key];
      const rule = airframe?.usageCounters?.find(item => item.boardCounter === key);
      const input = rule ? amounts.has(rule.id) && { key: aggregateResourceKey(rule.id), source: rule.name, value: amounts.get(rule.id), unit: rule.unit } :
        spec.source === "board:flight" ? Object.hasOwn(sources, "flight") && { key: spec.source, source: usageRule("flight", aircraft).label, value: sources.flight, unit: "ч" } :
        landingInputs.length && { key: spec.source, source: "Сумма посадок за работу", value: actualLandings, unit: "пос." };
      if (input) flow.push({ output: "balance:" + key, name: spec.name, amount: aircraft[key], previous, unit: spec.unit, inputs: [input] });
    }
    postBalance("totalFlightMinutes");
    postBalance("actualLandings");
    aircraft.equivalentLandings = Math.round((aircraft.equivalentLandings + equivalent) * 1e6) / 1e6;
    const previousHooks = aircraft.arresterHooks;
    aircraft.arresterHooks += arresterHooks;
    if (Object.hasOwn(sources, "arresterHooks")) flow.push({ output: "balance:arresterHooks", name: usageRule("arresterHooks", aircraft).label,
      amount: aircraft.arresterHooks, previous: previousHooks, unit: "шт.", inputs: [{ key: "board:arresterHooks", source: usageRule("arresterHooks", aircraft).label, value: arresterHooks, unit: "шт." }] });
    if (countsTowardPpr(airframe, date) || (!airframe && (aircraft.pprFlightMinutes != null || aircraft.pprLandings != null))) {
      postBalance("pprFlightMinutes");
      postBalance("pprLandings");
    }
    function recordBalance(block, field, label, previous, unit, input) {
      if (input) flow.push({ owner: block.id, ownerName: block.name, output: "balance:" + block.id + ":" + field,
        name: label, previous: previous ?? 0, amount: block[field], unit, inputs: [input] });
    }
    const landingInput = landingInputs.length && { key: "work:landings", source: "Сумма посадок за работу", value: actualLandings, unit: "пос." };
    function addBlockUsage(block, minutes, landings, afterRepair, minuteSource, landingSource) {
      function add(field, label, amount, unit, input) {
        const previous = block[field] || 0;
        block[field] = previous + amount;
        recordBalance(block, field, label, previous, unit, input);
      }
      add("sneMinutes", "Наработка СНЭ", minutes, "мин", minuteSource);
      if (afterRepair) add("pprMinutes", "Наработка ППР", minutes, "мин", minuteSource);
      if (landings != null) {
        add("sneLandings", "Посадки СНЭ", landings, "пос.", landingSource);
        if (afterRepair) add("pprLandings", "Посадки ППР", landings, "пос.", landingSource);
      }
    }
    for (const [block, usage] of engineUsage) {
      const { minutes, starts, maximumSeconds: maximum, afterburnerSeconds: afterburner, modes, startsOnly } = usage;
      const input = (key, value, unit) => {
        const source = usage.flowKeys?.[key] || (usage.reported?.includes(key) && "engine:" + block.id + ":" + key);
        return source && { key: source, source: block.name + " · " + ENGINE_SOURCES[key], value, unit };
      };
      const beforeStarts = block.starts, beforePprStarts = block.pprStarts;
      const afterRepair = countsTowardPpr(block, date);
      block.starts = (block.starts || 0) + starts;
      if (afterRepair) block.pprStarts = (block.pprStarts || 0) + starts;
      const startsInput = input("starts", starts, "зап.");
      recordBalance(block, "starts", "Запуски СНЭ", beforeStarts, "зап.", startsInput);
      if (afterRepair) recordBalance(block, "pprStarts", "Запуски ППР", beforePprStarts, "зап.", startsInput);
      if (startsOnly) continue;
      const landings = block.kind === "engine" ? (aircraft.workTemplate ? 0 : actualLandings) : null;
      addBlockUsage(block, minutes, landings, afterRepair, input("engineMinutes", minutes, "мин"), !aircraft.workTemplate && landingInput);
      block.maximumSeconds = (block.maximumSeconds || 0) + maximum;
      block.afterburnerSeconds = (block.afterburnerSeconds || 0) + afterburner;
      accumulateModes(block.modesSeconds ??= {}, modes);
      if (afterRepair) {
        block.pprMaximumSeconds = (block.pprMaximumSeconds || 0) + maximum;
        block.pprAfterburnerSeconds = (block.pprAfterburnerSeconds || 0) + afterburner;
        accumulateModes(block.pprModesSeconds ??= {}, modes);
      }
    }
    for (const block of aircraft.blocks) {
      if (accrueUnits && block.kind === "unit" && !Array.isArray(block.usageCounters) && blockInstalledOn(block, date)) {
        addBlockUsage(block, flight, actualLandings, countsTowardPpr(block, date),
          Object.hasOwn(sources, "flight") && { key: "board:flight", source: usageRule("flight", aircraft).label, value: sources.flight, unit: "ч" }, landingInput);
      }
    }
    for (const entry of accruals) {
      const resource = aircraft.resources.find((item) => item.id === entry.resourceId);
      resource.remaining = entry.remaining;
      resource.status = resourceStatus(resource.remaining, resource.limit);
    }
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

  function accumulateModes(totals, modes) {
    for (const [key, seconds] of Object.entries(modes)) totals[key] = (totals[key] || 0) + seconds;
  }

  function renderAircraftSettings() {
    const aircraft = selectedAircraft();
    const blockRows = aircraft.blocks.map((block) => `
      <div class="setting-row block-setting-row">
        <span><strong>${escapeHtml(block.name)}</strong>${componentSerialLine(block)}${block.caption ? `<small>${escapeHtml(block.caption)}</small>` : ""}</span>
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
      ${aircraft.workTemplate ? '<button type="button" class="setting-row" id="export-board-template"><span><strong>Экспортировать шаблон борта</strong><small>Позиции, показатели, правила расчёта и раскладка карточек</small></span></button>' : ""}
      ${aircraft.workTemplate ? '<button type="button" class="setting-row" id="export-starting-aircraft"><span><strong>Экспортировать борт с показаниями</strong><small>Текущие показания и остатки станут стартовыми. История работ не переносится.</small></span></button>' : ""}
      ${aircraftImportControls()}
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

    bindTemplateImport();
    document.getElementById("export-board-template")?.addEventListener("click", () => exportTemplate(boardTemplate(aircraft)));
    document.getElementById("export-starting-aircraft")?.addEventListener("click", () => {
      try {
        const file = exportStartingAircraft(aircraft);
        const suffix = aircraft.boardNumber.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 39);
        downloadAircraftFile(file, suffix ? `aircraft-${suffix}.json` : "aircraft.json");
      } catch (error) { showToast(error.message); }
    });
    document.getElementById("aircraft-notifications").addEventListener("change", (event) => {
      if (!setBoardNotifications(aircraft, event.target.checked)) { render(); return; }
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
    const key = selected.trim().toLowerCase();
    const types = state.aircraftTypes.filter((name) => !isArchivedType(name) || name.toLowerCase() === key);
    const removed = state.removedAircraftTypes.includes(key);
    if (removed) types.push(selected);
    return `<select name="type" required><option value="">Выбрать тип</option>${types.map((name) =>
      `<option value="${escapeHtml(name)}" ${name.toLowerCase() === key ? "selected" : ""}>${escapeHtml(name)}${removed && name === selected ? " · удалён из справочника" : ""}</option>`
    ).join("")}</select>`;
  }

  function renderBoardDetails() {
    const aircraft = selectedAircraft();
    app.innerHTML = shell(`<h1>Реквизиты борта</h1>
      <form id="board-details-form" class="shift-form settings-form">
        <div class="field-tiles">
          ${aircraft.workTemplate ? `<label>Тип самолёта<output>${escapeHtml(aircraft.type)}</output></label>` :
            `<label>Тип самолёта${aircraftTypeSelect(aircraft.type)}</label>`}
          <label>Бортовой номер<input name="boardNumber" type="text" value="${escapeHtml(aircraft.boardNumber)}" required></label>
          <label>Заводской номер<input name="serialNumber" type="text" value="${escapeHtml(aircraft.serialNumber || "")}"></label>
          <label>RF<input name="rfNumber" type="text" value="${escapeHtml(aircraft.rfNumber || "")}" placeholder="33738"></label>
        </div>
        <p id="board-details-status" class="field-help" role="status"></p>
        <button class="primary-button" type="submit">Сохранить реквизиты</button>
      </form>`, { title: "Реквизиты борта", subtitle: "", back: true, settings: false });
    const form = document.getElementById("board-details-form");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, value.trim()]));
      if (aircraft.workTemplate) data.type = aircraft.type;
      const status = document.getElementById("board-details-status");
      if (!(data.type.toLowerCase() === aircraft.type.trim().toLowerCase() || activeAircraftTypes().includes(data.type)) || !data.boardNumber) {
        status.textContent = "Укажи тип и бортовой номер.";
        return;
      }
      if (data.type !== aircraft.type && state.templateCatalog.some((item) => item.name === data.type)) {
        status.textContent = "Для шаблона создай новый борт, чтобы получить его формуляры.";
        return;
      }
      data.rfNumber = normalizeIdentifier("rfNumber", data.rfNumber);
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

  let addingFormColumn = false;
  let focusedFormColumn;
  function renderAggregateRules() {
    const aircraft = selectedAircraft();
    const block = aircraft.blocks.find(({ id }) => id === state.selectedBlockId);
    if (!block) { navigateBack(); return; }
    app.innerHTML = shell(`<form id="aggregate-rules-form" class="shift-form settings-form">
      <fieldset><legend>${escapeHtml(block.name)}</legend>${aggregateRuleFields()}</fieldset>
      <p class="form-error" role="alert"></p>
      <button type="submit" class="primary-button">Сохранить</button>
    </form>`, { title: "Учёт наработки", singleLine: true, back: true, settings: false });
    const form = document.getElementById("aggregate-rules-form");
    const editor = bindAggregateRules(form, aircraft, block);
    const initial = JSON.stringify(editor.draft());
    if (addingFormColumn) {
      addingFormColumn = false;
      form.querySelector("[data-aggregate-rule-add]").click();
      form.querySelector("[data-aggregate-rules] > :last-child [data-rule=name]")?.focus();
    }
    if (focusedFormColumn) {
      const row = [...form.querySelectorAll("[data-rule-id]")].find(item => item.dataset.ruleId === focusedFormColumn);
      focusedFormColumn = null;
      row?.querySelector("[data-rule=source]")?.focus();
      row?.scrollIntoView({ block: "start" });
    }
    leaveAggregateRules = () => {
      if (JSON.stringify(editor.draft()) === initial) {
        leaveAggregateRules = null;
        return false;
      }
      if (!app.querySelector("dialog[open]")) {
        chooseLayoutAction("Сохранить изменения учёта наработки?",
          [["save", "Сохранить"], ["discard", "Выйти без сохранения"], ["cancel", "Остаться"]], (action) => {
            if (action === "save") form.requestSubmit();
            if (action === "discard") {
              leaveAggregateRules = null;
              finishBackNavigation();
            }
          });
      }
      return true;
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const previousRules = block.usageCounters;
      const previousTotals = block.usageTotals;
      try {
        const rows = editor.read();
        block.usageCounters = storedCounterRules(rows);
        block.usageTotals = initialCounterTotals(rows, previousTotals);
        if (!saveState()) throw new Error("Не удалось сохранить учёт наработки");
      } catch (error) {
        block.usageCounters = previousRules;
        block.usageTotals = previousTotals;
        form.querySelector(".form-error").textContent = error.message;
        return;
      }
      leaveAggregateRules = null;
      finishBackNavigation();
      showToast("Учёт наработки сохранён");
    });
  }

  function aggregateFormLog(aircraft, block) {
    const counters = (block.usageCounters || []).map((rule) => {
      const totals = block.usageTotals?.[rule.id];
      const workType = rule.workTypeId && (aircraft.operationTypes || DEFAULT_OPERATION_TYPES).find(item => item.id === rule.workTypeId);
      const condition = workType ? `<small>Из работ: ${escapeHtml(workType.label)}</small>` : "";
      const formulaButton = `<button type="button" class="small-button" data-column-rule="${escapeHtml(rule.id)}">Связи графы</button>`;
      if (rule.boardCounter) {
        const value = aircraft[rule.boardCounter];
        const formatted = value == null ? "—" : aircraftTemplates.boardCards[rule.boardCounter].unit === "мин" ? flightCounterValue(value) : formatNumber(value, 6);
        return `<article class="metric" data-form-widget="aggregate-counter:${escapeHtml(rule.id)}"><span data-tile-caption>${escapeHtml(rule.name)}</span>
          <strong>${escapeHtml(formatted)}</strong>${condition}${formulaButton}</article>`;
      }
      if (rule.workMode === "entry") {
        const last = aircraft.shifts.flatMap(shift => (shift.aggregateAccruals || [])
          .filter(entry => entry.blockId === block.id && entry.counterId === rule.id).map(entry => ({ date: shift.date, value: entry.textValue ?? entry.amount })))
          .sort((a, b) => a.date.localeCompare(b.date)).at(-1);
        return `<article class="metric" data-form-widget="aggregate-counter:${escapeHtml(rule.id)}"><span data-tile-caption>${escapeHtml(rule.name)}</span>
          <strong>${last ? escapeHtml(formValue(last.value, rule.unit)) : "—"}</strong><small>${escapeHtml(rule.sourceLabel || "Из записи о работе")}</small>${condition}${formulaButton}</article>`;
      }
      return `<article class="metric" data-form-widget="aggregate-counter:${escapeHtml(rule.id)}">
        <span data-tile-caption>${escapeHtml(rule.name)}</span><strong>СНЭ ${formatNumber(totals?.sne || 0, 6)} ${escapeHtml(rule.unit)}</strong>
        ${block.repairs ? `<small>ППР ${formatNumber(totals?.ppr ?? 0, 6)} ${escapeHtml(rule.unit)}</small>` : ""}${condition}${formulaButton}
      </article>`;
    }).join("");
    const entries = aircraft.shifts.slice().reverse().flatMap((shift) => (shift.aggregateAccruals || [])
      .filter((entry) => entry.blockId === block.id)
      .map((entry) => `<li><strong>${formatDate(shift.date)} · ${escapeHtml(entry.name)}</strong>
        ${aggregateAccrualCalculation(entry)}</li>`));
    return `
      <button type="button" class="secondary-button" data-form-widget="aggregate-settings" data-view="block-usage-rules">Настроить учёт наработки</button>
      ${counters}
      ${entries.length ? `<details data-form-widget="aggregate-log"><summary>Журнал наработки</summary><ul class="accrual-items">${entries.join("")}</ul></details>` : ""}`;
  }

  function repairAggregateBalances(rows = []) {
    return rows.map(({ name, unit, sne, ppr }) => {
      const value = (amount) => amount == null ? "—" : `${formatNumber(amount, 6)} ${escapeHtml(unit)}`;
      return `<span>${escapeHtml(name)} до ремонта · СНЭ ${value(sne)} · ППР ${value(ppr)}</span>`;
    }).join("");
  }

  function renderBlock(layoutEditing = false) {
    const aircraft = selectedAircraft();
    const block = aircraft.blocks.find((item) => item.id === state.selectedBlockId);
    if (!block) {
      state.view = "aircraft";
      renderAircraft();
      return;
    }
    const repaired = block.repairs > 0;
    const position = templatePositionFor(aircraft, block);
    const logFields = aircraftTemplates.positionCounters(aircraft.workTemplate, position);
    const groundRule = block.groundRule ?? usageTypeOverride(aircraft)?.ground ?? state.sharedGround ?? aircraft.settings;
    const ppr = (value) => repaired && value != null ? value : "—";
    const modeRow = (label, total, sinceRepair, format) => `<div class="metric"><span>${escapeHtml(label)}</span><strong>${format(total || 0)} / ${ppr(sinceRepair == null ? null : format(sinceRepair))}</strong></div>`;
    const hasTypedColumns = block.usageCounters?.some(rule => rule.workMode);
    const hasLegacyReadings = [block.sneMinutes, block.pprMinutes, block.starts, block.sneLandings, block.pprLandings, block.maximumSeconds, block.afterburnerSeconds, ...Object.values(block.modesSeconds || {})].some(Number);
    const legacyUsage = (!hasTypedColumns || hasLegacyReadings) && block.kind !== "airframe" && !logFields.length && (block.kind === "engine" || !Array.isArray(block.usageCounters));
    const blockFields = legacyUsage ? `
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
    const relatedResources = aircraft.resources.filter((resource) => resourceFormOwner(aircraft, resource) === block);
    const availableResources = aircraft.resources.filter((resource) => !relatedResources.includes(resource));
    const assemblies = aircraft.blocks.filter((item) => item.kind !== "airframe");
    const installedAssemblies = assemblies.filter((item) => blockInstalledOn(item, todayIso()));
    const assemblyHistory = assemblies.flatMap((item) =>
      item.events.filter((entry) => entry.type === "install" || entry.type === "dismantle")
        .map((entry) => ({ ...entry, name: item.name })))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const landingCountKeys = new Set(Object.keys(aircraft.initialLandingCounts || {}));
    if (aircraft.workTemplate?.inputs.some(field => field.role === "touch") && sourceEnabled(aircraft, "touch")) landingCountKeys.add("touch");
    const airframeFields = block.kind === "airframe" ? `
      <h2 data-form-widget="airframe-usage-title" aria-label="Наработка планера">Наработка планера</h2>
      <section class="metric-grid" aria-label="Наработка планера">
        <div class="metric"><span>${escapeHtml(usageRule("flight", aircraft).label)} СНЭ</span><strong>${flightCounterValue(aircraft.totalFlightMinutes)}</strong></div>
        <label>${escapeHtml(usageRule("flight", aircraft).label)} ППР<input name="pprFlightMinutes" type="text" pattern="[0-9]{1,9}:[0-5][0-9](:[0-5][0-9])?" title="Часы:минуты или часы:минуты:секунды" value="${aircraft.pprFlightMinutes == null ? "" : calc.formatDuration(aircraft.pprFlightMinutes)}" placeholder="${repaired ? "0:00" : "—"}" ${repaired ? "" : "disabled"}></label>
        <div class="metric"><span>Посадки СНЭ</span><strong>${aircraft.actualLandings}</strong></div>
        <label>Посадки ППР<input name="pprLandings" type="number" min="0" step="1" value="${aircraft.pprLandings ?? ""}" placeholder="${repaired ? "0" : "—"}" ${repaired ? "" : "disabled"}></label>
        <div class="metric landing-count-metric"><span data-tile-caption>Зацепы</span><strong>${aircraft.arresterHooks}</strong></div>
        ${[...landingCountKeys].map((key) =>
          `<div class="metric${key === "touch" ? " landing-count-metric" : ""}" data-form-widget="landing-count-${escapeHtml(key)}"><span data-tile-caption>${escapeHtml(usageRule(key, aircraft).label)}</span><strong>${landingCount(aircraft, key)}</strong></div>`).join("")}
      </section>` : "";
    const installations = block.kind === "airframe" ? `
      <section id="form-installations" class="section-stack settings-section-heading">
        <h2 data-form-widget="assemblies-title">Установленные агрегаты</h2>
        ${installedAssemblies.map((item) => {
          const entry = item.events.filter((event) => event.type === "install" && event.date <= todayIso())
            .sort((a, b) => a.date.localeCompare(b.date)).at(-1);
          return `<div class="form-assembly" data-form-widget="assembly:${escapeHtml(item.id)}">
            <button type="button" class="form-assembly-open" data-block-id="${escapeHtml(item.id)}">
              <strong data-tile-caption>${escapeHtml(item.name)}</strong>
              ${componentSerialLine(item)}
              <small>${entry ? `Установлен ${formatOptionalDate(entry.date)}${entry.note ? ` · ${escapeHtml(entry.note)}` : ""}` : "Установлен"}</small>
            </button>
            <button type="button" class="small-button danger-button" data-dismantle-block="${escapeHtml(item.id)}">Демонтировать</button>
          </div>`;
        }).join("") || '<p data-form-widget="assemblies-empty">Установленных агрегатов пока нет.</p>'}
        <h2 data-form-widget="installation-history-title">История установок и демонтажа</h2>
        ${assemblyHistory.map((entry, index) => `<article class="history-row" data-form-widget="installation:${escapeHtml(entry.id || String(index))}"><div>
          <strong data-tile-caption>${formatOptionalDate(entry.date)} · ${escapeHtml(entry.name)}</strong>
          <span>${entry.type === "install" ? "Установка" : "Демонтаж"}${entry.note ? ` · ${escapeHtml(entry.note)}` : ""}</span>
        </div></article>`).join("") || '<p data-form-widget="installation-history-empty">Записей пока нет.</p>'}
      </section>` : "";
    const eventLabels = { repair: "Ремонт", dismantle: "Демонтаж", install: "Установка", extension: "Продление ресурса", correction: "Корректировка" };
    const eventRows = block.events.slice().reverse().map((item, index) => {
      const before = item.beforeRepair;
      const counters = before ? [
        before.sneMinutes != null ? `СНЭ ${calc.formatDuration(before.sneMinutes)}` : "",
        before.pprMinutes != null ? `ППР ${calc.formatDuration(before.pprMinutes)}` : "",
        before.starts != null ? `Запуски: ${formatNumber(before.starts)}` : "",
      ].filter(Boolean).join(" · ") : "";
      return `<article class="history-row" data-form-widget="event:${escapeHtml(item.id || String(index))}"><div><strong>${formatOptionalDate(item.date)}</strong>
        <span>${eventLabels[item.type] || "Событие"}${item.note ? ` · ${escapeHtml(item.note)}` : ""}</span>
        ${counters ? `<span>До ремонта: ${counters}</span>` : ""}
        ${repairAggregateBalances(before?.aggregate)}</div></article>`;
    }).join("");
    const historicalRows = Object.entries(block.historicalRepairs || {}).map(([number, entry]) => {
      const before = entry.beforeRepair || {};
      const { sneMinutes, pprMinutes, sneLandings, pprLandings } = before;
      return `<article class="history-row" data-form-widget="repair:${escapeHtml(number)}"><div><strong>Ремонт № ${escapeHtml(number)}${entry.date ? ` · ${formatDate(entry.date)}` : ""}</strong>
        <span>До ремонта · СНЭ: ${sneMinutes == null ? "—" : calc.formatDuration(sneMinutes)}, посадки ${sneLandings ?? "—"}</span>
        <span>ППР: ${pprMinutes == null ? "—" : calc.formatDuration(pprMinutes)}, посадки ${pprLandings ?? "—"}</span>
        ${repairAggregateBalances(before.aggregate)}
        ${entry.note ? `<span>${escapeHtml(entry.note)}</span>` : ""}</div></article>`;
    }).join("");
    app.innerHTML = shell(`
      <section class="page-heading compact"><div><p class="eyebrow">${escapeHtml(aircraft.type)} · борт ${escapeHtml(aircraft.boardNumber)}</p><h1>${escapeHtml(block.name)}</h1></div>
        <button type="button" class="secondary-button" id="add-form-column">+ Графа</button>
        <button type="button" class="secondary-button" id="edit-form-layout">Карточки формуляра</button>
        ${block.kind === "airframe" && !layoutEditing && !Object.keys(aircraftTemplates.boardCards).every(key => block.usageCounters?.some(rule => rule.boardCounter === key)) ? '<button type="button" class="small-button" id="replace-board-counters">Пересоздать карточки СНЭ и ППР</button>' : ""}
      </section>
      ${logFields.length ? templateFormLog(aircraft, block, position, logFields) : ""}
      ${aggregateFormLog(aircraft, block)}
      <section class="section-stack" aria-labelledby="block-resources-title">
        <h2 id="block-resources-title" data-form-widget="resources-title">Ресурсы и работы</h2>
        ${relatedResources.length ? `<div class="resource-list">${resourceRows(relatedResources, { editable: true })}</div>` : '<p data-form-widget="resources-empty">Ресурсы пока не добавлены.</p>'}
        <div class="operation-tags">
          <button type="button" class="secondary-button" data-action="add-resource" data-resource-object="${escapeHtml(block.name)}" data-resource-owner="${escapeHtml(block.id)}">${icon("plus")} Добавить ресурс</button>
          ${availableResources.length ? '<button type="button" class="secondary-button" id="attach-existing-resource">Привязать существующий</button>' : ""}
        </div>
      </section>
      <form id="block-form" class="shift-form">
        <fieldset class="field-tiles"><legend>Реквизиты</legend>
          <label><span>Название</span><input name="name" type="text" value="${escapeHtml(block.name)}" required></label>
          ${block.caption ? `<label><span>Описание</span><input name="caption" type="text" value="${escapeHtml(block.caption)}"></label>` : ""}
          ${block.kind === "airframe" ? `
            <label>Заводской номер<input name="serialNumber" type="text" value="${escapeHtml(aircraft.serialNumber || "")}" placeholder="—"></label>
            <label>RF<input name="rfNumber" type="text" value="${escapeHtml(aircraft.rfNumber || "")}" placeholder="—"></label>` : `
          <label><span>Заводской номер</span><input name="serialNumber" type="text" value="${escapeHtml(block.serialNumber || "")}"></label>
          <label><span>Дата выпуска</span><input name="manufactureDate" type="date" value="${escapeHtml(block.manufactureDate || "")}"></label>
          <label><span>Чертёжный номер</span><input name="drawingNumber" type="text" value="${escapeHtml(block.drawingNumber || "")}"></label>
          <label><span>Установка</span><select name="installed"><option value="true" ${blockInstalledOn(block, todayIso()) ? "selected" : ""}>Установлен</option><option value="false" ${!blockInstalledOn(block, todayIso()) ? "selected" : ""}>Демонтирован</option></select></label>`}
          <label data-form-field="repairs">Ремонтов<output>${block.repairs}</output></label>
          ${block.kind === "unit" ? `<label><span>Модель</span><input name="model" type="text" value="${escapeHtml(block.model || "")}"></label>` : ""}
        </fieldset>
        ${airframeFields}
        ${blockFields}
        ${block.kind === "engine" && legacyUsage ? `<fieldset class="form-grid"><legend>Земная наработка этого двигателя</legend>
          <label>Доля в общей наработке, %<input name="groundPercent" type="number" min="0" max="100" step="any" value="${groundRule.groundPercent}" required></label>
          <label>Шаг округления, минут<input name="groundStep" type="number" min="1" step="1" value="${groundRule.groundRoundingMinutes}" required></label>
          <label class="form-span">Направление<select name="groundDirection">${[["nearest","До ближайшего"],["up","Вверх"],["down","Вниз"]].map(([value, name]) =>
            `<option value="${value}" ${groundRule.groundRoundingDirection === value ? "selected" : ""}>${name}</option>`).join("")}</select></label>
        </fieldset>` : ""}
        <button type="submit" class="primary-button wide">Сохранить формуляр</button>
      </form>
      <button type="button" class="add-block-button" data-view="correct-usage">Уточнить показания</button>
      ${installations}
      <h2 data-form-widget="events-title">История событий</h2>
      <section class="history-list">${(eventRows + historicalRows) || `<p data-form-widget="events-empty">Исторических операций пока нет.</p>`}</section>
      <form id="block-event-form" class="shift-form event-form">
        <fieldset><legend>Добавить событие</legend>
          <div class="field-pair"><label><span>Тип события</span><select name="type"><option value="repair">Ремонт</option><option value="dismantle">Демонтаж</option><option value="install">Установка</option><option value="extension">Продление ресурса</option><option value="correction">Корректировка</option></select></label><label><span>Дата</span><input name="date" type="date" value="${todayIso()}" required></label></div>
          <label><span>Цель установки, основание или примечание</span><input name="note" type="text" placeholder="Цель, номер документа или акт"></label>
          <button type="submit" class="secondary-button wide">Записать событие</button>
        </fieldset>
      </form>
    `, { title: block.name, subtitle: "Формуляр объекта", back: true, settings: false });

    const replaceCounters = document.getElementById("replace-board-counters");
    if (replaceCounters) replaceCounters.onclick = () => chooseLayoutAction(
      "Заменить стандартные карточки налёта и посадок СНЭ и ППР на настраиваемые? Показания и записи работ сохранятся. Высота карточек «Зацепы» и «Касания» будет по содержимому.",
      [["replace", "Заменить карточки"], ["cancel", "Отмена"]], action => {
        if (action !== "replace") return;
        const previous = { rules: block.usageCounters, layout: block.formLayout };
        const rules = [...(previous.rules || [])];
        const keys = new Map();
        for (const [target, spec] of Object.entries(aircraftTemplates.boardCards)) {
          let rule = rules.find(item => item.boardCounter === target);
          if (!rule) {
            rule = { id: id(), columnKey: id(), name: spec.name, boardCounter: target, source: spec.source, factor: 1, unit: spec.unit,
              sourceLabel: aggregateUsageSources(aircraft, true).find(item => item.key === spec.source)?.label, workMode: "entry" };
            rules.push(rule);
          }
          keys.set(spec.key, "form:aggregate-counter:" + rule.id);
        }
        block.usageCounters = rules;
        block.formLayout = remapFormLayout(previous.layout || { tiles: layout.layout, hidden: layout.hidden }, key => keys.get(key) || key);
        for (const tile of block.formLayout.tiles) {
          if (tile.keys.every(key => key === "form-metric:2" || key === "form:landing-count-touch")) delete tile.height;
        }
        if (!saveState()) {
          block.usageCounters = previous.rules;
          block.formLayout = previous.layout;
          showToast("Не удалось сохранить карточки");
          return;
        }
        render();
      });
    const layout = prepareFormLayout(aircraft, block, layoutEditing);
    if (layoutEditing) return layout;
    for (const button of app.querySelectorAll("[data-column-rule]")) button.onclick = () => {
      focusedFormColumn = button.dataset.columnRule;
      navigateTo("block-usage-rules");
    };
    document.getElementById("add-form-column").onclick = () => { addingFormColumn = true; navigateTo("block-usage-rules"); };
    for (const button of app.querySelectorAll("[data-dismantle-block]")) {
      button.onclick = () => dismantleFormAssembly(aircraft, button.dataset.dismantleBlock);
    }
    document.getElementById("attach-existing-resource")?.addEventListener("click", () => {
      attachExistingResource(aircraft, block, availableResources);
    });
    document.getElementById("block-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const name = String(data.get("name")).trim();
      if (!name) { showToast("Введи название формуляра"); return; }
      if (data.get("installed") === "true" && !blockInstalledOn(block, todayIso()) && block.templateSlotId &&
          enginePositionOccupied(aircraft, block.templateSlotId, todayIso(), block.id)) {
        showToast("Эта позиция двигателя уже занята");
        return;
      }
      const before = structuredClone(aircraft);
      updateBlockName(aircraft, block, name);
      block.caption = String(data.get("caption") || "").trim();
      if (block.kind === "airframe") {
        aircraft.serialNumber = normalizeIdentifier("serialNumber", String(data.get("serialNumber") || ""));
        aircraft.rfNumber = normalizeIdentifier("rfNumber", String(data.get("rfNumber") || ""));
      } else {
        if (data.has("model")) block.model = String(data.get("model")).trim();
        block.serialNumber = String(data.get("serialNumber") || "").trim();
        if (data.has("manufactureDate")) block.manufactureDate = data.get("manufactureDate");
        block.drawingNumber = String(data.get("drawingNumber") || "").trim();
        const installed = data.get("installed") === "true";
        if (blockInstalledOn(block, todayIso()) !== installed) {
          recordInstallation(block, { id: id(), type: installed ? "install" : "dismantle", date: todayIso(), note: "" });
        }
      }
      if (block.kind === "airframe" && repaired) {
        const pprDuration = data.get("pprFlightMinutes");
        if (data.has("pprFlightMinutes")) aircraft.pprFlightMinutes = pprDuration ? calc.parseClockDuration(pprDuration) / 60 : null;
        if (data.has("pprLandings")) aircraft.pprLandings = data.get("pprLandings") === "" ? null : Number(data.get("pprLandings"));
      } else if (legacyUsage) {
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
      if (type === "install" && block.templateSlotId && enginePositionOccupied(aircraft, block.templateSlotId, item.date, block.id)) {
        showToast("Эта позиция двигателя уже занята на дату установки");
        return;
      }
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
          ...(block.usageCounters?.length && { aggregate: block.usageCounters.filter(rule => rule.workMode !== "entry").map((rule) => ({
            ...rule, ...block.usageTotals?.[rule.id],
          })) }),
        };
        block.repairs += 1;
        for (const rule of block.usageCounters || []) {
          if (rule.workMode === "entry") continue;
          block.usageTotals[rule.id] = { sne: block.usageTotals[rule.id]?.sne ?? 0, ppr: 0 };
        }
        if (block.kind === "airframe") {
          aircraft.pprFlightMinutes = 0;
          aircraft.pprLandings = 0;
        } else if (onlyStarts(logFields)) {
          block.pprStarts = 0;
        } else {
          block.pprMinutes = 0;
          block.pprLandings = 0;
          if (block.kind === "engine" || position?.engineLink) {
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

  let formInputDraft;

  function prepareFormLayout(aircraft, block, editing) {
    const blockForm = document.getElementById("block-form");
    const eventForm = document.getElementById("block-event-form");
    const main = blockForm.closest("main");
    const heading = main.querySelector(".page-heading");
    const edit = heading.querySelector("#edit-form-layout");
    const preview = document.createElement("div");
    preview.id = "counter-preview";
    preview.className = "form-counter-preview";
    const forms = [blockForm, eventForm];
    const catalog = new Map();
    const hiddenFields = new Map();
    const selectors = [
      "[data-form-widget]", "#block-form label", "#block-form .metric", "#block-form button",
      "#block-form fieldset > p", "#block-event-form label", "#block-event-form button",
      ".resource-list .resource-row", '[data-action="add-resource"]', "#attach-existing-resource", '[data-view="correct-usage"]',
    ];
    let metricIndex = 0;
    for (const node of main.querySelectorAll(selectors.join(","))) {
      const eventControl = eventForm.contains(node);
      const resource = node.querySelector("[data-resource-id]");
      const input = node.matches("label") ? node.querySelector("[name]") : null;
      const field = node.dataset.formField || input?.name;
      const action = node.dataset.action || node.dataset.view || node.id || (eventControl ? "save-event" : "save");
      const key = node.dataset.formWidget ? `form:${node.dataset.formWidget}` :
        field ? `${eventControl ? "event-field" : "form-field"}:${field}` :
        resource ? `form-resource:${resource.dataset.resourceId}` :
        node.matches(".metric, p") ? `form-metric:${metricIndex++}` : `form-action:${action}`;
      if (eventControl) (input || node).setAttribute("form", eventForm.id);
      if (node.matches("label")) {
        node.classList.add("form-tile-field");
        let caption = node.querySelector(":scope > span");
        if (!caption) {
          const text = [...node.childNodes].find((item) => item.nodeType === Node.TEXT_NODE && item.textContent.trim());
          if (text) {
            caption = document.createElement("span");
            caption.textContent = text.textContent.trim();
            text.replaceWith(caption);
          }
        }
        if (caption) caption.dataset.tileCaption = "";
      } else if (node.matches("h2, p")) node.dataset.tileCaption = "";
      if (node.matches("button:not([type])")) node.type = "button";
      for (const button of node.querySelectorAll("button:not([type])")) button.type = "button";
      catalog.set(key, node.outerHTML);
      if (input) hiddenFields.set(key, node);
    }

    for (const rule of block.usageCounters || []) {
      if (rule.boardCounter) catalog.delete(aircraftTemplates.boardCards[rule.boardCounter].key);
    }
    const saved = block.formLayout;
    const hidden = (saved?.hidden || []).filter((key) => catalog.has(key));
    const defaultOrder = ["form:journal", "form-field:name", "form-field:caption", ...catalog.keys()];
    const visible = new Set(defaultOrder.filter((key) => catalog.has(key) && !hidden.includes(key)));
    const layout = (saved?.tiles || []).flatMap((tile) => {
      const keys = tile.keys.filter((key) => visible.delete(key));
      return keys.length ? [{ ...tile, keys }] : [];
    });
    for (const key of visible) layout.push({ keys: [key], wide: key === "form:journal" });
    blockForm.replaceChildren(preview);
    eventForm.replaceChildren();
    main.replaceChildren(heading, blockForm, eventForm);
    for (const key of hidden) {
      const field = hiddenFields.get(key);
      if (!field) continue;
      field.hidden = true;
      blockForm.append(field);
    }
    const options = { layout, catalog, formBlock: block, hidden };
    if (editing) return options;
    preview.innerHTML = counterTiles(aircraft, layout, false, catalog);
    restoreFormInputDraft(block);
    const open = (index = 0) => {
      formInputDraft = { blockId: block.id, values: Object.fromEntries(forms.map((form) => [form.id,
        Object.fromEntries([...form.elements].filter((control) => control.name && control.matches("input, select, textarea"))
          .map((control) => [control.name, control.value]))])) };
      activeCounterIndex = index;
      viewStack.push(state.view);
      state.view = "block-layout";
      renderAircraftLayout(options);
    };
    bindTileHold(preview, "block", open);
    edit.onclick = () => open();
    return options;
  }

  function restoreFormInputDraft(block) {
    if (formInputDraft?.blockId !== block.id) return;
    for (const [formId, values] of Object.entries(formInputDraft.values)) {
      const form = document.getElementById(formId);
      for (const [name, value] of Object.entries(values)) {
        const control = form?.elements.namedItem(name);
        if (control) control.value = value;
      }
    }
    if (state.view === "block") formInputDraft = null;
  }

  function dismantleFormAssembly(aircraft, blockId) {
    const block = aircraft.blocks.find((item) => item.id === blockId);
    const date = todayIso();
    if (!block || !blockInstalledOn(block, date)) return;
    chooseLayoutAction(`Демонтировать «${escapeHtml(block.name)}»?`, [["cancel", "Отмена"], ["dismantle", "Демонтировать", "danger-button"]], (action) => {
      if (action !== "dismantle" || !blockInstalledOn(block, date)) return;
      const previous = { installed: block.installed, events: block.events.slice() };
      recordInstallation(block, { id: id(), type: "dismantle", date, note: "" });
      if (!saveState()) {
        Object.assign(block, previous);
        showToast("Не удалось записать демонтаж");
        return;
      }
      render();
      showToast("Демонтаж записан");
    }, `Дата записи — ${formatOptionalDate(date)}. Формуляр и его история сохранятся.`);
  }

  function attachExistingResource(aircraft, block, candidates) {
    const dialog = document.createElement("dialog");
    dialog.className = "confirm-dialog";
    dialog.setAttribute("aria-labelledby", "attach-resource-title");
    dialog.innerHTML = `<form class="shift-form">
      <h2 id="attach-resource-title">Привязать ресурс к «${escapeHtml(block.name)}»</h2>
      <label>Ресурс этого борта<select name="resource" required>
        <option value="">Выбрать ресурс</option>
        ${candidates.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.object)} · ${escapeHtml(item.name)} · ${formatNumber(item.remaining)} ${escapeHtml(item.unit)}</option>`).join("")}
      </select></label>
      <p class="field-help" role="status">При переносе сохраняются остаток и история ресурса.</p>
      <div class="operation-tags">
        <button type="button" class="secondary-button" data-cancel>Отмена</button>
        <button type="submit" class="primary-button" disabled>Привязать</button>
      </div>
    </form>`;
    const form = dialog.querySelector("form");
    const status = form.querySelector("[role='status']");
    const submit = form.querySelector("[type='submit']");
    const allowed = new Set(resourceSources(aircraft, block).map(({ key }) => key));
    function checkSelected() {
      const resource = candidates.find((item) => item.id === form.elements.resource.value);
      if (!resource) {
        submit.disabled = true;
        status.textContent = "При переносе сохраняются остаток и история ресурса.";
        return null;
      }
      const owner = resourceOwner(aircraft, resource);
      const inputs = resourceInputs(resource, owner, aircraft);
      const original = new Map(resourceSources(aircraft, owner).map(({ key, label }) => [key, label]));
      const missing = Object.entries(inputs).filter(([key, factor]) => factor > 0 && !allowed.has(key))
        .map(([key]) => original.get(key) || "удалённый показатель");
      submit.disabled = missing.length > 0;
      status.textContent = missing.length
        ? `Для этого формуляра недоступен расход по показателям: ${missing.join(", ")}. Измените расход в карточке ресурса перед переносом.`
        : `Ресурс будет перенесён из «${resource.object}». Остаток и история сохранятся.`;
      return missing.length ? null : { resource, inputs };
    }
    form.elements.resource.addEventListener("change", checkSelected);
    form.querySelector("[data-cancel]").onclick = () => dialog.close();
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const selection = checkSelected();
      if (!selection) return;
      const { resource, inputs } = selection;
      const previous = aircraft.resources;
      const lastWork = aircraft.shifts.at(-1);
      const preventRecalculation = resource.unit !== "дн." && lastWork?.afterUsage && !lastWork.resourceAssignmentChanged;
      aircraft.resources = previous.map((item) => item === resource
        ? { ...resource, object: block.name, objectId: block.id, consumption: inputs }
        : item);
      if (preventRecalculation) lastWork.resourceAssignmentChanged = true;
      if (!saveState()) {
        aircraft.resources = previous;
        if (preventRecalculation) delete lastWork.resourceAssignmentChanged;
        status.textContent = "Не удалось привязать ресурс. Попробуйте ещё раз.";
        return;
      }
      dialog.close();
      render();
      showToast("Ресурс привязан к формуляру");
    });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    app.append(dialog);
    dialog.showModal();
  }

  function templateFormLog(aircraft, block, position, fields) {
    const startsOnly = onlyStarts(fields);
    const totals = {};
    const repairs = new Map();
    const kind = position.kind === "unit" ? "units" : "engines";
    const items = aircraft.shifts.filter((entry) => entry.templateWork).sort((a, b) => a.date.localeCompare(b.date))
      .flatMap((shift) => (shift.templateWork[kind] || []).filter((entry) => entry.blockId === block.id)
        .map((entry) => ({ date: shift.date, entry })));
    const rows = items.map(({ date, entry }) => {
      const current = repairs.get(entry.repairNumber) || {};
      if (entry.repairNumber != null) repairs.set(entry.repairNumber, current);
      return `<tr><th scope="row">${formatDate(date)}</th>${fields.map((field) => {
        const value = entry.counters[field.id];
        if (value == null) return "<td>—</td>";
        totals[field.id] = (totals[field.id] || 0) + value;
        if (entry.repairNumber != null) current[field.id] = (current[field.id] || 0) + value;
        if (startsOnly) {
          return `<td>${value}</td><td>${totals[field.id]}</td><td>${current[field.id] ?? "—"}</td>`;
        }
        return `<td>${aircraftTemplates.formatValue(field, value)}${field.role === "starts" ? ` / ${aircraftTemplates.formatValue(field,
          entry.repairNumber == null ? totals[field.id] : current[field.id])}` : ""}</td>`;
      }).join("")}</tr>`;
    }).join("");
    const foot = (title, values) => `<tr><th scope="row">${title}</th>${fields.map((field) =>
      `<td>${aircraftTemplates.formatValue(field, values[field.id])}</td>`).join("")}</tr>`;
    const headers = startsOnly ? ["Дата работы", "Запуски", "Сумма СНЭ", "Сумма ППР"] :
      ["Дата работы", ...fields.map((field) => field.label)];
    const summary = startsOnly ? `<tr><th scope="row">Текущие показания</th><td>—</td>
      <td>${block.starts ?? 0}</td><td>${block.repairs ? block.pprStarts ?? 0 : "—"}</td></tr>` :
      `${foot("СНЭ по журналу", totals)}${block.repairs ? foot("ППР по журналу", repairs.get(block.repairs) || {}) : ""}`;
    const engineSource = position.engineLink && aircraft.workTemplate.positions.find((item) => item.id === position.engineLink.source);
    return `<section class="section-stack" data-form-widget="journal"><h2 data-tile-caption>${position.kind === "engine" ? "Записи формуляра двигателя" : "Записи формуляра агрегата"}</h2>
      <p>${engineSource ? `Источник наработки — ${escapeHtml(engineSource.label.toLowerCase())}` :
        `${escapeHtml(position.label)} · ${escapeHtml(position.model)}`}</p>
      <div class="template-table-wrap" tabindex="0"><table class="aircraft-counters template-table">
        <thead><tr>${headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join("")}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${headers.length}">Записей пока нет.</td></tr>`}</tbody>
        <tfoot>${summary}</tfoot>
      </table></div></section>`;
  }

  function renderUsageCorrection() {
    const aircraft = selectedAircraft();
    const block = aircraft.blocks.find((item) => item.id === state.selectedBlockId);
    const airframe = block.kind === "airframe";
    const position = templatePositionFor(aircraft, block);
    const startsOnly = onlyStarts(aircraftTemplates.positionCounters(aircraft.workTemplate, position));
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
    const durationLabel = airframe ? usageRule("flight", aircraft).label : "Наработка";
    const labels = [`${durationLabel} СНЭ, мин`, "Посадки СНЭ", `${durationLabel} ППР, мин`, "Посадки ППР"];
    const counters = startsOnly ? [] : names.flatMap((key, index) => position?.engineLink && index % 2 === 1 ? [] :
      [[key, labels[index], subject[key], index >= 2]]);
    if (block.kind === "engine" || position?.engineLink) {
      const pairs = [["Запуски", "starts", "pprStarts"]];
      if (!startsOnly) pairs.push(
        ["Максимал, с", "maximumSeconds", "pprMaximumSeconds"],
        ...(position?.engineLink ? [] : [["Форсаж, с", "afterburnerSeconds", "pprAfterburnerSeconds"]]),
        ["ОР, с", "modesSeconds.or", "pprModesSeconds.or"], ["Б, с", "modesSeconds.combat", "pprModesSeconds.combat"],
        ["Б + УБ, с", "modesSeconds.combined", "pprModesSeconds.combined"],
      );
      for (const [label, total, ppr] of pairs) {
        counters.push([total, `${label} · СНЭ`, readCounter(total), false], [ppr, `${label} · ППР`, readCounter(ppr), true]);
      }
    }
    const repairs = block.events.filter((entry) => entry.type === "repair");
    let imported = block.historicalRepairs || {};
    const historyNames = { totalFlightMinutes: "sneMinutes", actualLandings: "sneLandings",
      pprFlightMinutes: "pprMinutes", pprLandings: "pprLandings" };
    const counterStep = (key) => key === "starts" || key === "pprStarts" ? "1" : "any";
    const aggregateCounters = (block.usageCounters || []).filter(rule => rule.workMode !== "entry");
    const counterName = (rule, period) => `aggregate-usage:${rule.id}:${period}`;
    const counterFields = (historical) => aggregateCounters.map((rule) => `
      <div class="field-pair" data-aggregate-readings="${escapeHtml(rule.id)}">${["sne", "ppr"].map((period) =>
        `<label>${escapeHtml(rule.name)} · ${period === "sne" ? "СНЭ" : "ППР"}, ${escapeHtml(rule.unit)}
          <input name="${escapeHtml(counterName(rule, period))}" ${!historical && period === "ppr" ? "data-ppr" : ""}
            type="number" min="0" step="any" value="${historical ? "" : block.usageTotals?.[rule.id]?.[period] ?? ""}"></label>`).join("")}</div>`).join("");
    app.innerHTML = shell(`
      <form id="correct-usage-form" class="shift-form">
        <fieldset><legend>Текущие показания · ${escapeHtml(block.name)}</legend>
          <label>Количество ремонтов<input name="repairs" type="number" min="${repairs.length}" step="1" value="${block.repairs}" required></label>
          <div class="field-pair">${counters.map(([key, label, value, isPpr]) => `<label>${escapeHtml(label)}<input name="${key}" ${isPpr ? "data-ppr" : ""} type="number" min="0" step="${counterStep(key)}" value="${value ?? (isPpr ? "" : 0)}"></label>`).join("")}</div>
          ${counterFields(false)}
          <label>Основание или номер документа<input name="note"></label>
          <button class="primary-button" type="submit">Сохранить показания</button>
        </fieldset>
      </form>
      <form id="historical-repair-form" class="shift-form">
        <fieldset ${block.repairs ? "" : "disabled"}><legend>Показания до ремонта</legend>
          <p>Заполни известные данные отдельно для каждого ремонта. Пустое поле означает, что показание неизвестно.</p>
          <label>Ремонт №<input name="number" type="number" min="1" max="${block.repairs}" value="1" required></label>
          <label>Дата ремонта<input name="date" type="date"></label>
          <div class="field-pair">${counters.map(([key, label]) => `<label>${escapeHtml(label)}<input name="${key}" type="number" min="0" step="${counterStep(key)}"></label>`).join("")}</div>
          ${counterFields(true)}
          <label>Основание<input name="note"></label>
          <button class="secondary-button" type="submit">Сохранить запись о ремонте</button>
        </fieldset>
      </form>`, { title: "Уточнить показания", back: true, settings: false });
    const form = document.getElementById("correct-usage-form");
    const update = () => form.querySelectorAll("[data-ppr]").forEach((input) => { input.disabled = Number(form.elements.repairs.value) === 0; });
    form.elements.repairs.addEventListener("input", update);
    update();
    const numberOrNull = (value) => value === "" || value == null ? null : Number(value);
    const readAggregate = (data) => aggregateCounters.map((rule) => ({
      id: rule.id, name: rule.name, unit: rule.unit,
      sne: numberOrNull(data.get(counterName(rule, "sne"))), ppr: numberOrNull(data.get(counterName(rule, "ppr"))),
    }));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const previous = { repairs: block.repairs };
      const current = { repairs: Number(data.get("repairs")) };
      const previousTotals = block.usageTotals;
      for (const [key, , , isPpr] of counters) {
        previous[key] = readCounter(key) ?? null;
        current[key] = isPpr ? numberOrNull(data.get(key)) : Number(data.get(key));
        writeCounter(key, current[key]);
      }
      if (aggregateCounters.length) {
        previous.aggregate = aggregateCounters.map(({ id, name, unit }) => ({ id, name, unit, ...previousTotals?.[id] }));
        current.aggregate = readAggregate(data);
        block.usageTotals = { ...previousTotals, ...Object.fromEntries(current.aggregate.map(({ id, sne, ppr }) =>
          [id, { sne: sne ?? 0, ppr }])) };
      }
      block.repairs = current.repairs;
      block.events.push({ id: id(), type: "correction", date: todayIso(), note: data.get("note"), previous, current });
      if (saveState()) {
        render();
        showToast("Показания сохранены");
      } else {
        block.events.pop();
        block.repairs = previous.repairs;
        if (aggregateCounters.length) block.usageTotals = previousTotals;
        for (const [key] of counters) writeCounter(key, previous[key]);
        showToast("Не удалось сохранить показания");
      }
    });
    const history = document.getElementById("historical-repair-form");
    const findRepair = (number) => imported[number] || repairs.find((item, index) => (item.repairNumber ?? index + 1) === number);
    const loadRepair = () => {
      const number = Number(history.elements.number.value);
      const entry = findRepair(number);
      history.elements.date.value = entry?.date || "";
      history.elements.note.value = entry?.note || "";
      const usage = entry?.beforeRepair || {};
      counters.forEach(([key]) => {
        const [group, entry] = key.split(".");
        history.elements[key].value = usage[key] ?? (entry ? usage[group]?.[entry] : null) ??
          usage[historyNames[key]] ?? "";
      });
      for (const rule of aggregateCounters) {
        const saved = usage.aggregate?.find(({ id }) => id === rule.id);
        for (const period of ["sne", "ppr"]) history.elements[counterName(rule, period)].value = saved?.[period] ?? "";
      }
    };
    history.elements.number.addEventListener("input", loadRepair);
    loadRepair();
    history.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(history);
      const number = Number(data.get("number"));
      const beforeRepair = Object.fromEntries(counters.map(([key]) => [
        historyNames[key] || key, numberOrNull(data.get(key)),
      ]));
      const activeIds = new Set(aggregateCounters.map(({ id }) => id));
      const kept = (findRepair(number)?.beforeRepair?.aggregate || []).filter(({ id }) => !activeIds.has(id));
      const measurements = readAggregate(data).filter(({ sne, ppr }) => sne != null || ppr != null);
      if (measurements.length || kept.length) beforeRepair.aggregate = [...kept, ...measurements];
      block.historicalRepairs = { ...imported, [number]: { date: data.get("date"), note: data.get("note"), beforeRepair } };
      if (saveState()) { imported = block.historicalRepairs; showToast("Показания до ремонта сохранены"); }
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
    if (shift.templateWork) {
      renderTemplateWorkEntry(aircraft, shift);
      return;
    }
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
      ...(!shift.workInputVersion || shift.raw?.flightHours || shift.raw?.flightMinutes ? [[builtIn("flight"), calc.formatDuration(shift.flightMinutes)]] : []),
      ...OPTIONAL_USAGE_TYPES.filter((key) => shift.raw ? key in shift.raw && shift.raw[key] !== "" : key in (shift.landingsByType || {}))
        .map((key) => [builtIn(key), shift.raw?.[key] ?? shift.landingsByType?.[key]]),
      ...customRows,
    ];
    app.innerHTML = shell(`
      <section class="section-stack"><h1>${escapeHtml(shift.operationLabel || "Лётная смена")}</h1><p>${formatDate(shift.date)}</p>
        <details open><summary>Введённые показатели</summary><dl>${rawRows.map(([label, value]) =>
          `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd>`).join("")}</dl></details>
        <details open><summary>Двигатели</summary><ol class="accrual-items">${engines.length ? engines.map((entry) =>
          `<li><strong>${escapeHtml(entry.name)} · ${calc.formatDuration(entry.minutes)}</strong><small>Налёт ${calc.formatDuration(entry.flightMinutes)} · земля ${entry.ground.actualMinutes} → ${entry.ground.roundedMinutes} мин × ${entry.ground.percent}%</small></li>`).join("") :
          shift.workInputVersion ? "<li>Показания двигателей не вводились</li>" : `<li>Левый · ${calc.formatDuration(shift.leftEngineMinutes)}</li><li>Правый · ${calc.formatDuration(shift.rightEngineMinutes)}</li>`}</ol></details>
        <h2>Расход ресурсов</h2>
        ${shift.accruals?.length ? accrualSummary(shift.accruals) : `<p>${shift.accruals ? "Начислений по ресурсам нет." : "Для этой записи разбивка по ресурсам не сохранялась."}</p>`}
        ${aggregateAccrualSummary(shift.aggregateAccruals)}
        <button class="secondary-button" id="open-shift-map">Карта начислений</button>
        ${canCorrectShift(aircraft, shift) ? `<button class="secondary-button" data-view="correct-shift">Исправить запись</button>` : ""}
        ${shift === aircraft.shifts.at(-1) && shift.resourceAssignmentChanged
          ? '<p class="field-help">После записи изменились настройки ресурса. Начисления этой записи сохранены в журнале.</p>' : ""}
        ${shift === aircraft.shifts.at(-1) && shift.beforeUsage && !sameRecordedUsageKinds(aircraft, shift)
          ? `<p class="field-help">Состав или единицы показателей изменились. В журнале сохранены исходные значения этой записи.</p>` : ""}
        ${(shift.revisions || []).map((revision) => `<details><summary>Предыдущая версия · ${escapeHtml(new Date(revision.correctedAt).toLocaleString("ru-RU"))}</summary>
          <p>Налёт: ${calc.formatDuration(Number(revision.raw.flightHours) * 60 + Number(revision.raw.flightMinutes))}</p>
          ${accrualSummary(revision.accruals || [])}${aggregateAccrualSummary(revision.aggregateAccruals)}</details>`).join("")}
      </section>`, { title: "Запись работы", back: true, settings: false });
    document.getElementById("open-shift-map").addEventListener("click", () => {
      state.mapShiftId = shift.id;
      navigateTo("usage-map");
    });
  }

  function renderTemplateWorkEntry(aircraft, shift) {
    const template = aircraft.workTemplate;
    const work = shift.templateWork;
    function rawValues(raw, scope) {
      const fields = scope === "board" && work.boardFields ? work.boardFields : template.inputs.filter((field) => field.scope === scope);
      return fields.map((field) => {
        const values = field.group ? (raw.groups[field.group] || []).map((row, index) => row[field.id] ? `${index + 1}. ${row[field.id]}` : "").filter(Boolean) :
          [raw.fields[field.id]].filter(Boolean);
        const label = field.role === "flight" ? aircraftTemplates.normalizeFlightLabel(field.label) : field.label;
        return values.length ? `<dt>${escapeHtml(label)}</dt><dd>${values.map(escapeHtml).join(" · ")}</dd>` : "";
      }).join("");
    }
    app.innerHTML = shell(`<section class="section-stack">
      <h1>${escapeHtml(shift.operationLabel || template.workTitle)}</h1><p>${formatDate(shift.date)}</p>
      <details open><summary>${escapeHtml(template.workTitle)} · борт</summary><dl class="template-values">${rawValues(work.boardInputs, "board")}</dl></details>
      ${work.customUsage?.length ? `<dl class="template-values">${work.customUsage.map((entry) => `<dt>${escapeHtml(entry.label)}</dt><dd>${entry.seconds == null
        ? formatNumber(entry.value) : aircraftTemplates.formatValue({format: entry.format === "seconds" ? "HH:MM:SS" : "HH:MM"}, entry.seconds)}</dd>`).join("")}</dl>` : ""}
      ${incompleteNotice(template, work.boardIncomplete)}${work.engines.filter(engine => engine.participation !== "none").map((engine) => `<details open><summary>${escapeHtml(engine.blockName || engine.slotLabel)}${engine.serialNumber ? ` · № ${escapeHtml(engine.serialNumber)}` : ""}</summary>
        ${engine.pending ? "<p>Ожидает привязки двигателя на дату работы.</p>" : ""}
        <dl class="template-values">${rawValues(engine.raw, "engine")}</dl>
        ${engine.inheritedFlight ? "<p>Время в воздухе взято из налёта борта.</p>" : ""}
        ${incompleteNotice(template, engine.incomplete)}${templateCounterValues(template, engine.counters)}
        ${templateCalculationSteps(template, engine.steps)}
      </details>`).join("")}
      ${shift.accruals?.length ? accrualSummary(shift.accruals) : ""}
      ${aggregateAccrualSummary(shift.aggregateAccruals)}
    </section>`, { title: "Запись работы", back: true, settings: false });
  }

  function renderUsageMap() {
    const aircraft = selectedAircraft();
    const shift = aircraft.shifts.find((entry) => entry.id === state.mapShiftId);
    if (!shift && state.mapShiftId === "no-work") {
      app.innerHTML = shell(`<section class="section-stack"><h1>Карта начислений</h1><p>Пока нет сохранённых работ. После ввода работы здесь появятся пути её данных.</p>
        <button class="secondary-button" id="map-config">Посмотреть настроенные связи</button></section>`, { title: "Карта наработки", back: true, settings: false });
      document.getElementById("map-config").onclick = () => { state.mapShiftId = null; renderUsageMap(); };
      return;
    }
    const blocks = aircraft.blocks.filter((block) => block.kind !== "airframe");
    const first = aircraft.blocks.find((block) => block.kind === "airframe");
    const boardNode = "__airframe";
    const resources = aircraft.resources.filter((resource) => resource.unit !== "дн.");
    const resourceEdges = shift ? (shift.accruals || []).flatMap((entry) => entry.inputs.map((input) => ({
      ...input, key: input.flowKey || input.key, source: entry.labels?.[input.key] || input.key, output: "resource:" + entry.resourceId,
      target: entry.blockId || boardNode, name: entry.name, unit: entry.unit, remaining: entry.remaining, before: entry.before, enabled: true, installed: true,
    }))) : resources.flatMap((resource) => {
      const owner = resourceOwner(aircraft, resource);
      if (!owner && resource.object !== "Самолёт") return [];
      const available = new Map(resourceSources(aircraft, owner).map((source) => [source.key, source]));
      return Object.entries(resourceInputs(resource, owner, aircraft)).filter(([, factor]) => factor > 0).map(([key, factor]) => ({
        key, factor: resourceSourceFactor(aircraft, key, factor), target: owner?.kind === "airframe" || !owner ? boardNode : owner.id,
        output: "resource:" + resource.id, name: resource.name, sourceLabel: available.get(key)?.label || "Удалённый показатель", enabled: available.get(key)?.enabled === true,
        installed: !owner || blockInstalledOn(owner, todayIso()), installedDate: resource.installed,
      }));
    });
    const mapTarget = blockId => !blockId || blockId === first?.id ? boardNode : blockId;
    const aggregateSources = new Map((shift ? [] : aggregateUsageSources(aircraft)).map(({ key, label }) => [key, label]));
    const columnIds = new Map();
    for (const block of shift ? [] : aircraft.blocks) for (const rule of block.usageCounters || []) {
      columnIds.set(block.id + ":" + formulas.refKey(rule), aggregateResourceKey(rule.id));
      if (rule.fieldKey && rule.source === "manual") columnIds.set(block.id + ":local:" + rule.fieldKey, block.id + ":input:" + rule.id);
    }
    const mapSourceKey = (blockId, key, counterId) => key === "manual" ? blockId + ":input:" + counterId :
      columnIds.get(blockId + ":" + key) || (key?.startsWith("cell:") || key?.startsWith("local:") ? blockId + ":" + key : key);
    const aggregateEdges = shift ? (shift.aggregateAccruals || []).flatMap((entry) => (entry.inputs || [entry]).filter(part => part.input != null || entry.textValue != null).map((part) => ({
      ...part, unit: entry.unit, posted: entry, key: part.flowKey || (part.sourceKey?.startsWith("local:") || part.sourceKey?.startsWith("cell:") ? entry.blockId + ":" + part.sourceKey :
        part.sourceKey === "manual" ? entry.blockId + ":input:" + entry.counterId : part.sourceKey), output: aggregateResourceKey(entry.counterId), expression: entry.expression, name: entry.name, target: mapTarget(entry.blockId), counter: true, enabled: true, installed: true,
    }))) : aircraft.blocks.flatMap((block) => (block.usageCounters || []).flatMap((rule) => {
      const ownerSources = aggregateUsageSources(aircraft, false, block);
      const type = (aircraft.operationTypes || DEFAULT_OPERATION_TYPES).find(item => item.id === rule.workTypeId);
      const condition = [type?.label, rule.boardCounter?.startsWith("ppr") ? "После ремонта" : ""].filter(Boolean).join(" · ");
      if (rule.formula) {
        const catalog = formulas.catalog(block.usageCounters, aggregateUsageSources(aircraft, true, block));
        const refs = new Set(rule.formula.tokens.filter(token => token?.ref).map(token => token.ref));
        return [...refs].map(ref => ({ key: mapSourceKey(block.id, ref), source: catalog.get(ref)?.label || ref, target: mapTarget(block.id), condition,
          name: rule.name, output: aggregateResourceKey(rule.id), expression: formulas.describe(rule.formula, catalog), enabled: true, installed: blockInstalledOn(block, todayIso()), counter: true }));
      }
      return aggregateRuleInputs(rule).map(({ source, sourceLabel, factor }) => ({
        key: mapSourceKey(block.id, source, rule.id), output: aggregateResourceKey(rule.id), source: ownerSources.find(item => item.key === source)?.label || sourceLabel, target: mapTarget(block.id), name: rule.name, factor, unit: rule.unit,
        enabled: factor > 0 && ownerSources.some(item => item.key === source), installed: blockInstalledOn(block, todayIso()), counter: true, condition,
      }));
    }));
    const recordedEdges = (shift?.flow || []).flatMap(row => row.inputs.map(input => ({
      key: input.key, source: input.source, output: row.output, target: mapTarget(row.owner), name: row.name,
      input: input.value, sourceUnit: input.unit, amount: row.amount, unit: row.unit, previous: row.previous,
      trace: true, counter: true, enabled: true, installed: true,
    })));
    const edges = [...resourceEdges, ...aggregateEdges, ...recordedEdges];
    const sourceLabels = new Map((shift ? [] : usageSources(aircraft, { kind: "engine" })).map((source) => [source.key, calculationSourceLabel(source)]));
    for (const [key, label] of Object.entries(shift?.sourceLabels || {})) sourceLabels.set(key, label);
    for (const entry of shift?.accruals || []) {
      for (const [key, label] of Object.entries(entry.labels || {})) sourceLabels.set(key, label);
    }
    for (const { key, sourceLabel } of resourceEdges) if (sourceLabel && !sourceLabels.has(key)) sourceLabels.set(key, sourceLabel);
    for (const edge of aggregateEdges) sourceLabels.set(edge.key, shift ? edge.source : aggregateSources.get(edge.key) || edge.source);
    for (const edge of aggregateEdges) {
      if (edge.output) sourceLabels.set(edge.output, edge.name);
      if (edge.key.includes(":input:")) sourceLabels.set(edge.key, edge.sourceKey === "manual" || !sourceLabels.has(edge.key) ? edge.name : sourceLabels.get(edge.key));
    }
    const balances = (shift?.aggregateAccruals || []).flatMap(entry => Object.entries(entry.balances || {}).map(([period, [previous, amount]]) => ({
      key: aggregateResourceKey(entry.counterId), source: entry.name, output: "balance:" + entry.counterId + ":" + period,
      name: entry.name + (period === "sne" ? " СНЭ" : " ППР"), target: mapTarget(entry.blockId), unit: entry.unit, sourceUnit: entry.unit,
      previous, amount, input: entry.amount, trace: true, counter: true, enabled: true, installed: true,
    })));
    edges.push(...balances);
    const outputs = new Map();
    for (const edge of edges) {
      if (edge.output) outputs.set(edge.output, edge);
      if (shift) sourceLabels.set(edge.key, edge.sourceKey === "manual" ? edge.name : edge.source || edge.key);
    }
    for (const edge of outputs.values()) sourceLabels.set(edge.output, edge.name);
    const sourceKeys = [...new Set(edges.map(({ key }) => key))].filter(key => !outputs.has(key));
    const node = (block) => {
      const connected = edges.some(({ target, enabled, installed, installedDate }) =>
        target === block.id && enabled && installed && (!installedDate || installedDate <= todayIso()));
      const number = block.serialNumber || resourceOwnerNumber(block);
      return `<div class="map-node ${connected ? "map-node--linked" : "map-node--unlinked"}" data-map-target="${escapeHtml(block.id)}">
        <button type="button" class="map-node-caption" data-map-select="${escapeHtml(block.id)}"><strong>${escapeHtml(block.name)}</strong><small>${escapeHtml(number || "Номер не указан")}</small></button>
        <div class="map-fields">${[...outputs.values()].filter(edge => edge.target === block.id).map(edge =>
          `<button type="button" class="small-button" data-map-field="${escapeHtml(edge.output)}">${escapeHtml(edge.name)}</button>`).join("")}</div>
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
      if (entry.blockId && entry.blockId !== first?.id && !nodes.some((item) => item.id === entry.blockId)) nodes.push({ id: entry.blockId, name: entry.object });
    }
    for (const entry of shift?.aggregateAccruals || []) {
      if (entry.blockId !== first?.id && !nodes.some((item) => item.id === entry.blockId)) nodes.push({ id: entry.blockId, name: entry.blockName });
    }
    for (const row of shift?.flow || []) {
      if (row.owner && !nodes.some(item => item.id === row.owner)) nodes.push({ id: row.owner, name: row.ownerName });
    }
    if (shift) {
      const owners = new Map([
        ...(shift.accruals || []).map(row => [row.blockId, row.object]),
        ...(shift.aggregateAccruals || []).map(row => [row.blockId, row.blockName]),
        ...(shift.flow || []).filter(row => row.owner).map(row => [row.owner, row.ownerName]),
      ]);
      for (const node of nodes) if (owners.get(node.id)) node.name = owners.get(node.id);
    }
    app.innerHTML = shell(`
      <section class="section-stack">
        <h1>${shift ? "Карта начислений" : "Карта наработки"}</h1>
        ${shift ? `<p>${formatDate(shift.date)} · ${escapeHtml(shift.operationLabel || "Лётная смена")}</p>` : ""}
        <label>Показать связи<select id="map-work"><option value="">Настроенные графы и ресурсы</option>${aircraft.shifts.slice().reverse().map(entry =>
          `<option value="${escapeHtml(entry.id)}"${entry.id === shift?.id ? " selected" : ""}>${formatDate(entry.date)} · ${escapeHtml(entry.operationLabel || "Запись работы")}</option>`).join("")}</select></label>
        ${shift && !shift.flow ? "<p>Для старой записи показаны только сохранённые источники и результаты.</p>" : ""}
        ${shift && !edges.length ? "<p>В этой записи нет сохранённых связей.</p>" : ""}
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
        ${shift ? "" : `<p>Зелёный ореол — настроенный учёт наработки или расход ресурса. Пунктир показывает связи со счётчиками или отключённые линии.</p>`}</section>
      </section>`, { title: "Карта наработки", back: true, settings: false });
    document.getElementById("map-work").onchange = event => { state.mapShiftId = event.target.value || null; renderUsageMap(); };
    const canvas = document.querySelector(".usage-map-canvas");
    const zoom = document.getElementById("map-scale");
    const details = document.getElementById("map-details");
    const wires = canvas.querySelector("svg");
    const targets = new Map([...canvas.querySelectorAll("[data-map-target]")].map((item) => [item.dataset.mapTarget, item]));
    const sources = new Map([...canvas.querySelectorAll("[data-map-source]")].map((item) => [item.dataset.mapSource, item]));
    const fields = new Map([...canvas.querySelectorAll("[data-map-field]")].map(item => [item.dataset.mapField, item]));
    let active;
    const scale = () => Number(zoom.value) / 100;
    const position = (element, right) => {
      const rect = element.getBoundingClientRect();
      const surface = canvas.getBoundingClientRect();
      return [(rect[right ? "right" : "left"] - surface.left) / scale(), (rect.top + rect.height / 2 - surface.top) / scale()];
    };
    const draw = () => {
      wires.querySelectorAll(".map-wire").forEach(wire => wire.remove());
      const connect = (from, to, muted, emphasized, counter = false, key, output) => {
        const forwards = from.getBoundingClientRect().left < to.getBoundingClientRect().left;
        const [x1, y1] = position(from, forwards);
        const [x2, y2] = position(to, !forwards);
        const withinOwner = from.closest("[data-map-target]") && from.closest("[data-map-target]") === to.closest("[data-map-target]");
        const wire = document.createElementNS("http://www.w3.org/2000/svg", withinOwner ? "path" : "line");
        if (withinOwner) {
          const [start, y] = position(from, true), [end, z] = position(to, true);
          const bend = Math.max(start, end) + 18;
          wire.setAttribute("d", `M${start},${y} C${bend},${y} ${bend},${z} ${end},${z}`);
          wire.setAttribute("fill", "none");
        } else {
          for (const [attr, value] of Object.entries({ x1, y1, x2, y2 })) wire.setAttribute(attr, value);
        }
        wire.setAttribute("class", `map-wire ${counter ? "map-wire--counter" : ""} ${muted ? "map-wire--muted" : ""} ${emphasized ? "map-wire--selected" : ""}`);
        wire.setAttribute("marker-end", "url(#map-arrow)");
        if (key) wire.dataset.from = key;
        if (output) wire.dataset.to = output;
        wires.append(wire);
      };
      const paths = new Set();
      for (const edge of edges) {
        const from = fields.get(edge.key) || sources.get(edge.key);
        const to = fields.get(edge.output);
        const pair = JSON.stringify([edge.key, edge.output]);
        if (!from || !to || paths.has(pair)) continue;
        paths.add(pair);
        const muted = !edge.enabled || !edge.installed || Boolean(edge.installedDate && edge.installedDate > todayIso());
        connect(from, to, muted, [edge.key, edge.output, edge.target].includes(active), edge.counter, edge.key, edge.output);
      }
    };
    function select(key, isSource) {
      active = key;
      canvas.querySelectorAll(".map-node, [data-map-field]").forEach((element) => {
        element.classList.toggle("map-node--selected", (element.dataset.mapField ?? element.dataset.mapTarget ?? element.dataset.mapSource) === key);
      });
      const matching = edges.filter((edge) => isSource ? edge.key === key || edge.output === key : edge.target === key);
      const heading = isSource ? sourceLabels.get(key) || key : nodes.find((item) => item.id === key)?.name;
      details.innerHTML = `<h2>${escapeHtml(heading || "")}</h2>${matching.length ? `<ul class="accrual-items">${matching.map((edge) => `<li>
        <strong>${escapeHtml(sourceLabels.get(edge.key) || edge.key)}${edge.trace || edge.expression || edge.unit === "текст" ? "" : " × " + formatNumber(edge.factor)} → ${escapeHtml(nodes.find((item) => item.id === edge.target)?.name || "")} · ${escapeHtml(edge.name)}</strong>
        ${edge.remaining != null ? `<small>Остаток: ${edge.before == null ? "" : escapeHtml(formValue(edge.before, edge.unit)) + " → "}${escapeHtml(formValue(edge.remaining, edge.unit))}</small>` : ""}
        <small>${edge.trace ? "Вход: " + escapeHtml(formValue(edge.input, edge.sourceUnit)) + (edge.previous == null ? " · Результат: " :
          " · Было: " + escapeHtml(formValue(edge.previous, edge.unit)) + " · Стало: ") + escapeHtml(formValue(edge.amount, edge.unit)) :
          edge.posted ? aggregateAccrualCalculation(edge.posted) : edge.unit === "текст" ? "Текстовая запись" : edge.expression ? escapeHtml(edge.expression) + (edge.condition ? " · " + escapeHtml(edge.condition) : "") : shift ? `${formatNumber(edge.input, 6)} × ${formatNumber(edge.factor, 6)} = ${formatNumber(edge.amount, 6)}` :
          `${edge.counter ? "Счётчик формуляра" : "Списание ресурса"} · ${!edge.enabled ? "Источник отключён" :
            !edge.installed ? "Агрегат демонтирован" : edge.target === boardNode ? "Начисляется на борт" : "Агрегат должен быть установлен на дату работы"}
            ${edge.installedDate ? ` · с ${formatDate(edge.installedDate)}` : ""}
            ${edge.condition ? ` · ${escapeHtml(edge.condition)}` : ""}`}</small></li>`).join("")}</ul>`
        : `<p>${isSource ? "Нет получателей." : "Связей нет."}</p>`}`;
      draw();
    }
    fields.forEach((element, key) => element.onclick = () => select(key, true));
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
      const { rows, totals, aggregateTotals } = calc.summarizeShifts(aircraft.shifts, start, end);
      const reportEngines = aircraft.workTemplate ? templateEngineReport(aircraft.workTemplate, rows) :
        `<p>Левый двигатель: ${calc.formatDuration(totals.leftEngineMinutes)}, запусков: ${totals.leftStarts}. Правый двигатель: ${calc.formatDuration(totals.rightEngineMinutes)}, запусков: ${totals.rightStarts}.</p>`;
      output.innerHTML = `<h2>${formatDate(start)} — ${formatDate(end)}</h2>
        <p>Смен: ${rows.length} · ${escapeHtml(usageRule("flight").label)}: ${calc.formatDuration(totals.flightMinutes)} · Посадки: ${totals.actualLandings} / ${formatNumber(totals.equivalentLandings)} в зачёт · Зацепы: ${totals.arresterHooks}</p>
        ${reportEngines}
        ${aggregateTotals.length ? `<details data-report-aggregates><summary>Наработка агрегатов за период (${aggregateTotals.length})</summary>
          <ul class="accrual-items">${aggregateTotals.map((block) => {
            const serial = block.serialNumber || aircraft.blocks.find((item) => item.id === block.id)?.serialNumber;
            return `<li><strong>${escapeHtml(block.name)}${serial ? ` · № ${escapeHtml(serial)}` : ""}</strong>
              ${block.counters.map(({ name, total, unit }) => `<small>${escapeHtml(name)} · ${formatNumber(total, 6)} ${escapeHtml(unit)}</small>`).join("")}</li>`;
          }).join("")}</ul></details>` : ""}
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

  function templateEngineReport(template, rows) {
    const fields = template.engineCounters.filter((field) => field.role === "total" || field.role === "starts");
    if (!fields.length) return "";
    const byPosition = new Map(template.positions.filter((position) => position.kind === "engine").map((position) =>
      [position.id, { position, sums: {} }]));
    for (const row of rows) {
      for (const entry of row.templateWork?.engines ?? []) {
        const group = byPosition.get(entry.slotId);
        if (!group || !entry.blockId) continue;
        for (const field of fields) {
          const value = entry.counters[field.id];
          if (value != null) group.sums[field.id] = (group.sums[field.id] || 0) + value;
        }
      }
    }
    if (!byPosition.size) return "";
    return `<ul class="accrual-items">${[...byPosition.values()].map(({ position, sums }) => `<li><strong>${escapeHtml(position.label)}</strong>
      ${fields.map((field) => ` · ${escapeHtml(field.label)} ${aircraftTemplates.formatValue(field, sums[field.id])}`).join("")}</li>`).join("")}</ul>`;
  }

  function renderAbout() {
    app.innerHTML = shell(`
      <section class="page-heading compact"><div><p class="eyebrow">Авиаресурс</p><h1>О приложении</h1></div></section>
      <section class="info-panel">${icon("plane")}<div><strong>Версия ${APP_VERSION}</strong><p>Локальный прототип персонального учёта ресурсов самолёта, двигателей и агрегатов.</p></div></section>
      <section class="info-panel">${icon("shield")}<div><strong>Хранение данных</strong><p>Текущая версия работает без интернета и хранит данные только на устройстве. Защищённый серверный режим ещё не включён.</p></div></section>
      <section class="info-panel">${icon("log")}<div><strong>Назначение сборки</strong><p>Эта версия предназначена для проверки структуры и расчётов и не заменяет утверждённую эксплуатационную документацию.</p></div></section>
    `, { title: "О приложении", subtitle: `Авиаресурс ${APP_VERSION}`, back: true, settings: false });
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
      advanceValue: null,
      notifyOnDue: true,
    };
    const objectOptions = ["Самолёт", ...aircraft.blocks.map((block) => block.name)]
      .map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
    app.innerHTML = shell(`
      <section class="page-heading compact"><div><p class="eyebrow">${escapeHtml(aircraft.type)} · борт ${escapeHtml(aircraft.boardNumber)}</p><h1>${isNew ? (draft.objectId ? "Добавить ресурс" : "Новый ресурсный агрегат") : escapeHtml(draft.name)}</h1></div></section>
      <form id="resource-form" class="shift-form">
        <fieldset class="field-tiles"><legend>Ресурс и формуляр</legend>
          <label><span>Агрегат или объект</span><input name="object" type="text" list="resource-objects" value="${escapeHtml(draft.object)}" required><datalist id="resource-objects">${objectOptions}</datalist></label>
          <label><span>Название ресурса или работы</span><input name="name" type="text" value="${escapeHtml(draft.name)}" required></label>
          <label id="resource-owner-choice" hidden>Экземпляр агрегата<select name="ownerId"></select></label>
        </fieldset>
        <fieldset class="field-tiles"><legend>Ограничение ресурса</legend>
          <label><span>Вид ограничения</span><select name="resourceType"><option value="assigned" ${draft.resourceType === "assigned" ? "selected" : ""}>Назначенный ресурс</option><option value="overhaul" ${draft.resourceType === "overhaul" ? "selected" : ""}>Межремонтный ресурс</option><option value="extension" ${draft.resourceType === "extension" ? "selected" : ""}>Ресурс до продления</option></select></label>
            <label><span>Единица</span><select name="unit">
              <option value="ч" ${draft.unit === "ч" ? "selected" : ""}>Часы</option>
              <option value="пос." ${draft.unit === "пос." ? "selected" : ""}>Посадки</option>
              <option value="зап." ${draft.unit === "зап." ? "selected" : ""}>Запуски</option>
              <option value="сраб." ${draft.unit === "сраб." ? "selected" : ""}>Срабатывания</option>
              <option value="шт." ${draft.unit === "шт." ? "selected" : ""}>Количество</option>
              <option value="мин" ${draft.unit === "мин" ? "selected" : ""}>Минуты</option>
              <option value="с" ${draft.unit === "с" ? "selected" : ""}>Секунды</option>
              <option value="дн." ${draft.unit === "дн." ? "selected" : ""}>Календарные дни</option>
            </select></label>
            <label><span>Полный ресурс</span><input name="limit" type="number" min="0" step="any" value="${draft.limit}" required></label>
          <label><span>Остаток</span><input name="remaining" type="number" min="0" step="any" value="${draft.remaining}" required></label>
          <label class="checkbox-row form-span"><input type="checkbox" name="priority" ${draft.priority ? "checked" : ""}><span>Показывать первым в начислениях</span></label>
        </fieldset>
        <details class="form-details" ${draft.serialNumber || draft.drawingNumber || draft.repairs ? "open" : ""}>
          <summary>Номера и ремонты</summary>
          <fieldset class="field-tiles" aria-label="Номера и ремонты">
            <label><span>Заводской номер</span><input name="serialNumber" type="text" value="${escapeHtml(draft.serialNumber || "")}"></label>
            <label><span>Чертёжный номер</span><input name="drawingNumber" type="text" value="${escapeHtml(draft.drawingNumber || "")}"></label>
            <label><span>Количество ремонтов</span><input name="repairs" type="number" min="0" step="1" value="${Number(draft.repairs) || 0}"></label>
          </fieldset>
        </details>
        <details id="resource-consumption-details" class="form-details"><summary>Расход ресурса из записи работы</summary>
        <fieldset id="resource-consumption" aria-label="Расход ресурса из записи работы">
          <p>Пустое поле отключает начисление. Множитель переводит показатель в единицы этого ресурса.</p>
          <div id="resource-inputs" class="field-pair"></div>
          <details id="resource-add-source-panel"><summary>Добавить показатель смены</summary>
            ${sourceDefinitionFields('<label>Название<input id="resource-source-name" type="text" maxlength="80"></label>',
              '<label class="usage-source-choice">Из списка<select id="resource-source-choice"></select></label>')}
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
        </details>
        <fieldset class="field-tiles"><legend>Даты</legend>
          <label><span>Дата изготовления</span><input name="produced" type="date" value="${draft.produced || ""}"></label><label><span>Дата установки</span><input name="installed" type="date" value="${draft.installed || ""}"></label>
          <label><span>Дата окончания календарного ресурса</span><input name="expiryDate" type="date" value="${draft.expiryDate || ""}"></label>
        </fieldset>
        <details class="form-details"><summary>Уведомления</summary>
        <fieldset aria-label="Уведомления этой работы">
          <label><span>Категория</span><select name="notificationCategory"><option value="workUsage" ${draft.notificationCategory === "workUsage" ? "selected" : ""}>Работы по наработке</option><option value="workDate" ${draft.notificationCategory === "workDate" ? "selected" : ""}>Работы по дате</option><option value="resourceUsage" ${draft.notificationCategory === "resourceUsage" ? "selected" : ""}>Ресурс по наработке</option><option value="resourceDate" ${draft.notificationCategory === "resourceDate" ? "selected" : ""}>Ресурс по дате</option></select></label>
          <div class="field-pair"><label class="checkbox-row"><input name="notifyApp" type="checkbox" ${draft.notifyApp !== false ? "checked" : ""}><span>Уведомление приложения</span></label><label class="checkbox-row"><input name="notifyCalendar" type="checkbox" ${draft.notifyCalendar ? "checked" : ""}><span>Штатный календарь</span></label></div>
          <div class="field-pair"><label><span>Предварительно за</span><input name="advanceValue" type="number" min="0" step="any" value="${draft.advanceValue ?? ""}" placeholder="По умолчанию"></label><label class="checkbox-row"><input name="notifyOnDue" type="checkbox" ${draft.notifyOnDue !== false ? "checked" : ""}><span>Напомнить при наступлении срока</span></label></div>
        </fieldset>
        </details>
        <div class="operation-tags">
          <button type="submit" class="primary-button">${isNew ? (draft.objectId ? "Добавить ресурс" : "Добавить агрегат с ограниченным ресурсом") : "Сохранить карточку"}</button>
          ${isNew ? "" : `<button type="button" class="secondary-button danger-button" data-action="delete-resource">Удалить карточку</button>`}
        </div>
      </form>
      ${resource && resource.unit !== "дн." ? `
        <form id="extension-form" class="shift-form event-form">
          <fieldset class="form-grid"><legend>Продлить ресурс</legend>
            <label>Дата продления<input name="date" type="date" value="${todayIso()}" required></label>
            <label>Новый полный ресурс, ${escapeHtml(resource.unit)}<input name="limit" type="number" min="0" step="any" required></label>
            <label class="form-span">Основание<input name="basis" type="text" required></label>
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
      inputsRoot.innerHTML = resourceSources(aircraft, currentOwner()).map((source) => {
        const { key } = source;
        return `<label>${escapeHtml(calculationSourceLabel(source))}${source.enabled ? "" : " · отключён"}
        <input data-source="${escapeHtml(key)}" type="number" min="0" step="any" value="${values[key] ?? ""}" placeholder="—"></label>`;
      }).join("");
      sourceChoice.replaceChildren(new Option("Новый показатель", ""),
        ...usageSources(aircraft).filter(({ key }) => !sourceEnabled(aircraft, key)).map(({ key, label }) => new Option(label, key)));
      const fieldset = inputsRoot.closest("fieldset");
      fieldset.disabled = fieldset.hidden = resourceForm.elements.unit.value === "дн.";
      fieldset.parentElement.hidden = fieldset.hidden;
    };
    let implicitInputs = resource?.consumption ? null : resourceInputs(draft, currentOwner(), aircraft);
    drawInputs(implicitInputs || resource.consumption);
    const refreshInputs = (refreshOwner = false) => {
      const current = readInputs();
      if (refreshOwner) syncOwner();
      if (implicitInputs && JSON.stringify(implicitInputs) === JSON.stringify(current)) {
        implicitInputs = resourceInputs({ unit: resourceForm.elements.unit.value }, currentOwner(), aircraft);
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
      const origin = resourceOwner(aircraft, source);
      const target = currentOwner();
      const allowed = new Set(resourceSources(aircraft, target).map(({ key }) => key));
      const values = {};
      for (const [key, factor] of Object.entries(resourceInputs(source, origin, aircraft))) {
        let destination = key;
        if (!allowed.has(destination)) {
          if (!factor) continue;
          const counter = origin?.usageCounters?.find(({ id }) => aggregateResourceKey(id) === key);
          const matches = counter ? (target?.usageCounters || []).filter((rule) =>
            aggregateRuleIdentity(rule) === aggregateRuleIdentity(counter)) : [];
          if (matches.length !== 1) {
            showToast("В формуляре назначения нужен один такой же показатель с теми же источником, единицей и коэффициентом");
            return;
          }
          destination = aggregateResourceKey(matches[0].id);
        }
        if (Object.hasOwn(values, destination)) {
          showToast("Несколько правил расхода ссылаются на один показатель назначения");
          return;
        }
        values[destination] = factor;
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
        id: resource?.id || `resource-${id()}`,
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
        advanceValue: data.get("advanceValue") === "" ? null : Number(data.get("advanceValue")),
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
      const lastWork = aircraft.shifts.at(-1);
      let preventRecalculation = false;
      if (resource && lastWork?.afterUsage && !lastWork.resourceAssignmentChanged) {
        const owner = resourceOwner(aircraft, resource);
        const previousInputs = resourceInputs(resource, owner, aircraft);
        const keys = new Set([...Object.keys(previousInputs), ...Object.keys(saved.consumption)]);
        preventRecalculation = resource.unit !== saved.unit || (resource.installed || "") !== saved.installed ||
          owner?.id !== resourceOwner(aircraft, saved)?.id ||
          [...keys].some((key) => (previousInputs[key] || 0) !== (saved.consumption[key] || 0));
        if (preventRecalculation) lastWork.resourceAssignmentChanged = true;
      }
      if (resource) Object.assign(resource, saved);
      else aircraft.resources.push(saved);
      if (!saveState()) {
        if (preventRecalculation) delete lastWork.resourceAssignmentChanged;
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
        <div class="type-trash-actions">
          ${aircraftImportControls()}
          <button type="button" class="secondary-button" id="create-aircraft-template">Создать шаблон</button>
        </div>
        <section class="settings-list" aria-label="Доступные типы">
          ${types.map((name, index) => `<div class="setting-row type-catalog-card"><span><strong>${escapeHtml(name)}</strong>
            ${state.templateCatalog.some((template) => template.name === name) ? `<span class="type-trash-actions">
              <button type="button" class="small-button" data-copy-template="${index}">Сделать копию</button>
              <button type="button" class="small-button" data-export-template="${index}">Экспортировать</button>
            </span>` : ""}</span><button class="type-archive-button" type="button" data-archive-type="${index}" aria-label="Переместить ${escapeHtml(name)} в корзину">×</button></div>`).join("") || "<p>Доступных типов пока нет.</p>"}
        </section>
        <details id="aircraft-type-trash" ${types.length ? "" : "open"}><summary>Корзина (${archived.length})</summary>
          ${archived.map((name, index) => `<div class="setting-row type-trash-row"><strong>${escapeHtml(name)}</strong>
            <div class="type-trash-actions"><button class="small-button" type="button" data-restore-type="${index}">Восстановить</button>
            <button class="small-button danger-button" type="button" data-delete-type="${index}">Стереть совсем</button></div>
          </div>`).join("") || "<p>Корзина пуста.</p>"}
        </details>
      </section>`, { title: "Типы самолётов", back: true, settings: false });
    bindTemplateImport();
    document.getElementById("create-aircraft-template").onclick = () => openTemplateEditor();
    for (const button of app.querySelectorAll("[data-copy-template], [data-export-template]")) {
      button.onclick = () => {
        const name = types[Number(button.dataset.copyTemplate ?? button.dataset.exportTemplate)];
        const template = state.templateCatalog.find((item) => item.name === name);
        if (button.hasAttribute("data-copy-template")) openTemplateEditor(template);
        else exportTemplate(template);
      };
    }
    document.getElementById("aircraft-type-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const name = event.currentTarget.elements.type.value.trim();
      const key = name.toLowerCase();
      if (!name) { showToast("Введи название типа"); return; }
      if (state.aircraftTypes.some((item) => item.toLowerCase() === key)) {
        showToast(isArchivedType(name) ? "Тип уже в корзине. Его можно восстановить" : "Такой тип уже есть");
        return;
      }
      const previous = {
        removedAircraftTypes: state.removedAircraftTypes, usageTypeOverrides: state.usageTypeOverrides,
        typeSettings: state.typeSettings, aircraftTypes: state.aircraftTypes,
      };
      if (state.removedAircraftTypes.includes(key) && state.aircraft.some((item) => item.type.trim().toLowerCase() === key)) {
        showToast("Это название осталось у существующих бортов. Введи другое название");
        return;
      }
      state.removedAircraftTypes = previous.removedAircraftTypes.filter((item) => item !== key);
      state.typeSettings = previous.typeSettings.filter((item) => item.type.trim().toLowerCase() !== key);
      state.aircraftTypes = [...previous.aircraftTypes, name];
      state.usageTypeOverrides = [...previous.usageTypeOverrides.filter((item) => item.type !== key), {
        type: key, labels: { flight: USAGE_TYPES.flight, runway: "Посадки" },
        enabled: defaultUsageSources(),
      }];
      if (saveState()) render();
      else { Object.assign(state, previous); showToast("Не удалось сохранить тип"); }
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
      chooseLayoutAction("Удалить тип в корзину? Существующие борта сохранят его.",
        [["archive", "В корзину"], ["cancel", "Отмена"]], (action) => { if (action === "archive") changeArchive(name, true); });
    }));
    app.querySelectorAll("[data-restore-type]").forEach((button) => button.addEventListener("click", () => {
      changeArchive(archived[Number(button.dataset.restoreType)], false);
    }));
    app.querySelectorAll("[data-delete-type]").forEach((button) => button.addEventListener("click", () => {
      const name = archived[Number(button.dataset.deleteType)];
      const key = name.toLowerCase();
      const linked = state.aircraft.some((item) => item.type.trim().toLowerCase() === key);
      const prompt = linked ? "Стереть тип из справочника? Существующие борта сохранят свои данные и правила расчёта." : "Стереть тип и его настройки из справочника?";
      chooseLayoutAction(prompt, [["delete", "Стереть совсем"], ["cancel", "Отмена"]], (action) => {
        if (action !== "delete") return;
        const previous = {
          aircraftTypes: state.aircraftTypes, archivedAircraftTypes: state.archivedAircraftTypes,
          removedAircraftTypes: state.removedAircraftTypes, usageTypeOverrides: state.usageTypeOverrides, typeSettings: state.typeSettings,
          templateCatalog: state.templateCatalog,
        };
        state.aircraftTypes = previous.aircraftTypes.filter((item) => item !== name);
        state.archivedAircraftTypes = previous.archivedAircraftTypes.filter((item) => item !== key);
        state.templateCatalog = previous.templateCatalog.filter((item) => item.name !== name);
        if (linked) state.removedAircraftTypes = [...previous.removedAircraftTypes, key];
        else {
          state.usageTypeOverrides = previous.usageTypeOverrides.filter((item) => item.type !== key);
          state.typeSettings = previous.typeSettings.filter((item) => item.type.trim().toLowerCase() !== key);
        }
        if (saveState()) render();
        else { Object.assign(state, previous); showToast("Не удалось удалить тип"); }
      });
    }));
  }

  function templateNameTaken(name) {
    const key = name.toLowerCase();
    return state.aircraftTypes.some((item) => item.toLowerCase() === key) || state.removedAircraftTypes.includes(key);
  }

  function templateIdTaken(id) {
    return state.templateCatalog.some((item) => item.id === id);
  }

  function assertTemplateAvailable(template) {
    if (templateNameTaken(template.name) || templateIdTaken(template.id)) {
      throw new Error("Тип или идентификатор шаблона уже есть в приложении");
    }
  }

  function templateCopyIdentity(template) {
    for (let index = 1; ; index += 1) {
      const nameSuffix = index === 1 ? " (копия)" : ` (копия ${index})`;
      const idSuffix = `-copy-${index}`;
      const name = template.name.slice(0, 120 - nameSuffix.length).trimEnd() + nameSuffix;
      const id = template.id.slice(0, 48 - idSuffix.length).replace(/-+$/, "") + idSuffix;
      if (!templateNameTaken(name) && !templateIdTaken(id)) return { name, id };
    }
  }

  function saveNewTemplate(template) {
    const previous = { aircraftTypes: state.aircraftTypes, templateCatalog: state.templateCatalog, usageTypeOverrides: state.usageTypeOverrides };
    registerTemplate(template);
    if (saveState()) return true;
    Object.assign(state, previous);
    return false;
  }

  function registerTemplate(template) {
    const fields = template.inputs.filter((input) => input.role);
    const enabled = Object.fromEntries(BOARD_USAGE_TYPES.map((key) => [key, fields.some((input) => input.role === key)]));
    const labels = Object.fromEntries(fields.map((input) => [input.role, input.label]));
    const factors = {};
    const customSources = [];
    for (const { key, enabled: active, ...source } of template.boardUsage || []) {
      enabled[key] = active;
      labels[key] = source.label;
      factors[key] = source.factor;
      if (key.startsWith("custom-")) customSources.push({ key, ...source });
    }
    state.aircraftTypes = [...state.aircraftTypes, template.name];
    state.templateCatalog = [...state.templateCatalog, template];
    state.usageTypeOverrides = [...state.usageTypeOverrides, {
      type: template.name.toLowerCase(), enabled, labels, ...(template.boardUsage && { factors, customSources }),
    }];
  }

  function openTemplateEditor(source) {
    const template = source ? structuredClone(source) : {
      schemaVersion: 1, workTitle: "Данные работы",
      positions: [{ id: "airframe", kind: "airframe", label: "Формуляр самолёта" }],
      inputs: [
        { id: "flight", label: "Налёт", scope: "board", type: "duration", format: "HH:MM", role: "flight" },
        { id: "runway", label: "Посадки БВПП", scope: "board", type: "count", role: "runway" },
      ],
      repeatGroups: [], engineCounters: [], rules: [], checks: [],
    };
    Object.assign(template, source ? templateCopyIdentity(source) : { name: "", id: `template-${Date.now().toString(36)}` });
    state.templateDraft = template;
    navigateTo("template-editor");
  }

  function renderTemplateEditor() {
    const draft = state.templateDraft;
    const kinds = [["airframe", "Самолёт"], ["engine", "Двигатель"], ["unit", "Агрегат"]];
    const scopes = [["board", "Самолёт"], ["engine", "Двигатель"]];
    const types = [["duration", "Время"], ["count", "Количество"]];
    const formats = [["HH:MM", "Часы и минуты"], ["HH:MM:SS", "Часы, минуты, секунды"]];
    const boardRoles = [["", "Свой показатель"], ...Object.entries(USAGE_TYPES).filter(([key]) => BOARD_USAGE_TYPES.includes(key))];
    const counterRoles = [["", "Своя графа"], ["starts", "Запуски"], ["ground", "Земля"], ["flight", "Полёт"],
      ["or", "Первый максимал"], ["combat", "Второй максимал"], ["combined", "Общий максимал"], ["total", "Общая наработка"]];
    const config = {
      positions: { title: "Позиции формуляров", fields: [
        ["label", "Название"], ["kind", "Вид", kinds], ["id", "Идентификатор позиции"], ["model", "Модель"],
        ["linkSource", "Позиция своего двигателя", "engine-slots"], ["linkCounters", "Графы двигателя (через запятую или all)", "counter-ids"],
      ], sample: { kind: "unit", label: "" }, prefix: "position" },
      inputs: { title: "Поля ввода", fields: [
        ["label", "Название"], ["id", "Идентификатор поля"], ["scope", "Чьи данные", scopes], ["type", "Единицы", types],
        ["format", "Формат времени", formats], ["role", "Показатель борта", boardRoles], ["group", "Группа строк", "group-ids"],
      ], sample: { scope: "engine", type: "duration", format: "HH:MM", label: "" }, prefix: "input" },
      repeatGroups: { title: "Повторяющиеся строки", fields: [
        ["label", "Название"], ["id", "Идентификатор группы"], ["scope", "Чьи данные", scopes], ["countField", "Поле с числом строк", "input-ids"],
      ], sample: { scope: "engine", label: "" }, prefix: "group" },
      engineCounters: { title: "Графы формуляра двигателя", fields: [
        ["label", "Название"], ["id", "Идентификатор графы"], ["type", "Единицы", types], ["format", "Формат времени", formats],
        ["role", "Назначение", counterRoles],
      ], sample: { type: "duration", format: "HH:MM", label: "" }, prefix: "counter" },
      rules: { title: "Правила начисления", fields: [
        ["target", "Графа назначения", "counter-ids"], ["operation", "Операция", [["copy", "Перенести поле"], ["flight_plus_ground", "Полёт + доля земли"]]],
        ["source", "Исходное поле для переноса", "input-ids"], ["flight", "Поле полёта", "input-ids"], ["ground", "Поле земли", "input-ids"],
        ["percent", "Доля земли, %", "number"], ["stepMinutes", "Шаг округления, мин", "number"],
        ["direction", "Округление", [["nearest", "До ближайшего"], ["up", "Вверх"], ["down", "Вниз"]]],
      ], sample: { operation: "copy", percent: 20, stepMinutes: 5, direction: "nearest" } },
      checks: { title: "Проверки последовательности", fields: [["ascending", "Идентификаторы полей через запятую, от меньшего к большему"]], sample: { ascending: [] } },
    };
    app.innerHTML = shell(`<h1>Шаблон самолёта</h1>
      <form class="shift-form" id="template-editor-form">
        <div class="field-pair">
          <label>Название типа<input name="name" value="${escapeHtml(draft.name)}" maxlength="120" required></label>
          <label>Имя файла и идентификатор<input name="id" value="${escapeHtml(draft.id)}" maxlength="48" required></label>
        </div>
        <label>Заголовок формы ввода<input name="workTitle" value="${escapeHtml(draft.workTitle)}" maxlength="120"></label>
        ${Object.entries(config).map(([key, { title }]) => `<details class="template-editor-section" ${key === "positions" ? "open" : ""}>
          <summary>${title}</summary><div data-template-list="${key}"></div>
          <button class="secondary-button" type="button" data-template-edit="add" data-list="${key}">Добавить</button>
        </details>`).join("")}
        <div id="template-editor-suggestions"></div>
        <p id="template-editor-error" class="field-help" role="status"></p>
        <div class="type-trash-actions">
          <button class="primary-button" type="submit">Сохранить шаблон</button>
          <button class="secondary-button" id="export-draft-template" type="button">Экспортировать JSON</button>
        </div>
      </form>`, { title: "Шаблон самолёта", back: true, settings: false });
    const form = document.getElementById("template-editor-form");
    const error = document.getElementById("template-editor-error");
    const commaList = (value) => value.split(",").map((item) => item.trim()).filter(Boolean);
    function valuesFor(row) {
      return { ...row, ...(row.engineLink && { linkSource: row.engineLink.source,
        linkCounters: row.engineLink.counters === "all" ? "all" : row.engineLink.counters.join(", ") }),
      ...(row.ascending && { ascending: row.ascending.join(", ") }) };
    }
    function counterFields(position, index) {
      const sources = new Map([["manual", "Ввести при записи работы"]]);
      for (const input of draft.inputs.filter((item) => item.scope === "board" && item.role))
        sources.set("board:" + input.role, input.label);
      for (const item of draft.boardUsage || []) if (item.enabled) sources.set("board:" + item.key, item.label);
      for (const slot of draft.positions.filter((item) => item.kind === "engine"))
        for (const rule of draft.rules) {
          const field = draft.engineCounters.find((item) => item.id === rule.target);
          if (field) sources.set(`position:${slot.id}:${field.id}`, slot.label + " · " + field.label);
        }
      const option = (key, title, value) => `<option value="${escapeHtml(key)}" ${key === value ? "selected" : ""}>${escapeHtml(title)}</option>`;
      return `<div data-template-property="usageRules"><strong>Графы формуляра</strong>
        ${(position.usageCounters || []).map((rule, i) => {
          const choices = new Map(sources);
          if (rule.workMode) {
            if (rule.formula) choices.set("formula", "Формула из граф");
            choices.set("work:landings", "Сумма посадок за работу");
            choices.set("work:date", "Дата записи о работе");
            choices.set("work:type", "Название вида работы");
            for (const field of aircraftTemplates.rawSourceList(draft)) choices.set(field.key, field.label);
            for (const field of position.usageCounters.filter(item => item.fieldKey && item.source === "manual")) choices.set("local:" + field.fieldKey, field.name);
          }
          if (!choices.has(rule.source)) choices.set(rule.source, rule.source);
          return `<div data-position-counter><div class="field-pair">
            <label>Название<input data-counter-name value="${escapeHtml(rule.name)}" maxlength="120"></label>
            <label>Тип ячейки и единица<select data-counter-unit>${rule.workMode ? cellOptions(rule.unit) : AGGREGATE_UNITS.map(u => option(u, u, rule.unit)).join("")}</select></label>
            <label>Источник<select data-counter-source>${[...choices].map(([k, v]) => option(k, v, rule.source)).join("")}</select></label>
            ${rule.workMode ? `<label>Запись в формуляр<select data-counter-mode>${option("entry", "Значение за работу", rule.workMode)}${option("total", "Прибавлять к наработке", rule.workMode)}</select></label>` : ""}
            <label>Из каких работ брать данные<select data-counter-work>${option("", "Любая работа", rule.workTypeId || "")}${(draft.operationTypes || DEFAULT_OPERATION_TYPES).map(item => option(item.id, item.label, rule.workTypeId)).join("")}</select></label>
            <label>Коэффициент<input data-counter-factor type="number" min="0" max="1000000" step="any" value="${rule.factor}"></label>
          </div><button type="button" class="small-button" data-counter-remove="${i}" data-slot-index="${index}">Убрать показатель</button></div>`;
        }).join("")}
        <button type="button" class="secondary-button" data-counter-add data-slot-index="${index}">Добавить графу</button></div>`;
    }
    function draw(key) {
      const { fields } = config[key];
      form.querySelector(`[data-template-list="${key}"]`).innerHTML = draft[key].map((row, index) => {
        const values = valuesFor(row);
        return `<fieldset class="template-editor-entry" data-template-entry="${key}">
          <legend>${index + 1}. ${escapeHtml(row.label || row.target || "")}</legend>
          <div class="field-pair">${fields.map(([name, title, mode]) => {
            const value = values[name] ?? "";
            const control = Array.isArray(mode)
              ? `<select data-property="${name}">${mode.map(([option, caption]) =>
                `<option value="${option}" ${value === option ? "selected" : ""}>${escapeHtml(caption)}</option>`).join("")}</select>`
              : `<input data-property="${name}" type="${mode === "number" ? 'number" step="any' : "text"}" ${mode && mode !== "number" ? `list="${mode}"` : ""} value="${escapeHtml(value)}">`;
            return `<label data-template-property="${name}">${title}${control}</label>`;
          }).join("")}</div>
          ${key === "positions" ? counterFields(row, index) : ""}
          <div class="type-trash-actions">${[["up", "Вверх"], ["down", "Вниз"], ["remove", "Удалить"]].map(([action, label]) =>
            `<button class="small-button" type="button" data-template-edit="${action}" data-list="${key}" data-index="${index}"
              ${(action === "up" && !index) || (action === "down" && index === draft[key].length - 1) ? "disabled" : ""}>${label}</button>`).join("")}</div>
        </fieldset>`;
      }).join("");
    }
    function suggestions() {
      const sources = { "engine-slots": draft.positions.filter((row) => row.kind === "engine"), "counter-ids": draft.engineCounters,
        "group-ids": draft.repeatGroups, "input-ids": draft.inputs };
      document.getElementById("template-editor-suggestions").innerHTML = Object.entries(sources).map(([key, rows]) =>
        `<datalist id="${key}">${rows.map((row) => `<option value="${escapeHtml(row.id)}" label="${escapeHtml(row.label || row.id)}"></option>`).join("")}</datalist>`).join("");
    }
    function updateControlVisibility() {
      for (const entry of form.querySelectorAll("[data-template-entry]")) {
        const value = (key) => entry.querySelector(`[data-property="${key}"]`)?.value;
        const hide = (keys, hidden) => keys.forEach((key) => {
          entry.querySelector(`[data-template-property="${key}"]`).hidden = hidden;
        });
        if (entry.dataset.templateEntry === "positions") {
          hide(["linkSource", "linkCounters"], value("kind") !== "unit");
          for (const row of entry.querySelectorAll("[data-position-counter]")) {
            const mode = row.querySelector("[data-counter-mode]");
            if (!mode) continue;
            const unit = row.querySelector("[data-counter-unit]").value;
            mode.disabled = unit === "текст" || unit === "дата";
            if (mode.disabled) mode.value = "entry";
            const factor = row.querySelector("[data-counter-factor]");
            factor.closest("label").hidden = mode.disabled;
            if (mode.disabled) factor.value = "1";
            const source = row.querySelector("[data-counter-source]");
            const locals = draft.positions[Number(entry.querySelector("[data-slot-index]").dataset.slotIndex)]?.usageCounters || [];
            for (const option of source.options) {
              const isText = option.value === "work:type" || locals.some(field => field.unit === "текст" && field.fieldKey && option.value === "local:" + field.fieldKey);
              option.disabled = option.value !== "manual" && (unit === "текст") !== isText;
            }
            if (source.selectedOptions[0]?.disabled) source.value = "manual";
          }
        }

        if (entry.dataset.templateEntry === "inputs") hide(["role"], value("scope") !== "board");
        if (value("type")) hide(["format"], value("type") !== "duration");
        if (value("operation")) {
          const copies = value("operation") === "copy";
          hide(["source"], !copies);
          hide(["flight", "ground", "percent", "stepMinutes", "direction"], copies);
        }
      }
    }
    function readDraft() {
      for (const key of ["name", "id", "workTitle"]) draft[key] = form.elements[key].value.trim();
      for (const key of Object.keys(config)) {
        draft[key] = [...form.querySelectorAll(`[data-template-entry="${key}"]`)].map((entry, index) => {
          const row = Object.fromEntries([...entry.querySelectorAll("[data-property]")]
            .filter((input) => !input.closest("[hidden]") && input.value.trim()).map((input) =>
            [input.dataset.property, input.type === "number" ? Number(input.value) : input.value.trim()]));
          if (key === "positions") {
            const { linkSource, linkCounters, ...position } = row;
            if (linkSource) position.engineLink = { source: linkSource, counters: linkCounters === "all" ? "all" : commaList(linkCounters || "") };
            const { usageCounters, formLayout } = draft.positions[index];
            if (usageCounters) position.usageCounters = [...entry.querySelectorAll("[data-position-counter]")].map((node, i) => ({
              ...usageCounters[i], ...(usageCounters[i].workMode && { workMode: node.querySelector("[data-counter-mode]").value }),
              workTypeId: node.querySelector("[data-counter-work]").value,
              fieldKey: node.querySelector("[data-counter-mode]") && node.querySelector("[data-counter-source]").value === "manual" ? usageCounters[i].fieldKey || id() : undefined,
              name: node.querySelector("[data-counter-name]").value.trim(),
              unit: node.querySelector("[data-counter-unit]").value, source: node.querySelector("[data-counter-source]").value,
              factor: node.querySelector("[data-counter-factor]").valueAsNumber,
            }));
            if (formLayout) position.formLayout = formLayout;
            return position;
          }
          if (key === "checks") return { ascending: commaList(row.ascending || "") };
          return row;
        });
      }
    }
    function cleanDraft() {
      readDraft();
      const clean = structuredClone(draft);
      const assemblySlots = new Set(clean.positions.map(({ id }) => `form:assembly-slot:${id}`));
      for (const position of clean.positions) {
        if (position.formLayout) position.formLayout = remapFormLayout(position.formLayout, (key) =>
          !key.startsWith("form:assembly-slot:") || assemblySlots.has(key) ? key : null);
      }
      if (clean.layout) {
        const slots = new Set(clean.positions.map((position) => `slot:${position.id}`));
        clean.layout.tabs = Object.fromEntries(Object.entries(clean.layout.tabs).map(([tab, tiles]) =>
          [tab, remapTemplateTiles(tiles, (key) => !key.startsWith("slot:") || slots.has(key) ? key : null)]));
      }
      return aircraftTemplates.validateTemplate(clean);
    }
    for (const key of Object.keys(config)) draw(key);
    updateControlVisibility();
    readDraft();
    const initial = JSON.stringify(draft);
    suggestions();
    form.addEventListener("change", (event) => {
      updateControlVisibility(); readDraft(); suggestions();
      if (["inputs", "engineCounters", "rules"].includes(event.target.closest("[data-template-entry]")?.dataset.templateEntry)) {
        draw("positions"); updateControlVisibility();
      }
    });
    form.addEventListener("click", (event) => {
      const editCounter = event.target.closest("[data-slot-index]");
      if (editCounter) {
        readDraft();
        const position = draft.positions[Number(editCounter.dataset.slotIndex)];
        const rules = position.usageCounters ||= [];
        if (editCounter.hasAttribute("data-counter-add")) rules.push({ name: "", unit: "шт.", source: "manual", factor: 1, workMode: "entry", columnKey: id() });
        else {
          const removed = Number(editCounter.dataset.counterRemove);
          rules.splice(removed, 1);
          if (position.formLayout) position.formLayout = remapFormLayout(position.formLayout, (key) => {
            const match = /^form:aggregate-counter-index:(\d+)$/.exec(key);
            if (!match || Number(match[1]) < removed) return key;
            return Number(match[1]) === removed ? null : `form:aggregate-counter-index:${Number(match[1]) - 1}`;
          });
        }
        draw("positions"); updateControlVisibility();
        return;
      }
      const button = event.target.closest("[data-template-edit]");
      if (!button) return;
      readDraft();
      const { list: key, templateEdit: action } = button.dataset;
      const rows = draft[key];
      const index = Number(button.dataset.index);
      if (action === "add") {
        const { sample, prefix } = config[key];
        let next = rows.length + 1;
        while (prefix && rows.some((row) => row.id === `${prefix}-${next}`)) next += 1;
        rows.push({ ...structuredClone(sample), ...(prefix && { id: `${prefix}-${next}` }) });
      } else if (action === "remove") {
        rows.splice(index, 1);
      } else {
        const target = index + (action === "up" ? -1 : 1);
        [rows[index], rows[target]] = [rows[target], rows[index]];
      }
      draw(key);
      updateControlVisibility();
      suggestions();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      try {
        const template = cleanDraft();
        assertTemplateAvailable(template);
        if (!saveNewTemplate(template)) throw new Error("Не удалось сохранить шаблон");
        leaveTemplateEditor = null;
        delete state.templateDraft;
        navigateBack();
        showToast("Шаблон сохранён");
      } catch (problem) { error.textContent = problem.message; }
    });
    document.getElementById("export-draft-template").onclick = () => {
      try { exportTemplate(cleanDraft()); error.textContent = ""; }
      catch (problem) { error.textContent = problem.message; }
    };
    leaveTemplateEditor = () => {
      readDraft();
      if (JSON.stringify(draft) === initial) {
        leaveTemplateEditor = null;
        delete state.templateDraft;
        return false;
      }
      chooseLayoutAction("Выйти без сохранения шаблона?", [["discard", "Выйти"], ["cancel", "Остаться"]], (action) => {
        if (action !== "discard") return;
        leaveTemplateEditor = null;
        delete state.templateDraft;
        finishBackNavigation();
      });
      return true;
    };
  }

  function aircraftImportControls() {
    return `<div class="aircraft-import">
      <button type="button" class="secondary-button" id="import-aircraft-template">Импортировать борт или шаблон</button>
      <input id="aircraft-template-file" type="file" accept=".json,application/json" hidden>
      <p id="template-import-status" class="field-help" role="status"></p>
    </div>`;
  }

  function bindTemplateImport() {
    const file = document.getElementById("aircraft-template-file");
    const status = document.getElementById("template-import-status");
    function importCopy(template) {
      const identity = templateCopyIdentity(template);
      const dialog = document.createElement("dialog");
      dialog.className = "confirm-dialog";
      dialog.setAttribute("aria-labelledby", "template-copy-title");
      dialog.innerHTML = `<form>
        <h2 id="template-copy-title">Импортировать как новый тип</h2>
        <p>Название или идентификатор шаблона «${escapeHtml(template.name)}» уже используется. Введи название нового типа.</p>
        <label>Название нового типа<input name="name" type="text" maxlength="120" value="${escapeHtml(identity.name)}" required></label>
        <p class="form-error" role="alert"></p>
        <div class="operation-tags">
          <button type="submit" class="primary-button" value="import-copy">Импортировать копию</button>
          <button type="button" class="secondary-button" value="cancel">Отмена</button>
        </div>
      </form>`;
      const form = dialog.querySelector("form");
      const alert = form.querySelector("[role=alert]");
      form.querySelector('[value="cancel"]').onclick = () => dialog.close();
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const name = form.elements.name.value.trim();
        if (!name || templateNameTaken(name)) {
          alert.textContent = name ? "Тип с таким названием уже есть" : "Укажи название нового типа";
          return;
        }
        const copy = { ...template, ...templateCopyIdentity(template), name };
        if (!saveNewTemplate(copy)) { alert.textContent = "Не удалось сохранить копию шаблона"; return; }
        dialog.close();
        render();
        showToast("Шаблон импортирован как новый тип");
      });
      form.elements.name.addEventListener("input", () => { alert.textContent = ""; });
      dialog.addEventListener("close", () => dialog.remove(), { once: true });
      app.append(dialog);
      dialog.showModal();
    }
    function showFile(text, error) {
      if (!status.isConnected || app.querySelector("dialog[open]")) return;
      if (error) { status.textContent = error; return; }
      let template;
      try {
        const incoming = JSON.parse(text);
        if (incoming?.kind === "aircraft-start") {
          const pack = aircraftTemplates.validateStartingAircraft(incoming);
          const info = pack.aircraft;
          chooseLayoutAction(`Импортировать борт ${escapeHtml(info.boardNumber)} · ${escapeHtml(pack.template.name)}? Формуляров: ${pack.template.positions.length}. Ресурсов: ${info.resources.length}. Начальные показания будут записаны без создания смены.`,
            [["import", "Импортировать борт"], ["cancel", "Отмена"]], (action) => {
              if (action !== "import") return;
              try { importStartingAircraft(pack); }
              catch (problem) { status.textContent = problem.message; showToast(problem.message); }
            });
          return;
        }
        template = aircraftTemplates.validateTemplate(incoming);
      } catch (problem) {
        status.textContent = problem instanceof SyntaxError ? "Файл не является корректным JSON" : problem.message;
        return;
      }
      if (templateNameTaken(template.name) || templateIdTaken(template.id)) {
        status.textContent = "Тип или идентификатор шаблона уже есть. Можно импортировать копию.";
        importCopy(template);
        return;
      }
      status.textContent = "";
      const positions = template.positions.length;
      chooseLayoutAction(`Импортировать «${escapeHtml(template.name)}»? Формуляров: ${positions}. Полей ввода: ${template.inputs.length}.`,
        [["import", "Импортировать"], ["cancel", "Отмена"]], (action) => {
          if (action !== "import") return;
          if (saveNewTemplate(template)) { render(); showToast("Шаблон импортирован"); }
          else status.textContent = "Не удалось сохранить шаблон";
        });
    }
    window.receiveAircraftTemplate = showFile;
    document.getElementById("import-aircraft-template").addEventListener("click", () => {
      status.textContent = "";
      if (typeof window.AndroidBridge?.pickAircraftTemplate === "function") window.AndroidBridge.pickAircraftTemplate();
      else file.click();
    });
    file.addEventListener("change", async () => {
      const selected = file.files?.[0];
      file.value = "";
      if (!selected) return;
      if (selected.size > 256 * 1024) { showFile(null, "Файл шаблона должен быть не больше 256 КБ"); return; }
      try { showFile((await selected.text()).replace(/^\uFEFF/, "")); }
      catch (_) { showFile(null, "Не удалось прочитать файл"); }
    });
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
        const kind = sourceKind(item);
        const editableKind = key.startsWith("custom-");
        return `<fieldset class="usage-source-card" aria-label="${escapeHtml(currentLabel(item))}">
          <div class="usage-source-grid">
            <label>Название<input name="${key}Label" type="text" value="${escapeHtml(currentLabel(item))}" maxlength="80" required></label>
            <label class="usage-coefficient">Коэффициент<input name="${key}Factor" type="number" min="0" step="any" value="${factor}" required></label>
            <label>Категория<select name="${key}Kind" data-usage-kind="${key}">${usageKindOptions(kind)}</select></label>
            ${editableKind ? `<label class="usage-time-format" ${kind === "time" ? "" : "hidden"}>Формат ввода<select name="${key}Format">${durationOptions(item.format)}</select></label>` : ""}
            <small class="field-help usage-example">${usageFactorExample(factor)}</small>
            <button type="button" class="small-button usage-remove" data-disable-source="${key}">Убрать</button>
          </div>
        </fieldset>`;
      }).join("") + `<details id="type-add-source"><summary>Добавить показатель</summary>
          ${sourceDefinitionFields('<label>Название<input name="newSource" type="text" maxlength="80"></label>',
            available.length ? `<label class="usage-source-choice">Из списка<select name="existingSource"><option value="">Выбрать</option>${available.map((item) =>
              `<option value="${item.key}">${escapeHtml(currentLabel(item))}</option>`).join("")}</select></label>` : "")}
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
        if (key.startsWith("custom-")) {
          const kind = form.elements.namedItem(`${key}Kind`).value;
          if (kind !== sourceKind(item)) item.kind = kind;
          if (kind === "time") item.format = form.elements.namedItem(`${key}Format`).value;
          else delete item.format;
        }
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
      if (field.name.endsWith("Label") && row.classList.contains("usage-source-card")) row.setAttribute("aria-label", field.value);
      if (field.name.endsWith("Factor")) {
        row.querySelector("small").textContent = usageFactorExample(field.valueAsNumber);
      }
    });
    collection?.addEventListener("change", (event) => {
      if (event.target.matches("[data-usage-kind]")) {
        const key = event.target.dataset.usageKind;
        if (!key.startsWith("custom-")) keepBuiltInKind(event.target, { key });
        const format = event.target.closest("fieldset").querySelector(".usage-time-format");
        if (format) format.hidden = event.target.value !== "time";
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
        <button class="setting-row" data-action="about"><span><strong>О приложении</strong><small>Авиаресурс · Android-прототип ${APP_VERSION}</small></span>${icon("chevron")}</button>
      </section>
      <section class="info-panel">${icon("shield")}<div><strong>Данные этого прототипа</strong><p>Сохраняются только в локальном хранилище браузера. Серверная синхронизация и шифрование пока не реализованы.</p></div></section>
    `, { title: "Общие настройки", subtitle: "Приложение и все самолёты", back: true, settings: false });

    function setAllNotifications(enabled) {
      const previous = state.globalNotifications;
      const flags = state.aircraft.map((item) => item.notifications);
      state.globalNotifications = enabled;
      state.aircraft.forEach((item) => { item.notifications = enabled; });
      if (!saveState()) {
        state.globalNotifications = previous;
        state.aircraft.forEach((item, index) => { item.notifications = flags[index]; });
        render();
        showToast("Не удалось сохранить уведомления");
        return;
      }
      if (enabled) window.AndroidBridge?.requestNotifications?.();
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
        if (!setBoardNotifications(targetAircraft, event.target.checked)) { render(); return; }
        showToast(`${targetAircraft.type}, борт ${targetAircraft.boardNumber}: уведомления ${targetAircraft.notifications ? "включены" : "выключены"}`);
      });
    });
  }

  function bindCommonActions() {
    document.querySelectorAll("[data-board-menu]").forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.boardMenu === "delete-board") {
        removeAircraft(button.dataset.boardId);
        return;
      }
      state.selectedAircraftId = button.dataset.boardId;
      navigateTo(button.dataset.boardMenu);
    }));
    document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.view === "usage-map") state.mapShiftId = selectedAircraft().shifts.at(-1)?.id || "no-work";
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
    const aircraft = aircraftForm ? null : selectedAircraft();
    const template = aircraft?.workTemplate;
    const canAddAirframe = aircraft && !aircraft.blocks.some((block) => block.kind === "airframe");
    const freePositions = template?.positions.filter((position) => position.kind === "engine" &&
      !enginePositionOccupied(aircraft, position.id, todayIso())) || [];
    const title = aircraftForm ? "Добавить самолёт" : "Новая карточка";
    app.innerHTML = shell(`
      ${aircraftForm ? `<h1>${title}</h1>` : ""}
      <form id="creation-form" class="shift-form settings-form form-grid">
        ${aircraftForm ? `
          <label>Тип самолёта${aircraftTypeSelect()}</label>
          <p class="field-help">Типы добавляются в общих настройках.</p>
          <label>Бортовой номер<input name="boardNumber" type="text" required></label>
          <label>Заводской номер<input name="serialNumber" type="text"></label>
          <label>RF<input name="rfNumber" type="text" placeholder="Например, 33738"></label>
          <div id="creation-usage" class="form-span"></div>` : `
          <label class="form-span">Что добавить<select name="kind"><option value="unit">Формуляр агрегата</option><option value="engine">Формуляр двигателя</option>${canAddAirframe ? '<option value="airframe">Формуляр планера</option>' : ""}</select></label>
          <label>Название<input name="name" type="text" required></label>
          <label id="new-block-serial">Заводской номер<input name="serialNumber" type="text"></label>
          ${template && freePositions.length ? `<label class="form-span" id="template-new-slot" hidden>Свободная позиция двигателя<select name="templateSlotId" disabled><option value="">Выбрать позицию</option>
            ${freePositions.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}${item.model ? ` · ${escapeHtml(item.model)}` : ""}</option>`).join("")}
          </select></label>` : ""}
          ${template && !freePositions.length ? '<p class="form-span field-help" id="no-engine-position" hidden>Свободных позиций нет. Для замены сначала оформи демонтаж установленного двигателя.</p>' : ""}
          <label class="form-span">Описание<input name="caption" type="text"></label>
          <fieldset id="new-block-usage" class="form-span"><legend>Учёт наработки</legend>${aggregateRuleFields()}</fieldset>`}
        <p class="form-span" id="creation-error" role="alert"></p>
        <button class="primary-button" type="submit">${aircraftForm ? title : "Добавить"}</button>
      </form>`, { title, singleLine: !aircraftForm, subtitle: aircraftForm ? undefined : "", back: true, settings: false });
    const form = document.getElementById("creation-form");
    const usage = aircraftForm ? bindCreationUsage(form) : null;
    const aggregateRules = aircraftForm ? null : bindAggregateRules(document.getElementById("new-block-usage"), aircraft);
    if (!aircraftForm) {
      const slot = form.elements.templateSlotId;
      const unavailable = document.getElementById("no-engine-position");
      const serial = form.elements.serialNumber;
      const syncKind = () => {
        const { value: kind } = form.elements.kind;
        const engine = kind === "engine";
        const airframe = kind === "airframe";
        if (slot) {
          slot.closest("label").hidden = !engine;
          slot.disabled = !engine;
          slot.required = engine;
        }
        if (unavailable) unavailable.hidden = !engine;
        serial.disabled = serial.closest("label").hidden = airframe;
        const ruleSection = document.getElementById("new-block-usage");
        ruleSection.disabled = ruleSection.hidden = airframe;
        form.querySelector('button[type="submit"]').disabled = engine && Boolean(unavailable);
      };
      syncKind();
      form.elements.kind.addEventListener("change", syncKind);
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = Object.fromEntries([...new FormData(event.currentTarget)].map(([key, value]) => [key, value.trim()]));
      if (aircraftForm ? !activeAircraftTypes().includes(data.type) || !data.boardNumber : !data.name) {
        document.getElementById("creation-error").textContent = "Заполни обязательные поля.";
        return;
      }
      if (aircraftForm) createAircraft({ ...data, ...usage.read() });
      else {
        try { createBlock({ ...data, usageCounters: data.kind === "airframe" ? [] : aggregateRules.read() }); }
        catch (error) { document.getElementById("creation-error").textContent = error.message; }
      }
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
          ${sourceDefinitionFields('<label>Название<input name="newSource" type="text" maxlength="80"></label>',
            available.length ? `<label class="usage-source-choice">Из списка<select name="existingSource"><option value="">Выбрать</option>${available.map(({ key, label }) =>
              `<option value="${key}">${escapeHtml(label)}</option>`).join("")}</select></label>` : "")}
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

  function buildAircraft({ type, boardNumber, serialNumber, rfNumber, enabledUsageSources, customUsageSources, usageFactors },
    workTemplate = state.templateCatalog.find((item) => item.name === type)) {
    const template = state.typeSettings.find((entry) => entry.type.toLowerCase() === type.toLowerCase());
    const sameType = state.aircraft.find((item) => item.type.toLowerCase() === type.toLowerCase());
    const boardId = `aircraft-${id()}`;
    const aircraft = {
      id: boardId,
      type: type.trim(),
      boardNumber: boardNumber.trim(),
      enabledUsageSources,
      customUsageSources,
      usageFactors,
      ...(workTemplate && { workTemplate: structuredClone(workTemplate) }),
      serialNumber: serialNumber || "Не указан",
      rfNumber: normalizeIdentifier("rfNumber", rfNumber || ""),
      notifications: state.globalNotifications,
      totalFlightMinutes: 0,
      actualLandings: 0,
      equivalentLandings: 0,
      arresterHooks: 0,
      settings: structuredClone(template?.settings ?? sameType?.settings ?? DEFAULT_AIRCRAFT_SETTINGS),
      notificationConfig: structuredClone(DEFAULT_NOTIFICATION_CONFIG),
      shifts: [],
      blocks: (workTemplate ? workTemplate.positions.map((position) => ({
        id: id(), name: position.label, kind: position.kind, model: position.model, caption: position.model,
        templateSlotId: position.id,
      })) : [
        { id: "airframe", kind: "airframe", name: "Формуляр самолёта", caption: "Планер и общая наработка" },
        { id: "engine-left", kind: "engine", name: "Левый двигатель", caption: "Формуляр двигателя" },
        { id: "engine-right", kind: "engine", name: "Правый двигатель", caption: "Формуляр двигателя" },
        { id: "vka", kind: "unit", name: "ВКА", caption: "Выносная коробка агрегатов" },
        { id: "gtde", kind: "unit", name: "ГТДЭ / ВСУ", caption: "Вспомогательная энергоустановка" },
      ]).map((block) => normalizeBlock({ status: "ok", ...block })),
      resources: [],
    };
    if (workTemplate) {
      if (workTemplate.operationTypes) {
        aircraft.operationTypes = structuredClone(workTemplate.operationTypes);
        aircraft.defaultOperationType = workTemplate.defaultOperationType || aircraft.operationTypes[0].id;
      }
      applyTemplateLayout(aircraft, workTemplate);
      if (workTemplate.positions.some((position) => position.usageCounters)) {
        for (const block of aircraft.blocks) {
          const rules = templatePositionFor(aircraft, block)?.usageCounters;
          if (!rules) continue;
          const labels = new Map(aggregateUsageSources(aircraft, true, { ...block, usageCounters: rules }).map(({ key, label }) => [key, label]));
          block.usageCounters = rules.map((rule) => ({
            ...rule, id: id(), sourceLabel: rule.source === "formula" ? "Формула из граф" : labels.get(rule.source),
            ...(rule.additionalInputs?.length && { additionalInputs: rule.additionalInputs.map((input) =>
              ({ ...input, sourceLabel: labels.get(input.source) })) }),
          }));
          block.usageTotals = {};
        }
      }
      applyTemplateFormLayouts(aircraft);
    }
    return aircraft;
  }

  function createAircraft(data) {
    finishAircraftCreation(buildAircraft(data));
  }

  function finishAircraftCreation(aircraft) {
    const previous = { aircraft: state.aircraft, selectedAircraftId: state.selectedAircraftId, aircraftTab: state.aircraftTab, view: state.view };
    state.aircraft = [...state.aircraft, aircraft];
    state.selectedAircraftId = aircraft.id;
    state.aircraftTab = "aggregates";
    state.view = "aircraft";
    if (!saveState()) { Object.assign(state, previous); showToast("Не удалось сохранить борт"); return false; }
    render();
    showToast("Самолёт добавлен");
    return true;
  }

  function createBlock({ name, kind, caption, serialNumber, templateSlotId, usageCounters }) {
    const aircraft = selectedAircraft();
    if (kind === "airframe" && aircraft.blocks.some((block) => block.kind === "airframe")) throw new Error("У борта уже есть формуляр планера");
    const slot = kind === "engine" && aircraft.workTemplate?.positions.find((item) => item.kind === "engine" && item.id === templateSlotId);
    if (kind === "engine" && aircraft.workTemplate && (!slot || enginePositionOccupied(aircraft, slot.id, todayIso()))) {
      throw new Error("Выбери свободную позицию двигателя");
    }
    aircraft.blocks.push(normalizeBlock({
      id: `unit-${id()}`,
      kind,
      name: name.trim(),
      serialNumber,
      caption: caption.trim(),
      ...(slot && { templateSlotId: slot.id, model: slot.model, events: [{ id: id(), type: "install", date: todayIso(), note: "" }] }),
      status: "ok",
      ...(usageCounters.length && { usageCounters: storedCounterRules(usageCounters), usageTotals: initialCounterTotals(usageCounters) }),
      ...(kind === "engine" ? { sneMinutes: 0, starts: 0 } : {}),
    }));
    if (!saveState()) {
      aircraft.blocks.pop();
      throw new Error("Не удалось сохранить формуляр");
    }
    navigateBack();
    showToast("Формуляр добавлен");
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

  function removeAircraft(aircraftId) {
    const aircraft = state.aircraft.find((item) => item.id === aircraftId);
    if (!aircraft) return;
    const name = `${aircraft.type} · борт ${aircraft.boardNumber}`;
    chooseLayoutAction(`Удалить «${escapeHtml(name)}»?`,
      [["cancel", "Отмена"], ["delete", "Удалить борт", "danger-button"]], (action) => {
        if (action !== "delete") return;
        const previous = { aircraft: state.aircraft, selectedAircraftId: state.selectedAircraftId };
        state.aircraft = state.aircraft.filter((item) => item.id !== aircraftId);
        if (state.selectedAircraftId === aircraftId) state.selectedAircraftId = state.aircraft[0]?.id ?? null;
        if (!saveState()) {
          Object.assign(state, previous);
          showToast("Не удалось удалить борт");
          return;
        }
        render();
        showToast(`Удалён ${name}`);
      }, "Формуляры, ресурсы и история работ этого борта будут удалены без возможности восстановления.");
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

  function setBoardNotifications(aircraft, enabled) {
    const previous = aircraft.notifications;
    aircraft.notifications = state.globalNotifications && enabled;
    if (!saveState()) {
      aircraft.notifications = previous;
      showToast("Не удалось сохранить уведомления");
      return false;
    }
    if (aircraft.notifications) window.AndroidBridge?.requestNotifications?.();
    return true;
  }

  function syncAndroidReminders() {
    if (typeof window.AndroidBridge?.syncResourceReminders !== "function") return;
    try { window.AndroidBridge.syncResourceReminders(JSON.stringify(resourceReminders())); }
    catch (_) { recordDiagnostic("reminders.sync.error"); }
  }

  function resourceReminders() {
    if (!state.globalNotifications) return [];
    const now = Date.now();
    const today = todayIso();
    return state.aircraft.filter((aircraft) => aircraft.notifications).flatMap((aircraft) => {
      const config = aircraft.notificationConfig;
      return aircraft.resources.flatMap((resource) => {
        const category = resource.notificationCategory || "resourceUsage";
        if (resource.notifyApp === false || (config.mode === "selected" && !config.categories[category]) ||
            (resource.installed && resource.installed > today)) return [];
        const label = `${aircraft.type}, борт ${aircraft.boardNumber} · ${resource.name}`;
        const key = JSON.stringify([aircraft.id, resource.id]);
        const dueAlert = resource.notifyOnDue !== false;
        if (resource.unit === "дн." || category.endsWith("Date")) {
          if (!resource.expiryDate) return [];
          const end = new Date(`${resource.expiryDate}T09:00:00`);
          const when = end.getTime();
          if (!Number.isFinite(when)) return [];
          const days = Math.max(0, Math.trunc(resource.advanceValue ?? config.leadDays));
          const alerts = [];
          if (days && now < when) {
            end.setDate(end.getDate() - days);
            alerts.push({ key: `${key}:date:${resource.expiryDate}:advance`, at: end.getTime(), body: `${label} · приближается срок` });
          }
          if (dueAlert) alerts.push({ key: `${key}:date:${resource.expiryDate}:due`, at: when, body: `${label} · наступил срок` });
          return alerts;
        }
        const owner = resourceOwner(aircraft, resource);
        if ((resource.objectId && !owner) || (owner && !blockInstalledOn(owner, today))) return [];
        const remaining = Number(resource.remaining);
        if (!(resource.limit > 0) || !Number.isFinite(remaining)) return [];
        const threshold = resource.advanceValue ?? 3;
        const phase = remaining <= 0 ? (dueAlert ? "due" : "") : (remaining <= threshold ? "advance" : "");
        return phase ? [{
          key: `${key}:usage:${resource.limit}:${phase}`, at: 0,
          body: `${label} · остаток ${formatNumber(remaining, 6)} ${resource.unit}`,
        }] : [];
      });
    });
  }

  function addNearestWorkToCalendar() {
    const aircraft = selectedAircraft();
    if (!aircraft) { showToast("Добавь самолёт для календарных работ"); return; }
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
      advanceValue: null,
      notifyOnDue: true,
      ...resource,
    };
    if (normalized.unit === "дн." && normalized.expiryDate) {
      const end = Date.parse(normalized.expiryDate);
      if (Number.isFinite(end)) {
        normalized.remaining = Math.max(0, (end - Date.parse(todayIso())) / 86400000);
      }
    }
    if (normalized.unit === "дн.") {
      normalized.notificationCategory = normalized.notificationCategory?.startsWith("work") ? "workDate" : "resourceDate";
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
  syncAndroidReminders();
})();
