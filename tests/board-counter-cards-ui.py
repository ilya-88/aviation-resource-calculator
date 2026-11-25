"""Exercise replacement of existing cards and trace the resulting work through the UI."""
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
pack = json.loads((ROOT / "examples/civil-form-check-29.json").read_text(encoding="utf8"))
pack["aircraft"]["readings"].update(totalFlightMinutes=60, pprFlightMinutes=20, pprLandings=9)
pack["aircraft"]["blocks"][0].update(repairs=1, lastRepairDate="2020-01-01")
pack["template"]["positions"][0]["formLayout"] = {"tiles": [
    {"keys": ["form-metric:0"], "height": 68, "span": 7},
    {"keys": ["form-field:pprFlightMinutes"], "span": 5},
]}

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.set_default_timeout(4000)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto((ROOT / "index.html").as_uri())
    page.locator("[data-action=settings]").click()
    page.get_by_text("Типы самолётов", exact=True).first.click()
    page.locator("#aircraft-template-file").set_input_files({"name": "test.json", "mimeType": "application/json", "buffer": json.dumps(pack).encode()})
    page.get_by_role("button", name="Импортировать борт", exact=True).click()

    def board():
        page.reload()
        page.locator("[data-aircraft-id]").filter(has_text="Т-29").click()

    def aircraft_form():
        page.get_by_role("button", name="Формуляр самолёта Норма").first.click()

    def save_work():
        page.get_by_role("button", name="Внести работу").click()
        page.locator("[data-template-scope=board] [data-template-field=flight]").fill("00:10")
        page.locator("[data-template-scope=board] [data-template-field=runway]").fill("1")
        page.get_by_role("button", name="Сохранить работу").click()
        page.get_by_role("button", name="Внести работу").wait_for()

    def readings():
        return page.evaluate("""() => {
          const b=JSON.parse(localStorage.getItem('aviation-resource-prototype-v1')).aircraft.at(-1);
          return [b.totalFlightMinutes,b.pprFlightMinutes,b.actualLandings,b.pprLandings,b.shifts.length];
        }""")

    save_work()
    assert readings() == [70, 30, 101, 10, 1]
    aircraft_form()
    page.locator("#replace-board-counters").click()
    page.get_by_role("button", name="Заменить карточки", exact=True).click()
    page.locator("#replace-board-counters").wait_for(state="detached")
    assert readings() == [70, 30, 101, 10, 1]
    card = page.locator("[data-form-widget]").filter(has=page.get_by_text("Налёт СНЭ", exact=True)).last
    assert card.locator("strong").inner_text() == "1:10"
    assert card.evaluate("el=>el.closest('.counter-tile').offsetHeight") >= 68
    card.locator("[data-column-rule]").click()
    row = page.locator("[data-rule-id]").filter(has=page.locator('[data-rule=name][value="Налёт СНЭ"]'))
    row.locator("[data-rule=factor]").fill("2")
    page.locator("#aggregate-rules-form button[type=submit]").click()
    page.locator("#add-form-column").wait_for()
    board()
    save_work()
    assert readings() == [90, 40, 102, 11, 2], readings()
    page.locator("[data-view=usage-map]").click()
    page.locator('[data-map-select="__airframe"]').click()
    assert "Налёт СНЭ" in page.locator("#map-details").inner_text()
    page.locator("#map-work").select_option(index=1)
    page.locator('[data-map-select="__airframe"]').click()
    details = page.locator("#map-details").inner_text()
    assert "Налёт СНЭ" in details and "Посадки ППР" in details, details
    assert page.locator(".map-wires line").count() > 0
    # A rule changed after a posting applies only to future work.
    board()
    aircraft_form()
    card = page.locator("article[data-form-widget]").filter(has=page.get_by_text("Налёт СНЭ", exact=True))
    card.locator("[data-column-rule]").click()
    row = page.locator("[data-rule-id]").filter(has=page.locator('[data-rule=name][value="Налёт СНЭ"]'))
    row.locator("[data-rule=factor]").fill("3")
    page.locator("#aggregate-rules-form button[type=submit]").click()
    page.locator("#add-form-column").wait_for()
    board()
    save_work()
    assert readings() == [120, 50, 103, 12, 3]
    page.locator("[data-view=usage-map]").click()
    page.locator("#map-work").select_option(index=2)
    page.locator('[data-map-select="__airframe"]').click()
    assert "20 мин" in page.locator("#map-details").inner_text()
    assert not errors, errors
    print("PASS: replaced four original cards, preserved existing work and balances, checked edited rule, separate PPR and actual map after reload")
