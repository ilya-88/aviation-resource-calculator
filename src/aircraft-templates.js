(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./formulas.js") : root.formulas);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.aircraftTemplates = api;
})(globalThis, function (formulas) {
  "use strict";

  const landingRoles = ["runway", "carrier", "touch", "circuit", "arresterHooks"];
  const boardRoles = ["flight", ...landingRoles];
  const aggregateUnits = ["шт.", "ч", "мин", "с", "пос.", "зап.", "сраб."];
  const counterRoles = ["starts", "total", "flight", "ground", "or", "combat", "combined"];
  const scopes = ["board", "engine"];
  const layoutTabs = ["works", "aggregates", "least-reliable"];
  const navigationKeys = ["widget:board-tabs", "widget:board-aggregates", "widget:board-resources"];
  const layoutKeys = ["flightSne", "flightPpr", "landingSne", "landingPpr", "widget:resources", "widget:shift",
    "widget:add-block:aggregates", "widget:add-resource:works", "widget:add-resource:least-reliable", "widget:reports"];
  const formKeys = new Set([
    ...landingRoles.map((key) => `form:landing-count-${key}`),
    ...["name", "caption", "serialNumber", "rfNumber", "drawingNumber", "manufactureDate", "installed", "repairs", "model",
      "pprFlightMinutes", "pprLandings", "sneMinutes", "pprMinutes", "sneLandings", "starts", "groundPercent",
      "groundStep", "groundDirection"].map((key) => `form-field:${key}`),
    ...["journal", "resources-title", "resources-empty", "events-title", "events-empty", "airframe-usage-title",
      "assemblies-title", "assemblies-empty", "installation-history-title", "installation-history-empty",
      "aggregate-settings", "aggregate-log"].map((key) => `form:${key}`),
    ...["add-resource", "attach-existing-resource", "correct-usage", "save", "save-event"].map((key) => `form-action:${key}`),
    ...["type", "date", "note"].map((key) => `event-field:${key}`),
  ]);
  const isFormKey = (key) => formKeys.has(key) || (typeof key === "string" && /^form-metric:\d{1,3}$/.test(key));
  const legacySu33Units = [
    { id: "vka-1", oldLabel: "ВКА № 1", label: "Левая ВКА", source: "engine-left", counters: "all" },
    { id: "vka-2", oldLabel: "ВКА № 2", label: "Правая ВКА", source: "engine-right", counters: "all" },
    { id: "gtde-1", oldLabel: "ГТД-Э № 1", label: "Левый ГТДЭ", source: "engine-left", counters: ["starts"] },
    { id: "gtde-2", oldLabel: "ГТД-Э № 2", label: "Правый ГТДЭ", source: "engine-right", counters: ["starts"] },
  ];

  const timeUnits = { "ч": 3600, "мин": 60, "с": 1 };
  function dimension(unit) {
    if (Object.hasOwn(timeUnits, unit)) return "duration";
    if (unit === "текст") return "text";
    if (unit === "дата") return "date";
    if (unit === "дн.") return "period";
    return "count";
  }
  function unitScale(from, to) {
    if (dimension(from) !== dimension(to)) throw new Error(`Несовместимые единицы: ${from} и ${to}`);
    return (timeUnits[from] || 1) / (timeUnits[to] || 1);
  }
  function rawSourceList(template) {
    const result = [];
    for (const field of template.inputs) {
      const unit = field.type === "duration" ? "с" : "шт.";
      const slots = field.scope === "board" ? [{ id: "board", label: "Самолёт" }] : template.positions.filter(p => p.kind === "engine");
      for (const slot of slots) result.push({ key: `raw:${slot.id}:${field.id}`, label: `Запись о работе · ${slot.label} · ${field.label}`, unit });
    }
    return result;
  }

  function requireValue(condition, message) {
    if (!condition) throw new Error(message);
  }

  function label(value, where) {
    requireValue(typeof value === "string" && value.trim() && value.length <= 120, `Укажи название: ${where}`);
    return value.trim();
  }

  function identifier(value, where) {
    requireValue(typeof value === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(value) && !Object.hasOwn(Object.prototype, value),
      `Недопустимый идентификатор: ${where}`);
    return value;
  }

  function list(value, where, read) {
    requireValue(Array.isArray(value) && value.length <= 120, `Ожидался список: ${where}`);
    return value.map((entry, index) => {
      requireValue(entry && typeof entry === "object" && !Array.isArray(entry), `Некорректная запись: ${where}, ${index + 1}`);
      return read(entry);
    });
  }

  function unique(rows, key, where) {
    requireValue(new Set(rows.map((row) => row[key])).size === rows.length, `Повторяются ключи: ${where}`);
  }

  function field(row, scope) {
    const id = identifier(row.id, "поле");
    const type = row.type;
    requireValue(type === "count" || type === "duration", `Неизвестный тип значения: ${id}`);
    requireValue(type !== "duration" || ["HH:MM", "HH:MM:SS"].includes(row.format), `Неизвестный формат времени: ${id}`);
    return { id, label: label(row.label, id), type, format: type === "duration" ? row.format : "count", scope };
  }

  function normalizeFlightLabel(value) {
    return typeof value === "string" && /^нал[её]т по вылету$/iu.test(value.trim()) ? "Налёт" : value;
  }

  function normalizeTemplateFlightLabel(template) {
    const needsUpdate = (field) => field?.scope === "board" && field.role === "flight" && normalizeFlightLabel(field.label) !== field.label;
    if (!Array.isArray(template?.inputs) || !template.inputs.some(needsUpdate)) return template;
    return { ...template, inputs: template.inputs.map((field) => needsUpdate(field) ? { ...field, label: normalizeFlightLabel(field.label) } : field) };
  }

  function upgradeLegacySu33(template) {
    if (template?.id !== "su-33" || template.schemaVersion !== 1 || !Array.isArray(template.positions) ||
        !legacySu33Units.every((unit) => template.positions.some((position) =>
          position?.id === unit.id && position.kind === "unit" && position.label === unit.oldLabel && !position.engineLink))) return template;
    return { ...template, positions: template.positions.map((position) => {
      const unit = legacySu33Units.find((entry) => entry.id === position?.id);
      if (!unit) return position;
      return { ...position, label: unit.label, engineLink: { source: unit.source, counters: unit.counters } };
    }) };
  }

  function positionCounters(template, position) {
    if (position?.kind === "engine" || position?.engineLink?.counters === "all") return template.engineCounters;
    if (!position?.engineLink) return [];
    return template.engineCounters.filter((field) => position.engineLink.counters.includes(field.id));
  }

  function layoutTile(row, allowed) {
    requireValue(Array.isArray(row.keys) && row.keys.length > 0 && row.keys.every(allowed),
      "Раскладка ссылается на неизвестную карточку");
    const clean = { keys: [...row.keys], wide: row.wide === true };
    for (const [key, min, max] of [["span", 2, 12], ["columnStart", 1, 120], ["height", 0, 10000], ["font", 0.65, 1.7]]) {
      if (row[key] == null) continue;
      requireValue(Number.isFinite(row[key]) && row[key] >= min && row[key] <= max &&
        (key !== "columnStart" || Number.isInteger(row[key])), `Недопустимый размер или положение карточки: ${key}`);
      clean[key] = row[key];
    }
    if (row.labels) clean.labels = Object.fromEntries(row.keys.filter((key) => Object.hasOwn(row.labels, key))
      .map((key) => [key, label(row.labels[key], "подпись карточки")]));
    return clean;
  }

  function validateLayout(layout, positions) {
    requireValue(layout && typeof layout === "object" && !Array.isArray(layout), "Некорректная раскладка карточек");
    const validKeys = new Set([...layoutKeys, ...positions.map((position) => `slot:${position.id}`)]);
    const tabs = Object.fromEntries(layoutTabs.filter((tab) => layout.tabs?.[tab] != null).map((tab) => {
      const tiles = list(layout.tabs[tab], "карточки", (row) => layoutTile(row, (key) => validKeys.has(key)));
      const keys = tiles.flatMap((row) => row.keys);
      requireValue(new Set(keys).size === keys.length, "Карточка указана в раскладке дважды");
      return [tab, tiles];
    }));
    const navigation = layout.navigation == null ? null : list(layout.navigation, "вкладки раскладки", (row) => {
      requireValue(Number.isInteger(row.index) && row.index >= 0 && row.index <= 120 && row.tile, "Некорректное положение вкладки");
      return { index: row.index, tile: layoutTile(row.tile, (key) => navigationKeys.includes(key)) };
    });
    if (navigation) {
      const keys = navigation.flatMap((row) => row.tile.keys);
      requireValue(keys.length === navigationKeys.length && new Set(keys).size === navigationKeys.length,
        "Раскладка должна содержать все вкладки по одному разу");
    }
    return { tabs, ...(navigation && { navigation }) };
  }

  function validateFormLayout(layout, position, positions) {
    requireValue(layout && typeof layout === "object" && !Array.isArray(layout), "Некорректная раскладка формуляра");
    const extra = new Set((position.usageCounters || []).map((_, index) => `form:aggregate-counter-index:${index}`));
    if (position.kind === "airframe") {
      for (const item of positions.filter(({ kind }) => kind !== "airframe")) extra.add(`form:assembly-slot:${item.id}`);
    }
    const allowed = (key) => isFormKey(key) || extra.has(key);
    const tiles = list(layout.tiles, "карточки формуляра", (row) => layoutTile(row, allowed));
    const hidden = layout.hidden || [];
    requireValue(Array.isArray(hidden) && hidden.length <= 120 && hidden.every(allowed), "Неизвестная скрытая карточка формуляра");
    const keys = [...tiles.flatMap((tile) => tile.keys), ...hidden];
    requireValue(new Set(keys).size === keys.length, "Карточка указана в раскладке дважды");
    return { tiles, hidden: [...hidden] };
  }

  function validateTemplate(document) {
    document = normalizeTemplateFlightLabel(upgradeLegacySu33(document));
    requireValue(document && document.schemaVersion === 1, "Поддерживается версия шаблона 1");
    const id = identifier(document.id, "шаблон");
    const name = label(document.name, id);
    const operationTypes = document.operationTypes == null ? null : list(document.operationTypes, "виды работы", row => {
      requireValue(typeof row.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(row.id), "Проверь идентификатор вида работы");
      return { id: row.id, label: label(row.label, "вид работы") };
    });
    if (operationTypes) {
      requireValue(operationTypes.length > 0, "Нужен хотя бы один вид работы");
      unique(operationTypes, "id", "виды работы");
      if (document.defaultOperationType != null) requireValue(operationTypes.some(row => row.id === document.defaultOperationType), "Неизвестный вид работы по умолчанию");
    }
    const positions = list(document.positions, "позиции", (row) => {
      const position = identifier(row.id, "позиция");
      requireValue(position !== "board", "Идентификатор board занят данными самолёта");
      requireValue(["airframe", "engine", "unit"].includes(row.kind), `Неизвестный вид формуляра: ${position}`);
      return { id: position, label: label(row.label, position), kind: row.kind, model: row.model ? label(row.model, position) : "",
        ...(row.engineLink != null && { engineLink: row.engineLink }),
        ...(row.usageCounters != null && { usageCounters: row.usageCounters }),
        ...(row.formLayout != null && { formLayout: row.formLayout }) };
    });
    unique(positions, "id", "позиции");
    requireValue(positions.filter((row) => row.kind === "airframe").length === 1, "Шаблону нужен один формуляр самолёта");
    const groups = list(document.repeatGroups || [], "повторяющиеся строки", (row) => {
      const group = identifier(row.id, "повторяющиеся строки");
      requireValue(scopes.includes(row.scope), `Неизвестная область ввода: ${group}`);
      return { id: group, label: label(row.label, group), scope: row.scope,
        ...(row.countField != null && { countField: identifier(row.countField, group) }) };
    });
    unique(groups, "id", "повторяющиеся строки");
    const inputs = list(document.inputs, "поля ввода", (row) => {
      requireValue(scopes.includes(row.scope), `Неизвестная область ввода: ${row.id}`);
      const input = field(row, row.scope);
      if (row.group != null) {
        requireValue(groups.some((group) => group.id === row.group && group.scope === row.scope), `Не найдена группа поля: ${input.id}`);
        input.group = row.group;
      }
      if (row.role != null) {
        requireValue(row.scope === "board" && (row.role === "flight" ? row.type === "duration" : landingRoles.includes(row.role) && row.type === "count"),
          `Некорректная роль поля: ${input.id}`);
        input.role = row.role;
      }
      return input;
    });
    unique(inputs, "id", "поля ввода");
    unique(inputs.filter((row) => row.role), "role", "показатели борта");
    requireValue(groups.every((group) => inputs.some((input) => input.group === group.id)), "Пустая группа повторяющихся строк");
    for (const group of groups.filter((row) => row.countField)) {
      requireValue(inputs.some((field) => field.id === group.countField && field.scope === group.scope && field.type === "count" && !field.group),
        `Число строк должно ссылаться на поле количества: ${group.id}`);
    }
    requireValue(inputs.some((row) => row.role === "flight"), "Укажи поле налёта борта");
    const counters = list(document.engineCounters || [], "графы двигателя", (row) => {
      const counter = field(row, "engine");
      if (row.role != null) {
        requireValue(counterRoles.includes(row.role) && row.type === (row.role === "starts" ? "count" : "duration"),
          `Некорректная роль графы: ${counter.id}`);
        counter.role = row.role;
      }
      return counter;
    });
    unique(counters, "id", "графы двигателя");
    unique(counters.filter((row) => row.role), "role", "счётчики двигателя");
    for (const position of positions.filter((row) => row.engineLink != null)) {
      const { source, counters: selected } = position.engineLink;
      requireValue(position.kind === "unit" && positions.some((row) => row.id === source && row.kind === "engine"),
        `Укажи двигатель для агрегата: ${position.id}`);
      requireValue(selected === "all" ? counters.length > 0 : Array.isArray(selected) && selected.length > 0 &&
        selected.length <= counters.length && new Set(selected).size === selected.length &&
        selected.every((key) => counters.some((counter) => counter.id === key)),
      `Укажи существующие графы для агрегата: ${position.id}`);
      position.engineLink = { source, counters: selected === "all" ? selected : [...selected] };
    }
    const engineInput = (key) => inputs.find((row) => row.id === key && row.scope === "engine");
    const rules = list(document.rules || [], "правила начисления", (row) => {
      const target = counters.find((counter) => counter.id === row.target);
      requireValue(target, `Графа назначения не найдена: ${row.target}`);
      if (row.operation === "copy") {
        requireValue(engineInput(row.source)?.type === target.type, `Несовместимый источник: ${row.target}`);
        return { operation: "copy", source: row.source, target: row.target };
      }
      requireValue(row.operation === "flight_plus_ground", `Неизвестная операция для: ${row.target}`);
      requireValue(target.type === "duration" && engineInput(row.flight)?.type === "duration" && engineInput(row.ground)?.type === "duration",
        `Для итога нужны два поля времени: ${row.target}`);
      requireValue(Number.isInteger(row.stepMinutes) && row.stepMinutes > 0 && row.stepMinutes <= 1440 &&
        Number.isFinite(row.percent) && row.percent >= 0 && row.percent <= 100 &&
        ["nearest", "up", "down"].includes(row.direction), `Некорректное округление или процент: ${row.target}`);
      return { operation: "flight_plus_ground", target: row.target, flight: row.flight, ground: row.ground,
        stepMinutes: row.stepMinutes, percent: row.percent, direction: row.direction };
    });
    unique(rules, "target", "правила начисления");
    const boardUsage = document.boardUsage == null ? null : list(document.boardUsage, "показатели борта", (row) => {
      const key = boardRoles.includes(row.key) ? row.key : identifier(row.key, "показатель борта");
      const custom = key.startsWith("custom-");
      requireValue(custom || boardRoles.includes(key), `Неизвестный показатель борта: ${key}`);
      requireValue(typeof row.enabled === "boolean" && Number.isFinite(row.factor) && row.factor >= 0,
        `Проверь доступность и коэффициент показателя: ${key}`);
      if (custom) {
        requireValue(row.kind === "count" || (row.kind === "time" && ["hours", "seconds"].includes(row.format)),
          `Проверь тип и формат показателя: ${key}`);
      }
      return { key, label: label(row.label, key), enabled: row.enabled, factor: row.factor,
        ...(custom && { kind: row.kind, ...(row.kind === "time" && { format: row.format }) }) };
    });
    if (boardUsage) unique(boardUsage, "key", "показатели борта");
    const boardKeys = new Set([...boardRoles, ...(boardUsage || []).map(({ key }) => key)]);
    const engineKeys = new Set(positions.filter((position) => position.kind === "engine").flatMap((position) =>
      rules.map((rule) => `position:${position.id}:${rule.target}`)));
    const rawSources = rawSourceList({ inputs, positions });
    const rawKeys = new Set(rawSources.map(item => item.key));
    for (const position of positions.filter((row) => row.usageCounters != null)) {

      requireValue(Array.isArray(position.usageCounters), "Проверь список показателей формуляра");
      const localFields = new Map();
      for (const field of position.usageCounters.filter(item => item?.fieldKey != null)) {
        requireValue(typeof field.fieldKey === "string" && /^[a-z0-9-]{1,64}$/.test(field.fieldKey) && field.source === "manual" &&
          field.workMode && !localFields.has(field.fieldKey), "Некорректный идентификатор поля ввода");
        localFields.set(field.fieldKey, field.unit);
      }
      position.usageCounters = list(position.usageCounters, position.id, (row) => {
        const name = label(row.name, position.id);
        const workFilter = row.workTypeId ? { workTypeId: row.workTypeId } : {};
        if (row.workTypeId) requireValue((operationTypes || [{id:"0"}, {id:"1"}, {id:"2"}]).some(item => item.id === row.workTypeId), "Вид работы графы отсутствует в шаблоне");
        function parseInput({ source, factor }) {
          requireValue(source === "manual" || (typeof source === "string" && source.startsWith("board:") && boardKeys.has(source.slice(6))) ||
            engineKeys.has(source) || (row.workMode && (rawKeys.has(source) || (typeof source === "string" && source.startsWith("local:") && localFields.has(source.slice(6)) && source !== "local:" + row.fieldKey) || ["work:date", "work:type"].includes(source))), `Не найден источник показателя «${name}» в формуляре «${position.label}»`);
          requireValue(Number.isFinite(factor) && factor >= 0 && factor <= 1000000, `Проверь коэффициент показателя «${name}»`);
          return { source, factor };
        }
        if (row.workMode != null) {
          requireValue(["entry", "total"].includes(row.workMode), "Неизвестное назначение графы");
          requireValue(!["дата", "текст"].includes(row.unit) || row.workMode === "entry", "Дата и текст сохраняются только за работу");
        }
        requireValue(aggregateUnits.includes(row.unit) || (row.workMode && ["дата", "дн.", "текст"].includes(row.unit)), `Проверь единицу показателя «${name}»`);
        if (row.columnKey != null) requireValue(typeof row.columnKey === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(row.columnKey), "Некорректная ссылка графы");
        if (row.source === "formula") {
          requireValue(row.unit !== "текст", "Текст нельзя вычислить по формуле");
          requireValue(row.workMode && row.formula && row.factor === 1 && !row.additionalInputs?.length, "Проверь формулу графы");
          return { name, ...workFilter, columnKey: row.columnKey, source: "formula", factor: 1, workMode: row.workMode, unit: row.unit, formula: row.formula };
        }
        const primary = parseInput(row);
        const additionalInputs = row.additionalInputs == null ? [] : list(row.additionalInputs, `источники показателя «${name}»`, parseInput);
        unique([primary, ...additionalInputs], "source", `источники показателя «${name}»`);
        if (row.workMode) {
          for (const part of [primary, ...additionalInputs]) {
            const key = part.source;
            const boardUnit = key.startsWith("board:") ? (key === "board:flight" || boardUsage?.find(item => item.key === key.slice(6))?.kind === "time" ? "ч" : "шт.") : null;
            const field = key.startsWith("position:") ? counters.find(item => item.id === key.split(":")[2]) : null;
            const engineUnit = field ? (field.type === "count" ? "шт." : field.format === "HH:MM" ? "ч" : "с") : null;
            const unit = boardUnit || engineUnit || (key.startsWith("local:") && localFields.get(key.slice(6))) || rawSources.find(item => item.key === key)?.unit ||
              (key === "work:date" ? "дата" : key === "work:type" ? "текст" : null);
            if (unit) unitScale(unit, row.unit);
          }
          requireValue(!["дата", "текст"].includes(row.unit) || (!additionalInputs.length && primary.factor === 1), "Для даты или текста выбери один источник без коэффициента");
        }
        return { name, ...workFilter, ...(row.columnKey && { columnKey: row.columnKey }), ...(row.workMode && { workMode: row.workMode }), ...(row.fieldKey && { fieldKey: row.fieldKey }), source: primary.source, unit: row.unit, factor: primary.factor, ...(additionalInputs.length && { additionalInputs }) };
      });
      if (position.usageCounters.some(row => row.columnKey || row.source === "formula")) {
        const external = [...rawSources, { key: "work:date", unit: "дата" },
          ...[...boardKeys].map(key => ({ key: "board:" + key, unit: key === "flight" || boardUsage?.find(row => row.key === key)?.kind === "time" ? "ч" : "шт." })),
          ...[...engineKeys].map(key => { const field = counters.find(row => row.id === key.split(":")[2]);
            return { key, unit: field.type === "count" ? "шт." : field.format === "HH:MM" ? "ч" : "с" }; }),
          ...[...localFields].map(([key, unit]) => ({ key: "local:" + key, unit }))];
        position.usageCounters.forEach((row, i) => { row.columnKey ??= "slot-" + i; });
        formulas.order(position.usageCounters, formulas.catalog(position.usageCounters, external));
      }
    }
    const checks = list(document.checks || [], "проверки вложенности", (row) => {
      requireValue(Array.isArray(row.ascending) && row.ascending.length >= 2 && row.ascending.length <= 12 &&
        new Set(row.ascending).size === row.ascending.length && row.ascending.every((key) => engineInput(key)?.type === "duration"),
        "Проверка вложенности должна ссылаться на графы времени одного двигателя");
      return { ascending: [...row.ascending] };
    });
    requireValue(positions.some((row) => row.kind === "engine") || (counters.length === 0 && !inputs.some((row) => row.scope === "engine")),
      "Поля двигателя требуют хотя бы одну позицию двигателя");
    const layout = document.layout == null ? null : validateLayout(document.layout, positions);
    for (const position of positions) {
      if (position.formLayout != null) position.formLayout = validateFormLayout(position.formLayout, position, positions);
    }
    return { schemaVersion: 1, id, name, workTitle: label(document.workTitle || "Исходные данные работы", "форма ввода"),
      positions, repeatGroups: groups, inputs, engineCounters: counters, rules, checks, ...(operationTypes && { operationTypes, defaultOperationType: document.defaultOperationType ?? operationTypes[0].id }),
      ...(boardUsage && { boardUsage }), ...(layout && { layout }) };
  }

  function parseValue(field, raw) {
    const value = String(raw ?? "").trim();
    if (!value) return null;
    if (field.type === "count") {
      const count = Number(value);
      requireValue(/^\d+$/.test(value) && Number.isSafeInteger(count) && count <= 1000000000, `«${field.label}»: введи целое число`);
      return count;
    }
    const pattern = field.format === "HH:MM:SS" ? /^(\d{1,6}):([0-5]\d):([0-5]\d)$/ : /^(\d{1,6}):([0-5]\d)$/;
    const parts = pattern.exec(value);
    requireValue(parts, `«${field.label}»: формат ${field.format}`);
    return Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3] || 0);
  }

  function formatValue(field, value) {
    if (value == null) return "—";
    if (field.format === "count") return String(value);
    const seconds = Math.round(value);
    const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const minutes = String(Math.floor(seconds / 60) % 60).padStart(2, "0");
    return field.format === "HH:MM:SS" ? `${hours}:${minutes}:${String(seconds % 60).padStart(2, "0")}` : `${hours}:${minutes}`;
  }

  function engineFlightInput(template) {
    const flightCounter = template.engineCounters.find((field) => field.role === "flight");
    const copy = template.rules.find((rule) => rule.operation === "copy" && rule.target === flightCounter?.id);
    if (!copy || template.rules.some((rule) => rule.operation === "flight_plus_ground" && rule.flight !== copy.source)) return null;
    return template.inputs.find((field) => field.id === copy.source && field.scope === "engine" && !field.group && field.type === "duration") || null;
  }

  function calculate(template, inputs, scope, flightLink) {
    const values = {};
    const incomplete = [];
    for (const field of template.inputs.filter((item) => item.scope === scope)) {
      const rows = field.group ? (inputs.groups[field.group] || []) : [inputs.fields];
      const entries = rows.map((row) => parseValue(field, row[field.id]));
      const present = entries.filter((entry) => entry != null);
      if (flightLink?.partial && present.length > 0 && present.length < rows.length) {
        incomplete.push(field.id);
        values[field.id] = null;
        continue;
      }
      requireValue(present.length === 0 || present.length === rows.length, `«${field.label}»: заполни все строки или оставь всю графу пустой`);
      values[field.id] = present.length ? present.reduce((sum, value) => sum + value, 0) : null;
    }
    for (const group of template.repeatGroups.filter((row) => row.scope === scope && row.countField)) {
      const count = (inputs.groups[group.id] || []).length;
      if (count && flightLink?.partial && (values[group.countField] == null || count < values[group.countField])) {
        if (values[group.countField] != null) {
          for (const field of template.inputs.filter(item => item.group === group.id && values[item.id] != null)) {
            incomplete.push(field.id);
            values[field.id] = null;
          }
        }
        continue;
      }
      if (count) requireValue(values[group.countField] === count, `«${group.label}»: число заполненных строк должно совпадать с количеством запусков`);
    }
    if (scope === "board") return { values, ...(incomplete.length && { incomplete }) };
    const flightKey = flightLink?.field?.id;
    const inheritedFlight = flightKey && values[flightKey] == null && flightLink.boardSeconds != null;
    if (inheritedFlight) values[flightKey] = flightLink.boardSeconds;
    for (const check of template.checks) {
      let previous;
      for (const key of check.ascending) {
        if (values[key] == null) continue;
        if (previous != null && values[key] < values[previous]) {
          const names = [previous, key].map((id) => template.inputs.find((field) => field.id === id).label);
          throw new Error(`Проверь вложенность: «${names[1]}» меньше «${names[0]}»`);
        }
        previous = key;
      }
    }
    const counters = {};
    const steps = {};
    for (const rule of template.rules) {
      if (rule.operation === "copy") { counters[rule.target] = values[rule.source]; continue; }
      if (incomplete.includes(rule.ground) || incomplete.includes(rule.flight)) { counters[rule.target] = null; continue; }
      let flight = values[rule.flight];
      let ground = values[rule.ground];
      if (rule.flight === flightKey && (flight != null || ground != null)) {
        flight ??= 0;
        ground ??= 0;
      }
      if (flight == null || ground == null) { counters[rule.target] = null; continue; }
      const step = rule.stepMinutes * 60;
      const round = { nearest: Math.round, up: Math.ceil, down: Math.floor }[rule.direction];
      const rounded = round(ground / step) * step;
      const credit = Math.round(rounded * rule.percent / 100);
      counters[rule.target] = flight + credit;
      steps[rule.target] = { ground, rounded, credit, flight, percent: rule.percent, stepMinutes: rule.stepMinutes };
    }
    return { values, counters, steps, ...(incomplete.length && { incomplete }), ...(inheritedFlight && { inheritedFlight: true }) };
  }

  function validateStartingAircraft(doc) {
    requireValue(doc?.kind === "aircraft-start" && doc.version === 1, "Неизвестный формат файла борта");
    const template = validateTemplate(doc.template);
    const data = doc.aircraft;
    requireValue(data && typeof data === "object", "Не указан борт");
    const number = (v, key, integer = false) => {
      requireValue(typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER &&
        (!integer || Number.isInteger(v)), `Проверь числовое значение: ${key}`);
      return v;
    };
    function readings(row, allowed, integers = []) {
      requireValue(row && typeof row === "object" && !Array.isArray(row), "Неизвестный формат показаний");
      return Object.fromEntries(Object.entries(row).map(([key, value]) => {
        requireValue(allowed.includes(key), `Неизвестное показание: ${key}`);
        return [key, number(value, key, integers.includes(key))];
      }));
    }
    function date(value) {
      if (value == null || value === "") return "";
      requireValue(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value), "Проверь календарную дату");
      return value;
    }
    const text = (value) => value == null || value === "" ? "" : label(value, "реквизиты");
    const counts = ["actualLandings", "pprLandings", "arresterHooks"];
    const board = readings(data.readings || {}, ["totalFlightMinutes", "pprFlightMinutes", "equivalentLandings", ...counts], counts);
    const landingCounts = readings(data.landingCounts || {}, landingRoles.filter((key) => key !== "arresterHooks"), landingRoles);
    const blocks = list(data.blocks || [], "формуляры борта", (row) => {
      const position = template.positions.find((item) => item.id === row.position);
      requireValue(position, "В файле есть экземпляр без позиции шаблона");
      const rules = position.usageCounters || [];
      const totals = list(row.totals || [], position.label, (entry) => {
        const counter = number(entry.counter, "номер показателя", true);
        requireValue(counter < rules.length, "Неизвестный показатель формуляра");
        return { counter, ...readings(Object.fromEntries(Object.entries(entry).filter(([k]) => k !== "counter")), ["sne", "ppr"]) };
      });
      unique(totals, "counter", position.label);
      const repairs = number(row.repairs ?? 0, "ремонты", true);
      const blockCounts = ["starts", "pprStarts", "sneLandings", "pprLandings"];
      const values = readings(row.readings || {}, ["sneMinutes", "pprMinutes", ...blockCounts], blockCounts);
      const ppr = position.kind === "airframe" ? board : values;
      requireValue(repairs || (!Object.keys(ppr).some((k) => k.startsWith("ppr")) && totals.every((entry) => entry.ppr == null)),
        `Для ППР укажи ремонт: ${position.label}`);
      const repairDate = date(row.lastRepairDate);
      requireValue(!repairDate || repairs > 0, "Дата ремонта задана при нулевом числе ремонтов");
      return { position: position.id, serialNumber: text(row.serialNumber), manufactureDate: date(row.manufactureDate),
        repairs, lastRepairDate: repairDate, readings: values, totals };
    });
    unique(blocks, "position", "экземпляры");
    if (board.pprLandings != null || board.pprFlightMinutes != null) requireValue(blocks.some((row) =>
      row.repairs && template.positions.find((p) => p.id === row.position).kind === "airframe"), "Для ППР борта укажи ремонт планера");
    const resources = list(data.resources || [], "ресурсы", (row) => {
      const position = template.positions.find((item) => item.id === row.position);
      requireValue(position && [...aggregateUnits, "дн."].includes(row.unit), "Проверь позицию и единицу ресурса");
      const limit = number(row.limit, "лимит"), remaining = number(row.remaining, "остаток");
      requireValue(remaining <= limit, "Остаток превышает полный ресурс");
      const inputs = list(row.inputs || [], "правила расхода", (input) => {
        const source = input.source;
        requireValue(typeof source === "string" && (boardRoles.includes(source) ||
          template.boardUsage?.some((item) => item.key === source) ||
          (/^counter:(0|[1-9]\d*)$/.test(source) && Number(source.slice(8)) < (position.usageCounters?.length || 0)) ||
          (/^[a-zA-Z][a-zA-Z0-9]{0,47}$/.test(source) &&
            (position.kind === "engine" || position.engineLink))), "Неизвестный источник расхода");
        if (source.startsWith("counter:")) requireValue(!["дата", "текст"].includes(position.usageCounters[Number(source.slice(8))].unit),
          "Дата и текст не могут расходовать ресурс");
        return { source, factor: number(input.factor, "коэффициент") };
      });
      unique(inputs, "source", "источники расхода");
      requireValue(row.unit !== "дн." || !inputs.length, "Для календарного срока указывается дата");
      return { position: position.id, name: label(row.name, "ресурс"), unit: row.unit, limit, remaining, inputs,
        installed: date(row.installed), produced: date(row.produced), expiryDate: date(row.expiryDate) };
    });
    return { kind: doc.kind, version: 1, template, aircraft: { boardNumber: label(data.boardNumber, "бортовой номер"),
      serialNumber: text(data.serialNumber), rfNumber: text(data.rfNumber), readings: board, landingCounts, blocks, resources } };
  }

  return { validateTemplate, validateStartingAircraft, calculate, engineFlightInput, formatValue, positionCounters, upgradeLegacySu33, layoutKeys, aggregateUnits, unitScale, dimension, rawSourceList,
    isFormKey, normalizeFlightLabel, normalizeTemplateFlightLabel };
});
