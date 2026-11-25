"""Exercise the ledger from the aircraft screen, using the same JSON files as Android."""
import json
from datetime import date, timedelta
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EX = ROOT / "examples"
this_month = date.today().replace(day=1)
prior_month = this_month - timedelta(days=1)
source = json.loads((EX / "aircraft-89-2026-11-24.json").read_text(encoding="utf8"))
source["asOfDate"] = (prior_month - timedelta(days=1)).isoformat()


def test_ledger():
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 360, "height": 740}, has_touch=True, is_mobile=True)
        page.set_default_timeout(4500)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto((ROOT / "index.html").as_uri())

        def upload(f, action):
            page.locator("#aircraft-template-file").set_input_files(f)
            page.get_by_role("button", name=action, exact=True).click()

        upload(EX / "su-33-kza-type-exp41.json", "Импортировать")
        page.get_by_text("Тип самолёта импортирован", exact=True).wait_for()
        upload(EX / "aircraft-89-inventory.json", "Добавить состав борта")
        page.locator("[data-view=shift]").wait_for()
        page.reload()
        upload({"name": "dated.json", "mimeType": "application/json", "buffer": json.dumps(source).encode()}, "Внести показания")
        page.get_by_text("Показания на дату внесены", exact=True).wait_for()
        page.locator("[data-aircraft-id]").click()
        for day, count, flying in [(prior_month, 2, True), (this_month, 1, False)]:
            page.locator("[data-view=shift]").first.click()
            page.locator("form [name=date]").fill(day.isoformat())
            if flying:
                page.locator("[data-template-field=flight]").first.fill("00:12")
                page.locator("[data-template-field=_note]").first.fill("Учебный")
                page.locator("[data-template-field=runway]").first.fill("1")
            page.locator('[data-template-scope=engine-left] [data-template-field=starts]').first.fill(str(count))
            page.get_by_role("button", name="Сохранить работу", exact=True).click()
            page.locator("[data-view=shift]").first.wait_for()

        def board():
            return page.evaluate("JSON.parse(localStorage.getItem('aviation-resource-prototype-v1')).aircraft[0]")

        before = board()
        assert len(before["shifts"]) == 2
        page.reload()
        page.locator("[data-aircraft-id]").click()
        for block in before["blocks"]:
            slot = block["templateSlotId"]
            page.locator(f'.equipment-block[data-block-id="{block["id"]}"]').click()
            sheet = page.locator("#work-ledger")
            assert sheet.evaluate("e=>e===e.parentElement.firstElementChild")
            rows = sheet.locator("tbody tr")
            if slot == "airframe":
                assert rows.count() == 1
                assert rows.first.locator("td").all_text_contents()[:4] == ["Учебный", "0:12", "418:41", "967:44"]
            elif slot.endswith("left"):
                assert rows.count() == 2
                sheet.locator("select").select_option(this_month.isoformat()[:7])
                assert rows.count() == 1
                assert sheet.locator("tfoot tr").first.locator("td").first.inner_text() == "1"
                if slot == "gtde-left":
                    assert rows.first.locator("td").all_text_contents() == ["1", "—", "191"]
                sheet.locator("select").select_option("")
                assert sheet.locator("tfoot tr").first.locator("td").first.inner_text() == "3"
            else:
                assert "Записей пока нет" in rows.inner_text()
            sheet.get_by_role("button", name="Увеличить").click()
            assert sheet.locator("[data-zoom='0']").inner_text() == "125%"
            sheet.get_by_role("button", name="Уменьшить").click()
            assert sheet.locator("[data-zoom='0']").inner_text() == "100%"
            sheet.get_by_role("button", name="Итоги").click()
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")
            page.locator(".topbar [data-action=back]").click()
        assert board() == before and not errors, errors
        browser.close()
        print("PASS: seven forms, two months, partial entries, monthly and absolute totals, zoom and restart")


if __name__ == "__main__":
    test_ledger()
