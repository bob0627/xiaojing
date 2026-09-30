'use strict';
/* 示例数据生成器：每个接口在没有 Key 或百度报错时返回的数据，全部带 mock:true */
const { BUILDINGS, POIS, catOfQuery } = require('./mockdata');
const P = require('../public/planner.js');

function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let x = seed || 1; return () => ((x = Math.imul(x ^ (x >>> 15), 2246822507) ^ Math.imul(x ^ (x >>> 13), 3266489909)) >>> 0) / 4294967296; }

function geocode(address) {
  const b = BUILDINGS.find(b => b.match.some(m => address.includes(m)));
  if (b) return { lat: b.lat, lng: b.lng, formatted: b.address, precise: 1, confidence: 80, level: '门址', mock: true };
  const r = rng(hash(address));
  return { lat: 31.2304 + (r() - 0.5) * 0.06, lng: 121.4737 + (r() - 0.5) * 0.08, formatted: address + '（示例坐标）', precise: 0, confidence: 20, level: '示例', mock: true };
}

function poi(query, center, radiusM, limit = 20) {
  const cat = catOfQuery(query);
  const fragQ = !cat && /^(咖啡馆|书店|公园|美术馆|羽毛球馆|博物馆)$/.test(query); // v2 M3 碎片时间的类别：示例库里没有，按种子生成
  let list = fragQ ? [] : POIS.filter(p => (!cat || p.cat === cat)).map(p => Object.assign({}, p, { distance: Math.round(P.haversineKm(center, p) * 1000), mock: true }))
    .filter(p => p.distance <= radiusM).sort((a, b) => a.distance - b.distance);
  const nearestAny = POIS.filter(p => !cat || p.cat === cat).reduce((m, p) => Math.min(m, P.haversineKm(center, p)), Infinity);
  if (fragQ || (list.length < 3 && nearestAny > radiusM / 1000 * 2)) {
    // 中心点远离示例数据集时，按种子生成几条示例地点，保证流程可走通
    const r = rng(hash(query + center.lat.toFixed(3) + center.lng.toFixed(3)));
    const label = { hotel: '酒店', tennis: '网球场', bar: '酒吧', food: '餐厅' }[cat] || query;
    list = Array.from({ length: 6 }, (_, i) => {
      const ang = r() * Math.PI * 2, d = (0.2 + r() * 0.8) * radiusM / 1000;
      const lat = center.lat + (d / 111) * Math.sin(ang), lng = center.lng + (d / (111 * Math.cos(center.lat * Math.PI / 180))) * Math.cos(ang);
      return { uid: `mock-gen-${hash(query)}-${i}`, cat, name: `附近${label}${i + 1}（示例）`, lat, lng, address: '示例地址', rating: +(3.9 + r() * 1).toFixed(1),
        price: cat === 'hotel' ? Math.round(350 + r() * 700) : null, hours: cat === 'bar' ? '18:00-02:00' : cat === 'tennis' ? '08:00-22:00' : query === '公园' ? '06:00-18:00' : query === '美术馆' ? '10:00-17:00' : '10:00-22:00',
        distance: Math.round(d * 1000), mock: true };
    });
  }
  return list.slice(0, limit);
}

function matrix(origins, dests, mode) {
  return origins.map(o => dests.map(d => { const e = P.estimateLeg(o, d, mode); return { m: e.m, s: e.s }; }));
}

function route(o, d, mode) {
  // 示例折线：带一点弯曲的二次曲线，不是真实道路
  const n = 16, mx = (o.lng + d.lng) / 2, my = (o.lat + d.lat) / 2;
  const cx = mx - (d.lat - o.lat) * 0.18, cy = my + (d.lng - o.lng) * 0.18;
  const path = [];
  for (let i = 0; i <= n; i++) { const t = i / n; path.push([(1 - t) ** 2 * o.lng + 2 * (1 - t) * t * cx + t * t * d.lng, (1 - t) ** 2 * o.lat + 2 * (1 - t) * t * cy + t * t * d.lat]); }
  const e = P.estimateLeg(o, d, mode);
  return { path, distance: e.m, duration: e.s };
}

/* 规则版任务解析（没有大模型 Key 时用），输出与 LLM 相同的 JSON 结构 */
function nextWeekday(today, dow) { // dow: 1=周一
  const t = new Date(today); const cur = t.getDay() || 7; const add = 7 - cur + dow;
  t.setDate(t.getDate() + add); return t;
}
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DOW = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

/* 规则版「点名行程」解析：「10月5日…住X酒店…下午1点去Y打球，打完回酒店…第二天早上9点去Z…」 */
const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
function parseFixedTrip(text, today) {
  const dm = text.match(/(\d{1,2})月(\d{1,2})[日号]/);
  const segs = text.split(/[。；;！!]|，(?=(?:当天|第二天|次日|然后|再|接着)?\s*(?:早上|上午|中午|下午|晚上)?\s*[\d一二两三四五六七八九十]{1,3}点)/);
  // v2：支持时间段「下午1点到2点在X打球」「13-14点」「四五点和朋友去Y看展」
  const re = /(当天|第二天|次日)?\s*(早上|上午|中午|下午|晚上)?\s*([\d一二两三四五六七八九十]{1,3})(?:点(半)?)?\s*(?:(?:到|至|-|–|—)\s*([\d一二两三四五六七八九十]{1,3})点(半)?)?\s*(?:钟)?\s*(?:和[^，,去在]{1,6})?\s*(?:去|在)\s*([^，,。；;]+?)(打网球|打球|看网球比赛|看比赛|看展|看展览|吃饭|$|，|,)/;
  const stops = []; let dayOff = 0, period = '';
  const num = x => /^\d+$/.test(x) ? +x : CN[x] || 0;
  const hour = (h, p) => { if ((p === '下午' || p === '晚上') && h < 12) h += 12; else if (p === '中午' && h < 11) h += 12; else if (!p && h < 8) h += 12; return h; };
  segs.forEach(seg => {
    const m = seg.match(re); if (!m || !/点/.test(m[0])) return;
    if (m[1] === '第二天' || m[1] === '次日') { dayOff = 1; period = ''; }
    if (m[2]) period = m[2];
    let sh = m[3], eh = m[5];
    if (!/^\d+$/.test(sh) && sh.length === 2 && CN[sh[0]] && CN[sh[1]] === CN[sh[0]] + 1 && !eh) { eh = sh[1]; sh = sh[0]; } // 「四五点」
    const h = hour(num(sh), period);
    const name = m[7].trim(), act = m[8] || '';
    const kind = /比赛/.test(act) ? 'event' : /球/.test(act) || /网球|球场|球馆/.test(name) ? 'tennis' : /展/.test(act) || /美术馆|博物馆|展览/.test(name) ? 'museum' : 'other';
    const start = `${String(h).padStart(2, '0')}:${m[4] ? '30' : '00'}`;
    let end = '';
    if (eh) { let e = hour(num(eh), period || (h >= 12 ? '下午' : '')); if (e <= h) e += 12; end = `${String(e).padStart(2, '0')}:${m[6] ? '30' : '00'}`; }
    const dur = end ? (parseInt(end) * 60 + +end.slice(3)) - (h * 60 + +start.slice(3)) : ({ tennis: 120, museum: 120, event: 180 }[kind] || 90);
    stops.push({ id: 's' + (stops.length + 1), name, query: name, kind, purpose: act.replace(/[，,]/g, '') || '到访', dayOff, start, end,
      duration_min: dur, duration_is_assumed: !end, back_to_hotel_after: /回酒店/.test(seg.slice(seg.indexOf(m[0]) + m[0].length)) });
  });
  if (!dm || !stops.length) return null;
  const y = today.getFullYear() + (+dm[1] < today.getMonth() + 1 ? 1 : 0);
  const d0 = new Date(y, +dm[1] - 1, +dm[2], 12), dates = [];
  for (let i = 0; i <= Math.max(...stops.map(x => x.dayOff)); i++) { const d = new Date(d0); d.setDate(d.getDate() + i); dates.push(ymd(d)); }
  stops.forEach(x => { x.date = dates[x.dayOff]; delete x.dayOff; });
  const hotel = (text.match(/住(?:在)?\s*([^，,。；;]+?(?:酒店|宾馆|饭店|公寓|民宿))/) || [])[1] || '';
  const city = (text.match(/[去到](上海|北京|深圳|广州|杭州|南京|成都)/) || [, '上海'])[1];
  const arrive = (text.match(/(早上|上午|中午|下午|晚上|\d{1,2}点)[^，,。]{0,4}到(?:了)?(?:上海|北京|深圳|广州|杭州|南京|成都)/) || [])[1] || '';
  const assumed = stops.filter(x => x.duration_is_assumed);
  return {
    city, start_date: dates[0], end_date: dates[dates.length - 1], summary: `${city} ${dates.length} 天：${stops.map(x => x.purpose + '·' + x.name).join('、')}`,
    clients: [], activities: [], stops, people: [], time: { arrive_part: arrive, free_budget_min: 0 },
    scenario_guess: { primary: 'fixed_trip', reason: '规则：X点去/在某地' },
    hotel: { name: hotel, status: hotel ? 'booked' : 'unknown', budget_max: 0, min_rating: 4.3, brands: [], nights: Math.max(1, dates.length - 1) },
    followups: [...[...new Map(assumed.map(x => [x.purpose || x.kind, x])).values()].slice(0, 2).map(x => ({ id: 'dur-' + x.id, question: `${x.purpose || x.name}按 ${x.duration_min / 60} 小时算可以吗？`, options: x.kind === 'event' ? ['3 小时', '看到结束', '2 小时'] : ['2 小时', '1.5 小时', '3 小时'] })),
      ...(/回酒店/.test(text) ? [] : [{ id: 'back', question: '最后一项结束后回酒店吗？', options: ['回酒店', '直接去车站/机场'] }])],
    assumptions: [...(assumed.length ? ['时长没说，按 运动/看展 2 小时、看比赛 3 小时 估'] : []), ...(stops.length > assumed.length ? ['你给了起止时间的项目按你说的时长'] : []), '每天从酒店出发'],
  };
}


/* v2：追问由 public/slots.js 统一计算（5 栏 + 场景模板 + 缺口）。这里保留 applyAskPlan 这个名字给旧调用方，
   额外做两件 v1.4 就有的事：记录待填客户数、删掉和追问冲突的假设。 */
const Slots = require('../public/slots.js');
const clientCount = Slots.clientCount;
function applyAskPlan(task, text, hint) {
  const post = Slots.plan(task, text, hint);
  const need = new Set((task.followups || []).map(f => f.type).filter(Boolean));
  if (need.has('clients')) task.clients_pending = (task.clients || []).filter(c => c.pending).length;
  task.assumptions = (task.assumptions || []).filter(a => !(need.has('dates') && /日期|下周|默认出差|\d+月\d+日|\d{4}-\d{2}-\d{2}|第一天|最后一天|返程/.test(a)) && !(need.has('clients') && /客户|clients/.test(a)) && !/数组|为空|hotel\.|budget_max|brands|stops|activities|scenario|free_budget/.test(a));
  if (need.has('dates')) task.assumptions.unshift('日期还没定，先按 ' + task.start_date + ' 占位，答完追问后以你选的为准');
  return post;
}

function parseTask(text, todayStr, hint) {
  const today = todayStr ? new Date(todayStr + 'T12:00:00') : new Date();
  const fixed = parseFixedTrip(text, today);
  if (fixed) { applyAskPlan(fixed, text, hint); return fixed; }
  let start = null, end = null;
  const m = text.match(/下周([一二三四五六日天])(?:到|至|-|—|、|和)?(?:周)?([一二三四五六日天])?/);
  const md = text.match(/(\d{1,2})\s*[月\/.]\s*(\d{1,2})\s*[日号]?(?:\s*(?:到|至|-|–|—|~)\s*(?:(\d{1,2})\s*[月\/.]\s*)?(\d{1,2})\s*[日号]?)?/);
  if (md && +md[1] >= 1 && +md[1] <= 12) { // 「10月12日–13日」「10/12–10/13」
    const y = today.getFullYear() + (+md[1] < today.getMonth() + 1 ? 1 : 0);
    start = new Date(y, +md[1] - 1, +md[2], 12); end = md[4] ? new Date(y, +(md[3] || md[1]) - 1, +md[4], 12) : new Date(start);
    if (end < start) end = new Date(start);
  } else if (m) { start = nextWeekday(today, DOW[m[1]]); end = m[2] ? nextWeekday(today, DOW[m[2]]) : new Date(start); }
  else if (/(?:^|[^下])(?:这|本)?周([一二三四五六日天])/.test(text) && !/下周/.test(text)) { // 「周六」= 最近的周六（今天之后）
    const w = DOW[text.match(/(?:这|本)?周([一二三四五六日天])/)[1]], d = new Date(today); do d.setDate(d.getDate() + 1); while (d.getDay() !== w % 7);
    start = d; end = new Date(d); }
  else if (/现在|今天|今晚|这会|有空|个小时空|小时的空/.test(text)) { start = new Date(today); end = new Date(today); } // 碎片时间默认就是今天
  else { start = nextWeekday(today, 1); end = new Date(start); end.setDate(end.getDate() + 1); }
  const dates = []; for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) dates.push(ymd(d));
  const city = (text.match(/去(上海|北京|深圳|广州|杭州|南京|成都)/) || [, '上海'])[1];

  // 客户：「X 公司在 某写字楼（地址）」
  const clients = [];
  for (const seg of text.split(/[：:、，,；;。]/)) {
    const c = seg.match(/^(.*?)在\s*([^（(]+?)\s*[（(]([^）)]+)[）)]/);
    if (!c) continue;
    const name = c[1].replace(/拜访|三家客户|客户|去|的/g, '').replace(/\s+/g, '').trim();
    clients.push({ name: name || `公司${clients.length + 1}`, place: c[2].trim(), address: c[3].trim() });
  }
  const biz = /客户|出差|拜访/.test(text);
  if (!clients.length && !clientCount(text) && biz && /陆家嘴|静安|徐家汇|演示/.test(text)) {
    [['A 公司', '上海中心大厦', '浦东新区银城中路501号'], ['B 公司', '静安嘉里中心', '静安区南京西路1515号'], ['C 公司', '港汇恒隆广场', '徐汇区虹桥路1号']]
      .forEach(([name, place, address]) => clients.push({ name, place, address }));
  }
  const slots = [['09:30', '11:00'], ['14:00', '15:30'], ['10:00', '11:30']];
  const cl = clients.slice(0, 6).map((x, i) => ({
    id: String.fromCharCode(65 + i), name: `客户${String.fromCharCode(65 + i)} · ${x.name}`,
    address: `${city}市${x.address.replace(/^上海市?/, '')}`, place: x.place,
    date: dates[Math.min(dates.length - 1, i < 2 ? 0 : 1)], start: slots[i % 3][0], end: slots[i % 3][1], duration_min: 90, time_is_assumed: true,
  }));

  const acts = [];
  const lastDay = dates[0];
  if (/网球/.test(text)) acts.push({ id: 'tennis', kind: 'tennis', label: '打网球', query: '网球场', date: lastDay, window_start: '16:00', window_end: '21:30', duration_min: 90, near: 'hotel', max_radius_km: 2 });
  if (/酒吧|清吧|喝一杯/.test(text)) acts.push({ id: 'bar', kind: 'bar', label: '去酒吧', query: '酒吧', date: lastDay, window_start: '20:30', window_end: '23:59', duration_min: 90, near: 'hotel', max_radius_km: 2 });
  if (/吃个?饭|晚饭|晚餐|请客/.test(text)) acts.push({ id: 'food', kind: 'food', label: /客户|请客/.test(text) ? '请客户吃饭' : '吃饭', query: '中餐厅', date: lastDay, window_start: '18:30', window_end: '21:00', duration_min: 120, near: 'hotel', max_radius_km: 1.5 });
  const bud = text.match(/预算\s*(\d{3,5})/) || text.match(/(\d{3,5})\s*(?:元|块)?\s*以内/);
  const followups = !biz ? [] : [
    { id: 'times', question: '客户时间还没定，先按上午 9:30 / 下午 2:00 占位可以吗？', options: ['可以，先占位', '我来填具体时间'] },
    { id: 'luggage', question: '带行李吗？（带行李默认打车）', options: ['一个登机箱', '不带'] },
    { id: 'brand', question: '有协议或会员酒店吗？', options: ['全季', '亚朵', '没有'] },
  ];
  const holiday = dates.some(d => d >= `${today.getFullYear()}-10-01` && d <= `${today.getFullYear()}-10-08`);
  if (holiday) followups.unshift({ id: 'holiday', question: `${dates[0].slice(5)} 在国庆假期内，客户那天上班吗？`, options: ['确认上班', '改到节后'] });
  const n = cl.length || clientCount(text);
  const task = {
    city, start_date: dates[0], end_date: dates[dates.length - 1],
    summary: !biz ? `${city} ${dates.length} 天` + (acts.length ? '：' + acts.map(a => a.label).join('、') : '') : `${city}出差 ${dates.length} 天：拜访 ${n} 家客户${acts.length ? '，' + acts.map(a => a.label).join('、') : ''}${bud ? `，酒店 ≤ ¥${bud[1]}` : ''}`,
    clients: cl, activities: acts, stops: [], people: [], time: { arrive_part: '', free_budget_min: Slots.freeBudget(text) },
    scenario_guess: { primary: biz ? 'business' : 'unclear', reason: '规则解析' },
    hotel: { name: '', status: 'unknown', budget_max: bud ? +bud[1] : 800, min_rating: 4.3, brands: [], nights: Math.max(1, dates.length - 1) },
    followups,
    assumptions: !biz ? [] : ['客户具体时间未给出，按默认时段占位（可改）', ...(acts.length ? ['网球、酒吧默认排在第一天晚上、酒店 2km 内'] : []), '最后一天结束后回酒店取行李'],
  };
  if (!bud) task.hotel.budget_max = 0;
  applyAskPlan(task, text, hint);
  return task;
}

/* 规则版变更解析：输出结构化 diff，时间由编排器计算 */
function replan(text) {
  const ops = [];
  const kindOf = s => /酒吧|清吧/.test(s) ? 'bar' : /网球/.test(s) ? 'tennis' : /吃饭|餐|饭/.test(s) ? 'food' : /客户/.test(s) ? 'client' : 'none';
  const m = text.match(/把(.+?)(?:换成|改成|改为|替换成)(.+)/);
  if (m) {
    const nk = kindOf(m[2]);
    const isDinner = nk === 'food';
    ops.push({ op: 'replace', target_kind: kindOf(m[1]), target_name: '', new_kind: nk, query: isDinner ? '中餐厅' : m[2].replace(/[。！!]/g, ''), label: isDinner && /客户/.test(m[2]) ? '请客户吃饭' : m[2].replace(/[。！!]/g, ''),
      window_start: isDinner ? '18:30' : '20:30', window_end: isDinner ? '21:30' : '23:30', duration_min: isDinner ? 120 : 90, near: 'ask', needs: isDinner ? '包间' : '' });
  } else if (/取消|不去|不打|删掉/.test(text)) {
    ops.push({ op: 'remove', target_kind: kindOf(text), target_name: '', new_kind: 'none', query: '', label: '', window_start: '', window_end: '', duration_min: 0, near: 'current', needs: '' });
  } else if (/加|再去|顺便/.test(text)) {
    const nk = kindOf(text);
    ops.push({ op: 'add', target_kind: 'none', target_name: '', new_kind: nk === 'none' ? 'food' : nk, query: text.replace(/.*(加|再去|顺便)/, '').slice(0, 10) || '餐厅', label: text.slice(0, 12),
      window_start: '12:00', window_end: '22:00', duration_min: 60, near: 'hotel', needs: '' });
  }
  const ask = ops.some(o => o.near === 'ask');
  return {
    intent: ops.length ? text : '没有识别出改动',
    ops,
    question: ask ? { text: '餐厅放在哪里？', options: ['🏨 酒店附近', '🏢 客户公司附近', '📍 两者中间'] } : { text: '', options: [] },
    explanation: ops.length ? '只动受影响的这一段，客户时间窗不变；具体时间由编排器重算。' : '没看懂要改什么，可以说“把酒吧换成请客户吃饭”。',
  };
}

module.exports = { applyAskPlan, clientCount, geocode, poi, matrix, route, parseTask, replan };
