"""v2 M1：5 栏 + 场景识别 + 新追问（定了没 / 酒店订好了吗）端到端截图。
用法：python3 scripts/shoot_v2m1.py [http://localhost:8890] [前缀 real-v2-M1-] [输出目录]"""
import pathlib, sys, json
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8890'
PREFIX = sys.argv[2] if len(sys.argv) > 2 else 'real-v2-M1-'
OUT = pathlib.Path(sys.argv[3]) if len(sys.argv) > 3 else ROOT / 'shots'; OUT.mkdir(parents=True, exist_ok=True)
errors, res = [], {}
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
    slots = lambda: pg.evaluate("document.querySelector('#slotBox').innerText")
    def start(text):
        pg.goto('about:blank'); pg.goto(f'{BASE}/?shot=1#1'); pg.wait_for_function('window.__ready === true', timeout=30000); pg.wait_for_timeout(300)
        pg.fill('#chatInput', text); pg.click('#sendBtn')
        pg.wait_for_function("window.__app.S.task && document.querySelector('#s2intro').textContent.indexOf('正在') < 0", timeout=120000); pg.wait_for_timeout(300)
    def wait_verify(expr): pg.wait_for_function(expr, timeout=120000); pg.wait_for_timeout(300)

    # A 场景不清楚 → 一道选择题
    start('帮我安排一下')
    res['A'] = {'order': order(), 'scenario': pg.evaluate("window.__app.S.task.scenario")}
    reveal('#askRow', 60); shot('01-unclear-choice')
    pg.click('.chip[data-scen="business"]')
    pg.wait_for_function("window.__app.S.task && window.__app.S.task.scenario && window.__app.S.task.scenario.source === 'user'", timeout=120000); pg.wait_for_timeout(300)
    res['A']['after_choice'] = {'order': order(), 'scenario': pg.evaluate("window.__app.S.task.scenario.primary"), 'slots': slots()}

    # B 活动没说地点 → 先问「定了没」；酒店 → 订好了 → 核对
    start('10月8号去上海，晚上和朋友吃个饭')
    res['B'] = {'initial': order(), 'slots0': slots()}
    pg.click('#s2go'); pg.wait_for_timeout(400); res['B']['go_blocked'] = pg.evaluate("document.querySelector('#toast').textContent")
    vid = pg.evaluate("window.__app.S.task.followups.find(f => f.type === 'venue').items[0].id")
    pg.click(f'.chip[data-venue="{vid}"][data-st="booked"]'); pg.wait_for_timeout(200)
    pg.fill(f'.fv-in[data-id="{vid}"]', '老吉士酒家(天平路店)'); pg.click(f'.fs-ok[data-act="venue"][data-id="{vid}"]')
    wait_verify(f"(() => {{ const v = window.__app.S.venue['{vid}']; return v && !v.verifying; }})()")
    res['B']['after_venue'] = order(); res['B']['venue'] = pg.evaluate(f"(() => {{ const v = window.__app.S.venue['{vid}']; return v.pick ? [v.pick.name, v.pick.address, v.match] : 'notFound'; }})()")
    pg.click('.chip[data-hb="booked"]'); pg.wait_for_timeout(200)
    pg.fill('#hbIn', '上海静安瑞吉酒店'); pg.click('.fs-ok[data-act="hb"]')
    wait_verify("window.__app.S.hb && !window.__app.S.hb.verifying")
    res['B']['after_hotel'] = order(); res['B']['hotel'] = pg.evaluate("(() => { const h = window.__app.S.hb; return h.pick ? [h.pick.name, h.pick.address, h.match] : 'notFound'; })()")
    res['B']['slots1'] = slots()
    pg.evaluate("window.__app.S.flowOpen = 'hotel_booked'; window.__app.renderAsk()")
    pg.evaluate("document.querySelector('#s2scroll').scrollTop = 0"); pg.wait_for_timeout(150); shot('02-slots-venue-hotel')
    pg.click('#s2go'); pg.wait_for_function('window.__app.S.pipelineDone === true', timeout=300000); pg.wait_for_timeout(400)
    pg.click('.step-btn[data-step="6"]'); pg.wait_for_timeout(1500); shot('03-overview')
    res['B']['plan'] = pg.evaluate("window.__app.S.days.map(d => d.label + ': ' + d.items.map(i => String(Math.floor(i.s / 60)).padStart(2, '0') + ':' + String(i.s % 60).padStart(2, '0') + ' ' + (i.label || i.name)).join(' | '))")
    net = pg.evaluate("window.__app.S.log.filter(e => e.kind === 'api').map(e => [e.api, e.mock ? 'MOCK' : 'real'])"); res['B']['calls'] = len(net); res['B']['mock'] = sum(1 for x in net if x[1] == 'MOCK')

    # C 混合：见客户 + 多待两天玩 → 按天拆
    start('下周一周二去上海见两个客户，周三周四多待两天玩玩，客户在陆家嘴金融中心和静安嘉里中心')
    res['C'] = {'order': order(), 'slots': slots(), 'segments': pg.evaluate("window.__app.S.task.scenario.segments")}
    pg.evaluate("document.querySelector('#s2scroll').scrollTop = 0"); pg.wait_for_timeout(150); shot('04-mixed-split')

    # D 旧演示：都说了 → 不插追问
    start('下周一到周二去上海出差，拜访三家客户：A 公司在陆家嘴上海中心大厦（浦东新区银城中路501号）、B 公司在静安嘉里中心（静安区南京西路1515号）、C 公司在徐家汇港汇恒隆广场（徐汇区虹桥路1号），晚上想打网球、去个酒吧，酒店预算800以内')
    res['D'] = {'order': order(), 'slots': slots()}
    (OUT / f'{PREFIX}dump.json').write_text(json.dumps(res, ensure_ascii=False, indent=1))
    print(json.dumps(res, ensure_ascii=False, indent=1))
    b.close()
print('errors:', errors or 'none')
