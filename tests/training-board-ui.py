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

def baseline(page):
    upload(page,read("aircraft-89-2026-11-24.json"),"Внести показания")
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
    assert (board["totalFlightMinutes"],board["pprFlightMinutes"],board["actualLandings"],board["pprLandings"]) == (58052,25109,1251,271)
    assert [(r[0],r[2],r[7]) for r in rows["airframe"]] == [
        ("31.10.2026","0:45","1"), ("01.11.2026","—","0"), ("02.11.2026","1:10","3")]
    assert all(r[3:5] == ["—","—"] and r[-2:] == ["—","—"] for r in rows["airframe"])
    for side in ("left","right"):
        days=[s for s in SHIFTS if side in s[-1]]
        for kind in ("engine","vka","gtde"):
            entries=rows[kind+"-"+side]
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
    for shift, definition in zip(board["shifts"],SHIFTS,strict=True):
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
        baseline(page)
        page.locator("[data-aircraft-id]").click()
        post(page)
        page.reload()
        workspace=saved(page)
        b=workspace["aircraft"][0]
        assert b["serialNumber"]=="49051004189" and b["boardNumber"]=="89" and len(b["shifts"])==4
        page.locator("[data-aircraft-id]").click()
        rows=ledger(page,b)
        verify(rows,b)
        if "--bundle" in sys.argv:
            workspace["globalNotifications"]=False
            b["notifications"]=False
            data=json.dumps(workspace,ensure_ascii=False,separators=(",",":"))
            (ROOT/"src/training-board.js").write_text("// Generated by tests/training-board-ui.py --bundle.\nglobalThis.trainingBoard = "+data+";\n",encoding="utf8")
        checked=fresh()
        setup(checked,False)
        baseline(checked)
        original=saved(checked)["aircraft"]
        checked.locator("#open-training-board").click()
        assert "тестовая копия" in checked.locator("header").inner_text()
        installed=checked.evaluate("trainingBoard.aircraft[0]")
        verify(ledger(checked,installed), installed)
        checked.locator('.topbar [data-action=back]').click()
        assert saved(checked)["aircraft"]==original and checked.locator("[data-aircraft-id]").count()==1
        checked.locator("#open-training-board").click()
        checked.locator("[data-view=shift]").first.click()
        checked.locator("[name=date]").fill("2026-11-25")
        checked.locator("[data-template-field=runway]").fill("1")
        checked.get_by_role("button",name="Сохранить работу",exact=True).click()
        checked.reload()
        after=saved(checked)
        assert after["aircraft"]==original
        copy=after["training89"]["aircraft"][0]
        assert len(copy["shifts"])==5 and copy["actualLandings"]==1252
        checked.locator("#open-training-board").click()
        copied_rows=ledger(checked,copy)
        assert copied_rows["airframe"][-1][-1].replace("\xa0","").replace(" ","")=="1252"
        print("PASS: four original dates, seven independent ledgers, cutoff, restart, isolated copy and subsequent edit")
        browser.close()

if __name__=="__main__":
    main()
