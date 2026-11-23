"use strict";

const assert = require("node:assert/strict");
const demoState = require("./fixtures/demo-state.json");
const su33Template = require("../templates/su-33.json");

const port = Number(process.argv[2] || 9223);
const endpoint = `http://127.0.0.1:${port}`;

async function connect() {
  const targets = await fetch(`${endpoint}/json`).then((response) => response.json());
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("Chrome page target not found");

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });

  function command(method, params = {}) {
    const id = ++nextId;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  async function evaluate(expression) {
    const response = await command("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) {
      const details = response.exceptionDetails;
      const description = details.exception?.description || details.text;
      throw new Error(description);
    }
    return response.result.value;
  }

  return { socket, evaluate, command };
}

async function main() {
  const { socket, evaluate, command } = await connect();
  const results = {};
  try {
    if (process.argv[3]) {
      await command("Emulation.setDeviceMetricsOverride", { width: Number(process.argv[3]), height: 812, deviceScaleFactor: 1, mobile: true });
    }
    const experimental = await evaluate(`(async () => {
      const click = selector => {
        const element = document.querySelector(selector);
        if (!element) throw new Error('Не найдено: ' + selector);
        element.click();
      };
      const read = () => JSON.parse(localStorage.getItem('aviation-resource-prototype-v1'));
      const back = () => window.handleAndroidBack();
      const empty = !document.querySelector('[data-aircraft-id]');
      click('[data-action="settings"]');
      click('[data-view="aircraft-types"]');
      const template = ${JSON.stringify(su33Template)};
      const file = (text) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([text], 'su-33.json', { type:'application/json' }));
        const input = document.querySelector('#aircraft-template-file');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change'));
      };
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 30 && !condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
        if (!condition()) throw new Error('Не получен результат импорта');
      };
      file('{invalid');
      await waitFor(() => document.querySelector('#template-import-status').textContent.includes('JSON'));
      file(JSON.stringify(template));
      await waitFor(() => document.querySelector('dialog[open] [value="import"]'));
      await new Promise(resolve => {
        const dialog = document.querySelector('dialog[open]');
        dialog.addEventListener('close', resolve, { once: true });
        click('dialog[open] [value="import"]');
      });
      file(JSON.stringify(template));
      await waitFor(() => document.querySelector('#template-import-status').textContent.includes('уже есть'));
      const imported = read().templateCatalog.length === 1;
      back();
      back();
      click('[data-action="add-aircraft"]');
      const boardForm = document.querySelector('#creation-form');
      boardForm.elements.type.value = 'Су-33';
      boardForm.elements.type.dispatchEvent(new Event('change'));
      boardForm.elements.boardNumber.value = '101';
      boardForm.requestSubmit();
      const board = () => read().aircraft.find(row => row.boardNumber === '101');
      const types = board().blocks.reduce((counts, block) => ({ ...counts, [block.kind]: (counts[block.kind] || 0) + 1 }), {});
      const engine = slot => board().blocks.find(block => block.templateSlotId === slot);
      const openEngine = slot => click('[data-block-id="' + engine(slot).id + '"]');
      click('[data-action="add-block"]');
      const creation = document.querySelector('#creation-form');
      creation.elements.kind.value = 'engine';
      creation.elements.kind.dispatchEvent(new Event('change'));
      const noDuplicates = !creation.querySelector('option[value="airframe"]') && !creation.elements.templateSlotId &&
        !document.querySelector('#no-engine-position').hidden && creation.querySelector('[type=submit]').disabled;
      back();
      const engineInputOrder = 'starts ground-b ground-b-ub flight-b flight-b-ub maximum-or maximum-or-b maximum-b-ub';
      function record(both) {
        click('[data-view="shift"]');
        const form = document.querySelector('#template-work-form');
        const scopes = [...form.querySelectorAll('[data-template-scope]')];
        const fieldOrder = scope => [...scope.querySelectorAll('[data-template-field]')].map(field => field.dataset.templateField).join(' ');
        const orderedInputs = form.elements.date.compareDocumentPosition(scopes[0]) === Node.DOCUMENT_POSITION_FOLLOWING &&
          fieldOrder(scopes[0]) === 'board-flight runway hooks' &&
          scopes.slice(1).map(scope => scope.dataset.templateScope).join(' ') === 'engine-left engine-right' &&
          scopes.slice(1).every(scope => fieldOrder(scope) === engineInputOrder &&
            scope.querySelector('[data-template-field="ground-b-ub"]').getBoundingClientRect().top <
            scope.querySelector('[data-template-field="flight-b"]').getBoundingClientRect().top);
        const set = (slot, key, value, row = 0) => {
          form.querySelectorAll('[data-template-scope="' + slot + '"] [data-template-field="' + key + '"]')[row].value = value;
        };
        click('[data-template-scope="board"] [data-template-add]');
        click('[data-template-scope="board"] [data-template-row]:last-child [data-template-remove]');
        const rowsRemoved = form.querySelectorAll('[data-template-scope="board"] [data-template-row]').length === 1;
        click('[data-template-scope="board"] [data-template-add]');
        set('board', 'board-flight', '00:20');
        set('board', 'board-flight', '00:40', 1);
        set('board', 'runway', '1');
        const slots = both ? ['engine-left', 'engine-right'] : ['engine-right'];
        for (const slot of slots) {
          for (const [key, value] of Object.entries({
            starts: '1', 'ground-b': '00:13', 'ground-b-ub': '00:23', 'flight-b': '00:40',
            'flight-b-ub': '00:50', 'maximum-or': '00:00:03', 'maximum-or-b': '00:00:08', 'maximum-b-ub': '00:00:12',
          })) set(slot, key, value);
        }
        if (both) {
          click('[data-template-scope="engine-right"] [data-template-add]');
          set('engine-right', 'starts', '2');
          set('engine-right', 'ground-b', '00:00', 1);
          set('engine-right', 'ground-b-ub', '00:00', 1);
          set('engine-right', 'flight-b-ub', '01:00');
          set('engine-left', 'maximum-b-ub', '00:00:06');
          form.dispatchEvent(new Event('input'));
          if (!document.querySelector('#template-preview').textContent.includes('вложенность')) throw new Error('Нет проверки режимов');
          set('engine-left', 'maximum-b-ub', '00:00:12');
        }
        form.dispatchEvent(new Event('input'));
        const preview = document.querySelector('#template-preview').textContent;
        form.requestSubmit();
        return { orderedInputs, rowsRemoved, preview };
      }
      const first = record(true);
      const firstWork = board().shifts.at(-1);
      const pair = firstWork.templateWork.engines;
      const routed = pair[0].blockId === engine('engine-left').id && pair[1].blockId === engine('engine-right').id &&
        pair[0].counters['total-b'] === 43 * 60 && pair[0].counters['total-b-ub'] === 55 * 60 &&
        pair[1].counters['total-b-ub'] === 65 * 60 && firstWork.flightMinutes === 60;
      const pairedCounters = [
        ['vka-1', 'Левая ВКА', 1, 55], ['vka-2', 'Правая ВКА', 2, 65],
        ['gtde-1', 'Левый ГТДЭ', 1, undefined], ['gtde-2', 'Правый ГТДЭ', 2, undefined],
      ].every(([slot, name, starts, minutes]) => {
        const unit = engine(slot);
        const entry = firstWork.templateWork.units.find(row => row.blockId === unit.id);
        return unit.name === name && unit.starts === starts && unit.sneMinutes === minutes && !unit.sneLandings &&
          entry.counters.starts === starts && (minutes != null || Object.keys(entry.counters).join() === 'starts');
      });
      const maximas = Object.entries(pair[0].counters).filter(([key]) => key.startsWith('maximum')).map(([,value]) => value);
      openEngine('engine-left');
      const logColumns = () => [...document.querySelectorAll('.template-table thead th')].map(header => header.textContent);
      const orderedHeadings = [
        'Дата работы', 'Запуски', 'Земля · Б', 'Земля · Б + УБ', 'Полёт · Б', 'Полёт · Б + УБ', 'Максимал · ОР',
        'Максимал · ОР + Б', 'Максимал · Б + УБ', 'Итог · Б', 'Итог · Б + УБ', 'Работа на заказ',
      ].join('|');
      const logValues = () => [...document.querySelectorAll('.template-table tbody tr:first-child td')].map(cell => cell.textContent).join('|');
      const leftLog = logColumns().join('|') === orderedHeadings &&
        logValues() === '1 / 1|00:13|00:23|00:40|00:50|00:00:03|00:00:08|00:00:12|00:43|00:55|—';
      const logBeforeSettings = document.querySelector('.template-table').compareDocumentPosition(document.querySelector('#block-form [name=name]')) === Node.DOCUMENT_POSITION_FOLLOWING;
      const repair = document.querySelector('#block-event-form');
      repair.elements.type.value = 'repair';
      repair.requestSubmit();
      back();
      openEngine('engine-right');
      const rightLog = logColumns().join('|') === orderedHeadings &&
        logValues() === '2 / 2|00:13|00:23|00:40|01:00|00:00:03|00:00:08|00:00:12|00:43|01:05|—';
      const event = document.querySelector('#block-event-form');
      event.elements.type.value = 'dismantle';
      event.requestSubmit();
      back();
      const vkaLogs = ['vka-1', 'vka-2'].every((slot, index) => {
        openEngine(slot);
        const match = logColumns().join('|') === orderedHeadings && logValues().split('|')[9] === ['00:55', '01:05'][index];
        back();
        return match;
      });
      const gtdeLogs = ['gtde-1', 'gtde-2'].every((slot, index) => {
        openEngine(slot);
        const match = logColumns().join('|') === 'Дата работы|Запуски|Сумма СНЭ|Сумма ППР' &&
          logValues() === [index + 1, index + 1, '—'].join('|');
        if (index === 0) {
          const unitRepair = document.querySelector('#block-event-form');
          unitRepair.elements.type.value = 'repair';
          unitRepair.requestSubmit();
        }
        back();
        return match;
      });
      const pendingRecord = record(true);
      const pending = board().shifts.at(-1).templateWork.engines[1];
      openEngine('engine-left');
      const totals = [...document.querySelectorAll('.template-table tfoot tr')].map(row => row.textContent);
      const repairs = totals[0].includes('01:50') && totals[1].includes('ППР') && totals[1].includes('00:55');
      back();
      openEngine('gtde-1');
      const gtdePpr = [...document.querySelectorAll('.template-table tbody tr')].map(row =>
        [...row.querySelectorAll('td')].map(cell => cell.textContent).join('|')).join('/') === '1|1|—/1|2|1' &&
        engine('gtde-1').pprStarts === 1 && engine('gtde-2').pprStarts == null;
      back();
      click('[data-aircraft-tab="works"]');
      click('[data-shift-id]');
      const showsRaw = document.querySelector('main').textContent.includes('Ожидает привязки') &&
        document.querySelector('main').textContent.includes('00:13');
      back();
      click('[data-aircraft-tab="aggregates"]');
      click('[data-action="add-block"]');
      const replacement = document.querySelector('#creation-form');
      replacement.elements.name.value = 'Новый правый двигатель';
      replacement.elements.kind.value = 'engine';
      replacement.elements.kind.dispatchEvent(new Event('change'));
      replacement.elements.templateSlotId.value = 'engine-right';
      replacement.elements.serialNumber.value = 'TEST-02';
      replacement.requestSubmit();
      record(false);
      const latest = board().shifts.at(-1).templateWork;
      const next = latest.engines[1];
      const replaces = next.blockId !== pair[1].blockId && next.serialNumber === 'TEST-02' &&
        board().shifts[0].templateWork.engines[1].blockId === pair[1].blockId;
      const excludesUnpairedUnits = latest.units.length === 0 && engine('gtde-2').starts === 2;
      click('[data-action="add-block"]');
      const aggregateForm = document.querySelector('#creation-form');
      aggregateForm.elements.name.value = 'ГАК (проверка учёта)';
      function addRule(name, source, factor, initial) {
        click('[data-aggregate-rule-add]');
        const row = document.querySelector('[data-rule-id]:last-child');
        const input = key => row.querySelector('[data-rule="' + key + '"]');
        input('name').value = name;
        input('source').value = source;
        input('source').dispatchEvent(new Event('change'));
        input('factor').value = factor;
        input('sne').value = initial;
      }
      addRule('Посадки', 'board:runway', 2, 3);
      addRule('Проверки', 'manual', 0.5, 0);
      addRule('Запуски правого', 'position:engine-right:starts', 3, 0);
      aggregateForm.requestSubmit();
      const aggregate = () => board().blocks.find(block => block.name === 'ГАК (проверка учёта)');
      const aggregateBalances = () => aggregate().usageCounters.map(rule => aggregate().usageTotals[rule.id]);
      click('[data-block-id="' + aggregate().id + '"]');
      click('[data-view="block-usage-rules"]');
      const rulesPersisted = document.querySelectorAll('[data-rule-id]').length === 3 &&
        document.querySelector('[data-rule-id] [data-rule="sne"]').value === '3';
      const ruleName = () => document.querySelector('#aggregate-rules-form [data-rule-id] [data-rule="name"]');
      async function leaveRules(action) {
        back();
        const dialog = document.querySelector('dialog[open]');
        if (!dialog?.textContent.includes('Сохранить изменения учёта наработки?')) throw new Error('Нет предупреждения о несохранённом учёте');
        await new Promise(resolve => {
          dialog.addEventListener('close', resolve, { once: true });
          dialog.querySelector('[value="' + action + '"]').click();
        });
      }
      ruleName().value = 'Черновик';
      await leaveRules('cancel');
      const rulesCancel = ruleName()?.value === 'Черновик';
      await leaveRules('discard');
      const rulesDiscard = !ruleName() && aggregate().usageCounters[0].name === 'Посадки';
      click('[data-view="block-usage-rules"]');
      ruleName().value = 'Циклы от посадок';
      await leaveRules('save');
      const rulesSavedOnBack = !ruleName() && aggregate().usageCounters[0].name === 'Циклы от посадок';
      back();
      function recordAggregate() {
        click('[data-view="shift"]');
        const form = document.querySelector('#template-work-form');
        form.querySelector('[data-template-field="board-flight"]').value = '00:01';
        form.querySelector('[data-template-field="runway"]').value = '2';
        form.querySelector('[data-template-scope="engine-right"] [data-template-field="starts"]').value = '1';
        form.querySelector('[data-aggregate-manual-block] input').value = '10';
        form.dispatchEvent(new Event('input'));
        const previewed = document.querySelector('#template-preview').textContent.includes('Наработка агрегатов (3)');
        form.requestSubmit();
        return previewed;
      }
      const aggregatePreview = recordAggregate();
      const firstTotals = aggregateBalances();
      click('[data-block-id="' + aggregate().id + '"]');
      const aggregateJournal = document.querySelector('[data-tile-key="form:aggregate-log"]').textContent.includes('Циклы от посадок');
      document.querySelector('#block-event-form').requestSubmit();
      const repairBalances = aggregate().events.at(-1).beforeRepair.aggregate[0].sne === 7 &&
        aggregateBalances().every(total => total.ppr === 0);
      back();
      recordAggregate();
      const aggregateTotals = JSON.stringify(firstTotals) === JSON.stringify([{sne:7,ppr:null},{sne:5,ppr:null},{sne:3,ppr:null}]) &&
        JSON.stringify(aggregateBalances()) === JSON.stringify([{sne:11,ppr:4},{sne:10,ppr:5},{sne:6,ppr:3}]);
      const aggregateHistory = board().shifts.at(-1).aggregateAccruals.map(entry => entry.amount).join(',') === '4,5,3';
      click('[data-aircraft-tab="works"]');
      click('[data-view="reports"]');
      const report = document.querySelector('[data-report-aggregates]');
      const aggregateReport = report.textContent.includes('ГАК (проверка учёта)') &&
        report.textContent.includes('Циклы от посадок · 8 пос.') && report.textContent.includes('Проверки · 10 шт.');
      const reportForm = document.querySelector('#report-form');
      reportForm.elements.period.value = 'custom';
      reportForm.elements.from.value = '2000-01-01';
      reportForm.elements.to.value = '2000-01-02';
      reportForm.requestSubmit();
      const aggregateReportPeriod = !document.querySelector('[data-report-aggregates]');
      back();
      click('[data-aircraft-tab="aggregates"]');
      return { empty, imported, types, routed, pairedCounters, vkaLogs, gtdeLogs, gtdePpr, excludesUnpairedUnits,
        maximas, orderedInputs: first.orderedInputs, leftLog, rightLog, noDuplicates, rulesPersisted, rulesCancel, rulesDiscard, rulesSavedOnBack,
        aggregatePreview, aggregateJournal, repairBalances, aggregateTotals, aggregateHistory, aggregateReport, aggregateReportPeriod,
        logBeforeSettings, repairs, replaces, preview: first.preview.includes('00:43'),
        rowsRemoved: first.rowsRemoved, pending: pending.pending && !pending.blockId && pendingRecord.preview.includes('ожидает привязки'), showsRaw };
    })()`);
    assert.deepEqual(experimental, { empty: true, imported: true, types: {airframe:1, engine:2, unit:4}, routed: true,
      pairedCounters: true, vkaLogs: true, gtdeLogs: true, gtdePpr: true, excludesUnpairedUnits: true,
      maximas: [3,8,12], orderedInputs: true, leftLog: true, rightLog: true, logBeforeSettings: true,
      noDuplicates: true, rulesPersisted: true, rulesCancel: true, rulesDiscard: true, rulesSavedOnBack: true,
      aggregatePreview: true, aggregateJournal: true, repairBalances: true,
      aggregateTotals: true, aggregateHistory: true, aggregateReport: true, aggregateReportPeriod: true,
      repairs: true, replaces: true, preview: true, rowsRemoved: true, pending: true, showsRaw: true });
    results.templateExperiment = "ok";
    await evaluate(`(() => {
      const key = 'aviation-resource-prototype-v1';
      const saved = JSON.parse(localStorage.getItem(key));
      const aircraft = saved.aircraft.find(row => row.boardNumber === '101');
      const previousLabel = 'Налёт по вылету';
      saved.usageTypeOverrides.find(row => row.type === 'су-33').labels.flight = previousLabel;
      for (const template of [aircraft.workTemplate, saved.templateCatalog[0]]) {
        template.inputs.find(field => field.role === 'flight').label = previousLabel;
      }
      for (const shift of aircraft.shifts) shift.templateWork.boardFields.find(field => field.role === 'flight').label = previousLabel;
      localStorage.setItem(key, JSON.stringify(saved));
    })()`);
    await command("Page.reload");
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await evaluate("Boolean(document.querySelector('[data-aircraft-id]'))").catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const updatedFlightLabels = await evaluate(`(() => {
      const click = selector => document.querySelector(selector).click();
      const back = () => window.handleAndroidBack();
      click('[data-aircraft-id]');
      const counters = [...document.querySelectorAll('#counter-preview [data-tile-caption]')];
      const value = label => counters.find(node => node.textContent === label)?.nextElementSibling?.textContent;
      const cards = value('Налёт СНЭ') !== undefined && value('Налёт ППР') === '0' && value('Посадки ППР') === '0';
      click('[data-view="shift"]');
      const input = document.querySelector('[data-template-field="board-flight"]').closest('label').textContent.trim() === 'Налёт';
      back();
      click('[data-aircraft-tab="works"]');
      click('[data-shift-id]');
      const history = [...document.querySelectorAll('dt')].some(node => node.textContent === 'Налёт') &&
        !document.querySelector('main').textContent.includes('Налёт по вылету');
      back();
      click('[data-aircraft-tab="aggregates"]');
      const board = JSON.parse(localStorage.getItem('aviation-resource-prototype-v1')).aircraft[0];
      click('[data-block-id="' + board.blocks.find(block => block.kind === 'airframe').id + '"]');
      const ppr = document.querySelector('#block-form [name=pprFlightMinutes]');
      const form = ppr.placeholder === '0' && ppr.disabled && ppr.value === '' &&
        [...document.querySelectorAll('#block-form .metric span')].some(node => node.textContent === 'Налёт СНЭ');
      back();
      return { cards, input, history, form };
    })()`);
    assert.deepEqual(updatedFlightLabels, { cards: true, input: true, history: true, form: true });
    results.flightLabels = "ok";
    const portable = await evaluate(`(async () => {
      const click = selector => {
        const node = document.querySelector(selector);
        if (!node) throw new Error('Не найдено: ' + selector);
        node.click();
      };
      const back = () => window.handleAndroidBack();
      const read = () => JSON.parse(localStorage.getItem('aviation-resource-prototype-v1'));
      const catalog = () => { click('[data-action="settings"]'); click('[data-view="aircraft-types"]'); };
      function create(type, number) {
        click('[data-action="add-aircraft"]');
        const form = document.querySelector('#creation-form');
        form.elements.type.value = type;
        form.elements.type.dispatchEvent(new Event('change'));
        form.elements.boardNumber.value = number;
        form.requestSubmit();
      }
      back();
      catalog();
      click('#create-aircraft-template');
      const blank = document.querySelector('#template-editor-form');
      blank.elements.name.value = 'Шаблон с нуля';
      blank.requestSubmit();
      const blankSaved = read().templateCatalog.some(item => item.name === 'Шаблон с нуля' && item.positions.length === 1);
      click('[data-copy-template="0"]');
      const form = document.querySelector('#template-editor-form');
      form.elements.name.value = 'Четыре двигателя';
      form.elements.id.value = 'example-four';
      const set = (index, values) => {
        const row = form.querySelectorAll('[data-template-entry="positions"]')[index];
        for (const [key, value] of Object.entries(values)) {
          const input = row.querySelector('[data-property="' + key + '"]');
          input.value = value;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      };
      for (let index = 1; index <= 4; index++) {
        if (index >= 3) click('[data-template-edit="add"][data-list="positions"]');
        set(index < 3 ? index : index + 4, { id: 'motor-' + index, kind: 'engine', label: 'Двигатель ' + index });
      }
      for (let index = 3; index <= 6; index++) set(index, { linkSource: 'motor-' + (index % 2 === 1 ? 1 : 2) });
      click('[data-template-edit="add"][data-list="positions"]');
      set(9, { id: 'unit-four', kind: 'unit', label: 'Связанный агрегат 4', linkSource: 'motor-4', linkCounters: 'starts' });
      form.requestSubmit();
      const saved = read().templateCatalog.find(item => item.id === 'example-four');
      if (!saved) throw new Error(document.querySelector('#template-editor-error').textContent);
      back();
      back();
      create(saved.name, '401');
      const board = () => read().aircraft.find(row => row.boardNumber === '401');
      click('[data-view="shift"]');
      const work = document.querySelector('#template-work-form');
      for (let i = 1; i <= 4; i++) {
        const scope = work.querySelector('[data-template-scope="motor-' + i + '"]');
        const values = { starts: '1', 'ground-b': '00:13', 'ground-b-ub': '00:23', 'flight-b': '00:' + i + '0', 'flight-b-ub': '00:' + i + '0' };
        for (const [key, value] of Object.entries(values)) scope.querySelector('[data-template-field="' + key + '"]').value = value;
      }
      work.requestSubmit();
      const savedWork = board().shifts.at(-1).templateWork;
      const fourTotals = savedWork.engines.map(row => row.counters['total-b-ub'] / 60).join(',') === '15,25,35,45' &&
        savedWork.units.some(row => row.slotId === 'unit-four' && row.counters.starts === 1);
      click('[data-aircraft-tab="works"]');
      click('[data-view="reports"]');
      const report = [...document.querySelectorAll('#report-results .accrual-items li strong')].map(element => element.textContent).join('|');
      back();
      click('[data-aircraft-tab="aggregates"]');
      const oldId = board().blocks.find(block => block.templateSlotId === 'motor-4').id;
      const target = document.querySelector('[data-block-id="' + oldId + '"]');
      target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [new Touch({ identifier: 1, target, clientX: 20, clientY: 20 })] }));
      await new Promise(resolve => setTimeout(resolve, 750));
      target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));
      const active = '.counter-tile-active';
      const priorIndex = document.querySelector(active).dataset.counterIndex;
      click(active + ' [data-layout-action="up"]');
      const movedIndex = Number(document.querySelector(active).dataset.counterIndex);
      click(active + ' [data-layout-action="size"]');
      click(active + ' [data-layout-action="edit"]');
      let dialog = document.querySelector('dialog[open]');
      dialog.querySelector('input').value = 'Мой двигатель 4';
      await new Promise(resolve => {
        dialog.addEventListener('close', resolve, { once: true });
        dialog.querySelector('[value="save"]').click();
      });
      click('#layout-save');
      click('[data-action="settings"]');
      let payload;
      window.AndroidBridge = { saveAircraftTemplate(filename, json) { payload = { filename, json }; } };
      click('#export-board-template');
      delete window.AndroidBridge;
      const exported = JSON.parse(payload.json);
      const layout = exported.layout.tabs.aggregates;
      const tile = layout.find(item => item.keys.includes('slot:motor-4'));
      const exportOk = payload.filename === 'example-four.json' && movedIndex < Number(priorIndex) &&
        tile.labels['slot:motor-4'] === 'Мой двигатель 4' && Boolean(tile.span) &&
        !payload.json.includes(oldId) && !exported.shifts && !exported.boardNumber;
      back();
      back();
      catalog();
      exported.id = 'portable-four';
      exported.name = 'Перенесённый шаблон';
      const wrapper = new DataTransfer();
      wrapper.items.add(new File([JSON.stringify(exported)], 'portable-four.json', { type:'application/json' }));
      const picker = document.querySelector('#aircraft-template-file');
      picker.files = wrapper.files;
      picker.dispatchEvent(new Event('change'));
      for (let attempt = 0; attempt < 30 && !document.querySelector('dialog[open]'); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
      dialog = document.querySelector('dialog[open]');
      if (!dialog) throw new Error(document.querySelector('#template-import-status').textContent);
      await new Promise(resolve => {
        dialog.addEventListener('close', resolve, { once: true });
        dialog.querySelector('[value="import"]').click();
      });
      back();
      back();
      create(exported.name, '402');
      const instance = read().aircraft.find(row => row.boardNumber === '402');
      const newId = instance.blocks.find(block => block.templateSlotId === 'motor-4').id;
      const content = document.querySelector('[data-block-id="' + newId + '"]');
      const remapped = instance.boardLayouts.aggregates[layout.indexOf(tile)].keys.includes('widget:' + newId) &&
        content.textContent.includes('Мой двигатель 4') &&
        instance.boardLayouts.aggregates[layout.indexOf(tile)].span === tile.span && !instance.shifts.length;
      return { blankSaved, fourTotals, report, exportOk, remapped };
    })()`);
    assert.deepEqual(portable, { blankSaved: true, fourTotals: true, report: "Двигатель 1|Двигатель 2|Двигатель 3|Двигатель 4", exportOk: true, remapped: true });
    results.portableFourEngineTemplate = "ok";
    const formResources = await evaluate(`(() => {
      const read = () => JSON.parse(localStorage.getItem('aviation-resource-prototype-v1')).aircraft.find(row => row.boardNumber === '402');
      const click = selector => {
        const element = document.querySelector(selector);
        if (!element) throw new Error('Не найдено: ' + selector);
        element.click();
      };
      const back = () => window.handleAndroidBack();
      const block = slot => read().blocks.find(item => item.templateSlotId === slot);
      const visit = slot => click('[data-block-id="' + block(slot).id + '"]');
      const bySlot = slot => read().resources.find(item => item.name === 'Ресурс ' + slot);
      const slots = ['airframe', 'motor-1', 'motor-2', 'vka-1', 'vka-2', 'gtde-1', 'gtde-2'];
      const added = slots.every((slot, index) => {
        visit(slot);
        click('[data-action="add-resource"]');
        const form = document.querySelector('#resource-form');
        const targeted = form.elements.ownerId.value === block(slot).id;
        form.elements.name.value = 'Ресурс ' + slot;
        form.elements.limit.value = '100';
        form.elements.remaining.value = String(60.5 + index);
        if (slot.startsWith('gtde')) {
          form.elements.unit.value = 'зап.';
          form.elements.unit.dispatchEvent(new Event('change'));
        }
        form.requestSubmit();
        back();
        const resource = bySlot(slot);
        const result = targeted && resource.objectId === block(slot).id && resource.remaining === 60.5 + index &&
          Boolean(document.querySelector('#block-form [data-resource-id="' + resource.id + '"]'));
        back();
        return result;
      });
      visit('vka-1');
      click('[data-resource-id="' + bySlot('vka-1').id + '"]');
      const extension = document.querySelector('#extension-form');
      extension.elements.limit.value = '105';
      extension.elements.basis.value = 'Проверка';
      extension.elements.documentNumber.value = 'TEST-1';
      extension.elements.documentDate.value = extension.elements.date.value;
      extension.requestSubmit();
      back();
      back();
      const originalResource = bySlot('vka-1');
      function selectExisting(id) {
        click('#attach-existing-resource');
        const form = document.querySelector('dialog[open] form');
        form.elements.resource.value = id;
        form.elements.resource.dispatchEvent(new Event('change'));
        return form;
      }
      visit('gtde-1');
      const incompatible = selectExisting(originalResource.id);
      const blocked = incompatible.querySelector('[type=submit]').disabled && incompatible.textContent.includes('недоступен расход');
      incompatible.querySelector('[data-cancel]').click();
      back();
      visit('motor-2');
      const cancelled = selectExisting(originalResource.id);
      cancelled.querySelector('[data-cancel]').click();
      const intactOnCancel = bySlot('vka-1').objectId === block('vka-1').id;
      const form = selectExisting(originalResource.id);
      form.requestSubmit();
      const moved = bySlot('vka-1');
      const kept = JSON.stringify(moved) === JSON.stringify({ ...originalResource, object: block('motor-2').name, objectId: block('motor-2').id }) &&
        originalResource.history.length === 1 && read().resources.length === slots.length &&
        Boolean(document.querySelector('[data-resource-id="' + moved.id + '"]'));
      back();
      visit('vka-1');
      const removedFromSource = !document.querySelector('[data-resource-id="' + moved.id + '"]');
      back();
      click('[data-view="shift"]');
      const work = document.querySelector('#template-work-form');
      const scope = work.querySelector('[data-template-scope="motor-2"]');
      const inputs = { starts: '1', 'ground-b': '00:00', 'ground-b-ub': '00:00', 'flight-b': '00:30', 'flight-b-ub': '00:30' };
      for (const [key, value] of Object.entries(inputs)) scope.querySelector('[data-template-field="' + key + '"]').value = value;
      work.requestSubmit();
      const accrual = read().shifts.at(-1).accruals.filter(item => item.resourceId === moved.id);
      const chargedToNewOwner = accrual.length === 1 && accrual[0].blockId === block('motor-2').id &&
        accrual[0].amount === 0.5 && bySlot('vka-1').remaining === moved.remaining - 0.5;
      return { added, blocked, intactOnCancel, kept, removedFromSource, chargedToNewOwner };
    })()`);
    assert.deepEqual(formResources, { added: true, blocked: true, intactOnCancel: true, kept: true, removedFromSource: true, chargedToNewOwner: true });
    results.formResources = "ok";
    const compactAudit = await evaluate(`(() => {
      const screens = [];
      const back = () => window.handleAndroidBack();
      const get = selector => {
        const element = document.querySelector(selector);
        if (!element) throw new Error('Не найдено: ' + selector);
        return element;
      };
      const click = selector => get(selector).click();
      function check(title) {
        const width = document.documentElement.clientWidth;
        const selectors = [
          'fieldset', 'label', 'input:not([type=hidden])', 'textarea', 'select', 'summary', 'button', 'output', '.metric', '.setting-row',
          '.aircraft-card', '.resource-row', '.history-row', '.counter-tile', '.template-table-wrap',
        ].join(',');
        for (const element of document.querySelectorAll('main :is(' + selectors + '), dialog[open] :is(' + selectors + ')')) {
          if (!element.getClientRects().length || element.closest('.filter-row, .usage-map-scroll')) continue;
          const bounds = element.getBoundingClientRect();
          if (bounds.left < -1 || bounds.right > width + 1) {
            throw new Error(title + ' выходит за ширину ' + width + ': ' + element.tagName + ' ' + (element.name || element.id || element.className));
          }
        }
        screens.push(title);
      }
      function sideBySide(left, right) {
        const a = get(left).getBoundingClientRect();
        const b = get(right).getBoundingClientRect();
        if (Math.abs(a.top - b.top) > 2 || a.right > b.left + 1 || a.height < 44 || b.height < 44) {
          throw new Error('Поля должны стоять рядом и оставаться доступными для нажатия: ' + left + ' и ' + right);
        }
      }
      function separateTiles(left, right) {
        const tiles = [get(left), get(right)].map(control => control.closest('.counter-tile') || control.closest('label'));
        if (!tiles[0].matches('.counter-tile')) sideBySide(left, right);
        else if (Math.abs(tiles[0].getBoundingClientRect().top - tiles[1].getBoundingClientRect().top) > 2) {
          throw new Error('Плитки формуляра должны стоять рядом');
        }
        const group = tiles[0].parentElement;
        const width = group.getBoundingClientRect().width;
        if (tiles[1].parentElement !== group || tiles.some(tile => {
          const style = getComputedStyle(tile);
          return Number.parseFloat(style.borderRadius) < 10 || tile.getBoundingClientRect().width > width * 0.55;
        })) throw new Error('Вместо соседних карточек отрисована широкая строка: ' + left + ' и ' + right);
      }
      const storage = JSON.parse(localStorage.getItem('aviation-resource-prototype-v1'));
      const board = storage.aircraft.find(row => row.boardNumber === '402');
      const card = '[data-aircraft-id="' + board.id + '"]';
      for (const block of board.blocks) {
        click('[data-block-id="' + block.id + '"]');
        check('Формуляр · ' + block.name);
        separateTiles('#block-form [name=name]', '#block-form [name=caption]');
        const table = document.querySelector('.template-table-wrap');
        if (table) {
          const date = table.querySelector('thead th');
          const left = date.getBoundingClientRect().left;
          table.scrollLeft = table.scrollWidth;
          if (getComputedStyle(date).position !== 'sticky' || Math.abs(date.getBoundingClientRect().left - left) > 2) {
            throw new Error('Дата не закреплена при прокрутке');
          }
          table.scrollLeft = 0;
        }
        click('[data-view="correct-usage"]');
        check('Показания · ' + block.name);
        back();
        click('[data-action="add-resource"]');
        check('Добавление ресурса · ' + block.name);
        separateTiles('#resource-form [name=object]', '#resource-form [name=name]');
        separateTiles('#resource-form [name=limit]', '#resource-form [name=remaining]');
        separateTiles('#resource-form [name=produced]', '#resource-form [name=installed]');
        if (get('#resource-form [type=submit]').getBoundingClientRect().width >= get('#resource-form').getBoundingClientRect().width - 1) {
          throw new Error('Кнопка ресурса растянута на всю форму');
        }
        for (const details of document.querySelectorAll('#resource-form details')) details.open = true;
        check('Дополнительные поля · ' + block.name);
        back();
        if (document.querySelector('#attach-existing-resource')) {
          click('#attach-existing-resource');
          check('Привязка · ' + block.name);
          back();
        }
        back();
      }
      click('[data-view="shift"]');
      check('Данные работы');
      back();
      click('[data-view="resources"]');
      check('Остатки ресурсов');
      const existing = board.resources.find(resource => resource.unit === 'ч');
      click('[data-resource-id="' + existing.id + '"]');
      check('Ресурс и продление');
      back();
      back();
      click('[data-aircraft-tab="works"]');
      check('Регламентные работы');
      click('[data-view="reports"]');
      check('Отчёт');
      sideBySide('#report-form [name=from]', '#report-form [name=to]');
      back();
      click('[data-shift-id]');
      check('История работы');
      back();
      click('[data-aircraft-tab="least-reliable"]');
      check('Карточки ресурса');
      click('[data-aircraft-tab="aggregates"]');
      check('Карточки агрегатов');
      click('[data-action="add-block"]');
      check('Добавление агрегата');
      back();
      click('[data-view="usage-map"]');
      check('Карта наработки');
      back();
      click('[data-action="settings"]');
      check('Настройки борта');
      click('[data-view="board-usage"]');
      check('Показатели борта');
      back();
      back();
      back();
      check('Карточки самолётов');
      const menu = get(card).closest('article').querySelector('.aircraft-card-menu');
      menu.open = true;
      check('Меню самолёта');
      click('[data-board-menu="board-details"][data-board-id="' + board.id + '"]');
      check('Реквизиты борта');
      separateTiles('[name=serialNumber]', '[name=rfNumber]');
      back();
      click('[data-board-menu="board-image"][data-board-id="' + board.id + '"]');
      check('Картинка борта');
      back();
      click('[data-action="add-aircraft"]');
      check('Добавление самолёта');
      back();
      click('[data-action="settings"]');
      check('Общие настройки');
      click('[data-view="diagnostics"]');
      check('Диагностика');
      back();
      click('[data-action="about"]');
      check('О приложении');
      back();
      click('[data-view="usage-settings"]');
      check('Виды наработки');
      back();
      click('[data-view="aircraft-types"]');
      check('Справочник');
      click('[data-copy-template]');
      for (const details of document.querySelectorAll('#template-editor-form details')) details.open = true;
      check('Редактор шаблона');
      back();
      back();
      back();
      click(card);
      return screens.length;
    })()`);
    assert.ok(compactAudit >= 60);
    results.compactAudit = compactAudit;
    const formLayout = await evaluate(`(async () => {
      const read = () => JSON.parse(localStorage.getItem('aviation-resource-prototype-v1')).aircraft.find(row => row.boardNumber === '402');
      const bySlot = (slot) => read().blocks.find(block => block.templateSlotId === slot);
      const get = selector => {
        const element = document.querySelector(selector);
        if (!element) throw new Error('Не найдено: ' + selector);
        return element;
      };
      const click = selector => get(selector).click();
      const back = () => window.handleAndroidBack();
      const keySelector = key => '[data-tile-key="' + key + '"]';
      const visit = slot => click('[data-block-id="' + bySlot(slot).id + '"]');
      const active = '.counter-tile-active';
      const selector = (key, action) => keySelector(key) + ' [data-layout-action="' + action + '"]';
      const touch = (element, type, x, y) => {
        const point = new Touch({ identifier: 7, target: element, clientX: x, clientY: y });
        element.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true,
          ...(type === 'touchend' ? { changedTouches: [point] } : { touches: [point] }) }));
      };
      async function hold(key) {
        const element = get(keySelector(key) + ' .counter-value');
        element.scrollIntoView({ block: 'center' });
        const bounds = element.getBoundingClientRect();
        touch(element, 'touchstart', bounds.left + 5, bounds.top + 5);
        await new Promise(resolve => setTimeout(resolve, 750));
        touch(element, 'touchend', bounds.left + 5, bounds.top + 5);
        if (get(active).dataset.tileKey !== key) throw new Error('Долгое нажатие не выбрало ' + key);
      }
      async function choose(value) {
        const dialog = get('dialog[open]');
        await new Promise(resolve => {
          dialog.addEventListener('close', resolve, { once: true });
          dialog.querySelector('[value="' + value + '"]').click();
        });
      }
      visit('airframe');
      const name = 'form-field:name';
      const caption = 'form-field:caption';
      const assembly = 'form:assembly:' + bySlot('vka-1').id;
      const identifiers = ['form-field:serialNumber', 'form-field:rfNumber'];
      let removableIdentifiers = true;
      for (const key of identifiers) {
        await hold(key);
        removableIdentifiers &&= Boolean(document.querySelector(selector(key, 'hide')));
        back();
      }
      const indexBefore = Number(get(keySelector(assembly)).dataset.counterIndex);
      const pendingText = 'Описание, введённое до перестановки';
      get('#block-form [name=caption]').value = pendingText;
      await hold(assembly);
      click('[data-gesture=move]');
      const card = get(active);
      const neighbor = document.querySelectorAll('#counter-preview .counter-tile')[indexBefore - 1];
      card.scrollIntoView({ block: 'center' });
      const first = card.getBoundingClientRect();
      const second = neighbor.getBoundingClientRect();
      const item = card.querySelector('.counter-value');
      touch(item, 'touchstart', first.left + 12, first.top + 12);
      touch(item, 'touchmove', second.left + 12, second.top + 12);
      const live = Boolean(neighbor.style.order);
      touch(item, 'touchend', second.left + 12, second.top + 12);
      const moved = Number(get(active).dataset.counterIndex) < indexBefore;
      click('[data-gesture=resize]');
      const value = get(active + ' .counter-value');
      const widthBefore = get(active).getBoundingClientRect().width;
      touch(value, 'touchstart', 160, 370);
      touch(value, 'touchmove', 150, 370);
      const resized = get(active).getBoundingClientRect().width < widthBefore;
      touch(value, 'touchend', 150, 370);
      click('[data-gesture=font]');
      const text = get(active + ' .counter-value');
      touch(text, 'touchstart', 160, 370);
      touch(text, 'touchmove', 160, 356);
      touch(text, 'touchend', 160, 356);
      const restyled = get(active).style.getPropertyValue('--tile-font') !== '1rem';
      click(selector(assembly, 'edit'));
      get('dialog[open] input').value = 'ВКА слева';
      await choose('save');
      click('#layout-save');
      const preservedInput = get('#block-form [name=caption]').value === pendingText;
      const savedTile = bySlot('airframe').formLayout.tiles.find(tile => tile.keys.includes(assembly));
      const saved = moved && resized && live && restyled && savedTile.span < 6 && savedTile.font > 1 &&
        savedTile.labels[assembly] === 'ВКА слева' && get(keySelector(assembly)).textContent.includes('ВКА слева');
      if (!saved) throw new Error(JSON.stringify({ moved, resized, live, restyled, savedTile }));
      await hold(caption);
      click(selector(caption, 'hide'));
      click('#layout-save');
      const hidden = !document.querySelector(keySelector(caption)) && bySlot('airframe').formLayout.hidden.includes(caption)
        && get('#block-form [name=caption]').value === pendingText && get('#block-form [name=caption]').closest('label').hidden;
      click('#edit-form-layout');
      click('#layout-restore');
      await choose(caption);
      click('#layout-save');
      const restored = Boolean(document.querySelector(keySelector(caption))) &&
        bySlot('airframe').formLayout.hidden.length === 0;
      click('[data-dismantle-block="' + bySlot('vka-1').id + '"]');
      await choose('cancel');
      const cancelled = Boolean(document.querySelector(keySelector(assembly)));
      click('[data-dismantle-block="' + bySlot('vka-1').id + '"]');
      await choose('dismantle');
      const dismantled = !document.querySelector(keySelector(assembly)) &&
        bySlot('vka-1').events.at(-1).type === 'dismantle' &&
        Boolean(document.querySelector('[data-tile-key^="form:installation:"]'));
      if (!document.querySelector(keySelector(name))) throw new Error('Карточка названия потерялась');
      back();
      const childForms = ['motor-1', 'vka-2', 'gtde-1'];
      const independent = childForms.every(slot => {
        visit(slot);
        click('#edit-form-layout');
        const editor = Boolean(document.querySelector('[data-gesture=move]')) && !bySlot(slot).formLayout;
        back();
        back();
        return editor;
      });
      click('[data-action="add-block"]');
      const newForm = get('#creation-form');
      newForm.elements.name.value = 'Дополнительный формуляр';
      newForm.elements.kind.value = 'unit';
      newForm.requestSubmit();
      const added = read().blocks.find(block => block.name === 'Дополнительный формуляр');
      click('[data-block-id="' + added.id + '"]');
      await hold(caption);
      click(selector(caption, 'hide'));
      click('#layout-save');
      const manualForm = read().blocks.find(block => block.id === added.id).formLayout.hidden.includes(caption) &&
        !document.querySelector(keySelector(caption)) && bySlot('airframe').formLayout.hidden.length === 0;
      back();
      return { removableIdentifiers, saved, preservedInput, hidden, restored, cancelled, dismantled, independent, manualForm };
    })()`);
    assert.deepEqual(formLayout, { removableIdentifiers: true, saved: true, preservedInput: true, hidden: true, restored: true,
      cancelled: true, dismantled: true, independent: true, manualForm: true });
    results.formLayout = "ok";
    await evaluate(`(() => {
      const key = 'aviation-resource-prototype-v1';
      const saved = JSON.parse(localStorage.getItem(key));
      const board = saved.aircraft.find(row => row.boardNumber === '402');
      board.rfNumber = '330 037';
      const tiles = board.blocks.find(block => block.templateSlotId === 'airframe').formLayout.tiles;
      tiles.find(tile => tile.keys.includes('form-field:rfNumber')).labels = { 'form-field:rfNumber': 'RF 330 837' };
      tiles.find(tile => tile.keys.includes('form-field:repairs')).height = 83;
      localStorage.setItem(key, JSON.stringify(saved));
    })()`);
    await command("Page.reload");
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await evaluate("Boolean(document.querySelector('[data-aircraft-id]'))").catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const compactIdentifiers = await evaluate(`(async () => {
      const saved = () => JSON.parse(localStorage.getItem('aviation-resource-prototype-v1'));
      const board = () => saved().aircraft.find(row => row.boardNumber === '402');
      const layout = () => board().blocks.find(block => block.templateSlotId === 'airframe').formLayout;
      const get = selector => {
        const element = document.querySelector(selector);
        if (!element) throw new Error('Не найдено: ' + selector);
        return element;
      };
      const click = selector => get(selector).click();
      const rf = '[data-tile-key="form-field:rfNumber"]';
      const repairs = '[data-tile-key="form-field:repairs"]';
      const serial = '[data-tile-key="form-field:serialNumber"]';
      const initialLayouts = JSON.stringify(saved().aircraft.map(row => ({ board: row.boardLayouts, blocks: row.blocks.map(block => block.formLayout) })));
      click('[data-aircraft-id="' + board().id + '"]');
      click('[data-block-id="' + board().blocks.find(block => block.templateSlotId === 'airframe').id + '"]');
      function inOneLine(tile, control) {
        const label = get(tile + ' [data-tile-caption]').getBoundingClientRect();
        const value = get(tile + ' ' + control).getBoundingClientRect();
        return value.left >= label.right && Math.abs((label.top + label.bottom - value.top - value.bottom) / 2) < 8;
      }
      const compactRf = inOneLine(rf, 'input') && get(rf + ' input').value === '330 037' &&
        get(rf + ' [data-tile-caption]').textContent === 'RF';
      const compactRepairs = inOneLine(repairs, 'output') && get(repairs + ' output').textContent === '0';
      click('#edit-form-layout');
      click('#layout-save');
      const loadingKeepsLayouts = JSON.stringify(saved().aircraft.map(row => ({ board: row.boardLayouts, blocks: row.blocks.map(block => block.formLayout) }))) === initialLayouts;
      click('#edit-form-layout');
      click('[data-gesture=resize]');
      function touch(element, type, x, y) {
        const point = new Touch({ identifier: 29, target: element, clientX: x, clientY: y });
        element.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true,
          ...(type === 'touchend' ? { changedTouches: [point] } : { touches: [point] }) }));
      }
      function selectTile(tile) {
        const target = get(tile + ' .counter-value');
        const rect = target.getBoundingClientRect();
        touch(target, 'touchstart', rect.left + 5, rect.top + 5);
        touch(target, 'touchend', rect.left + 5, rect.top + 5);
      }
      selectTile(repairs);
      const resizeSwitch = get('.counter-tile-active').matches(repairs) &&
        get('[data-gesture=resize]').getAttribute('aria-pressed') === 'true';
      const content = get(repairs + ' .counter-value');
      touch(content, 'touchstart', 120, 400);
      touch(content, 'touchmove', 120, 325);
      const shrankVertically = get(repairs).getBoundingClientRect().height <= 39;
      touch(content, 'touchend', 120, 325);
      click('[data-gesture=font]');
      selectTile(rf);
      const fontSwitch = get('.counter-tile-active').matches(rf) &&
        get('[data-gesture=font]').getAttribute('aria-pressed') === 'true';
      function applyDialog() {
        const dialog = get('dialog[open]');
        return new Promise(resolve => {
          dialog.addEventListener('close', resolve, { once: true });
          dialog.querySelector('[value=save]').click();
        });
      }
      click(rf + ' [data-layout-action=edit]');
      get('dialog[open] [name="form-field:rfNumber"]').value = 'RF 330 837';
      await applyDialog();
      const previewValue = get(rf + ' input').value === '330 837' && get(rf + ' [data-tile-caption]').textContent === 'RF';
      selectTile(serial);
      click(serial + ' [data-layout-action=edit]');
      get('dialog[open] [name="identifier:serialNumber"]').value = 'SN-402';
      await applyDialog();
      click(serial + ' [data-layout-action=hide]');
      click('#layout-save');
      const pencilSavesValues = board().rfNumber === '330 837' && board().serialNumber === 'SN-402' &&
        layout().hidden.includes('form-field:serialNumber') && !document.querySelector(serial);
      get(rf + ' input').value = 'RF 330 038';
      get('#block-form').requestSubmit();
      const inlineSaves = board().rfNumber === '330 038' && get(rf + ' input').value === '330 038' && inOneLine(rf, 'input');
      window.handleAndroidBack();
      return { compactRf, compactRepairs, loadingKeepsLayouts, resizeSwitch, shrankVertically, fontSwitch, previewValue, pencilSavesValues, inlineSaves };
    })()`);
    assert.deepEqual(compactIdentifiers, { compactRf: true, compactRepairs: true, loadingKeepsLayouts: true,
      resizeSwitch: true, shrankVertically: true, fontSwitch: true, previewValue: true, pencilSavesValues: true, inlineSaves: true });
    results.compactIdentifiers = "ok";
    const boardDeletion = await evaluate(`(async () => {
      window.handleAndroidBack();
      const read = () => JSON.parse(localStorage.getItem('aviation-resource-prototype-v1'));
      const original = read();
      const target = original.aircraft.find(board => board.boardNumber === '401');
      const selected = original.aircraft.find(board => board.id === original.selectedAircraftId);
      const card = id => document.querySelector('[data-aircraft-id="' + id + '"]');
      function prompt(id) {
        const menu = card(id).closest('article').querySelector('.aircraft-card-menu');
        if (!menu.open) menu.querySelector('summary').click();
        menu.querySelector('[data-board-menu="delete-board"]').click();
        return document.querySelector('dialog[open]');
      }
      async function choose(dialog, value) {
        await new Promise(resolve => {
          dialog.addEventListener('close', resolve, { once: true });
          dialog.querySelector('[value="' + value + '"]').click();
        });
      }
      let dialog = prompt(target.id);
      const promptSpecific = dialog.querySelector('h2').textContent.includes('Четыре двигателя · борт 401') &&
        dialog.textContent.includes('без возможности восстановления') && target.shifts.length > 0;
      await choose(dialog, 'cancel');
      const cancel = Boolean(card(target.id)) && JSON.stringify(read()) === JSON.stringify(original);
      dialog = prompt(target.id);
      const setItem = Storage.prototype.setItem;
      try {
        Storage.prototype.setItem = function(key, value) {
          if (key === 'aviation-resource-prototype-v1') throw new Error('test write failure');
          return setItem.call(this, key, value);
        };
        await choose(dialog, 'delete');
      } finally {
        Storage.prototype.setItem = setItem;
      }
      const rollback = Boolean(card(target.id)) && JSON.stringify(read()) === JSON.stringify(original) &&
        document.querySelector('.toast')?.textContent === 'Не удалось удалить борт';
      await choose(prompt(target.id), 'delete');
      const after = read();
      const onlyTarget = !card(target.id) && JSON.stringify(after.aircraft) === JSON.stringify(original.aircraft.filter(board => board.id !== target.id)) &&
        after.selectedAircraftId === selected.id;
      await choose(prompt(selected.id), 'delete');
      const fallback = read().aircraft[0];
      const selectedFallback = read().selectedAircraftId === fallback.id;
      await choose(prompt(fallback.id), 'delete');
      const final = read();
      const last = final.aircraft.length === 0 && final.selectedAircraftId === null &&
        document.querySelector('main').textContent.includes('Самолётов пока нет') &&
        JSON.stringify(final.templateCatalog) === JSON.stringify(original.templateCatalog) &&
        JSON.stringify(final.aircraftTypes) === JSON.stringify(original.aircraftTypes);
      return { promptSpecific, cancel, rollback, onlyTarget, selectedFallback, last };
    })()`);
    assert.deepEqual(boardDeletion, { promptSpecific: true, cancel: true, rollback: true, onlyTarget: true, selectedFallback: true, last: true });
    await command("Page.reload");
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await evaluate("Boolean(document.querySelector('[data-action=add-aircraft]'))").catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(await evaluate(`!document.querySelector('[data-aircraft-id]') &&
      document.querySelector('main').textContent.includes('Самолётов пока нет')`), true);
    results.boardDeletion = "ok";
    if (process.argv.includes("--templates-only")) {
      process.stdout.write(`${JSON.stringify(results)}\n`);
      return;
    }
    await evaluate(`localStorage.setItem("aviation-resource-prototype-v1", JSON.stringify(${JSON.stringify(demoState)}))`);
    await command("Page.reload");
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await evaluate("Boolean(document.querySelector('[data-aircraft-id=su33-85]'))").catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const home = await evaluate(`({
      h1: document.querySelector("h1")?.textContent,
      hasSettings: Boolean(document.querySelector('[data-action="settings"]')),
      hasBottomNav: Boolean(document.querySelector('.bottom-nav'))
    })`);
    assert.deepEqual(home, { h1: "Самолёты", hasSettings: true, hasBottomNav: false });
    results.home = "ok";

    const general = await evaluate(`(() => {
      document.querySelector('[data-action="settings"]').click();
      return {
        h1: document.querySelector("h1")?.textContent,
        rows: document.querySelectorAll('[data-aircraft-notification-id]').length,
        subtitle: document.querySelector('.title-group span')?.textContent
      };
    })()`);
    assert.deepEqual(general, { h1: "Настройки", rows: 1, subtitle: "Приложение и все самолёты" });
    results.generalSettings = "ok";

    const masterOff = await evaluate(`(async () => {
      const master = document.querySelector('#global-notifications');
      master.checked = false;
      master.dispatchEvent(new Event('change', { bubbles: true }));
      const dialog = document.querySelector('dialog[open]');
      await new Promise(resolve => {
        dialog.addEventListener('close', resolve, { once: true });
        dialog.querySelector('[value="disable"]').click();
      });
      const saved = JSON.parse(localStorage.getItem('aviation-resource-prototype-v1'));
      return {
        master: saved.globalNotifications,
        aircraft: saved.aircraft.map((item) => item.notifications),
        switches: [...document.querySelectorAll('[data-aircraft-notification-id]')].map((item) => ({ checked: item.checked, disabled: item.disabled }))
      };
    })()`);
    assert.equal(masterOff.master, false);
    assert.deepEqual(masterOff.aircraft, [false]);
    assert.deepEqual(masterOff.switches, [{ checked: false, disabled: true }]);
    results.masterNotifications = "ok";

    const newAircraft = await evaluate(`(() => {
      if (!window.handleAndroidBack() || document.querySelector('h1')?.textContent !== 'Самолёты') {
        throw new Error('Системный возврат из общих настроек должен открыть главный экран');
      }
      document.querySelector('[data-action="settings"]').click();
      document.querySelector('[data-view="aircraft-types"]').click();
      const typeForm = document.querySelector('#aircraft-type-form');
      const box = typeForm.elements.type.getBoundingClientRect();
      const fullWidth = box.width >= typeForm.getBoundingClientRect().width - 1;
      typeForm.elements.type.value = "МиГ-29";
      typeForm.requestSubmit();
      const noUsageInCatalog = !document.querySelector('#usage-settings-form');
      window.handleAndroidBack();
      document.querySelector('[data-view="usage-settings"]').click();
      const choice = document.querySelector('#usage-aircraft-type');
      const firstByDefault = choice.value === choice.options[0].value;
      choice.value = 'МиГ-29';
      choice.dispatchEvent(new Event('change'));
      const noCatalogInUsage = !document.querySelector('#aircraft-type-form, [data-archive-type], #aircraft-type-trash');
      const onlyMain = [...document.querySelectorAll('[data-disable-source]')].map(button => button.dataset.disableSource).join(',') === 'flight,runway';
      const card = document.querySelector('[data-usage-kind="flight"]').closest('fieldset');
      const nameBox = card.querySelector('[name="flightLabel"]').getBoundingClientRect();
      const factorBox = card.querySelector('[name="flightFactor"]').getBoundingClientRect();
      const categoryBox = card.querySelector('[name="flightKind"]').getBoundingClientRect();
      const exampleBox = card.querySelector('.usage-example').getBoundingClientRect();
      const compact = Math.abs(nameBox.top - factorBox.top) < 1 && factorBox.left > nameBox.right &&
        categoryBox.top > nameBox.bottom && exampleBox.top > categoryBox.bottom && nameBox.width < card.clientWidth * 0.65;
      window.handleAndroidBack();
      window.handleAndroidBack();
      document.querySelector('[data-action="add-aircraft"]').click();
      const form = document.querySelector('#creation-form');
      form.elements.type.value = "МиГ-29";
      form.elements.type.dispatchEvent(new Event('change'));
      form.elements.newSource.value = 'Зацепы за аэрофинишер';
      document.querySelector('#creation-add-source').click();
      form.elements.newSource.value = 'Циклы борта';
      const localFactor = form.querySelector('[data-source-factor]');
      localFactor.value = '2';
      localFactor.dispatchEvent(new Event('input'));
      document.querySelector('#creation-add-source').click();
      document.querySelector('[data-creation-hide-source="flight"]').click();
      const canHideFlight = !document.querySelector('[data-creation-hide-source="flight"]');
      form.elements.existingSource.value = 'flight';
      document.querySelector('#creation-add-source').click();
      form.elements.boardNumber.value = "42";
      form.elements.serialNumber.value = "SN-42";
      form.requestSubmit();
      const saved = JSON.parse(localStorage.getItem('aviation-resource-prototype-v1'));
      const created = saved.aircraft.find((item) => item.boardNumber === "42");
      return {
        h1: document.querySelector("h1")?.textContent,
        count: saved.aircraft.length,
        notifications: created?.notifications,
        fullWidth, onlyMain, canHideFlight, noUsageInCatalog, firstByDefault, noCatalogInUsage, compact,
        localSources: created.customUsageSources.map(source => source.label),
        localDefinition: created.customUsageSources.map(({kind, factor}) => [kind, factor]),
        localHooks: created.enabledUsageSources.arresterHooks,
        tabs: [...document.querySelectorAll('[data-aircraft-tab]')].map((item) => item.textContent.trim()),
        activeTab: document.querySelector('[data-aircraft-tab][aria-selected="true"]')?.dataset.aircraftTab
      };
    })()`);
    assert.equal(newAircraft.h1, "МиГ-29 · Борт 42");
    assert.equal(newAircraft.count, 2);
    assert.equal(newAircraft.notifications, false);
    assert.ok(newAircraft.fullWidth && newAircraft.onlyMain && newAircraft.canHideFlight && newAircraft.localHooks);
    assert.ok(newAircraft.noUsageInCatalog && newAircraft.firstByDefault && newAircraft.noCatalogInUsage);
    assert.ok(newAircraft.compact);
    assert.deepEqual(newAircraft.localSources, ["Циклы борта"]);
    assert.deepEqual(newAircraft.localDefinition, [["count", 2]]);
    assert.equal(newAircraft.activeTab, "aggregates");
    assert.deepEqual(newAircraft.tabs, ["Работы", "Агрегаты", "Агрегаты с наименее надёжным ресурсом"]);
    results.newAircraftInheritsMasterOff = "ok";

    const aircraftTabs = await evaluate(`(() => {
      document.querySelector('[data-aircraft-tab="aggregates"]').click();
      const aggregatesTitle = document.querySelector('.aircraft-tab-panel h2')?.textContent;
      document.querySelector('[data-aircraft-tab="least-reliable"]').click();
      return {
        aggregatesTitle,
        leastReliableTitle: document.querySelector('.aircraft-tab-panel h2')?.textContent,
        selected: document.querySelector('[data-aircraft-tab="least-reliable"]')?.getAttribute('aria-selected')
      };
    })()`);
    assert.deepEqual(aircraftTabs, {
      aggregatesTitle: "Агрегаты",
      leastReliableTitle: "Агрегаты с наименее надёжным ресурсом",
      selected: "true",
    });
    results.aircraftTabs = "ok";

    const forms = await evaluate(`(() => {
      document.querySelector('[data-aircraft-tab="aggregates"]').click();
      const ids = [...document.querySelectorAll('[data-block-id]')].map(button => button.dataset.blockId);
      return ids.map(id => {
        document.querySelector('[data-block-id="' + id + '"]').click();
        const fields = {
          title: document.querySelector('h1')?.textContent,
          form: Boolean(document.querySelector('#block-form')),
          engine: Boolean(document.querySelector('#block-form [name="starts"]')),
          hasModel: Boolean(document.querySelector('#block-form [name="model"]')),
          hasSerial: Boolean(document.querySelector('#block-form [name="serialNumber"]')),
          boardSerial: document.querySelector('#block-form [name=serialNumber]')?.value,
          airframe: Boolean(document.querySelector('[aria-label="Наработка планера"]')),
          resource: Boolean(document.querySelector('[data-action="add-resource"]'))
        };
        document.querySelector('[data-action="back"]').click();
        return fields;
      });
    })()`);
    assert.deepEqual(forms.map(item => item.title), ["Формуляр самолёта", "Левый двигатель", "Правый двигатель", "ВКА", "ГТДЭ / ВСУ"]);
    assert.ok(forms.every(item => item.form && item.resource));
    assert.deepEqual(forms.map(item => item.engine), [false, true, true, false, false]);
    assert.equal(forms[0].airframe, true);
    assert.equal(forms[0].boardSerial, "SN-42");
    assert.ok(forms.filter(item => item.engine).every(item => !item.hasModel && item.hasSerial));
    results.defaultForms = "ok";
    const addedBlock = await evaluate(`(() => {
      document.querySelector('[data-action="add-block"]').click();
      const form = document.querySelector('#creation-form');
      form.elements.name.value = 'Запасной двигатель';
      form.elements.kind.value = 'engine';
      form.requestSubmit();
      const button = [...document.querySelectorAll('[data-block-id]')].find(item => item.textContent.includes('Запасной двигатель'));
      button.click();
      const engineFields = Boolean(document.querySelector('[name="sneMinutes"]'));
      const blockForm = document.querySelector('#block-form');
      blockForm.elements.sneMinutes.value = '600';
      blockForm.requestSubmit();
      document.querySelector('#block-event-form').requestSubmit();
      const history = document.querySelector('[data-form-widget^="event:"]').textContent;
      const sne = document.querySelector('[name="sneMinutes"]').value;
      const ppr = document.querySelector('[name="pprMinutes"]').value;
      document.querySelector('#edit-form-layout').click();
      const newEngineHasEditor = Boolean(document.querySelector('[data-gesture=move]'));
      window.handleAndroidBack();
      document.querySelector('[data-action="back"]').click();
      return { engineFields, history, sne, ppr, newEngineHasEditor };
    })()`);
    assert.equal(addedBlock.engineFields, true);
    assert.equal(addedBlock.newEngineHasEditor, true);
    assert.equal(addedBlock.sne, "600");
    assert.equal(addedBlock.ppr, "0");
    assert.match(addedBlock.history, /До ремонта: СНЭ 10:00/);
    assert.doesNotMatch(addedBlock.history, /ППР/);
    results.addEngineForm = "ok";
    await evaluate(`document.querySelector('[data-aircraft-tab="least-reliable"]').click()`);

    const limitedResource = await evaluate(`(() => {
      document.querySelector('[data-action="add-resource"]').click();
      const form = document.querySelector('#resource-form');
      form.elements.object.value = "Гидронасос";
      form.elements.name.value = "Назначенный ресурс";
      form.elements.limit.value = "100";
      form.elements.remaining.value = "5";
      form.requestSubmit();
      const saved = JSON.parse(localStorage.getItem('aviation-resource-prototype-v1'));
      const plane = saved.aircraft.find((item) => item.boardNumber === "42");
      return {
        h1: document.querySelector('h1')?.textContent,
        resource: plane.resources.find((item) => item.object === "Гидронасос"),
        block: plane.blocks.find((item) => item.name === "Гидронасос")
      };
    })()`);
    assert.equal(limitedResource.h1, "Назначенный ресурс");
    assert.equal(limitedResource.resource.limit, 100);
    assert.equal(limitedResource.resource.remaining, 5);
    assert.equal(limitedResource.resource.status, "danger");
    assert.equal(limitedResource.block.caption, "Агрегат с ограниченным ресурсом");
    results.limitedResourceCard = "ok";
    const extension = await evaluate(`(() => {
      const form = document.querySelector('#extension-form');
      form.elements.limit.value = '120';
      form.elements.basis.value = 'Решение изготовителя';
      form.elements.documentNumber.value = '42-А';
      form.elements.documentDate.value = '2026-01-01';
      form.requestSubmit();
      const saved = JSON.parse(localStorage.getItem('aviation-resource-prototype-v1'));
      const item = saved.aircraft.find(plane => plane.boardNumber === '42').resources.find(resource => resource.object === 'Гидронасос');
      return { limit: item.limit, remaining: item.remaining, document: item.history[0].documentNumber,
        visibleHistory: Boolean(document.querySelector('details.resource-row')) };
    })()`);
    assert.deepEqual(extension, { limit: 120, remaining: 25, document: "42-А", visibleHistory: true });
    results.resourceExtension = "ok";

    await evaluate(`document.querySelector('[data-action="back"]').click()`);
    const filteredSort = await evaluate(`(() => {
      document.querySelector('[data-view="resources"]').click();
      const search = document.querySelector('#resource-search');
      search.value = 'не найдено';
      search.dispatchEvent(new Event('input'));
      document.querySelector('[data-sort="installed"]').click();
      const excluded = document.querySelectorAll('#resource-list [data-resource-id]').length;
      search.value = 'гидронасос';
      search.dispatchEvent(new Event('input'));
      const included = document.querySelectorAll('#resource-list [data-resource-id]').length;
      document.querySelector('[data-action="back"]').click();
      return { excluded, included };
    })()`);
    assert.deepEqual(filteredSort, { excluded: 0, included: 1 });
    results.resourceSearchAndSort = "ok";
    const workSeparation = await evaluate(`(() => {
      document.querySelector('[data-aircraft-tab="works"]').click();
      const showsResource = document.querySelector('.aircraft-tab-panel').textContent.includes('Гидронасос');
      document.querySelector('[data-work="true"]').click();
      const form = document.querySelector('#resource-form');
      const category = form.elements.notificationCategory.value;
      form.elements.object.value = 'Гидронасос';
      form.elements.name.value = 'Проверка давления';
      form.elements.limit.value = '50';
      form.elements.remaining.value = '10';
      form.elements.unit.value = 'дн.';
      form.elements.notificationCategory.value = 'workDate';
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + 5);
      form.elements.expiryDate.value = new Date(expiry.getTime() - expiry.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      form.requestSubmit();
      const stored = JSON.parse(localStorage.getItem('aviation-resource-prototype-v1'));
      const remaining = stored.aircraft.find(item => item.boardNumber === '42').resources.find(item => item.name === 'Проверка давления').remaining;
      document.querySelector('[data-action="back"]').click();
      const showsWork = document.querySelector('.aircraft-tab-panel').textContent.includes('Проверка давления');
      document.querySelector('[data-aircraft-tab="least-reliable"]').click();
      const workInResources = document.querySelector('.aircraft-tab-panel').textContent.includes('Проверка давления');
      return { showsResource, category, showsWork, workInResources, remaining };
    })()`);
    assert.deepEqual(workSeparation, { showsResource: false, category: "workUsage", showsWork: true, workInResources: false, remaining: 5 });
    results.workSeparation = "ok";

    const lifecycleEvent = await evaluate(`(() => {
      document.querySelector('[data-aircraft-tab="aggregates"]').click();
      [...document.querySelectorAll('[data-block-id]')].find((item) => item.textContent.includes('Гидронасос')).click();
      const eventForm = document.querySelector('#block-event-form');
      eventForm.elements.type.value = 'repair';
      eventForm.elements.note.value = 'Акт ремонта № 1';
      eventForm.requestSubmit();
      const saved = JSON.parse(localStorage.getItem('aviation-resource-prototype-v1'));
      const block = saved.aircraft.find((item) => item.boardNumber === '42').blocks.find((item) => item.name === 'Гидронасос');
      const historyText = document.querySelector('[data-form-widget^="event:"]')?.textContent;
      document.querySelector('#edit-form-layout').click();
      const newUnitHasEditor = Boolean(document.querySelector('[data-gesture=move]'));
      window.handleAndroidBack();
      return { events: block.events.length, repairs: block.repairs, historyText, newUnitHasEditor };
    })()`);
    assert.equal(lifecycleEvent.events, 1);
    assert.equal(lifecycleEvent.repairs, 1);
    assert.equal(lifecycleEvent.newUnitHasEditor, true);
    assert.match(lifecycleEvent.historyText, /Ремонт/);
    results.aggregateLifecycle = "ok";

    await evaluate(`document.querySelector('[data-action="back"]').click()`);

    const aircraftSettings = await evaluate(`(() => {
      document.querySelector('[data-action="settings"]').click();
      const toggle = document.querySelector('#aircraft-notifications');
      return { h1: document.querySelector("h1")?.textContent, checked: toggle.checked, disabled: toggle.disabled };
    })()`);
    assert.deepEqual(aircraftSettings, { h1: "Настройки самолёта", checked: false, disabled: true });
    results.aircraftSettings = "ok";

    const shift = await evaluate(`(() => {
      document.querySelector('[data-action="back"]').click();
      document.querySelector('[data-aircraft-tab="works"]').click();
      document.querySelector('[data-view="shift"]').click();
      const inputs = document.querySelector('#shift-form');
      inputs.elements.flightHours.value = '1';
      inputs.elements.leftGround.value = '13';
      inputs.elements.rightGround.value = '13';
      inputs.elements.leftGround.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        h1: document.querySelector("h1")?.textContent,
        left: document.querySelector('#left-calculation')?.textContent,
        summary: document.querySelector('#shift-summary')?.textContent,
        hooks: Boolean(document.querySelector('[name="arresterHooks"]')),
        starts: Boolean(document.querySelector('[name="leftStarts"]')),
        separateModes: Boolean(document.querySelector('[name="leftCombinedMode"]') && document.querySelector('[name="rightCombinedMode"]'))
      };
    })()`);
    assert.equal(shift.h1, "Новая запись работы");
    assert.match(shift.left, /13 → 15 мин → 20% = 3 мин/);
    assert.match(shift.summary, /Левый: 1:03 · Правый: 1:03/);
    assert.equal(shift.hooks && shift.starts && shift.separateModes, true);
    results.shiftCalculation = "ok";

    const allAircraftRows = await evaluate(`(() => {
      document.querySelector('[data-action="back"]').click();
      document.querySelector('[data-action="back"]').click();
      document.querySelector('[data-action="settings"]').click();
      return {
        h1: document.querySelector("h1")?.textContent,
        rows: document.querySelectorAll('[data-aircraft-notification-id]').length,
        labels: [...document.querySelectorAll('[data-aircraft-notification-id]')].map((input) => input.closest('label').querySelector('strong').textContent)
      };
    })()`);
    assert.equal(allAircraftRows.h1, "Настройки");
    assert.equal(allAircraftRows.rows, 2);
    assert.ok(allAircraftRows.labels.some((label) => label.includes("борт 85")));
    assert.ok(allAircraftRows.labels.some((label) => label.includes("борт 42")));
    results.allAircraftNotificationRows = "ok";
    const masterOn = await evaluate(`(() => {
      const master = document.querySelector('#global-notifications');
      master.checked = true;
      master.dispatchEvent(new Event('change', { bubbles: true }));
      return [...document.querySelectorAll('[data-aircraft-notification-id]')].every(input => input.checked && !input.disabled);
    })()`);
    assert.equal(masterOn, true);
    results.masterOn = "ok";
    const typeSettings = await evaluate(`(async () => {
      document.querySelector('[data-action="back"]').click();
      document.querySelector('[data-action="settings"]').click();
      document.querySelector('[data-view="usage-settings"]').click();
      const type = document.querySelector('#usage-aircraft-type');
      type.value = 'МиГ-29';
      type.dispatchEvent(new Event('change'));
      const rules = document.querySelector('#usage-settings-form');
      rules.elements.runwayFactor.value = '2.5';
      rules.elements.existingSource.value = 'touch';
      document.querySelector('#type-add-source-button').click();
      document.querySelector('[data-disable-source="touch"]').click();
      const hidesOptional = !rules.elements.touchFactor;
      rules.elements.existingSource.value = 'touch';
      rules.elements.existingSource.dispatchEvent(new Event('change'));
      const category = rules.querySelector('[data-source-kind]');
      category.value = 'time';
      category.dispatchEvent(new Event('change'));
      const fixedCategory = category.value === 'count' && document.querySelector('.toast').textContent.includes('идентификатор подсчёта количества');
      const touchFactor = rules.querySelector('[data-source-factor]');
      touchFactor.value = '0.75';
      touchFactor.dispatchEvent(new Event('input'));
      document.querySelector('#type-add-source-button').click();
      rules.elements.newSource.value = 'Осмотры';
      document.querySelector('#type-add-source-button').click();
      const customCard = [...rules.querySelectorAll('.usage-source-card')].find(card => card.getAttribute('aria-label') === 'Осмотры');
      const customKind = customCard.querySelector('[data-usage-kind]');
      customKind.value = 'time';
      customKind.dispatchEvent(new Event('change', { bubbles: true }));
      customCard.querySelector('.usage-time-format select').value = 'seconds';
      rules.elements.newSource.value = 'Проверка времени';
      const kind = rules.querySelector('[data-source-kind]');
      kind.value = 'time';
      kind.dispatchEvent(new Event('change'));
      const timeFactor = rules.querySelector('[data-source-factor]');
      timeFactor.value = '0.5';
      timeFactor.dispatchEvent(new Event('input'));
      document.querySelector('#type-add-source-button').click();
      rules.requestSubmit();
      window.handleAndroidBack();
      document.querySelector('[data-view="aircraft-types"]').click();
      const archive = async (label) => {
        [...document.querySelectorAll('[data-archive-type]')].find(button => button.parentElement.querySelector('strong').textContent === label).click();
        const dialog = document.querySelector('dialog[open]');
        await new Promise(resolve => {
          dialog.addEventListener('close', resolve, { once: true });
          dialog.querySelector('[value="archive"]').click();
        });
      };
      await archive('МиГ-29');
      const read = () => JSON.parse(localStorage.getItem('aviation-resource-prototype-v1'));
      const archived = read().archivedAircraftTypes.includes('миг-29') && read().aircraft.find(item => item.boardNumber === '42').type === 'МиГ-29';
      window.handleAndroidBack();
      window.handleAndroidBack();
      document.querySelector('[data-action="add-aircraft"]').click();
      const omitted = ![...document.querySelector('#creation-form select[name="type"]').options].some(option => option.value === 'МиГ-29');
      document.querySelector('[data-action="back"]').click();
      document.querySelector('[data-action="settings"]').click();
      document.querySelector('[data-view="aircraft-types"]').click();
      const remainingType = document.querySelector('[data-archive-type]').parentElement.querySelector('strong').textContent;
      await archive(remainingType);
      window.handleAndroidBack();
      document.querySelector('[data-view="usage-settings"]').click();
      const emptyState = document.querySelector('main').textContent.includes('Создать тип самолёта для того, чтобы выбрать наработки для этого типа самолёта') &&
        !document.querySelector('#usage-aircraft-type, #aircraft-type-form, #aircraft-type-trash');
      window.handleAndroidBack();
      document.querySelector('[data-view="aircraft-types"]').click();
      document.querySelector('[data-restore-type]').click();
      document.querySelector('[data-restore-type]').click();
      document.querySelector('[data-action="back"]').click();
      document.querySelector('[data-action="back"]').click();
      document.querySelector('[data-action="add-aircraft"]').click();
      const form = document.querySelector('#creation-form');
      form.elements.type.value = 'МиГ-29';
      form.elements.type.dispatchEvent(new Event('change'));
      const inherited = document.querySelector('#creation-usage').textContent.includes('Осмотры') &&
        Boolean(document.querySelector('[data-creation-hide-source="touch"]')) && !document.querySelector('[data-creation-hide-source="arresterHooks"]');
      form.elements.boardNumber.value = '43';
      form.requestSubmit();
      document.querySelector('[data-view="shift"]').click();
      const runway = document.querySelector('#shift-form [name="runway"]');
      runway.value = '2';
      runway.form.elements.touch.value = '1';
      runway.dispatchEvent(new Event('input', { bubbles: true }));
      const applies = document.querySelector('#shift-summary').textContent.includes('Зачёт посадок: 5,75');
      window.handleAndroidBack();
      const profile = read().usageTypeOverrides.find(entry => entry.type === 'миг-29');
      const editedCategory = profile.customSources.some(source => source.label === 'Осмотры' && source.kind === 'time' && source.format === 'seconds');
      return { archived, omitted, inherited, applies, hidesOptional, emptyState, fixedCategory, editedCategory, template: profile.factors.runway,
        restored: !read().archivedAircraftTypes.includes('миг-29'), newAircraft: read().aircraft.find(item => item.boardNumber === '43').type };
    })()`);
    assert.deepEqual(typeSettings, { archived: true, omitted: true, inherited: true, applies: true, hidesOptional: true, emptyState: true, fixedCategory: true, editedCategory: true,
      template: 2.5, restored: true, newAircraft: "МиГ-29" });
    results.typeSettings = "ok";
    const savedUsageName = await evaluate(`(async () => {
      document.querySelector('[data-action="back"]').click();
      document.querySelector('[data-action="settings"]').click();
      document.querySelector('[data-view="usage-settings"]').click();
      document.querySelector('#usage-settings-form').elements.flightLabel.value = 'Полётное время';
      window.handleAndroidBack();
      const dialog = document.querySelector('dialog[open]');
      await new Promise(resolve => {
        dialog.addEventListener('close', resolve, { once: true });
        dialog.querySelector('[value="save"]').click();
      });
      document.querySelector('[data-view="usage-settings"]').click();
      return document.querySelector('#usage-settings-form').elements.flightLabel.value;
    })()`);
    assert.equal(savedUsageName, "Полётное время");
    results.usageSettingsBackSave = "ok";
    const namedUsage = await evaluate(`(() => {
      const type = document.querySelector('#usage-aircraft-type').value;
      let form = document.querySelector('#usage-settings-form');
      form.elements.flightKind.value = 'count';
      form.elements.flightKind.dispatchEvent(new Event('change', { bubbles: true }));
      const renamedCounter = form.elements.flightLabel.value === 'Полётное время' && form.elements.flightKind.value === 'time' &&
        document.querySelector('.toast').textContent.includes('идентификатор подсчёта времени');
      const wasOff = !form.elements.touchFactor && [...form.elements.existingSource.options].some(option => option.value === 'touch');
      form.elements.newSource.value = ' КАСАНИЯ ';
      document.querySelector('#type-add-source-button').click();
      const addedByName = Boolean(form.elements.touchFactor);
      document.querySelector('[data-disable-source="touch"]').click();
      form.elements.newSource.value = 'касание';
      form.requestSubmit();
      form = document.querySelector('#usage-settings-form');
      const enabled = Boolean(form.elements.touchFactor);
      form.elements.newSource.value = 'Касания';
      document.querySelector('#type-add-source-button').click();
      const blocksDuplicate = document.querySelector('.toast')?.textContent.includes('уже включён для выбранного типа');
      form.elements.newSource.value = '';
      const storage = JSON.parse(localStorage.getItem('aviation-resource-prototype-v1'));
      const profile = storage.usageTypeOverrides.find(row => row.type === type.toLowerCase());
      const reused = profile.enabled.touch && !profile.customSources.some(item => /касани/i.test(item.label));
      window.handleAndroidBack();
      window.handleAndroidBack();
      document.querySelector('[data-aircraft-id]').click();
      document.querySelector('[data-view="shift"]').click();
      const work = document.querySelector('#shift-form');
      work.elements.touch.value = '1';
      work.elements.touch.dispatchEvent(new Event('input', { bubbles: true }));
      const appearsInWork = work.querySelectorAll('[name="touch"]').length === 1 &&
        document.querySelector('#shift-summary').textContent.includes('Зачёт посадок: 0,6');
      window.handleAndroidBack();
      window.handleAndroidBack();
      document.querySelector('[data-action="settings"]').click();
      document.querySelector('[data-view="usage-settings"]').click();
      return { type, wasOff, addedByName, enabled, blocksDuplicate, reused, appearsInWork, renamedCounter };
    })()`);
    assert.deepEqual(namedUsage, { type: "Су-33", wasOff: true, addedByName: true, enabled: true, blocksDuplicate: true, reused: true, appearsInWork: true, renamedCounter: true });
    results.usageSourceByName = "ok";
    const layoutResult = await evaluate(`(async () => {
      window.handleAndroidBack();
      window.handleAndroidBack();
      document.querySelector('[data-aircraft-id]').click();
      const hold = async (target) => {
        target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [new Touch({ identifier: 1, target, clientX: 20, clientY: 20 })] }));
        if (target.dispatchEvent(new Event('selectstart', { bubbles: true, cancelable: true }))) throw new Error('Включилось выделение текста');
        await new Promise(resolve => setTimeout(resolve, 900));
        if (!target.closest('.counter-tile').classList.contains('counter-tile-active')) throw new Error('Плитка не выделилась при удержании');
        target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));
      };
      await hold(document.querySelector('[data-view="shift"]'));
      const baseCount = document.querySelectorAll('.counter-tile').length;
      const selectedAction = Boolean(document.querySelector('.counter-tile-active [data-view="shift"]'));
      document.querySelector('[data-tile-key="flightSne"] [data-layout-action="split"]').click();
      document.querySelector('[data-layout-action="right"][data-index="1"]').click();
      document.querySelector('[data-layout-action="merge"]').click();
      document.querySelector('[data-layout-action="size"][data-index="1"]').click();
      const count = document.querySelectorAll('.counter-tile').length - baseCount;
      window.handleAndroidBack();
      let dialog = document.querySelector('dialog[open]');
      await new Promise(resolve => {
        dialog.addEventListener('close', resolve, { once: true });
        dialog.querySelector('[value="save"]').click();
      });
      const tile = document.querySelector('.counter-tile:nth-child(2)');
      const persisted = tile.getBoundingClientRect().width < tile.parentElement.clientWidth &&
        JSON.parse(localStorage.getItem('aviation-resource-prototype-v1')).aircraft[0].boardLayouts.aggregates[0].span === 6;
      await hold(document.querySelector('[data-block-id]'));
      document.querySelector('.counter-tile-active [data-layout-action="edit"]').click();
      dialog = document.querySelector('dialog[open]');
      dialog.querySelector('input').value = 'Планер · моя подпись';
      await new Promise(resolve => {
        dialog.addEventListener('close', resolve, { once: true });
        dialog.querySelector('[value="save"]').click();
      });
      document.querySelector('#layout-default').click();
      dialog = document.querySelector('dialog[open]');
      await new Promise(resolve => {
        dialog.addEventListener('close', resolve, { once: true });
        dialog.querySelector('[value="reset"]').click();
      });
      document.querySelector('#layout-save').click();
      const saved = JSON.parse(localStorage.getItem('aviation-resource-prototype-v1')).aircraft[0];
      const captionOnly = document.querySelector('[data-block-id]').textContent.includes('Планер · моя подпись') &&
        saved.blocks[0].name === 'Формуляр самолёта' && !document.querySelector('[data-action="edit-blocks"]');
      return { count, persisted, selectedAction, captionOnly, restored: document.querySelectorAll('.counter-tile').length === baseCount &&
        JSON.parse(localStorage.getItem('aviation-resource-prototype-v1')).aircraft[0].boardLayouts.aggregates[0].span === 6 };
    })()`);
    assert.deepEqual(layoutResult, { count: 0, persisted: true, selectedAction: true, captionOnly: true, restored: true });
    results.aircraftLayout = "ok";
    const liveReflow = await evaluate(`(async () => {
      const source = document.querySelector('[data-tile-key="widget:board-tabs"] .aircraft-tab');
      const identifiers = document.querySelector('.board-identifiers');
      const [serial, rf] = identifiers.children;
      const numbersInOneRow = serial.textContent.includes('49051002905') && rf.textContent === 'RF 33738' &&
        Math.abs(serial.getBoundingClientRect().top - rf.getBoundingClientRect().top) < 1 &&
        serial.getBoundingClientRect().left < rf.getBoundingClientRect().left;
      source.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [new Touch({ identifier: 1, target: source })] }));
      await new Promise(resolve => setTimeout(resolve, 900));
      source.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));
      document.querySelector('[data-gesture="move"]').click();
      const [first, second] = document.querySelectorAll('#counter-preview .counter-tile');
      const dragTarget = first.querySelector('.counter-value');
      first.scrollIntoView({ block: 'center' });
      const a = first.getBoundingClientRect();
      const b = second.getBoundingClientRect();
      const touch = (x, y) => new Touch({ identifier: 2, target: dragTarget, clientX: x, clientY: y });
      dragTarget.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(a.left + 20, a.top + 10)] }));
      dragTarget.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [touch(b.left + 20, b.top + 10)] }));
      await new Promise(resolve => setTimeout(resolve, 180));
      const movedBeforeRelease = second.getBoundingClientRect().top < b.top;
      dragTarget.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, changedTouches: [touch(b.left + 20, b.top + 10)] }));
      document.querySelector('[data-gesture="font"]').click();
      const active = document.querySelector('.counter-tile-active');
      const value = active.querySelector('.counter-value');
      const finger = (y) => new Touch({ identifier: 3, target: value, clientX: 40, clientY: y });
      value.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [finger(400)] }));
      value.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [finger(391)] }));
      const fontGrowsInline = active.style.getPropertyValue('--tile-font') === '1.03rem' && !document.querySelector('dialog[open]');
      value.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [finger(391)] }));
      document.querySelector('#counter-font-reset').click();
      const fontReset = document.querySelector('.counter-tile-active').style.getPropertyValue('--tile-font') === '1rem';
      const toolbar = document.querySelector('.counter-gesture-toolbar').getBoundingClientRect();
      const toolbarFits = toolbar.left >= 0 && toolbar.right <= innerWidth;
      document.querySelector('[data-gesture="resize"]').click();
      const tile = document.querySelector('.counter-tile-active');
      const content = tile.querySelector('.counter-value');
      const before = tile.getBoundingClientRect();
      const dragSize = (x) => new Touch({ identifier: 4, target: content, clientX: x, clientY: 400 });
      content.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [dragSize(180)] }));
      content.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [dragSize(171)] }));
      const after = tile.getBoundingClientRect();
      const gentleResize = before.width - after.width > 0 && before.width - after.width <= 14 && Math.abs(before.left - after.left) <= 1;
      content.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [dragSize(171)] }));
      document.querySelector('#layout-save').click();
      const savedTabPosition = JSON.parse(localStorage.getItem('aviation-resource-prototype-v1')).aircraft[0].boardNavigationLayout[0].index;
      document.querySelector('[data-aircraft-tab="works"]').click();
      const tabsStillWork = document.querySelector('[data-aircraft-tab="works"]').getAttribute('aria-selected') === 'true' &&
        document.querySelectorAll('.counter-tile')[savedTabPosition].dataset.tileKey === 'widget:board-tabs';
      const tab = document.querySelector('[data-aircraft-tab="works"]');
      tab.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [new Touch({ identifier: 5, target: tab })] }));
      await new Promise(resolve => setTimeout(resolve, 900));
      tab.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));
      document.querySelector('#layout-group').click();
      const splitTabs = new Set([...document.querySelectorAll('[data-aircraft-tab]')].map(button => button.closest('.counter-tile'))).size === 3;
      document.querySelector('#layout-save').click();
      document.querySelector('[data-aircraft-tab="aggregates"]').click();
      const splitPersisted = new Set([...document.querySelectorAll('[data-aircraft-tab]')].map(button => button.closest('.counter-tile'))).size === 3;
      return { movedBeforeRelease, fontGrowsInline, fontReset, toolbarFits, gentleResize, tabsStillWork, numbersInOneRow, splitTabs, splitPersisted };
    })()`);
    assert.deepEqual(liveReflow, { movedBeforeRelease: true, fontGrowsInline: true, fontReset: true, toolbarFits: true, gentleResize: true, tabsStillWork: true, numbersInOneRow: true, splitTabs: true, splitPersisted: true });
    results.liveTileReflow = "ok";
    const journal = await evaluate(`(() => {
      window.handleAndroidBack();
      document.querySelector('[data-action="settings"]').click();
      document.querySelector('[data-view="diagnostics"]').click();
      return document.querySelector('#diagnostic-text').value;
    })()`);
    assert.match(journal, /layout\.hold\.ready/);
    assert.match(journal, /layout\.open\.ok toolbar=true/);
    assert.match(journal, /layout\.save\.ok/);
    assert.doesNotMatch(journal, /Су-33|49051002905|742:18/);
    results.diagnosticJournal = "ok";
    const boardImage = await evaluate(`(async () => {
      window.handleAndroidBack();
      window.handleAndroidBack();
      document.querySelector('.aircraft-card-menu summary').click();
      document.querySelector('[data-board-menu="board-details"]').click();
      const details = document.querySelector('#board-details-form');
      details.elements.rfNumber.value = 'RF 33739';
      details.requestSubmit();
      document.querySelector('[data-aircraft-id]').click();
      const updatedRF = document.querySelector('.board-identifiers')?.textContent.includes('RF 33739');
      document.querySelector('[data-block-id="airframe"]').click();
      const airframeSections = !document.querySelector('#block-form [name="model"], #block-form [name="drawingNumber"]') &&
        document.querySelector('#block-form [name=rfNumber]')?.value === '33739' &&
        document.querySelector('#block-form [name=serialNumber]')?.value === '49051002905' &&
        [...document.querySelectorAll('h2')].some(item => item.textContent === 'Установленные агрегаты');
      window.handleAndroidBack();
      window.handleAndroidBack();
      document.querySelector('.aircraft-card-menu summary').click();
      document.querySelector('[data-board-menu="board-image"]').click();
      const form = document.querySelector('#board-image-form');
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], 'emblem.png', { type: 'image/png' }));
      form.elements.picture.files = transfer.files;
      form.elements.picture.dispatchEvent(new Event('change'));
      const preview = document.querySelector('#board-image-preview');
      for (let i = 0; i < 50 && !preview.querySelector('img')?.naturalWidth; i++) await new Promise(resolve => setTimeout(resolve, 20));
      const previewWidth = preview.querySelector('img')?.naturalWidth;
      form.elements.fit.value = 'contain';
      form.requestSubmit();
      window.handleAndroidBack();
      return { previewWidth, updatedRF, airframeSections, shownOnMain: Boolean(document.querySelector('.aircraft-card .board-image-contain')) };
    })()`);
    assert.deepEqual(boardImage, { previewWidth: 320, updatedRF: true, airframeSections: true, shownOnMain: true });
    results.boardImage = "ok";

    const repairUsage = await evaluate(`(() => {
      const read = () => JSON.parse(localStorage.getItem('aviation-resource-prototype-v1')).aircraft.find(board => board.boardNumber === '42');
      document.querySelector('[data-aircraft-id="' + read().id + '"]').click();
      const engine = board => board.blocks.find(block => block.id === 'engine-left');
      const repair = id => {
        document.querySelector('[data-aircraft-tab="aggregates"]').click();
        document.querySelector('[data-block-id="' + id + '"]').click();
        document.querySelector('#block-event-form').requestSubmit();
        window.handleAndroidBack();
      };
      document.querySelector('[data-aircraft-tab="aggregates"]').click();
      document.querySelector('[data-block-id="engine-left"]').click();
      const initialPpr = document.querySelector('#block-form [name="pprMinutes"]');
      const emptyBeforeRepair = initialPpr.disabled && initialPpr.value === '';
      window.handleAndroidBack();
      repair('airframe');
      repair('engine-left');
      const before = read();
      document.querySelector('[data-aircraft-tab="works"]').click();
      document.querySelector('[data-view="shift"]').click();
      const form = document.querySelector('#shift-form');
      form.elements.flightHours.value = '1';
      form.elements.flightMinutes.value = '0';
      form.elements.leftGround.value = '13';
      form.elements.runway.value = '1';
      form.elements.leftMaximum.value = '21';
      form.elements.leftAfterburner.value = '7';
      form.elements.extraEngine0Ground.value = '13';
      form.elements.extraEngine0Afterburner.value = '9';
      form.requestSubmit();
      const after = read();
      repair('engine-left');
      const reset = engine(read());
      const unit = board => board.blocks.find(block => block.name === 'Гидронасос');
      return {
        emptyBeforeRepair,
        airframePpr: after.pprFlightMinutes,
        airframeLandings: after.pprLandings,
        enginePpr: engine(after).pprMinutes,
        engineSneAdded: engine(after).sneMinutes - (engine(before).sneMinutes || 0),
        enginePprLandings: engine(after).pprLandings,
        afterburner: engine(after).pprAfterburnerSeconds,
        maximum: engine(after).pprMaximumSeconds,
        extraEngine: after.shifts.at(-1).otherEngines.map(entry => [entry.minutes, entry.afterburnerSeconds]),
        unitPprAdded: unit(after).pprMinutes - unit(before).pprMinutes,
        resetPpr: reset.pprMinutes,
        resetModes: [reset.pprMaximumSeconds, reset.pprAfterburnerSeconds],
        keepsSne: reset.sneMinutes === engine(after).sneMinutes,
        previousPpr: reset.events.at(-1).beforeRepair.pprMinutes,
      };
    })()`);
    assert.deepEqual(repairUsage, {
      emptyBeforeRepair: true, airframePpr: 60, airframeLandings: 1, enginePpr: 63,
      engineSneAdded: 63, enginePprLandings: 1, afterburner: 7, maximum: 21,
      extraEngine: [[63, 9]], unitPprAdded: 60, resetPpr: 0, resetModes: [0, 0], keepsSne: true, previousPpr: 63,
    });
    results.repairUsage = "ok";

    const routing = await evaluate(`(() => {
      const read = () => JSON.parse(localStorage.getItem('aviation-resource-prototype-v1')).aircraft.find(board => board.boardNumber === '42');
      const click = selector => document.querySelector(selector).click();
      const openBlock = name => [...document.querySelectorAll('.aircraft-tab-panel [data-block-id]')].find(item => item.textContent.includes(name)).click();
      const submit = selector => document.querySelector(selector).requestSubmit();
      click('[data-action="settings"]');
      click('[data-view="board-usage"]');
      document.querySelector('#board-usage-form [value="arresterHooks"]').checked = false;
      submit('#board-usage-form');
      window.handleAndroidBack();
      window.handleAndroidBack();
      click('[data-aircraft-tab="aggregates"]');
      click('[data-action="add-block"]');
      const blockForm = document.querySelector('#creation-form');
      blockForm.elements.name.value = 'ГАК';
      blockForm.elements.serialNumber.value = 'G-456';
      submit('#creation-form');
      openBlock('ГАК');
      click('[data-action="add-resource"]');
      const resource = document.querySelector('#resource-form');
      resource.elements.name.value = 'Ресурс по зацепам';
      resource.elements.limit.value = '50';
      resource.elements.remaining.value = '50';
      resource.elements.unit.value = 'пос.';
      resource.elements.unit.dispatchEvent(new Event('change'));
      document.querySelector('#resource-source-choice').value = 'arresterHooks';
      click('#resource-source-add');
      document.querySelector('[data-source="arresterHooks"]').value = '2';
      submit('#resource-form');
      window.handleAndroidBack();
      click('[data-view="correct-usage"]');
      const correction = document.querySelector('#correct-usage-form');
      correction.elements.repairs.value = '2';
      correction.elements.repairs.dispatchEvent(new Event('input'));
      correction.elements.sneMinutes.value = '420';
      correction.elements.pprMinutes.value = '60';
      submit('#correct-usage-form');
      const historical = document.querySelector('#historical-repair-form');
      historical.elements.number.value = '2';
      historical.elements.sneMinutes.value = '360';
      historical.elements.sneLandings.value = '48';
      submit('#historical-repair-form');
      window.handleAndroidBack();
      window.handleAndroidBack();
      click('[data-view="usage-map"]');
      const block = read().blocks.find(item => item.name === 'ГАК');
      click('[data-map-select="' + block.id + '"]');
      const map = document.querySelector('#map-details').textContent.includes('× 2');
      const connected = document.querySelector('[data-map-target="' + block.id + '"]').classList.contains('map-node--linked');
      const pump = read().blocks.find(item => item.name === 'ВКА');
      click('[data-map-select="' + pump.id + '"]');
      const unlinkedWithCounters = document.querySelector('[data-map-target="' + pump.id + '"]').classList.contains('map-node--unlinked') &&
        document.querySelector('#map-details').textContent.includes('Счётчик формуляра') &&
        !document.querySelector('#map-details').textContent.includes('Списание ресурса');
      window.handleAndroidBack();
      click('[data-aircraft-tab="aggregates"]');
      openBlock('Правый двигатель');
      const engineForm = document.querySelector('#block-form');
      engineForm.elements.groundPercent.value = '40';
      submit('#block-form');
      window.handleAndroidBack();
      openBlock('Гидронасос');
      click('[data-action="add-resource"]');
      const copyFrom = document.querySelector('#resource-copy-from');
      copyFrom.value = read().resources.find(item => item.object === 'ГАК').id;
      click('#resource-copy-limit');
      click('#resource-copy-inputs');
      const copied = document.querySelector('#resource-form').elements.limit.value === '50' &&
        document.querySelector('[data-source="arresterHooks"]').value === '2';
      window.handleAndroidBack();
      click('[data-view="block-usage-rules"]');
      click('[data-aggregate-rule-add]');
      document.querySelector('[data-rule="name"]').value = 'Проверки гидронасоса';
      document.querySelector('[data-rule="factor"]').value = '0.5';
      document.querySelector('[data-rule="sne"]').value = '5';
      submit('#aggregate-rules-form');
      window.handleAndroidBack();
      click('[data-view="shift"]');
      const form = document.querySelector('#shift-form');
      form.elements.flightHours.value = '1';
      form.elements.arresterHooks.value = '1';
      form.elements.rightFlight.value = '30';
      form.elements.rightGround.value = '13';
      form.elements.operationType.value = '2';
      form.querySelector('[data-aggregate-manual] input').value = '8';
      form.elements.arresterHooks.dispatchEvent(new Event('input', { bubbles: true }));
      const preview = document.querySelector('#shift-summary').textContent.includes('Расход 2');
      submit('#shift-form');
      click('[data-aircraft-tab="works"]');
      click('[data-shift-id]');
      click('[data-view="correct-shift"]');
      const revise = document.querySelector('#shift-form');
      const manualInput = revise.querySelector('[data-aggregate-manual] input');
      const previousManual = manualInput.value;
      manualInput.value = '6';
      revise.elements.arresterHooks.value = '2';
      submit('#shift-form');
      const board = read();
      const shift = board.shifts.at(-1);
      const saved = board.resources.find(item => item.object === 'ГАК');
      const hook = board.blocks.find(item => item.name === 'ГАК');
      const pumpAfterWork = board.blocks.find(item => item.name === 'Гидронасос');
      const manualRevised = previousManual === '8' && pumpAfterWork.usageTotals[pumpAfterWork.usageCounters[0].id].sne === 8 &&
        shift.aggregateAccruals[0].amount === 3 && shift.revisions[0].aggregateAccruals[0].amount === 4;
      return { map, connected, unlinkedWithCounters, preview, copied, amount: shift.accruals.find(item => item.resourceId === saved.id).amount,
        remaining: saved.remaining, previous: shift.revisions[0].raw.arresterHooks, kind: shift.operationLabel,
        rightFlight: shift.engineAccruals.find(item => item.blockId === 'engine-right').flightMinutes,
        rightTotal: shift.engineAccruals.find(item => item.blockId === 'engine-right').minutes,
        historyBeforeRepair: hook.historicalRepairs[2].beforeRepair.sneMinutes, repairs: hook.repairs,
        hookPpr: hook.pprMinutes, manualRevised };
    })()`);
    assert.deepEqual(routing, { map: true, connected: true, unlinkedWithCounters: true, preview: true, copied: true, amount: 4, remaining: 46, previous: '1',
      kind: 'Руление', rightFlight: 30, rightTotal: 36, historyBeforeRepair: 360, repairs: 2, hookPpr: 120, manualRevised: true });
    results.resourceRouting = "ok";

    const cardIntegrity = await evaluate(`(() => {
      const get = selector => {
        const element = document.querySelector(selector);
        if (!element) throw new Error('Элемент карточки отсутствует: ' + selector);
        return element;
      };
      const click = selector => get(selector).click();
      const submit = selector => get(selector).requestSubmit();
      const back = () => window.handleAndroidBack();
      const read = () => JSON.parse(localStorage.getItem('aviation-resource-prototype-v1')).aircraft.find(board => board.boardNumber === '42');
      const hook = read().blocks.find(block => block.name === 'ГАК');
      back();
      click('[data-aircraft-tab="aggregates"]');
      click('[data-block-id="' + hook.id + '"]');
      let form = get('#block-event-form');
      form.elements.type.value = 'install';
      submit('#block-event-form');
      form = get('#block-form');
      form.elements.installed.value = 'false';
      submit('#block-form');
      const manualDismantle = read().blocks.find(block => block.id === hook.id).events.at(-1).type === 'dismantle';
      back();
      click('[data-view="shift"]');
      get('#shift-form [name="arresterHooks"]').value = '2';
      get('#shift-form [name="arresterHooks"]').dispatchEvent(new Event('input', { bubbles: true }));
      const noAccrualAfterDismantle = !get('#shift-summary').textContent.includes('Ресурс по зацепам');
      submit('#shift-form');
      const noSavedAccrual = !read().shifts.at(-1).accruals.some(entry => entry.blockId === hook.id);
      click('[data-aircraft-tab="aggregates"]');
      click('[data-action="add-block"]');
      form = get('#creation-form');
      form.elements.name.value = 'ГАК';
      form.elements.serialNumber.value = 'G-457';
      submit('#creation-form');
      const other = read().blocks.find(block => block.serialNumber === 'G-457');
      click('[data-block-id="' + other.id + '"]');
      click('[data-action="add-resource"]');
      form = get('#resource-form');
      form.elements.name.value = 'Проверочный ресурс';
      form.elements.limit.value = '10';
      form.elements.remaining.value = '9.995';
      const selectsRightOwner = form.elements.ownerId.value === other.id;
      submit('#resource-form');
      const fractionalSave = read().resources.find(resource => resource.objectId === other.id)?.remaining === 9.995;
      back();
      back();
      click('[data-action="settings"]');
      const originalPrompt = window.prompt;
      try {
        window.prompt = () => 'ГАК второй';
        click('[data-rename-block-id="' + other.id + '"]');
      } finally { window.prompt = originalPrompt; }
      const board = read();
      const renameIsolated = board.resources.find(resource => resource.objectId === hook.id)?.object === 'ГАК' &&
        board.resources.find(resource => resource.objectId === other.id)?.object === 'ГАК второй';
      const search = get('#notification-work-search');
      search.value = 'Проверочный ресурс';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const notificationSearch = [...document.querySelectorAll('[data-notification-work]')]
        .filter(row => getComputedStyle(row).display !== 'none').length === 1;
      back();
      click('[data-view="resources"]');
      const resourceId = board.resources.find(resource => resource.objectId === other.id).id;
      click('[data-resource-id="' + resourceId + '"]');
      form = get('#resource-form');
      form.elements.unit.value = 'дн.';
      form.elements.unit.dispatchEvent(new Event('change'));
      const calendarHidesFormula = getComputedStyle(get('#resource-consumption')).display === 'none' && get('#resource-consumption').disabled;
      const originalConfirm = window.confirm;
      try {
        window.confirm = () => false;
        click('[data-action="delete-resource"]');
        if (!read().resources.some(resource => resource.id === resourceId)) throw new Error('Отмена удаления не сработала');
        window.confirm = () => true;
        click('[data-action="delete-resource"]');
      } finally { window.confirm = originalConfirm; }
      const resourceDeletion = !read().resources.some(resource => resource.id === resourceId) &&
        read().blocks.some(block => block.id === other.id) && Boolean(document.querySelector('#resource-list'));
      return { manualDismantle, noAccrualAfterDismantle, noSavedAccrual, selectsRightOwner, fractionalSave,
        renameIsolated, notificationSearch, calendarHidesFormula, resourceDeletion };
    })()`);
    assert.deepEqual(cardIntegrity, {
      manualDismantle: true, noAccrualAfterDismantle: true, noSavedAccrual: true, selectsRightOwner: true,
      fractionalSave: true, renameIsolated: true, notificationSearch: true, calendarHidesFormula: true, resourceDeletion: true,
    });
    results.cardIntegrity = "ok";

    const reportIntegrity = await evaluate(`(() => {
      const click = selector => {
        const element = document.querySelector(selector);
        if (!element) throw new Error('Не найдено: ' + selector);
        element.click();
      };
      const submit = selector => document.querySelector(selector).requestSubmit();
      const read = () => JSON.parse(localStorage.getItem('aviation-resource-prototype-v1')).aircraft.find(board => board.boardNumber === '42');
      const back = () => window.handleAndroidBack();
      back();
      click('[data-aircraft-tab="aggregates"]');
      click('[data-block-id="engine-left"]');
      document.querySelector('#block-form').elements.installed.value = 'false';
      submit('#block-form');
      back();
      click('[data-view="shift"]');
      const shift = document.querySelector('#shift-form');
      shift.elements.flightHours.value = '1';
      shift.elements.leftStarts.value = '3';
      shift.elements.leftGround.value = '13';
      shift.elements.leftGround.dispatchEvent(new Event('input', { bubbles: true }));
      const preview = document.querySelector('#left-calculation').textContent.includes('не установлен') &&
        document.querySelector('#shift-summary').textContent.includes('Левый: —');
      submit('#shift-form');
      const saved = read().shifts.at(-1);
      const totals = [saved.leftEngineMinutes, saved.leftStarts, saved.rightEngineMinutes];
      click('[data-aircraft-tab="works"]');
      click('[data-view="reports"]');
      click('[data-report-shift="' + saved.id + '"]');
      const reportEntry = !document.querySelector('main').textContent.includes('Левый двигатель') &&
        document.querySelector('main').textContent.includes('Правый двигатель');
      click('#open-shift-map');
      const zoom = document.querySelector('#map-scale');
      zoom.value = '65';
      zoom.dispatchEvent(new Event('input'));
      const mapZoom = Number(document.querySelector('.usage-map-canvas').style.zoom) === 0.65;
      back();
      back();
      const returnToReport = Boolean(document.querySelector('#report-form'));
      return { preview, totals, reportEntry, mapZoom, returnToReport };
    })()`);
    assert.deepEqual(reportIntegrity, { preview: true, totals: [0, 0, 60], reportEntry: true, mapZoom: true, returnToReport: true });
    results.reportIntegrity = "ok";

    const usageMeasures = await evaluate(`(() => {
      const click = selector => document.querySelector(selector).click();
      const read = () => JSON.parse(localStorage.getItem('aviation-resource-prototype-v1'));
      const board = () => read().aircraft.find(item => item.boardNumber === '42');
      const typeTime = read().usageTypeOverrides.find(row => row.type === 'миг-29').customSources.find(row => row.label === 'Проверка времени');
      window.handleAndroidBack();
      click('[data-aircraft-tab="aggregates"]');
      click('[data-block-id="vka"]');
      click('[data-action="add-resource"]');
      const resource = document.querySelector('#resource-form');
      resource.elements.name.value = 'Ресурс по времени';
      resource.elements.limit.value = '10';
      resource.elements.remaining.value = '10';
      document.querySelector('#resource-source-name').value = 'Время в секундах';
      const kind = resource.querySelector('[data-source-kind]');
      kind.value = 'time';
      kind.dispatchEvent(new Event('change'));
      resource.querySelector('[data-duration-format] select').value = 'seconds';
      const factor = resource.querySelector('[data-source-factor]');
      factor.value = '0.25';
      factor.dispatchEvent(new Event('input'));
      click('#resource-source-add');
      const secondTime = board().customUsageSources.find(row => row.label === 'Время в секундах');
      document.querySelector('[data-source="flight"]').value = '';
      document.querySelector('[data-source="' + typeTime.key + '"]').value = '2';
      document.querySelector('[data-source="' + secondTime.key + '"]').value = '1';
      resource.requestSubmit();
      window.handleAndroidBack();
      window.handleAndroidBack();
      click('[data-view="shift"]');
      const form = document.querySelector('#shift-form');
      const count = board().customUsageSources.find(row => row.label === 'Циклы борта');
      form.elements[typeTime.key + 'Major'].value = '1';
      form.elements[typeTime.key + 'Minor'].value = '30';
      form.elements[secondTime.key + 'Major'].value = '1';
      form.elements[secondTime.key + 'Minor'].value = '30';
      form.elements[count.key].value = '1.5';
      const onlyWhole = form.elements[count.key].validity.stepMismatch;
      form.elements[count.key].value = '3';
      form.elements[count.key].dispatchEvent(new Event('input', { bubbles: true }));
      const preview = document.querySelector('#shift-summary').textContent.includes('Расход 1,50625 ч');
      form.requestSubmit();
      const saved = board().shifts.at(-1);
      click('[data-aircraft-tab="works"]');
      click('[data-shift-id="' + saved.id + '"]');
      const work = document.querySelector('main').textContent;
      const history = work.includes('1 ч 30 мин') && work.includes('1 мин 30 с');
      window.handleAndroidBack();
      click('[data-view="reports"]');
      return { typeFactor: typeTime.factor, boardFactor: secondTime.factor, onlyWhole, preview, history,
        seconds: saved.customUsage.find(row => row.key === secondTime.key).seconds,
        hours: saved.customUsage.find(row => row.key === typeTime.key).value,
        amount: saved.accruals.find(row => row.name === 'Ресурс по времени').amount,
      };
    })()`);
    assert.deepEqual(usageMeasures, { typeFactor: 0.5, boardFactor: 0.25, onlyWhole: true, preview: true,
      history: true, seconds: 90, hours: 1.5, amount: 1.50625 });
    results.usageMeasures = "ok";

    await evaluate(`(() => {
      window.handleAndroidBack();
      document.querySelector('[data-action="add-resource"][data-work="true"]').click();
      const form = document.querySelector('#resource-form');
      form.elements.object.value = 'Самолёт';
      form.elements.name.value = 'Работа для проверки размеров';
      form.elements.limit.value = '10';
      form.elements.remaining.value = '7';
      form.requestSubmit();
      window.handleAndroidBack();
    })()`);
    const tileAudit = {};
    for (const tab of ["works", "aggregates", "least-reliable"]) {
      const audit = evaluate(`(async () => {
        const tab = ${JSON.stringify(tab)};
        const grid = () => document.querySelector('#counter-preview .counter-tiles');
        const all = () => [...grid().querySelectorAll(':scope > .counter-tile')];
        const active = () => grid().querySelector('.counter-tile-active');
        const byKey = key => all().find(tile => tile.dataset.tileKey === key);
        const close = (a, b) => Math.abs(a - b) <= 1.1;
        const fail = (key, issue) => { throw new Error(tab + ' / ' + key + ': ' + issue); };
        const touch = (element, type, x, y, identifier, ending = false) => {
          const point = new Touch({ target: element, identifier, clientX: x, clientY: y });
          element.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true,
            touches: ending ? [] : [point], changedTouches: ending ? [point] : [] }));
        };
        const hold = async key => {
          const tile = byKey(key);
          tile.scrollIntoView({ block: 'center' });
          const rect = tile.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + 10;
          touch(tile, 'touchstart', x, y, 80);
          await new Promise(resolve => setTimeout(resolve, 760));
          touch(tile, 'touchend', x, y, 80, true);
          if (active()?.dataset.tileKey !== key) fail(key, 'удержание не открыло нужную плитку');
        };
        const gesture = (dx, dy, end = 'touchend') => {
          const tile = active();
          const rect = tile.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + 20;
          touch(tile, 'touchstart', x, y, 81);
          touch(tile, 'touchmove', x + dx, y + dy, 81);
          const live = active().getBoundingClientRect();
          touch(tile, end, x + dx, y + dy, 81, true);
          return live;
        };
        document.querySelector('[data-aircraft-tab="' + tab + '"]').click();
        const keys = all().map(tile => tile.dataset.tileKey);
        for (const key of keys) {
          await hold(key);
          document.querySelector('[data-gesture="font"]').click();
          const font = () => parseFloat(getComputedStyle(active().querySelector('.counter-value')).fontSize);
          const oldFont = font();
          gesture(0, -30);
          if (font() <= oldFont) fail(key, 'размер текста не изменился');
          document.querySelector('#counter-font-reset').click();
          if (!close(font(), oldFont)) fail(key, 'сброс текста не вернул исходный размер');
          document.querySelector('[data-gesture="resize"]').click();
          const start = active().getBoundingClientRect();
          const initialFont = parseFloat(getComputedStyle(active().querySelector('.counter-value')).fontSize);
          const narrow = gesture(-Math.round(grid().clientWidth * 0.28), 0);
          if (!(narrow.width < start.width - 10)) fail(key, 'сужение не изменило ширину');
          if (!close(narrow.left, start.left)) fail(key, 'при сужении сместился левый край');
          if (!close(narrow.width, active().getBoundingClientRect().width)) fail(key, 'ширина изменилась после отпускания');
          const narrowFont = parseFloat(getComputedStyle(active().querySelector('.counter-value')).fontSize);
          if (!(narrowFont < initialFont)) fail(key, 'при сужении текст не подстроился');
          const expanded = gesture(14, 0);
          if (!(expanded.width > narrow.width + 3)) fail(key, 'не расширяется после сужения');
          const gridRect = grid().getBoundingClientRect();
          if (expanded.left < gridRect.left - 1 || expanded.right > gridRect.right + 1) fail(key, 'плитка выходит за границы сетки');
          const full = gesture(grid().clientWidth, 0, 'touchcancel');
          if (full.width < gridRect.width - 8 || full.left < gridRect.left - 1 || full.right > gridRect.right + 1 ||
              !close(expanded.width, active().getBoundingClientRect().width)) fail(key, 'расширение до краёв или отмена ширины не сработали');
          const base = active().getBoundingClientRect();
          const taller = gesture(0, 25);
          if (!(taller.height > base.height + 5)) fail(key, 'не увеличивается высота');
          const shorter = gesture(0, -40);
          if (!close(shorter.height, base.height)) fail(key, 'после уменьшения остаётся пустая высота');
          const cancelled = gesture(0, 18, 'touchcancel');
          if (cancelled.height <= shorter.height || !close(active().getBoundingClientRect().height, shorter.height)) fail(key, 'отменённый жест изменил размер');
          const final = gesture(0, 12);
          document.querySelector('#layout-save').click();
          const rendered = byKey(key).getBoundingClientRect();
          if (!close(rendered.width, final.width) || !close(rendered.height, final.height)) fail(key, 'после сохранения размер отличается от редактора');
          if (byKey(key).querySelector('.counter-group, .board-navigation-group').scrollWidth >
              byKey(key).querySelector('.counter-group, .board-navigation-group').clientWidth + 2) fail(key, 'содержимое выступает по ширине');
        }
        const saved = new Map(all().map(tile => [tile.dataset.tileKey, tile.getBoundingClientRect()]));
        window.handleAndroidBack();
        const board = [...document.querySelectorAll('[data-aircraft-id]')].find(item => item.textContent.includes('борт 42'));
        board.click();
        document.querySelector('[data-aircraft-tab="' + tab + '"]').click();
        for (const [key, rect] of saved) {
          const reopened = byKey(key)?.getBoundingClientRect();
          if (!reopened || !close(rect.width, reopened.width) || !close(rect.height, reopened.height)) fail(key, 'размер потерян после повторного открытия борта');
        }
        const closeDialog = async (key, choice) => {
          const dialog = document.querySelector('dialog[open]');
          if (!dialog) fail(key, 'не открылось окно выбора');
          const button = [...dialog.querySelectorAll('button')].find(item => item.value === choice);
          if (!button) fail(key, 'нет действия ' + choice);
          await new Promise(resolve => {
            dialog.addEventListener('close', resolve, { once: true });
            button.click();
          });
        };
        const count = { tiles: keys.length, openedActions: 0 };
        for (const key of keys) {
          await hold(key);
          const toolbar = () => document.querySelector('.counter-gesture-toolbar').getBoundingClientRect();
          const startToolbar = toolbar();
          const grip = document.querySelector('.counter-toolbar-handle').getBoundingClientRect();
          const delta = startToolbar.right + 30 < innerWidth - 8 ? 25 : -25;
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Перетаскивание панели не завершилось')), 5000);
            window.tileToolbarDrag = { x: grip.left + grip.width / 2, y: grip.top + grip.height / 2, delta, done: () => { clearTimeout(timeout); resolve(); } };
          });
          if (Math.abs(toolbar().left - startToolbar.left) < 12 || toolbar().left < 0 || toolbar().right > innerWidth) fail(key, 'панель не переместилась внутри экрана');
          document.querySelector('.counter-tile-active [data-layout-action="edit"]').click();
          const alias = 'Проверка подписи';
          document.querySelector('dialog[open] input').value = alias;
          await closeDialog(key, 'save');
          if (!active().textContent.includes(alias)) fail(key, 'подпись не применилась');
          document.querySelector('[data-gesture="move"]').click();
          const sourceIndex = Number(active().dataset.counterIndex);
          const candidates = all().filter(tile => tile !== active()).map(tile => {
            const rect = tile.getBoundingClientRect();
            return { tile, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          });
          const target = candidates.find(({tile,x,y}) => document.elementFromPoint(x,y)?.closest('.counter-tile') === tile);
          if (!target) fail(key, 'нет видимой цели для перемещения');
          const pos = active().getBoundingClientRect();
          const x = pos.left + pos.width / 2;
          const y = pos.top + 10;
          const node = active();
          const startingColumn = node.style.getPropertyValue('--tile-start');
          touch(node, 'touchstart', x, y, 82);
          touch(node, 'touchmove', target.x, target.y, 82);
          touch(node, 'touchcancel', target.x, target.y, 82, true);
          if (node.style.getPropertyValue('--tile-start') !== startingColumn || all().some(tile => tile.style.order)) {
            fail(key, 'отмена перемещения сдвинула плитки');
          }
          touch(node, 'touchstart', x, y, 82);
          touch(node, 'touchmove', target.x, target.y, 82);
          if (!target.tile.style.order) fail(key, 'соседние плитки не перестроились при жесте');
          touch(node, 'touchend', target.x, target.y, 82, true);
          if (Number(active().dataset.counterIndex) === sourceIndex || active().dataset.tileKey !== key) fail(key, 'перемещение не закрепилось в редакторе');
          const originalCount = all().length;
          const members = active().querySelectorAll('.counter-value').length;
          if (members === 1) {
            document.querySelector('#layout-group').click();
            const option = document.querySelector('dialog[open] button:not([value="cancel"])');
            if (!option) fail(key, 'нет совместимой плитки для группировки');
            await closeDialog(key, option.value);
            if (all().length !== originalCount - 1 || active().querySelectorAll('.counter-value').length < 2) fail(key, 'группировка не сработала');
          }
          const groupMembers = active().querySelectorAll('.counter-value').length;
          const groupedCount = all().length;
          document.querySelector('#layout-group').click();
          if (all().length !== groupedCount + groupMembers - 1) fail(key, 'разделение не сработало');
          document.querySelector('#layout-default').click();
          await closeDialog(key, 'reset');
          if (byKey(key).style.getPropertyValue('--tile-height') !== '0px') fail(key, 'сброс размера не убрал высоту');
          window.handleAndroidBack();
          await closeDialog(key, 'discard');
          if (byKey(key).textContent.includes(alias) || !close(byKey(key).getBoundingClientRect().height, saved.get(key).height) ||
              Number(byKey(key).dataset.counterIndex) !== sourceIndex) fail(key, 'выход без сохранения изменил раскладку');
          const actions = [...byKey(key).querySelectorAll('.counter-value button')].map(button => ({ ...button.dataset }));
          for (const attrs of actions) {
            const button = [...byKey(key).querySelectorAll('.counter-value button')].find(item =>
              Object.entries(attrs).every(([name, value]) => item.dataset[name] === value));
            const visible = (selector) => Boolean(document.querySelector(selector));
            button.click();
            if (attrs.aircraftTab) {
              if (!visible('[data-aircraft-tab="' + attrs.aircraftTab + '"][aria-selected="true"]')) fail(key, 'вкладка не переключилась');
              document.querySelector('[data-aircraft-tab="' + tab + '"]').click();
            } else {
              const screen = attrs.blockId ? '#block-form' : attrs.resourceId || attrs.action === 'add-resource' ? '#resource-form' :
                attrs.shiftId ? '#open-shift-map' : attrs.action === 'add-block' ? '#creation-form' :
                { shift: '#shift-form', resources: '#resource-list', reports: '#report-form' }[attrs.view];
              if (!screen || !visible(screen)) fail(key, 'действие не открыло нужный экран');
              window.handleAndroidBack();
            }
            count.openedActions += 1;
          }
        }
        return count;
      })()`);
      let finished = false;
      audit.then(() => { finished = true; }, () => { finished = true; });
      while (!finished) {
        const drag = await evaluate("window.tileToolbarDrag && {x:window.tileToolbarDrag.x,y:window.tileToolbarDrag.y,delta:window.tileToolbarDrag.delta}");
        if (drag) {
          const { x, y, delta } = drag;
          await command("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
          await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + delta, y, button: "left", buttons: 1 });
          await command("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + delta, y, button: "left", clickCount: 1 });
          await evaluate("(() => { const request = window.tileToolbarDrag; delete window.tileToolbarDrag; request.done(); })()");
        } else {
          await new Promise(resolve => setTimeout(resolve, 75));
        }
      }
      tileAudit[tab] = await audit;
    }
    results.tileResizeAudit = tileAudit;

    const typeDeletion = await evaluate(`(async () => {
      const read = () => JSON.parse(localStorage.getItem('aviation-resource-prototype-v1'));
      const press = async (choice) => {
        const dialog = document.querySelector('dialog[open]');
        await new Promise(resolve => {
          dialog.addEventListener('close', resolve, { once: true });
          dialog.querySelector('[value="' + choice + '"]').click();
        });
      };
      const find = (selector, label) => [...document.querySelectorAll(selector)].find(button => button.closest('.setting-row').querySelector('strong').textContent === label);
      const board = () => read().aircraft.find(item => item.boardNumber === '85');
      window.handleAndroidBack();
      document.querySelector('[data-action="settings"]').click();
      document.querySelector('[data-view="aircraft-types"]').click();
      const before = JSON.stringify(board());
      const profile = JSON.stringify(read().usageTypeOverrides.find(row => row.type === 'су-33'));
      const close = find('[data-archive-type]', 'Су-33');
      const cross = close.textContent.trim() === '×' && getComputedStyle(close).position === 'absolute' &&
        Number.parseFloat(getComputedStyle(close).borderRadius) >= 50;
      close.click();
      await press('cancel');
      const cancelArchive = Boolean(find('[data-archive-type]', 'Су-33'));
      find('[data-archive-type]', 'Су-33').click();
      await press('archive');
      document.querySelector('#aircraft-type-trash summary').click();
      const inTrash = Boolean(find('[data-restore-type]', 'Су-33')) && !find('[data-archive-type]', 'Су-33');
      find('[data-delete-type]', 'Су-33').click();
      await press('cancel');
      const cancelDelete = Boolean(find('[data-delete-type]', 'Су-33'));
      find('[data-delete-type]', 'Су-33').click();
      await press('delete');
      const removed = !find('[data-delete-type]', 'Су-33') && !read().aircraftTypes.includes('Су-33');
      const intact = JSON.stringify(board()) === before && JSON.stringify(read().usageTypeOverrides.find(row => row.type === 'су-33')) === profile;
      const typeForm = document.querySelector('#aircraft-type-form');
      typeForm.elements.type.value = 'Пробный тип';
      typeForm.requestSubmit();
      find('[data-archive-type]', 'Пробный тип').click();
      await press('archive');
      document.querySelector('#aircraft-type-trash summary').click();
      find('[data-delete-type]', 'Пробный тип').click();
      await press('delete');
      const unusedPurged = !read().aircraftTypes.includes('Пробный тип') &&
        !read().usageTypeOverrides.some(row => row.type === 'пробный тип');
      return { cross, cancelArchive, inTrash, cancelDelete, removed, intact, unusedPurged };
    })()`);
    assert.deepEqual(typeDeletion, { cross: true, cancelArchive: true, inTrash: true, cancelDelete: true, removed: true, intact: true, unusedPurged: true });
    await command("Page.reload");
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await evaluate("Boolean(document.querySelector('[data-action=add-aircraft]'))").catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const typeDeletionAfterReload = await evaluate(`(() => {
      document.querySelector('[data-action="add-aircraft"]').click();
      const omitted = ![...document.querySelector('#creation-form [name="type"]').options].some(option => option.value === 'Су-33');
      window.handleAndroidBack();
      document.querySelector('[data-board-menu="board-details"]').click();
      const form = document.querySelector('#board-details-form');
      const retained = form.elements.type.value === 'Су-33' && form.elements.type.selectedOptions[0].textContent.includes('удалён из справочника');
      form.elements.rfNumber.value = '33738';
      form.requestSubmit();
      const saved = Boolean(document.querySelector('[data-aircraft-id]')) && JSON.parse(localStorage.getItem('aviation-resource-prototype-v1'))
        .aircraft.some(board => board.type === 'Су-33' && board.blocks.length > 0);
      return { omitted, retained, saved };
    })()`);
    assert.deepEqual(typeDeletionAfterReload, { omitted: true, retained: true, saved: true });
    results.typeDeletion = "ok";

    await evaluate(`(() => {
      const storage = 'aviation-resource-prototype-v1';
      const previous = JSON.parse(localStorage.getItem(storage));
      delete previous.usageInheritanceVersion;
      previous.removedAircraftTypes = [];
      previous.aircraftTypes.unshift('Су-33');
      const board = previous.aircraft.find(item => item.boardNumber === '85');
      board.enabledUsageSources = {carrier:true,touch:true,circuit:true,arresterHooks:true};
      const legacy = structuredClone(board);
      legacy.id = 'legacy-board';
      legacy.boardNumber = '86';
      legacy.enabledUsageSources = {flight:true,runway:true,carrier:true,touch:true,circuit:true,arresterHooks:true};
      previous.aircraft.push(legacy);
      const custom = previous.aircraft.find(item => item.boardNumber === '42');
      custom.enabledUsageSources = {arresterHooks:true,circuit:true};
      const type = previous.usageTypeOverrides.find(row => row.type === 'су-33');
      type.enabled = {flight:true,runway:true,arresterHooks:true};
      localStorage.setItem(storage, JSON.stringify(previous));
    })()`);
    await command("Page.reload");
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await evaluate("document.querySelector('[data-aircraft-id=legacy-board]') !== null").catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const inheritance = await evaluate(`(() => {
      const read = () => JSON.parse(localStorage.getItem('aviation-resource-prototype-v1'));
      const click = selector => document.querySelector(selector).click();
      const home = () => window.handleAndroidBack();
      const open = number => {
        const id = read().aircraft.find(row => row.boardNumber === number).id;
        click('[data-aircraft-id="' + id + '"]');
      };
      const fields = () => [...document.querySelectorAll('#shift-form input')].map(input => input.name)
        .filter(name => ['flightHours','runway','carrier','touch','circuit','arresterHooks'].includes(name));
      const readWork = number => {
        open(number);
        click('[data-view="shift"]');
        const result = fields();
        home();
        home();
        return result;
      };
      const migrated = readWork('85');
      const legacy = readWork('86');
      open('42');
      click('[data-view="shift"]');
      const independent = fields().includes('circuit') && fields().includes('arresterHooks');
      home();
      click('[data-action="settings"]');
      click('[data-view="board-usage"]');
      click('#inherit-type-usage');
      const restored = Boolean(document.querySelector('#board-usage-form')) && !document.querySelector('#inherit-type-usage');
      home();
      home();
      click('[data-view="shift"]');
      const followsType = !fields().includes('circuit') && !fields().includes('arresterHooks');
      home();
      home();
      click('[data-action="settings"]');
      click('[data-view="usage-settings"]');
      const type = document.querySelector('#usage-aircraft-type');
      type.value = 'Су-33';
      type.dispatchEvent(new Event('change'));
      const rules = document.querySelector('#usage-settings-form');
      rules.elements.existingSource.value = 'touch';
      click('#type-add-source-button');
      rules.requestSubmit();
      home();
      home();
      const afterChange = readWork('85');
      const saved = read().usageInheritanceVersion === 1;
      return { migrated, legacy, independent, restored, followsType, afterChange, saved };
    })()`);
    assert.deepEqual(inheritance, {
      migrated: ["flightHours", "runway", "arresterHooks"], legacy: ["flightHours", "runway", "arresterHooks"],
      independent: true, restored: true, followsType: true,
      afterChange: ["flightHours", "runway", "touch", "arresterHooks"], saved: true,
    });
    results.usageInheritance = "ok";

    process.stdout.write(`${JSON.stringify(results)}\n`);
  } finally {
    await command("Browser.close").catch(() => {});
    socket.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
