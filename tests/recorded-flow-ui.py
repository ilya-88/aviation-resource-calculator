"""Local UI regression for a posted chain and an explicit zero on a second work record."""
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
pack = json.loads((ROOT / "examples/civil-partial-31.json").read_text(encoding="utf8"))
template = pack["template"]
template["positions"].append({"id": "meter", "label": "Счётчик", "kind": "unit",
                              "engineLink": {"source": "a", "counters": ["starts"]}})
pack["aircraft"]["blocks"].append({"position": "meter"})
template["positions"][1]["usageCounters"].append({
    "columnKey": "weighted", "name": "Доля", "unit": "шт.", "factor": 1, "workMode": "entry", "source": "formula",
    "formula": {"tokens": [{"ref": "cell:runs"}, "*", 2], "emptyZero": False},
})
pack["aircraft"]["resources"][0]["inputs"][0]["source"] = "counter:4"


def test_flow():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport={"width": 360, "height": 800})
        errors = []
        page.on("pageerror", lambda err: errors.append(str(err)))
        page.set_default_timeout(5000)
        page.goto((ROOT / "index.html").as_uri())
        page.locator("#aircraft-template-file").set_input_files({
            "name": "demo.json", "mimeType": "application/json", "buffer": json.dumps(pack).encode(),
        })
        page.get_by_role("button", name="Импортировать борт", exact=True).click()
        page.locator("[data-view=usage-map]").click()
        assert "Пока нет сохранённых работ" in page.locator("main").inner_text()
        assert page.locator(".map-wire").count() == 0

        def board():
            page.reload()
            page.locator("[data-aircraft-id]").filter(has_text="Т-31").click()

        def post(slot, value):
            board()
            page.get_by_role("button", name="Внести работу").click()
            page.locator('[name="operationType"][value="check"]').check()
            page.locator(f'[data-template-scope="{slot}"] [data-template-field="start"]').fill(value)
            page.get_by_role("button", name="Сохранить работу").click()
            page.get_by_role("button", name="Внести работу").wait_for()

        def stored():
            return page.evaluate("JSON.parse(localStorage.getItem('aviation-resource-prototype-v1')).aircraft.at(-1)")

        def paths():
            page.locator(".map-wire[data-from]").first.wait_for(state="attached")
            return {tuple(pair) for pair in page.locator(".map-wire").evaluate_all("xs=>xs.map(x=>[x.dataset.from,x.dataset.to])")}

        post("a", "2")
        first = stored()
        left = next(b for b in first["blocks"] if b.get("templateSlotId") == "a")
        rules = {r["columnKey"]: "aggregate:" + r["id"] for r in left["usageCounters"]}
        res = "resource:" + first["resources"][0]["id"]
        assert first["resources"][0]["remaining"] == 8
        board()
        page.locator("[data-view=usage-map]").click()
        expected = {("raw:a:start", rules["runs"]), ("raw:a:start", rules["check"]),
                    (rules["runs"], rules["weighted"]), (rules["weighted"], res),
                    ("raw:a:start", "position:a:starts"), ("position:a:starts", "position:meter:starts")}
        first_paths = paths()
        assert expected <= first_paths, expected - first_paths
        assert not any("raw:b:" in source for source, _ in first_paths)
        assert len(first_paths) == page.locator(".map-wire").count()
        page.locator(f'[data-map-field="{res}"]').click()
        assert "12 шт. → 8 шт." in page.locator("#map-details").inner_text()
        post("b", "0")
        board()
        page.locator("[data-view=usage-map]").click()
        latest = paths()
        assert ("raw:b:start", "position:b:starts") in latest
        assert all("raw:a:" not in source and dest != res for source, dest in latest)
        page.locator("#map-work").select_option(index=2)
        assert paths() == first_paths
        # Simulate a saved record from exp.34, which did not store native field traces.
        page.evaluate("""() => {
          const key = 'aviation-resource-prototype-v1', state = JSON.parse(localStorage.getItem(key));
          const board = state.aircraft.at(-1), shift = board.shifts[0];
          delete shift.flow;
          for (const entry of shift.aggregateAccruals) {
            delete entry.balances;
            for (const part of entry.inputs || [entry]) delete part.flowKey;
          }
          for (const entry of shift.accruals) for (const input of entry.inputs) delete input.flowKey;
          board.blocks.find(b => b.templateSlotId === 'a').usageCounters = [];
          localStorage.setItem(key, JSON.stringify(state));
        }""")
        board()
        page.locator("[data-view=usage-map]").click()
        page.locator("#map-work").select_option(index=2)
        legacy = paths()
        assert "Для старой записи" in page.locator("main").inner_text()
        assert ("raw:a:start", rules["runs"]) in legacy
        assert (rules["weighted"], res) in legacy
        assert ("raw:a:start", "position:a:starts") not in legacy
        assert not errors, errors
        print("PASS: empty history, separate recipients, actual inputs, linked copy, formula, resource balance, zero and previous work")
        browser.close()


if __name__ == "__main__":
    test_flow()
