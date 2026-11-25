"""Local Chromium regression for user-created columns in all three kinds of forms."""
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FORMS = ["Формуляр самолёта", "Учебный двигатель", "Контрольный счётчик"]
FIELDS = [
    ("Штуки", "шт.", "manual", "0", "0 шт."),
    ("Посадки", "пос.", "manual", "2", "2 пос."),
    ("Запуски", "зап.", "manual", "3", "3 зап."),
    ("Срабатывания", "сраб.", "manual", "4", "4 сраб."),
    ("Часы", "ч", "manual", "1.5", "1,5 ч"),
    ("Минуты", "мин", "manual", "15", "15 мин"),
    ("Секунды", "с", "manual", "3", "3 с"),
    ("Своя дата", "дата", "manual", "2024-03-01", "01.03.2024"),
    ("Срок", "дн.", "manual", ("2024-02-28", "2024-03-01"), "2 дн."),
    ("Заметка", "текст", "manual", "<осмотр> 001", "<осмотр> 001"),
    ("Вид", "текст", "work:type", None, "Руление"),
    ("Дата записи", "дата", "work:date", None, "02.03.2024"),
    ("Вычислено", "мин", "formula", None, "СНЭ 30 мин"),
]


def check(page):
    page.goto((ROOT / "index.html").as_uri())
    page.get_by_role("button", name="Настройки", exact=True).click()
    page.get_by_text("Типы самолётов", exact=True).first.click()
    page.locator("#aircraft-template-file").set_input_files(ROOT / "examples/civil-form-check-29.json")
    page.get_by_role("button", name="Импортировать борт", exact=True).click()

    def open_form(name):
        if not page.locator("[data-block-id]").filter(has_text=name).count():
            page.locator("[data-aircraft-tab=aggregates]").click()
        page.locator("[data-block-id]").filter(has_text=name).first.click()

    def reopen_board():
        page.reload()
        page.locator("[data-aircraft-id]").filter(has_text="Т-29").click()

    for owner in FORMS:
        open_form(owner)
        page.locator("#add-form-column").click()
        for index, (name, unit, source, value, expected) in enumerate(FIELDS):
            if index:
                page.locator("[data-aggregate-rule-add]").click()
            row = page.locator("[data-rule-id]").last
            row.locator("[data-rule=name]").fill(name)
            row.locator("[data-rule=unit]").select_option(unit)
            row.locator("[data-rule=source]").select_option(source)
            row.locator("[data-rule=workTypeId]").select_option("2")
            if name == "Минуты":
                minute_key = row.get_attribute("data-column-key")
            if source == "formula":
                row.locator("[data-rule=workMode]").select_option("total")
                row.locator(f'[data-ref="cell:{minute_key}"]').click()
                row.locator('[data-op="*"]').click()
                row.locator("[data-number]").fill("2")
                row.locator("[data-insert-number]").click()
        page.locator("#aggregate-rules-form button[type=submit]").click()
        assert not page.locator("#aggregate-rules-form").count(), (owner, page.locator(".form-error").text_content())
        page.locator("#add-form-column").wait_for()
        reopen_board()

    page.get_by_role("button", name="Внести работу").click()
    page.locator('[name=operationType][value="2"]').check()
    page.locator('[name=date]').fill("2024-03-02")
    page.locator("[data-aggregate-manual] summary").click()
    for group in page.locator("[data-aggregate-manual-block]").all():
        for name, unit, source, value, _ in FIELDS:
            if source != "manual":
                continue
            if unit == "дн.":
                period = group.locator("fieldset").filter(has=page.get_by_text(name, exact=True))
                period.get_by_label("С даты").fill(value[0])
                period.get_by_label("До даты").fill(value[1])
            else:
                label = name if unit in ("дата", "текст") else f"{name} ({unit})"
                group.get_by_label(label, exact=True).fill(value)
    page.get_by_role("button", name="Сохранить работу").click()
    page.get_by_role("button", name="Внести работу").wait_for()
    # A different work type with all these entries omitted must preserve the last readings.
    page.get_by_role("button", name="Внести работу").click()
    page.locator('[name=operationType][value="0"]').check()
    assert not page.locator('[data-manual-type="2"]:visible').count()
    page.locator('[data-template-scope=board] [data-template-field=flight]').fill("00:05")
    page.get_by_role("button", name="Сохранить работу").click()
    page.get_by_role("button", name="Внести работу").wait_for()
    for owner in FORMS:
        reopen_board()
        open_form(owner)
        for name, _, _, _, expected in FIELDS:
            card = page.locator("article[data-form-widget]").filter(has=page.get_by_text(name, exact=True))
            actual = card.locator("strong").inner_text()
            assert actual == expected, (owner, name, actual, expected)
    reopen_board()
    page.locator("[data-action=settings]").click()
    def export(button):
        with page.expect_download() as download:
            page.locator("#" + button).click()
        return download.value.path().read_bytes()
    type_file = export("export-board-template")
    inventory = export("export-starting-aircraft")
    baseline = export("export-baseline")
    assert "readings" not in json.loads(inventory) and "template" not in json.loads(baseline)
    for position in json.loads(type_file)["positions"]:
        definitions = {row["name"]: row for row in position["usageCounters"]}
        for name, unit, source, _, _ in FIELDS:
            row = definitions[name]
            assert (row["unit"], row["source"], row["workTypeId"]) == (unit, source, "2")
    fresh = page.context.browser.new_page()
    fresh.goto((ROOT / "index.html").as_uri())
    fresh.locator("[data-action=settings]").click()
    fresh.get_by_text("Типы самолётов", exact=True).first.click()
    def upload(payload, button):
        fresh.locator("#aircraft-template-file").set_input_files({"name": "roundtrip.json", "mimeType": "application/json", "buffer": payload})
        fresh.get_by_role("button", name=button, exact=True).click()
    upload(type_file, "Импортировать")
    fresh.get_by_text("Тип самолёта импортирован", exact=True).wait_for()
    upload(inventory, "Добавить состав борта")
    fresh.locator("[data-action=settings]").click()
    upload(baseline, "Внести показания")
    fresh.get_by_text("Показания на дату внесены", exact=True).wait_for()
    fresh.reload()
    fresh.locator("[data-aircraft-id]").filter(has_text="Т-29").click()
    fresh.get_by_role("button", name="Внести работу").click()
    fresh.locator('[name=operationType][value="2"]').check()
    fresh.locator("[data-aggregate-manual] summary").click()
    assert fresh.get_by_label("Заметка", exact=True).count() == len(FORMS)
    fresh.reload()
    fresh.locator("[data-action=settings]").click()
    fresh.get_by_text("Типы самолётов", exact=True).first.click()
    fresh.locator("[data-copy-template]").last.click()
    for position in fresh.locator("[data-template-entry=positions]").all():
        position.locator("[data-counter-add]").click()
        row = position.locator("[data-position-counter]").last
        row.locator("[data-counter-name]").fill("Вид записи")
        row.locator("[data-counter-unit]").select_option("текст")
        row.locator("[data-counter-source]").select_option("work:type")
        row.locator("[data-counter-work]").select_option("2")
        assert not row.locator("[data-counter-factor]").is_visible()
    with fresh.expect_download(timeout=5000) as copy:
        fresh.locator("#export-draft-template").click()
    for position in json.loads(copy.value.path().read_bytes())["positions"]:
        last = position["usageCounters"][-1]
        assert (last["source"], last["workMode"], last["workTypeId"]) == ("work:type", "entry", "2")
    fresh.close()
    print(f"PASS: {len(FIELDS)} columns × {len(FORMS)} form kinds, write, work filter, reload and read")


if __name__ == "__main__":
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport={"width": 390, "height": 844})
        page.set_default_timeout(4000)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        check(page)
        assert not errors, errors
        browser.close()
