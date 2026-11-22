const test = require("node:test");
const assert = require("node:assert/strict");
const calc = require("../src/calculations.js");

test("общая сортировка сравнивает доли ресурса, а записи без лимита ставит в конец", () => {
  const hours = { remaining: 5, limit: 10 };
  const days = { remaining: 30, limit: 365 };
  const unknown = { remaining: 0, limit: 0 };
  assert.deepEqual([unknown, hours, days].sort(calc.compareResourceRemaining), [days, hours, unknown]);
});

test("направление округления можно изменить без изменения стандартного правила", () => {
  assert.equal(calc.calculateGroundContribution(7, { direction: "up" }).roundedMinutes, 10);
  assert.equal(calc.calculateGroundContribution(8, { direction: "down" }).roundedMinutes, 5);
  assert.equal(calc.calculateGroundContribution(8).roundedMinutes, 10);
});

test("продление сохраняет использованный ресурс и увеличивает остаток на разницу лимитов", () => {
  const initial = { limit: 300, remaining: 20 };
  const first = calc.extendUsageResource(initial, 400);
  assert.deepEqual(first, { previousLimit: 300, limit: 400, increase: 100, remaining: 120 });
  assert.deepEqual(initial, { limit: 300, remaining: 20 });
  assert.equal(calc.extendUsageResource(first, 500).remaining, 220);
  assert.throws(() => calc.extendUsageResource(first, 400), RangeError);
});

test("отчёт включает обе границы периода и поддерживает старые записи", () => {
  const shifts = [
    { date: "2026-03-01", flightMinutes: 99 },
    { date: "2026-02-28", flightMinutes: 23, leftStarts: 2 },
    { date: "2026-02-01", flightMinutes: 60 },
  ];
  const report = calc.summarizeShifts(shifts, "2026-02-01", "2026-02-28");
  assert.deepEqual(report.rows.map((row) => row.date), ["2026-02-01", "2026-02-28"]);
  assert.equal(report.totals.flightMinutes, 83);
  assert.equal(report.totals.leftStarts, 2);
  assert.equal(report.totals.rightStarts, 0);
});

test("13 минут округляются до 15, 20% дают 3 минуты", () => {
  assert.deepEqual(calc.calculateGroundContribution(13), {
    actualMinutes: 13,
    roundedMinutes: 15,
    percent: 20,
    contributionMinutes: 3,
  });
});

test("час полёта и 13 минут земли дают 1 час 3 минуты", () => {
  const result = calc.calculateEngineIncrement(60, 13);
  assert.equal(result.totalMinutes, 63);
  assert.equal(calc.formatDuration(result.totalMinutes), "1:03");
});

test("примеры округления к ближайшим пяти минутам", () => {
  assert.equal(calc.roundToNearestStep(4, 5), 5);
  assert.equal(calc.roundToNearestStep(6, 5), 5);
  assert.equal(calc.roundToNearestStep(7, 5), 5);
  assert.equal(calc.roundToNearestStep(8, 5), 10);
  assert.equal(calc.roundToNearestStep(9, 5), 10);
  assert.equal(calc.roundToNearestStep(47, 5), 45);
});

test("приведённые посадки используют настраиваемые коэффициенты", () => {
  const total = calc.calculateEquivalentLandings(
    { runway: 1, carrier: 2, touch: 1, circuit: 1 },
    { runway: 1, carrier: 2, touch: 0.6, circuit: 0.6 },
  );
  assert.equal(total, 6.2);
});

test("шаг округления и процент настраиваются для самолёта", () => {
  assert.deepEqual(calc.calculateGroundContribution(13, { stepMinutes: 10, percent: 25 }), {
    actualMinutes: 13,
    roundedMinutes: 10,
    percent: 25,
    contributionMinutes: 2.5,
  });
  assert.equal(calc.formatDuration(62.5), "1:02:30");
});

test("время режимов разбирается до секунд", () => {
  assert.equal(calc.parseClockDuration("01:02:03"), 3723);
  assert.equal(calc.parseClockDuration("00:05"), 300);
  assert.throws(() => calc.parseClockDuration("00:60:00"), RangeError);
});

test("вложенные режимы не допускают двойного суммирования", () => {
  assert.equal(calc.validateNestedEngineModes({ or: 10, combat: 20, combined: 30 }), null);
  assert.equal(calc.validateNestedEngineModes({ or: 20, combat: 10, combined: 30 }), "combat_lt_or");
  assert.equal(calc.validateNestedEngineModes({ or: 10, combat: 30, combined: 20 }), "combined_lt_combat");
});

test("ошибочные отрицательные и нечисловые значения отклоняются", () => {
  assert.throws(() => calc.calculateGroundContribution(-1), TypeError);
  assert.throws(() => calc.calculateEngineIncrement("нет", 0), TypeError);
  assert.throws(() => calc.roundToNearestStep(5, 0), RangeError);
});
