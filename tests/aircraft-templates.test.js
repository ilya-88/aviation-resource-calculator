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
