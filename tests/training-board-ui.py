"""Replay the four original example shifts against the seven logbooks of board 89."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EX = ROOT / "examples"
KEY = "aviation-resource-prototype-v1"
# starts, recorded runtime (minutes), B/UB/OR cycles, independent B/UB/OR seconds
SHIFTS = [
    ("2026-10-30","1",None,None, {"left": (1,9,1,0,0,15,0,0)}),
    ("2026-10-31","0","00:45",1, {"left": (2,53,1,2,1,32,45,8), "right": (1,50,0,1,0,0,36,0)}),
    ("2026-11-01","2",None,0, {"right": (1,12,1,0,0,21,0,0)}),
    ("2026-11-02","0","01:10",3, {"left": (1,75,0,1,2,0,28,61), "right": (2,79,2,1,1,55,47,19)}),
]

# Two separately posted entries on the only elapsed date after the 24 November reading.
# Durations for the example are independent register inputs, in minutes or seconds as labelled.
LATER = [
    {"flight": 20, "landings": 1, "sides": [
        (5,10,12,20, 2,12,36), (10,15,14,20, 4,18,44)]},
    {"flight": 30, "landings": 2, "sides": [
        (10,15,18,30, 3,24,49), (5,10,16,30, 5,31,56)]},
]
# Invented readings on 24 November for the copy only. Units match the archived columns.
VKA_OPENINGS = {
    "vka-left": {"Максимал ОР":60, "Максимал Б + ОР":3600, "Максимал Б + УБ":7200,
                 "Суммарная наработка Б":180, "Суммарная наработка Б + УБ":240},
    "vka-right": {"Максимал ОР":120, "Максимал Б + ОР":10800, "Максимал Б + УБ":14400,
                  "Суммарная наработка Б":300, "Суммарная наработка Б + УБ":360},
}

def minutes(n):
    return f"{n//60:02}:{n%60:02}"

def post_later(page):
    for i,entry in enumerate(LATER, 1):
        page.locator("[data-view=shift]").first.click()
        page.locator("[name=date]").fill("2026-11-25")
        page.locator('[name=operationType][value="0"]').check()
        board=page.locator('[data-template-scope=board]')
        board.locator('[data-template-field=flight]').fill(minutes(entry["flight"]))
        board.locator('[data-template-field=_note]').fill(f"Проверка {i}")
        board.locator('[data-template-field=runway]').fill(str(entry["landings"]))
        for side, (ground, ground_all, air, air_all, first, second, third) in zip(("left","right"),entry["sides"],strict=True):
            engine=page.locator(f'[data-template-scope=engine-{side}]')
            for field,value in {"starts":"1","cycle-b":"1","archive-reading-1":"1",
                                "ground-b":minutes(ground),"ground-bub":minutes(ground_all),
                                "air-b":minutes(air),"air-bub":minutes(air_all),
                                "archive-reading-2":clock(first),"archive-reading-3":clock(second),
                                "archive-reading-4":clock(third)}.items():
                engine.locator(f'[data-template-field="{field}"]').fill(value)
            engine.locator('[data-template-field=cycle-ub]').select_option("1")
        page.get_by_role("button", name="Сохранить работу", exact=True).click()
        page.locator("[data-view=shift]").first.wait_for()


def clock(n):
    return f"{n//3600:02}:{n//60%60:02}:{n%60:02}"

def read(file):
    return json.loads((EX/file).read_text(encoding="utf8"))

def upload(page, data, action):
    picker = page.locator("#aircraft-template-file")
    picker.set_input_files({"name":"import.json","mimeType":"application/json","buffer":json.dumps(data).encode()})
    page.get_by_role("button",name=action,exact=True).click()

def setup(page, archive_fields):
    template = read("su-33-kza-type-exp41.json")
    template.pop("previousTemplate", None)
    if archive_fields:
        # Keep the original independent readings available in the work record.
        # They do not define either a combined meter or a ground/air split.
        for name, label, fmt in [("sample-runtime","Общее время по исходной записи","HH:MM"),
                                 ("sample-b","Б отдельно по исходной записи","HH:MM:SS"),
                                 ("sample-ub","УБ отдельно по исходной записи","HH:MM:SS")]:
            template["inputs"].append(dict(id=name,scope="engine",type="duration",format=fmt,label=label))
    upload(page,template,"Импортировать")
    page.get_by_text("Тип самолёта импортирован",exact=True).wait_for()
    upload(page,read("aircraft-89-inventory.json"),"Добавить состав борта")
    page.locator("[data-view=shift]").first.wait_for()
    page.reload()

def baseline(page, training=False):
    snapshot=read("aircraft-89-2026-11-24.json")
    if training:
        for block in snapshot["blocks"]:
            opening=VKA_OPENINGS.get(block["position"])
            if opening:
                block["totals"]=[dict(counter=i,sne=opening[c["name"]]) for i,c in enumerate(block["columns"]) if c["name"] in opening]
    upload(page,snapshot,"Внести показания")
    page.get_by_text("Показания на дату внесены",exact=True).wait_for()

def post(page):
    for day, op, flight, landings, engines in SHIFTS:
        page.locator("[data-view=shift]").first.click()
        page.locator("[name=date]").fill(day)
        page.locator(f'[name=operationType][value="{op}"]').check()
        board = page.locator('[data-template-scope=board]')
        if flight:
            board.locator('[data-template-field=flight]').fill(flight)
        if landings is not None:
            board.locator('[data-template-field=runway]').fill(str(landings))
        for side,(starts,minutes,b,ub,or_count,bs,ubs,ors) in engines.items():
            form=page.locator(f'[data-template-scope=engine-{side}]')
            for field,value in {"starts":starts,"cycle-b":b,"archive-reading-1":or_count,
                                "archive-reading-2":clock(ors),"sample-b":clock(bs),"sample-ub":clock(ubs),
                                "sample-runtime":f"{minutes//60:02}:{minutes%60:02}"}.items():
                form.locator(f'[data-template-field="{field}"]').fill(str(value))
            runs=form.locator('[data-template-group=runs]')
            while runs.locator('[data-template-row]').count()<starts:
                runs.locator('[data-template-add]').click()
            for i, flag in enumerate(runs.locator('[data-template-field=cycle-ub]').all()):
                flag.select_option("1" if i<ub else "0")
        page.get_by_role("button",name="Сохранить работу",exact=True).click()
        page.locator("[data-view=shift]").first.wait_for()

def saved(page):
    return page.evaluate("key=>JSON.parse(localStorage.getItem(key))",KEY)

def ledger(page,b):
    rows={}
    for block in b["blocks"]:
        page.locator(f'.equipment-block[data-block-id="{block["id"]}"]').click()
        rows[block["templateSlotId"]]=page.locator("#work-ledger tbody tr").evaluate_all(
            "rows=>rows.map(row=>Array.from(row.cells,c=>c.textContent))")
        page.locator(".topbar [data-action=back]").click()
    return rows

def verify(rows, board):
    inv=read("aircraft-89-inventory.json")
    assert {(b["templateSlotId"],b["serialNumber"]) for b in board["blocks"]} == {(b["position"],b["serialNumber"]) for b in inv["blocks"]}
    assert (board["totalFlightMinutes"],board["pprFlightMinutes"],board["actualLandings"],board["pprLandings"]) == (58102,25159,1254,274)
    assert [(r[0],r[2],r[7]) for r in rows["airframe"][:3]] == [
        ("31.10.2026","0:45","1"), ("01.11.2026","—","0"), ("02.11.2026","1:10","3")]
    assert all(r[3:5] == ["—","—"] and r[-2:] == ["—","—"] for r in rows["airframe"][:3])
    for side in ("left","right"):
        days=[s for s in SHIFTS if side in s[-1]]
        for kind in ("engine","vka","gtde"):
            entries=rows[kind+"-"+side][:3]
            assert len(entries)==len(days)
            for row,(day,op,flight,landings,engines) in zip(entries,days,strict=True):
                starts,minutes,b,ub,orc,bs,ubs,ors=engines[side]
                assert row[0]==".".join(reversed(day.split("-")))
                if kind=="gtde":
                    assert row[1:]==[str(starts),"—","—"]
                    continue
                assert row[1]==f"{starts}/—"
                if kind=="engine":
                    assert row[2:6]==[f"{orc}/—",str(b),str(ub),str(orc)]
                else:
                    assert row[2:5]==[str(b),str(ub),f"{orc}/—"]
                index=10 if kind=="engine" else 9
                assert row[index]==clock(ors)+" за запись" and row[index+1:]==["—"]*(len(row)-index-1)
    for shift, definition in zip(board["shifts"][:4],SHIFTS,strict=True):
        day, operation, _, _, engines=definition
        assert (shift["date"],shift["operationType"])==(day, operation)
        for item in shift["templateWork"]["engines"]:
            side=item["slotId"].split("-")[-1]
            if side not in engines:
                assert not item.get("blockId")
                continue
            _,minutes,_,_,_,bs,ubs,_=engines[side]
            fields=item["raw"]["fields"]
            assert [fields[k] for k in ("sample-runtime","sample-b","sample-ub")]==[f"{minutes//60:02}:{minutes%60:02}",clock(bs),clock(ubs)]
            assert not fields["archive-reading-3"] and not fields["archive-reading-4"]


def check_date_layout(page):
    for width in (320,360,412):
        page.set_viewport_size({"width":width,"height":740})
        for scale in ("0","1"):
            page.locator(f'#work-ledger [data-zoom="{scale}"]').click()
            for scrolled in (False, True):
                result=page.locator(".paper-scroll").evaluate("""(viewport, scrolled) => {
                    viewport.scrollLeft = scrolled ? viewport.scrollWidth : 0;
                    const dates = Array.from(viewport.querySelectorAll('tbody th.paper-date'));
                    return dates.every(cell => {
                        const rect = cell.getBoundingClientRect(), bounds = viewport.getBoundingClientRect();
                        const parts = ['.paper-day','.paper-year'].map(s => cell.querySelector(s));
                        if (parts.some(p=>!p)) return false;
                        const [day, year] = parts.map(p => {
                            const r = document.createRange(); r.selectNodeContents(p.firstChild);
                            return r.getBoundingClientRect();
                        });
                        return rect.left >= bounds.left - 1 && Math.abs(rect.left - bounds.left) < 4 &&
                            [day,year].every(r=> r.left >= rect.left && r.right <= rect.right + .5 &&
                                r.top >= rect.top - 1 && r.bottom <= rect.bottom + 1) &&
                            day.bottom <= year.top + 2 && document.documentElement.scrollWidth <= innerWidth+1;
                    });
                }""", scrolled)
                assert result,(width,scale,scrolled)
            page.locator('.paper-scroll').evaluate("v=>v.scrollLeft=0")
    page.locator('#work-ledger [data-zoom="0"]').click()
    page.set_viewport_size({"width":360,"height":740})


def check_new_rows(page,board):
    # Fixed expected deltas in each of the two shifts. Compare the UI at BOTH points.
    day_totals={"left":[(13,22),(20,33)],"right":[(16,23),(17,32)]}
    snapshot=read("aircraft-89-2026-11-24.json")
    for block in board["blocks"]:
        slot=block["templateSlotId"]
        page.locator(f'.equipment-block[data-block-id="{block["id"]}"]').click()
        sheet=page.locator("#work-ledger")
        # The date is printed on two lines. Read the original caption including punctuation.
        rows=sheet.locator("tbody tr").filter(has=page.locator("th.paper-date",has_text="25.11.2026"))
        assert rows.count()==2,slot
        if slot=="airframe":
            check_date_layout(page)
            for i,(flight,ppr,sne,landings) in enumerate([("0:20","418:49","967:52","1252"),("0:30","419:19","968:22","1254")]):
                fields=rows.nth(i).locator("td").all_text_contents()
                assert fields[1:4]==[flight,ppr,sne] and fields[-1].replace("\xa0","")==landings
        elif slot.startswith("gtde"):
            base=188 if slot.endswith("left") else 190
            for i in range(2):
                assert rows.nth(i).locator("td").all_text_contents()==["1","—",str(base+i+1)]
        else:
            source=next(b for b in snapshot["blocks"] if b["position"]==slot)
            side=slot.split("-")[1]
            is_engine=slot.startswith("engine")
            base=({source["columns"][t["counter"]]["name"]:t["ppr"] for t in source["totals"]}
                  if is_engine else VKA_OPENINGS[slot])
            labels=("Максимал ОР","Максимал Б + ОР","Максимал Б + УБ","Суммарная наработка Б","Суммарная наработка Б + УБ")
            balances=[base[label] for label in labels]
            sheet.locator("[data-entry-amounts]").click()
            for i,entry in enumerate(LATER):
                vals=entry["sides"][0 if side=="left" else 1]
                cells=rows.nth(i).locator("td")
                offset=5 if is_engine else 4
                assert cells.all_text_contents()[offset:offset+4]==list(map(minutes,vals[:4]))
                for j,amount in enumerate((*vals[4:],*day_totals[side][i])):
                    balances[j]+=amount
                    fmt=clock if j<3 else minutes
                    pair=cells.nth(offset+4+j).locator(".paper-duration-pair > span").all_text_contents()
                    assert pair==["+"+fmt(amount),"Σ "+fmt(balances[j])],(slot,i,labels[j],pair)
            sheet.locator("[data-entry-amounts]").click()
        page.locator(".topbar [data-action=back]").click()


def main():
    with sync_playwright() as pw:
        browser=pw.chromium.launch()
        def fresh():
            page=browser.new_page(viewport={"width":360,"height":740},has_touch=True,is_mobile=True)
            page.set_default_timeout(3500)
            page.goto((ROOT/"index.html").as_uri())
            return page
        page=fresh()
        setup(page,True)
        baseline(page,True)
        page.locator("[data-aircraft-id]").click()
        post(page)
        post_later(page)
        page.reload()
        workspace=saved(page)
        b=workspace["aircraft"][0]
        assert b["serialNumber"]=="49051004189" and b["boardNumber"]=="89" and len(b["shifts"])==6
        page.locator("[data-aircraft-id]").click()
        rows=ledger(page,b)
        verify(rows,b)
        if "--bundle" in sys.argv:
            b["trainingReadingNotes"]={slot:
                "На 24.11.2026 для проверки заданы учебные показания ВКА. Б + ОР " +
                clock(v["Максимал Б + ОР"]) + ", Б + УБ " + clock(v["Максимал Б + УБ"]) +
                ". Суммарная наработка Б " + minutes(v["Суммарная наработка Б"]) + ", Б + УБ " +
                minutes(v["Суммарная наработка Б + УБ"]) + "."
                for slot,v in VKA_OPENINGS.items()}
            workspace["globalNotifications"]=False
            b["notifications"]=False
            data=json.dumps(workspace,ensure_ascii=False,separators=(",",":"))
            (ROOT/"src/training-board.js").write_text("// Generated by tests/training-board-ui.py --bundle.\nglobalThis.trainingBoard = "+data+";\n",encoding="utf8")
        checked=fresh()
        setup(checked,False)
        baseline(checked)
        original=saved(checked)["aircraft"]
        # An exp.46 installation may already have a privately edited copy.
        checked.evaluate("""key=>{
            const main=JSON.parse(localStorage.getItem(key));
            main.training89=structuredClone(main);
            main.training89.aircraft[0].rfNumber='edited-in-earlier-copy';
            localStorage.setItem(key, JSON.stringify(main));
        }""",KEY)
        checked.reload()
        previous=saved(checked)["training89"]
        checked.locator("#open-previous-training").click()
        assert "edited-in-earlier-copy" in checked.locator(".board-identifiers").inner_text()
        checked.locator(".topbar [data-action=back]").click()
        checked.locator("#open-training-board").click()
        assert "тестовая копия" in checked.locator("header").inner_text()
        installed=checked.evaluate("trainingBoard.aircraft[0]")
        verify(ledger(checked,installed), installed)
        check_new_rows(checked,installed)
        checked.locator('.topbar [data-action=back]').click()
        assert saved(checked)["aircraft"]==original and checked.locator("[data-aircraft-id]").count()==1
        checked.locator("#open-training-board").click()
        checked.locator("[data-view=shift]").first.click()
        checked.locator("[name=date]").fill("2026-11-25")
        checked.locator("[data-template-field=runway]").fill("1")
        checked.get_by_role("button",name="Сохранить работу",exact=True).click()
        checked.reload()
        after=saved(checked)
        assert after["aircraft"]==original and after["training89"]==previous
        copy=after["training89Nov25"]["aircraft"][0]
        assert len(copy["shifts"])==7 and copy["actualLandings"]==1255
        checked.locator("#open-training-board").click()
        copied_rows=ledger(checked,copy)
        assert copied_rows["airframe"][-1][-1].replace("\xa0","").replace(" ","")=="1255"
        print("PASS: six shifts; two post-baseline postings in seven ledgers; four separate accumulated totals; two-line dates at 320, 360, 412 pixels, zoom and horizontal scrolling; restart and edit")
        browser.close()

if __name__=="__main__":
    main()
