"use strict";

const assert = require("node:assert/strict");

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
      typeForm.elements.type.value = "МиГ-29";
      typeForm.requestSubmit();
      window.handleAndroidBack();
      window.handleAndroidBack();
      document.querySelector('[data-action="add-aircraft"]').click();
      const form = document.querySelector('#creation-form');
      form.elements.type.value = "МиГ-29";
      form.elements.boardNumber.value = "42";
      form.elements.serialNumber.value = "SN-42";
      form.requestSubmit();
      const saved = JSON.parse(localStorage.getItem('aviation-resource-prototype-v1'));
      const created = saved.aircraft.find((item) => item.boardNumber === "42");
      return {
        h1: document.querySelector("h1")?.textContent,
        count: saved.aircraft.length,
        notifications: created?.notifications,
        tabs: [...document.querySelectorAll('[data-aircraft-tab]')].map((item) => item.textContent.trim()),
        activeTab: document.querySelector('[data-aircraft-tab][aria-selected="true"]')?.dataset.aircraftTab
      };
    })()`);
    assert.equal(newAircraft.h1, "МиГ-29 · Борт 42");
    assert.equal(newAircraft.count, 2);
    assert.equal(newAircraft.notifications, false);
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
          boardSerial: document.querySelector('#block-form output')?.textContent,
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
      const history = document.querySelector('.history-list').textContent;
      const sne = document.querySelector('[name="sneMinutes"]').value;
      const ppr = document.querySelector('[name="pprMinutes"]').value;
      document.querySelector('[data-action="back"]').click();
      return { engineFields, history, sne, ppr };
    })()`);
    assert.equal(addedBlock.engineFields, true);
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
      return { events: block.events.length, repairs: block.repairs, historyText: document.querySelector('.history-list')?.textContent };
    })()`);
    assert.equal(lifecycleEvent.events, 1);
    assert.equal(lifecycleEvent.repairs, 1);
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
    const typeSettings = await evaluate(`(() => {
      document.querySelector('[data-action="back"]').click();
      [...document.querySelectorAll('[data-aircraft-id]')].find(item => item.textContent.includes('борт 42')).click();
      document.querySelector('[data-action="settings"]').click();
      const rules = document.querySelector('#aircraft-rules-form');
      rules.elements.runway.value = '2.5';
      rules.requestSubmit();
      document.querySelector('[data-action="back"]').click();
      document.querySelector('[data-action="back"]').click();
      document.querySelector('[data-action="add-aircraft"]').click();
      const form = document.querySelector('#creation-form');
      form.elements.type.value = 'МиГ-29';
      form.elements.boardNumber.value = '43';
      form.requestSubmit();
      const saved = JSON.parse(localStorage.getItem('aviation-resource-prototype-v1'));
      return { template: saved.typeSettings.find(entry => entry.type === 'МиГ-29').settings.landingCoefficients.runway,
        newAircraft: saved.aircraft.find(item => item.boardNumber === '43').settings.landingCoefficients.runway };
    })()`);
    assert.deepEqual(typeSettings, { template: 2.5, newAircraft: 2.5 });
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
      const airframeSections = !document.querySelector('[name="rfNumber"], #block-form [name="model"], #block-form [name="drawingNumber"], #block-form [name="serialNumber"]') &&
        [...document.querySelectorAll('#block-form output')].some((item) => item.textContent === '33739') &&
        document.querySelector('#block-form output')?.textContent === '49051002905' &&
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
      window.handleAndroidBack();
      click('[data-view="shift"]');
      const form = document.querySelector('#shift-form');
      form.elements.flightHours.value = '1';
      form.elements.arresterHooks.value = '1';
      form.elements.rightFlight.value = '30';
      form.elements.rightGround.value = '13';
      form.elements.operationType.value = '2';
      form.elements.arresterHooks.dispatchEvent(new Event('input', { bubbles: true }));
      const preview = document.querySelector('#shift-summary').textContent.includes('Расход 2');
      submit('#shift-form');
      click('[data-aircraft-tab="works"]');
      click('[data-shift-id]');
      click('[data-view="correct-shift"]');
      const revise = document.querySelector('#shift-form');
      revise.elements.arresterHooks.value = '2';
      submit('#shift-form');
      const board = read();
      const shift = board.shifts.at(-1);
      const saved = board.resources.find(item => item.object === 'ГАК');
      const hook = board.blocks.find(item => item.name === 'ГАК');
      return { map, connected, preview, copied, amount: shift.accruals.find(item => item.resourceId === saved.id).amount,
        remaining: saved.remaining, previous: shift.revisions[0].raw.arresterHooks, kind: shift.operationLabel,
        rightFlight: shift.engineAccruals.find(item => item.blockId === 'engine-right').flightMinutes,
        rightTotal: shift.engineAccruals.find(item => item.blockId === 'engine-right').minutes,
        historyBeforeRepair: hook.historicalRepairs[2].beforeRepair.sneMinutes, repairs: hook.repairs,
        hookPpr: hook.pprMinutes };
    })()`);
    assert.deepEqual(routing, { map: true, connected: true, preview: true, copied: true, amount: 4, remaining: 46, previous: '1',
      kind: 'Руление', rightFlight: 30, rightTotal: 36, historyBeforeRepair: 360, repairs: 2, hookPpr: 120 });
    results.resourceRouting = "ok";

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
