const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "src", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const activity = fs.readFileSync(path.join(root, "android", "app", "src", "main", "java", "ru", "smolnikov", "aviaresource", "MainActivity.java"), "utf8");

test("главный экран называется «Самолёты», без придуманной нижней навигации", () => {
  assert.match(app, /<h1>Самолёты<\/h1>/);
  assert.doesNotMatch(app, /Мои самолёты/);
  assert.doesNotMatch(app, /bottom-nav|bottom navigation/i);
  assert.doesNotMatch(css, /\.bottom-nav/);
});

test("общие настройки строят переключатели по полному списку самолётов", () => {
  assert.match(app, /state\.aircraft\.map\(\(item\) =>/);
  assert.match(app, /Уведомления по самолётам/);
  assert.match(app, /state\.aircraft\.forEach\(\(item\) => \{ item\.notifications = enabled; \}\)/);
});

test("общий запрет уведомлений наследуется новым самолётом", () => {
  assert.match(app, /notifications: state\.globalNotifications/);
  assert.match(app, /\$\{!state\.globalNotifications \? "disabled" : ""\}/);
});

test("Android размещает WebView между системными панелями и вырезом", () => {
  assert.match(activity, /setDecorFitsSystemWindows\(false\)/);
  assert.match(activity, /WindowInsets\.Type\.systemBars\(\) \| WindowInsets\.Type\.displayCutout\(\)/);
  assert.match(activity, /params\.setMargins\(bars\.left, bars\.top, bars\.right, bars\.bottom\)/);
  assert.doesNotMatch(activity, /webView\.setPadding|view\.setPadding/);
  assert.doesNotMatch(html, /viewport-fit=cover/);
});

test("настройки самолёта отделены от общих настроек", () => {
  assert.match(app, /function renderAircraftSettings\(\)/);
  assert.match(app, /data-settings-scope="\$\{settingsScope\}"/);
  assert.match(app, /Приложение и все самолёты/);
});

test("форма смены содержит зацепы, запуски и раздельные режимы двигателей", () => {
  assert.match(app, /name="arresterHooks"/);
  assert.match(app, /name="leftStarts"/);
  assert.match(app, /name="rightStarts"/);
  assert.match(app, /name="leftCombinedMode"/);
  assert.match(app, /name="rightCombinedMode"/);
});

test("ресурсная сводка содержит все оговорённые сортировки", () => {
  for (const label of ["По установке", "По производству", "По наработке", "Остаток по наработке", "Календарный остаток"]) {
    assert.ok(app.includes(label), `Нет сортировки: ${label}`);
  }
});

test("карточка самолёта содержит три оговорённые вкладки", () => {
  for (const label of ["Работы", "Агрегаты", "Агрегаты с наименее надёжным ресурсом"]) {
    assert.ok(app.includes(`>${label}</button>`), `Нет вкладки: ${label}`);
  }
  assert.match(app, /data-aircraft-tab="works"/);
  assert.match(app, /data-aircraft-tab="aggregates"/);
  assert.match(app, /data-aircraft-tab="least-reliable"/);
});

test("формуляр агрегата поддерживает жизненный цикл без удаления истории", () => {
  for (const eventType of ["repair", "dismantle", "install", "extension"]) {
    assert.ok(app.includes(`value="${eventType}"`), `Нет события: ${eventType}`);
  }
  assert.match(app, /block\.events\.push\(item\)/);
  assert.match(app, /if \(block\.hasPpr\) block\.pprMinutes = 0/);
  assert.match(app, /block\.installed = false/);
  assert.match(app, /block\.installed = true/);
});

test("карточка ограниченного ресурса поддерживает основные единицы и номера", () => {
  for (const unit of ["ч", "пос.", "зап.", "сраб.", "дн."]) {
    assert.ok(app.includes(`value="${unit}"`), `Нет единицы: ${unit}`);
  }
  assert.match(app, /name="serialNumber"/);
  assert.match(app, /name="drawingNumber"/);
  assert.match(app, /name="resourceType"/);
});
