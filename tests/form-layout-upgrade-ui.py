"""Check type-layout upgrades with and without a saved per-aircraft layout."""
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "examples"
NEXT = EXAMPLES / "su-33-kza-type-exp41.json"


def check(browser, version, edit):
    context = browser.new_context()
    page = context.new_page()
    page.set_default_timeout(4500)
    page.goto((ROOT / "index.html").as_uri())

    def upload(payload, action):
        page.locator("#aircraft-template-file").set_input_files(payload)
        page.get_by_role("button", name=action, exact=True).click()

    def board():
        return page.evaluate("JSON.parse(localStorage.getItem('aviation-resource-prototype-v1')).aircraft[0]")

    previous = json.loads(NEXT.read_text(encoding="utf-8"))["previousTemplate"]
    if version == 39:
        previous = previous["previousTemplate"]
    upload({"name": "previous.json", "mimeType": "application/json",
            "buffer": json.dumps(previous).encode()}, "Импортировать")
    page.get_by_text("Шаблон импортирован", exact=True).wait_for()
    upload(EXAMPLES / "aircraft-89-inventory.json", "Добавить состав борта")
    page.locator("[data-view=shift]").wait_for()
    if edit:
        right = next(b for b in board()["blocks"] if b["templateSlotId"] == "engine-right")
        page.locator(f'[data-block-id="{right["id"]}"]').first.click()
        page.locator("#edit-form-layout").click()
        page.locator('[data-tile-key="form-field:manufactureDate"]').click()
        page.locator('[data-layout-action=hide]').click()
        page.locator("#layout-save").click()
        page.locator("#edit-form-layout").wait_for()
    before = board()
    page.reload()
    upload(NEXT, "Обновить тип")
    page.get_by_text("Тип обновлён", exact=True).wait_for()
    page.reload()
    after = board()
    left, right = [next(b for b in after["blocks"] if b["templateSlotId"] == "engine-" + side)
                   for side in ("left", "right")]
    if edit:
        assert "form-field:manufactureDate" in right["formLayout"]["hidden"]
        assert after["blocks"] == before["blocks"]
    else:
        assert left["formLayout"] == right["formLayout"]
        assert len(right["formLayout"]["tiles"]) == 34
    assert after["id"] == before["id"] and after["resources"] == before["resources"]
    context.close()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    for version in (39, 40):
        for edit in (False, True):
            check(browser, version, edit)
    print("PASS: upgrades from exp.39/40, matching defaults and preserved personal layout")

