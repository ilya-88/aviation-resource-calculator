const test = require("node:test");
const assert = require("node:assert/strict");
const calc = require("../src/calculations.js");

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
