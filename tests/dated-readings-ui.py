"""Date selection, data entry, APK-independent JSON export/import and persistence."""
import json
from datetime import date, timedelta
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EX = ROOT / "examples"
base = (date.today() - timedelta(days=3)).isoformat()
later = (date.today() - timedelta(days=1)).isoformat()
source = json.loads((EX / "aircraft-89-2026-11-24.json").read_text(encoding="utf8"))
source["asOfDate"] = base


def upload(page, payload, action):
    if isinstance(payload, dict):
        payload = {"name": "readings.json", "mimeType": "application/json", "buffer": json.dumps(payload).encode()}
    page.locator("#aircraft-template-file").set_input_files(payload)
    page.get_by_role("button", name=action, exact=True).click()


def fresh(browser, readings):
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.set_default_timeout(5000)
    page.goto((ROOT / "index.html").as_uri())
    upload(page, EX / "su-33-kza-type-exp41.json", "Импортировать")
    page.get_by_text("Тип самолёта импортирован", exact=True).wait_for()
    upload(page, EX / "aircraft-89-inventory.json", "Добавить состав борта")
    page.locator("[data-view=shift]").wait_for()
    page.reload()
    upload(page, readings, "Внести показания")
    page.get_by_text("Показания на дату внесены", exact=True).wait_for()
    return page


def open_dates(page):
    page.reload()
    page.locator("[data-aircraft-id]").click()
    page.locator("[data-action=settings]").click()
    page.locator("[data-view=dated-readings]").click()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    page = fresh(browser, source)
    middle = (date.fromisoformat(base) + timedelta(days=1)).isoformat()
    for when, duration in [(middle, "00:12"), (later, "00:08"), (base, "00:07")]:
        page.reload()
        page.locator("[data-aircraft-id]").click()
        page.locator("[data-view=shift]").first.click()
        page.locator("form [name=date]").fill(when)
        page.locator("[data-template-field=flight]").first.fill(duration)
        page.locator("[data-template-field=runway]").first.fill("1")
        page.get_by_role("button", name="Сохранить работу", exact=True).click()
        page.locator("[data-view=shift]").first.wait_for()
    open_dates(page)
    flight_row = page.locator("tr").filter(has=page.get_by_role("rowheader", name="Налёт СНЭ", exact=True))
    assert flight_row.locator("td").all_text_contents() == ["967:32", "967:52", "+0:20"]
    date_to = page.locator("#date-range [name=to]")
    date_to.fill(later)
    entry = page.locator("#observation")
    entry.locator("[name=key]").select_option("actualLandings")
    entry.locator("[name=amount]").fill("1255")
    entry.locator("button").click()
    entry.get_by_text("Показание сохранено").wait_for()
    open_dates(page)
    date_to.fill(later)
    row = page.locator("tr").filter(has=page.get_by_role("rowheader", name="Посадки СНЭ", exact=True))
    assert [s.replace(chr(160), " ") for s in row.locator("td").all_text_contents()] == ["1 251 шт.", "1 255 шт.", "+4 шт."]
    for when, expected in [(base, 1251), (later, 1255)]:
        date_to.fill(when)
        with page.expect_download() as dl:
            page.locator("#export-at-date").click()
        payload = json.loads(dl.value.path().read_bytes())
        assert payload["asOfDate"] == when and payload["readings"]["actualLandings"] == expected
        assert payload["readings"]["totalFlightMinutes"] == 967 * 60 + (32 if when == base else 52)
        assert dl.value.suggested_filename.endswith(when + ".json") and len(payload["blocks"]) == 7
        imported = fresh(browser, payload)
        open_dates(imported)
        assert imported.locator("#date-range [name=from]").input_value() == when
        assert imported.locator("tr").filter(has=imported.get_by_role("rowheader", name="Посадки СНЭ", exact=True)).locator("td").first.inner_text().replace(chr(160)," ") == f"1 {expected % 1000} шт."
        imported.close()
    date_to.fill((date.fromisoformat(base) - timedelta(days=1)).isoformat())
    assert not page.locator("#reading-results table").count()
    print("PASS: two dated readings, restart, historical export and clean re-import of both files")
    browser.close()
