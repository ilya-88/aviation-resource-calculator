const test = require("node:test");
const assert = require("node:assert/strict");
const { at, valid, days, calendarPeriod, postedBetween } = require("../src/dated-readings.js");

test("Закрытие дня, несколько смен, частичное показание и пропущенные данные", () => {
  const board = { readingsByDate: {
    "2024-02-28": { totalFlightMinutes: 100, actualLandings: 45, "column:t:sne": 200, "resource:r": 8 },
    "2024-03-01": { totalFlightMinutes: 150 }
  }, shifts: [
    { date: "2024-02-28", flightMinutes: 30 },
    ...["2024-02-29","2024-02-29","2024-03-01","2024-03-02"].map(date => ({
      date, flightMinutes: 10, actualLandings: 1,
      aggregateAccruals: [{ counterId: "t", amount: 12 }, { counterId: "cycle", workMode: "entry", amount: 1 }],
      accruals: [{ resourceId: "r", amount: 3 }]
    }))
  ] };
  assert.equal(at(board, "2024-02-27").size, 0);
  assert.equal(at(board, "2024-02-28").get("totalFlightMinutes"), 100);
  assert.equal(at(board, "2024-02-29").get("totalFlightMinutes"), 120);
  assert.equal(at(board, "2024-03-01").get("totalFlightMinutes"), 150);
  const result = at(board, "2024-03-02");
  assert.equal(result.get("totalFlightMinutes"), 160);
  assert.equal(result.get("actualLandings"), 49);
  assert.equal(result.get("column:t:sne"), 248);
  assert.equal(result.has("column:cycle:sne"), false);
  const charges = postedBetween(board, "2024-02-28", "2024-03-02");
  assert.equal(charges.get("column:t:sne"), 48);
  assert.equal(charges.has("column:cycle:sne"), false);
  assert.equal(result.get("resource:r"), 0);
});

test("Ремонт между двумя записями сбрасывает только ППР", () => {
  const board = { readingsByDate: { "2024-03-01": { "column:t:sne": 80, "column:t:ppr": 30 } },
    blocks: [{id: "a", kind: "unit", usageCounters: [{ id: "t" }], events: [
      {type: "repair", date: "2024-03-02", recordedAt: "11:00", repairNumber: 2}
    ] }], shifts: ["10:00","12:00"].map(recordedAt => ({ date: "2024-03-02", recordedAt,
      aggregateAccruals: [{ counterId: "t", amount: 10, ppr: true }] })) };
  const result = at(board,"2024-03-02");
  assert.equal(result.get("column:t:sne"), 100);
  assert.equal(result.get("column:t:ppr"), 10);
  assert.equal(result.get("a:repairs"), 2);
});

test("Календарь учитывает конец месяца, високосный год и дату продления", () => {
  assert.equal(valid("2023-02-29"), false);
  assert.equal(days("2024-02-28","2024-03-01"), 2);
  assert.equal(calendarPeriod("2024-01-31","2024-03-01"), "0 г. 1 мес. 1 дн.");
  assert.equal(calendarPeriod("2024-02-29","2025-02-28"), "1 г. 0 мес. 0 дн.");
  const board = { resources: [{id: "r", unit: "дн.", expiryDate: "2025-03-01"}], deadlinesByDate: {
    "2024-01-01": {"resource:r": "2024-03-01"}, "2024-04-01": {"resource:r": "2025-03-01"}
  }};
  assert.equal(at(board,"2023-12-31").has("resource:r"), false);
  assert.equal(at(board,"2024-02-29").get("resource:r"), 1);
  assert.equal(at(board,"2024-03-15").get("resource:r"), 0);
  assert.equal(at(board,"2024-04-01").get("resource:r"), 334);
});
