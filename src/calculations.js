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

  function roundToNearestStep(value, step) {
    const numericValue = requireNonNegativeNumber(value, "Значение");
    const numericStep = requireNonNegativeNumber(step, "Шаг округления");
    if (numericStep === 0) throw new RangeError("Шаг округления должен быть больше нуля");
    return Math.round(numericValue / numericStep) * numericStep;
  }

  function calculateGroundContribution(actualMinutes, options) {
    const settings = Object.assign({ stepMinutes: 5, percent: 20 }, options);
    const actual = requireNonNegativeNumber(actualMinutes, "Земная наработка");
    const roundedMinutes = roundToNearestStep(actual, settings.stepMinutes);
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

  return {
    roundToNearestStep,
    calculateGroundContribution,
    calculateEngineIncrement,
    calculateEquivalentLandings,
    formatDuration,
  };
});
