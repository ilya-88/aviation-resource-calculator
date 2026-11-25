"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const templates = require("../src/aircraft-templates");

test("строки ведомости различают отметку, ноль и пропуск", () => {
  const template = templates.validateTemplate({ schemaVersion: 1, id: "logbook", name: "Журнал",
    positions: [{ id: "body", kind: "airframe", label: "Формуляр" }],
    repeatGroups: [{ id: "entries", label: "Вылет", scope: "board", noteLabel: "Вид полёта" }],
    inputs: [
      { id: "flight", label: "Время", type: "duration", format: "HH:MM", scope: "board", role: "flight", group: "entries" },
      { id: "mark", label: "Отметка", type: "count", scope: "board", group: "entries", entryMode: "flag" },
    ] });
  const read = mark => templates.calculate(template, { fields: {}, groups: { entries: [
    { flight: "00:08", mark: "1", _note: "Учебный" }, { flight: "00:22", mark }
  ] } }, "board", { partial: true });
  assert.deepEqual(read("0").values, { flight: 1800, mark: 1 });
  assert.equal(read("1").values.mark, 2);
  assert.equal(read("").values.mark, null);
  assert.throws(() => read("2"), /да или нет/);
  assert.equal(template.repeatGroups[0].noteLabel, "Вид полёта");
});

test("налёт борта, индивидуальное время двигателя и пустая наземная смена", () => {
  const time = (id) => ({ id, type: "duration", format: "HH:MM", scope: "engine" });
  const template = { inputs: [time("air"), time("ground")], repeatGroups: [], checks: [],
    engineCounters: [{ ...time("air-total"), role: "flight" }],
    rules: [{ operation: "copy", target: "air-total", source: "air" },
      { operation: "flight_plus_ground", target: "total", flight: "air", ground: "ground", stepMinutes: 1, direction: "nearest", percent: 100 }] };
  const field = templates.engineFlightInput(template);
  assert.equal(field.id, "air");
  const calculate = (fields, boardSeconds) => templates.calculate(template, { fields, groups: {} }, "engine", { field, boardSeconds });
  assert.equal(calculate({}, 1800).counters.total, 1800);
  assert.equal(calculate({ ground: "00:06" }, 1800).counters.total, 2160);
  assert.equal(calculate({ air: "00:10" }, 1800).counters.total, 600);
  assert.equal(calculate({ air: "00:00" }, 1800).counters.total, 0);
  assert.equal(calculate({ ground: "00:06" }).counters.total, 360);
  assert.equal(calculate({}).counters.total, null);
  assert.equal(calculate({}, 1800).inheritedFlight, true);
  assert.equal(calculate({ air: "00:00" }, 1800).inheritedFlight, undefined);
  template.rules.push({ ...template.rules[1], flight: "other" });
  assert.equal(templates.engineFlightInput(template), null);
});
const su33 = require("../templates/su-33.json");

test("перенос стартового борта сохраняет типы чисел и связи после повторной сериализации", () => {
  const pack = {
    kind: "aircraft-start", version: 1,
    template: { schemaVersion: 1, id: "school", name: "Учебный", rules: [], engineCounters: [],
      inputs: [{ id: "flight", label: "Время", scope: "board", role: "flight", type: "duration", format: "HH:MM" }],
      positions: [{ id: "frame", kind: "airframe", label: "Планер" },
        { id: "meter", kind: "unit", label: "Счётчик", usageCounters: [
          { name: "Количество", source: "board:runway", unit: "пос.", factor: 0.5 }] }] },
    aircraft: { boardNumber: "01", serialNumber: "001", readings: { actualLandings: 40, pprLandings: 7 },
      blocks: [{ position: "frame", repairs: 1, lastRepairDate: "2024-02-29" }],
      resources: [{ position: "meter", name: "Остаток", unit: "пос.", remaining: 9.5, limit: 20,
        inputs: [{ source: "counter:0", factor: 1 }] }] },
  };
  const parsed = templates.validateStartingAircraft(pack);
  assert.deepEqual(templates.validateStartingAircraft(JSON.parse(JSON.stringify(parsed))), parsed);
  for (const mutate of [
    (doc) => { doc.aircraft.readings.actualLandings = "40"; },
    (doc) => { doc.aircraft.blocks[0].lastRepairDate = "2023-02-29"; },
    (doc) => { doc.aircraft.blocks[0].repairs = 0; },
    (doc) => { doc.aircraft.blocks.push(doc.aircraft.blocks[0]); },
    (doc) => { doc.aircraft.resources[0].position = "missing"; },
    (doc) => { doc.aircraft.resources[0].inputs[0].source = "counter:1"; },
    (doc) => { doc.aircraft.resources[0].inputs[0].factor = -1; },
  ]) {
    const invalid = structuredClone(pack);
    mutate(invalid);
    assert.throws(() => templates.validateStartingAircraft(invalid));
  }
});

test("шаблон переносит семь позиций и сохраняется без потери схемы", () => {
  const parsed = templates.validateTemplate(su33);
  assert.deepEqual(templates.validateTemplate(JSON.parse(JSON.stringify(parsed))), parsed);
  assert.deepEqual(parsed.positions.map(({ kind }) => kind), ["airframe", "engine", "engine", "unit", "unit", "unit", "unit"]);
});

test("земля суммируется до округления, итог и максималы ведутся отдельно", () => {
  const parsed = templates.validateTemplate(su33);
  const data = {
    fields: { starts: "4", "flight-b": "00:40", "flight-b-ub": "00:50",
      "maximum-or": "00:00:03", "maximum-or-b": "00:00:08", "maximum-b-ub": "00:00:12" },
    groups: { runs: ["00:17", "00:15", "00:16", "00:33"].map((value) => ({ "ground-b": value, "ground-b-ub": "00:20" })) },
  };
  const result = templates.calculate(parsed, data, "engine");
  assert.deepEqual(result.steps["total-b"], { ground: 4860, rounded: 4800, credit: 960, flight: 2400, percent: 20, stepMinutes: 5 });
  assert.equal(result.counters["total-b"], 56 * 60);
  assert.equal(result.counters["total-b-ub"], 66 * 60);
  assert.deepEqual(["maximum-or", "maximum-or-b", "maximum-b-ub"].map((key) => result.counters[key]), [3, 8, 12]);
  assert.equal(templates.formatValue(parsed.engineCounters.find((row) => row.id === "maximum-or"), 3), "00:00:03");
  data.fields["maximum-b-ub"] = "00:00:06";
  assert.throws(() => templates.calculate(parsed, data, "engine"), /вложенность/);
  data.fields.starts = "3";
  assert.throws(() => templates.calculate(parsed, data, "engine"), /количеством запусков/);
});

test("старый Су-33 сохраняет позиции и получает связи по сторонам", () => {
  const legacy = structuredClone(su33);
  ["ВКА № 1", "ВКА № 2", "ГТД-Э № 1", "ГТД-Э № 2"].forEach((label, index) => {
    legacy.positions[3 + index].label = label;
    delete legacy.positions[3 + index].engineLink;
  });
  const parsed = templates.validateTemplate(legacy);
  assert.deepEqual(parsed, templates.validateTemplate(su33));
  assert.deepEqual(parsed.positions.slice(3).map((position) => position.engineLink.source),
    ["engine-left", "engine-right", "engine-left", "engine-right"]);
  assert.deepEqual(templates.positionCounters(parsed, parsed.positions[3]), parsed.engineCounters);
  assert.deepEqual(templates.positionCounters(parsed, parsed.positions[5]).map(({ id }) => id), ["starts"]);
  legacy.positions = structuredClone(su33.positions);
  legacy.positions[5].engineLink.source = "vka-1";
  assert.throws(() => templates.validateTemplate(legacy), /Укажи двигатель для агрегата/);
  legacy.positions[5].engineLink = { source: "engine-left", counters: ["unknown"] };
  assert.throws(() => templates.validateTemplate(legacy), /Укажи существующие графы/);
});

test("старое название налёта заменяется без изменений структуры поля", () => {
  const legacy = structuredClone(su33);
  const flight = legacy.inputs.find((field) => field.role === "flight");
  flight.label = "Налёт по вылету";
  assert.deepEqual(templates.validateTemplate(legacy), templates.validateTemplate(su33));
  flight.label = "Налёт в журнале";
  assert.equal(templates.validateTemplate(legacy).inputs.find((field) => field.role === "flight").label, flight.label);
});

test("раскладка принимает позицию шаблона, числовые размеры и подпись карточки", () => {
  const document = structuredClone(su33);
  const tile = { keys: ["slot:engine-left"], span: 4.3, height: 128, columnStart: 10, font: 0.87,
    labels: { "slot:engine-left": "Свой двигатель" } };
  document.layout = { tabs: { aggregates: [tile] } };
  const parsed = templates.validateTemplate(document);
  assert.deepEqual(parsed.layout.tabs.aggregates[0], { ...tile, wide: false });
  tile.span = "4.3; color: red";
  assert.throws(() => templates.validateTemplate(document), /Недопустимый размер/);
  tile.span = 4;
  tile.keys = ["slot:absent"];
  assert.throws(() => templates.validateTemplate(document), /неизвестную карточку/);
});

test("шаблон переносит определения счётчиков и проверяет источники", () => {
  const raw = structuredClone(su33);
  raw.boardUsage = [{ key: "custom-clock", label: "Работа насоса", kind: "time", format: "seconds", factor: 2, enabled: true }];
  const rule = { name: "Циклы", source: "board:custom-clock", unit: "шт.", factor: 3,
    additionalInputs: [{ source: "manual", factor: 2 }] };
  raw.positions[3].usageCounters = [
    { ...rule, id: "local", sne: 400, ppr: 23 },
    { name: "Запуски", source: "position:engine-right:starts", unit: "зап.", factor: 1 },
  ];
  const parsed = templates.validateTemplate(raw);
  assert.deepEqual(parsed.boardUsage, raw.boardUsage);
  assert.deepEqual(parsed.positions[3].usageCounters, [rule, raw.positions[3].usageCounters[1]]);
  assert.deepEqual(templates.validateTemplate(parsed), parsed);
  raw.positions[3].usageCounters[1].source = "position:missing:starts";
  assert.throws(() => templates.validateTemplate(raw), /Не найден источник показателя/);
  raw.positions[3].usageCounters.pop();
  raw.positions[3].usageCounters[0].additionalInputs.push({ source: rule.source, factor: 1 });
  assert.throws(() => templates.validateTemplate(raw), /Повторяются ключи/);
  raw.positions[3].usageCounters[0].additionalInputs.pop();
  raw.boardUsage = [];
  assert.throws(() => templates.validateTemplate(raw), /Не найден источник показателя/);
});

test("раскладки формуляров используют позиции и индексы вместо идентификаторов экземпляров", () => {
  const raw = structuredClone(su33);
  raw.positions[0].formLayout = { tiles: [{ keys: ["form-field:name", "form:assembly-slot:vka-1"], span: 8.5 }],
    hidden: ["form-field:serialNumber"] };
  raw.positions[3].usageCounters = [{ name: "Циклы", source: "manual", unit: "шт.", factor: 1 }];
  const counter = "form:aggregate-counter-index:0";
  raw.positions[3].formLayout = { tiles: [{ keys: [counter], height: 83, font: 1.15, labels: { [counter]: "Включения" } }], hidden: [] };
  const parsed = templates.validateTemplate(raw);
  assert.deepEqual(parsed.positions[0].formLayout.tiles[0].keys, ["form-field:name", "form:assembly-slot:vka-1"]);
  assert.equal(parsed.positions[3].formLayout.tiles[0].labels[counter], "Включения");
  assert.deepEqual(templates.validateTemplate(parsed), parsed);
  raw.positions[3].formLayout.hidden.push(counter);
  assert.throws(() => templates.validateTemplate(raw), /указана в раскладке дважды/);
  raw.positions[3].formLayout.hidden[0] = "form:event:instance-id";
  assert.throws(() => templates.validateTemplate(raw), /Неизвестная скрытая карточка/);
});

test("неподдерживаемая операция и несовместимый тип отклоняются при импорте", () => {
  const copy = structuredClone(su33);
  copy.rules[0].operation = "unknown";
  assert.throws(() => templates.validateTemplate(copy), /Неизвестная операция/);
  copy.rules[0] = { operation: "copy", source: "ground-b", target: "starts" };
  assert.throws(() => templates.validateTemplate(copy), /Несовместимый источник/);
  assert.throws(() => templates.calculate(templates.validateTemplate(su33),
    { fields: { runway: "1.5" }, groups: {} }, "board"), /целое число/);
});

test("тот же расчёт принимает один двигатель с другими названиями и долей земли", () => {
  const parsed = templates.validateTemplate({
    schemaVersion: 1, id: "simple-test", name: "Проверка схемы",
    positions: [{ id: "board-form", label: "Планер", kind: "airframe" }, { id: "single", label: "Двигатель", kind: "engine" }],
    inputs: [
      { id: "board-time", label: "Налёт", scope: "board", type: "duration", format: "HH:MM", role: "flight" },
      { id: "ground", label: "Наземная работа", scope: "engine", type: "duration", format: "HH:MM" },
      { id: "air", label: "В воздухе", scope: "engine", type: "duration", format: "HH:MM" },
    ],
    engineCounters: [{ id: "operation", label: "Итог", type: "duration", format: "HH:MM", role: "total" }],
    rules: [{ operation: "flight_plus_ground", target: "operation", flight: "air", ground: "ground", stepMinutes: 10, percent: 50, direction: "up" }],
  });
  const result = templates.calculate(parsed, { fields: { ground: "00:11", air: "00:20" }, groups: {} }, "engine");
  assert.equal(result.counters.operation, 1800);
});


test("Новые графы: отдельный импорт, совместимые единицы и защита от ошибочной связи", () => {
  const api = require("../src/aircraft-templates.js");
  const sample = require("../examples/civil-form-check-29.json");
  const pack = api.validateStartingAircraft(sample);
  assert.equal(pack.aircraft.boardNumber, "Т-29");
  assert.equal(pack.template.positions[0].usageCounters[0].workMode, "entry");
  assert.equal(1020 * api.unitScale("с", "мин"), 17);
  assert.equal(2 * api.unitScale("ч", "мин"), 120);
  assert.throws(() => api.unitScale("ч", "шт."), /Несовместимые/);
  const source = structuredClone(sample);
  const rules = source.template.positions[1].usageCounters;
  rules[0].unit = "шт.";
  assert.throws(() => api.validateStartingAircraft(source), /Несовместимые/);
  rules[0].unit = "мин";
  rules[1].fieldKey = "inspection";
  rules.push({ name: "Прошло дней", workMode: "entry", unit: "дн.", source: "local:inspection", factor: 1 });
  assert.equal(api.validateStartingAircraft(source).template.positions[1].usageCounters.at(-1).source, "local:inspection");
  rules.at(-1).source = "local:missing";
  assert.throws(() => api.validateStartingAircraft(source), /Не найден источник/);
});


test("Вид работы привязан по ID и сохраняется при повторном импорте", () => {
  const sample = structuredClone(require("../examples/civil-partial-31.json"));
  sample.template.operationTypes[1].label = "Проверка";
  sample.template.defaultOperationType = "taxi";
  const first = templates.validateStartingAircraft(sample);
  const again = templates.validateTemplate(JSON.parse(JSON.stringify(first.template)));
  assert.equal(again.defaultOperationType, "taxi");
  assert.equal(again.positions[1].usageCounters[1].workTypeId, "check");
  assert.equal(again.operationTypes.find(row => row.id === "check").label, "Проверка");
  sample.template.operationTypes.splice(1, 1);
  assert.throws(() => templates.validateStartingAircraft(sample), /Вид работы графы/);
});

test("Неполный повторяющийся ввод сохраняет известные показатели и явный ноль", () => {
  const template = {
    inputs: [
      { id: "runs", label: "Запуски", type: "count", scope: "engine" },
      { id: "time", label: "Время", type: "duration", format: "HH:MM", scope: "engine", group: "measure" },
      { id: "events", label: "События", type: "count", scope: "engine", group: "measure" },
    ],
    repeatGroups: [{ id: "measure", label: "Измерения", scope: "engine", countField: "runs" }],
    rules: [{ target: "result", source: "time", operation: "copy" }], checks: [],
  };
  const raw = { fields: { runs: "2" }, groups: { measure: [{ time: "00:10", events: "0" }, { events: "0" }] } };
  const result = templates.calculate(template, raw, "engine", { partial: true });
  assert.deepEqual(result.incomplete, ["time"]);
  assert.deepEqual(result.values, { runs: 2, time: null, events: 0 });
  assert.equal(result.counters.result, null);
  assert.equal(raw.groups.measure[0].time, "00:10");
  raw.groups.measure.pop();
  assert.equal(templates.calculate(template, raw, "engine", { partial: true }).values.time, null);
  raw.fields.runs = "1";
  assert.equal(templates.calculate(template, raw, "engine", { partial: true }).counters.result, 600);
});

test("Текст за работу допускает ручной ввод и вид работы, исключает арифметику и расход ресурса", () => {
  const example = structuredClone(require("../examples/civil-form-check-29.json"));
  const meter = example.template.positions.at(-1);
  const note = { name: "Запись", columnKey: "note", workMode: "entry", unit: "текст", source: "manual", factor: 1, fieldKey: "note-input" };
  meter.usageCounters.push(note);
  const copy = { ...note, name: "Копия", columnKey: "copy", source: "local:note-input" };
  delete copy.fieldKey;
  meter.usageCounters.push(copy);
  const validate = () => templates.validateStartingAircraft(example);
  assert.equal(validate().template.positions.at(-1).usageCounters.at(-1).unit, "текст");
  for (const changes of [{ factor: 2 }, { workMode: "total" }, { unit: "шт." }, { source: "work:date" },
    { source: "formula", formula: { tokens: [{ ref: "cell:note" }], emptyZero: false }, unit: "шт." }]) {
    Object.assign(copy, changes);
    assert.throws(validate);
    Object.assign(copy, { factor: 1, workMode: "entry", unit: "текст", source: "local:note-input" });
    delete copy.formula;
  }
  copy.source = "work:type";
  assert.equal(validate().template.positions.at(-1).usageCounters.at(-1).source, "work:type");
  example.aircraft.resources.push({ name: "Счётчик", position: meter.id, unit: "шт.", remaining: 5, limit: 5,
    inputs: [{ source: "counter:1", factor: 1 }] });
  assert.throws(validate, /не могут расходовать ресурс/);
});

test("импорт показаний проверяет типы, дату и соответствие граф выбранному шаблону", () => {
  const template = templates.validateTemplate({ schemaVersion: 1, id: "archive", name: "Архив",
    positions: [{ id: "body", kind: "airframe", label: "Формуляр" }],
    repeatGroups: [{ id: "flights", label: "Вылет", scope: "board", noteLabel: "Вид полёта" }],
    inputs: [{ id: "duration", label: "Налёт", type: "duration", format: "HH:MM", scope: "board", role: "flight", group: "flights" },
      { id: "count", label: "Количество", type: "count", scope: "board" }] });
  const base = { kind: "work-readings", version: 1, recordId: "entry-1", templateId: "archive",
    boardNumber: "89", operationType: "0", date: "2026-10-27" };
  const check = data => templates.validateWorkReadings({ ...base, ...data }, template);
  assert.doesNotThrow(() => check({ board: { fields: { count: 0 }, groups: { flights: [{ duration: "00:17", _note: "Первый" }] } } }));
  assert.throws(() => check({ board: { fields: { count: null } } }), /нет показаний/);
  assert.throws(() => check({ board: { fields: { duration: "00:17" } } }), /duration/);
  assert.throws(() => check({ board: { groups: { flights: [{ duration: "00:80" }] } } }), /формат/);
  assert.throws(() => check({ positions: { other: {} } }), /other/);
  assert.throws(() => check({ date: "2026-02-30" }), /дату/);
});
