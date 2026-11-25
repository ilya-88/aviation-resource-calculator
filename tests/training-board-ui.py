"""Exercise a complete fictional training board through the same controls as a user.
Run with --bundle to refresh the offline example after checking the recorded history.
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / "src/training-board.js"
BOARD = "У-01"
MODES = [("b", "Б"), ("ub", "УБ"), ("or", "ОР")]
SHIFTS = [
    ("2026-10-30", "check", {}, {"left": (1, 9, 1, 0, 0)}),
    ("2026-10-31", "flight", {"flight": "00:45", "runway": 1}, {"left": (2, 53, 1, 2, 1), "right": (1, 50, 0, 1, 0)}),
    ("2026-11-01", "taxi", {"runway": 0}, {"right": (1, 12, 1, 0, 0)}),
    ("2026-11-02", "flight", {"flight": "01:10", "runway": 3}, {"left": (1, 75, 0, 1, 2), "right": (2, 79, 2, 1, 1)}),
]


# Independent example durations in seconds, in the same order as MODES.
MODE_TIMES = [
    {"left": (15, 0, 0)},
    {"left": (32, 45, 8), "right": (0, 36, 0)},
    {"right": (21, 0, 0)},
    {"left": (0, 28, 61), "right": (55, 47, 19)},
]


def packet():
    def field(key, label, scope, kind, **opts):
        return dict(id=key, label=label, scope=scope, type=kind, **opts)
    positions = [dict(id="body", label="Формуляр самолёта", kind="airframe")]
    inputs = [field("flight", "Налёт", "board", "duration", format="HH:MM", role="flight"),
              field("runway", "Посадки", "board", "count", role="runway")]
    definitions = [("starts", "Запуски", "count", {"role": "starts"}),
                   ("runtime", "Время работы", "duration", {"role": "total", "format": "HH:MM"}),
                   *((key, label, "count", {}) for key, label in MODES),
                   *(("time-"+k,label,"duration",{"format":"HH:MM:SS"}) for k,label in MODES)]
    counters, rules, blocks, resources = [], [], [], []
    for key, label, kind, opts in definitions:
        inputs.append(field("in-"+key, label, "engine", kind, **({"format": opts["format"]} if kind == "duration" else {})))
        counters.append(field(key, label, "engine", kind, **opts))
        rules.append(dict(operation="copy", source="in-"+key, target=key))
    def block(slot, number, **opts):
        return dict(position=slot, serialNumber=number, manufactureDate="2020-06-01", **opts)
    blocks.append(block("body", "DEMO-001", repairs=1, lastRepairDate="2025-01-01"))
    resources.append(dict(position="body", name="Счётчик посадок", unit="шт.", limit=100, remaining=60,
                          inputs=[dict(source="runway", factor=1)]))
    for side, name, initial in [("left", "Левый", 20), ("right", "Правый", 30)]:
        journal = [dict(field="starts", label="Запуски"), dict(field="or", label="Включения ОР", withPpr=True)]
        journal += [dict(field=k, label=label, group="Циклы", perEntry=True) for k,label in MODES]
        # The three mode labels represent independent example counts entered by the user.
        journal.append(dict(field="runtime", label="Работа за смену", perEntry=True))
        mode_counters = [dict(name="Циклы "+label, columnKey="cycles-"+k, unit="шт.", factor=1,
                              source=f"position:{side}:{k}", workMode="total") for k,label in MODES]
        for key, label in MODES:
            journal.append(dict(field="time-"+key, label=label, group="Время режимов"))
            mode_counters.append(dict(name="Время "+label, columnKey="time-"+key, unit="с", factor=1,
                                      source=f"position:{side}:time-{key}", workMode="total"))
        positions.append(dict(id=side, kind="engine", label=name+" двигатель", journal=journal, usageCounters=mode_counters))
        blocks.append(block(side, "DEMO-M-"+side, repairs=1, lastRepairDate="2025-01-01",
                            readings=dict(starts=initial, pprStarts=5, sneMinutes=600, pprMinutes=120),
                            totals=[dict(counter=i, sne=10, ppr=2) for i in range(3)] +
                                   [dict(counter=i, sne=0, ppr=0) for i in range(3,6)]))
        for prefix, caption, fields in [("timer", "Счётчик времени", ["runtime"]), ("starter", "Стартер", ["starts"])]:
            slot = prefix+"-"+side
            positions.append(dict(id=slot, kind="unit", label=caption+" · "+name.lower(),
                                  engineLink=dict(source=side, counters=fields)))
            blocks.append(block(slot, "DEMO-"+slot, readings=dict(starts=0, sneMinutes=0)))
            if prefix=="starter":
                resources.append(dict(position=slot, name="Учебный лимит запусков", unit="шт.", limit=50, remaining=15,
                                      inputs=[dict(source="starts", factor=1)]))
    template = dict(id="journal-demo-01", name="Учебный двухдвигательный", schemaVersion=1, inputs=inputs,
                    positions=positions, rules=rules, engineCounters=counters, operationTypes=[
                        dict(id=k,label=v) for k,v in [("flight","Лётная смена"),("check","Опробование"),("taxi","Руление")]])
    return dict(kind="aircraft-start", version=1, template=template, aircraft=dict(boardNumber=BOARD,
                serialNumber="DEMO-001", rfNumber="DEMO01", readings=dict(actualLandings=40, pprLandings=10,
                totalFlightMinutes=1200, pprFlightMinutes=300, equivalentLandings=40), blocks=blocks, resources=resources))


def read_board(page):
    return page.evaluate("""JSON.parse(localStorage.getItem('aviation-resource-prototype-v1')).aircraft.find(b=>b.serialNumber==='DEMO-001')""")


def verify(board):
    assert len(board["shifts"]) == 4 and len(board["blocks"]) == 7
    assert [board[k] for k in ["totalFlightMinutes","pprFlightMinutes","actualLandings","pprLandings"]] == [1315,415,44,14]
    blocks = {b["templateSlotId"]: b for b in board["blocks"]}
    for side, starts, minutes, modes in [("left", 24, 737, [2,3,3]), ("right", 34, 741, [3,2,1])]:
        engine = blocks[side]
        assert (engine["starts"],engine["pprStarts"],engine["sneMinutes"],engine["pprMinutes"]) == (starts,9,minutes,minutes-480)
        for rule, amount in zip(engine["usageCounters"][:3], modes, strict=True):
            total = engine["usageTotals"][rule["id"]]
            assert [total["sne"],total["ppr"]] == [10+amount,2+amount]
        seconds = [47,73,69] if side == "left" else [76,83,19]
        for rule, amount in zip(engine["usageCounters"][3:], seconds, strict=True):
            total = engine["usageTotals"][rule["id"]]
            assert [total["sne"],total["ppr"]] == [amount,amount]
        assert blocks["starter-"+side]["starts"] == 4
        assert blocks["timer-"+side]["sneMinutes"] == minutes-600
    assert [r["remaining"] for r in board["resources"]] == [56,11,11]
    assert [s["actualLandings"] for s in board["shifts"]] == [0,1,0,3]
    assert [s["operationType"] for s in board["shifts"]] == ["check","flight","taxi","flight"]
    for s, (_, _, _, engines) in zip(board["shifts"], SHIFTS, strict=True):
        active = {e["slotId"] for e in s["templateWork"]["engines"] if e.get("blockId")}
        assert active == set(engines)
        assert {e["slotId"] for e in s["templateWork"]["units"]} == {p+"-"+side for side in engines for p in ("timer","starter")}


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width":360,"height":740}, has_touch=True, is_mobile=True)
        page.set_default_timeout(4500)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto((ROOT/"index.html").as_uri())
        page.locator("#aircraft-template-file").set_input_files(dict(name="test.json", mimeType="application/json", buffer=json.dumps(packet()).encode()))
        page.get_by_role("button", name="Импортировать борт", exact=True).click()
        for (date, operation, board, engines), durations in zip(SHIFTS, MODE_TIMES, strict=True):
            page.locator("[data-view=shift]").first.click()
            page.locator("[name=date]").fill(date)
            page.locator(f'[name=operationType][value={operation}]').check()
            def fill(slot, key, value):
                page.locator(f'[data-template-scope="{slot}"] [data-template-field="{key}"]').fill(str(value))
            for key,v in board.items():
                fill("board",key,v)
            for slot, (starts,minutes,b,ub,or_count) in engines.items():
                for key,v in zip(["starts","runtime","b","ub","or"], [starts, f"{minutes//60:02}:{minutes%60:02}",b,ub,or_count], strict=True):
                    fill(slot,"in-"+key,v)
                for (key, _), seconds in zip(MODES, durations[slot], strict=True):
                    fill(slot,"in-time-"+key,f"00:{seconds//60:02}:{seconds%60:02}")
            page.get_by_role("button", name="Сохранить работу", exact=True).click()
            page.locator("[data-view=shift]").first.wait_for()
        page.reload()
        board = read_board(page)
        verify(board)
        if "--bundle" in sys.argv:
            data = json.dumps(board, ensure_ascii=False, separators=(",",":")).replace(board["id"], "offline-training-board-01")
            BUNDLE.write_text("// Generated by tests/training-board-ui.py --bundle from four UI-entered shifts.\nglobalThis.trainingBoard = "+data+";\n", encoding="utf8")
        # On a separate fresh installation the same history is already in the APK.
        clean = browser.new_page(viewport={"width": 360, "height": 740}, has_touch=True, is_mobile=True)
        clean.on("pageerror", lambda e: errors.append(str(e)))
        clean.goto((ROOT/"index.html").as_uri())
        clean.locator("#open-training-board").click()
        built = read_board(clean)
        verify(built)
        assert built["notifications"] is False
        for block in built["blocks"]:
            slot = block["templateSlotId"]
            clean.locator(f'.equipment-block[data-block-id="{block["id"]}"]').click()
            sheet = clean.locator("#work-ledger")
            rows = sheet.locator("tbody tr")
            assert rows.count() == 3  # two flights and one ground entry for this owner
            last = rows.last.locator("td").all_text_contents()
            if slot == "body":
                assert last[1:4] == ["1:10","6:55","21:55"] and last[-2:] == ["14","44"]
            elif slot in ("left","right"):
                assert [last[0],last[1],last[5]] == (["1/9","2/5","01:15"] if slot == "left" else ["2/9","1/3","01:19"])
                assert last[-3:] == (["00:00:47","00:01:13","00:01:09"] if slot == "left" else ["00:01:16","00:01:23","00:00:19"])
                assert sheet.locator("thead abbr").first.evaluate("e=>e.closest('th').offsetWidth") <= 48
            elif slot.startswith("starter"):
                assert last[-1] == "4"
            else:
                assert last == (["01:15"] if slot.endswith("left") else ["01:19"])
            sheet.locator("select").select_option("2026-11")
            assert rows.count() == (2 if slot=="body" or slot.endswith("right") else 1)
            clean.locator(".topbar [data-action=back]").click()
        clean.locator('[data-view="usage-map"]').click()
        for i in range(1,5):
            clean.locator("#map-work").select_option(index=i)
            clean.locator(".map-wire[data-from]").first.wait_for(state="attached")
        clean.reload()
        assert clean.locator("#open-training-board").count() == 0
        assert read_board(clean) == built
        assert clean.locator("#aircraft-template-file").count() == 1
        clean.locator("[data-aircraft-id]").click()
        clean.locator("[data-view=shift]").first.click()
        clean.locator('form [name=date]').fill("2026-11-03")
        clean.locator('[data-template-scope=board] [data-template-field=runway]').fill("2")
        clean.get_by_role("button",name="Сохранить работу",exact=True).click()
        clean.reload()
        changed = read_board(clean)
        assert len(changed["shifts"]) == 5 and changed["actualLandings"] == 46
        assert changed["blocks"] == built["blocks"] and changed["resources"][0]["remaining"] == 54
        assert not errors, errors
        browser.close()
        print("PASS: four shifts, seven forms, totals, three modes, routing, resources and persistence")


if __name__ == "__main__":
    main()
