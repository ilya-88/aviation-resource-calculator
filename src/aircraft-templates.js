(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.aircraftTemplates = api;
})(globalThis, function () {
  "use strict";

  const landingRoles = ["runway", "carrier", "touch", "circuit", "arresterHooks"];
  const counterRoles = ["starts", "total", "flight", "ground", "or", "combat", "combined"];
  const scopes = ["board", "engine"];

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

  function validateTemplate(document) {
    requireValue(document && document.schemaVersion === 1, "Поддерживается версия шаблона 1");
    const id = identifier(document.id, "шаблон");
    const name = label(document.name, id);
    const positions = list(document.positions, "позиции", (row) => {
      const position = identifier(row.id, "позиция");
      requireValue(position !== "board", "Идентификатор board занят данными самолёта");
      requireValue(["airframe", "engine", "unit"].includes(row.kind), `Неизвестный вид формуляра: ${position}`);
      return { id: position, label: label(row.label, position), kind: row.kind, model: row.model ? label(row.model, position) : "" };
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
    const checks = list(document.checks || [], "проверки вложенности", (row) => {
      requireValue(Array.isArray(row.ascending) && row.ascending.length >= 2 && row.ascending.length <= 12 &&
        new Set(row.ascending).size === row.ascending.length && row.ascending.every((key) => engineInput(key)?.type === "duration"),
        "Проверка вложенности должна ссылаться на графы времени одного двигателя");
      return { ascending: [...row.ascending] };
    });
    requireValue(positions.some((row) => row.kind === "engine") || (counters.length === 0 && !inputs.some((row) => row.scope === "engine")),
      "Поля двигателя требуют хотя бы одну позицию двигателя");
    return { schemaVersion: 1, id, name, workTitle: label(document.workTitle || "Исходные данные работы", "форма ввода"),
      positions, repeatGroups: groups, inputs, engineCounters: counters, rules, checks };
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

  function calculate(template, inputs, scope) {
    const values = {};
    for (const field of template.inputs.filter((item) => item.scope === scope)) {
      const rows = field.group ? (inputs.groups[field.group] || []) : [inputs.fields];
      const entries = rows.map((row) => parseValue(field, row[field.id]));
      const present = entries.filter((entry) => entry != null);
      requireValue(present.length === 0 || present.length === rows.length, `«${field.label}»: заполни все строки или оставь всю графу пустой`);
      values[field.id] = present.length ? present.reduce((sum, value) => sum + value, 0) : null;
    }
    for (const group of template.repeatGroups.filter((row) => row.scope === scope && row.countField)) {
      const count = (inputs.groups[group.id] || []).length;
      if (count) requireValue(values[group.countField] === count, `«${group.label}»: число заполненных строк должно совпадать с количеством запусков`);
    }
    if (scope === "board") return { values };
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
      const flight = values[rule.flight];
      const ground = values[rule.ground];
      if (flight == null || ground == null) { counters[rule.target] = null; continue; }
      const step = rule.stepMinutes * 60;
      const round = { nearest: Math.round, up: Math.ceil, down: Math.floor }[rule.direction];
      const rounded = round(ground / step) * step;
      const credit = Math.round(rounded * rule.percent / 100);
      counters[rule.target] = flight + credit;
      steps[rule.target] = { ground, rounded, credit, flight, percent: rule.percent, stepMinutes: rule.stepMinutes };
    }
    return { values, counters, steps };
  }

  return { validateTemplate, calculate, formatValue };
});
