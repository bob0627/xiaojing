"""v2 M4：拼车接送（上车点核对 → 接人顺序 → 途经点路线 → 倒推每人几点下楼 → 分享页 + 司机按钮）。
用法：python3 scripts/shoot_v2m4.py [http://localhost:8890] [前缀 real-v2-M4-] [输出目录]"""
import pathlib, sys, json
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8890'
PREFIX = sys.argv[2] if len(sys.argv) > 2 else 'real-v2-M4-'
OUT = pathlib.Path(sys.argv[3]) if len(sys.argv) > 3 else ROOT / 'shots'; OUT.mkdir(parents=True, exist_ok=True)
TEXT = '周六小王开车从漕河泾开发区出发，先到徐家汇接我，再去静安寺接小李，一起去旗忠网球中心看比赛，12点前到，回来反过来送'
TEXT2 = '周六小王开车接我和B去旗忠网球中心看比赛，12点前到'
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

    POOL = """(() => { const A = window.__app.S, G = A.pool && A.pool.go, hm = window.Carpool.hm; if (!G) return null; const s = G.sched;
      return { order: G.riders.map(r => r.name), legs_min_raw: G.legs, legs_buffered: s.legs, km: +G.km.toFixed(1), depart: hm(s.depart), arrive: hm(s.arrive),
        riders: G.riders.map((r, j) => ({ name: r.name, at: r.pt.name, match: r.pt.match, down: hm(s.stops[j].down), car: hm(s.stops[j].car), leave: hm(s.stops[j].leave) })),
        opt: A.pool.opt ? { tried: A.pool.opt.tried, said: [A.pool.opt.said.order, A.pool.opt.said.total], fast: [A.pool.opt.fast.order, A.pool.opt.fast.total], fair: [A.pool.opt.fair.order, A.pool.opt.fair.maxRide] } : null,
        back: A.pool.back ? { end: hm(A.pool.back.end), drops: A.pool.back.sched.drops.map(d => hm(d.at)), home: hm(A.pool.back.sched.end), km: +A.pool.back.km.toFixed(1) } : null,
        trip: A.pool.trip ? A.pool.trip.id : null, driverFrom: A.poolIn.pts.driver.name, dest: A.poolIn.pts.dest.name, mock: G.mock }; })()"""
    def sheet_scroll(y):
        pg.evaluate(f"(() => {{ const s = document.querySelector('#poolSheet'); s.scrollTop = {y}; }})()"); pg.wait_for_timeout(250)
    def verify_and_go():
        pg.click('.fs-ok[data-act="carpool"]')
        pg.wait_for_function("window.__app.S.poolIn && !window.__app.S.poolIn.verifying && (window.__app.S.poolIn.ready || window.__app.S.poolIn.err)", timeout=180000); pg.wait_for_timeout(300)
        err = pg.evaluate("window.__app.S.poolIn.err || ''")
        if err: errors.append('verify: ' + err); return False
        pg.click('#s2go'); pg.wait_for_function('window.__app.S.pipelineDone === true && window.__app.S.pool && window.__app.S.pool.go', timeout=300000); pg.wait_for_timeout(1200)
        return True

    # ---- A：原话里都说了 ----
    start(TEXT)
    res['A_parse'] = pg.evaluate("(() => { const t = window.__app.S.task, f = t.followups.find(x => x.type === 'carpool') || {}; return { scenario: t.scenario.primary, reason: t.scenario.reason, date: t.start_date, people: t.people, card: { driver: f.driver, from: f.driverFrom, riders: f.riders, dest: f.dest, deadline: f.deadline, back: f.back, purpose: f.purpose }, asks: t.followups.map(x => (x.type || x.id) + ': ' + x.question) }; })()")
    res['A_order'] = order()
    pg.click('#s2go'); pg.wait_for_timeout(300); res['A_go_blocked'] = pg.evaluate("document.querySelector('#toast').textContent")
    pg.evaluate("document.querySelector('#s2scroll').scrollTop = 0"); pg.wait_for_timeout(150); shot('01-task-card')
    if verify_and_go():
        res['A_pool'] = pg.evaluate(POOL)
        sheet_scroll(0); shot('02-pool-map')
        sheet_scroll(330); shot('03-pool-cards')
        sheet_scroll(900); shot('03b-pool-riders-back')
        opt = res['A_pool'].get('opt')
        if opt and opt['fast'][0] != opt['said'][0] and pg.locator('[data-cporder="fast"]').count():
            pg.click('[data-cporder="fast"]'); pg.wait_for_function("window.__app.S.pool.go.order.join() === '" + ','.join(map(str, opt['fast'][0])) + "'", timeout=120000); pg.wait_for_timeout(800)
            res['A_pool_fast'] = pg.evaluate(POOL)
            pg.click('[data-cporder="said"]'); pg.wait_for_function("window.__app.S.pool.go.order.join() === '" + ','.join(map(str, opt['said'][0])) + "'", timeout=120000); pg.wait_for_timeout(800)
        res['A_calls'] = calls()
        T = pg.evaluate("window.__app.S.pool.trip")
        if T:
            sp = pg.context.new_page(); sp.on('pageerror', lambda e: errors.append('share pageerror: ' + str(e)))
            def share(as_, key=None, name=''):
                sp.goto('about:blank'); sp.goto(f"{BASE}/?shot=1&trip={T['id']}&as={as_}" + (f"&k={key}" if key else '')); sp.wait_for_function('window.__ready === true', timeout=30000); sp.wait_for_timeout(1500)
                try: sp.wait_for_function('!window.MapView || !MapView.idle || MapView.idle()', timeout=15000)
                except Exception: pass
                sp.wait_for_timeout(1200)
                if name: sp.locator('#phoneWrap').screenshot(path=str(OUT / f'{PREFIX}{name}.png'))
                return sp.evaluate("document.querySelector('#poolWhy').innerText + ' || ' + [...document.querySelectorAll('#poolBody .pool-card')].map(c => c.innerText.replace(/\\s+/g, ' ')).join(' | ')")
            res['S_rider1_before'] = share('1', None, '04-share-rider-before')
            res['S_driver_before'] = share('d', T['key'])
            sp.click('[data-ev="depart"]'); sp.wait_for_timeout(2500)
            res['S_driver_after_depart'] = sp.evaluate("document.querySelector('#poolWhy').innerText + ' || ' + [...document.querySelectorAll('#poolBody button')].map(b => b.innerText).join(',')")
            sp.locator('#phoneWrap').screenshot(path=str(OUT / f'{PREFIX}05-share-driver.png'))
            res['S_rider1_live'] = share('1', None, '06-share-rider-live')
            share('d', T['key']); sp.click('[data-ev="picked"]'); sp.wait_for_timeout(2500)
            res['S_rider2_after_pick1'] = share('2', None, '07-share-rider2-after-pick')
            share('d', T['key']); sp.click('[data-ev="reset"]'); sp.wait_for_timeout(1000)
            sp.close()

    # ---- B：原话没说上车点 → 卡片里填 ----
    start(TEXT2)
    res['B_parse'] = pg.evaluate("(() => { const t = window.__app.S.task, f = t.followups.find(x => x.type === 'carpool') || {}; return { scenario: t.scenario.primary, card: { driver: f.driver, from: f.driverFrom, riders: f.riders, dest: f.dest, deadline: f.deadline }, asks: t.followups.map(x => (x.type || x.id)) }; })()")
    if pg.locator('.fs-ok[data-act="carpool"]').count():
        pg.click('.fs-ok[data-act="carpool"]'); pg.wait_for_timeout(500); res['B_missing'] = pg.evaluate("window.__app.S.poolIn.err")
        pg.fill('#cpFrom', '虹桥天地'); pg.fill('.cp-ra[data-i="0"]', '徐家汇'); pg.fill('.cp-ra[data-i="1"]', '莘庄地铁站')
        if verify_and_go():
            res['B_pool'] = pg.evaluate(POOL); sheet_scroll(0); shot('08-B-pool-map')
    res['B_calls'] = calls()
    (OUT / f'{PREFIX}dump.json').write_text(json.dumps(res, ensure_ascii=False, indent=1))
    print(json.dumps(res, ensure_ascii=False, indent=1))
    b.close()
print('errors:', errors or 'none')
