"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const templates = require("../src/aircraft-templates");
const su33 = require("../templates/su-33.json");

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
