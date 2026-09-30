"""v1.4 分步追问端到端截图。用法：python3 scripts/shoot_v14.py [http://localhost:8890] [前缀 real-v14-] [输出目录]
「我要出差去上海见3个客户」→ ① 日期 → ② 客户在哪（百度核对）→ ③ 酒店偏好 → 规划 → 酒店推荐（真实地图）"""
import pathlib, sys, json
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8890'
PREFIX = sys.argv[2] if len(sys.argv) > 2 else 'real-v14-'
OUT = pathlib.Path(sys.argv[3]) if len(sys.argv) > 3 else ROOT / 'shots'; OUT.mkdir(parents=True, exist_ok=True)
TEXT = '我要出差去上海见3个客户'
CLIENTS = ['陆家嘴金融中心', '静安嘉里中心', '漕河泾开发区']
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    pg = b.new_context(viewport={'width': 480, 'height': 1000}, device_scale_factor=2).new_page()
    pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    pg.on('console', lambda m: m.type == 'error' and errors.append('console: ' + m.text))
    def mapidle():
        try: pg.wait_for_function('!window.MapView || !MapView.idle || MapView.idle()', timeout=15000)
        except Exception: errors.append('map tiles not idle before screenshot')
        pg.wait_for_timeout(600 if pg.evaluate('!!window.__useBaidu') else 0)
    def shot(name): mapidle(); pg.locator('#phoneWrap').screenshot(path=str(OUT / f'{PREFIX}{name}.png'))
    def reveal(sel, off=40): pg.evaluate(f"(() => {{ const s = document.querySelector('#s2scroll'), el = document.querySelector('{sel}'); if (el) s.scrollTop = el.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - {off}; }})()"); pg.wait_for_timeout(150)
    order = lambda: pg.evaluate("[...document.querySelectorAll('#askRow .fs')].map(e => e.dataset.type + (e.classList.contains('done') ? ':done' : e.classList.contains('open') ? ':open' : e.classList.contains('locked') ? ':locked' : ''))")
    pg.goto(f'{BASE}/?shot=1#1'); pg.wait_for_function('window.__ready === true', timeout=30000); pg.wait_for_timeout(300)
    pg.fill('#chatInput', TEXT); pg.click('#sendBtn')
    pg.wait_for_function("document.querySelectorAll('#taskList .check-item').length > 0", timeout=120000); pg.wait_for_timeout(300)
    steps = {'initial': order(), 'followups': pg.evaluate("window.__app.S.task.followups.map(f => (f.type || f.id) + ': ' + f.question)")}
    reveal('.flow', 150); shot('01-ordered-followups')
    # 试着直接开始：应被拦住
    pg.click('#s2go'); pg.wait_for_timeout(400); steps['go_blocked'] = pg.evaluate("document.querySelector('#toast').textContent"); steps['screen_after_go'] = pg.evaluate("location.hash")
    pg.fill('#fdA', '2026-10-12'); pg.fill('#fdB', '2026-10-13'); pg.click('.fs-ok[data-act="dates"]'); pg.wait_for_timeout(300)
    steps['after_dates'] = order()
    for i, c in enumerate(CLIENTS): pg.fill(f'.fc-in[data-i="{i}"]', c)
    pg.click('.fs-ok[data-act="clients"]')
    pg.wait_for_function("window.__app.S.task.clients.every(c => !c.verifying) && window.__app.S.task.clients.every(c => c.verified || c.notFound)", timeout=180000); pg.wait_for_timeout(300)
    steps['after_clients'] = order()
    pg.evaluate("window.__app.S.flowOpen = 'clients'; window.__app.renderAsk()"); reveal('.fs[data-type=clients]', 60); shot('02-client-verify')
    # v2：酒店一步变成「酒店订好了吗」→ 还没订 → 偏好（v1.4 是直接问偏好）
    htype = pg.evaluate("window.__app.S.task.followups.some(f => f.type === 'hotel_booked') ? 'hotel_booked' : 'hotel'")
    pg.evaluate(f"window.__app.S.flowOpen = '{htype}'; window.__app.renderAsk()")
    if htype == 'hotel_booked': pg.click('.chip[data-hb="recommend"]'); pg.wait_for_timeout(200)
    pg.click('.chip[data-price="500–800"]'); pg.click('.chip[data-tag="近地铁"]'); reveal('.flow', 40); shot('03-hotel-prefs')
    pg.click('.fs-ok[data-act="hbrec"]' if htype == 'hotel_booked' else '.fs-ok[data-act="hotel"]'); pg.wait_for_timeout(300); steps['after_hotel'] = order()
    pg.evaluate("document.querySelector('#s2scroll').scrollTop = 0"); pg.wait_for_timeout(150); shot('03b-task-ready')
    pg.click('#s2go'); pg.wait_for_function('window.__app.S.pipelineDone === true', timeout=300000); pg.wait_for_timeout(400)
    pg.evaluate("document.querySelector('#s3scroll').scrollTop = 0"); pg.wait_for_timeout(150); shot('04-process')
    pg.evaluate("(() => { const s = document.querySelector('#s3scroll'), el = [...document.querySelectorAll('#activity .act-item')].find(e => /近地铁/.test(e.textContent)); if (el) s.scrollTop = el.offsetTop - s.offsetTop - 380; })()"); pg.wait_for_timeout(150); shot('04b-process-metro')
    pg.click('.step-btn[data-step="4"]'); pg.wait_for_timeout(1200); shot('05-hotel-pick')
    pg.evaluate("(() => { const s = document.querySelector('[data-screen=\"4\"] .scroll'); if (s) s.scrollTop = 420; })()"); pg.wait_for_timeout(300); shot('05b-hotel-card')
    pg.click('.step-btn[data-step="6"]'); pg.wait_for_timeout(1200); shot('06-overview')
    dump = pg.evaluate("""(() => { const S = window.__app.S; const net = S.log.filter(e => e.kind === 'api');
      return { clients: S.task.clients.map(c => ({ said: c.said, name: c.place, address: c.address, lat: c.lat, lng: c.lng, match: c.match, note: c.note, date: c.date, start: c.start, end: c.end })),
        dates: S.task.dates, hotelPref: S.task.hotel, top: S.top.map(r => ({ name: r.hotel.name, address: r.hotel.address, price: r.hotel.price, rating: r.hotel.rating, metro: r.hotel.metro, score: r.score, avg: Math.round(r.avg), commutes: r.commutes.map(c => c.min) })),
        picked: S.hotel && S.hotel.name, log: S.log.map(e => [e.kind, e.lab, e.api || '', e.mock ? 'MOCK ' + (e.reason || '') : '', e.detail || '', e.ms]),
        calls: net.length, mock: net.filter(e => e.mock).length, llm: net.filter(e => /LLM/.test(e.api)).map(e => e.api + (e.mock ? ' MOCK' : '')) }; })()""")
    dump['steps'] = steps
    (OUT / f'{PREFIX}dump.json').write_text(json.dumps(dump, ensure_ascii=False, indent=1))
    print('steps', json.dumps(steps, ensure_ascii=False))
    print('map:', 'Baidu GL' if pg.evaluate('!!window.__useBaidu') else 'SVG fallback', '| calls', dump['calls'], 'mock', dump['mock'], '| llm', dump['llm'], '| picked', dump['picked'])
    b.close()
print('errors:', errors or 'none')
