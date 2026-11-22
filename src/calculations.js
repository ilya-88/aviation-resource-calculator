(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AviationCalc = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function requireNonNegativeNumber(value, label) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new TypeError(`${label} должно быть неотрицательным числом`);
    }
    return parsed;
  }

  function roundToNearestStep(value, step, direction = "nearest") {
    const numericValue = requireNonNegativeNumber(value, "Значение");
    const numericStep = requireNonNegativeNumber(step, "Шаг округления");
    if (numericStep === 0) throw new RangeError("Шаг округления должен быть больше нуля");
    const round = direction === "up" ? Math.ceil : direction === "down" ? Math.floor : Math.round;
    return round(numericValue / numericStep) * numericStep;
  }

  function calculateGroundContribution(actualMinutes, options) {
    const settings = Object.assign({ stepMinutes: 5, percent: 20 }, options);
    const actual = requireNonNegativeNumber(actualMinutes, "Земная наработка");
    const roundedMinutes = roundToNearestStep(actual, settings.stepMinutes, settings.direction);
    const percent = requireNonNegativeNumber(settings.percent, "Процент пересчёта");
    const contributionMinutes = roundedMinutes * (percent / 100);

    return {
      actualMinutes: actual,
      roundedMinutes,
      percent,
      contributionMinutes,
    };
  }

  function calculateEngineIncrement(flightMinutes, groundMinutes, options) {
    const flight = requireNonNegativeNumber(flightMinutes, "Полётная наработка");
    const ground = calculateGroundContribution(groundMinutes, options);
    return {
      flightMinutes: flight,
      ground,
      totalMinutes: flight + ground.contributionMinutes,
    };
  }

  function formatDuration(totalMinutes) {
    const value = requireNonNegativeNumber(totalMinutes, "Продолжительность");
    const wholeSeconds = Math.round(value * 60);
    const hours = Math.floor(wholeSeconds / 3600);
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    const seconds = wholeSeconds % 60;
    return seconds
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${hours}:${String(minutes).padStart(2, "0")}`;
  }

  function calculateEquivalentLandings(landings, coefficients) {
    const total = Object.keys(landings).reduce((sum, key) => {
      const count = requireNonNegativeNumber(landings[key], `Посадки ${key}`);
      const coefficient = requireNonNegativeNumber(coefficients[key] ?? 0, `Коэффициент ${key}`);
      return sum + count * coefficient;
    }, 0);
    return Math.round(total * 1e6) / 1e6;
  }

  function parseClockDuration(value) {
    const parts = String(value || "00:00:00").split(":");
    if (parts.length < 2 || parts.length > 3) throw new TypeError("Время должно быть в формате ЧЧ:ММ или ЧЧ:ММ:СС");
    const numeric = parts.map(Number);
    if (numeric.some((part) => !Number.isInteger(part) || part < 0)) throw new TypeError("Время содержит недопустимое значение");
    const [hours, minutes, seconds = 0] = numeric;
    if (minutes > 59 || seconds > 59) throw new RangeError("Минуты и секунды должны быть от 0 до 59");
    return hours * 3600 + minutes * 60 + seconds;
  }

  function validateNestedEngineModes(modes) {
    const orSeconds = requireNonNegativeNumber(modes.or, "ОР");
    const combatSeconds = requireNonNegativeNumber(modes.combat, "Б");
    const combinedSeconds = requireNonNegativeNumber(modes.combined, "Б + УБ");
    if (combatSeconds < orSeconds) return "combat_lt_or";
    if (combinedSeconds < combatSeconds) return "combined_lt_combat";
    return null;
  }

  function extendUsageResource(resource, newLimit) {
    const previousLimit = requireNonNegativeNumber(resource.limit, "Прежний ресурс");
    const remaining = requireNonNegativeNumber(resource.remaining, "Остаток");
    const limit = requireNonNegativeNumber(newLimit, "Новый ресурс");
    if (limit <= previousLimit) throw new RangeError("Новый ресурс должен быть больше прежнего");
    const increase = limit - previousLimit;
    return { previousLimit, limit, increase, remaining: remaining + increase };
  }

  function summarizeShifts(shifts, from, to) {
    const fields = ["flightMinutes", "actualLandings", "equivalentLandings", "arresterHooks", "leftEngineMinutes", "rightEngineMinutes", "leftStarts", "rightStarts"];
    const totals = Object.fromEntries(fields.map((field) => [field, 0]));
    const rows = shifts.filter((shift) => shift.date >= from && shift.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date));
    for (const shift of rows) {
      for (const field of fields) totals[field] += Number(shift[field] ?? 0);
    }
    return { rows, totals };
  }

  return {
    roundToNearestStep,
    summarizeShifts,
    extendUsageResource,
    calculateGroundContribution,
    calculateEngineIncrement,
    calculateEquivalentLandings,
    formatDuration,
    parseClockDuration,
    validateNestedEngineModes,
  };
});
