'use strict';
/* 地图任务 Agent v1 后端：静态文件 + API 代理。无第三方依赖（Node ≥ 18）。
   Key 只从环境变量读取：BAIDU_MAP_AK / BAIDU_MAP_BROWSER_AK / QIANFAN_API_KEY / QIANFAN_MODEL（备选 OPENAI_API_KEY / OPENAI_MODEL）。
   MOCK=1 强制示例数据；缺 Key 或百度 status != 0 时自动降级为示例数据，并在响应里给出 reason。 */
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const baidu = require('./lib/baidu');
const mock = require('./lib/mock');
const llm = require('./lib/llm');
const place = require('./lib/place');
const P = require('./public/planner.js');
const Slots = require('./public/slots.js');
const OP = require('./public/openplan.js');
const hot = require('./lib/hot');

const PORT = +process.env.PORT || 8890;
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); }); }
const pt = s => { const [lat, lng] = String(s).split(',').map(Number); return { lat, lng }; };
const ptStr = p => `${(+p.lat).toFixed(6)},${(+p.lng).toFixed(6)}`;
function noKeyReason(which) { return process.env.MOCK === '1' ? 'MOCK=1 强制示例数据' : `未设置 ${which}`; }
function log(line) { console.log(new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + ' CST', line); } // 只记接口名和状态，不记 URL/Key

/* 统一的「真实调用 → 失败降级」包装 */
async function viaBaidu(api, path, params, onOk, onMock, opts = {}) {
  if (!baidu.enabled()) return Object.assign(onMock(), { mock: true, reason: noKeyReason('BAIDU_MAP_AK'), api, ms: 0 });
  const r = await baidu.call(path, params, opts);
  log(`${api} status=${r.status} ${r.ms}ms${r.cached ? ' cached' : ''}`);
  if (r.ok) { try { return Object.assign(onOk(r.data), { mock: false, api, ms: r.ms, cached: !!r.cached, status: 0 }); } catch (e) { return Object.assign(onMock(), { mock: true, reason: '百度返回结构无法解析：' + e.message, api, ms: r.ms }); } }
  return Object.assign(onMock(), { mock: true, reason: baidu.reasonOf(r) + ' → 已降级为示例数据', api, ms: r.ms, status: r.status });
}

/* LLM 解析结果的确定性补全（实测 ERNIE 有时不给追问、min_rating 填 0、nights = 天数）：
   只补缺的/明显不合理的字段，返回补了什么，前端过程日志里能看到 */
function finishTask(task, text, t, hint) {
  const post = [], rule = mock.parseTask(text, t);
  // v2.3：原话没说城市（「周六小王开车接我和B去旗忠」）→ ERNIE 给空城市，前端会把 undefined 当城市去检索 → 用规则的城市（默认上海）
  if (!task.city || /^(undefined|null)$/.test(task.city)) { task.city = rule.city || '上海'; post.push(`city 空→${task.city}`); }
  // 只说了一个日期、没说几天/第二天（「10月8号去上海，晚上吃个饭」）：实测 ERNIE 有时给两天 → 按一天
  const oneDay = (text.match(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]?|\d{1,2}\s*[号日]/g) || []).length === 1 && !/第二天|次日|第三天|[到至~–—-]\s*\d|[两二三四五几多]\s*天|周[一二三四五六日天].{0,2}[到至]|客户|出差/.test(text);
  if (oneDay && task.start_date && task.end_date && task.end_date !== task.start_date) { post.push(`end_date ${task.end_date}→${task.start_date}（原话只有一天）`); task.end_date = task.start_date; }
  const days = task.start_date && task.end_date ? Math.round((new Date(task.end_date) - new Date(task.start_date)) / 864e5) + 1 : 1;
  task.hotel = task.hotel || {};
  task.stops = (task.stops || []).filter(x => x && (x.name || x.query));
  task.assumptions = task.assumptions || [];
  if (task.stops.length) {
    // 实测 ERNIE 会把点名的行程点再复制一份到 activities（会去检索另一家网球场）：同一天同类的活动去掉
    const before = (task.activities || []).length;
    // v2.2：ERNIE 有时活动日期留空、或类别不同但就是同一件事（「看展」vs 点名的浦东美术馆·看展）→ 同样算重复
    const same = (a, x) => (!a.date || !x.date || x.date === a.date) && (x.kind === a.kind || (x.purpose && a.label && (x.purpose.includes(a.label) || a.label.includes(x.purpose))) || (a.label && x.name && x.name.includes(a.label)));
    task.activities = (task.activities || []).filter(a => !task.stops.some(x => same(a, x)));
    if (task.activities.length < before) post.push(`去掉与点名行程点重复的活动 ${before - task.activities.length} 条`);
    if (!task.activities.length) task.assumptions = task.assumptions.filter(a => !/时间窗|\d\s*km|公里内|酒店.{0,6}内/.test(a)); // 删掉的活动留下的假设
    // 用户原话里没有任何时长（「X小时」「打到X点」），时长只能是假设：由代码判定，不信模型的 duration_is_assumed
    const saidDur = Slots.saidTimes(text); // 「1点到2点」「13-14点」「四五点」「打1小时」
    // v2：用户给了起止时间 → 时长 = 结束 - 开始，覆盖默认时长（模型有时漏填 end，用规则解析补）
    task.stops.forEach(x => {
      const r = !x.end && rule.stops && rule.stops.find(y => y.end && y.start === x.start && y.date === x.date);
      if (r) { x.end = r.end; post.push(`${x.name} 结束时间→${r.end}（规则解析）`); }
      const d = P.toMin(x.end || '') - P.toMin(x.start || '');
      if (saidDur && x.start && x.end && d > 0 && d !== x.duration_min) { post.push(`${x.name} 时长 ${x.duration_min}→${d}（你说的 ${x.start}–${x.end}）`); x.duration_min = d; }
      if (saidDur && x.start && x.end && d > 0) x.duration_is_assumed = false;
    });
    const DEF = { tennis: 120, museum: 120, sight: 120, event: 180, food: 90 };
    task.stops.forEach(x => {
      if (/比赛|观赛|看球|演出|演唱会/.test(x.purpose || '') && x.kind !== 'event') { post.push(`${x.name} 类别 ${x.kind}→event`); x.kind = 'event'; } // 「看网球比赛」是观赛不是打球
      if (!x.duration_min || x.duration_min < 15) { x.duration_min = DEF[x.kind] || 90; post.push(`${x.name} 时长→${x.duration_min} 分钟`); }
      if (!saidDur && !x.duration_is_assumed || saidDur && !x.end && !/\d+(\.\d+)?\s*(个)?(小时|钟头|分钟)|[一两二三四半]\s*(个)?(小时|钟头)/.test(text) && !x.duration_is_assumed) { x.duration_is_assumed = true; post.push(`${x.name} 时长标为假设`); }
    });
    const assumed = task.stops.filter(x => x.duration_is_assumed);
    if (assumed.length && !task.assumptions.some(a => /时长|小时/.test(a))) task.assumptions.push('时长没说，按 ' + [...new Set(assumed.map(x => `${x.purpose || x.name} ${x.duration_min / 60} 小时`))].join('、') + ' 估');
    if (!task.assumptions.some(a => /出发|从酒店/.test(a))) task.assumptions.push('每天从酒店出发；地点之间默认打车（2km 内步行），同时给出公交/地铁用时');
    task.followups = (task.followups || []).filter(f => !/工作日|上班/.test(f.question || '')); // 没有客户时「是否工作日」没有意义
    const durQ = [...new Map(assumed.map(x => [x.purpose || x.kind, x])).values()].slice(0, 2)
      .map(x => ({ id: 'dur-' + x.id, question: `${x.purpose || x.name}按 ${x.duration_min / 60} 小时算可以吗？`, options: x.kind === 'event' ? ['3 小时', '看到结束', '2 小时'] : ['2 小时', '1.5 小时', '3 小时'] }));
    if (durQ.length) { task.followups = [...durQ, ...task.followups.filter(f => !/时长|多久|几个?小时|分钟/.test(f.question))].slice(0, 4); post.push(`补时长追问 ${durQ.length} 个`); }
  }
  // 实测 ERNIE 会凭空加活动（只说「见3个客户」也给了网球、晚饭）：原话里没提到的类别去掉
  const ACT_WORD = { tennis: /网球/, bar: /酒吧|清吧|喝一杯|喝酒/, food: /吃.{0,2}饭|晚饭|晚餐|午饭|午餐|请客|饭局|餐厅|吃点|吃个/, cafe: /咖啡/, gym: /健身|跑步|游泳/, sight: /景点|逛|玩|打卡/, museum: /美术馆|博物馆|看展/, event: /比赛|演出|演唱会|看球/ };
  // other 类：标签里任意两个连续字都不在原话里 → 模型编的（实测「帮我安排一下」给出「待定活动」）
  const inText = a => { const l = String(a.label || a.query || ''); for (let i = 0; i + 2 <= l.length; i++) if (text.includes(l.slice(i, i + 2))) return true; return false; };
  const dropped = (task.activities || []).filter(a => ACT_WORD[a.kind] ? !ACT_WORD[a.kind].test(text) : !inText(a));
  if (dropped.length) {
    task.activities = task.activities.filter(a => !dropped.includes(a));
    const W = a => ACT_WORD[a.kind] || /$^/;
    task.assumptions = task.assumptions.filter(x => !dropped.some(a => W(a).test(x) || (a.label && x.includes(a.label))));
    task.followups = (task.followups || []).filter(f => !dropped.some(a => W(a).test(f.question || '') || (a.label && (f.question || '').includes(a.label))));
    post.push(`去掉原话没提的活动 ${dropped.map(a => a.label || a.kind).join('、')}`);
  }
  if (!task.hotel.min_rating) { task.hotel.min_rating = 4.3; post.push('min_rating 未给→4.3'); }
  if (days >= 1 && (!task.hotel.nights || task.hotel.nights > Math.max(1, days - 1))) { post.push(`nights ${task.hotel.nights}→${Math.max(1, days - 1)}`); task.hotel.nights = Math.max(1, days - 1); }
  // 时间窗太紧（窗口 < 时长 + 60 分钟，如 网球 18:00–20:00 打 120 分钟）会让后续改动必然冲突：放宽最晚结束
  (task.activities || []).forEach(a => {
    const s = P.toMin(a.window_start || '0:00'), e = P.toMin(a.window_end || '0:00'), d = a.duration_min || 90;
    const span = (e <= s ? e + 1440 : e) - s;
    if (a.window_start && span < d + 60) { const ne = Math.min(s + d + 120, 1439); const hm = P.toHM(ne); post.push(`${a.label || a.kind} 时间窗 ${a.window_start}–${a.window_end}→${a.window_start}–${hm}`); a.window_end = hm; }
  });
  // 同类活动被复制到多天（用户没说「每天」）：只留第一天那条
  if (!/每天|每晚|两天都|都要/.test(text)) {
    const seen = new Set(), before = (task.activities || []).length;
    task.activities = (task.activities || []).filter(a => { if (seen.has(a.kind)) return false; seen.add(a.kind); return true; });
    if (task.activities.length < before) post.push(`去掉重复活动 ${before - task.activities.length} 条`);
  }
  // 公司名：模型写「公司名未提供」时用规则解析拿到的名字（用户原话里的「A 公司」）
  (task.clients || []).forEach((c, i) => { if (/未提供|未知|未给/.test(c.name) && rule.clients[i]) { post.push(`客户${c.id || i + 1} 名称→${rule.clients[i].name}`); c.name = rule.clients[i].name; } });
  task.followups = (task.followups || []).filter(f => f && f.question && Array.isArray(f.options) && f.options.length);
  const inHoliday = [task.start_date, task.end_date].some(d => d && d.slice(5) >= '10-01' && d.slice(5) <= '10-08');
  // 节假日由代码判断（实测 ERNIE 会说「10月5日是工作日」）：没有提到国庆/假期就替换掉模型的「是否上班」问题
  if (inHoliday && !(task.clients || []).length && task.stops.length && !task.followups.some(f => /国庆|假期|节假/.test(f.question))) {
    task.followups = [...task.followups.slice(0, 3), { id: 'holiday', question: `${task.start_date.slice(5)} 在国庆假期内，场地和门票订好了吗？`, options: ['都订好了', '还没订，提醒我'] }]; post.push('国庆假期追问由代码判断');
  } else if (inHoliday && (task.clients || []).length) {
    // 实测 ERNIE 会说「10月5日是国庆假期后上班第一天」：节假日问题一律由代码出
    const h = { id: 'holiday', question: `${task.start_date.slice(5)} 在国庆假期内，客户那天上班吗？`, options: ['确认上班', '改到节后'] };
    task.followups = [h, ...task.followups.filter(f => !/上班|工作日|国庆|假期|节假/.test(f.question))].slice(0, 4); post.push('国庆假期追问由代码判断');
  }
  if (task.followups.length < 2 && !task.stops.length) {
    const have = new Set(task.followups.map(f => f.id));
    const add = rule.followups.filter(f => !have.has(f.id) && !(f.id === 'holiday' && inHoliday)).slice(0, 3 - task.followups.length);
    task.followups.push(...add); if (add.length) post.push(`补规则追问 ${add.length} 个`);
  }
  const ask = mock.applyAskPlan(task, text, hint); // v2：场景识别 + 缺口（public/slots.js），说过的跳过
  if (ask) post.push(...ask);
  return post;
}

/* 变更 diff 规整：实测 ERNIE 会把「把 X 换成 Y」拆成 remove X + add Y（前端只执行第一条 op 会只删不加），
   这里合并成一个 replace；晚饭时间窗早于 17:00 时按 18:30 起 */
function finishDiff(diff, text) {
  const post = [], ops = diff.ops || [];
  const rm = ops.findIndex(o => o.op === 'remove'), ad = ops.findIndex(o => o.op === 'add');
  if (rm > -1 && ad > -1 && /换成|改成|改为|替换/.test(text)) {
    const merged = Object.assign({}, ops[ad], { op: 'replace', target_kind: ops[rm].target_kind, target_name: ops[rm].target_name || '' });
    diff.ops = [merged, ...ops.filter((_, i) => i !== rm && i !== ad)];
    post.push('remove+add→replace');
  }
  (diff.ops || []).forEach(o => {
    if (o.new_kind === 'food' && /吃饭|晚饭|晚餐|请客/.test(text + o.label) && o.window_start && P.toMin(o.window_start) < 17 * 60) {
      post.push(`晚饭时间窗 ${o.window_start}→18:30`); o.window_start = '18:30'; if (!o.window_end || P.toMin(o.window_end) < 20 * 60) o.window_end = '21:30';
    }
    if (o.new_kind === 'food' && !o.query) { o.query = '中餐厅'; post.push('检索词→中餐厅'); }
    if (o.new_kind === 'food' && !o.duration_min) o.duration_min = 120;
    if (o.window_start && o.window_end && P.toMin(o.window_end) - P.toMin(o.window_start) < (o.duration_min || 90) + 60) {
      const hm = P.toHM(Math.min(P.toMin(o.window_start) + (o.duration_min || 90) + 90, 1439)); post.push(`时间窗 ${o.window_start}–${o.window_end}→${o.window_start}–${hm}`); o.window_end = hm;
    }
  });
  return post;
}

/* ---- v2.3 拼车分享的服务端存储 ---- */
const TRIPS = path.join(__dirname, 'data', 'trips');
function saveTrip(t) { fs.mkdirSync(TRIPS, { recursive: true }); fs.writeFileSync(path.join(TRIPS, t.id + '.json'), JSON.stringify(t)); }
function loadTrip(id) { if (!/^[a-f0-9]{8}$/.test(String(id || ''))) return null; try { return JSON.parse(fs.readFileSync(path.join(TRIPS, id + '.json'), 'utf8')); } catch { return null; } }
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

const API = {
  async status() {
    const p = llm.provider();
    return { baiduAk: !!process.env.BAIDU_MAP_AK, browserAk: !!process.env.BAIDU_MAP_BROWSER_AK, llm: !!p, llmProvider: p ? p.label : '文心 ERNIE（千帆）',
      forceMock: process.env.MOCK === '1', model: llm.MODEL(), today: today(),
      baiduLast: baidu.last.status === null ? null : { ok: baidu.last.status === 0, reason: baidu.last.message } };
  },
  async config() { return { browserAk: process.env.MOCK === '1' ? '' : (process.env.BAIDU_MAP_BROWSER_AK || '') }; },

  async parse(q, body) {
    const text = String(body.text || q.text || '').slice(0, 2000);
    const t = body.today || today();
    const hint = Slots.TEMPLATES[body.hint] ? body.hint : '';
    if (!llm.enabled()) return { task: mock.parseTask(text, t, hint), mock: true, reason: noKeyReason('QIANFAN_API_KEY') + '，用规则解析', api: 'LLM parse', ms: 0 };
    const r = await llm.parseTask(text, t, hint);
    log(`LLM parse ok=${r.ok} ${r.ms}ms${r.fixes && r.fixes.length ? ' fixes=' + r.fixes.length : ''}${r.ok ? '' : ' reason=' + r.reason}`);
    if (r.ok) { const post = finishTask(r.data, text, t, hint); return { task: r.data, mock: false, api: `LLM parse · ${r.provider} ${r.model} · ${r.jsonMode}`, ms: r.ms, fixes: [...r.fixes, ...post] }; }
    return { task: mock.parseTask(text, t, hint), mock: true, reason: r.reason + ' → 用规则解析', api: 'LLM parse', ms: r.ms };
  },

  async geocode(q) {
    const address = String(q.address || '');
    return viaBaidu('geocoding/v3', '/geocoding/v3/', { address, city: /^(undefined|null|)$/.test(String(q.city || '')) ? '上海' : q.city, ret_coordtype: 'bd09ll' },
      d => ({ lat: d.result.location.lat, lng: d.result.location.lng, precise: d.result.precise, confidence: d.result.confidence, level: d.result.level, formatted: address }),
      () => mock.geocode(address));
  },

  async poi(q) {
    const center = pt(q.center), radius = Math.min(50000, +q.radius || 2000), query = String(q.query || '');
    const size = Math.min(20, +q.size || 20), pages = Math.max(1, Math.min(3, +q.pages || 1));
    const params = n => ({ query, location: ptStr(center), radius, radius_limit: 'true', scope: 2, page_size: size, page_num: n, filter: q.filter || '' });
    const norm = d => (d.results || []).map(baidu.normPlace).filter(p => p.lat);
    const r = await viaBaidu('place/v2/search', '/place/v2/search', params(0),
      d => ({ results: norm(d), total: d.total }),
      () => ({ results: mock.poi(query, center, radius, size * pages), total: null }));
    // 百度每页最多 20 条：需要更多候选（如酒店）时继续翻页，去重合并；翻页失败就用已拿到的
    for (let n = 1; !r.mock && n < pages && r.results.length < (r.total || 0); n++) {
      const more = await baidu.call('/place/v2/search', params(n));
      log(`place/v2/search page=${n} status=${more.status} ${more.ms}ms${more.cached ? ' cached' : ''}`);
      if (!more.ok) break;
      const seen = new Set(r.results.map(p => p.uid)), add = norm(more.data).filter(p => !seen.has(p.uid));
      if (!add.length) break;
      r.results.push(...add); r.ms += more.ms; r.cached = r.cached && !!more.cached;
    }
    return r;
  },

  async matrix(q, body) {
    const mode = ['walking', 'driving', 'riding'].includes(body.mode || q.mode) ? (body.mode || q.mode) : 'driving';
    const origins = body.origins || [], dests = body.destinations || [];
    if (!origins.length || !dests.length) return { rows: [], mock: true, reason: '空输入', api: 'routematrix', ms: 0 };
    const mk = () => ({ rows: mock.matrix(origins, dests, mode) });
    if (!baidu.enabled()) return Object.assign(mk(), { mock: true, reason: noKeyReason('BAIDU_MAP_AK'), api: `routematrix/v2/${mode}`, ms: 0, elements: origins.length * dests.length });
    // 百度限制：起点数 × 终点数 ≤ 50，按起点分批
    const per = Math.max(1, Math.floor(50 / dests.length)), rows = []; let ms = 0, cached = true;
    for (let i = 0; i < origins.length; i += per) {
      const chunk = origins.slice(i, i + per);
      const r = await baidu.call(`/routematrix/v2/${mode}`, { origins: chunk.map(ptStr).join('|'), destinations: dests.map(ptStr).join('|') });
      log(`routematrix/v2/${mode} ${chunk.length}x${dests.length} status=${r.status} ${r.ms}ms`);
      ms += r.ms; cached = cached && !!r.cached;
      if (!r.ok) return Object.assign(mk(), { mock: true, reason: baidu.reasonOf(r) + ' → 已降级为示例数据', api: `routematrix/v2/${mode}`, ms, status: r.status, elements: origins.length * dests.length });
      const res = r.data.result || [];
      chunk.forEach((_, oi) => rows.push(dests.map((_, di) => { const e = res[oi * dests.length + di] || {}; return { m: e.distance ? +e.distance.value : null, s: e.duration ? +e.duration.value : null }; })));
    }
    return { rows, mock: false, api: `routematrix/v2/${mode}`, ms, cached, status: 0, elements: origins.length * dests.length };
  },

  async route(q) {
    const o = pt(q.origin), d = pt(q.destination);
    const mode = ['walking', 'driving', 'riding'].includes(q.mode) ? q.mode : 'driving';
    const p = mode === 'walking' ? '/directionlite/v1/walking' : `/direction/v2/${mode}`;
    // v2.3：驾车支持途经点（拼车），返回每段用时（按 steps.leg_index 分组）
    const wps = mode === 'driving' && q.waypoints ? String(q.waypoints).split('|').map(pt).filter(x => x.lat).slice(0, 10) : [];
    const params = { origin: ptStr(o), destination: ptStr(d) }; if (wps.length) params.waypoints = wps.map(ptStr).join('|');
    return viaBaidu(p.slice(1), p, params,
      data => { const r0 = data.result.routes[0]; const legs = [];
        r0.steps.forEach(s => { const i = +s.leg_index || 0; legs[i] = legs[i] || { s: 0, m: 0 }; legs[i].s += +s.duration || 0; legs[i].m += +s.distance || 0; });
        return { path: r0.steps.flatMap(s => baidu.parsePath(s.path)), distance: r0.distance, duration: r0.duration, legs: Array.from(legs, x => x || { s: 0, m: 0 }), waypoints: wps.length, taxiFee: r0.taxi_fee || null }; },
      () => { const pts = [o, ...wps, d], legs = []; for (let i = 1; i < pts.length; i++) { const e = P.estimateLeg(pts[i - 1], pts[i], 'driving'); legs.push({ s: e.s, m: e.m }); }
        const r = mock.route(o, d, mode); return Object.assign(r, wps.length ? { path: pts.map(x => [x.lng, x.lat]), legs, duration: legs.reduce((a, x) => a + x.s, 0), distance: legs.reduce((a, x) => a + x.m, 0) } : { legs }); }, { fresh: q.fresh === '1' });
  },

  /* v2.4 场景 3 近期热点：千帆百度搜索（≤ 2 次/方案，当天缓存）→ 文心抽活动 → 代码校验日期/原文 → 场馆用百度核对，核对不上丢掉 */
  async hot(q, body) {
    const city = String(body.city || '上海').replace(/市$/, '') || '上海', dates = (body.dates || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 5);
    const words = (body.words || []).map(String).slice(0, 8);
    if (!dates.length) return { error: '没有日期' };
    const U = () => ({ month: hot.usage().calls, cap: hot.CAP(), free: 1500 });
    if (!llm.enabled()) { // 示例：不调搜索
      const evs = [{ id: 'e1', name: '（示例）秋季艺术市集', venue: '上海当代艺术博物馆', date_from: dates[0], date_to: dates[dates.length - 1], kind: 'market', ref: { title: '示例数据 · 没有调用搜索', url: '', date: hot.today(), site: '示例' } }];
      for (const e of evs) { const r = await API.place({ name: e.venue, city, kind: 'museum' }); e.place = r.pick; e.match = r.match; }
      return { events: evs, dropped: [], refs: 0, search: Object.assign({ calls: 0, cached: 0, queries: [] }, U()), mock: true, reason: noKeyReason('QIANFAN_API_KEY') + '，近期热点用示例', api: 'ai_search/web_search · 示例' };
    }
    const qs = hot.queries(city, dates, words), per = [], refs = [], seen = new Set();
    for (const x of qs) {
      const r = await hot.search(x);
      log(`qianfan web_search ok=${r.ok} ${r.ms || 0}ms${r.cached ? ' cached' : ''} refs=${r.refs.length}${r.ok ? '' : ' reason=' + r.reason}`);
      per.push({ q: x, ok: r.ok, cached: !!r.cached, counted: !!r.counted, n: r.refs.length, ms: r.ms || 0, reason: r.reason || '' });
      r.refs.forEach(f => { if (!seen.has(f.url)) { seen.add(f.url); refs.push(f); } });
    }
    const search = Object.assign({ calls: per.filter(x => x.counted).length, cached: per.filter(x => x.cached).length, queries: per }, U());
    if (!refs.length) return { events: [], dropped: [], refs: 0, search, mock: false, reason: per.map(x => x.reason).filter(Boolean).join('；') || '搜索没有结果', api: 'ai_search/web_search' };
    const xkey = 'x|' + refs.map(r => r.url).join('|');
    let raw = (hot.cacheGet(xkey) || {}).raw, llmMs = 0, llmNote = '缓存';
    if (!raw) {
      const L = await llm.extractEvents(city, dates[0].slice(0, 4), refs.slice(0, 12));
      log(`LLM events ok=${L.ok} ${L.ms}ms${L.ok ? '' : ' reason=' + L.reason}`);
      llmMs = L.ms; llmNote = L.ok ? `${L.provider} ${L.model}` : L.reason;
      raw = L.ok ? L.data.events : []; if (L.ok) hot.cacheSet(xkey, { raw });
    }
    const { events, dropped } = hot.checkEvents(raw, refs.slice(0, 12), dates);
    const kept = [];
    for (const e of events.slice(0, 5)) { // 场馆百度核对：核对不上的丢掉
      const r = await API.place({ name: e.venue, city, kind: 'museum' });
      if (!r.pick || r.match === 'none' || r.mock) { dropped.push({ name: e.name, why: `百度没核对上场馆「${e.venue}」` }); continue; }
      kept.push(Object.assign(e, { place: r.pick, match: r.match, note: r.note || '' }));
    }
    return { events: kept, dropped, refs: refs.length, search, llm: llmNote, llmMs, extracted: raw.length, mock: false, api: 'ai_search/web_search + LLM 抽取 + place/v2/search' };
  },
  async themes(q, body) {
    const dates = (body.dates || []).slice(0, 5), interests = (body.interests || []).filter(x => x && OP.MENU[x.cat]).slice(0, 8), events = (body.events || []).slice(0, 6), pace = body.pace === 'full' ? 'full' : 'loose';
    const city = String(body.city || '上海');
    if (!llm.enabled()) return Object.assign(OP.checkThemes(OP.ruleThemes(interests, events), interests, events), { mock: true, rule: true, reason: noKeyReason('QIANFAN_API_KEY') + '，用分类菜单规则出主题', api: 'LLM themes' });
    const L = await llm.themes(city, dates, interests, pace, events);
    log(`LLM themes ok=${L.ok} ${L.ms}ms${L.ok ? '' : ' reason=' + L.reason}`);
    if (!L.ok) return Object.assign(OP.checkThemes(OP.ruleThemes(interests, events), interests, events), { rule: true, reason: L.reason + ' → 用分类菜单规则出主题', mock: false, api: 'LLM themes', ms: L.ms });
    const c = OP.checkThemes(L.data.themes, interests, events);
    return Object.assign(c, { mock: false, api: `LLM themes · ${L.provider} ${L.model}`, ms: L.ms, fixes: [...(L.fixes || []), ...c.fixes] });
  },

  /* v2.3 拼车分享：行程存成服务端 JSON 文件（data/trips/<id>.json）。每人一个只读链接；司机链接带 key，才能点「出发了 / 接到 X 了」 */
  async trip(q, body) {
    if (body && body.create) {
      const id = crypto.randomBytes(5).toString('hex').slice(0, 8), key = crypto.randomBytes(8).toString('hex');
      const trip = { id, key, created: Date.now(), plan: body.plan || {}, events: [] };
      if (JSON.stringify(trip).length > 200000) return { error: '行程太大' };
      saveTrip(trip); return { id, key };
    }
    const t = loadTrip(q.id); if (!t) return { error: '找不到这个行程（链接可能过期）' };
    const { key, ...pub } = t; return Object.assign(pub, { now: nowMin(), today: today(), isDriver: !!q.k && q.k === key });
  },
  async tripEvent(q, body) {
    const t = loadTrip(body.id); if (!t) return { error: '找不到这个行程' };
    if (body.key !== t.key) return { error: '只有司机链接能上报' };
    const type = ['depart', 'picked', 'arrived', 'reset'].includes(body.type) ? body.type : null; if (!type) return { error: '未知事件' };
    if (type === 'reset') { t.events = []; saveTrip(t); return { ok: true, events: [] }; }
    const pts = t.plan.points || []; // [司机出发地, 乘客1.., 目的地]（按实际接人顺序）
    const idx = type === 'depart' ? -1 : type === 'picked' ? Math.max(0, Math.min(pts.length - 3, +body.idx || 0)) : pts.length - 2;
    const ev = { type, idx, at: nowMin(), wall: Date.now() };
    const from = pts[type === 'depart' ? 0 : idx + 1], to = pts[type === 'depart' ? 1 : idx + 2];
    if (type !== 'arrived' && from && to) { // 下一段按实时路况重算（简单版：司机位置 = 上一个上车点）
      const r = await API.route({ origin: `${from.lat},${from.lng}`, destination: `${to.lat},${to.lng}`, mode: 'driving', fresh: '1' });
      ev.fresh = r.duration ? Math.round(r.duration / 60) : null; ev.freshMock = !!r.mock; ev.freshMs = r.ms;
    }
    t.events.push(ev); saveTrip(t);
    log(`trip ${t.id} event ${type}${type === 'picked' ? ' #' + idx : ''}${ev.fresh != null ? ' fresh=' + ev.fresh + 'min' : ''}`);
    return { ok: true, event: ev, events: t.events };
  },

  /* 点名地点核对：百度地点检索（城市内）→ 合并子点 → 名称匹配；不确定时让大模型从候选里挑（同音字等），再不行取百度排序第一并标「需确认」 */
  async place(q) {
    const said = String(q.name || '').slice(0, 60), query = String(q.query || said).slice(0, 60), kind = String(q.kind || ''), city = /^(undefined|null|)$/.test(String(q.city || '')) ? '上海' : String(q.city);
    const search = kw => viaBaidu('place/v2/search', '/place/v2/search', { query: kw, region: city, city_limit: 'true', scope: 2, page_size: 12 },
      d => ({ results: (d.results || []).map(baidu.normPlace).filter(p => p.lat), total: d.total }), () => ({ results: [] }));
    // 百度检索对括号分店名不友好（实测「小杨生煎(黄河路店)」只回「晓燕生煎」）：括号换成空格去查，排序时再比分店
    const kw = /[（(]/.test(query) ? query.replace(/[（(]/g, ' ').replace(/[）)]/g, '').replace(/\s+/g, ' ').trim() : query;
    let r = await search(kw), ms = r.ms || 0;
    if (r.mock) { const g = mock.geocode(said); return { pick: { name: said + '（示例）', address: '示例地址', lat: g.lat, lng: g.lng, uid: 'mock-place-' + said, mock: true }, match: 'guess', note: '示例坐标', candidates: [], mock: true, reason: r.reason, api: 'place/v2/search · 地点核对', ms }; }
    let cands = place.rank(said, query, place.collapse(r.results, kind));
    let queries = [kw];
    if (!place.confident(cands) && query !== said) { // 纠正后的检索词不确定时，再用原话查一次
      const r2 = await search(said); ms += r2.ms || 0; queries.push(said);
      if (!r2.mock) { const seen = new Set(cands.map(c => c.uid)); cands = place.rank(said, query, [...cands, ...place.collapse(r2.results, kind).filter(c => !seen.has(c.uid))]); }
    }
    const top = cands.slice(0, 8), base = { candidates: top.map(c => ({ name: c.name, address: c.address, score: c.score, mismatch: c.mismatch || '' })), mock: false, api: 'place/v2/search · 地点核对', queries };
    if (!top.length) return Object.assign(base, { pick: null, match: 'none', note: `百度在${city}没有找到「${said}」`, ms });
    // 客户：同名的地方有好几处且相距 > 2km（如 漕河泾开发区 徐汇/松江/闵行园区），取排第一的但标「同名多处 · 请确认」
    const kmOf = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 95);
    const twins = kind === 'client' && top[0].score < 1 ? top.slice(1).filter(c => c.score >= Math.min(0.9, top[0].score) && kmOf(c, top[0]) > 2) : [];
    if (twins.length) return Object.assign(base, { pick: top[0], match: 'ambiguous', note: `同名多处：${twins.slice(0, 3).map(c => c.name).join('、')}`, ms });
    // 说了分店、但好几家分店同样匹配（「全季酒店(上海人民广场店)」→ 南京路店/福州路店/北京西路店）→ 请用户确认
    const sibs = place.branchOf(said) && top[0].score >= 0.6 ? top.slice(1).filter(c => c.score === top[0].score && place.branchOf(c.name) !== place.branchOf(top[0].name)) : [];
    if (sibs.length) return Object.assign(base, { pick: top[0], match: 'ambiguous', note: `好几家分店都叫这个：${[top[0], ...sibs].slice(0, 3).map(c => c.name).join('、')}`, ms });
    if (place.confident(top)) { const p = top[0], same = place.core(p.name) === place.core(said) && place.branchOf(p.name).replace(/店$/, '') === place.branchOf(said).replace(/店$/, ''); return Object.assign(base, { pick: p, match: p.score >= 0.9 && same ? 'exact' : 'alias', note: same ? '' : `百度名称「${p.name}」`, ms }); }
    if (llm.enabled()) {
      const L = await llm.pickPlace(said, kind, top);
      log(`LLM place ok=${L.ok} ${L.ms}ms${L.ok ? '' : ' reason=' + L.reason}`);
      if (L.ok && L.data.index >= 0 && L.data.index < top.length && L.data.match !== 'none') {
        let pk = top[L.data.index], mm = place.penalty(said, pk.name).why; // 模型说同一处，但分店/区域对不上 → 降为「请确认」
        // 品牌部分一个字都对不上（实测「外婆家」→「巴奴毛肚火锅」被判同音）→ 不采信，退回百度排序第一条
        const brand = n => place.core(n).replace(/^上海市?/, '');
        if (place.similarity(brand(said), brand(pk.name)) === 0 && ![...brand(said)].some(ch => brand(pk.name).includes(ch))) {
          pk = top[0]; return Object.assign(base, { pick: pk, match: 'guess', note: `大模型选了「${top[L.data.index].name}」但名字对不上，改用百度第一条${place.penalty(said, pk.name).why ? '（' + place.penalty(said, pk.name).why + '）' : ''}，请确认`, ms: ms + L.ms, llm: `${L.provider} ${L.model}` });
        }
        return Object.assign(base, { pick: pk, match: mm && ['exact', 'alias'].includes(L.data.match) ? 'guess' : L.data.match, note: mm ? `${mm}；${L.data.note}` : L.data.note, ms: ms + L.ms, llm: `${L.provider} ${L.model}` });
      }
      if (L.ok && L.data.index === -1) return Object.assign(base, { pick: top[0], match: 'guess', note: `大模型认为候选都不对（${L.data.note}），先用百度第一条，请确认`, ms: ms + L.ms, llm: `${L.provider} ${L.model}` });
      return Object.assign(base, { pick: top[0], match: 'guess', note: '名称不完全一致，按百度排序取第一条，请确认（' + L.reason + '）', ms: ms + L.ms });
    }
    return Object.assign(base, { pick: top[0], match: 'guess', note: '名称不完全一致，按百度排序取第一条，请确认', ms });
  },

  /* 公交/地铁：direction/v2/transit 支持出发日期和时间（驾车接口不支持未来出发时间，用的是当前路况） */
  async transit(q) {
    const o = pt(q.origin), d = pt(q.destination);
    const params = { origin: ptStr(o), destination: ptStr(d) };
    if (/^\d{8}$/.test(q.date || '')) params.departure_date = q.date;
    if (/^\d{1,2}:\d{2}$/.test(q.time || '')) params.departure_time = q.time;
    return viaBaidu('direction/v2/transit', '/direction/v2/transit', params, data => {
      const r0 = (data.result.routes || [])[0];
      if (!r0) return { none: true, taxi: data.result.taxi ? { min: Math.round(data.result.taxi.duration / 60), km: +(data.result.taxi.distance / 1000).toFixed(1) } : null };
      const steps = r0.steps.map(s => s[0]);
      const lines = steps.filter(x => x.vehicle_info && x.vehicle_info.type !== 5 && x.vehicle_info.detail).map(x => x.vehicle_info.detail.name).filter(Boolean);
      const walk = steps.filter(x => x.vehicle_info && x.vehicle_info.type === 5).reduce((a, x) => a + (+x.distance || 0), 0);
      return { min: Math.round(r0.duration / 60), km: +(r0.distance / 1000).toFixed(1), price: r0.price || null, lines, walkM: walk };
    }, () => { const e = P.estimateLeg(o, d, 'driving'); return { min: Math.round(e.s / 60 * 1.8), km: +(e.m / 1000).toFixed(1), lines: [], walkM: 0 }; });
  },

  async replan(q, body) {
    const text = String(body.text || '').slice(0, 500);
    if (!llm.enabled()) return { diff: mock.replan(text), mock: true, reason: noKeyReason('QIANFAN_API_KEY') + '，用规则解析', api: 'LLM replan', ms: 0 };
    const r = await llm.replan(text, body.plan || {});
    log(`LLM replan ok=${r.ok} ${r.ms}ms${r.fixes && r.fixes.length ? ' fixes=' + r.fixes.length : ''}${r.ok ? '' : ' reason=' + r.reason}`);
    if (r.ok) { r.fixes.push(...finishDiff(r.data, text)); return { diff: r.data, mock: false, api: `LLM replan · ${r.provider} ${r.model} · ${r.jsonMode}`, ms: r.ms, fixes: r.fixes }; }
    return { diff: mock.replan(text), mock: true, reason: r.reason + ' → 用规则解析', api: 'LLM replan', ms: r.ms };
  },
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    const name = u.pathname.slice(5);
    if (!API[name]) return send(res, 404, { error: 'unknown api' });
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      return send(res, 200, await API[name](Object.fromEntries(u.searchParams), body));
    } catch (e) { log(`api ${name} error ${e.message}`); return send(res, 500, { error: e.message }); }
  }
  let f = path.normalize(path.join(PUB, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname)));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});
server.listen(PORT, () => {
  log(`地图任务 Agent v1 · http://localhost:${PORT} · 百度服务端AK=${process.env.BAIDU_MAP_AK ? '已设置' : '未设置'} · 浏览器AK=${process.env.BAIDU_MAP_BROWSER_AK ? '已设置' : '未设置'} · 大模型=${llm.provider() ? llm.provider().label + ' ' + llm.MODEL() : '未设置'} · MOCK=${process.env.MOCK === '1' ? '1' : '0'}`);
});
