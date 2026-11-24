(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.formulas = api;
})(globalThis, function () {
  "use strict";

  const seconds = new Map([["ч", 3600], ["мин", 60], ["с", 1]]);
  const keys = new Set(["+", "-", "*", "/", "(", ")"]);
  const marks = { "*": "×", "/": "÷", "-": "−" };
  const kind = unit => seconds.has(unit) ? "time" : unit === "дата" ? "date" : unit === "дн." ? "days" : "number";
  const columnKey = row => row.columnKey || row.id;
  const refKey = row => "cell:" + columnKey(row);
  const fail = message => { throw new Error(message); };

  // Recursive descent keeps the same precedence in preview, import and actual postings.
  function calculate(formula, unit, sources, read) {
    if (!formula || !Array.isArray(formula.tokens) || !formula.tokens.length || formula.tokens.length > 100 ||
        typeof formula.emptyZero !== "boolean") fail("Собери выражение из граф и чисел");
    if (unit === "текст") fail("Текст нельзя вычислить по формуле");
    const tokens = formula.tokens;
    const operands = new Map();
    let at = 0, present = false, missing = false;
    const target = kind(unit);
    const scale = seconds.get(unit) || 1;
    function take() {
      const token = tokens[at++];
      let term;
      if (token === "(") {
        term = sum();
        if (tokens[at++] !== ")") fail("Нужна закрывающая скобка");
      } else if (Number.isFinite(token)) {
        term = { n: token, k: "constant" };
      } else if (token && typeof token.ref === "string") {
        const source = sources.get(token.ref);
        if (source?.unit === "текст") fail("Текст нельзя использовать в формуле");
        if (!source) fail("Графа, на которую ссылается формула, отсутствует");
        const value = read ? read(token.ref) : null;
        if (value == null) missing = true;
        else if (Number.isFinite(value)) present = true;
        else fail("Некорректное значение графы «" + source.label + "»");
        operands.set(token.ref, { sourceKey: token.ref, source: source.label, input: value ?? null, sourceUnit: source.unit });
        term = { n: (value ?? 0) * (seconds.get(source.unit) || 1), k: kind(source.unit) };
      } else fail("Ожидается графа, число или открывающая скобка");
      while (tokens[at] === "%" || tokens[at]?.round != null) {
        const suffix = tokens[at++];
        if (term.k === "date") fail("Проценты и округление к дате неприменимы");
        if (suffix === "%") term.n /= 100;
        else {
          if (!Number.isFinite(suffix.round) || suffix.round <= 0) fail("Шаг округления должен быть больше нуля");
          const step = suffix.round * (term.k === "time" ? scale : 1);
          term.n = Math.round(term.n / step) * step;
        }
      }
      return term;
    }
    function product() {
      let left = take();
      while (tokens[at] === "*" || tokens[at] === "/") {
        const op = tokens[at++];
        const right = take();
        if (left.k === "date" || right.k === "date") fail("Дата не участвует в умножении и делении");
        const scalar = k => k === "number" || k === "constant";
        let k;
        if (scalar(right.k)) k = left.k === "constant" ? right.k : left.k;
        else if (op === "*" && scalar(left.k)) k = right.k;
        else if (op === "/" && left.k === right.k) k = "number";
        else fail("Несовместимые единицы для умножения или деления");
        if (op === "/" && right.n === 0) {
          if (right.k === "constant") fail("Деление на ноль");
          if (read) divisionByZero = true;
        }
        left = { n: op === "*" ? left.n * right.n : right.n ? left.n / right.n : 0, k };
      }
      return left;
    }
    function sum() {
      let left = product();
      while (tokens[at] === "+" || tokens[at] === "-") {
        const op = tokens[at++];
        const right = product();
        if (left.k === "constant" && right.k !== "constant") {
          left.k = right.k; left.n *= left.k === "time" ? scale : 1;
        }
        if (right.k === "constant" && left.k !== "constant") {
          right.k = left.k; right.n *= right.k === "time" ? scale : 1;
        }
        const dates = left.k === "date" && right.k === "date" && op === "-";
        if (left.k !== right.k || (!dates && left.k === "date")) fail("Для сложения и вычитания нужны совместимые величины");
        left = { n: op === "+" ? left.n + right.n : left.n - right.n, k: dates ? "days" : left.k };
      }
      return left;
    }
    let divisionByZero = false;
    const result = sum();
    if (at !== tokens.length) fail("Между графами нужен знак действия или парная скобка");
    if (!operands.size) fail("Выбери хотя бы одну графу");
    if (result.k !== target) fail("Результат формулы несовместим с единицей «" + unit + "»");
    const amount = !read || !present || (missing && !formula.emptyZero) ? null : result.n / scale;
    if (amount !== null && divisionByZero) fail("Деление на ноль");
    if (amount !== null && !Number.isFinite(amount)) fail("Результат выходит за диапазон чисел");
    return { amount, inputs: [...operands.values()] };
  }

  function catalog(rows, external = []) {
    const sources = new Map(external.filter(item => item.unit).map(item => [item.key, item]));
    for (const row of rows) {
      const ref = refKey(row);
      if (sources.has(ref)) fail("Две графы имеют один идентификатор");
      sources.set(ref, { key: ref, label: row.name, unit: row.unit });
    }
    return sources;
  }

  function order(rows, sources) {
    const byKey = new Map(rows.map(row => [refKey(row), row]));
    const done = new Set(), active = new Set(), ordered = [];
    function visit(row) {
      if (done.has(row)) return;
      if (active.has(row)) fail("Круговая ссылка: «" + row.name + "»");
      active.add(row);
      if (row.source === "formula") {
        if (!row.workMode || !row.formula) fail("Укажи выражение для «" + row.name + "»");
        try { calculate(row.formula, row.unit, sources); }
        catch (error) { fail("«" + row.name + "»: " + error.message); }
        for (const token of row.formula.tokens) if (byKey.has(token?.ref)) visit(byKey.get(token.ref));
      }
      active.delete(row); done.add(row); ordered.push(row);
    }
    rows.forEach(visit);
    return ordered;
  }

  function describe(formula, sources) {
    return (formula?.tokens || []).map(token => {
      if (typeof token === "number") return String(token).replace(".", ",");
      if (token?.ref) return "«" + (sources.get(token.ref)?.label || "Графа удалена") + "»";
      if (token?.round) return "⟦до " + token.round + "⟧";
      return keys.has(token) ? (marks[token] || token) : token === "%" ? "%" : "?";
    }).join(" ");
  }
  return { calculate, catalog, order, describe, columnKey, refKey };
});
