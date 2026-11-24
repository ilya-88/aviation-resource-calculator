const test = require("node:test");
const assert = require("node:assert/strict");
const forms = require("../src/formulas");
const templates = require("../src/aircraft-templates");
const sample = require("../examples/civil-formula-30.json");

const cell = key => ({ ref: "cell:" + key });
const rows = templates.validateStartingAircraft(sample).template.positions[0].usageCounters;
const sources = forms.catalog(rows);
function post(first, second, rules = rows) {
  const values = new Map([["cell:time-a", first], ["cell:time-b", second]]);
  for (const row of forms.order(rules, sources)) {
    if (row.formula) values.set(forms.refKey(row), forms.calculate(row.formula, row.unit, sources, key => values.get(key)).amount);
  }
  return values.get("cell:total");
}
test("Forward references and rounded operands: missing, explicit zero and full inputs", () => {
  assert.equal(post(null, 18), 4);
  assert.equal(post(0, 18), 4);
  assert.equal(post(60, 18), 64);
  assert.equal(post(60, null), 60);
  assert.equal(post(0, null), 0);
  assert.equal(post(null, null), null);
  const strict = structuredClone(rows);
  strict[0].formula.emptyZero = false;
  assert.equal(post(null, 18, strict), null);
});
test("Four operations, order, compatible units, denominator and missing references", () => {
  const m = new Map([["x", { unit:"мин", label:"X" }], ["y", { unit:"ч", label:"Y" }]]);
  const x = { ref:"x" }, y = { ref:"y" };
  const calc = (tokens, unit = "мин") => forms.calculate({ tokens, emptyZero:false }, unit, m, key => key === "x" ? 10 : 1).amount;
  assert.equal(calc([y, "-", x, "*", 2]), 40);
  assert.equal(calc(["(", y, "-", x, ")", "/", 2]), 25);
  assert.equal(calc([y, "/", x], "шт."), 6);
  assert.throws(() => calc([x, "/", 0]), /ноль/);
  assert.throws(() => calc([x, "+", { ref:"missing" }]), /отсутствует/);
  assert.throws(() => calc([x, "*", y]), /единицы/);
});
test("Template import detects indirect cycles, also after a display name changes", () => {
  const bad = structuredClone(sample);
  const [, share] = bad.template.positions[0].usageCounters;
  share.name = "Новое имя";
  share.formula.tokens = [cell("total")];
  assert.throws(() => templates.validateStartingAircraft(bad), /Круговая ссылка/);
  const copy = structuredClone(sample);
  copy.template.positions[0].usageCounters[0].name = "Переименовано";
  assert.deepEqual(templates.validateStartingAircraft(copy).template.positions[0].usageCounters[0].formula.tokens, rows[0].formula.tokens);
});
