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
          engine: Boolean(document.querySelector('[name="sneMinutes"]')),
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
      blockForm.elements.pprMinutes.value = '120';
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
    assert.match(addedBlock.history, /До ремонта: СНЭ 10:00 · ППР 2:00/);
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
      return {
        h1: document.querySelector("h1")?.textContent,
        left: document.querySelector('#left-calculation')?.textContent,
        summary: document.querySelector('#shift-summary')?.textContent,
        hooks: Boolean(document.querySelector('[name="arresterHooks"]')),
        starts: Boolean(document.querySelector('[name="leftStarts"]')),
        separateModes: Boolean(document.querySelector('[name="leftCombinedMode"]') && document.querySelector('[name="rightCombinedMode"]'))
      };
    })()`);
    assert.equal(shift.h1, "Лётная смена");
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
      rules.elements.groundPercent.value = '25';
      rules.requestSubmit();
      document.querySelector('[data-action="back"]').click();
      document.querySelector('[data-action="back"]').click();
      document.querySelector('[data-action="add-aircraft"]').click();
      const form = document.querySelector('#creation-form');
      form.elements.type.value = 'МиГ-29';
      form.elements.boardNumber.value = '43';
      form.requestSubmit();
      const saved = JSON.parse(localStorage.getItem('aviation-resource-prototype-v1'));
      return { template: saved.typeSettings.find(entry => entry.type === 'МиГ-29').settings.groundPercent,
        newAircraft: saved.aircraft.find(item => item.boardNumber === '43').settings.groundPercent };
    })()`);
    assert.deepEqual(typeSettings, { template: 25, newAircraft: 25 });
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
      document.querySelector('[data-view="aircraft-layout"]').click();
      document.querySelector('[data-layout-action="split"]').click();
      document.querySelector('[data-layout-action="right"][data-index="0"]').click();
      document.querySelector('[data-layout-action="merge"]').click();
      const count = document.querySelectorAll('.counter-tile').length;
      window.handleAndroidBack();
      let dialog = document.querySelector('dialog[open]');
      await new Promise(resolve => {
        dialog.addEventListener('close', resolve, { once: true });
        dialog.querySelector('[value="save"]').click();
      });
      const persisted = Boolean(document.querySelector('.counter-tile'));
      document.querySelector('[data-view="aircraft-layout"]').click();
      document.querySelector('#layout-default').click();
      dialog = document.querySelector('dialog[open]');
      await new Promise(resolve => {
        dialog.addEventListener('close', resolve, { once: true });
        dialog.querySelector('[value="reset"]').click();
      });
      document.querySelector('#layout-save').click();
      return { count, persisted, restored: Boolean(document.querySelector('.aircraft-counters')) };
    })()`);
    assert.deepEqual(layoutResult, { count: 2, persisted: true, restored: true });
    results.aircraftLayout = "ok";

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
