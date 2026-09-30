"""场景 2（点名酒店 + 点名地点 + 固定时间）端到端截图。用法：python3 scripts/shoot_case2.py [http://localhost:8890] [前缀 real-case2-] [输出目录]
在首页输入框里打字 → 发送（大模型解析）→ 追问 → 开始规划（百度）→ 过程日志 → 总览 → 第 1 天 → 第 2 天 → 酒店核对 → 调用日志"""
import pathlib, sys, json
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8890'
PREFIX = sys.argv[2] if len(sys.argv) > 2 else 'real-case2-'
OUT = pathlib.Path(sys.argv[3]) if len(sys.argv) > 3 else ROOT / 'shots'; OUT.mkdir(parents=True, exist_ok=True)
TEXT = '10月5日去上海，住上海虹桥家庭酒店。当天下午1点去仙霞网球场打球，打完回酒店，下午5点去浦东美术馆看展，再回酒店。第二天早上9点去仙霞网球馆打球，中午12点去旗忠网球中心看网球比赛。'
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
    def scroll(sel, y): pg.evaluate(f"document.querySelector('{sel}').scrollTop = {y}"); pg.wait_for_timeout(150)
    pg.goto(f'{BASE}/?shot=1#1'); pg.wait_for_function('window.__ready === true', timeout=30000); pg.wait_for_timeout(400)
    pg.fill('#chatInput', TEXT); shot('01-home-input')
    pg.click('#sendBtn'); pg.wait_for_function("document.querySelectorAll('#taskList .check-item').length > 0", timeout=120000); pg.wait_for_timeout(300)
    scroll('#s2scroll', 0); shot('02-task')
    scroll('#s2scroll', 9999); pg.click('#askRow .ask-btn[data-f="0"]'); pg.wait_for_timeout(200); shot('02b-task-followups')
    pg.click('#s2go'); pg.wait_for_function('window.__app.S.pipelineDone === true', timeout=240000); pg.wait_for_timeout(400)
    scroll('#s3scroll', 0); shot('03-process')
    pg.evaluate("(() => { const s = document.querySelector('#s3scroll'), el = [...document.querySelectorAll('#activity .act-item')].find(e => /路线规划/.test(e.textContent)); if (el) s.scrollTop = el.offsetTop - s.offsetTop - 60; })()"); pg.wait_for_timeout(150); shot('03b-process-routes')
    scroll('#s3scroll', 99999); shot('03c-process-end')
    pg.click('.step-btn[data-step="6"]'); pg.wait_for_timeout(900); shot('04-overview')
    scroll('#ovScroll', 9999); shot('04b-overview-days')
    pg.click('#dayCards .day-card[data-day="d1"]'); pg.wait_for_timeout(900); shot('05-day1')
    pg.evaluate("(() => { const d = document.querySelector('#drawer'); d.scrollTop = 9999; })()"); pg.wait_for_timeout(200); shot('05b-day1-list')
    pg.evaluate("document.querySelector('#drawer').scrollTop = 0"); pg.click('#dayPills button[data-day="d2"]'); pg.wait_for_timeout(900); shot('06-day2')
    pg.evaluate("(() => { const d = document.querySelector('#drawer'); d.scrollTop = 9999; })()"); pg.wait_for_timeout(200); shot('06b-day2-list')
    pg.click('.step-btn[data-step="4"]'); pg.wait_for_timeout(900); shot('07-hotel')
    pg.click('#logBtn'); pg.wait_for_timeout(400); shot('08-call-log')
    dump = pg.evaluate("""(() => { const S = window.__app.S, P = window.Planner;
      const net = S.log.filter(e => e.kind === 'api');
      return { log: S.log.map(e => [e.kind, e.lab, e.api || '', e.mock ? 'MOCK ' + (e.reason || '') : '', e.detail || '', e.ms]),
        hotel: S.hotel && { name: S.hotel.name, address: S.hotel.address, lat: S.hotel.lat, lng: S.hotel.lng, match: S.hotel.match, note: S.hotel.note, alts: S.hotel.alts },
        stops: S.task.stops.map(x => ({ said: x.name, query: x.query, place: x.place && { name: x.place.name, address: x.place.address, lat: x.place.lat, lng: x.place.lng }, match: x.match, note: x.note, dur: x.duration_min, assumed: x.duration_is_assumed, back: x.back_to_hotel_after })),
        followups: S.task.followups, assumptions: S.task.assumptions,
        warn: document.querySelector('#goalList').innerText,
        calls: net.length, mock: net.filter(e => e.mock).length, llm: net.filter(e => /LLM/.test(e.api)).map(e => e.api + (e.mock ? ' MOCK' : '')) }; })()""")
    tl = []
    for d in ['d1', 'd2']:
        pg.evaluate(f"window.__app.S.day = '{d}'; window.__app.renderTimeline()")
        tl.append(pg.evaluate("document.querySelector('#daySummary').innerText + '\\n' + document.querySelector('#timeline').innerText"))
    dump['timeline'] = tl
    (OUT / f'{PREFIX}dump.json').write_text(json.dumps(dump, ensure_ascii=False, indent=1))
    print('map:', 'Baidu GL' if pg.evaluate('!!window.__useBaidu') else 'SVG fallback', '| calls', dump['calls'], 'mock', dump['mock'], '| llm', dump['llm'])
    b.close()
print('errors:', errors or 'none')
