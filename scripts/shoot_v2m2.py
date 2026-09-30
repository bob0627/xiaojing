"""v2 M2：场景2 完整流程（时间段、酒店订好了吗、没订→按地点中心推荐+跳转链接、空档 > 60 分钟 → 回酒店/另有安排）。
用法：python3 scripts/shoot_v2m2.py [http://localhost:8890] [前缀 real-v2-M2-] [输出目录]"""
import pathlib, sys, json
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8890'
PREFIX = sys.argv[2] if len(sys.argv) > 2 else 'real-v2-M2-'
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

    # ---- 分支 1：酒店还没订 → 按两个地点中心推荐 ----
    start(TEXT)
    res['parse'] = pg.evaluate("(() => { const t = window.__app.S.task; return { scenario: t.scenario.primary, stops: t.stops.map(x => [x.name, x.start, x.end, x.duration_min, x.duration_from]), arrive: t.time && t.time.arrive_part, hotel: t.hotel.status, asks: t.followups.map(f => (f.type || f.id) + ': ' + f.question) }; })()")
    res['order0'] = order()
    pg.evaluate("document.querySelector('#s2scroll').scrollTop = 0"); pg.wait_for_timeout(150); shot('01-task-slots')
    pg.click('#s2go'); pg.wait_for_timeout(400); res['go_blocked'] = pg.evaluate("document.querySelector('#toast').textContent")
    pg.click('.chip[data-hb="recommend"]'); pg.wait_for_timeout(200); pg.click('.fs-ok[data-act="hbrec"]'); pg.wait_for_timeout(300)
    res['order1'] = order()
    pg.click('#s2go'); pg.wait_for_function('window.__app.S.pipelineDone === true', timeout=300000); pg.wait_for_timeout(400)
    pg.click('.step-btn[data-step="4"]'); pg.wait_for_timeout(1500)
    res['hotels'] = pg.evaluate("window.__app.S.top.map(r => ({ name: r.hotel.name, address: r.hotel.address, price: r.hotel.price, rating: r.hotel.rating, avg: Math.round(r.avg), commutes: r.commutes.map(c => c.min), score: r.score }))")
    res['deeplinks'] = pg.evaluate("[...document.querySelectorAll('#hotelScroll .hotel-card:first-child .deep a')].map(a => a.textContent + ' ' + a.href)")
    pg.evaluate("(() => { const s = document.querySelector('[data-screen=\"4\"] .scroll'); if (s) s.scrollTop = 330; })()"); pg.wait_for_timeout(300); shot('02-hotel-rec-links')
    pg.click('#hotelScroll .hotel-card:first-child .pick'); pg.wait_for_timeout(1500)
    pg.click('.step-btn[data-step="6"]'); pg.wait_for_timeout(1500)
    res['plan_before'] = pg.evaluate(PLAN); res['gaps'] = pg.evaluate(GAPS)
    ov_scroll('#gapBox'); shot('03-gap-card')
    g = res['gaps'][0] if res['gaps'] else None
    if g and g['level'] != 'no':
        pg.click(f'.chip[data-ga="hotel"][data-gap="{g["key"]}"]')
        pg.wait_for_function("window.__app.S.gapDone.length > 0 && window.__app.S.days.some(d => d.items.some(i => i.gapBack))", timeout=120000); pg.wait_for_timeout(1500)
        res['plan_after'] = pg.evaluate(PLAN); res['gaps_after'] = pg.evaluate(GAPS)
        pg.evaluate("document.querySelector('#ovScroll').scrollTop = 0"); pg.wait_for_timeout(200); shot('04-after-back-to-hotel')
        pg.click('#dayCards .day-card[data-day="d1"]'); pg.wait_for_timeout(1500); shot('05-timeline')
    res['calls1'] = calls()

    # ---- 分支 2：酒店订好了 → 核对 → 用它算空档 ----
    start(TEXT)
    res['parse2'] = pg.evaluate("(() => { const t = window.__app.S.task; return { hotel: t.hotel.status, asks: t.followups.map(f => f.type || f.id) }; })()")
    pg.evaluate("window.__app.S.flowOpen = 'hotel_booked'; window.__app.renderAsk()"); pg.wait_for_timeout(200)
    pg.click('.chip[data-hb="booked"]'); pg.wait_for_timeout(200); pg.fill('#hbIn', '上海静安瑞吉酒店'); pg.click('.fs-ok[data-act="hb"]')
    pg.wait_for_function("window.__app.S.hb && !window.__app.S.hb.verifying", timeout=120000); pg.wait_for_timeout(300)
    res['booked'] = pg.evaluate("(() => { const h = window.__app.S.hb; return h.pick ? [h.pick.name, h.pick.address, h.match] : 'notFound'; })()")
    pg.click('#s2go'); pg.wait_for_function('window.__app.S.pipelineDone === true', timeout=300000); pg.wait_for_timeout(400)
    pg.click('.step-btn[data-step="6"]'); pg.wait_for_timeout(1500)
    res['booked_plan'] = pg.evaluate(PLAN); res['booked_gaps'] = pg.evaluate(GAPS)
    ov_scroll('#gapBox'); shot('06-booked-gap')
    # 另有安排：填一个定好的地方
    g2 = res['booked_gaps'][0] if res['booked_gaps'] else None
    if g2:
        pg.click(f'.chip[data-ga="other"][data-gap="{g2["key"]}"]'); pg.wait_for_timeout(300)
        pg.fill('#gapIn', '上海自然博物馆'); pg.click('.fs-ok[data-act="otherok"]' if pg.locator('.fs-ok[data-act="otherok"]').count() else '[data-ga="otherok"]')
        pg.wait_for_function("window.__app.S.gapDone.length > 0", timeout=120000); pg.wait_for_timeout(2500)
        res['other_plan'] = pg.evaluate(PLAN)
        res['gap_done'] = pg.evaluate("window.__app.S.gapDone")
        ov_scroll('#gapBox'); shot('07-other-inserted')
    res['calls2'] = calls()
    (OUT / f'{PREFIX}dump.json').write_text(json.dumps(res, ensure_ascii=False, indent=1))
    print(json.dumps(res, ensure_ascii=False, indent=1))
    b.close()
print('errors:', errors or 'none')
