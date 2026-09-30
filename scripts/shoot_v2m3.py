"""v2 M3：碎片时间推荐（空档「附近逛逛」+ 场景5 直接说「有 X 小时空」）。
用法：python3 scripts/shoot_v2m3.py [http://localhost:8890] [前缀 real-v2-M3-] [输出目录]"""
import pathlib, sys, json
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8890'
PREFIX = sys.argv[2] if len(sys.argv) > 2 else 'real-v2-M3-'
OUT = pathlib.Path(sys.argv[3]) if len(sys.argv) > 3 else ROOT / 'shots'; OUT.mkdir(parents=True, exist_ok=True)
TEXT = '10月5号上午我到上海，下午1点到2点在仙霞网球场打球，四五点和朋友去浦东美术馆看展，晚上回酒店'
errors, res = [], {}
GAPS = """window.__app.findGaps().map(g => ({ key: g.key, span: g.day.date + ' ' + Math.floor(g.a.e/60) + ':' + String(g.a.e%60).padStart(2,'0') + '-' + Math.floor(g.b.s/60) + ':' + String(g.b.s%60).padStart(2,'0'), free: g.free, rest: g.rest, stay: g.stay, toH: g.toH.min, fromH: g.fromH.min, direct: g.direct.min, level: g.level }))"""
PLAN = """window.__app.S.days.map(d => d.label + ': ' + d.items.map(i => String(Math.floor(i.s / 60)).padStart(2, '0') + ':' + String(i.s % 60).padStart(2, '0') + '-' + String(Math.floor(i.e / 60)).padStart(2, '0') + ':' + String(i.e % 60).padStart(2, '0') + ' ' + (i.kind === 'hotel' ? i.label : (i.label || '') + '@' + i.name)).join(' | '))"""
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    pg = b.new_context(viewport={'width': 480, 'height': 1000}, device_scale_factor=2).new_page()
    pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    pg.on('console', lambda m: m.type == 'error' and errors.append('console: ' + m.text))
    def mapidle():
        try: pg.wait_for_function('!window.MapView || !MapView.idle || MapView.idle()', timeout=15000)
        except Exception: errors.append('map tiles not idle before screenshot')
        pg.wait_for_timeout(600 if pg.evaluate('!!window.__useBaidu') else 0)
    def shot(name): mapidle(); pg.wait_for_timeout(1200); mapidle(); pg.locator('#phoneWrap').screenshot(path=str(OUT / f'{PREFIX}{name}.png'))
    order = lambda: pg.evaluate("[...document.querySelectorAll('#askRow .fs')].map(e => e.dataset.type + (e.classList.contains('done') ? ':done' : e.classList.contains('open') ? ':open' : e.classList.contains('locked') ? ':locked' : ''))")
    def start(text):
        pg.goto('about:blank'); pg.goto(f'{BASE}/?shot=1#1'); pg.wait_for_function('window.__ready === true', timeout=30000); pg.wait_for_timeout(300)
        pg.fill('#chatInput', text); pg.click('#sendBtn')
        pg.wait_for_function("window.__app.S.task && document.querySelector('#s2intro').textContent.indexOf('正在') < 0", timeout=120000); pg.wait_for_timeout(300)
    def ov_scroll(sel):
        pg.evaluate(f"(() => {{ const s = document.querySelector('#ovScroll'), el = document.querySelector('{sel}'); if (s && el) s.scrollTop += el.getBoundingClientRect().top - s.getBoundingClientRect().top - 12; }})()"); pg.wait_for_timeout(200)
    def calls():
        net = pg.evaluate("window.__app.S.log.filter(e => e.kind === 'api').map(e => [e.api, e.mock ? 'MOCK' : 'real'])")
        return {'calls': len(net), 'mock': sum(1 for x in net if x[1] == 'MOCK')}

    FRAG = """(() => { const F = window.__app.S.frag; if (!F) return null; const hm = m => String(Math.floor(m/60)).padStart(2,'0') + ':' + String(m%60).padStart(2,'0');
      return { window: hm(F.o.start) + '-' + hm(F.o.end), from: F.o.from.name, to: F.o.to ? F.o.to.name : null, radius: F.R.m, why: F.R.why, cats: F.cats.map(c => c.label), direct: F.direct, rejected: F.rejected, feasible: F.all.length,
        picks: F.picks.map(c => ({ name: c.name, cat: c.catInfo.label, rating: c.rating, hours: c.hours, open: c.open, go: c.go.min + (c.go.mode === 'walking' ? '步行' : '打车'), back: c.back.min, stay: c.stay, leave: hm(c.leave), detour: c.detour })) }; })()"""
    def wait_frag():
        pg.wait_for_function("window.__app.S.frag !== undefined && window.__app.S.frag !== null && document.querySelector('#fragTitle').textContent.indexOf('计算中') < 0", timeout=300000); pg.wait_for_timeout(800)
    def sheet_scroll(y):
        pg.evaluate(f"(() => {{ const s = document.querySelector('#fragSheet .fs-body') || document.querySelector('#fragSheet'); s.scrollTop = {y}; }})()"); pg.wait_for_timeout(250)

    # ---- A：场景2 空档 → 附近逛逛 → 加入行程 ----
    start(TEXT)
    pg.evaluate("window.__app.S.flowOpen = 'hotel_booked'; window.__app.renderAsk()"); pg.wait_for_timeout(200)
    pg.click('.chip[data-hb="booked"]'); pg.wait_for_timeout(200); pg.fill('#hbIn', '上海静安瑞吉酒店'); pg.click('.fs-ok[data-act="hb"]')
    pg.wait_for_function("window.__app.S.hb && !window.__app.S.hb.verifying", timeout=120000); pg.wait_for_timeout(300)
    pg.click('#s2go'); pg.wait_for_timeout(500)
    res['A_order'] = order(); res['A_toast'] = pg.evaluate("document.querySelector('#toast').textContent"); res['A_asks'] = pg.evaluate("window.__app.S.task.followups.map(f => (f.type || f.id) + ': ' + f.question)")
    print('A_order', res['A_order'], res['A_toast'], res['A_asks'], flush=True)
    pg.wait_for_function('window.__app.S.pipelineDone === true', timeout=300000); pg.wait_for_timeout(400)
    pg.click('.step-btn[data-step="6"]'); pg.wait_for_timeout(1500)
    res['A_gaps'] = pg.evaluate(GAPS)
    res['A_parse'] = pg.evaluate("(() => { const t = window.__app.S.task; return { stops: t.stops.map(x => [x.name, x.date, x.start, x.end, x.duration_min, x.back_to_hotel_after]), acts: (t.activities || []).map(a => [a.kind, a.label, a.date]), plan: window.__app.S.days.map(d => d.label + ' ' + d.items.map(i => i.name + '@' + i.s + '-' + i.e).join(' | ')) }; })()")
    g = res['A_gaps'][0] if res['A_gaps'] else None
    if g:
        pg.evaluate("window.__app.S.frag = null")
        pg.click(f'.chip[data-ga="wander"][data-gap="{g["key"]}"]'); wait_frag()
        res['A_frag'] = pg.evaluate(FRAG)
        sheet_scroll(0); shot('01-gap-wander-map')
        sheet_scroll(330); shot('02-gap-wander-cards')
        if pg.locator('[data-frag="0"]').count():
            pg.click('[data-frag="0"]')
            pg.wait_for_function("window.__app.S.gapDone.length > 0", timeout=120000); pg.wait_for_timeout(2000)
            res['A_legs'] = pg.evaluate("(() => { const A = window.__app, d = A.S.days[0], pk = p => (+p.lat).toFixed(5) + ',' + (+p.lng).toFixed(5); return d.items.slice(1).map((i, k) => { const a = d.items[k], l = A.TR(a, i); return [a.name.slice(0, 8) + '→' + i.name.slice(0, 8), l.min, l.mode, l.source, !!A.S.routes.get(pk(a) + '>' + pk(i) + '|' + l.mode), i.s, i.wait]; }); })()")
            res['A_plan'] = pg.evaluate(PLAN); res['A_done'] = pg.evaluate("window.__app.S.gapDone"); res['A_gaps_after'] = pg.evaluate(GAPS)
            ov_scroll('#dayCards'); shot('03-gap-inserted')
    res['A_calls'] = calls()

    # ---- B/C：场景5 直接说「有 X 小时空」 ----
    for tag, text, n in [('B', '下午在静安寺，5点要到浦东美术馆，中间有2个小时空', '04'), ('C', '下午有3个小时空，在徐家汇附近', '06')]:
        start(text)
        res[tag + '_parse'] = pg.evaluate("(() => { const t = window.__app.S.task; return { scenario: t.scenario.primary, reason: t.scenario.reason, slots: document.querySelector('#slotBox') ? document.querySelector('#slotBox').innerText.replace(/\\s+/g, ' ').slice(0, 300) : '', asks: t.followups.map(f => (f.type || f.id) + ': ' + f.question + (f.type === 'frag' ? ' [' + [f.here, f.budget, f.next, f.nextAt, f.startAt].join('|') + ']' : '')) }; })()")
        res[tag + '_order'] = order()
        pg.click('#s2go'); pg.wait_for_timeout(300); res[tag + '_go_blocked'] = pg.evaluate("document.querySelector('#toast').textContent")
        if not pg.locator('.fs-ok[data-act="frag"]').count():
            errors.append(f'{tag}: 没有出现「在哪/空多久」这一步（场景={res[tag + "_parse"]["scenario"]}）'); continue
        pg.click('.fs-ok[data-act="frag"]')
        pg.wait_for_function("window.__app.S.fragIn && !window.__app.S.fragIn.verifying && (window.__app.S.fragIn.ready || window.__app.S.fragIn.err)", timeout=120000); pg.wait_for_timeout(400)
        res[tag + '_fragIn'] = pg.evaluate("(() => { const F = window.__app.S.fragIn; return { ready: F.ready, err: F.err, from: F.from && F.from.name, to: F.to && F.to.name, start: F.start, end: F.end }; })()")
        if tag == 'B': pg.evaluate("document.querySelector('#s2scroll').scrollTop = 0"); pg.wait_for_timeout(150); shot('04-s5-task')
        if not res[tag + '_fragIn']['ready']: continue
        pg.evaluate("window.__app.S.frag = null")
        pg.click('#s2go'); pg.wait_for_function('window.__app.S.pipelineDone === true', timeout=300000); wait_frag()
        res[tag + '_frag'] = pg.evaluate(FRAG); res[tag + '_screen'] = pg.evaluate("document.querySelector('.screen.active') ? document.querySelector('.screen.active').dataset.screen : null")
        sheet_scroll(0); shot(('05' if tag == 'B' else '06') + '-s5-sheet')
        sheet_scroll(330); shot(('05b' if tag == 'B' else '06b') + '-s5-cards')
        res[tag + '_links'] = pg.evaluate("[...document.querySelectorAll('#fragList .frag-card:first-child a')].map(a => a.textContent + ' ' + a.href.slice(0, 90))")
        res[tag + '_calls'] = calls()
    (OUT / f'{PREFIX}dump.json').write_text(json.dumps(res, ensure_ascii=False, indent=1))
    print(json.dumps(res, ensure_ascii=False, indent=1))
    b.close()
print('errors:', errors or 'none')
