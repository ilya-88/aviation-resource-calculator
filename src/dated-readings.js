(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.datedReadings = api;
})(globalThis, function () {
  "use strict";
  const day = 86400000;
  function valid(date) {
    return typeof date === "string" && /^\d{4}-\d\d-\d\d$/.test(date) && Number.isFinite(Date.parse(date)) &&
      new Date(date).toISOString().slice(0, 10) === date;
  }
  function days(from, to) {
    return (Date.parse(to) - Date.parse(from)) / day;
  }

  // Entries on a date are applied first. A reading taken at close of day replaces that field only.
  function at(board, date) {
    if (!valid(date)) throw new Error("Проверь дату показаний");
    const values = new Map();
    values.expiries = new Map();
    const timeline = [];
    const cutoff = date;
    function add(date, priority, run, recordedAt = "") {
      if (valid(date) && date <= cutoff) timeline.push({ date, priority, recordedAt, run });
    }
    function increment(key, delta, previous) {
      const before = values.has(key) ? values.get(key) : previous;
      if (Number.isFinite(before) && Number.isFinite(delta)) values.set(key, before + delta);
    }
    for (const shift of board.shifts || []) add(shift.date, 0, () => {
      const posted = new Set();
      for (const row of shift.flow || []) {
        if (!row.output?.startsWith("balance:")) continue;
        const key = row.output.slice(8);
        increment(key, row.amount - row.previous, row.previous);
        posted.add(key);
      }
      for (const item of [...(shift.templateWork?.engines || []), ...(shift.templateWork?.units || [])]) {
        if (!item.blockId) continue;
        const field = board.workTemplate?.engineCounters?.find(f => f.role === "starts");
        const n = field && item.counters?.[field.id];
        if (n == null) continue;
        for (const key of item.repairNumber != null ? ["starts","pprStarts"] : ["starts"]) {
          const id = item.blockId + ":" + key;
          if (!posted.has(id)) increment(id, n);
        }
      }
      for (const row of shift.engineAccruals || []) {
        const previous = shift.beforeUsage?.blocks?.find(b => b.id === row.blockId);
        for (const key of ["maximumSeconds", "afterburnerSeconds"]) {
          increment(row.blockId + ":" + key, row[key], previous?.values?.[key]);
          const ppr = "ppr" + key[0].toUpperCase() + key.slice(1);
          if (previous?.repairs > 0 || values.has(row.blockId + ":" + ppr)) {
            increment(row.blockId + ":" + ppr, row[key], previous?.values?.[ppr]);
          }
        }
      }
      if (!posted.has("totalFlightMinutes")) increment("totalFlightMinutes", shift.flightMinutes);
      if (!posted.has("actualLandings")) increment("actualLandings", shift.actualLandings);
      if (!posted.has("arresterHooks")) increment("arresterHooks", shift.arresterHooks);
      increment("equivalentLandings", shift.equivalentLandings);
      for (const [key, n] of Object.entries(shift.landingsByType || {})) increment("landing:" + key, n);
      for (const row of shift.aggregateAccruals || []) {
        if (row.workMode === "entry" || row.textValue != null) continue;
        for (const period of row.ppr ? ["sne", "ppr"] : ["sne"]) {
          increment("column:" + row.counterId + ":" + period, row.amount, row.balances?.[period]?.[0]);
        }
      }
      for (const row of shift.accruals || []) {
        const key = "resource:" + row.resourceId;
        const before = values.has(key) ? values.get(key) : row.before;
        if (Number.isFinite(before)) values.set(key, Math.max(0, before - row.amount));
      }
    }, shift.recordedAt);
    for (const block of board.blocks || []) {
      const owner = block.kind === "airframe" ? "" : block.id + ":";
      for (const event of block.events || []) add(event.date, 1, () => {
        if (event.type === "repair") {
          if (Number.isInteger(event.repairNumber)) values.set(block.id + ":repairs", event.repairNumber);
          else increment(block.id + ":repairs", 1);
          for (const field of ["pprFlightMinutes", "pprLandings", "pprMinutes", "pprStarts", "pprMaximumSeconds", "pprAfterburnerSeconds"]) values.set(owner + field, 0);
          for (const rule of block.usageCounters || []) if (rule.workMode !== "entry") values.set("column:" + rule.id + ":ppr", 0);
        }
        if (event.type !== "correction" || !event.current) return;
        if (Number.isInteger(event.current.repairs)) values.set(block.id + ":repairs", event.current.repairs);
        for (const [key, v] of Object.entries(event.current)) if (key !== "aggregate" && key !== "repairs") values.set(owner + key, v);
        for (const col of event.current.aggregate || []) for (const period of ["sne", "ppr"]) values.set("column:" + col.id + ":" + period, col[period]);
      }, event.recordedAt);
    }
    for (const [when, observation] of Object.entries(board.readingsByDate || {})) add(when, 2, () => {
      for (const [key, n] of Object.entries(observation)) values.set(key, n);
    });
    timeline.sort((a,b) => a.date.localeCompare(b.date) ||
      Number(a.priority === 2) - Number(b.priority === 2) ||
      a.recordedAt.localeCompare(b.recordedAt) || a.priority - b.priority);
    for (const event of timeline) event.run();
    for (const resource of board.resources || []) {
      if (resource.unit !== "дн.") continue;
      const key = "resource:" + resource.id;
      const history = Object.entries(board.deadlinesByDate || {}).filter(([,v]) => Object.hasOwn(v, key));
      const dated = history.filter(([d]) => d <= date).sort(([a],[b]) => b.localeCompare(a));
      const expiry = dated.length ? dated[0][1][key] : history.length ? null : resource.expiryDate;
      if (!valid(expiry)) continue;
      values.expiries.set(key, expiry);
      const remaining = valid(resource.produced) && resource.produced > date ? null : Math.max(0, days(date, expiry));
      values.set(key, remaining);
    }
    return values;
  }
  // The journal can document work even when the initial meter reading is unknown.
  function postedBetween(board, from, to) {
    const amounts = new Map();
    function post(key, n) {
      if (Number.isFinite(n)) amounts.set(key, (amounts.get(key) || 0) + n);
    }
    for (const shift of board.shifts || []) {
      if (!valid(shift.date) || shift.date <= from || shift.date > to) continue;
      for (const row of shift.flow || []) {
        if (row.output?.startsWith("balance:") && Number.isFinite(row.previous) && Number.isFinite(row.amount)) {
          post(row.output.slice(8), row.amount - row.previous);
        }
      }
      for (const [name, count] of Object.entries(shift.landingsByType || {})) post("landing:" + name, count);
      for (const row of shift.aggregateAccruals || []) {
        if (row.workMode === "entry" || row.textValue != null) continue;
        post("column:" + row.counterId + ":sne", row.amount);
        if (row.ppr) post("column:" + row.counterId + ":ppr", row.amount);
      }
    }
    return amounts;
  }

  function calendarPeriod(from, to) {
    if (!valid(from) || !valid(to) || from > to) return "";
    const first = new Date(from), last = new Date(to);
    let months = (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + last.getUTCMonth() - first.getUTCMonth();
    function plus(n) {
      const d = new Date(from);
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + n + 1);
      d.setUTCDate(0);
      d.setUTCDate(Math.min(first.getUTCDate(), d.getUTCDate()));
      return d;
    }
    if (plus(months) > last) months--;
    return Math.floor(months / 12) + " г. " + (months % 12) + " мес. " + ((last - plus(months)) / day) + " дн.";
  }
  return { valid, days, at, postedBetween, calendarPeriod };
});

