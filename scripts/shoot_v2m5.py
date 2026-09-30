"""v2 M5：开放式安排（画像 → 近期热点 千帆搜索 → 分类菜单 → 2–3 个主题 → 百度地点按区域分天 → 酒店 → 时间轴，带来源标签）。
用法：python3 scripts/shoot_v2m5.py [http://localhost:8890] [前缀 real-v2-M5-] [输出目录]"""
import pathlib, sys, json
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8890'
PREFIX = sys.argv[2] if len(sys.argv) > 2 else 'real-v2-M5-'
OUT = pathlib.Path(sys.argv[3]) if len(sys.argv) > 3 else ROOT / 'shots'; OUT.mkdir(parents=True, exist_ok=True)
TEXT = '我在上海多待两天，10月7号到8号，帮我安排，给点建议，我喜欢打网球和看展'
TEXT2 = '10月17号到18号在上海空出来两天，有什么好玩的'
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

    def s2to(sel):
        pg.evaluate(f"(() => {{ const s = document.querySelector('#s2scroll'), el = document.querySelector('{sel}'); if (s && el) s.scrollTop += el.getBoundingClientRect().top - s.getBoundingClientRect().top - 12; }})()"); pg.wait_for_timeout(250)
    OPEN = """(() => { const O = window.__app.S.openIn; if (!O) return null; const H = O.hot || {};
      return { stage: O.stage, words: O.words.map(x => x.w + '(' + x.cat + (x.src ? ',' + x.src : '') + ')'), remembered: O.remembered, pace: O.pace, err: O.err || '',
        search: H.search ? { calls: H.search.calls, cached: H.search.cached, month: H.search.month, queries: (H.search.queries || []).map(q => q.q + (q.cached ? ' [缓存]' : '') + ' → ' + q.n) } : null,
        refs: H.refs, extracted: H.extracted, events: (H.events || []).map(e => e.name + ' @' + (e.place ? e.place.name : '?') + ' ' + e.date_from + '~' + e.date_to + ' · 发布 ' + e.ref.date + ' · ' + e.ref.url.slice(0, 50)), dropped: H.dropped, hotMock: !!H.mock,
        themes: (O.themes || []).map(t => t.title + ' [' + t.cats.join(',') + ']' + (t.events.length ? ' 活动 ' + t.events.join(',') : '') + (t.rule ? ' 规则' : '')),
        days: (O.days || []).map(d => d.date + ': ' + d.picks.map(p => p.at + ' ' + p.name + (p.rating ? ' ★' + p.rating : '') + (p.ev ? ' [网页活动]' : ' [' + p.sub.q + ']') + (p.borrowed ? ' 借' : '')).join(' / ')) }; })()"""
    PLAN = """window.__app.S.days.map(d => d.label + ': ' + d.items.map(i => String(Math.floor(i.s / 60)).padStart(2, '0') + ':' + String(i.s % 60).padStart(2, '0') + ' ' + (i.name || '').slice(0, 14) + (i.conflict ? ' ⚠' + i.conflict : '')).join(' → '))"""
    def open_flow(tag, theme_idx, pace=None):
        if pace: pg.click(f'.chip[data-opace="{pace}"]'); pg.wait_for_timeout(200)
        pg.click('.fs-ok[data-act="openhot"]')
        pg.wait_for_function("window.__app.S.openIn && window.__app.S.openIn.stage === 'themes'", timeout=300000); pg.wait_for_timeout(600)
        res[tag + '_hot'] = pg.evaluate(OPEN)
        s2to('.op-count'); shot(('03' if tag == 'A' else '09') + f'-{tag}-hot-events')
        s2to('.op-theme'); shot(('03b' if tag == 'A' else '09b') + f'-{tag}-themes')
        if theme_idx == 'events':  # 挑第一个带活动的模型主题（没有就第 2 个）
            theme_idx = pg.evaluate("(() => { const T = window.__app.S.openIn.themes || []; const i = T.findIndex(t => !t.rule && t.events.length); return i >= 0 ? i : Math.min(1, T.length - 1); })()")
        if not pg.locator(f'[data-otheme="{theme_idx}"]').count(): theme_idx = 0
        pg.click(f'[data-otheme="{theme_idx}"]')
        pg.wait_for_function("window.__app.S.openIn.stage === 'ready' || (window.__app.S.openIn.stage === 'themes' && window.__app.S.openIn.err)", timeout=300000); pg.wait_for_timeout(600)
        res[tag + '_open'] = pg.evaluate(OPEN)
        if res[tag + '_open']['stage'] == 'ready':
            pg.evaluate("window.__app.S.flowOpen = 'open'; window.__app.renderAsk()"); pg.wait_for_timeout(300)
            s2to('.op-day'); shot(('04' if tag == 'A' else '10') + f'-{tag}-theme-days')
            pg.evaluate("window.__app.S.flowOpen = null; window.__app.renderAsk()"); pg.wait_for_timeout(200)
        return res[tag + '_open']['stage'] == 'ready'

    # ---- A：原话带兴趣（网球 + 看展）· 酒店没订 ----
    start(TEXT)
    res['A_parse'] = pg.evaluate("(() => { const t = window.__app.S.task; return { scenario: t.scenario.primary, reason: t.scenario.reason, dates: t.dates, hotel: t.hotel.status, acts: (t.activities || []).map(a => a.label), stops: t.stops.map(x => x.name), asks: t.followups.map(f => (f.type || f.id) + ': ' + f.question) }; })()")
    res['A_order'] = order()
    pg.evaluate("document.querySelector('#s2scroll').scrollTop = 0"); pg.wait_for_timeout(150); shot('01-task-card')
    pg.click('#s2go'); pg.wait_for_timeout(300); res['A_go_blocked'] = pg.evaluate("document.querySelector('#toast').textContent")
    if pg.locator('.chip[data-hb="recommend"]').count():
        pg.click('.chip[data-hb="recommend"]'); pg.wait_for_timeout(200); pg.click('.fs-ok[data-act="hbrec"]'); pg.wait_for_timeout(300)
    res['A_order1'] = order()
    s2to('#askRow .fs.open'); shot('02-profile')
    if open_flow('A', 0):
        # 主题卡截图：回到 themes 阶段看一眼再选回来会重算，这里直接用 hot 阶段的数据（03 已含热点，04 含分天）
        pg.click('#s2go'); pg.wait_for_function('window.__app.S.pipelineDone === true', timeout=400000); pg.wait_for_timeout(600)
        res['A_top'] = pg.evaluate("(window.__app.S.top || []).map(r => r.hotel.name + ' ★' + r.hotel.rating + ' 平均 ' + Math.round(r.avg) + '′')")
        pg.click('.step-btn[data-step="4"]'); pg.wait_for_timeout(1500); shot('05-hotel')
        if pg.locator('#hotelScroll .hotel-card:first-child .pick').count(): pg.click('#hotelScroll .hotel-card:first-child .pick'); pg.wait_for_timeout(1500)
        pg.click('.step-btn[data-step="6"]'); pg.wait_for_timeout(1500); res['A_plan'] = pg.evaluate(PLAN); shot('06-overview')
        pg.click('#dayCards .day-card[data-day="d1"]'); pg.wait_for_timeout(1500); shot('07-timeline-d1')
        res['A_tl_src'] = pg.evaluate("[...document.querySelectorAll('.tl-item .op-src')].map(e => e.innerText)")
        if pg.locator('#dayCards .day-card[data-day="d2"]').count() or True:
            pg.evaluate("window.__app.S.day = 'd2'"); 
    res['A_calls'] = calls()

    # ---- B：原话没说兴趣 → 用画像（A 里记住的）· 酒店已订 · 排满；搜索应命中缓存（0 次） ----
    start(TEXT2)
    res['B_parse'] = pg.evaluate("(() => { const t = window.__app.S.task; return { scenario: t.scenario.primary, dates: t.dates, hotel: t.hotel.status, asks: t.followups.map(f => (f.type || f.id)) }; })()")
    if pg.locator('.chip[data-hb="booked"]').count():
        pg.click('.chip[data-hb="booked"]'); pg.wait_for_timeout(200); pg.fill('#hbIn', '上海静安瑞吉酒店'); pg.click('.fs-ok[data-act="hb"]')
        pg.wait_for_function("window.__app.S.hb && !window.__app.S.hb.verifying", timeout=120000); pg.wait_for_timeout(300)
    if pg.locator('.fs-ok[data-act="openhot"]').count():
        s2to('#askRow .fs.open'); shot('08-B-profile-memory')
        res['B_profile'] = pg.evaluate(OPEN)
        if open_flow('B', 'events', 'full'):
            pg.click('#s2go'); pg.wait_for_function('window.__app.S.pipelineDone === true', timeout=400000); pg.wait_for_timeout(600)
            pg.click('.step-btn[data-step="6"]'); pg.wait_for_timeout(1500); res['B_plan'] = pg.evaluate(PLAN); shot('11-B-overview')
    else: errors.append('B: 没有出现开放式那一步')
    res['B_calls'] = calls()
    (OUT / f'{PREFIX}dump.json').write_text(json.dumps(res, ensure_ascii=False, indent=1))
    print(json.dumps(res, ensure_ascii=False, indent=1))
    b.close()
print('errors:', errors or 'none')
