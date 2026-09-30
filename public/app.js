/* 地图任务 Agent · v1 前端
   流程：一句话 → /api/parse（LLM 结构化）→ 地理编码 → 地点检索 → 批量算路 → 编排器打分/排程 → 可视化、拖拽、变更审批
   所有地点、距离、时间都来自接口或编排器；接口返回 mock:true 时界面标「示例数据」。 */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const params = new URLSearchParams(location.search);
const SHOT = params.has('shot');
if (SHOT) document.body.classList.add('shot');
const PL = window.Planner;
const { toMin, toHM, haversineKm, ptKey } = PL;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pause = ms => new Promise(r => setTimeout(r, SHOT ? 0 : ms));
const short = n => String(n || '').replace(/（.*?）/g, '').replace(/\(.*?\)/g, '');
// 卡片里保留分店名（真实数据常有同名连锁，如两家「快网网球俱乐部」），只去掉「上海」前缀和示例标记
const nm = n => String(n || '').replace(/（.*?）/g, '').replace(/\((?:上海市?)?(.*?)\)/g, (_, b) => b ? '·' + b : '');

const DEMO_TEXT = '下周一到周二去上海出差，拜访三家客户：A 公司在陆家嘴上海中心大厦（浦东新区银城中路501号）、B 公司在静安嘉里中心（静安区南京西路1515号）、C 公司在徐家汇港汇恒隆广场（徐汇区虹桥路1号），晚上想打网球、去个酒吧，酒店预算800以内';
const CHIPS = [
  { emo: '🧳', lab: '上海出差：3 个客户 + 网球 + 酒吧', fill: DEMO_TEXT },
  { emo: '🤝', lab: '两人公平汇合吃饭（v1 未做）', fill: '我在五角场、朋友在莘庄，找个两人都方便的餐厅。' },
];
const CATS = {
  tennis: { label: '网球', emo: '🎾', color: '#059669', query: '网球场', win: '16:00', dur: 90 },
  bar: { label: '酒吧', emo: '🍸', color: '#D97706', query: '酒吧', win: '20:30', dur: 90 },
  food: { label: '餐厅', emo: '🍽', color: '#DC2626', query: '中餐厅', win: '18:30', dur: 90 },
  cafe: { label: '咖啡', emo: '☕', color: '#92400E', query: '咖啡馆', win: '15:00', dur: 60 },
  gym: { label: '健身', emo: '🏋', color: '#2563EB', query: '健身房', win: '07:00', dur: 60 },
  sight: { label: '景点', emo: '📷', color: '#0891B2', query: '景点', win: '10:00', dur: 90 },
  museum: { label: '看展', emo: '🖼', color: '#BE185D', query: '美术馆', win: '10:00', dur: 120 },
  event: { label: '观赛', emo: '🏟', color: '#0F766E', query: '体育场馆', win: '12:00', dur: 180 },
  stop: { label: '行程点', emo: '📌', color: '#7C3AED' },
  other: { label: '地点', emo: '📍', color: '#6B7280', query: '', win: '10:00', dur: 60 },
  client: { label: '客户', emo: '🏢', color: '#7C3AED' },
  hotel: { label: '酒店', emo: '🏨', color: '#111', query: '酒店' },
};
const CAT_LABEL = { hotel: '🏨 住宿', client: '🏢 客户', tennis: '🎾 网球', bar: '🍸 酒吧', food: '🍽 餐厅', cafe: '☕ 咖啡', gym: '🏋 健身', sight: '📷 景点', museum: '🖼 看展', event: '🏟 观赛', other: '📍 地点' };
const MATCH = { ambiguous: '同名多处 · 请确认', exact: '名称一致', alias: '同一地点 · 百度名称不同', homophone: '按同音字纠正 · 请确认', guess: '最接近的一家 · 请确认', none: '没找到' };
const CAT_CLASS = { hotel: 'hotel', client: 'client', tennis: 'tennis', bar: 'bar', food: 'dinner' };
// 不用黄/橙：百度底图的高架、快速路是橙黄色，同色路线会「消失」（实测延安高架上的橙色路线看不见）
const SEG_COLORS = ['#3DB2F5', '#14B8A6', '#8B5CF6', '#E11D48', '#EC4899', '#0EA5E9', '#22C55E'];
const DAY_COLORS = ['#2563EB', '#DB2777', '#059669', '#7C3AED'];
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const dayLabel = d => { const dt = new Date(d + 'T12:00:00'); return `${d.slice(5).replace('-', '.')} 周${WD[dt.getDay()]}`; };
const fmtKm = d => d < 1 ? Math.round(d * 100) * 10 + 'm' : d.toFixed(1) + 'km';

const S = {
  status: null, text: '', task: null, answers: {}, clients: [], hotels: [], score: null, top: [], hotel: null,
  pois: {}, matrix: new Map(), days: [], day: 'd1', routes: new Map(), transit: new Map(), log: [], busy: false, pipelineDone: false, routeTimeAt: null,
  change: null, radar: { r: 2, cat: null, sel: null }, highlight: null, dragging: null, warn: [],
};
let TR = PL.makeTravel(lookup);
function lookup(a, b, mode) { return S.matrix.get(ptKey(a) + '>' + ptKey(b) + '|' + mode) || null; }
function resetTravel() { TR = PL.makeTravel(lookup); }
let uidN = 0;
function mkItem(kind, p, opts = {}) {
  return Object.assign({ uid: kind + '-' + (++uidN), kind, name: p.name, lat: p.lat, lng: p.lng, poiUid: p.uid, mock: !!p.mock,
    rating: p.rating, price: p.price, hours: p.hours, address: p.address }, opts);
}

/* ---------------- 日志 / 徽章 ---------------- */
let cur = 1;
function addLog(e) { e.t = Date.now(); S.log.push(e); refreshLogViews(); return e; }
function refreshLogViews() { renderBadge(); renderLogSheet(); if (cur === 3) renderActivity(); }
function netEntries() { return S.log.filter(e => e.kind === 'api' && e.state === 'done'); }
const isLLM = e => /LLM|parse|replan/.test(e.api || '');
function mapEntries() { return netEntries().filter(e => !isLLM(e)); }
/* 徽章只看百度地图接口：大模型没接时退回规则解析，不影响地点/距离/时间是否真实 */
function isReal() {
  const net = mapEntries();
  if (!net.length) return !!(S.status && S.status.baiduAk && !S.status.forceMock && !(S.status.baiduLast && !S.status.baiduLast.ok));
  return !net.some(e => e.mock);
}
const srcTag = e => isLLM(e) ? (e.mock ? '<span class="src mock">规则解析</span>' : '<span class="src real">文心 ERNIE</span>')
  : e.mock ? '<span class="src mock">示例数据</span>' : `<span class="src real">真实${e.cached ? '·缓存' : ''}</span>`;
function renderBadge() {
  const b = $('#dataBadge'), real = isReal();
  b.textContent = real ? '真实数据' : '示例数据';
  b.className = 'data-badge ' + (real ? 'real' : 'mock');
  const reasons = [...new Set(mapEntries().filter(e => e.mock && e.reason).map(e => e.reason))];
  b.title = reasons.length ? '示例数据原因：\n' + reasons.join('\n') : (real ? '地图数据全部来自百度真实接口' : '尚未调用接口');
  const mapKind = window.__useBaidu ? '百度地图' : '示意底图';
  $$('.map-badge').forEach(x => { x.textContent = `${mapKind} · ${real ? '真实数据' : '示例数据'}`; });
}
function renderLogSheet() {
  const net = netEntries();
  const mp = mapEntries(), lm = net.filter(isLLM);
  $('#logStat').textContent = `百度 ${mp.length} 次 · 真实 ${mp.filter(e => !e.mock).length} · 示例 ${mp.filter(e => e.mock).length}${lm.length ? ` · 大模型 ${lm.length} 次${lm.some(e => e.mock) ? '（规则解析）' : ''}` : ''}`;
  $('#logBody').innerHTML = S.log.map(e => `<div class="log-row">${e.ico} <b>${esc(e.lab)}</b> · ${e.kind === 'local' ? '本地编排器' : esc(e.api || '')}${e.ms != null ? ` · ${e.ms}ms` : ''}${e.cached ? ' · 缓存' : ''}
    ${e.kind === 'api' ? (e.state !== 'done' ? ' · 进行中' : e.mock ? ` · <span class="r">${isLLM(e) ? '规则解析' : '示例'}</span>` : ' · 真实') : ''}
    ${e.detail ? `<br><span style="color:#6B7280">${esc(e.detail)}</span>` : ''}${e.mock && e.reason ? `<br><span class="r">${esc(e.reason)}</span>` : ''}</div>`).join('') || '<div class="hint">还没有调用</div>';
}

async function api(name, { query, body } = {}, meta) {
  const entry = meta ? addLog({ kind: 'api', ico: meta.ico, lab: meta.lab, state: 'run', api: name, phase: meta.phase }) : null;
  const url = '/api/' + name + (query ? '?' + new URLSearchParams(query) : '');
  let r;
  try {
    const res = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    r = await res.json();
    if (!res.ok) throw new Error(r.error || 'HTTP ' + res.status);
  } catch (e) { r = Object.assign(r || {}, { mock: true, reason: '后端出错：' + e.message, failed: true }); }
  if (entry) {
    Object.assign(entry, { state: 'done', mock: !!r.mock, reason: r.reason, ms: r.ms, api: r.api || name, cached: r.cached });
    if (meta.detail && !r.failed) { try { entry.detail = meta.detail(r); } catch (e) { entry.detail = ''; } }
    refreshLogViews();
  }
  return r;
}
const localStep = (ico, lab, detail, phase = 'pipeline') => addLog({ kind: 'local', ico, lab, detail, state: 'done', phase });

/* ---------------- 解析任务 ---------------- */
function datesBetween(a, b) {
  const out = []; const d = new Date(a + 'T12:00:00'), e = new Date((b || a) + 'T12:00:00');
  while (d <= e && out.length < 7) { out.push(d.toLocaleDateString('sv-SE')); d.setDate(d.getDate() + 1); }
  return out.length ? out : [a];
}
function normalizeTask(t) {
  t.clients = (t.clients || []).map((c, i) => Object.assign({ id: String.fromCharCode(65 + i), duration_min: 90 }, c));
  t.activities = (t.activities || []).map(a => Object.assign({}, a, { kind: CATS[a.kind] ? a.kind : 'other', duration_min: a.duration_min || 90, max_radius_km: a.max_radius_km || 2 }));
  t.hotel = Object.assign({ budget_max: 0, min_rating: 4.3, brands: [], nights: 1 }, t.hotel || {});
  t.dates = datesBetween(t.start_date, t.end_date);
  // 点名行程点（用户给了地点和时间）+ 点名酒店：不做酒店筛选、不检索替代地点，时间照用户说的
  t.stops = (t.stops || []).map((x, i) => Object.assign({ id: 's' + (i + 1), duration_min: 120 }, x, { kind: CATS[x.kind] && !['stop', 'client', 'hotel'].includes(x.kind) ? x.kind : 'other' }));
  t.stops.forEach(x => { if (!t.dates.includes(x.date)) x.date = t.dates[0]; if (x.start && !/^\d{1,2}:\d{2}$/.test(x.start)) x.start = ''; });
  t.fixedHotel = !!String(t.hotel.name || '').trim();
  t.clients.forEach(c => { if (!t.dates.includes(c.date)) c.date = t.dates[0]; });
  t.activities.forEach(a => { if (!t.dates.includes(a.date)) a.date = t.dates[0]; });
  return t;
}
let parsing = null;
async function doParse(text, hint) {
  S.text = text; S.task = null; S.pipelineDone = false; S.change = null; S.hint = hint || '';
  S.log = S.log.filter(() => false);
  $('#s2user').textContent = text;
  $('#s2intro').textContent = '正在理解你的任务…';
  $('#taskList').innerHTML = ''; $('#askRow').innerHTML = ''; $('#assumeList').innerHTML = '';
  parsing = api('parse', { body: { text, hint: hint || undefined } }, { ico: '🧩', lab: `理解任务 · 大模型结构化输出${hint ? ' · 你选的场景：' + Slots.TEMPLATES[hint].name : ''}`, phase: 'parse',
    detail: r => `${r.task.hotel && r.task.hotel.name ? '指定酒店「' + r.task.hotel.name + '」 · ' : ''}${(r.task.stops || []).length ? r.task.stops.length + ' 个点名地点 · ' : ''}${r.task.clients.length} 个客户 · ${r.task.activities.length} 项活动 · ${r.task.followups.length} 个追问${r.fixes && r.fixes.length ? ' · 本地校验补全：' + r.fixes.join('，') : ''}` });
  const r = await parsing; parsing = null;
  S.task = normalizeTask(r.task);
  S.clients = S.task.clients.map(c => Object.assign({}, c));
  S.flowOpen = undefined; S.hotelPick = null; S.answers = {}; S.hb = null; S.hotelPre = null; S.venue = {}; S.gapAns = {}; S.gapDone = []; S.gapSkip = new Set(); S.fragIn = null; S.frag = null; S.fragOnly = false; S.poolIn = null; S.pool = null; S.openIn = null;
  const sc = S.task.scenario || {};
  localStep('🧭', sc.unclear ? '场景：看不出来 → 问一道选择题' : `场景 ${Slots.TEMPLATES[sc.primary].no} · ${Slots.TEMPLATES[sc.primary].name}（${Slots.TEMPLATES[sc.primary].mode}）`,
    sc.unclear ? `模型猜的：${sc.guess || '—'} · 原话里没有硬信号` : `${sc.reason}${sc.segments && sc.segments.length > 1 ? ' · 按天拆：' + sc.segments.map(g => `${g.dates.map(d => d.slice(5)).join('/')} ${Slots.TEMPLATES[g.scenario].name}`).join('；') : ''} · 要问：${flowAsks().map(f => STEP_NAME[f.type]).join(' → ') || '不用问'}（代码算的缺口）`, 'parse');
  renderTasks(r);
  return S.task;
}
function renderTasks(r) {
  const t = S.task; if (!t) return;
  const n = t.clients.length + t.activities.length + t.stops.length + 2;
  $('#s2intro').innerHTML = `我拆成了 <b>${n} 项</b>，先确认一下再开始查。${r && r.mock ? '<span class="mock-tag">（规则解析 · 未接大模型）</span>' : ''}`;
  $('#s2tag').textContent = `${t.dates.length} 天 ${t.hotel.nights || Math.max(1, t.dates.length - 1)} 晚`;
  const rows = [
    ...t.clients.map((c, i) => c.pending ? { emo: '🏢', name: `客户${i + 1} · 位置待填`, meta: c.notFound ? `百度没找到「${c.said}」，换个说法再核对` : '在下面「客户在哪」一步填公司名或地址' }
      : ({ emo: '🏢', name: c.name, meta: `${c.verified ? '百度核对 · ' : ''}${c.place && c.place !== c.address ? short(c.place) + ' · ' : ''}${c.address}${c.verified && !['exact', 'alias'].includes(c.match) ? ' · ⚠ 请确认' : ''} · ${t.dates_pending ? '日期待定' : dayLabel(c.date) + ' ' + c.start + '–' + c.end}${c.time_is_assumed ? '（时间待定，先占位）' : ''}`, hard: true })),
    t.dates_pending ? { emo: '📅', name: '日期 · 待定', meta: `${t.city} · 在下面第一步选日期` }
      : { emo: '📅', name: `日期 · ${dayLabel(t.dates[0])} – ${dayLabel(t.dates[t.dates.length - 1])}`, meta: `${t.city} · ${t.dates.length} 天` },
    ...t.stops.map(x => ({ emo: CATS[x.kind].emo, name: `${x.purpose || CATS[x.kind].label} · ${x.name}`, hard: !!x.start,
      meta: `${x.fromVenue ? '你定好的 · ' + short(x.place.name) + ' · ' : ''}${dayLabel(x.date)} ${x.start ? x.start + (x.end && x.duration_from === 'user' ? '–' + x.end + '（你给的时间）' : ' 开始') : x.window_start ? x.window_start + ' 以后' : '时间待定'} · ${x.duration_min} 分钟${x.duration_is_assumed ? '（时长是假设）' : ''}${x.back_to_hotel_after ? ' · 之后回酒店' : ''}${x.query && x.query !== x.name ? ` · 按「${x.query}」检索` : ''}${x.src ? (x.src.web ? ' · 来自网页（出发前看原文）' : ' · 大模型建议 · 百度核实') : ''}` })),
    ...t.activities.map(a => ({ emo: CATS[a.kind].emo, name: `${a.label} · ${a.duration_min} 分钟${a.status === 'undecided' ? ' · 地方定了吗？' : ''}`, meta: `${dayLabel(a.date)} ${a.window_start}–${a.window_end} · 离酒店 ${a.max_radius_km}km 内 · 检索词「${a.query}」` })),
    ...(t.scenario && t.scenario.primary === 'open_plan' && !(S.openIn && S.openIn.ready) ? [{ emo: '🎯', name: '开放式 · 兴趣 / 节奏 / 方案 待选', meta: '在下面一步：画像 → 近期活动（网页搜索）→ 分类菜单 → 给 2–3 个方向，挑一个再用百度找地点' }] : []),
    t.fixedHotel ? { emo: '🏨', name: `${t.hotel.stayLabel || '住'} ${t.hotel.name}`, meta: S.hotelPre ? '追问里已用百度核对 · 当每天的起点终点' : '你指定的酒店 · 不做酒店筛选，开始后用百度核对名称和位置', hard: true }
      : ['unknown', 'booked_unnamed'].includes(t.hotel.status) && !S.answers.hotel_booked ? { emo: '🏨', name: '酒店 · 订好了吗？', meta: '在下面回答：订好了就当起点终点；没订等地点定了再推荐' }
      : { emo: '🏨', name: '酒店偏好', meta: `${hotelPrefText(t.hotel)}${t.clients.some(c => c.pending) ? ' · 客户位置定了再搜' : ''}` },
  ];
  if (t.scenario && t.scenario.primary === 'carpool') { // 场景 4：列 司机 / 每个上车点 / 目的地 / 回程
    const P = S.poolIn, f = flowAsks().find(x => x.type === 'carpool') || { riders: [] }, ok = P && P.ready;
    const rs = ok ? P.riders.map((r, i) => ({ name: r.name, at: P.pts.riders[i].name, v: true })) : (P ? P.riders : f.riders).map(r => ({ name: r.name, at: r.at }));
    const fr = [
      { emo: '🚗', name: `司机 · ${(P || f).driver || '待填'}`, meta: ok ? `从 ${short(P.pts.driver.name)} 出发 · 百度核对` : `从 ${(P ? P.from : f.driverFrom) || '？'} 出发`, hard: ok },
      ...rs.map(r => ({ emo: '🙋', name: `接 · ${r.name || '？'}`, meta: r.at ? `在 ${short(r.at)} 上车${r.v ? ' · 百度核对' : ''}` : '上车点待填', hard: !!r.v })),
      { emo: '🏁', name: `目的地 · ${ok ? short(P.pts.dest.name) : (P || f).dest || '待填'}`, meta: `${dayLabel(t.start_date)} ${(P || f).deadline ? (P || f).deadline + ' 前到' : '几点到待填'}`, hard: ok },
      { emo: '↩️', name: `回程 · ${(P ? P.back : f.back) ? '反着送回去' : '只算去程'}`, meta: '散场时间先按活动常见时长假设' },
    ];
    $('#s2intro').innerHTML = `拼车接送：我拆成了 <b>${fr.length} 项</b>，核对完上车点就排每人几点下楼。${r && r.mock ? '<span class="mock-tag">（规则解析 · 未接大模型）</span>' : ''}`;
    $('#s2tag').textContent = '当天 · 接送';
    $('#taskList').innerHTML = fr.map((x, i) => `<div class="check-item"><span class="check on" data-i="${i}"></span><div class="check-body"><div class="name">${x.emo} ${esc(x.name)}${x.hard ? ' <span style="font-size:11px">🔒</span>' : ''}</div><div class="meta">${esc(x.meta)}</div></div></div>`).join('');
    $('#assumeList').innerHTML = ''; renderSlots(); renderAsk(); return;
  }
  if (t.scenario && t.scenario.primary === 'free_time') { // 场景 5：只列 在哪 / 空多久 / 之后去哪，不列酒店和「参观」
    const F = S.fragIn, f = flowAsks().find(x => x.type === 'frag') || {};
    const fr = [
      { emo: '📍', name: `现在在 · ${F && F.ready ? short(F.from.name) : f.here || '待填'}`, meta: F && F.ready ? `百度核对 · ${F.from.address || ''}` : '在下面一步填，我用百度核对位置', hard: !!(F && F.ready) },
      { emo: '⏱', name: `空闲 · ${F && F.ready ? `${toHM(F.start)}–${toHM(F.end)}（${F.end - F.start} 分钟）` : f.budget ? f.budget + ' 分钟' : '待定'}`, meta: `${dayLabel(t.dates[0])} · 按时长定搜索半径，路上最多占 1/3` },
      { emo: '🎯', name: `之后 · ${F && F.ready ? (F.to ? short(F.to.name) + (F.nextAt ? ' ' + F.nextAt + ' 要到' : '') : '回原地') : f.next ? f.next + (f.nextAt ? ' ' + f.nextAt + ' 要到' : '') : '回原地'}`, meta: '有下一站就按绕路算，提前 10 分钟到', hard: !!f.nextAt },
    ];
    $('#s2intro').innerHTML = `碎片时间：我拆成了 <b>3 项</b>，核对一下位置就开始找。${r && r.mock ? '<span class="mock-tag">（规则解析 · 未接大模型）</span>' : ''}`;
    $('#s2tag').textContent = '当天 · 不住宿';
    $('#taskList').innerHTML = fr.map((x, i) => `<div class="check-item"><span class="check on" data-i="${i}"></span><div class="check-body"><div class="name">${x.emo} ${esc(x.name)}${x.hard ? ' <span style="font-size:11px">🔒</span>' : ''}</div><div class="meta">${esc(x.meta)}</div></div></div>`).join('');
    $('#assumeList').innerHTML = ''; renderSlots(); renderAsk(); return;
  }
  if (t.scenario && t.scenario.unclear) { // 场景不清楚：先只问一道选择题，不列一堆猜出来的项
    $('#s2intro').innerHTML = '这句话我还看不出你想让我做哪种安排，选一个我就按那套流程问你。';
    $('#taskList').innerHTML = ''; $('#assumeList').innerHTML = ''; renderSlots(); renderAsk(); return;
  }
  $('#taskList').innerHTML = rows.map((x, i) => `
    <div class="check-item"><span class="check on" data-i="${i}"></span>
      <div class="check-body"><div class="name">${x.emo} ${esc(x.name)}${x.hard ? ' <span style="font-size:11px">🔒</span>' : ''}</div><div class="meta">${esc(x.meta)}</div></div>
      <button class="edit" style="align-self:center">改</button></div>`).join('');
  $('#assumeList').innerHTML = t.assumptions && t.assumptions.length ? '💡 我做的假设：' + t.assumptions.map(esc).join('；') : '';
  renderSlots();
  renderAsk();
}
/* v2「我怎么理解的」：5 个栏目 + 场景（实时反映追问的回答） */
const STEP_NAME = { scenario: '选场景', dates: '日期', clients: '客户在哪', venue: '定了没', hotel_booked: '酒店订了吗', hotel: '酒店偏好', frag: '在哪/空多久', carpool: '接谁/在哪/几点到', open: '兴趣/方案' };
function liveGaps() { return flowAsks().filter(f => !flowDone(f.type)); }
function renderSlots() {
  const t = S.task, box = $('#slotBox'); if (!box || !t) return;
  const sc = t.scenario || {}, T = Slots.TEMPLATES[sc.primary];
  const v = Slots.toSlots(t, liveGaps().length || !S.fragIn ? liveGaps() : (t.followups || []).filter(f => f.type === 'frag'));
  const F = S.fragIn;
  if (F && F.ready) v.anchors = [{ role: '当前位置', said: F.from.name, status: 'named' }, { role: '之后去', said: F.to ? F.to.name : '回原地', time: F.to && F.nextAt ? F.nextAt + ' 要到' : '', status: F.to ? 'named' : 'none' }];
  const isFree = sc.primary === 'free_time';
  const chip = st => `<span class="st st-${st}">${Slots.STATUS_LABEL[st] || st}</span>`;
  const anchors = v.anchors.filter(a => a.said || a.role === '酒店').map(a => `${a.role}${a.said ? ' ' + esc(short(a.said).slice(0, 10)) : ''}${a.time ? ' ' + a.time : ''}${a.dur === 'user' ? '<span class="fs-dim">（你给的时长）</span>' : ''} ${chip(a.status)}`);
  const rows = [
    ['锚点', anchors.join('　') || '—'],
    ['时间', t.dates_pending ? `日期 ${chip('unknown')}` : `${dayLabel(t.dates[0])}${t.dates.length > 1 ? ' – ' + dayLabel(t.dates[t.dates.length - 1]) : ''}${isFree ? (F && F.ready ? ` · ${toHM(F.start)}–${toHM(F.end)}` : v.time.arrive ? ` · ${esc(v.time.arrive)} 起` : ' · 从现在起') : v.time.arrive ? ' · ' + esc(v.time.arrive) + '到' : ''}${v.time.free_budget_min && !(isFree && F && F.ready) ? ` · 空 ${v.time.free_budget_min} 分钟` : isFree && F && F.ready ? ` · 空 ${F.end - F.start} 分钟` : ''}`],
    ['要找的', v.targets.map(x => `${CATS[x.kind] ? CATS[x.kind].emo : '📍'} ${esc(x.said || x.kind)} ${chip(x.status)}`).join('　') || '—'],
    ['偏好', v.prefs.map(esc).join(' · ') || '—'],
    ['缺口', liveGaps().map(f => STEP_NAME[f.type]).join(' → ') || '<span class="fc-ok">齐了，可以开始</span>'],
  ];
  const notReady = [...new Set([sc.primary, ...(sc.segments || []).map(g => g.scenario)])].map(k => Slots.TEMPLATES[k]).filter(x => x && !x.ready);
  const todo = notReady.length ? `<div class="slot-todo">${notReady.map(x => `「${x.name}」的专门流程在 ${x.todo} 做`).join('；')}，现在先按通用流程排</div>` : '';
  const seg = sc.segments && sc.segments.length > 1 ? `<div class="slot-seg">按天拆：${sc.segments.map(g => `${g.dates.map(d => d.slice(5).replace('-', '/')).join('、')} ${Slots.TEMPLATES[g.scenario].name}`).join(' ｜ ')} · 共用酒店</div>` : '';
  box.innerHTML = sc.unclear ? `<div class="slot-head">🧭 还没看出是哪种安排</div>` : `<div class="slot-head">🧭 场景 ${T.no} · ${T.name} <span class="fs-dim">${T.mode} · ${esc(sc.reason || '')}</span></div>${seg}
    <div class="slot-grid">${rows.map(([k, x]) => `<div class="slot-k">${k}</div><div class="slot-v">${x}</div>`).join('')}</div>${todo}`;
}
const hotelPrefText = h => `${h.budget_min && h.budget_max ? `¥${h.budget_min}–${h.budget_max}/晚` : h.budget_max ? '≤ ¥' + h.budget_max + '/晚' : '预算不限'} · 评分 ≥ ${h.min_rating}${h.near_metro ? ' · 近地铁' : ''}${h.brands && h.brands.length ? ' · ' + h.brands.join('/') : ''}`;

/* v1.4 分步追问：① 日期 → ② 客户在哪（百度核对）→ ③ 酒店偏好。问哪几步由后端按原话决定（说过的跳过），
   客户位置没定之前不开始规划：酒店要围绕客户中心点选 */
const FLOW = ['scenario', 'dates', 'clients', 'venue', 'hotel_booked', 'hotel', 'frag', 'carpool', 'open'];
const flowAsks = () => ((S.task && S.task.followups) || []).filter(f => FLOW.includes(f.type));
const venueItems = () => ((flowAsks().find(f => f.type === 'venue') || {}).items || []);
function flowDone(type) {
  const t = S.task;
  if (type === 'scenario') return false;
  if (type === 'dates') return !t.dates_pending;
  if (type === 'clients') return !t.clients.some(c => c.pending);
  if (type === 'venue') return venueItems().every(it => { const v = S.venue[it.id]; return v && (v.st === 'recommend' || (v.st === 'booked' && v.pick)); });
  if (type === 'hotel_booked') return !!S.answers.hotel_booked;
  if (type === 'frag') return !!(S.fragIn && S.fragIn.ready);
  if (type === 'carpool') return !!(S.poolIn && S.poolIn.ready);
  if (type === 'open') return !!(S.openIn && S.openIn.ready);
  return !!S.answers.hotel;
}
function askPending() {
  const t = S.task; if (!t) return '';
  if (flowAsks().some(f => f.type === 'scenario')) return '先选一下想让我帮你做哪种';
  if (t.dates_pending) return '先选日期';
  if (t.clients.some(c => c.pending)) return '先填客户在哪，我用百度核对（酒店要围绕客户位置选）';
  if (flowAsks().some(f => f.type === 'venue') && !flowDone('venue')) return '先说一下地方定了没（定了填名字，没定我来找）';
  if (flowAsks().some(f => f.type === 'hotel_booked') && !flowDone('hotel_booked')) return '先回答酒店订好了吗';
  if (flowAsks().some(f => f.type === 'carpool') && !flowDone('carpool')) return '先填谁开车、在哪接人、几点到（我用百度核对上车点）';
  if (flowAsks().some(f => f.type === 'open') && !flowDone('open')) return '先选兴趣和节奏、挑一个方案（地点用百度检索核实）';
  if (flowAsks().some(f => f.type === 'frag') && !flowDone('frag')) return '先说一下你在哪、空多久（我用百度核对位置）';
  return '';
}
function nextStep() { const f = flowAsks().find(x => !flowDone(x.type)); S.flowOpen = f ? f.type : null; }
function addDays(d, n) { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toLocaleDateString('sv-SE'); }
function datePresets() {
  const today = (S.status && S.status.today) || new Date().toLocaleDateString('sv-SE');
  const dow = new Date(today + 'T12:00:00').getDay(), mon = addDays(today, ((8 - dow) % 7) || 7);
  return [[addDays(today, 1), addDays(today, 2), '明天–后天'], [mon, addDays(mon, 1), '下周一–周二'], [addDays(mon, 2), addDays(mon, 3), '下周三–周四']];
}
const CLIENT_PH = ['如：陆家嘴金融中心', '如：静安嘉里中心', '如：漕河泾开发区', '公司名或地址', '公司名或地址', '公司名或地址'];
function clientRes(c) {
  if (c.verifying) return '<span class="fc-wait">百度核对中…</span>';
  if (c.notFound) return `<span class="fc-bad">✗ 百度没找到「${esc(c.said)}」，换个说法</span>`;
  if (!c.verified) return '';
  const ok = ['exact', 'alias'].includes(c.match);
  const why = c.match === 'ambiguous' ? esc(c.note || MATCH.ambiguous) : `${esc(MATCH[c.match] || '')}${c.note ? '（' + esc(c.note) + '）' : ''}${c.alts && c.alts.length ? ` · 其它候选：${esc(c.alts.map(a => short(a.name)).join('、'))}` : ''}`;
  return `<span class="${ok ? 'fc-ok' : 'fc-warn'}">${ok ? '✓' : '⚠ 请确认：'} ${esc(short(c.place))} · ${esc(c.address || '')}${ok ? '' : ' · ' + why}<span class="fs-dim"> · 图上标 ${esc(c.id)}</span></span>`;
}
function renderAsk() {
  const t = S.task; if (!t) return;
  const asks = flowAsks();
  if (S.flowOpen === undefined) nextStep();
  const hp = S.hotelPick = S.hotelPick || { price: '', tags: [] };
  const sum = type => {
    if (!flowDone(type)) return '';
    if (type === 'dates') return `${dayLabel(t.dates[0])} – ${dayLabel(t.dates[t.dates.length - 1])}`;
    if (type === 'clients') return t.clients.map(c => short(c.place)).join(' / ');
    if (type === 'venue') return venueItems().map(it => { const v = S.venue[it.id]; return v.st === 'booked' ? short(v.pick.name) : it.label + ' 帮我找'; }).join(' / ');
    if (type === 'hotel_booked') return S.answers.hotel_booked;
    if (type === 'open') { const O = S.openIn; return `${O.theme.title} · ${O.pace === 'full' ? '排满' : '松一点'}`; }
    if (type === 'carpool') { const P = S.poolIn; return `${P.driver || '司机'} → ${P.riders.map(r => r.name).join('、')} → ${short(P.pts.dest.name).slice(0, 6)} ${P.deadline}`; }
    if (type === 'frag') { const F = S.fragIn; return `${short(F.from.name).slice(0, 8)} · ${toHM(F.start)}–${toHM(F.end)}${F.to ? ' → ' + short(F.to.name).slice(0, 6) : ''}`; }
    return hotelPrefText(t.hotel);
  };
  const prefsBody = act => `<div class="fs-hint">每晚价格</div><div class="chips">${['500 以内', '500–800', '800–1200', '不限'].map(o => `<button class="chip ${hp.price === o ? 'active' : ''}" data-price="${o}">${o}</button>`).join('')}</div>
      <div class="fs-hint">其它（可多选）</div><div class="chips">${['近地铁', '评分 4.5+', '全季', '亚朵', '汉庭'].map(o => `<button class="chip ${hp.tags.includes(o) ? 'active' : ''}" data-tag="${o}">${o}</button>`).join('')}</div>
      <button class="fs-ok" data-act="${act}">好了</button>`;
  const placeRes = x => !x ? '' : x.verifying ? '<span class="fc-wait">百度核对中…</span>' : x.notFound ? `<span class="fc-bad">✗ 百度没找到「${esc(x.said)}」，换个说法</span>`
    : x.pick ? `<span class="${['exact', 'alias'].includes(x.match) ? 'fc-ok' : 'fc-warn'}">${['exact', 'alias'].includes(x.match) ? '✓' : '⚠ 请确认：'} ${esc(short(x.pick.name))} · ${esc(x.pick.address || '')}${['exact', 'alias'].includes(x.match) ? '' : ' · ' + esc(MATCH[x.match] || '')}</span>` : '';
  const body = f => {
    if (f.type === 'dates') return `<div class="chips">${datePresets().map(([a, b, l]) => `<button class="chip" data-dates="${a},${b}">${l} <span class="fs-dim">${a.slice(5).replace('-', '/')}–${b.slice(5).replace('-', '/')}</span></button>`).join('')}</div>
      <div class="fs-dates"><input type="date" id="fdA" value="${t.dates_pending ? '' : t.start_date}"> <span>到</span> <input type="date" id="fdB" value="${t.dates_pending ? '' : t.end_date}"><button class="fs-ok" data-act="dates">好</button></div>`;
    if (f.type === 'clients') return `<div class="fs-hint">填公司名、写字楼或地址都行，我用百度地点检索核对位置</div>
      ${t.clients.map((c, i) => `<div class="fc-row"><label>客户${i + 1}</label><input class="fc-in" data-i="${i}" value="${esc(c.said || (c.pending ? '' : short(c.place)))}" placeholder="${CLIENT_PH[i] || ''}"></div><div class="fc-res">${clientRes(c)}</div>`).join('')}
      <button class="fs-ok" data-act="clients">${t.clients.some(c => c.verifying) ? '核对中…' : '用百度核对'}</button>`;
    if (f.type === 'carpool') return poolStepBody(f);
    if (f.type === 'open') return openStepBody(f);
    if (f.type === 'frag') {
      const F = S.fragIn = S.fragIn || { here: f.here || '', budget: f.budget || 0, next: f.next || '', nextAt: f.nextAt || '', startAt: f.startAt || nowHM(), startGiven: !!f.startAt && !f.startVague };
      return `<div class="fs-hint">${esc(f.why || '')}</div>
        <div class="fc-row"><label>在哪</label><input id="frHere" class="fr-in" value="${esc(F.here)}" placeholder="如：徐家汇、静安寺、某某大厦"></div>
        <div class="fc-row"><label>几点起</label><input type="time" id="frStart" value="${esc(F.startAt)}"></div>
        <div class="fs-hint">空多久</div><div class="chips">${[60, 120, 180, 240].map(m => `<button class="chip ${F.budget === m ? 'active' : ''}" data-frb="${m}">${m / 60} 小时</button>`).join('')}${F.budget && ![60, 120, 180, 240].includes(F.budget) ? `<span class="chip active">${F.budget} 分钟</span>` : ''}</div>
        <div class="fs-hint">之后要赶去哪吗？（可不填，不填就回原地）</div>
        <div class="fc-row"><input id="frNext" class="fr-in" value="${esc(F.next)}" placeholder="下一站，如：浦东美术馆"><input type="time" id="frNextAt" value="${esc(F.nextAt)}" style="width:92px"></div>
        <div class="fc-res">${F.err ? `<span class="fc-bad">${esc(F.err)}</span>` : F.verifying ? '<span class="fc-wait">百度核对中…</span>' : ''}</div>
        <button class="fs-ok" data-act="frag">用百度核对</button>`;
    }
    if (f.type === 'scenario') return `<div class="fs-hint">${esc(f.why || '')}</div><div class="chips col">${Slots.CHOICES.map(c => `<button class="chip" data-scen="${c.id}">${esc(c.label)}</button>`).join('')}</div>`;
    if (f.type === 'venue') return `<div class="fs-hint">${esc(f.why || '')}</div>${(f.items || []).map(it => { const v = S.venue[it.id] || {};
      return `<div class="fv-row"><b>${CATS[it.kind] ? CATS[it.kind].emo : '📍'} ${esc(it.label)}</b> <button class="chip sm ${v.st === 'booked' ? 'active' : ''}" data-venue="${it.id}" data-st="booked">定了，我填</button><button class="chip sm ${v.st === 'recommend' ? 'active' : ''}" data-venue="${it.id}" data-st="recommend">还没定，帮我找</button></div>
        ${v.st === 'booked' ? `<div class="fc-row"><input class="fv-in" data-id="${it.id}" value="${esc(v.said || '')}" placeholder="店名、场馆名或地址"><button class="fs-ok sm" data-act="venue" data-id="${it.id}">核对</button></div><div class="fc-res">${placeRes(v)}</div>` : ''}`; }).join('')}`;
    if (f.type === 'hotel_booked') {
      const hb = S.hb || {};
      const opts = [['booked', '订好了'], ['recommend', '还没订，帮我推荐'], ['none', '不住酒店']];
      return `<div class="fs-hint">${esc(f.why || '')}</div><div class="chips">${opts.map(([k, l]) => `<button class="chip ${hb.mode === k ? 'active' : ''}" data-hb="${k}">${l}</button>`).join('')}</div>
        ${hb.mode === 'booked' || hb.mode === 'none' ? `<div class="fc-row"><input id="hbIn" value="${esc(hb.said || '')}" placeholder="${hb.mode === 'booked' ? '哪家酒店？如：全季酒店(上海虹桥)' : '住哪 / 从哪出发？如：朋友家小区名'}"><button class="fs-ok sm" data-act="hb">核对</button></div><div class="fc-res">${placeRes(hb)}</div>` : ''}
        ${hb.mode === 'recommend' ? `<div class="fs-hint">等地点都定了，按当天几个地点的中心推荐；只给跳转链接，不代订。偏好（可跳过）：</div>${prefsBody('hbrec')}` : ''}`;
    }
    return prefsBody('hotel');
  };
  const flow = asks.length ? `<div class="flow">${asks.map((f, i) => {
    const done = flowDone(f.type), open = S.flowOpen === f.type, locked = !done && !open && asks.slice(0, i).some(x => !flowDone(x.type));
    return `<div class="fs ${done ? 'done' : ''} ${open ? 'open' : ''} ${locked ? 'locked' : ''}" data-type="${f.type}">
      <div class="fs-head" data-open="${f.type}"><span class="fs-n">${done ? '✓' : i + 1}</span><b>${esc(f.question)}</b>${f.type === 'hotel' && !done ? '<span class="fs-dim">可跳过</span>' : ''}${f.type === 'scenario' ? '<span class="fs-dim">选一个</span>' : ''}<span class="fs-sum">${esc(sum(f.type))}</span></div>
      ${open ? `<div class="fs-body">${body(f)}</div>` : ''}</div>`;
  }).join('')}</div>` : '';
  const rest = (t.followups || []).map((f, i) => [f, i]).filter(([f]) => !FLOW.includes(f.type));
  $('#askRow').innerHTML = (asks.length ? `<span class="ask-lab">按顺序补几条信息：</span>${flow}` : '') +
    (rest.length ? `<span class="ask-lab">${asks.length ? '另外：' : '还缺几条信息，点一下就行：'}</span>` + rest.map(([f, i]) => `<button class="ask-btn" data-f="${i}">${S.answers[f.id] ? '✓ ' + esc(S.answers[f.id]) : esc(f.question)}</button>`).join('') : '');
  $('#s2go').classList.toggle('wait', !!askPending());
  renderSlots();
}
/* 活动「定了没」：定了 → 百度核对，变成点名地点（stop）；没定 → 状态改为「要推荐」，等锚点定了再搜 */
async function verifyVenue(id) {
  const t = S.task, it = venueItems().find(x => x.id === id), inp = $(`#askRow .fv-in[data-id="${id}"]`);
  const said = inp ? inp.value.trim() : ''; if (!said) { toast('填一个店名或地址'); return; }
  const v = S.venue[id] = Object.assign(S.venue[id] || {}, { st: 'booked', said, verifying: true, notFound: false, pick: null }); renderAsk();
  const r = await resolveOne(said, said, it.kind, `地点核对 · ${it.label}「${said}」`, 'parse');
  Object.assign(v, { verifying: false, pick: r.pick || null, match: r.match, note: r.note, notFound: !r.pick, candidates: r.candidates });
  if (r.pick) {
    const a = t.activities.find(x => x.id === id), idx = t.activities.indexOf(a);
    if (a) {
      t.activities.splice(idx, 1);
      t.stops.push({ id: 'v' + id, name: said, query: said, kind: a.kind, purpose: a.label, date: a.date, start: '', window_start: a.window_start, window_end: a.window_end,
        duration_min: Math.min(a.duration_min || 90, { food: 120, bar: 120, cafe: 90 }[a.kind] || 240), duration_is_assumed: true, status: 'booked', verified: true, place: Object.assign({}, r.pick, { cat: a.kind }), match: r.match, note: r.note, fromVenue: true });
    }
    localStep('📌', `${it.label}：你定好了「${said}」→ ${short(r.pick.name)}`, `${MATCH[r.match] || ''} · 当作点名地点排进日程，不再推荐`, 'parse');
  }
  if (flowDone('venue')) nextStep();
  renderTasks();
}
function setVenueRec(id) {
  const it = venueItems().find(x => x.id === id), a = S.task.activities.find(x => x.id === id);
  S.venue[id] = { st: 'recommend' }; if (a) a.status = 'recommend';
  localStep('🔍', `${it.label}：还没定 → 等地点和酒店定了在附近推荐`, '先问定了没再推荐（不替你选已经约好的地方）', 'parse');
  if (flowDone('venue')) nextStep(); renderTasks();
}
/* 酒店订好了吗：订好了 → 核对那家，当每天的起点终点；没订 → 偏好，等锚点定了按中心推荐（只给跳转）；不住 → 核对住处 */
async function verifyHotelBooked() {
  const t = S.task, hb = S.hb, said = ($('#hbIn') || {}).value ? $('#hbIn').value.trim() : '';
  if (!said) { toast(hb.mode === 'booked' ? '填酒店名' : '填住处或出发点'); return; }
  Object.assign(hb, { said, verifying: true, notFound: false, pick: null }); renderAsk();
  const r = await resolveOne(said, said, hb.mode === 'booked' ? 'hotel' : 'other', `地点核对 · ${hb.mode === 'booked' ? '你订的酒店' : '住处'}「${said}」`, 'parse');
  Object.assign(hb, { verifying: false, pick: r.pick || null, match: r.match, note: r.note, notFound: !r.pick });
  if (r.pick) {
    t.hotel.name = said; t.hotel.status = hb.mode === 'booked' ? 'booked' : 'none'; t.fixedHotel = true; t.hotel.stayLabel = hb.mode === 'none' ? '住处' : '';
    S.hotelPre = { said, r };
    S.answers.hotel_booked = `${hb.mode === 'booked' ? '订好了' : '不住酒店'} · ${short(r.pick.name)}`;
    localStep('🏨', `${hb.mode === 'booked' ? '酒店已订' : '不住酒店，住处'}：「${said}」→ ${short(r.pick.name)}`, `${MATCH[r.match] || ''} · 当每天的起点和终点，不再推荐酒店`, 'parse');
    nextStep();
  }
  renderTasks();
}
/* 场景 5：核对「在哪 / 之后去哪」，定出时间盒 [起, 止] */
const nowHM = () => { const d = new Date(); const m = Math.ceil((d.getHours() * 60 + d.getMinutes()) / 5) * 5; return toHM(m); };
function keepFragInputs() { const F = S.fragIn; if (!F || !$('#frHere')) return; F.here = $('#frHere').value.trim(); if ($('#frStart').value && $('#frStart').value !== F.startAt) F.startGiven = true; F.startAt = $('#frStart').value || F.startAt; F.next = $('#frNext').value.trim(); F.nextAt = $('#frNextAt').value; }
async function verifyFrag() {
  keepFragInputs(); const F = S.fragIn;
  if (!F.here) { toast('填一下你在哪'); return; }
  if (!F.budget && !(F.next && F.nextAt)) { toast('选一下空多久（或填下一站和时间）'); return; }
  F.verifying = true; F.err = ''; renderAsk();
  const r = await resolveOne(F.here, F.here, 'other', `地点核对 · 你在「${F.here}」`, 'parse');
  let to = null;
  if (F.next) { const r2 = await resolveOne(F.next, F.next, 'other', `地点核对 · 下一站「${F.next}」`, 'parse'); to = r2.pick ? Object.assign({}, r2.pick, { match: r2.match }) : null; if (!to) F.err = `百度没找到下一站「${F.next}」`; }
  F.verifying = false;
  if (!r.pick) { F.err = `百度没找到「${F.here}」，换个说法`; renderAsk(); return; }
  if (F.err) { renderAsk(); return; }
  F.from = Object.assign({}, r.pick, { match: r.match }); F.to = to;
  F.start = toMin(F.startAt || nowHM());
  F.end = to && F.nextAt ? toMin(F.nextAt) - GAP.arriveEarly : F.start + F.budget;
  // 说了「5点要到X，中间有2小时」但没说几点开始（或只说了「下午」）→ 从下一站往回推
  if (to && F.nextAt && F.budget && !F.startGiven && F.end - F.start > F.budget) F.start = F.end - F.budget;
  if (F.end - F.start < 30) { F.err = '空闲不到 30 分钟'; renderAsk(); return; }
  F.ready = true;
  localStep('📍', `碎片时间：${short(F.from.name)} ${toHM(F.start)}–${toHM(F.end)}${to ? ' → ' + short(to.name) + (F.nextAt ? ' ' + F.nextAt + ' 要到（提前 10 分钟）' : '') : ' · 回原地'}`, `${MATCH[r.match] || ''} · ${F.from.address || ''}`, 'parse');
  nextStep(); renderTasks(); renderSlots();
}
function hotelNotBooked() {
  const t = S.task; applyHotelPrefs(true);
  t.hotel.status = 'recommend'; S.answers.hotel_booked = '还没订 · ' + hotelPrefText(t.hotel);
  localStep('🏨', '酒店还没订 → 地点都定了再按中心推荐', `${hotelPrefText(t.hotel)} · 只给百度/携程/飞猪跳转，不代订`, 'parse');
  nextStep(); renderTasks();
}
function spreadClients() {
  const t = S.task, n = t.clients.length, D = t.dates.length, SLOTS = [['09:30', '11:00'], ['14:00', '15:30'], ['16:30', '18:00']], perDay = {};
  t.clients.forEach((c, i) => {
    if (c.start && !c.time_is_assumed && t.dates.includes(c.date)) return;
    const di = Math.min(D - 1, Math.floor(i * D / n)), k = perDay[di] || 0; perDay[di] = k + 1;
    c.date = t.dates[di]; [c.start, c.end] = SLOTS[k % 3]; c.time_is_assumed = true;
  });
  S.clients = t.clients.map(c => Object.assign({}, c));
}
function applyDates(a, b) {
  const t = S.task; if (!a) { toast('选一下开始日期'); return; }
  if (!b || b < a) b = a;
  Object.assign(t, { start_date: a, end_date: b, dates: datesBetween(a, b), dates_pending: false });
  t.hotel.nights = Math.max(1, t.dates.length - 1);
  t.activities.forEach(x => { if (!t.dates.includes(x.date)) x.date = t.dates[0]; });
  t.assumptions = (t.assumptions || []).filter(x => !/日期还没定/.test(x));
  if (t.dates.some(d => d.slice(5) >= '10-01' && d.slice(5) <= '10-08') && !t.followups.some(f => f.id === 'holiday'))
    t.followups.push({ id: 'holiday', question: `${a.slice(5)} 在国庆假期内，客户那天上班吗？`, options: ['确认上班', '改到节后'] });
  spreadClients(); S.answers.dates = `${a}–${b}`;
  localStep('📅', `日期：${dayLabel(a)} – ${dayLabel(b)}`, `${t.dates.length} 天 ${t.hotel.nights} 晚 · 你在追问里选的`, 'parse');
  nextStep(); refreshSummary(); renderTasks();
}
async function verifyClients() {
  const t = S.task, vals = $$('#askRow .fc-in').map(i => i.value.trim());
  if (vals.length !== t.clients.length || vals.some(v => !v)) { toast('每个客户填一个公司名或地址'); return; }
  vals.forEach((v, i) => { const c = t.clients[i]; if (!(c.verified && c.said === v)) Object.assign(c, { verifying: true, said: v }); });
  renderAsk();
  for (let i = 0; i < vals.length; i++) {
    const c = t.clients[i], v = vals[i]; if (!c.verifying) continue;
    const r = await resolveOne(v, v, 'client', `地点核对 · 客户${i + 1}「${v}」`, 'parse');
    c.verifying = false;
    if (r.pick) Object.assign(c, { name: `客户${c.id} · ${short(r.pick.name)}`, place: r.pick.name, address: r.pick.address || '', lat: r.pick.lat, lng: r.pick.lng, uid: r.pick.uid,
      match: r.match, note: r.note, verified: true, pending: false, notFound: false, mock: !!r.mock, alts: (r.candidates || []).filter(x => x.name !== r.pick.name).slice(0, 2) });
    else Object.assign(c, { verified: false, pending: true, notFound: true });
    renderAsk();
  }
  spreadClients();
  if (!t.clients.some(c => c.pending)) { t.clients_pending = 0; nextStep(); }
  refreshSummary(); renderTasks();
}
function applyHotelPrefs(quiet) {
  const t = S.task, hp = S.hotelPick, P = { '500 以内': [0, 500], '500–800': [500, 800], '800–1200': [800, 1200], '不限': [0, 0] }[hp.price];
  if (P) { t.hotel.budget_min = P[0]; t.hotel.budget_max = P[1]; }
  t.hotel.near_metro = hp.tags.includes('近地铁') || !!t.hotel.near_metro;
  if (hp.tags.includes('评分 4.5+')) t.hotel.min_rating = 4.5;
  t.hotel.brands = [...new Set([...(t.hotel.brands || []), ...hp.tags.filter(x => ['全季', '亚朵', '汉庭'].includes(x))])];
  S.answers.hotel = hotelPrefText(t.hotel);
  if (quiet === true) return;
  localStep('🏨', `酒店偏好：${S.answers.hotel}`, '你在追问里选的 · 客户位置定了之后按客户中心点检索', 'parse');
  nextStep(); renderTasks();
}
function refreshSummary() {
  const t = S.task, n = t.clients.length;
  if (flowAsks().some(f => f.type === 'clients')) t.summary = `${t.city}出差 ${t.dates_pending ? '' : dayLabel(t.dates[0]) + ' – ' + dayLabel(t.dates[t.dates.length - 1]) + ' '}拜访 ${n} 个客户${t.clients.some(c => c.verified) ? '：' + t.clients.filter(c => c.verified).map(c => short(c.place)).join('、') : ''}`;
}

/* ---------------- 规划流水线（过程可见） ---------------- */
const centroid = pts => ({ lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length, lng: pts.reduce((a, p) => a + p.lng, 0) / pts.length });
const actKinds = () => [...new Set((S.task.activities || []).map(a => a.kind))];
async function fetchMatrix(origins, dests, mode, lab, phase = 'pipeline') {
  const missing = origins.some(o => dests.some(d => ptKey(o) !== ptKey(d) && !S.matrix.has(ptKey(o) + '>' + ptKey(d) + '|' + mode)));
  if (!missing) return;
  const strip = p => ({ lat: p.lat, lng: p.lng });
  const r = await api('matrix', { body: { mode, origins: origins.map(strip), destinations: dests.map(strip) } }, { ico: '🧮', lab, phase,
    detail: r => `${r.elements} 条 OD${r.rows && r.rows[0] && r.rows[0][0] ? ` · 例：${(r.rows[0][0].m / 1000).toFixed(1)}km / ${Math.round(r.rows[0][0].s / 60)}min` : ''}` });
  (r.rows || []).forEach((row, i) => row.forEach((e, j) => {
    if (e && e.m != null && e.s != null) S.matrix.set(ptKey(origins[i]) + '>' + ptKey(dests[j]) + '|' + mode, { m: e.m, s: e.s, mock: !!r.mock });
  }));
  resetTravel();
}
async function fetchPois(center, cat, radius, phase = 'pipeline', query, pages = 1) {
  const key = (center.uid || ptKey(center));
  S.pois[key] = S.pois[key] || {};
  if (S.pois[key][cat] && !query) return S.pois[key][cat];
  const q = query || CATS[cat].query;
  const r = await api('poi', { query: { query: q, center: `${center.lat},${center.lng}`, radius, pages } }, { ico: CATS[cat].emo, phase,
    lab: `地点检索 · ${q} · ${short(center.name) || '中心点'} ${radius / 1000}km`, detail: r => `返回 ${r.results.length} 个${r.total != null ? '（共 ' + r.total + '）' : ''}` });
  const list = (r.results || []).map(p => Object.assign({}, p, { cat }));
  if (!query) S.pois[key][cat] = list;
  return list;
}
function pickPoi(a, hotel) {
  const list = (S.pois[hotel.uid] || {})[a.kind] || [];
  for (const r of [a.max_radius_km || 2, 3]) {
    const rk = PL.rankPois(list, hotel, r, { s: a.window_start, dur: a.duration_min });
    if (rk.inside.length) return { pick: rk.inside[0], rk, r };
  }
  return { pick: null, rk: PL.rankPois(list, hotel, 3, { s: a.window_start, dur: a.duration_min }), r: 3 };
}

/* 酒店选址 / 打分用的锚点：客户 + 点名地点（同一地点只算一次） */
function anchors() {
  const out = S.clients.map(c => c), seen = new Set(out.map(ptKey));
  (S.task.stops || []).forEach(x => { if (!x.place || seen.has(ptKey(x.place))) return; seen.add(ptKey(x.place)); out.push(Object.assign({}, x.place, { id: x.id, place: x.place.name })); });
  return out;
}
async function resolveOne(said, query, kind, lab, phase) {
  const t = S.task;
  const r = await api('place', { query: { name: said, query: query || said, kind, city: t.city || '上海' } }, { ico: '🔎', lab, phase,
    detail: r => r.pick ? `→ ${r.pick.name} · ${r.pick.address || ''} · ${MATCH[r.match] || r.match}${r.note ? '（' + r.note + '）' : ''}${r.candidates && r.candidates.length > 1 ? ` · 候选 ${r.candidates.length} 个` : ''}` : (r.note || '没找到') });
  if (r.llm) addLog({ kind: 'api', ico: '🤖', lab: `地点核对 · 大模型判断「${said}」对应哪一家`, api: 'LLM place · ' + r.llm, state: 'done', mock: false, phase: phase || 'pipeline',
    detail: `${MATCH[r.match] || r.match}：${r.note || ''} · 从百度 ${r.candidates.length} 个候选里选`, ms: null });
  return r;
}
async function resolveNamed() {
  const t = S.task, cache = new Map();
  if (t.fixedHotel) {
    const r = S.hotelPre && S.hotelPre.said === t.hotel.name ? S.hotelPre.r : await resolveOne(t.hotel.name, t.hotel.name, 'hotel', `地点核对 · 酒店「${t.hotel.name}」`);
    if (r.pick) {
      S.hotel = Object.assign({}, r.pick, { cat: 'hotel', said: t.hotel.name, match: r.match, note: r.note, alts: (r.candidates || []).filter(c => c.name !== r.pick.name).slice(0, 3), mock: !!r.mock });
      if (!['exact', 'alias'].includes(r.match)) S.warn.push({ lab: `酒店名：「${t.hotel.name}」→「${short(r.pick.name)}」`, meta: `${MATCH[r.match]}${r.note ? '，' + r.note : ''} · 其它候选：${S.hotel.alts.map(a => short(a.name)).join('、') || '无'}` });
    } else { t.fixedHotel = false; localStep('⚠️', `百度上没找到「${t.hotel.name}」`, '改为按地点附近推荐酒店'); }
  }
  for (const x of t.stops) {
    if (x.verified && x.place) continue; // 追问里已经核对过
    const key = (x.query || x.name) + '|' + x.kind;
    const r = cache.get(key) || await resolveOne(x.name, x.query, x.kind, `地点核对 · ${x.purpose || ''}「${x.name}」`);
    cache.set(key, r);
    x.place = r.pick ? Object.assign({}, r.pick, { cat: x.kind }) : null; x.match = r.match; x.note = r.note; x.alts = (r.candidates || []).filter(c => r.pick && c.name !== r.pick.name).slice(0, 3);
    if (!r.pick) S.warn.push({ lab: `没找到「${x.name}」`, meta: '百度地点检索没有结果，这一项没排进日程' });
    else if (!['exact', 'alias'].includes(r.match)) S.warn.push({ lab: `「${x.name}」→「${short(r.pick.name)}」`, meta: `${MATCH[r.match]}${r.note ? '，' + r.note : ''} · 其它候选：${x.alts.map(a => short(a.name)).join('、') || '无'}` });
  }
  // 不同叫法落到同一个百度地点（如 仙霞网球场 / 仙霞网球馆）
  const byUid = new Map();
  t.stops.filter(x => x.place).forEach(x => { const k = x.place.uid || ptKey(x.place); byUid.set(k, [...(byUid.get(k) || []), x]); });
  byUid.forEach(list => {
    const names = [...new Set(list.map(x => x.name))];
    if (names.length > 1) { const p = list[0].place; localStep('🔁', `「${names.join('」和「')}」是同一个地方`, `百度：${p.name} · ${p.address || ''}`); S.warn.push({ lab: `「${names.join('」「')}」按同一处算`, meta: `${short(p.name)} · ${p.address || ''}`, info: true }); }
  });
}

async function runPipeline() {
  if (S.busy) return; S.busy = true; S.pipelineDone = false;
  S.log = S.log.filter(e => e.phase === 'parse');
  refreshLogViews();
  const t = S.task;
  $('#s3sum').textContent = t.summary || '';
  $('#procBar').classList.remove('done');
  S.warn = [];
  if (askPending()) { localStep('⚠️', '还缺信息，先不搜酒店', askPending()); S.busy = false; return; }
  if (t.scenario && t.scenario.primary === 'carpool' && S.poolIn && S.poolIn.ready) { // 场景 4：不排酒店，算接人时间表
    await computeCarpool('pipeline'); renderPool();
    S.busy = false; S.pipelineDone = true; S.fragOnly = true; refreshLogViews(); return;
  }
  if (t.scenario && t.scenario.primary === 'free_time' && S.fragIn && S.fragIn.ready) { // 场景 5：不排酒店，只做碎片时间推荐
    const F = S.fragIn;
    await openFragment({ from: F.from, to: F.to, start: F.start, end: F.end, date: (S.status && S.status.today) || t.start_date, phase: 'pipeline' });
    S.busy = false; S.pipelineDone = true; S.fragOnly = true; refreshLogViews(); return;
  }
  S.clients.filter(c => c.verified && !['exact', 'alias'].includes(c.match)).forEach(c => S.warn.push({ lab: `客户：「${c.said}」→「${short(c.place)}」`, meta: `${MATCH[c.match] || ''}${c.note ? '，' + c.note : ''} · 请确认` }));
  // 0 点名的酒店 / 地点：百度核对（名字可能有同音字），核对不上就提示
  if (t.fixedHotel || t.stops.length) await resolveNamed();
  // 1 地理编码
  const verified = S.clients.filter(c => c.verified && c.lat);
  if (verified.length) localStep('📍', `客户位置：${verified.length} 个用追问里百度地点核对的坐标`, verified.map(c => `客户${c.id} ${short(c.place)} ${(+c.lat).toFixed(4)},${(+c.lng).toFixed(4)}`).join(' · '));
  for (const c of S.clients) {
    if (c.verified && c.lat) continue;
    const r = await api('geocode', { query: { address: c.address, city: t.city || '上海' } }, { ico: '📍', lab: `地理编码 · 客户${c.id} ${short(c.place) || c.address}`,
      detail: r => `${(+r.lat).toFixed(5)}, ${(+r.lng).toFixed(5)}${r.level ? ' · ' + r.level : ''}${r.confidence != null ? ' · 可信度 ' + r.confidence : ''}` });
    Object.assign(c, { lat: +r.lat, lng: +r.lng, mock: !!r.mock });
    await pause(180);
  }
  if (t.fixedHotel && S.hotel) {
    S.top = []; S.score = null; S.hotels = [S.hotel];
    localStep('🏨', `酒店由你指定：${short(S.hotel.name)} · 跳过酒店检索和打分`, `你说的「${t.hotel.name}」→ 百度「${S.hotel.name}」· ${S.hotel.address || ''}`);
    const far = anchors().map(a => `${short(a.name)} ${haversineKm(S.hotel, a).toFixed(1)}km`);
    if (far.length) localStep('📏', '各地点离酒店（直线）', far.join(' · ') + ' · 实际路程见下面算路');
    for (const k of actKinds()) await fetchPois(S.hotel, k, 3000);
    await selectHotel(S.hotel);
    S.busy = false; S.pipelineDone = true; refreshLogViews(); renderRecent();
    return;
  }
  // 2 酒店检索（锚点 = 客户 + 点名地点）
  const AN = anchors();
  if (!AN.length) { localStep('⚠️', '没有可定位的客户或地点', '说一下要去哪里'); S.busy = false; return; }
  const cen = centroid(AN); cen.name = S.clients.length ? `${S.clients.length} 客户中心` : `${AN.length} 个地点中心`;
  const hl = await fetchPois(cen, 'hotel', 5000, 'pipeline', '酒店', 2);
  S.hotels = hl.map(h => Object.assign(h, { cat: 'hotel' }));
  // 实测百度酒店 price 大多为空，偶尔是 ¥40 这类非房价数字（钟点房/床位）：< ¥100 视为不可靠，按「未知」处理
  const oddPrice = S.hotels.filter(h => h.price && h.price < 100);
  oddPrice.forEach(h => { h.priceRaw = h.price; h.price = null; });
  await pause(180);
  // 3 预筛
  const budget = t.hotel.budget_max || 0, minR = t.hotel.min_rating || 0;
  const over = S.hotels.filter(h => budget && h.price && h.price > budget);
  const low = S.hotels.filter(h => minR && h.rating && h.rating < minR && !over.includes(h));
  const pre = S.hotels.filter(h => !over.includes(h) && !low.includes(h));
  pre.forEach(h => { h.avgKm = AN.reduce((a, c) => a + haversineKm(h, c), 0) / AN.length; });
  let pool = pre.sort((a, b) => a.avgKm - b.avgKm);
  localStep('🧹', `预筛酒店：预算 ≤ ¥${budget || '∞'} · 评分 ≥ ${minR} → ${pre.length}/${S.hotels.length} 家`,
    `超预算 ${over.length} 家 · 评分不够 ${low.length} 家 · 价格未知 ${pre.filter(h => !h.price).length} 家保留${oddPrice.length ? `（其中 ${oddPrice.length} 家百度价格 < ¥100 不可靠）` : ''} · 按到客户直线距离排序`);
  const brands = t.hotel.brands || [];
  if (brands.length) { const b = pool.filter(h => brands.some(x => h.name.includes(x))); localStep('🏷', `品牌：${brands.join('/')} → ${b.length} 家`, b.length ? '只在这些里选' : '附近没有，不做硬筛'); if (b.length) pool = b; }
  if (t.hotel.near_metro && pool.length) {
    // 近地铁：离客户中心最近的 10 家，各查 1km 内地铁站，最近的站 ≤ 800m 才算
    for (const h of pool.slice(0, 10)) {
      const r = await api('poi', { query: { query: '地铁站', center: `${h.lat},${h.lng}`, radius: 1000, size: 10 } }, { ico: '🚇', lab: `地点检索 · 地铁站 · ${short(h.name)} 1km`,
        detail: r => { const m = nearestStation(h, r.results); return m ? `最近 ${short(m.name)} ${m.m}m` : '1km 内没有'; } });
      h.metro = nearestStation(h, r.results || []);
    }
    const near = pool.slice(0, 10).filter(h => h.metro && h.metro.m <= 800);
    localStep('🚇', `近地铁：${near.length}/${Math.min(10, pool.length)} 家离地铁站 ≤ 800m`, near.length >= 2 ? '只在这些里选 · ' + near.map(h => `${short(h.name)} ${h.metro.m}m`).join(' / ') : '不够 2 家，不做硬筛，卡片上标距离');
    if (near.length >= 2) pool = near;
  }
  const cand = pool.slice(0, 10);
  await pause(180);
  if (!cand.length) { localStep('⚠️', '附近没有符合预算和评分的酒店', '可以放宽预算或评分再试'); S.busy = false; return; }
  // 4 批量算路
  await fetchMatrix(cand, AN, 'walking', `批量算路 · 步行 ${cand.length} 酒店 × ${AN.length} ${S.clients.length ? '客户' : '地点'}`);
  await fetchMatrix(cand, AN, 'driving', `批量算路 · 驾车 ${cand.length} 酒店 × ${AN.length} ${S.clients.length ? '客户' : '地点'}`);
  // 5 打分
  S.score = PL.scoreHotels(cand, AN, (h, c) => TR(h, c), { budget, minRating: minR, maxCommute: 60 });
  S.top = S.score.ranked.slice(0, 3);
  if (!S.top.length) { localStep('⚠️', '没有酒店满足单程通勤 ≤ 60 分钟', S.score.rejected.map(x => x.reason).join('；')); S.busy = false; return; }
  localStep('⚖️', `酒店打分：通勤 50% + 评分 30% + 价格 20% → 推荐 ${short(S.top[0].hotel.name)}`,
    S.top.map(x => `${short(x.hotel.name)} ${x.score} 分 · 平均 ${Math.round(x.avg)} 分钟`).join(' / '));
  await pause(180);
  // 6 周边检索（前 3 家酒店 × 活动类别）
  for (const row of S.top) for (const k of actKinds()) { await fetchPois(row.hotel, k, 3000); await pause(80); }
  // 7 营业时间 + 距离筛
  const h0 = S.top[0].hotel;
  t.activities.forEach(a => {
    const { rk, r } = pickPoi(a, h0);
    const list = (S.pois[h0.uid] || {})[a.kind] || [];
    localStep('🕒', `筛选${CATS[a.kind].label}：营业时间 + ${r}km → ${list.length} 家留 ${rk.inside.length} 家`,
      `${a.window_start} 起 ${a.duration_min} 分钟要在营业 · 不营业 ${rk.closed.length} · 圈外 ${rk.outside.length} · 然后按评分排序`);
  });
  // 8 生成日程 + 日程点批量算路 + 路线
  await selectHotel(h0);
  S.busy = false; S.pipelineDone = true;
  refreshLogViews();
  renderRecent();
}

function nearestStation(h, list) {
  let best = null;
  (list || []).filter(p => (/地铁站|轻轨站/.test(p.tag || '') || /地铁站|号线/.test(p.name || '')) && !/酒店|宾馆|公寓|旅馆|店[)）]|公交/.test(p.name || '')).forEach(p => { const m = Math.round(haversineKm(h, p) * 1000); if (!best || m < best.m) best = { name: p.name.replace(/-?\d*号?(出入)?口.*$/, ''), m }; });
  return best;
}
async function selectHotel(h) {
  S.hotel = h;
  const t = S.task;
  for (const k of actKinds()) await fetchPois(h, k, 3000);
  buildDays();
  const notes = [...t.stops.filter(x => x.place).map(x => `${x.purpose || CATS[x.kind].label} ${x.start || ''} → ${short(x.place.name)}`),
    ...t.activities.map(a => a.unplaced ? `${a.label}：${a.unplaced}` : `${a.label} → ${short(a.placedName)}`)].join(' · ');
  localStep('🗓', t.stops.length ? '生成日程：你给的时间锁定 · 顺序按你说的 · 插入回酒店' : '生成日程：客户时间窗锁定 · 活动最便宜插入', notes);
  for (const d of S.days) await ensureDayMatrix(d);
  const fixedOrder = d => d.items.some(i => i.stopId || i.midReturn); // 用户排好的顺序不重排（全排列会把「回酒店」挪走来省路）
  S.days.forEach(d => { if (!fixedOrder(d)) d.items = PL.optimize(d.items, TR).items; PL.schedule(d.items, TR); });
  localStep('✨', S.days.some(fixedOrder) ? '顺序按你说的，不重排' : `全排列优化 ${S.days.length} 天的顺序`, S.days.map(d => `${d.label}：${d.items.length - 2} 个点 · 通勤 ${PL.schedule(d.items, TR).totalMin} 分钟`).join(' / '));
  for (const d of S.days) await fetchRoutes(d);
  if (S.days.some(fixedOrder)) {
    useRouteTimes();
    for (const d of S.days) await fetchTransit(d);
    const w = S.days.flatMap(d => d.items.filter(i => i.conflict || i.tight).map(i => `${d.label.split(' ')[0]} ${short(i.name)}：${i.conflict || i.tight}`));
    localStep(w.length ? '⚠️' : '✅', w.length ? `时间检查：${w.length} 处要注意` : '时间检查：都赶得上', w.join(' · ') || S.days.map(d => `${d.label} ${toHM(PL.schedule(d.items, TR).start)}–${toHM(PL.schedule(d.items, TR).end)}`).join(' / '));
  }
}
/* 点名行程：路段用时改用路线规划（direction）的距离/时间，和地图上的折线一致；批量算路只用于初排 */
function useRouteTimes() {
  let n = 0;
  S.days.forEach(d => { for (let i = 1; i < d.items.length; i++) {
    const a = d.items[i - 1], b = d.items[i]; if (ptKey(a) === ptKey(b)) continue;
    const mode = PL.chooseMode(a, b), r = S.routes.get(ptKey(a) + '>' + ptKey(b) + '|' + mode);
    if (r && r.m && r.s) { S.matrix.set(ptKey(a) + '>' + ptKey(b) + '|' + mode, { m: r.m, s: r.s, mock: r.mock }); n++; }
  } });
  resetTravel(); S.days.forEach(d => PL.schedule(d.items, TR));
  S.routeTimeAt = new Date();
  localStep('🧭', `路段用时以路线规划为准（${n} 段，与地图折线一致）`, `驾车时间是百度按查询时（${S.routeTimeAt.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}）的路况估算，不支持指定未来出发时间；节假日实际可能不同`);
}
/* 公交/地铁：按计划出发时间查 direction/v2/transit，赶不上固定时间的标出来（主方案仍是打车） */
async function fetchTransit(day, phase = 'pipeline') {
  const st = PL.schedule(day.items, TR);
  for (let i = 1; i < day.items.length; i++) {
    const a = day.items[i - 1], b = day.items[i];
    if (ptKey(a) === ptKey(b) || st.legs[i - 1].mode === 'walking') continue;
    const dep = toHM(a.e); // 最早能走的时间（第一段是打车方案的出发时间，只作参考）
    const k = `${ptKey(a)}>${ptKey(b)}@${day.date} ${dep}`;
    if (S.transit.has(k)) continue;
    const lab = x => x.kind === 'hotel' ? '酒店' : short(x.name).slice(0, 8);
    const r = await api('transit', { query: { origin: `${a.lat},${a.lng}`, destination: `${b.lat},${b.lng}`, date: day.date.replace(/-/g, ''), time: dep } }, { ico: '🚇', phase,
      lab: `公交/地铁 · ${lab(a)} → ${lab(b)} · ${day.date.slice(5)} ${dep} 出发`, detail: r => r.none ? '没有公交方案' : `${r.min} 分钟 · ${r.km}km${r.lines && r.lines.length ? ' · ' + r.lines.join(' → ') : ''}${r.price ? ' · ¥' + r.price : ''}` });
    S.transit.set(k, Object.assign({ dep }, r));
    b._tk = k;
  }
}
function transitFor(b) { return b && b._tk ? S.transit.get(b._tk) : null; }
function buildDays() {
  const t = S.task, h = S.hotel;
  S.days = t.dates.map((d, i) => {
    const last = i === t.dates.length - 1;
    const cs = S.clients.filter(c => c.date === d).sort((a, b) => toMin(a.start) - toMin(b.start));
    const ss = (t.stops || []).filter(x => x.date === d && x.place);
    const fixedItems = [
      ...cs.map(c => mkItem('client', c, { fixed: true, start: c.start, dur: c.duration_min || (toMin(c.end) - toMin(c.start)) || 90, clientId: c.id, name: c.name, address: c.address })),
      ...ss.map(x => mkItem(x.kind, x.place, { fixed: !!x.start, start: x.start || null, notBefore: x.start ? null : (x.window_start || '09:00'), notAfter: x.start ? null : (x.window_end || null), dur: x.duration_min || 120, stopId: x.id, label: x.purpose || CATS[x.kind].label, said: x.name, durAssumed: !!x.duration_is_assumed, durUser: x.duration_from === 'user', back: !!x.back_to_hotel_after, gapBack: x.gapBack || null, src: x.src || null })),
    ].sort((a, b) => toMin(a.start || a.notBefore || '23:00') - toMin(b.start || b.notBefore || '23:00')); // 只有时间窗的（空档里插入的）按窗口起点排
    const mids = [];
    fixedItems.forEach((it, k) => { mids.push(it); if (it.back && k < fixedItems.length - 1) mids.push(mkItem('hotel', h, { dur: 0, pinned: true, label: it.gapBack ? `回${t.hotel.stayLabel || '酒店'}歇会儿（空档）` : '回酒店', midReturn: true, gapBack: it.gapBack })); });
    const lastStop = ss.length ? fixedItems[fixedItems.length - 1] : null;
    const endLabel = cs.length ? (last ? '回酒店取行李 · 返程' : '回酒店') : lastStop && !lastStop.back ? '回酒店（你没说之后去哪，先按回酒店算）' : '回酒店';
    const items = [
      mkItem('hotel', h, { autoStart: true, start: '09:00', dur: 0, pinned: true, label: i === 0 ? (t.time && t.time.arrive_part ? `${t.time.arrive_part}到${t.city} · 从${t.hotel.stayLabel || '酒店'}出发` : ss.length ? '从酒店出发（假设已到酒店）' : '从酒店出发') : '出发' }),
      ...mids,
      mkItem('hotel', h, { dur: 0, pinned: true, label: endLabel }),
    ];
    return { key: 'd' + (i + 1), date: d, label: dayLabel(d), items };
  });
  t.activities.forEach(a => {
    const day = S.days.find(x => x.date === a.date) || S.days[0];
    const { pick } = pickPoi(a, h);
    if (!pick) { a.unplaced = `酒店 3km 内没有在 ${a.window_start} 营业的${CATS[a.kind].label}`; return; }
    a.unplaced = null; a.placedName = pick.name;
    const it = mkItem(a.kind, pick, { notBefore: a.window_start, notAfter: a.window_end, dur: a.duration_min, actId: a.id, label: a.label });
    day.items = PL.cheapestInsert(day.items, it, TR).items;
  });
  S.days.forEach(d => PL.schedule(d.items, TR));
  if (!S.days.find(d => d.key === S.day)) S.day = 'd1';
}
function uniquePts(items) { const m = new Map(); items.forEach(i => m.set(ptKey(i), i)); return [...m.values()]; }
async function ensureDayMatrix(day, phase = 'pipeline', items) {
  const pts = uniquePts(items || day.items);
  if (pts.length < 2) return;
  await fetchMatrix(pts, pts, 'walking', `批量算路 · ${day.label} 日程 ${pts.length}×${pts.length} 步行`, phase);
  await fetchMatrix(pts, pts, 'driving', `批量算路 · ${day.label} 日程 ${pts.length}×${pts.length} 驾车`, phase);
}
async function fetchRoutes(day, phase = 'pipeline') {
  let changed = false;
  for (let i = 1; i < day.items.length; i++) {
    const a = day.items[i - 1], b = day.items[i];
    if (ptKey(a) === ptKey(b)) continue;
    const mode = PL.chooseMode(a, b), k = ptKey(a) + '>' + ptKey(b) + '|' + mode;
    if (S.routes.has(k)) continue;
    const r = await api('route', { query: { origin: `${a.lat},${a.lng}`, destination: `${b.lat},${b.lng}`, mode } }, { ico: '🛣', phase,
      lab: `路线规划 · ${mode === 'walking' ? '步行' : '驾车'} ${short(a.label && a.kind === 'hotel' ? '酒店' : a.name).slice(0, 8)} → ${short(b.kind === 'hotel' ? '酒店' : b.name).slice(0, 8)}`,
      detail: r => `${(r.path || []).length} 个折线点 · ${((r.distance || 0) / 1000).toFixed(1)}km` });
    if (r.path && r.path.length > 1) { S.routes.set(k, { path: r.path, mock: !!r.mock, m: +r.distance || null, s: +r.duration || null }); changed = true; }
  }
  return changed;
}

/* ---------------- 3 过程可见 ---------------- */
function renderActivity() {
  const box = $('#activity');
  box.innerHTML = S.log.map(e => {
    const run = e.state !== 'done';
    const src = e.kind === 'local' ? '<span class="src local">本地计算</span>' : run ? '' : srcTag(e);
    const st = run ? '进行中…' : `✓ ${e.ms && e.kind === 'api' ? e.ms + 'ms' : ''}`;
    const small = [e.detail ? `<small>${esc(e.detail)}</small>` : '', e.mock && e.reason ? `<small class="warn">⚠ ${esc(e.reason)}</small>` : ''].join('');
    return `<div class="act-item ${run ? 'run' : 'done'}"><div class="ico">${e.ico}</div><div class="lab">${esc(e.lab)}${small}</div><div class="st">${st}${src}</div></div>`;
  }).join('') || '<div class="hint">等待开始…</div>';
  const net = netEntries();
  $('#procCount').textContent = `${S.log.filter(e => e.state === 'done').length} 步 · 接口 ${net.length} 次`;
  if (S.pipelineDone) {
    $('#procBar').classList.add('done');
    const mp = mapEntries(), mk = mp.filter(e => e.mock).length, lm = net.filter(isLLM);
    const llmTxt = lm.length ? (lm.some(e => e.mock) ? ' · 任务解析用规则（未接大模型）' : ' · 任务解析：文心 ERNIE') : '';
    $('#s3bubble').innerHTML = `完成：百度地图接口 ${mp.length} 次（真实 ${mp.length - mk} · 示例 ${mk}）${llmTxt}，${S.log.filter(e => e.kind === 'local').length} 步本地编排。${mk ? '<br><span class="mock-tag">示例数据原因见每步下方橙色提示</span>' : ''}`;
  }
  if (!SHOT) { const sc = $('#s3scroll'); sc.scrollTop = sc.scrollHeight; }
}

/* ---------------- 4 酒店对比 ---------------- */
/* 只给跳转链接，不代订：百度地点详情（URI API，uid）/ 携程、飞猪按店名搜索 */
const CTRIP_CITY = { 上海: 2, 北京: 1, 杭州: 17, 南京: 12, 广州: 32, 深圳: 30, 成都: 28 };
function deepLinks(h) {
  if (!h || h.mock) return '';
  const city = (S.task && S.task.city) || '上海', q = encodeURIComponent(short(h.name));
  const links = [
    h.uid ? ['百度详情', `https://api.map.baidu.com/place/detail?uid=${encodeURIComponent(h.uid)}&output=html&src=webapp.xiaojing`] : null,
    ['携程搜这家', `https://m.ctrip.com/webapp/hotel/list?city=${CTRIP_CITY[city] || 2}&keyword=${q}`],
    ['飞猪搜这家', `https://h5.m.taobao.com/trip/hotel/searchlist/index.html?keyWords=${q}&cityName=${encodeURIComponent(city)}`],
  ].filter(Boolean);
  return `<div class="deep">${links.map(([l, u]) => `<a href="${u}" target="_blank" rel="noopener">${l} ↗</a>`).join('')}<span class="fs-dim">只跳转，不代订</span></div>`;
}
function nearestKm(h, cat) { const l = (S.pois[h.uid] || {})[cat] || []; return l.length ? Math.min(...l.map(p => haversineKm(h, p))) : null; }
const isStopTrip = () => !!(S.task && S.task.stops && S.task.stops.length && !S.clients.length);
const anchorLabel = id => { const x = (S.task.stops || []).find(s => s.id === id); return x ? short(x.place ? x.place.name : x.name).slice(0, 6) : '客户' + id; };
/* 点名酒店：不比较候选，只展示核对结果 + 到各地点的真实路程 */
function renderFixedHotel() {
  const h = S.hotel, t = S.task;
  $('#hotelIntro').innerHTML = `酒店由你指定，不做筛选。你说的是「${esc(h.said)}」，百度上对应的是 <b>${esc(h.name)}</b>（${esc(MATCH[h.match] || '')}${h.note ? '：' + esc(h.note) : ''}）。`;
  const pts = anchors();
  $('#hotelScroll').innerHTML = `<div class="hotel-card rec picked" data-uid="${esc(h.uid)}"><span class="badge">📌 你指定</span>
    <div class="cover">🏨</div><div class="body"><h3>${esc(nm(h.name))}</h3><div class="sub">${esc(h.address || '')}${h.baiduName && h.baiduName !== h.name ? ' · 定位点：' + esc(h.baiduName) : ''}</div>
    <div style="margin-top:8px;font-size:11px;color:#6B7280">到各地点（批量算路 · 驾车/步行）</div>
    <div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap">${pts.map(a => { const lg = TR(h, a); return `<div class="metric" style="flex:1;min-width:88px;text-align:center"><div class="k">${esc(short(a.name).slice(0, 8))}</div><div class="v">${lg.min}′</div><div class="k">${lg.label} ${lg.km.toFixed(1)}km</div></div>`; }).join('')}</div>
    <div class="metrics"><div class="metric"><div class="k">评分</div><div class="v">${h.rating ? '★ ' + h.rating : '—'}</div></div><div class="metric"><div class="k">核对</div><div class="v" style="font-size:12px">${esc(MATCH[h.match] || '')}</div></div></div>
    <button class="pick">✓ 已指定</button></div></div>`;
  $('#compareText').innerHTML = h.alts && h.alts.length ? `不是这家？百度上名字接近的还有：${h.alts.map(a => `<b>${esc(short(a.name))}</b>（${esc(a.address || '')}）`).join('、')}。可以在下方输入框说「换成 …」。` : '百度上名称一致，无需确认。';
  $('#rejectText').textContent = `${t.nights || t.hotel.nights || 1} 晚 · 没有做预算/评分/通勤筛选（你已指定）。`;
  requestAnimationFrame(renderHotelMap);
}
function renderHotels() {
  if (S.task && S.task.fixedHotel && S.hotel) return renderFixedHotel();
  if (!S.top.length) { $('#hotelIntro').textContent = '还没有候选酒店。'; $('#hotelScroll').innerHTML = ''; return; }
  const t = S.task;
  $('#hotelIntro').innerHTML = `检索到 ${S.hotels.length} 家，按预算/评分/通勤筛完留下 ${S.score.ranked.length} 家，展示前 ${S.top.length}。<b>推荐 ${short(S.top[0].hotel.name)}</b>：综合分最高，平均通勤 ${Math.round(S.top[0].avg)} 分钟。`;
  const kinds = actKinds().slice(0, 2);
  $('#hotelScroll').innerHTML = S.top.map((row, i) => {
    const h = row.hotel, picked = S.hotel && S.hotel.uid === h.uid;
    return `<div class="hotel-card ${i === 0 ? 'rec' : ''} ${picked ? 'picked' : ''}" data-uid="${esc(h.uid)}">
      ${i === 0 ? '<span class="badge">★ 推荐</span>' : `<span class="badge" style="background:#fff;color:#333;border:1px solid #ddd">方案 ${i + 1}</span>`}
      <div class="cover">🏨${h.mock ? '<span style="position:absolute;right:10px;bottom:8px;font-size:10px;color:#B45309;background:rgba(255,255,255,.85);padding:2px 6px;border-radius:6px">示例数据</span>' : ''}</div>
      <div class="body">
        <h3>${esc(nm(h.name))}</h3>
        <div class="sub">${esc(h.address || '')}</div>
        <div style="margin-top:8px;font-size:11px;color:#6B7280">${isStopTrip() ? '到各地点' : '到客户通勤'}${row.commutes.some(c => c.source === 'estimate') ? '（部分为估算）' : ''}</div>
        <div style="display:flex;gap:4px;margin-top:4px">
          ${row.commutes.map(c => `<div class="metric" style="flex:1;text-align:center"><div class="k">${esc(anchorLabel(c.client))}</div><div class="v ${c.min <= 10 ? 'good' : ''}">${c.min}′</div><div class="k">${c.label} ${c.km.toFixed(1)}km</div></div>`).join('')}
        </div>
        <div class="metrics">
          <div class="metric"><div class="k">价格/晚</div><div class="v" style="${t.hotel.budget_max && h.price > t.hotel.budget_max ? 'color:#DC2626' : ''}">${h.price ? '¥' + h.price : '未知'}</div></div>
          <div class="metric"><div class="k">评分</div><div class="v">${h.rating ? '★ ' + h.rating : '—'}</div></div>
          ${h.metro ? `<div class="metric"><div class="k">🚇 ${esc(short(h.metro.name).slice(0, 8))}</div><div class="v ${h.metro.m <= 500 ? 'good' : ''}">${h.metro.m}m</div></div>` : ''}
          ${kinds.map(k => { const d = nearestKm(h, k); return `<div class="metric"><div class="k">最近${CATS[k].label}</div><div class="v">${d == null ? '—' : fmtKm(d)}</div></div>`; }).join('')}
        </div>
        <div class="score">综合 <b>${row.score}</b> = 通勤 ${row.parts.commute} · 评分 ${row.parts.rating} · 价格 ${row.parts.price}</div>
        <div style="font-size:11px;color:#6B7280;margin-bottom:8px">平均通勤 <b style="color:#111">${Math.round(row.avg)} 分钟</b> · 最长 ${row.max} 分钟</div>
        ${deepLinks(h)}
        <button class="pick">${picked ? '✓ 已选' : '选这家'}</button>
      </div></div>`;
  }).join('');
  requestAnimationFrame(renderHotelMap);
  const [a, b] = S.top;
  if (b) {
    const dAvg = Math.round(b.avg - a.avg), dP = (a.hotel.price || 0) - (b.hotel.price || 0);
    const bBest = b.commutes.reduce((m, c) => c.min < m.min ? c : m, b.commutes[0]);
    $('#compareText').innerHTML = `${esc(short(a.hotel.name))} 平均通勤 <b>${dAvg >= 0 ? '少 ' + dAvg : '多 ' + -dAvg} 分钟</b>，${a.hotel.price && b.hotel.price ? `${dP >= 0 ? '贵' : '便宜'} <b>¥${Math.abs(dP)}/晚</b>` : '价格有一家未知'}；${esc(short(b.hotel.name))} 离${isStopTrip() ? esc(anchorLabel(bBest.client)) : '客户' + bBest.client} ${bBest.label} ${bBest.min} 分钟。`;
  } else $('#compareText').textContent = '只有一家符合条件。';
  const rej = S.score.rejected, overN = S.hotels.filter(h => t.hotel.budget_max && h.price > t.hotel.budget_max).length;
  $('#rejectText').textContent = `未入选：超预算 ${overN} 家${rej.length ? ' · 算路后淘汰 ' + rej.length + ' 家（' + rej.slice(0, 2).map(x => short(x.hotel.name) + ' ' + x.reason).join('；') + '）' : ''}。先筛后排，通勤来自批量算路。`;
}

/* 酒店对比小地图：前 3 家酒店 + 客户（纯位置，不画直线假路线） */
function renderHotelMap() {
  if (cur !== 4) return;
  if (S.task && S.task.fixedHotel && S.hotel) {
    const pts = anchors();
    MapView.get($('#hotelMap')).render({ markers: [...pts.map((a, i) => ({ lat: a.lat, lng: a.lng, kind: 'num', text: String(i + 1), color: '#7C3AED', name: short(a.name).slice(0, 8) })),
      { lat: S.hotel.lat, lng: S.hotel.lng, kind: 'hotel', text: '宿', color: '#111', selected: true, name: short(S.hotel.name).replace(/·.*/, '') }], lines: [], circles: [], padTop: 30, padBottom: 12, legend: '宿 = 你指定的酒店 · 紫色 = 行程地点' });
    return;
  }
  if (!S.top.length) return;
  const markers = [
    ...S.clients.map(c => ({ lat: c.lat, lng: c.lng, kind: 'num', text: c.id, color: '#7C3AED', name: '客户' + c.id + ' ' + short(c.place || '') })),
    ...S.top.map((row, i) => ({ lat: row.hotel.lat, lng: row.hotel.lng, kind: 'hotel', text: i === 0 ? '荐' : String(i + 1), color: i === 0 ? '#111' : '#6B7280', selected: !!(S.hotel && S.hotel.uid === row.hotel.uid), name: short(row.hotel.name).replace(/·.*/, '') })),
  ];
  MapView.get($('#hotelMap')).render({ markers, lines: [], circles: [], padTop: 30, padBottom: 12, legend: '荐/2/3 = 候选酒店 · 紫色 = 客户' });
}

/* ---------------- 5 任务雷达 ---------------- */
function radarCats() { return [...actKinds(), ...(actKinds().includes('food') ? [] : ['food']), ...(S.clients.length ? ['client'] : []), ...((S.task.stops || []).length ? ['stop'] : [])]; }
async function renderRadar() {
  if (!S.hotel) return;
  const h = S.hotel, R = S.radar;
  if (!R.cat) R.cat = actKinds()[0] || 'food';
  $('#centerName').textContent = short(h.name);
  $('#catPills').innerHTML = radarCats().map(k => `<button data-cat="${k}" class="${k === R.cat ? 'on' : ''}">${CATS[k].emo} ${CATS[k].label}</button>`).join('');
  $$('#radiusPills button').forEach(b => b.classList.toggle('on', +b.dataset.r === R.r));
  let list;
  if (R.cat === 'client') list = S.clients.map(c => Object.assign({}, c, { cat: 'client', rating: null, hours: null, uid: 'client-' + c.id }));
  else if (R.cat === 'stop') list = S.task.stops.filter(x => x.place).map(x => Object.assign({}, x.place, { cat: 'stop', hours: null, uid: 'stop-' + x.id, date: x.date, start: x.start, end: x.start ? toHM(toMin(x.start) + x.duration_min) : '' }));
  else list = await fetchPois(h, R.cat, 3000, 'radar');
  const act = (S.task.activities || []).find(a => a.kind === R.cat);
  const win = act ? { s: act.window_start, dur: act.duration_min } : null;
  const rk = PL.rankPois(list, h, R.r, win);
  if (rk.inside.length && !rk.inside.find(p => p.uid === R.sel)) R.sel = rk.inside[0].uid;
  $('#radarCount').textContent = `圆内 ${rk.inside.length} 家 · 隐藏 ${rk.outside.length + rk.closed.length}`;
  $('#poiTitle').textContent = `${CATS[R.cat].label} · 先按距离${win ? '/营业' : ''}筛，再按评分排`;
  MapView.get($('#radarMap')).render({
    view: { lat: h.lat, lng: h.lng, rKm: window.__useBaidu ? R.r + 0.3 : 3.1 }, padTop: 50, padBottom: window.__useBaidu ? 108 : 64, logoLift: true, // 真实地图按所选半径缩放，街道看得清
    circles: [1, 2, 3].map(r => ({ lat: h.lat, lng: h.lng, rKm: r, label: r + 'km' })).concat([{ lat: h.lat, lng: h.lng, rKm: R.r, main: true }]),
    markers: [...rk.inside.map(p => ({ lat: p.lat, lng: p.lng, kind: 'emoji', emoji: CATS[R.cat].emo, color: CATS[R.cat].color, selected: p.uid === R.sel, name: p.uid === R.sel ? p.name : '', onClick: () => { R.sel = p.uid; renderRadar(); } })),
      { lat: h.lat, lng: h.lng, kind: 'hotel', text: '宿', color: '#3DB2F5' }],
    lines: [],
  });
  const inPlan = new Set(S.days.flatMap(d => d.items.map(i => i.poiUid)));
  const box = $('#poiList');
  box.innerHTML = rk.inside.map(p => `
    <div class="poi-card ${p.uid === R.sel ? 'sel' : ''}" data-uid="${esc(p.uid)}">
      <div class="thumb">${CATS[R.cat].emo}</div>
      <div class="info"><h4>${esc(nm(p.name))}${p.mock ? ' <span class="mock-tag">示例</span>' : ''}</h4>
        <div class="tags"><span class="pill">距酒店 ${fmtKm(p.distKm)} · 步行 ${Math.max(1, Math.round(p.distKm * 1.3 / 4.8 * 60))}min</span>
          ${p.rating ? `<span class="pill orange">★ ${p.rating}</span>` : ''}
          ${p.hours ? `<span class="pill green">营业 ${esc(p.hours)}</span>` : R.cat === 'client' || R.cat === 'stop' ? `<span class="pill green">${dayLabel(p.date)} ${p.start}–${p.end}</span>` : '<span class="pill">营业时间未知</span>'}</div>
        <div style="font-size:11px;color:#6B7280;margin-top:4px">${esc(p.price ? (typeof p.price === 'number' ? '人均/价格 ¥' + p.price : p.price) : p.address || '')}</div></div>
      <button class="add">${R.cat === 'client' || R.cat === 'stop' ? '已在时间轴' : inPlan.has(p.uid) ? '✓ 已在时间轴' : '＋ 加入时间轴'}</button></div>`).join('') ||
    `<div class="hint" style="padding:18px 0">${R.r}km 内没有合格的${CATS[R.cat].label}，试试放大半径</div>`;
  const hid = [...rk.closed.map(p => `${short(p.name)}（${fmtKm(p.distKm)} · 该时段不营业）`), ...rk.outside.slice(0, 6).map(p => `${short(p.name)}（${fmtKm(p.distKm)}）`)];
  if (hid.length) box.insertAdjacentHTML('beforeend', `<div class="hint" style="text-align:left">已隐藏 ${rk.closed.length + rk.outside.length} 家：${esc(hid.join('、'))}${rk.outside.length > 6 ? '…' : ''}</div>`);
  S.radar.rk = rk;
}
async function addToPlan(p, cat) {
  const act = (S.task.activities || []).find(a => a.kind === cat);
  const day = S.days.find(d => act && d.date === act.date) || S.days[0];
  const C = CATS[cat] || CATS.other;
  const it = mkItem(cat, p, { notBefore: act ? act.window_start : C.win, notAfter: act ? act.window_end : '23:30', dur: act ? act.duration_min : C.dur, actId: act && act.id, label: act ? act.label : C.label });
  const ex = day.items.findIndex(i => i.kind === cat && !i.fixed);
  await ensureDayMatrix(day, 'edit', [...day.items, it]);
  if (ex > -1) day.items.splice(ex, 1, it); else day.items = PL.cheapestInsert(day.items, it, TR).items;
  PL.schedule(day.items, TR);
  if (act) { act.placedName = p.name; act.unplaced = null; }
  S.highlight = it.uid; S.day = day.key;
  fetchRoutes(day, 'edit');
  return { day, it, replaced: ex > -1 };
}

/* ---------------- 6 计划总览 ---------------- */
function goals() {
  const all = S.days.flatMap(d => d.items.map(i => Object.assign({ day: d }, i)));
  const g = S.clients.map(c => { const it = all.find(i => i.clientId === c.id); return { emo: '🏢', lab: c.name, meta: `${dayLabel(c.date)} ${c.start}–${c.end} · ${short(c.place || c.address)}${it && it.conflict ? ' · ⚠ ' + it.conflict : ''}`, done: !!it && !it.conflict }; });
  (S.task.stops || []).forEach(x => { const it = all.find(i => i.stopId === x.id);
    g.push({ emo: CATS[x.kind].emo, lab: `${x.purpose || CATS[x.kind].label} · ${x.place ? short(x.place.name) : x.name}`, done: !!it && !it.conflict,
      meta: it ? `${it.day.label} ${toHM(it.s)}–${toHM(it.e)}${x.duration_is_assumed ? '（时长假设）' : ''}${it.conflict ? ' · ⚠ ' + it.conflict : it.tight ? ' · ⚠ ' + it.tight : ''}` : '没找到地点，未排入' }); });
  (S.task.activities || []).forEach(a => { const it = all.find(i => i.actId === a.id); g.push({ emo: CATS[a.kind].emo, lab: a.label, meta: it ? `${it.day.label} ${toHM(it.s)} · ${short(it.name)}` : (a.unplaced || '未排入'), done: !!it && !it.conflict }); });
  if (S.hotel) g.push({ emo: '🏨', lab: '酒店 · ' + short(S.hotel.name), meta: S.task.fixedHotel ? `你指定「${S.hotel.said}」· ${MATCH[S.hotel.match] || ''}` : `${S.hotel.price ? '¥' + S.hotel.price + '/晚 · ' : ''}${S.hotel.rating ? '★' + S.hotel.rating + ' · ' : ''}已选`, done: !S.task.fixedHotel || ['exact', 'alias'].includes(S.hotel.match) });
  warnings().forEach(w => g.push({ emo: w.info ? 'ℹ️' : '⚠️', lab: w.lab, meta: w.meta, done: false, warn: !w.info }));
  return g;
}
/* 提醒：地点核对 + 时间冲突/余量 + 坐地铁赶不上 + 路况说明（每次按当前日程重算） */
function warnings() {
  const out = [...(S.warn || [])];
  S.days.forEach(d => {
    const st = PL.schedule(d.items, TR);
    d.items.forEach((it, i) => {
      if (it.conflict) out.push({ lab: `${d.label.split(' ')[0]} ${short(it.name)}：${it.conflict}`, meta: `${toHM(it.s)} 才能到 · 固定时间 ${it.start || ''}` });
      else if (it.tight) out.push({ lab: `${d.label.split(' ')[0]} 赶 ${it.start} ${short(it.name)} 很紧`, meta: `${it.tight}（${st.legs[i - 1].label} ${st.legs[i - 1].min} 分钟）` });
      const tr = transitFor(it);
      if (tr && !tr.none && it.fixed && i > 1 && d.items[i - 1].e + tr.min > toMin(it.start)) out.push({ lab: `${d.label.split(' ')[0]} 坐公交/地铁赶不上 ${it.start} ${short(it.name)}`, meta: `公交/地铁要 ${tr.min} 分钟（${tr.dep} 出发），要打车（${st.legs[i - 1].min} 分钟）` });
    });
  });
  if (S.routeTimeAt) out.push({ info: true, lab: '驾车时间是百度实时路况估算', meta: `查询于 ${S.routeTimeAt.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}（接口不支持指定未来出发时间），${S.task.dates[0].slice(5)} 实际路况可能不同` });
  return out;
}
function routePath(a, b) {
  const k = ptKey(a) + '>' + ptKey(b) + '|' + PL.chooseMode(a, b);
  const r = S.routes.get(k);
  return r ? r.path : [[a.lng, a.lat], [b.lng, b.lat]];
}
function renderOverview() {
  if (!S.days.length) return;
  const t = S.task;
  $('#ovTitle').innerHTML = `${isStopTrip() ? '🗺 ' + esc(t.city) + '行程' : '🧳 ' + esc(t.city) + '出差'} <span class="tag">${t.dates.length} 天 ${t.hotel.nights || 1} 晚 · 进行中</span>`;
  const top = S.top.find(r => r.hotel.uid === S.hotel.uid);
  $('#ovSub').textContent = `${t.dates[0].slice(5)} – ${t.dates[t.dates.length - 1].slice(5)} · ${short(S.hotel.name)}${top ? ' · 平均通勤 ' + Math.round(top.avg) + ' 分钟' : ''}`;
  renderGaps();
  $('#goalList').innerHTML = goals().map(g => `<div class="goal-item ${g.done ? 'done' : 'pending'}${g.warn ? ' warn' : ''}"><span class="gmark">${g.done ? '✓' : ''}</span><span style="font-size:16px">${g.emo}</span>
    <div style="flex:1;min-width:0"><div class="glab">${esc(g.lab)}</div><div class="gmeta">${esc(g.meta)}</div></div></div>`).join('');
  $('#dayCards').innerHTML = S.days.map(d => {
    const st = PL.schedule(d.items, TR);
    const route = d.items.map(i => i.kind === 'hotel' ? '🏨' : `${(CAT_LABEL[i.kind] || '').split(' ')[0]} ${short(i.name).replace(/ · .*/, '')}`).join(' → ');
    const nT = d.items.filter(i => i.tight && !i.conflict).length;
    return `<div class="day-card" data-day="${d.key}"><div class="dc-top"><div class="dc-title">${d.label}</div><span class="dc-badge">${d.items.filter(i => i.kind !== 'hotel').length} 个地点 · ${st.totalKm.toFixed(1)}km</span></div>
      <div class="dc-route">${esc(route)}</div>
      <div class="dc-meta"><span>通勤合计 <b>${st.totalMin} 分钟</b></span><span>${toHM(st.start)}–${toHM(st.end)}</span>
      <span style="color:${st.conflicts ? '#DC2626' : nT ? '#D97706' : '#10B981'}">${st.conflicts ? '⚠ ' + st.conflicts + ' 冲突' : nT ? '⚠ ' + nT + ' 处很紧' : '无冲突'}</span></div></div>`;
  }).join('');
  $('#ovOpen').textContent = `打开时间轴 · ${S.days[0].label}`;
  let n = 0; const seen = new Set(), markers = [{ lat: S.hotel.lat, lng: S.hotel.lng, kind: 'hotel', name: S.hotel.name }];
  seen.add(ptKey(S.hotel));
  S.days.forEach(d => d.items.forEach(i => { if (seen.has(ptKey(i))) return; seen.add(ptKey(i)); markers.push({ lat: i.lat, lng: i.lng, kind: 'num', text: String(++n), name: short(i.name).replace(/ · .*/, '') }); }));
  const lines = [];
  S.days.forEach((d, di) => { for (let i = 1; i < d.items.length; i++) { const a = d.items[i - 1], b = d.items[i]; if (ptKey(a) === ptKey(b)) continue; lines.push({ path: routePath(a, b), color: DAY_COLORS[di % DAY_COLORS.length], dash: di > 0, width: di > 0 ? 3 : 4 }); } }); // 总览：一天一个颜色
  const ring = !isStopTrip(); // 点名行程跨半个上海，2km 圈没有意义
  $('#overviewMap').style.height = isStopTrip() ? '52%' : '38%'; // 点名地点的行程跨半个上海：地图高一点，才能停在 11 级（见 map.js minZoom）
  MapView.get($('#overviewMap')).render({ minZoom: isStopTrip() ? 11 : 0, markers, lines, circles: ring ? [{ lat: S.hotel.lat, lng: S.hotel.lng, rKm: 2, main: true }] : [], padTop: 34, padBottom: 34,
    legend: S.days.length > 1 ? `蓝 = ${S.days[0].label.split(' ')[0]} · 粉 = ${S.days[1].label.split(' ')[0]}${ring ? ' · 圈=2km' : ''}` : ring ? '圈=酒店 2km' : '' });
}

/* ---------------- v2 M2 空档 ----------------
   相邻两个地点之间空出 > 60 分钟、而且你没说中间回酒店 → 问：回酒店歇会儿 / 另有安排 / 附近逛逛 / 就在这等。
   能歇多久 = 空档 − 去酒店 − 回来 − 提前 10 分钟到；≥ 45 分钟值得回，20–45 有点赶，< 20 不值得（见 agent-flow-v1.md 7.3） */
const GAP = Slots.TEMPLATES.fixed_trip.gap;
function findGaps() {
  if (!isStopTrip() || !S.hotel) return [];
  const out = [];
  S.days.forEach(d => {
    PL.schedule(d.items, TR);
    for (let i = 1; i < d.items.length - 1; i++) {
      const a = d.items[i], b = d.items[i + 1];
      if (a.kind === 'hotel' || b.kind === 'hotel' || !b.fixed || ptKey(a) === ptKey(b)) continue;
      const free = b.s - a.e; if (free <= GAP.askMin) continue;
      const toH = TR(a, S.hotel), fromH = TR(S.hotel, b), direct = TR(a, b);
      const rest = free - toH.min - fromH.min - GAP.arriveEarly, stay = free - direct.min - GAP.arriveEarly;
      const key = `${d.date}|${a.stopId || a.uid}>${b.stopId || b.uid}`;
      if (S.gapSkip && S.gapSkip.has(key)) continue;
      out.push({ key, day: d, a, b, free, rest, stay, toH, fromH, direct, level: rest >= GAP.restOk ? 'ok' : rest >= GAP.restTight ? 'tight' : 'no', ans: S.gapAns[key] });
    }
  });
  return out;
}
function renderGaps() {
  const box = $('#gapBox'); if (!box) return;
  const gs = findGaps(), hn = S.task.hotel.stayLabel || '酒店';
  const done = S.gapDone || [];
  if (!gs.length && !done.length) { box.innerHTML = ''; return; }
  box.innerHTML = done.map(x => `<div class="gap-card done">✓ ${esc(x)}</div>`).join('') + gs.map(g => {
    const lab = x => short(x.name).slice(0, 8);
    const hotelBtn = g.level === 'no' ? `<button class="chip" data-gap="${esc(g.key)}" data-ga="hotel" disabled title="不值得">回${hn} · 来回 ${g.toH.min + g.fromH.min}′ 只能歇 ${Math.max(0, g.rest)}′，不值得</button>`
      : `<button class="chip ${g.level === 'tight' ? 'warn' : ''}" data-gap="${esc(g.key)}" data-ga="hotel">回${hn}歇会儿 · 能歇 ${g.rest}′${g.level === 'tight' ? '（有点赶）' : ''}</button>`;
    const other = g.ans === 'other' ? `<div class="fc-row"><input id="gapIn" placeholder="去哪？店名/地点（定了的）"><button class="fs-ok sm" data-gap="${esc(g.key)}" data-ga="otherok">核对并插入</button></div><div class="fc-res">${g.otherRes || ''}</div>
      <div class="fs-hint">还没想好？点「附近逛逛」按空档推荐</div>` : '';
    return `<div class="gap-card" data-key="${esc(g.key)}"><div class="gap-h">⏳ ${g.day.label.split(' ')[0]} ${toHM(g.a.e)}–${toHM(g.b.s)} 空出 <b>${g.free} 分钟</b></div>
      <div class="gap-m">${esc(lab(g.a))} 结束 → ${esc(lab(g.b))} ${toHM(g.b.s)} 开始 · 直接过去 ${g.direct.min}′（${g.direct.label}），到了要等 ${g.stay}′</div>
      <div class="chips">${hotelBtn}<button class="chip" data-gap="${esc(g.key)}" data-ga="other">另有安排</button><button class="chip" data-gap="${esc(g.key)}" data-ga="wander">附近逛逛</button><button class="chip" data-gap="${esc(g.key)}" data-ga="stay">就在那等</button></div>${other}</div>`;
  }).join('');
}
async function replanDays(why) {
  buildDays();
  for (const d of S.days) await ensureDayMatrix(d, 'change');
  S.days.forEach(d => PL.schedule(d.items, TR));
  for (const d of S.days) await fetchRoutes(d, 'change');
  useRouteTimes();
  for (const d of S.days) await fetchTransit(d, 'change');
  localStep('🗓', `重排日程：${why}`, S.days.map(d => `${d.label} ${toHM(PL.schedule(d.items, TR).start)}–${toHM(PL.schedule(d.items, TR).end)}`).join(' / '), 'change');
  if (cur === 6) renderOverview(); if (cur === 7) renderTimeline();
}
async function onGap(key, act) {
  const g = findGaps().find(x => x.key === key); if (!g) return;
  const t = S.task, x = t.stops.find(s => s.id === g.a.stopId), hn = t.hotel.stayLabel || '酒店';
  const span = `${g.day.label.split(' ')[0]} ${toHM(g.a.e)}–${toHM(g.b.s)}`;
  if (act === 'hotel') {
    if (!x) { toast('这一段不能插回酒店'); return; }
    x.back_to_hotel_after = true; x.gapBack = { rest: g.rest, level: g.level };
    S.gapDone.push(`${span} 回${hn}歇会儿（能歇约 ${g.rest} 分钟${g.level === 'tight' ? '，有点赶' : ''}）`);
    localStep('🏨', `空档 ${g.free} 分钟 → 回${hn}`, `去 ${g.toH.min}′ + 回 ${g.fromH.min}′ + 提前 ${GAP.arriveEarly}′ → 能歇 ${g.rest}′（≥${GAP.restOk} 值得回，${GAP.restTight}–${GAP.restOk} 有点赶）`, 'change');
    await replanDays(`${span} 插入回${hn}`);
  } else if (act === 'stay') {
    S.gapDone.push(`${span} 直接去 ${short(g.b.name).slice(0, 8)}，到了等 ${g.stay} 分钟`); S.gapAns[key] = 'stay';
    S.gapSkip = (S.gapSkip || new Set()).add(key); renderOverview();
  } else if (act === 'other') { S.gapAns[key] = 'other'; renderOverview(); }
  else if (act === 'otherok') {
    const said = ($('#gapIn') || {}).value ? $('#gapIn').value.trim() : ''; if (!said) { toast('填一个地点'); return; }
    const r = await resolveOne(said, said, 'other', `地点核对 · 空档里的安排「${said}」`, 'change');
    if (!r.pick) { toast('百度没找到，换个说法'); return; }
    await insertIntoGap(g, r.pick, 'other', '另有安排', `另有安排：${short(r.pick.name)}（${MATCH[r.match] || ''}）`, said);
  } else if (act === 'wander') {
    openFragment({ from: g.a, to: g.b, start: g.a.e, end: g.b.s - GAP.arriveEarly, date: g.day.date, key });
  }
}

/* 把一个地点插进空档：先按时间窗排，再按真实路程收紧停留时间，保证下一站提前 10 分钟到（算路结果已缓存，重排不再调接口） */
async function insertIntoGap(g, place, kind, label, doneText, said) {
  const t = S.task, span = `${g.day.label.split(' ')[0]} ${toHM(g.a.e)}–${toHM(g.b.s)}`;
  const nid = 'g' + (t.stops.length + 1) + '-' + Date.now() % 1000;
  t.stops.push({ id: nid, name: said || place.name, query: said || place.name, kind: CATS[kind] ? kind : 'other', purpose: label, date: g.day.date, start: '', window_start: toHM(g.a.e), window_end: toHM(g.b.s - GAP.arriveEarly),
    duration_min: Math.max(30, Math.min(90, g.free - 40)), duration_is_assumed: true, status: 'booked', verified: true, place: Object.assign({}, place, { cat: CATS[kind] ? kind : 'other' }), match: 'exact' });
  await replanDays(`${span} 插入「${short(place.name)}」`);
  const day = S.days.find(d => d.date === g.day.date), k = day ? day.items.findIndex(i => i.stopId === nid) : -1;
  const it = k > -1 ? day.items[k] : null, nx = it ? day.items[k + 1] : null, ns = t.stops.find(s => s.id === nid);
  let note = '';
  if (it && nx && nx.fixed) {
    const fit = toMin(nx.start) - GAP.arriveEarly - TR(it, nx).min - it.s;
    if (fit < 20) note = `，但去了只能待 ${Math.max(0, fit)} 分钟，不太值得`;
    if (fit !== ns.duration_min && fit >= 20) { ns.duration_min = fit; await replanDays(`「${short(place.name)}」能待 ${fit} 分钟（${toHM(it.s)} 到，${toHM(it.s + fit)} 往下一站走）`); }
    note = note || `，能待 ${ns.duration_min} 分钟，${toHM(it.s + ns.duration_min)} 往 ${short(nx.name).slice(0, 8)} 走`;
  }
  S.gapDone.push(`${span} ${doneText}${note}`);
  if (cur === 6) renderOverview();
}

/* ---------------- v2 M3 碎片时间推荐 ----------------
   入口：① 空档卡「附近逛逛」（起点 = 上一站，终点 = 下一站）② 场景 5「现在有 X 小时空」（起点 = 你在的地方，终点 = 之后要去的地方或回原地）
   只用百度地点检索 + 批量算路；筛选和排序是 fragment.js 里的纯函数 */
const FRAG_KIND = { cafe: 'cafe', book: 'other', park: 'sight', museum: 'museum', sport: 'other', food: 'food' };
async function computeFragment(o, phase = 'change') {
  const T = o.end - o.start, R = Frag.radiusFor(T), cats = Frag.pickCats(T, o.start, o.end);
  if (T < 30) { toast('空闲不到 30 分钟，不推荐了'); return null; }
  localStep('⏱', `碎片时间 ${T} 分钟（${toHM(o.start)}–${toHM(o.end)}）`, `${R.why} · 找：${cats.map(c => c.label).join('、')} · ${o.to ? `终点 ${short(o.to.name).slice(0, 8)}，按绕路算` : '回原地，按来回路程算'} · 路上/绕路最多占 1/3`, phase);
  const mid = o.to ? { lat: (o.from.lat + o.to.lat) / 2, lng: (o.from.lng + o.to.lng) / 2, name: '两地中间' } : null;
  const centers = !o.to ? [Object.assign({}, o.from, { name: short(o.from.name) })]
    : haversineKm(o.from, o.to) * 1000 > R.m ? [Object.assign({}, o.to, { name: short(o.to.name) }), mid] : [mid];
  const byUid = new Map();
  for (const c of cats) for (const cen of centers) {
    const r = await api('poi', { query: { query: c.query, center: `${cen.lat},${cen.lng}`, radius: R.m, size: 10 } }, { ico: c.emo, phase,
      lab: `地点检索 · ${c.query} · ${short(cen.name).slice(0, 8)} ${R.m >= 1000 ? R.m / 1000 + 'km' : R.m + 'm'}`, detail: r => `返回 ${(r.results || []).length} 个` });
    (r.results || []).filter(p => p.lat && (!p.rating || p.rating >= 4.0)).forEach(p => { if (!byUid.has(p.uid)) byUid.set(p.uid, Object.assign({}, p, { cat: c.id })); });
  }
  // 起点/终点本身（以及就在它们门口 250m 内的同名地方）不算「顺路去的地方」；分类标签对不上的剔掉
  const self = x => [o.from, o.to].some(a => a && (a.uid && a.uid === x.uid || haversineKm(a, x) < 0.25 && (short(a.name).slice(0, 4) === short(x.name).slice(0, 4) || haversineKm(a, x) < 0.08)));
  let dropSelf = 0, dropTag = 0;
  for (const [k, p] of byUid) { if (self(p)) { byUid.delete(k); dropSelf++; } else if (!Frag.fits(p)) { byUid.delete(k); dropTag++; } }
  if (dropSelf || dropTag) localStep('🧹', `去掉 ${dropSelf + dropTag} 个不合适的`, `${dropSelf ? `起点/终点本身 ${dropSelf} 个` : ''}${dropSelf && dropTag ? ' · ' : ''}${dropTag ? `分类对不上（如服装店、停车场、口袋公园）${dropTag} 个` : ''}`, phase);
  const back = o.to || o.from;
  const pre = [...byUid.values()].map(p => Object.assign(p, { pre: haversineKm(o.from, p) + haversineKm(p, back) }));
  const cands = cats.flatMap(c => pre.filter(p => p.cat === c.id).sort((a, b) => a.pre - b.pre).slice(0, 5));
  if (!cands.length) { localStep('⚠️', '附近没找到合适的地方', '可以换个时间段再试', phase); return { o, R, cats, picks: [], all: [], centers, rejected: {} }; }
  const dests = o.to ? [...cands, o.to] : cands;
  for (const mode of ['walking', 'driving']) {
    await fetchMatrix([o.from], dests, mode, `批量算路 · ${mode === 'walking' ? '步行' : '驾车'} 起点 → ${cands.length} 个候选${o.to ? ' + 终点' : ''}`, phase);
    await fetchMatrix(cands, [back], mode, `批量算路 · ${mode === 'walking' ? '步行' : '驾车'} ${cands.length} 个候选 → ${o.to ? '终点' : '起点'}`, phase);
  }
  // 批量算路（matrix）的驾车时间偏乐观；入选的几个再用「路线规划」核一遍（和加入行程后时间轴用的是同一个数），最多两轮
  const refined = new Set();
  const refine = async list => {
    const legs = [];
    list.forEach(c => { [[o.from, c], [c, back]].forEach(([a, b]) => { const k = ptKey(a) + '>' + ptKey(b); if (!refined.has(k) && PL.chooseMode(a, b) === 'driving') { refined.add(k); legs.push([a, b]); } }); });
    if (o.to && !refined.has(ptKey(o.from) + '>' + ptKey(o.to)) && PL.chooseMode(o.from, o.to) === 'driving') { refined.add(ptKey(o.from) + '>' + ptKey(o.to)); legs.push([o.from, o.to]); }
    for (const [a, b] of legs) {
      const k = ptKey(a) + '>' + ptKey(b) + '|driving';
      let r = S.routes.get(k);
      if (!r) {
        const x = await api('route', { query: { origin: `${a.lat},${a.lng}`, destination: `${b.lat},${b.lng}`, mode: 'driving' } }, { ico: '🛣', phase,
          lab: `路线规划 · 驾车 ${short(a.name).slice(0, 8)} → ${short(b.name).slice(0, 8)}`, detail: x => `${((x.distance || 0) / 1000).toFixed(1)}km · ${Math.round((x.duration || 0) / 60)} 分钟` });
        if (x.path && x.path.length > 1) { r = { path: x.path, mock: !!x.mock, m: +x.distance || null, s: +x.duration || null }; S.routes.set(k, r); }
      }
      if (r && r.m && r.s) S.matrix.set(k, { m: r.m, s: r.s, mock: r.mock });
    }
    if (legs.length) resetTravel();
    return legs.length;
  };
  const run = () => { const d = o.to ? TR(o.from, o.to).min : null; return { direct: d, ev: Frag.evaluate(cands, c => TR(o.from, c), c => TR(c, back), d, { start: o.start, end: o.end }) }; };
  let { direct, ev } = run(), picks = Frag.choose(ev.list), nRef = 0;
  // 直到最终入选的每一个都用路线规划核过（换上来的新候选也要核），最多 6 轮
  for (let round = 0; round < 6 && picks.length; round++) {
    const n = await refine(picks); nRef += n; if (!n) break;
    ({ direct, ev } = run()); picks = Frag.choose(ev.list);
  }
  const chk = (a, b) => PL.chooseMode(a, b) !== 'driving' || refined.has(ptKey(a) + '>' + ptKey(b));
  picks.forEach(c => { c.checked = chk(o.from, c) && chk(c, back); });
  if (nRef) localStep('🛣', `用路线规划复核 ${nRef} 段驾车时间`, '批量算路给的是理想时间，入选的地方按路线规划重算一遍，和加入行程后时间轴一致', phase);
  localStep('🧮', `筛选：${cands.length} 个候选 → 能去 ${ev.list.length} 个 → 推荐 ${picks.length} 个`, `绕路/路程太多 ${ev.rejected.far} · 待不够 ${ev.rejected.short} · 营业时间盖不住 ${ev.rejected.closed}${direct != null ? ` · 直达下一站 ${direct}′` : ''} · 按评分 + 能待时长 − 绕路排序，每类取一个`, phase);
  return { o, R, cats, picks, all: ev.list, centers, direct, rejected: ev.rejected };
}
async function openFragment(o) {
  const sh = $('#fragSheet'); sh.classList.add('show');
  $('#fragTitle').textContent = '⏱ 碎片时间 · 计算中…'; $('#fragSub').textContent = ''; $('#fragList').innerHTML = '<div class="fs-hint">正在用百度地点检索 + 批量算路筛选…</div>'; $('#fragWhy').textContent = '';
  S.frag = await computeFragment(o, o.phase || 'change');
  renderFragment();
}
function renderFragment() {
  const F = S.frag; if (!F) return;
  const o = F.o, T = o.end - o.start;
  $('#fragTitle').textContent = `⏱ ${toHM(o.start)}–${toHM(o.end)} 空 ${T} 分钟`;
  $('#fragSub').textContent = `${short(o.from.name).slice(0, 8)} → ${o.to ? short(o.to.name).slice(0, 8) : '回原地'}`;
  $('#fragWhy').innerHTML = `${esc(F.R.why)}；路上${o.to ? '（绕路）' : ''}最多占 1/3（${Math.floor(T / 3)} 分钟）；营业时间要盖住整段停留。${F.picks.length ? '' : '<br><b>没有满足条件的地方</b>：' + esc(`绕路太多 ${F.rejected.far || 0} · 待不够 ${F.rejected.short || 0} · 营业时间不合 ${F.rejected.closed || 0}`)}`;
  $('#fragList').innerHTML = F.picks.map((c, i) => `<div class="frag-card">
    <div class="fc-top"><span class="fc-emo">${c.catInfo.emo}</span><div style="flex:1;min-width:0"><div class="fc-name">${esc(nm(c.name))}</div><div class="fc-sub">${esc(c.catInfo.label)}${c.rating ? ' · ★' + c.rating : ''} · ${esc(c.address || '')}</div></div></div>
    <div class="fc-main">路上 <b>${c.go.min}′</b>${c.go.mode === 'walking' ? '步行' : '打车'} + <b>${c.back.min}′</b> · 能待 <b>${c.stay}′</b> · 最晚 <b>${toHM(c.leave)}</b> ${o.to ? '往下一站走' : '往回走'}${c.suggest < c.stay ? `<div class="fs-dim">一般待 ${c.suggest}′ 就够，富余 ${c.stay - c.suggest}′ 可以早点走</div>` : ''}</div>
    <div class="fc-tags">${c.open === true ? `<span class="t ok">营业 ${esc(c.hours)}</span>` : '<span class="t">营业时间未知，去前确认</span>'}${o.to ? `<span class="t">比直达多绕 ${c.detour}′</span>` : ''}${c.checked ? '<span class="t ok">路程已按路线规划核对</span>' : ''}${c.catInfo.book ? `<span class="t warn">${esc(c.catInfo.book)}</span>` : ''}</div>
    <div class="fc-act">${o.key ? `<button class="fs-ok sm" data-frag="${i}">加入行程</button>` : ''}${c.uid && !c.mock ? `<a href="https://api.map.baidu.com/place/detail?uid=${encodeURIComponent(c.uid)}&output=html&src=webapp.xiaojing" target="_blank" rel="noopener">百度详情 ↗</a>` : ''}<a href="${navLink(o.from, c, c.go.mode)}" target="_blank" rel="noopener">导航过去 ↗</a></div></div>`).join('');
  const markers = [{ lat: o.from.lat, lng: o.from.lng, kind: 'num', text: '起', name: short(o.from.name).slice(0, 8) }];
  if (o.to) markers.push({ lat: o.to.lat, lng: o.to.lng, kind: 'num', text: '终', name: short(o.to.name).slice(0, 8) });
  F.picks.forEach(c => markers.push({ lat: c.lat, lng: c.lng, kind: 'emoji', emoji: c.catInfo.emo, color: c.catInfo.color, name: short(c.name).slice(0, 8) }));
  const lines = F.picks.map(c => ({ path: [[o.from.lng, o.from.lat], [c.lng, c.lat], ...(o.to ? [[o.to.lng, o.to.lat]] : [[o.from.lng, o.from.lat]])], color: c.catInfo.color, dash: true, width: 2 }));
  requestAnimationFrame(() => MapView.get($('#fragMap')).render({ markers, lines, circles: F.centers.map((c, i) => ({ lat: c.lat, lng: c.lng, rKm: F.R.m / 1000, main: i === 0 })), padTop: 20, padBottom: 20 }));
}
const navLink = (a, b, mode) => `https://api.map.baidu.com/direction?origin=${encodeURIComponent(`latlng:${a.lat},${a.lng}|name:${short(a.name)}`)}&destination=${encodeURIComponent(`latlng:${b.lat},${b.lng}|name:${short(b.name)}`)}&mode=${mode === 'walking' ? 'walking' : 'driving'}&region=${encodeURIComponent((S.task && S.task.city) || '上海')}&output=html&src=webapp.xiaojing`;
async function addFragToPlan(i) {
  const F = S.frag, c = F && F.picks[i]; if (!c || !F.o.key) return;
  const g = findGaps().find(x => x.key === F.o.key); if (!g) { toast('这个空档已经处理过了'); return; }
  $('#fragSheet').classList.remove('show');
  await insertIntoGap(g, c, FRAG_KIND[c.cat] || 'other', c.catInfo.label, `附近逛逛：${short(c.name)}（${c.catInfo.label}）`);
  toast(`已加入：${short(c.name)}`);
}

/* ---------------- v2.3 M4 场景 4 拼车接送（简化版） ----------------
   追问卡：司机 + 从哪出发、每人在哪上车、去哪 + 几点前到、回程 → 百度逐个核对
   计算：批量算路（两两用时）→ 枚举接人顺序 → 途经点路线（一次调用拿每段用时和折线）→ 从到达时间倒推每人几点下楼
   分享：服务端存 JSON，每人一个链接；司机链接能点「出发了 / 接到 X 了」，下一段按实时路况重算，其他人的卡片轮询更新 */
const POOL_DUR = { 看比赛: 180, 看球: 180, 看演出: 150, 听音乐会: 150, 看演唱会: 180, 看展: 120, 打球: 120, 爬山: 240, 露营: 300, 吃饭: 90 };
/* ================= v2.4 场景 3 开放式安排：画像 → 近期热点（千帆搜索）→ 分类菜单 → 2–3 个主题 → 百度地点 → 按区域分天 ================= */
const OP = window.OpenPlan;
const PROFILE_KEY = 'xj_profile';
function loadProfile() { try { const p = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}'); return { interests: p.interests || [], pace: p.pace || '' }; } catch { return { interests: [], pace: '' }; } }
function saveProfile(p) { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch {} }
const openDates = () => { const sg = (S.task.scenario.segments || []).find(g => g.scenario === 'open_plan'); return sg && sg.dates.length ? sg.dates : S.task.dates; };
function initOpen() {
  const prof = loadProfile(), said = OP.interestsOf(S.text + ' ' + (S.task.openInterests || []).join(' ')), today = ((S.status && S.status.today) || new Date().toLocaleDateString('sv-SE')).slice(5).replace('-', '/');
  // 原话里明说的兴趣：直接记进画像，冒「记住了」小标签（可点掉）；之前记过的：预选，标「来自之前的对话」
  const fresh = said.filter(x => !prof.interests.some(y => y.w === x.w)).map(x => Object.assign({}, x, { src: `${today} 的原话` }));
  prof.interests = [...prof.interests, ...fresh].slice(-12);
  const pace = /排满|紧凑|多去几个|特种兵/.test(S.text) ? 'full' : /松|轻松|慢慢|别太累|休闲/.test(S.text) ? 'loose' : (prof.pace || 'loose');
  saveProfile(prof);
  return { stage: 'profile', words: prof.interests.map(x => ({ w: x.w, cat: x.cat, src: x.src })), remembered: fresh.map(x => x.w), prof, pace, from: null };
}
function openStepBody(f) {
  const O = S.openIn = S.openIn || initOpen();
  const hotelPt = S.hotelPre && S.hotelPre.r && S.hotelPre.r.pick;
  const picked = w => O.words.some(x => x.w === w);
  const extra = O.prof.interests.map(x => x.w).filter(w => !Object.values(OP.MENU).some(m => m.label === w));
  const chips = [...new Set([...extra, ...Object.values(OP.MENU).map(m => m.label)])];
  if (O.stage === 'profile' || O.stage === 'loading') {
    const mem = O.prof.interests.length ? `<div class="op-mem">${O.prof.interests.map(x => `<span class="op-tag">${O.remembered.includes(x.w) ? '记住了' : '之前说过'}：喜欢${esc(x.w)}<span class="fs-dim"> · ${esc(x.src || '')}</span> <button class="op-x" data-oforget="${esc(x.w)}" title="忘掉">✕</button></span>`).join('')}</div>` : '<div class="fs-hint">还不了解你：点几个喜欢的（只记你点的/说过的，不猜）</div>';
    return `<div class="fs-hint">${esc(f.why || '')}</div>${mem}
      <div class="fs-hint">兴趣（可多选）</div><div class="chips">${chips.map(w => `<button class="chip ${picked(w) ? 'active' : ''}" data-oint="${esc(w)}">${esc(w)}</button>`).join('')}</div>
      <div class="fs-hint">节奏</div><div class="chips">${[['loose', '松一点 · 每天 2–3 个点'], ['full', '排满 · 每天 4–5 个点']].map(([k, l]) => `<button class="chip ${O.pace === k ? 'active' : ''}" data-opace="${k}">${l}</button>`).join('')}</div>
      <div class="fs-hint">从哪出发：${hotelPt ? `<b>${esc(short(hotelPt.name))}</b>（你订的/住处，按它周边找）` : '没订酒店 → 先按市中心找，排好后按这些点推荐酒店'}</div>
      <div class="fc-res">${O.err ? `<span class="fc-bad">${esc(O.err)}</span>` : O.stage === 'loading' ? '<span class="fc-wait">千帆搜索近期活动 · 文心出主题中…（约 20–40 秒）</span>' : ''}</div>
      <button class="fs-ok" data-act="openhot">${O.stage === 'loading' ? '找中…' : '找近期活动 + 出 2–3 个方案'}</button>`;
  }
  const H = O.hot || {}, sc = H.search || {};
  const cnt = `<div class="op-count">🔎 千帆百度搜索：本次 <b>${sc.calls || 0}</b> 次${sc.cached ? `（缓存命中 ${sc.cached}）` : ''} · 本月累计 ${sc.month || 0} 次 · 免费额度 ${sc.free || 1500}/月（应用上限 ${sc.cap || 300}）${H.mock ? ' · <b>示例数据，没调搜索</b>' : ''}</div>`;
  const evCard = e => `<div class="op-ev"><b>🎫 ${esc(e.name)}</b><div class="fs-dim">${e.date_from.slice(5).replace('-', '/')}–${e.date_to.slice(5).replace('-', '/')} · 场馆 ${esc(short(e.place.name))}${['exact', 'alias'].includes(e.match) ? ' ✓百度核对' : ' ⚠ 请确认'}</div>
    <div class="op-src web">来自网页 · ${e.ref.url ? `<a href="${esc(e.ref.url)}" target="_blank" rel="noopener">原文链接 ↗</a>` : '示例'} · 发布于 ${esc(e.ref.date || '?')} · 出发前看原文</div></div>`;
  const hotList = (H.events || []).length ? `<div class="fs-hint">近期热点（日期覆盖你那几天、场馆百度核对过的）</div>${H.events.map(evCard).join('')}` : `<div class="fs-hint">近期热点：没有日期对得上、场馆核对得上的活动${H.reason ? '（' + esc(H.reason) + '）' : ''}，按兴趣 + 分类菜单排</div>`;
  const drop = (H.dropped || []).length ? `<div class="fs-dim op-drop">另有 ${H.dropped.length} 条丢掉了：${H.dropped.slice(0, 4).map(x => `${esc(x.name.slice(0, 14))}（${esc(x.why)}）`).join('；')}</div>` : '';
  const basis = O.words.length ? `按你${O.words.some(x => x.src && !O.remembered.includes(x.w)) ? '之前说过' : '说的'}喜欢${O.words.map(x => esc(x.w)).join('、')}来排` : '你没说兴趣，按分类菜单给方向';
  const themes = (O.themes || []).map((t, i) => `<div class="op-theme ${O.pick === i ? 'on' : ''}"><div class="op-t"><b>${esc(t.title)}</b>${t.rule ? '<span class="fs-dim"> · 规则兜底</span>' : ''}</div>
    <div class="fs-dim">${esc(t.why || '')}</div><div class="chips">${t.cats.map(c => `<span class="chip sm">${OP.MENU[c].emo} ${OP.MENU[c].label}</span>`).join('')}${t.events.map(id => { const e = (H.events || []).find(x => x.id === id); return e ? `<span class="chip sm">🎫 ${esc(e.name.slice(0, 10))}</span>` : ''; }).join('')}</div>
    <div class="op-src llm">大模型建议 · 地点会用百度检索核实</div><button class="fs-ok sm" data-otheme="${i}">${O.stage === 'building' && O.pick === i ? '百度检索中…' : '就这个'}</button></div>`).join('');
  if (O.stage === 'ready') return `${cnt}<div class="fs-hint">已选：<b>${esc(O.theme.title)}</b> · ${O.pace === 'full' ? '排满' : '松一点'}</div>${openDaysHtml()}<button class="chip sm" data-oreset="1">换个方案</button>`;
  return `${cnt}<div class="fs-hint">💡 ${basis}</div>${hotList}${drop}<div class="fs-hint">挑一个方向（${(O.themes || []).length} 个）</div>${themes}${O.err ? `<div class="fc-bad">${esc(O.err)}</div>` : ''}
    <div class="chips"><button class="chip sm" data-oback="1">← 改兴趣/节奏</button></div>`;
}
function openDaysHtml() {
  const O = S.openIn; if (!O.days) return '';
  const far = (O.days.far || []).length ? `<div class="fs-dim op-drop">没排进去的活动：${O.days.far.map(x => `${esc(x.name.slice(0, 14))}（${esc(x.why)}）`).join('；')}</div>` : '';
  return far + O.days.map(d => `<div class="op-day"><b>${dayLabel(d.date)}</b>${d.anchor ? ` <span class="fs-dim">· 围着「${esc(short(d.anchor))}」排</span>` : ''}${d.picks.length ? '' : ' · 这片区域没找到合适的点'}${d.picks.map(p => `<div class="op-pick">${p.at} ${OP.MENU[p.cat] ? OP.MENU[p.cat].emo : '🎫'} ${esc(short(p.name))}${p.rating ? ` · ★${p.rating}` : ''}${p.borrowed ? ' <span class="fs-dim">（邻近区域）</span>' : ''}
    <div class="op-src ${p.ev ? 'web' : 'llm'}">${p.ev ? `来自网页 · 「${esc(p.ev.name.slice(0, 16))}」 · ${p.ev.ref.url ? `<a href="${esc(p.ev.ref.url)}" target="_blank" rel="noopener">原文链接 ↗</a>` : '示例'} · 发布于 ${esc(p.ev.ref.date || '?')} · 出发前看原文` : `大模型建议 · 地点已由百度核实（检索「${esc(p.sub.q)}」）`}</div></div>`).join('')}</div>`).join('');
}
async function loadHot() {
  const O = S.openIn, t = S.task; O.stage = 'loading'; O.err = ''; renderAsk();
  O.prof.pace = O.pace; saveProfile(O.prof);
  const dates = openDates(), words = O.words.map(x => x.w);
  const H = await api('hot', { body: { city: t.city || '上海', dates, words } }, { ico: '🔥', phase: 'parse', lab: `近期热点 · 千帆百度搜索（${t.city || '上海'} ${dates.map(d => d.slice(5)).join('/')}）`,
    detail: r => r.error ? r.error : `搜索 ${r.search.calls} 次（缓存 ${r.search.cached}）· 本月 ${r.search.month}/${r.search.free} · ${r.refs} 条网页 → 文心抽出 ${r.extracted || 0} 条 → 日期/原文/场馆核对后留 ${r.events.length} 条${r.dropped.length ? `，丢 ${r.dropped.length} 条` : ''}` });
  O.hot = H.error ? { events: [], dropped: [], search: {}, reason: H.error } : H;
  const T = await api('themes', { body: { city: t.city || '上海', dates, interests: O.words.map(x => ({ w: x.w, cat: x.cat })), pace: O.pace, events: O.hot.events.map(e => ({ id: e.id, name: e.name, venue: e.venue, date_from: e.date_from, date_to: e.date_to })) } },
    { ico: '💡', phase: 'parse', lab: '想主题 · 大模型只出主题名和类别（不出店名）', detail: r => `${(r.themes || []).map(x => x.title).join(' / ')}${r.rule ? ' · 规则兜底' : ''}${r.fixes && r.fixes.length ? ' · 代码修正：' + r.fixes.join('，') : ''}` });
  O.themes = T.themes || OP.ruleThemes(O.words, O.hot.events).map(x => Object.assign(x, { label: x.cats.map(c => OP.MENU[c].label) }));
  O.stage = 'themes'; O.pick = null; renderAsk();
}
async function pickTheme(i) {
  const O = S.openIn, t = S.task, th = O.themes[i]; if (!th || O.stage === 'building') return;
  O.pick = i; O.stage = 'building'; O.err = ''; renderAsk();
  let c0 = S.hotelPre && S.hotelPre.r && S.hotelPre.r.pick;
  if (!c0) { const r = await resolveOne(`${t.city || '上海'}人民广场`, `${t.city || '上海'}人民广场`, 'other', '分天的中心 · 没订酒店 → 先按市中心', 'parse'); c0 = r.pick || { lat: 31.2336, lng: 121.4758, name: '人民广场' }; }
  const words = O.words.map(x => x.w), cands = [];
  const day0 = th.cats.filter(c => !['food', 'night'].includes(c));
  const catsQ = [...th.cats, ...(O.pace === 'full' && !th.cats.includes('food') ? ['food'] : []), ...(O.pace === 'full' && day0.length < 2 && !th.cats.includes('walk') ? ['walk'] : [])]; // 排满：饭点也排上；白天只有一类时补 City Walk
  if (catsQ.length > th.cats.length) localStep('➕', `排满：补了 ${catsQ.slice(th.cats.length).map(c => OP.MENU[c].label).join('、')}`, '一天 4–5 个点，只靠主题里的类别排不满（同类一天最多 1–2 个）', 'parse');
  for (const cat of catsQ) for (const sub of (!th.cats.includes(cat) ? OP.MENU[cat].subs.slice(0, 1) : OP.subsFor(cat, words))) {
    const r = await api('poi', { query: { query: sub.q, center: `${c0.lat},${c0.lng}`, radius: 12000, size: 20 } }, { ico: '🔎', phase: 'parse', lab: `分类菜单 · ${OP.MENU[cat].label} → 百度检索「${sub.q}」（${short(c0.name).slice(0, 8)} 12km）`,
      detail: r => { const g = (r.results || []).filter(OP.goodCand); return `${(r.results || []).length} 个 → 去掉入口/公司/低分后 ${g.length} 个`; } });
    (r.results || []).filter(OP.goodCand).sort((a, b) => (b.rating || 4.2) - (a.rating || 4.2)).slice(0, 8).forEach(p => { if (!cands.some(x => x.uid === p.uid)) cands.push(Object.assign({}, p, { cat, sub, mock: !!r.mock })); });
  }
  th.events.forEach(id => { const e = (O.hot.events || []).find(x => x.id === id); if (e && e.place) cands.push(Object.assign({}, e.place, { uid: e.place.uid || 'ev-' + id, cat: e.kind === 'sport' ? 'sport' : 'art', sub: { q: '活动', kind: e.kind === 'sport' ? 'event' : 'museum', dur: e.kind === 'sport' ? 180 : 120, when: ['am', 'pm'] }, ev: e })); });
  const dates = openDates(), thX = Object.assign({}, th, { cats: catsQ }), openFn = (p, a, b) => PL.openDuring(p.hours, a, b);
  let days = OP.arrange(cands, dates, thX, O.pace, openFn);
  // 围着远处活动排的那天（如 旗忠网球中心 看大师赛）：在活动场馆周边 5km 再找吃饭（排满再加 City Walk），再排一次
  const anc = days.filter(d => d.anchor);
  // 郊区场馆周边往往没有「本帮菜 / 历史文化街区」（实测旗忠 5km 内 0 个），用更宽的词：餐厅 / 公园
  const ANC = { food: { q: '餐厅', kind: 'food', dur: 75, when: ['lunch', 'dinner'] }, walk: { q: '公园', kind: 'sight', dur: 60, when: ['am', 'pm'] } };
  for (const d of anc) for (const cat of O.pace === 'full' ? ['food', 'walk'] : ['food']) {
    const sub = ANC[cat];
    const r = await api('poi', { query: { query: sub.q, center: `${d.anchorPt.lat},${d.anchorPt.lng}`, radius: 5000, size: 20 } }, { ico: '🔎', phase: 'parse', lab: `活动周边 · ${short(d.anchor).slice(0, 10)} 5km → 百度检索「${sub.q}」`, detail: r => `${(r.results || []).filter(OP.goodCand).length} 个可用` });
    (r.results || []).filter(OP.goodCand).sort((a, b) => (b.rating || 4.2) - (a.rating || 4.2)).slice(0, 6).forEach(p => { if (!cands.some(x => x.uid === p.uid)) cands.push(Object.assign({}, p, { cat, sub, nearEv: d.anchorUid, mock: !!r.mock })); });
  }
  if (anc.length) days = OP.arrange(cands, dates, thX, O.pace, openFn);
  localStep('🗂', `按区域分到 ${dates.length} 天（k-means，每天一个区域）`, days.map(d => `${dayLabel(d.date)}：${d.picks.map(p => short(p.name)).join(' → ') || '无'}`).join('；') + ` · 候选 ${cands.length} 个`, 'parse');
  if (!days.some(d => d.picks.length)) { O.err = '百度没检索到合适的地点，换个方案试试'; O.stage = 'themes'; renderAsk(); return; }
  t.stops = t.stops.filter(x => !x.fromOpen); let n = 0;
  days.forEach(d => d.picks.forEach(p => t.stops.push({ id: 'o' + (++n), name: p.name, query: p.name, kind: CATS[p.sub.kind] ? p.sub.kind : 'other', purpose: p.ev ? p.ev.name.slice(0, 14) : `${OP.MENU[p.cat].label}`,
    date: d.date, start: '', window_start: p.at, window_end: toHM(Math.min(23 * 60 + 59, Math.max(toMin(p.to), toMin(p.at) + p.sub.dur) + 90)), duration_min: p.sub.dur, duration_is_assumed: true, status: 'booked', verified: true, fromOpen: true,
    place: Object.assign({}, p, { cat: p.sub.kind }), match: 'exact', src: p.ev ? { web: true, url: p.ev.ref.url, date: p.ev.ref.date, name: p.ev.name } : { llm: true, q: p.sub.q } })));
  t.openPlan = { theme: th.title, pace: O.pace, words };
  O.theme = th; O.days = days; O.ready = true; O.stage = 'ready';
  nextStep(); renderTasks(); renderAsk();
}
function onOpenClick(e) {
  const O = S.openIn; if (!O) return false;
  const it = e.target.closest('[data-oint]'); if (it) { const w = it.dataset.oint, cat = Object.keys(OP.MENU).find(k => OP.MENU[k].label === w) || OP.catOfWord(w);
    if (O.words.some(x => x.w === w)) O.words = O.words.filter(x => x.w !== w); else if (cat) { O.words.push({ w, cat, src: '刚点的' }); if (!O.prof.interests.some(x => x.w === w)) { O.prof.interests.push({ w, cat, src: '你点的' }); saveProfile(O.prof); } }
    renderAsk(); return true; }
  const fg = e.target.closest('[data-oforget]'); if (fg) { const w = fg.dataset.oforget; O.prof.interests = O.prof.interests.filter(x => x.w !== w); O.words = O.words.filter(x => x.w !== w); O.remembered = O.remembered.filter(x => x !== w); saveProfile(O.prof); localStep('🧹', `忘掉了：喜欢${w}`, '画像里删掉，不再用来推荐', 'parse'); renderAsk(); return true; }
  const pc = e.target.closest('[data-opace]'); if (pc) { O.pace = pc.dataset.opace; renderAsk(); return true; }
  const th = e.target.closest('[data-otheme]'); if (th) { pickTheme(+th.dataset.otheme); return true; }
  const bk = e.target.closest('[data-oback]'); if (bk) { O.stage = 'profile'; renderAsk(); return true; }
  const rs = e.target.closest('[data-oreset]'); if (rs) { O.stage = 'themes'; O.ready = false; S.task.stops = S.task.stops.filter(x => !x.fromOpen); S.task.openPlan = null; S.flowOpen = 'open'; renderTasks(); renderAsk(); return true; }
  return false;
}
function keepPoolInputs() {
  const P = S.poolIn; if (!P || !$('#cpDriver')) return;
  P.driver = $('#cpDriver').value.trim(); P.from = $('#cpFrom').value.trim(); P.dest = $('#cpDest').value.trim(); P.deadline = $('#cpDl').value;
  document.querySelectorAll('.cp-rn').forEach(el => { P.riders[+el.dataset.i].name = el.value.trim(); });
  document.querySelectorAll('.cp-ra').forEach(el => { P.riders[+el.dataset.i].at = el.value.trim(); });
}
function poolStepBody(f) {
  const P = S.poolIn = S.poolIn || { driver: f.driver || '', from: f.driverFrom || '', riders: (f.riders && f.riders.length ? f.riders : [{ name: '我', at: '' }]).map(r => ({ name: r.name, at: r.at || '' })),
    dest: f.dest || '', deadline: f.deadline || '', back: !!f.back, purpose: f.purpose || '' };
  return `<div class="fs-hint">${esc(f.why || '')}</div>
    <div class="fc-row"><label>司机</label><input id="cpDriver" class="fr-in" style="max-width:64px" value="${esc(P.driver)}" placeholder="谁"><input id="cpFrom" class="fr-in" value="${esc(P.from)}" placeholder="从哪出发（小区/路名/地标）"></div>
    ${P.riders.map((r, i) => `<div class="fc-row"><label>接 ${i + 1}</label><input class="fr-in cp-rn" data-i="${i}" style="max-width:64px" value="${esc(r.name)}"><input class="fr-in cp-ra" data-i="${i}" value="${esc(r.at)}" placeholder="在哪上车">${P.riders.length > 1 ? `<button class="chip" data-cpdel="${i}">✕</button>` : ''}</div>`).join('')}
    ${P.riders.length < 5 ? '<button class="chip" data-cpadd="1">＋ 再接一个人</button>' : ''}
    <div class="fc-row"><label>去哪</label><input id="cpDest" class="fr-in" value="${esc(P.dest)}" placeholder="目的地"><input type="time" id="cpDl" value="${esc(P.deadline)}" style="width:92px"><span class="fs-dim">前到</span></div>
    <div class="chips"><button class="chip ${P.back ? 'active' : ''}" data-cpback="1">回程反着送回去</button><button class="chip ${!P.back ? 'active' : ''}" data-cpback="0">只算去程</button></div>
    <div class="fc-res">${P.err ? `<span class="fc-bad">${esc(P.err)}</span>` : P.verifying ? '<span class="fc-wait">百度核对中…</span>' : ''}</div>
    <button class="fs-ok" data-act="carpool">用百度核对上车点</button>`;
}
async function verifyPool() {
  keepPoolInputs(); const P = S.poolIn;
  const miss = !P.from ? '司机从哪出发' : P.riders.find(r => !r.at) ? `${P.riders.find(r => !r.at).name || '乘客'}在哪上车` : !P.dest ? '去哪' : !P.deadline ? '几点前到' : '';
  if (miss) { P.err = `还差：${miss}`; renderAsk(); return; }
  P.verifying = true; P.err = ''; renderAsk();
  const one = async (said, who) => { const r = await resolveOne(said, said, 'other', `上车点核对 · ${who}「${said}」`, 'parse'); return r.pick ? Object.assign({}, r.pick, { match: r.match, said, note: r.note || '' }) : null; };
  const d = await one(P.from, `司机${P.driver}出发地`); const rs = [];
  for (const r of P.riders) rs.push(await one(r.at, r.name));
  const dest = await one(P.dest, '目的地');
  P.verifying = false;
  const bad = !d ? P.from : rs.findIndex(x => !x) > -1 ? P.riders[rs.findIndex(x => !x)].at : !dest ? P.dest : '';
  if (bad) { P.err = `百度没找到「${bad}」，换个说法（小区名/路口/地铁站）`; renderAsk(); return; }
  P.pts = { driver: d, riders: rs, dest }; P.ready = true; P.order = null;
  const unsure = [d, ...rs, dest].filter(x => !['exact', 'alias'].includes(x.match));
  localStep('📍', `拼车：${P.driver || '司机'}从 ${short(d.name)} 出发，接 ${P.riders.map((r, i) => `${r.name}@${short(rs[i].name)}`).join('、')}，${P.deadline} 前到 ${short(dest.name)}`, unsure.length ? `⚠ 请确认：${unsure.map(x => `「${x.said}」→${short(x.name)}`).join('、')}` : '全部百度核对通过', 'parse');
  nextStep(); renderTasks(); renderSlots();
}
// 标题里的目的地：百度全称太长时（「久事体育场馆旗忠网球中心」）用用户原话（「旗忠网球中心」）
const destLabel = (name, said) => (said && said.length <= 8 && String(name).includes(said) ? said : short(name).slice(0, 8));
const poolName = i => (S.poolIn.riders[i - 1] || {}).name || `乘客${i}`;
async function computeCarpool(phase = 'pipeline') {
  const P = S.poolIn, k = P.riders.length, pts = [P.pts.driver, ...P.pts.riders, P.pts.dest];
  S.pool = S.pool && S.pool.key === JSON.stringify(pts.map(ptKey)) ? S.pool : { key: JSON.stringify(pts.map(ptKey)), opt: null };
  if (k >= 2 && !S.pool.opt) {
    const strip = p => ({ lat: p.lat, lng: p.lng });
    const r = await api('matrix', { body: { mode: 'driving', origins: pts.map(strip), destinations: pts.map(strip) } }, { ico: '🧮', phase,
      lab: `批量算路 · 驾车 ${pts.length}×${pts.length}（司机出发地、${k} 个上车点、目的地两两用时）`, detail: r => `${r.elements} 条 OD` });
    const M = (r.rows || []).map(row => row.map(e => (e && e.s != null ? Math.round(e.s / 60) : 999)));
    const opt = Carpool.bestOrders(M, P.riders.map((_, i) => i + 1)), nm = o => o.map(poolName).join('→');
    S.pool.opt = opt;
    localStep('🔀', `接人顺序：枚举 ${opt.tried} 种`, `按你说的 ${nm(opt.said.order)} ${opt.said.total}′ · 最省时 ${nm(opt.fast.order)} ${opt.fast.total}′ · 最公平 ${nm(opt.fair.order)}（坐车最久的人 ${opt.fair.maxRide}′）· 批量算路是理想时间，排好后用路线规划重算`, phase);
  }
  const order = P.order || (S.pool.opt ? S.pool.opt.said.order : P.riders.map((_, i) => i + 1));
  const riders = order.map(i => ({ name: poolName(i), pt: P.pts.riders[i - 1], i }));
  const wp = list => list.map(p => `${p.lat},${p.lng}`).join('|');
  const go = await api('route', { query: { origin: `${P.pts.driver.lat},${P.pts.driver.lng}`, destination: `${P.pts.dest.lat},${P.pts.dest.lng}`, mode: 'driving', waypoints: wp(riders.map(r => r.pt)) } }, { ico: '🛣', phase,
    lab: `途经点路线 · ${short(P.pts.driver.name).slice(0, 6)} → ${riders.map(r => r.name).join(' → ')} → ${short(P.pts.dest.name).slice(0, 6)}`, detail: r => `${((r.distance || 0) / 1000).toFixed(1)}km · ${Math.round((r.duration || 0) / 60)} 分钟 · 每段 ${(r.legs || []).map(l => Math.round(l.s / 60) + '′').join(' / ')}` });
  const legs = (go.legs || []).map(l => Math.max(1, Math.round(l.s / 60)));
  const sched = Carpool.backSchedule(legs, P.deadline);
  localStep('⏪', `倒推：${P.deadline} 前到 → ${Carpool.hm(sched.arrive)} 到（留 10′）→ 司机 ${Carpool.hm(sched.depart)} 出发`, riders.map((r, j) => `${r.name} ${Carpool.hm(sched.stops[j].down)} 下楼`).join(' · ') + ' · 每段 +15%、每站等 3′', phase);
  let back = null;
  if (P.back) {
    const dur = POOL_DUR[P.purpose] || 120, end = Carpool.toMin(P.deadline) + dur;
    const rev = riders.slice().reverse();
    const br = await api('route', { query: { origin: `${P.pts.dest.lat},${P.pts.dest.lng}`, destination: `${P.pts.driver.lat},${P.pts.driver.lng}`, mode: 'driving', waypoints: wp(rev.map(r => r.pt)) } }, { ico: '↩️', phase,
      lab: `回程途经点路线 · ${short(P.pts.dest.name).slice(0, 6)} → ${rev.map(r => r.name).join(' → ')} → ${P.driver || '司机'}`, detail: r => `${((r.distance || 0) / 1000).toFixed(1)}km · 每段 ${(r.legs || []).map(l => Math.round(l.s / 60) + '′').join(' / ')}` });
    const bl = (br.legs || []).map(l => Math.max(1, Math.round(l.s / 60)));
    back = { rev: rev.map(r => r.name), end, dur, assumed: true, sched: Carpool.forwardSchedule(bl, Carpool.hm(end + 10)), km: (br.distance || 0) / 1000, path: br.path || [], mock: !!br.mock };
  }
  S.pool.go = { order, riders, legs, sched, km: (go.distance || 0) / 1000, path: go.path || [], mock: !!go.mock, at: new Date() };
  S.pool.back = back;
  // 分享：存到服务端，每人一个链接
  const plan = { date: S.task.start_date, city: S.task.city, purpose: P.purpose, dest: { name: P.pts.dest.name, address: P.pts.dest.address, said: P.dest }, deadline: P.deadline,
    driver: { name: P.driver || '司机', place: P.pts.driver.name }, riders: riders.map((r, j) => ({ name: r.name, place: r.pt.name, address: r.pt.address, down: sched.stops[j].down, car: sched.stops[j].car, leave: sched.stops[j].leave })),
    points: [P.pts.driver, ...riders.map(r => r.pt), P.pts.dest].map(p => ({ name: p.name, lat: p.lat, lng: p.lng })), sched, path: thin(go.path || []), back: back ? { rev: back.rev, end: back.end, sched: back.sched, path: thin(back.path) } : null, queriedAt: S.pool.go.at.toISOString() };
  const tr = await api('trip', { body: { create: true, plan } }, { ico: '🔗', phase, lab: '生成分享链接 · 服务端存一份行程（每人一个链接）', detail: r => r.id ? `行程 ${r.id} · ${riders.length + 1} 个链接` : (r.error || '失败') });
  S.pool.trip = tr.id ? tr : null;
}
const thin = path => { if (path.length <= 400) return path; const st = Math.ceil(path.length / 400); return path.filter((_, i) => i % st === 0 || i === path.length - 1); };
function shareUrl(as, withKey) { const T = S.pool.trip; return `${location.origin}/?trip=${T.id}&as=${as}${withKey ? '&k=' + T.key : ''}`; }
function renderPool() {
  const P = S.poolIn, G = S.pool && S.pool.go; if (!G) return;
  const sh = $('#poolSheet'); sh.classList.add('show');
  const s = G.sched, hm = Carpool.hm, today = (S.status && S.status.today) || '';
  $('#poolTitle').textContent = `🚗 ${dayLabel(S.task.start_date)} · ${destLabel(P.pts.dest.name, P.dest)} ${P.deadline} 前到`;
  $('#poolSub').textContent = `${P.driver || '司机'}开车 · 接 ${G.riders.length} 人`;
  $('#poolWhy').innerHTML = `按<b>现在路况</b>估算（查询于 ${G.at.toTimeString().slice(0, 5)}），每段 +15% 缓冲；到达留 10′、每站等 3′、提前 2′ 下楼。${S.task.start_date !== today ? `${dayLabel(S.task.start_date)}的路况查不到（百度「未来出发时间」是付费高级功能，没开通），出发前 1 小时再算一次。${(() => { const d = G.at, m = d.getHours() * 60 + d.getMinutes(), wd = d.getDay() >= 1 && d.getDay() <= 5; return wd && ((m >= 420 && m <= 570) || (m >= 1020 && m <= 1170)) ? ' <b>现在是工作日高峰，这个时间多半偏长</b>。' : ''; })()}` : ''}${G.mock ? ' <b>示例数据</b>' : ''}`;
  const opt = S.pool.opt, cur = JSON.stringify(G.order), nm = o => o.map(poolName).join('→');
  const chips = opt ? `<div class="fs-hint">接人顺序（试了 ${opt.tried} 种）</div><div class="chips">
      <button class="chip ${cur === JSON.stringify(opt.said.order) ? 'active' : ''}" data-cporder="said">按你说的 ${nm(opt.said.order)}</button>
      ${JSON.stringify(opt.fast.order) !== JSON.stringify(opt.said.order) ? `<button class="chip ${cur === JSON.stringify(opt.fast.order) ? 'active' : ''}" data-cporder="fast">最省时 ${nm(opt.fast.order)} · 少 ${opt.said.total - opt.fast.total}′</button>` : '<span class="chip">按你说的已经最省时</span>'}
      ${JSON.stringify(opt.fair.order) !== JSON.stringify(opt.fast.order) ? `<button class="chip ${cur === JSON.stringify(opt.fair.order) ? 'active' : ''}" data-cporder="fair">最公平 ${nm(opt.fair.order)} · 坐车最久 ${opt.fair.maxRide}′</button>` : ''}</div>` : '';
  const T = S.pool.trip;
  const link = (as, key, label) => T ? `<div class="pc-link"><a href="${shareUrl(as, key)}" target="_blank" rel="noopener">${label} ↗</a><button class="chip sm" data-copy="${esc(shareUrl(as, key))}">复制链接</button></div>` : '';
  const nav = (a, b) => `https://api.map.baidu.com/direction?origin=${encodeURIComponent(`latlng:${a.lat},${a.lng}|name:${short(a.name)}`)}&destination=${encodeURIComponent(`latlng:${b.lat},${b.lng}|name:${short(b.name)}`)}&mode=driving&region=${encodeURIComponent(S.task.city || '上海')}&output=html&src=webapp.xiaojing`;
  const chain = [P.pts.driver, ...G.riders.map(r => r.pt), P.pts.dest];
  const drv = `<div class="pool-card drv"><div class="pc-top">🚗 <b>${esc(P.driver || '司机')}</b>（司机）<span class="pc-big">${hm(s.depart)} 出发</span></div>
    <div class="pc-sub">从 ${esc(short(P.pts.driver.name))}${P.pts.driver.match && !['exact', 'alias'].includes(P.pts.driver.match) ? ' <span class="t warn">⚠ 请确认</span>' : ''}</div>
    <ol class="pc-steps">${G.riders.map((r, j) => `<li><b>${hm(s.stops[j].car)}</b> 到 ${esc(short(r.pt.name))} 接 ${esc(r.name)}（等 3′，${hm(s.stops[j].leave)} 走）</li>`).join('')}<li><b>${hm(s.arrive)}</b> 到 ${esc(short(P.pts.dest.name))}（${P.deadline} 前）</li></ol>
    <div class="pc-sub">全程 ${G.km.toFixed(1)}km · 路上 ${s.legs.reduce((a, b) => a + b, 0)}′（含缓冲）· 每段 ${s.legs.map(x => x + '′').join(' / ')}</div>
    <div class="pc-link">${chain.slice(1).map((b, i) => `<a href="${nav(chain[i], b)}" target="_blank" rel="noopener">导航第 ${i + 1} 段 ↗</a>`).join(' ')}</div>${link('d', true, '司机的链接（能点「出发了/接到了」）')}</div>`;
  const riders = G.riders.map((r, j) => `<div class="pool-card"><div class="pc-top">🙋 <b>${esc(r.name)}</b><span class="pc-big">${hm(s.stops[j].down)} 下楼</span></div>
    <div class="pc-sub">在「${esc(short(r.pt.name))}」等${r.pt.address ? ' · ' + esc(r.pt.address) : ''}${!['exact', 'alias'].includes(r.pt.match) ? ' <span class="t warn">⚠ 请确认上车点</span>' : ''}</div>
    <div class="pc-sub">车 ${hm(s.stops[j].car)} 到，${hm(s.stops[j].leave)} 出发，${hm(s.arrive)} 到 ${esc(short(P.pts.dest.name).slice(0, 8))} · 坐车约 ${s.arrive - s.stops[j].leave}′</div>${link(String(j + 1), false, `${r.name} 的链接`)}</div>`).join('');
  const B = S.pool.back;
  const back = B ? `<div class="pool-card back"><div class="pc-top">↩️ <b>回程</b>（反着送）<span class="pc-big">${hm(B.sched.start)} 出发</span></div>
    <div class="pc-sub">假设 ${hm(B.end)} 散场（${P.purpose || '活动'}约 ${B.dur}′ · 假设 · 可改），散场后司机点一下「出发了」再按实时路况算</div>
    <ol class="pc-steps">${B.rev.map((n, i) => `<li><b>${hm(B.sched.drops[i].at)}</b> 送到 ${esc(n)}</li>`).join('')}<li><b>${hm(B.sched.end)}</b> ${esc(P.driver || '司机')}到家</li></ol><div class="pc-sub">全程 ${B.km.toFixed(1)}km</div></div>` : '';
  $('#poolBody').innerHTML = chips + drv + riders + back + (T ? '<div class="fs-hint">每人一个只读链接：打开能看到自己几点下楼，司机出发后自动更新；不发短信、不推送。</div>' : '<div class="fs-hint">分享链接生成失败（服务端存储不可用）</div>');
  const markers = [{ lat: P.pts.driver.lat, lng: P.pts.driver.lng, kind: 'num', text: '司', name: P.driver || '司机' }, ...G.riders.map((r, j) => ({ lat: r.pt.lat, lng: r.pt.lng, kind: 'num', text: String(j + 1), name: r.name })), { lat: P.pts.dest.lat, lng: P.pts.dest.lng, kind: 'num', text: '终', name: short(P.pts.dest.name).slice(0, 8) }];
  const lines = [...(B && B.path.length ? [{ path: B.path, color: '#F59E0B', dash: true, width: 2 }] : []), { path: G.path, color: '#2563EB', width: 4 }];
  requestAnimationFrame(() => MapView.get($('#poolMap')).render({ markers, lines, padTop: 20, padBottom: 20, legend: B ? '蓝 = 去程 · 橙虚线 = 回程' : '' }));
}
async function onPoolClick(e) {
  const c = e.target.closest('[data-copy]'); if (c) { try { await navigator.clipboard.writeText(c.dataset.copy); toast('已复制'); } catch { toast(c.dataset.copy); } return; }
  const o = e.target.closest('[data-cporder]'); if (o && S.pool && S.pool.opt) { S.poolIn.order = S.pool.opt[o.dataset.cporder].order; await computeCarpool('change'); renderPool(); }
}

/* 分享页：?trip=ID&as=d|1|2…（司机链接带 k）。轮询服务端状态；司机点按钮上报 */
async function initShare() {
  document.body.classList.add('share-mode');
  const id = params.get('trip'), as = params.get('as') || '1', k = params.get('k') || '';
  const load = async () => { const r = await fetch(`/api/trip?id=${encodeURIComponent(id)}${k ? '&k=' + encodeURIComponent(k) : ''}`); S.share = await r.json(); renderShare(as, k); };
  S.shareReload = load;
  $('#poolBody').addEventListener('click', async e => {
    const b = e.target.closest('[data-ev]'); if (!b) return;
    b.disabled = true;
    const r = await fetch('/api/tripEvent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, key: k, type: b.dataset.ev, idx: +b.dataset.idx || 0 }) }).then(x => x.json());
    if (r.error) toast(r.error); await load();
  });
  $('#poolClose').style.display = 'none';
  await load();
  if (!SHOT) setInterval(load, 5000);
}
function renderShare(as, k) {
  const T = S.share, hm = Carpool.hm; const sh = $('#poolSheet'); sh.classList.add('show', 'full');
  if (!T || T.error) { $('#poolTitle').textContent = '🚗 拼车行程'; $('#poolBody').innerHTML = `<div class="fc-bad">${esc((T && T.error) || '加载失败')}</div>`; return; }
  const P = T.plan, s = P.sched, ev = T.events || [], last = ev[ev.length - 1];
  const fresh = last && last.fresh != null ? last.fresh : null;
  const live = Carpool.liveEta(s, ev, fresh, T.now);
  const picked = new Set(ev.filter(x => x.type === 'picked').map(x => x.idx));
  const me = as === 'd' ? null : +as - 1;
  $('#poolTitle').textContent = `🚗 ${P.date ? P.date.slice(5).replace('-', '/') : ''} · ${destLabel(P.dest.name, P.dest.said)} ${P.deadline} 前到`;
  $('#poolSub').textContent = as === 'd' ? `${P.driver.name}（司机）` : `${(P.riders[me] || {}).name || ''} 的卡片`;
  const state = live.state === 'done' ? '✅ 已到达，行程结束' : !last ? `司机还没出发（计划 ${hm(s.depart)} 出发）` : `🚗 司机已出发 · 更新于 ${hm(last.at)}${last.fresh != null ? `（下一段按实时路况 ${last.fresh}′${last.freshMock ? ' · 示例' : ''}）` : ''}`;
  const card = (r, j) => {
    const done = picked.has(j), eta = live.eta && live.eta[j];
    const soon = !done && eta != null && eta - T.now <= 10 && live.state !== 'done';
    const line = done ? '✅ 已上车' : eta != null && last ? `预计 <b>${hm(eta)}</b> 到你这${soon ? ' · <b>可以下楼了</b>' : ''}` : `计划 <b>${hm(r.down)}</b> 下楼（车 ${hm(r.car)} 到）`;
    return `<div class="pool-card ${j === me ? 'me' : ''} ${soon ? 'soon' : ''}"><div class="pc-top">🙋 <b>${esc(r.name)}</b>${j === me ? '<span class="t">这是你</span>' : ''}<span class="pc-big">${done ? '已上车' : hm(eta != null && last ? eta - 2 : r.down) + ' 下楼'}</span></div>
      <div class="pc-sub">在「${esc(short(r.place))}」等</div><div class="pc-sub">${line}</div></div>`;
  };
  const k1 = P.riders.length;
  let btns = '';
  if (T.isDriver) {
    const nextIdx = last ? (last.type === 'depart' ? 0 : last.type === 'picked' ? last.idx + 1 : k1 + 1) : -1;
    btns = `<div class="pc-btns">${!last ? '<button class="fs-ok" data-ev="depart">出发了</button>' : nextIdx < k1 ? `<button class="fs-ok" data-ev="picked" data-idx="${nextIdx}">接到 ${esc(P.riders[nextIdx].name)} 了</button>` : live.state !== 'done' ? '<button class="fs-ok" data-ev="arrived">到了</button>' : ''}<button class="chip sm" data-ev="reset">重置</button></div>`;
  }
  $('#poolWhy').innerHTML = `${state}<br>预计 <b>${hm(live.arrive || s.arrive)}</b> 到 ${esc(destLabel(P.dest.name, P.dest.said))}${live.late && P.date === T.today ? ` · <b>可能晚 ${live.late}′</b>` : ''} · 按现在路况 +15%，每 5 秒刷新`;
  const order = me != null ? [me, ...P.riders.map((_, j) => j).filter(j => j !== me)] : P.riders.map((_, j) => j);
  $('#poolBody').innerHTML = btns + order.map(j => card(P.riders[j], j)).join('') +
    `<div class="pool-card drv"><div class="pc-top">🚗 <b>${esc(P.driver.name)}</b>（司机）<span class="pc-big">${last ? (live.state === 'done' ? '已到达' : '已出发') : hm(s.depart) + ' 出发'}</span></div><div class="pc-sub">${last ? `${hm((ev.find(x => x.type === 'depart') || last).at)} 出发 · ` : ''}从 ${esc(short(P.driver.place))} · 按顺序接 ${P.riders.map(r => esc(r.name)).join(' → ')} → ${esc(destLabel(P.dest.name, P.dest.said))}</div></div>
     <div class="fs-hint">只读分享页 · 不发短信、不推送；司机位置 = 上一个上车点（简单版，不用定位权限）</div>`;
  const pts = P.points, markers = pts.map((p, i) => ({ lat: p.lat, lng: p.lng, kind: 'num', text: i === 0 ? '司' : i === pts.length - 1 ? '终' : String(i), name: i === 0 ? P.driver.name : i === pts.length - 1 ? short(p.name).slice(0, 8) : P.riders[i - 1].name, selected: me != null && i === me + 1 }));
  requestAnimationFrame(() => MapView.get($('#poolMap')).render({ markers, lines: [{ path: P.path || [], color: '#2563EB', width: 4 }], padTop: 20, padBottom: 20 }));
}

/* ---------------- 7 时间轴 ---------------- */
function curDay() { return S.days.find(d => d.key === S.day) || S.days[0]; }
function renderDayPills() {
  $('#dayPills').innerHTML = `<button data-day="plan">← 计划总览</button>` + S.days.map(d => `<button data-day="${d.key}" class="${d.key === S.day ? 'on' : ''}">${d.label}</button>`).join('') + `<button data-day="pool" class="${S.day === 'pool' ? 'on' : ''}">备选</button>`;
}
function poolList() {
  const inPlan = new Set(S.days.flatMap(d => d.items.map(i => i.poiUid)));
  const out = [];
  (S.task.activities || []).forEach(a => {
    const list = (S.pois[S.hotel.uid] || {})[a.kind] || [];
    PL.rankPois(list, S.hotel, a.max_radius_km || 2, { s: a.window_start, dur: a.duration_min }).inside.filter(p => !inPlan.has(p.uid)).slice(0, 2).forEach(p => out.push(Object.assign({ cat: a.kind }, p)));
  });
  return out;
}
function renderTimeline() {
  renderDayPills();
  const tl = $('#timeline'); tl.innerHTML = '';
  if (!S.days.length) return;
  if (S.day === 'pool') {
    const pool = poolList();
    $('#daySummary').textContent = `备选 ${pool.length} 个 · 点“换上”替换同类`;
    tl.innerHTML = pool.map(p => `<div class="poi-card pool-item" data-uid="${esc(p.uid)}" data-cat="${p.cat}"><div class="thumb">${CATS[p.cat].emo}</div><div class="info"><h4>${esc(nm(p.name))}${p.mock ? ' <span class="mock-tag">示例</span>' : ''}</h4>
      <div class="tags"><span class="pill">距酒店 ${fmtKm(p.distKm)}</span>${p.rating ? `<span class="pill orange">★ ${p.rating}</span>` : ''}${p.hours ? `<span class="pill green">${esc(p.hours)}</span>` : ''}</div></div><button class="add">换上</button></div>`).join('') || '<div class="hint">没有备选</div>';
    renderRouteMap(S.days[0]);
    return;
  }
  const day = curDay();
  const st = PL.schedule(day.items, TR);
  const nTight = day.items.filter(i => i.tight && !i.conflict).length, nPlaces = day.items.filter(i => i.kind !== 'hotel').length;
  $('#daySummary').innerHTML = `${nPlaces} 个地点 · ${st.totalKm.toFixed(1)}km · 通勤 ${st.totalMin}′ · ${toHM(st.start)}–${toHM(st.end)}` +
    (st.conflicts ? ` · <span class="conflict">⚠ ${st.conflicts} 处冲突</span>` : nTight ? ` · <span class="tight">⚠ ${nTight} 处很紧</span>` : ' · <span style="color:#10B981">无冲突</span>');
  let n = 0;
  day.items.forEach((it, i) => {
    if (i > 0) {
      const lg = st.legs[i - 1], c = SEG_COLORS[(i - 1) % SEG_COLORS.length];
      const tr = transitFor(it), trMiss = tr && !tr.none && it.fixed && i > 1 && day.items[i - 1].e + tr.min > toMin(it.start);
      const trTxt = tr && !tr.none ? `<br><span class="tr-alt">🚇 公交/地铁 ${tr.min}′${tr.lines && tr.lines.length ? '（' + esc(tr.lines.slice(0, 3).join('→')) + '）' : ''}${trMiss ? ' · <b class="conflict">坐地铁赶不上</b>' : i === 1 && it.fixed ? ` · 需 ${toHM(toMin(it.start) - tr.min - 10)} 前出发` : ''}</span>` : '';
      tl.insertAdjacentHTML('beforeend', `<div class="transit"><span style="display:inline-block;width:3px;height:14px;border-radius:2px;background:${c};vertical-align:top"></span><span>${lg.emo} ${lg.label} ${fmtKm(lg.km)} · ${lg.min}min${lg.source === 'estimate' ? ' <span class="src">估算</span>' : lg.source === 'matrix-mock' ? ' <span class="src">示例</span>' : ''}${it.wait > 20 && it.kind !== 'hotel' && !day.items[i - 1].midReturn ? ` · <span style="color:#9AA3AD">空档 ${it.wait}′</span>` : ''}${trTxt}</span></div>`);
    }
    const isH = it.kind === 'hotel';
    let time = isH ? toHM(it.s) : `${toHM(it.s)}–${toHM(it.e)}`;
    if (it.midReturn && day.items[i + 1]) { // 回酒店中转：能休息多久、最晚几点出发
      const nx = day.items[i + 1], lgN = st.legs[i], latest = (nx.fixed ? toMin(nx.start) : nx.s) - lgN.min;
      time += ` 到 · 可休息 ${Math.max(0, latest - it.s)} 分钟，最晚 ${toHM(latest)} 出发`;
    }
    tl.insertAdjacentHTML('beforeend', `<div class="tl-item${it.pinned ? ' pinned' : ''}${S.dragging === it.uid ? ' dragging' : ''}${S.highlight === it.uid ? ' new' : ''}" data-uid="${it.uid}" ${it.pinned ? '' : 'draggable="true"'}>
      ${isH ? '<div class="num" style="background:#111">宿</div>' : `<div class="num">${++n}</div>`}
      <div class="body"><div class="cat ${CAT_CLASS[it.kind] || ''}">${CAT_LABEL[it.kind] || it.kind}${it.fixed ? ' · 🔒 时间固定' : it.notBefore ? ` · ${it.notBefore} 后` : ''}${it.mock ? ' <span class="mock-tag">示例</span>' : ''}</div>
        <div class="name">${it.label && (isH || it.label === '请客户吃饭' || it.stopId) ? esc(it.label) + ' · ' : ''}${esc(it.kind === 'client' ? short(it.name) : nm(it.name))}</div>
        <div class="time ${it.conflict ? 'conflict' : ''}">${time}${it.durAssumed ? `（${(it.dur / 60).toFixed(it.dur % 60 ? 1 : 0)} 小时是假设）` : ''}${it.hours && !isH ? ` · 营业 ${esc(it.hours)}` : ''}${it.conflict ? ' · ⚠ ' + esc(it.conflict) : it.tight ? ` · <span class="tight">⚠ ${esc(it.tight)}</span>` : ''}</div>
        ${it.said && short(it.said) !== short(it.name) && !it.src ? `<div class="said">你说的「${esc(it.said)}」</div>` : ''}${it.src ? `<div class="op-src ${it.src.web ? 'web' : 'llm'}">${it.src.web ? `来自网页 · 「${esc(it.src.name.slice(0, 14))}」 · ${it.src.url ? `<a href="${esc(it.src.url)}" target="_blank" rel="noopener">原文链接 ↗</a>` : '示例'} · 发布于 ${esc(it.src.date || '?')} · 出发前看原文` : '大模型建议 · 地点已由百度核实'}</div>` : ''}</div>
      <div class="handle">${it.pinned ? '📌' : '≡'}</div></div>`);
  });
  renderRouteMap(day, st);
}
function renderRouteMap(day, st) {
  st = st || PL.schedule(day.items, TR);
  let n = 0; const markers = [], seen = new Set();
  day.items.forEach(it => { if (it.kind === 'hotel') { if (seen.has('H')) return; seen.add('H'); markers.push({ lat: it.lat, lng: it.lng, kind: 'hotel', name: short(it.name) }); } else markers.push({ lat: it.lat, lng: it.lng, kind: 'num', text: String(++n), name: short(it.name).replace(/ · .*/, '') }); });
  const lines = [];
  for (let i = 1; i < day.items.length; i++) { const a = day.items[i - 1], b = day.items[i]; if (ptKey(a) === ptKey(b)) continue; const lg = st.legs[i - 1]; lines.push({ path: routePath(a, b), color: SEG_COLORS[(i - 1) % SEG_COLORS.length], pill: `${fmtKm(lg.km)}·${lg.min}′` }); }
  MapView.get($('#routeMap')).render({ markers, lines, circles: [], padTop: 34, padBottom: 16 });
}
function initDrag() {
  const tl = $('#timeline');
  let fromUid = null, targetIdx = -1, moved = false;
  tl.addEventListener('dragstart', e => {
    const card = e.target.closest('.tl-item');
    if (!card || card.classList.contains('pinned') || S.day === 'pool') { e.preventDefault(); return; }
    fromUid = card.dataset.uid; moved = false; card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', fromUid);
  });
  tl.addEventListener('dragover', e => {
    if (!fromUid) return; e.preventDefault();
    const over = e.target.closest('.tl-item'); if (!over || over.classList.contains('pinned')) return;
    $$('.tl-item', tl).forEach(c => c.classList.remove('tl-ghost'));
    if (over.dataset.uid !== fromUid) over.classList.add('tl-ghost');
    targetIdx = $$('.tl-item', tl).indexOf(over);
  });
  const finish = () => {
    if (!fromUid) return;
    const day = curDay(), items = day.items;
    const from = items.findIndex(i => i.uid === fromUid), to = Math.max(1, Math.min(items.length - 2, targetIdx));
    if (targetIdx > -1 && to !== from) { const [it] = items.splice(from, 1); items.splice(to, 0, it); moved = true; }
    fromUid = null; targetIdx = -1; S.dragging = null;
    renderTimeline();
    if (moved) { const c = items.filter(i => i.conflict).length; toast(c ? `已重算交通和时间 · ⚠ ${c} 处冲突` : '已重算交通和时间 · 无冲突'); fetchRoutes(day, 'edit').then(ch => ch && cur === 7 && renderTimeline()); }
  };
  tl.addEventListener('drop', e => { e.preventDefault(); finish(); });
  document.addEventListener('dragend', finish);
  let touchUid = null;
  tl.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    const handle = e.target.closest('.handle'), card = e.target.closest('.tl-item');
    if (!handle || !card || card.classList.contains('pinned')) return;
    touchUid = card.dataset.uid; moved = false; card.setPointerCapture(e.pointerId);
  });
  tl.addEventListener('pointermove', e => {
    if (!touchUid) return;
    const items = curDay().items, from = items.findIndex(i => i.uid === touchUid);
    let to = from;
    $$('.tl-item', tl).forEach((c, idx) => { const r = c.getBoundingClientRect(); if (e.clientY < r.top + r.height / 2 && idx < from) to = Math.min(to, idx); if (e.clientY > r.top + r.height / 2 && idx > from) to = Math.max(to, idx); });
    to = Math.max(1, Math.min(items.length - 2, to));
    if (to !== from) { const [it] = items.splice(from, 1); items.splice(to, 0, it); moved = true; S.dragging = touchUid; renderTimeline(); }
  });
  tl.addEventListener('pointerup', () => { if (!touchUid) return; touchUid = null; S.dragging = null; renderTimeline(); if (moved) toast('已重算交通和时间'); });
  tl.addEventListener('click', async e => {
    const b = e.target.closest('.pool-item .add'); if (!b) return;
    const card = b.closest('.pool-item'); const p = poolList().find(x => x.uid === card.dataset.uid); if (!p) return;
    const { day } = await addToPlan(p, card.dataset.cat); S.day = day.key; renderTimeline(); toast('已换上：' + short(p.name));
  });
}
function optimizeDay() {
  const day = curDay(); if (!day) return;
  if (day.items.some(i => i.stopId || i.midReturn)) { toast('这一天的地点、顺序和时间都是你定的，不自动重排'); return; }
  const before = PL.schedule(day.items.map(i => Object.assign({}, i)), TR);
  const r = PL.optimize(day.items, TR);
  day.items = r.items;
  const after = PL.schedule(day.items, TR);
  localStep('✨', `一键优化 · ${day.label}`, `${r.method === 'permutation' ? '全排列 ' + r.tried + ' 种' : '最便宜插入'} · 通勤 ${before.totalMin}′ → ${after.totalMin}′ · 冲突 ${before.conflicts} → ${after.conflicts}`, 'edit');
  renderTimeline(); fetchRoutes(day, 'edit').then(ch => ch && cur === 7 && renderTimeline());
  toast(`✨ ${r.method === 'permutation' ? '全排列 ' + r.tried + ' 种' : '最便宜插入'} · 通勤 ${before.totalMin}′ → ${after.totalMin}′`);
}

/* ---------------- 8 变更审批 ---------------- */
const PRESETS = ['把酒吧换成请客户吃饭', '取消网球'];
function planSummary() { return S.days.map(d => ({ date: d.date, items: d.items.map(i => ({ kind: i.kind, name: short(i.name), start: toHM(i.s), end: toHM(i.e), fixed: !!i.fixed })) })); }
async function startChange(text) {
  S.change = { text, stage: 'llm' };
  $('#approvalCard').style.display = 'none';
  const th = $('#s8thread');
  th.innerHTML = `<div class="bubble user">${esc(text)}</div><div class="bubble" id="s8agent">正在理解改动…</div>`;
  const r = await api('replan', { body: { text, plan: planSummary() } }, { ico: '🤖', lab: '变更解析 · 大模型结构化 diff', phase: 'edit', detail: r => ((r.diff.ops || []).map(o => `${o.op} ${o.target_kind}→${o.new_kind}${o.query ? '「' + o.query + '」' : ''}`).join('; ') || '无改动') + (r.fixes && r.fixes.length ? ' · 本地校验修正：' + r.fixes.join('，') : '') });
  const diff = r.diff || { ops: [] };
  S.change.diff = diff;
  const op = (diff.ops || [])[0];
  if (!op) { $('#s8agent').textContent = diff.explanation || '没看懂要改什么。'; return; }
  if (op.op === 'move') { $('#s8agent').textContent = 'v1 暂不支持“挪到另一天”，可以在时间轴里拖动。'; return; }
  const opts = diff.question && diff.question.options && diff.question.options.length ? diff.question.options : (op.near === 'ask' ? ['🏨 酒店附近', '🏢 客户公司附近', '📍 两者中间'] : []);
  $('#s8agent').innerHTML = `${esc(diff.explanation)}${r.mock ? '<span class="mock-tag">（规则解析）</span>' : ''}${opts.length ? '<br>' + esc(diff.question.text || '放在哪里？') : ''}`;
  if (opts.length) {
    th.insertAdjacentHTML('beforeend', `<div class="chips" id="s8near" style="margin-top:0">${opts.map((o, i) => `<button class="chip ${i === 0 ? 'active' : ''}" data-i="${i}">${esc(o)}</button>`).join('')}</div>`);
    $('#s8near').addEventListener('click', e => { const b = e.target.closest('.chip'); if (!b) return; $$('#s8near .chip').forEach(c => c.classList.toggle('active', c === b)); computeChange(op, b.textContent); });
  }
  await computeChange(op, opts[0] || op.near);
}
function nearCenter(choice, day, target) {
  const cs = day.items.filter(i => i.kind === 'client');
  const lastC = cs[cs.length - 1];
  const c = /客户/.test(choice) || choice === 'client' ? 'client' : /中间|midpoint/.test(choice) ? 'mid' : /current/.test(choice) && target ? 'cur' : 'hotel';
  if (c === 'client' && lastC) return { lat: lastC.lat, lng: lastC.lng, name: short(lastC.name).replace(/ · .*/, '') + ' 公司', uid: 'c:' + ptKey(lastC) };
  if (c === 'mid' && lastC) return { lat: (lastC.lat + S.hotel.lat) / 2, lng: (lastC.lng + S.hotel.lng) / 2, name: '酒店与' + short(lastC.name).replace(/ · .*/, '') + '中间', uid: 'm:' + ptKey(lastC) };
  if (c === 'cur') return { lat: target.lat, lng: target.lng, name: short(target.name), uid: 't:' + ptKey(target) };
  return { lat: S.hotel.lat, lng: S.hotel.lng, name: '酒店', uid: S.hotel.uid };
}
async function computeChange(op, choice) {
  const act = (S.task.activities || []).find(a => a.kind === op.target_kind);
  const day = S.days.find(d => d.items.some(i => i.kind === op.target_kind && !i.fixed)) || S.days.find(d => act && d.date === act.date) || S.days[0];
  const target = day.items.find(i => i.kind === op.target_kind && !i.fixed);
  $('#s8dayLab').textContent = `📍 ${day.label} · 当前时间轴`;
  $('#s8chain').innerHTML = day.items.map(i => i.kind === 'hotel' ? '🏨' : (i === target ? `<b>${CATS[i.kind] ? CATS[i.kind].emo : ''} ${esc(short(i.name))}</b>` : esc(short(i.name).replace(/ · .*/, '')))).join(' → ');
  let after, pick = null, rk = null, center = null, radius = 1.5, used = null;
  S.change.reordered = false;
  if (op.op === 'remove') {
    if (!target) { $('#s8agent').insertAdjacentHTML('beforeend', '<br>时间轴里没有这一项。'); return; }
    after = day.items.filter(i => i !== target);
  } else {
    const nk = CATS[op.new_kind] ? op.new_kind : 'food';
    center = nearCenter(choice || 'hotel', day, target);
    const q = op.query || CATS[nk].query;
    const win = { s: op.window_start || CATS[nk].win, dur: op.duration_min || CATS[nk].dur };
    const list = (await fetchPois(center, nk, 3000, 'edit', q)).map(p => Object.assign(p, { cat: nk }));
    for (const r of [1.5, 3]) {
      rk = PL.rankPois(list, center, r, win); radius = r;
      if (rk.inside.length) break;
    }
    let cands = rk.inside;
    if (op.needs) { const m = cands.filter(p => `${p.name}${p.tag || ''}${p.tags || ''}`.includes(op.needs)); if (m.length) { cands = m; used = op.needs; } }
    pick = cands[0];
    if (!pick) { $('#s8agent').insertAdjacentHTML('beforeend', `<br>${esc(center.name)} 3km 内没有在 ${win.s} 营业的${CATS[nk].label}。`); $('#approvalCard').style.display = 'none'; return; }
    const it = mkItem(nk, pick, { notBefore: win.s, notAfter: op.window_end || '23:30', dur: win.dur, label: op.label || CATS[nk].label, actId: target ? target.actId : undefined });
    await ensureDayMatrix(day, 'edit', [...day.items, it]);
    if (op.op === 'replace' && target) after = day.items.map(i => i === target ? it : i);
    else after = PL.cheapestInsert(day.items.filter(i => op.op !== 'replace' || i !== target), it, TR).items;
    // 原位替换有冲突时，试一下重新排灵活项的顺序（客户时间固定），冲突更少才采用
    const c0 = PL.schedule(after.map(i => Object.assign({}, i)), TR).conflicts;
    if (c0) { const o = PL.optimize(after, TR).items; if (PL.schedule(o.map(i => Object.assign({}, i)), TR).conflicts < c0) { after = o; S.change.reordered = true; } }
    S.change.newItem = it;
  }
  const d = PL.diffPlans(day.items, after, TR);
  Object.assign(S.change, { op, day, after, d, pick, rk, center, radius, used, target, stage: 'review' });
  renderApproval();
}
function renderApproval() {
  const c = S.change; if (!c || !c.d) return;
  const { d, op } = c;
  const line = (i, cls) => `<li class="${cls}">${toHM(i.s)}–${toHM(i.e)} ${CATS[i.kind] ? CATS[i.kind].emo : ''} ${esc(short(i.name))}</li>`;
  const endB = d.before[d.before.length - 1], endA = d.after[d.after.length - 1];
  const tailKm = (arr, res) => { const idx = arr.findIndex(i => i.uid === (c.target || c.newItem || {}).uid); const from = Math.max(0, (idx > -1 ? idx : arr.length - 2) - 1); return res.legs.slice(from).reduce((a, l) => a + l.km, 0); };
  $('#diffBox').innerHTML = `
    <div class="diff-col before"><h5>− 修改前</h5><ul>${d.removed.map(i => line(i, 'rm')).join('') || '<li>（无删除）</li>'}
      <li>🏨 回酒店 ${toHM(endB.s)}</li><li style="color:#6B7280">当日路程 ${d.rb.totalKm.toFixed(1)}km · 通勤 ${d.rb.totalMin}′</li></ul></div>
    <div class="diff-col after"><h5>＋ 修改后</h5><ul>${d.added.map(i => line(i, 'ad')).join('') || '<li>（无新增）</li>'}
      <li>🏨 回酒店 ${toHM(endA.s)}</li><li style="color:#6B7280">当日路程 ${d.ra.totalKm.toFixed(1)}km · 通勤 ${d.ra.totalMin}′</li></ul></div>`;
  const dEnd = d.endDelta;
  $('#deltaRow').innerHTML = `<span class="delta ${dEnd <= 0 ? 'down' : 'up'}">结束时间 ${dEnd === 0 ? '不变' : (dEnd < 0 ? '提前 ' : '推迟 ') + Math.abs(dEnd) + ' 分钟'}</span>
    <span class="delta ${d.kmDelta > 0 ? 'up' : 'down'}">当日路程 ${d.kmDelta >= 0 ? '+' : '−'}${fmtKm(Math.abs(d.kmDelta))}</span>
    <span class="delta ${d.minDelta > 0 ? 'up' : 'down'}">通勤 ${d.minDelta >= 0 ? '+' : '−'}${Math.abs(d.minDelta)}′</span>
    ${c.pick ? `<span class="delta">${c.pick.rating ? '★ ' + c.pick.rating + ' · ' : ''}距${esc(c.center.name)} ${fmtKm(c.pick.distKm)}</span>` : ''}
    ${c.pick && c.pick.price ? `<span class="delta">${esc(typeof c.pick.price === 'number' ? '¥' + c.pick.price : c.pick.price)}</span>` : ''}`;
  $('#s8tag').textContent = `${c.day.label} · ${op.op === 'replace' ? '替换' : op.op === 'remove' ? '删除' : '新增'}`;
  $('#s8rule').textContent = c.pick ? `按“${c.center.name} ${c.radius}km 内、${op.window_start || ''} 起营业${c.used ? '、有' + c.used : (op.needs ? '（' + op.needs + ' 无法从数据确认，已忽略）' : '')}”先筛，再按评分排序，选了评分最高的一家（候选 ${c.rk.inside.length} 家）。时间由编排器重算${c.reordered ? '，原位替换会冲突，已调整灵活项顺序（客户时间不动）' : ''}。` : '删除后由编排器重算后续时间。';
  const affected = d.removed.length + d.added.length + d.changed.length;
  $('#s8impact').innerHTML = `影响 ${affected} 项（时间变化 ${d.changed.length}）· 其余 ${d.unchanged.length} 项不变 · ${d.conflictsAfter ? `<span class="conflict">⚠ ${d.conflictsAfter} 处冲突</span>` : '无时间冲突'}`;
  $('#approveRow').innerHTML = `<button class="btn ghost" id="s8deny">再改改</button><button class="btn blue" id="s8allow">批准</button>`;
  $('#approvalCard').style.display = '';
  requestAnimationFrame(() => renderChangeMap(c));
}
/* 变更审批小地图：检索圈 + 原来的点（灰）+ 改后选中的点 + 其它候选 */
function renderChangeMap(c) {
  if (!c || !c.d || cur !== 8) return;
  const markers = [], circles = [];
  const h = S.hotel;
  markers.push({ lat: h.lat, lng: h.lng, kind: 'hotel', name: short(h.name) });
  if (c.target) markers.push({ lat: c.target.lat, lng: c.target.lng, kind: 'num', text: '原', color: '#9CA3AF', name: '原：' + short(c.target.name) });
  if (c.pick) {
    const cat = c.newItem ? c.newItem.kind : 'food', C = CATS[cat] || CATS.other;
    circles.push({ lat: c.center.lat, lng: c.center.lng, rKm: c.radius, main: true });
    if (c.center.uid !== h.uid) markers.push({ lat: c.center.lat, lng: c.center.lng, kind: 'num', text: '心', color: '#7C3AED', name: c.center.name });
    (c.rk ? c.rk.inside : []).filter(p => p.uid !== c.pick.uid).slice(0, 6).forEach(p => markers.push({ lat: p.lat, lng: p.lng, kind: 'emoji', emoji: C.emo, color: C.color }));
    markers.push({ lat: c.pick.lat, lng: c.pick.lng, kind: 'emoji', emoji: C.emo, color: '#10B981', selected: true, name: '改后：' + short(c.pick.name) });
  }
  MapView.get($('#changeMap')).render({ markers, lines: [], circles, padTop: 30, padBottom: 12,
    legend: c.pick ? `圈 = ${short(c.center.name)} ${c.radius}km 检索范围 · 灰 = 原来` : '灰 = 删除的项' });
}
function applyChange() {
  const c = S.change; if (!c || !c.after) return;
  c.day.items = c.after;
  PL.schedule(c.day.items, TR);
  if (c.target && c.target.actId) {
    const a = S.task.activities.find(x => x.id === c.target.actId);
    if (a && c.op.op === 'replace') Object.assign(a, { kind: c.newItem.kind, label: c.newItem.label, placedName: c.newItem.name, window_start: c.newItem.notBefore, duration_min: c.newItem.dur });
    if (a && c.op.op === 'remove') S.task.activities = S.task.activities.filter(x => x !== a);
  }
  localStep('✅', `批准变更 · ${c.text}`, `${c.day.label} 已更新`, 'edit');
  S.highlight = c.newItem ? c.newItem.uid : null; S.day = c.day.key; c.stage = 'applied';
  $('#approveRow').innerHTML = `<div style="flex:1;text-align:center;font-size:13px;font-weight:700;color:#10B981;padding:10px">✓ 已批准，时间轴已更新</div>`;
  fetchRoutes(c.day, 'edit').then(ch => ch && cur === 7 && renderTimeline()); // 新路段拿到真实折线后重画
  setTimeout(() => { go(7); toast('已更新：' + c.text); }, SHOT ? 0 : 700);
}

/* ---------------- 首页 ---------------- */
function renderHome() {
  $('#homeChips').innerHTML = CHIPS.map((c, i) => `<button class="chip" data-i="${i}"><span class="emo">${c.emo}</span>${esc(c.lab)}</button>`).join('');
  renderRecent(); renderKeys();
}
function renderRecent() {
  $('#recentList').innerHTML = S.pipelineDone
    ? `<div class="check-item recent-plan" data-plan="cur" role="button" tabindex="0"><div style="font-size:22px">🧳</div><div class="check-body"><div class="name">${isStopTrip() ? esc(S.task.city) + '行程 · ' + S.task.stops.map(x => x.purpose || CATS[x.kind].label).join(' + ') : `${esc(S.task.city)}出差 · ${S.clients.length} 客户${S.task.activities.length ? ' + ' + S.task.activities.map(a => a.label).join(' + ') : ''}`}</div>
       <div class="meta">进行中 · ${S.task.dates[0].slice(5)}–${S.task.dates[S.task.dates.length - 1].slice(5)} · ${esc(short(S.hotel.name))} · 点开看总览</div></div><span class="chev">›</span></div>`
    : `<div class="check-item" style="opacity:.7"><div style="font-size:22px">🗺</div><div class="check-body"><div class="name">还没有计划</div><div class="meta">点上面的示例，或者直接说一句目标</div></div></div>`;
}
function renderKeys() {
  const s = S.status || {};
  const lastMock = kind => { const e = [...netEntries()].reverse().find(x => kind.test(x.api || '')); return e && e.mock ? e.reason : null; };
  const hasBaiduCall = netEntries().some(x => /geocoding|place|routematrix|direction/.test(x.api || ''));
  const baiduReason = hasBaiduCall ? lastMock(/geocoding|place|routematrix|direction/) : (s.baiduLast && !s.baiduLast.ok ? s.baiduLast.reason : null);
  const llmReason = lastMock(/LLM/);
  const row = (name, ok, okText, noText) => `<div>${name}：<span class="${ok ? 'ok' : 'no'}">${ok ? okText : noText}</span></div>`;
  $('#keyList').innerHTML =
    row('百度服务端 AK（地点/算路/路线/地理编码）', s.baiduAk && !s.forceMock && !baiduReason && (hasBaiduCall || (s.baiduLast && s.baiduLast.ok)), '已接通', s.forceMock ? 'MOCK=1 · 示例数据' : s.baiduAk ? (baiduReason ? '已设置，但 ' + esc(baiduReason) + ' → 示例数据' : '已设置 · 尚未调用') : '未设置 · 示例数据') +
    row('百度浏览器端 AK（JS 地图）', !!window.__useBaidu, '百度地图 GL', s.browserAk && !s.forceMock ? '已设置但加载失败 · SVG 示意图' : '未设置 · SVG 示意底图') +
    row(`大模型 ${esc(s.llmProvider || '')}（${esc(s.model || '')}）`, s.llm && !s.forceMock && !llmReason, '已接通', s.forceMock ? 'MOCK=1 · 规则解析' : s.llm ? (llmReason ? esc(llmReason) : '已设置 · 尚未调用') : '未设置 QIANFAN_API_KEY · 规则解析');
  $('#keyTag').textContent = isReal() ? '真实数据' : '示例数据';
}

/* ---------------- 导航 ---------------- */
const STATUS = {
  1: () => '在线 · 说一句目标就开始',
  2: () => S.task ? `已拆出任务 · 等你确认` : '<span class="dot"></span>正在理解任务',
  3: () => S.pipelineDone ? '规划完成 · 可以看结果' : '<span class="dot"></span>正在调用百度地图接口',
  4: () => S.task && S.task.fixedHotel && S.hotel ? `酒店由你指定 · ${short(S.hotel.name)}` : `${S.top.length} 个候选 · 推荐 ${short((S.top[0] || { hotel: {} }).hotel.name) || ''}`,
  5: () => `任务雷达 · 以${short(S.hotel && S.hotel.name) || '酒店'}为圆心`,
  6: () => '计划已生成 · 点一天打开时间轴',
  7: () => '时间轴 · 可拖拽调整',
  8: () => S.change && S.change.stage === 'review' ? '等你批准 · 只动受影响的部分' : '说说要改什么',
};
const PLACEHOLDER = { 1: '说一句目标，比如：上海出差见 3 个客户', 2: '补充或修改，比如：客户B改到下午3点', 3: '随时打断', 4: '比如：再便宜一点', 5: '比如：找个能打夜场的网球场', 6: '比如：打开时间轴', 7: '比如：把酒吧换成请客户吃饭', 8: '比如：取消网球' };
let prep = null;
async function ensureData(n) {
  if (n >= 2 && !S.task) { if (parsing) await parsing; else await doParse(S.text || DEMO_TEXT); }
  if (n >= 4 && !S.pipelineDone) { if (S.busy) { while (S.busy) await new Promise(r => setTimeout(r, 50)); } else await runPipeline(); }
}
async function go(n) {
  cur = n;
  $$('.screen').forEach(s => s.classList.toggle('active', +s.dataset.screen === n));
  $$('.step-btn').forEach(b => b.classList.toggle('active', +b.dataset.step === n));
  $('#chatInput').placeholder = PLACEHOLDER[n]; $('#chatInput').value = '';
  const setStatus = () => { const sl = $('#statusLine'); sl.innerHTML = STATUS[cur](); sl.classList.toggle('live', cur === 3 && !S.pipelineDone); $('#avatar').classList.toggle('working', (cur === 3 && !S.pipelineDone) || S.busy); };
  setStatus();
  if (history.replaceState) history.replaceState(null, '', location.pathname + location.search.replace(/([?&])s=\d+&?/, '$1').replace(/[?&]$/, '') + '#' + n);
  if (n === 1) { renderHome(); return; }
  if (n >= 3 && S.task && !S.pipelineDone && askPending()) { const m = askPending(); nextStep(); await go(2); toast(m); return; }
  if (n === 3) {
    await ensureData(2);
    renderActivity();
    if (!S.pipelineDone && !S.busy) { await runPipeline(); renderActivity(); setStatus(); if (cur === 3 && !SHOT && !params.has('stay') && !S.fragOnly) setTimeout(() => cur === 3 && go(S.task.fixedHotel ? 6 : 4), 900); } // 指定酒店时不用选酒店，直接看总览
    return;
  }
  await ensureData(n);
  if (cur !== n) return;
  setStatus();
  if (n === 2) renderTasks();
  if (n === 4) renderHotels();
  if (n === 5) requestAnimationFrame(() => renderRadar());
  if (n === 6) requestAnimationFrame(renderOverview);
  if (n === 7) requestAnimationFrame(renderTimeline);
  if (n === 8) {
    $('#s8presets').innerHTML = PRESETS.map(p => `<button class="chip">${esc(p)}</button>`).join('');
    if (!S.change || S.change.stage === 'applied') await startChange(PRESETS[0]); else renderApproval();
    setStatus();
  }
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1800); }

async function send() {
  const v = $('#chatInput').value.trim();
  if (cur === 1) { S.text = v || DEMO_TEXT; S.task = null; await go(2); } // go(2) → ensureData 只解析一次（之前会调两次大模型）
  else if (cur === 2) { if (v) await doParse(S.text + '；' + v); else go(3); }
  else if (cur === 6) { S.day = S.days[0].key; go(7); }
  else if (cur === 7 || cur === 8) { if (v) { await go(8); if (cur === 8 && (S.change && S.change.text) !== v) startChange(v); } else go(8); }
  else if (v) toast('v1 这一屏还不能直接改：' + v.slice(0, 10));
}

async function init() {
  const [st, cfg] = await Promise.all([fetch('/api/status').then(r => r.json()).catch(() => ({})), fetch('/api/config').then(r => r.json()).catch(() => ({}))]);
  S.status = st;
  if (cfg.browserAk) window.__useBaidu = await MapView.loadBaidu(cfg.browserAk);
  renderBadge();
  $('#stepBar').addEventListener('click', e => { const b = e.target.closest('.step-btn'); if (b) go(+b.dataset.step); });
  $('#homeChips').addEventListener('click', e => { const b = e.target.closest('.chip'); if (!b) return; $('#chatInput').value = CHIPS[+b.dataset.i].fill; $('#chatInput').focus(); });
  $('#sendBtn').addEventListener('click', send);
  $('#chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  $('#s2go').addEventListener('click', () => go(3));
  $('#s2edit').addEventListener('click', () => toast('直接在下面说要改什么，比如：客户B改到下午3点'));
  $('#taskList').addEventListener('click', e => { const c = e.target.closest('.check'); if (c) c.classList.toggle('on'); if (e.target.classList.contains('edit')) toast('v1：在下方输入框说要改什么'); });
  $('#askRow').addEventListener('click', e => {
    if (e.target.closest('a[href]')) return; // 原文链接：直接打开
    if (onOpenClick(e)) return;
    const hd = e.target.closest('.fs-head[data-open]');
    if (hd) { const fs = hd.closest('.fs'); if (!fs.classList.contains('locked')) { S.flowOpen = S.flowOpen === hd.dataset.open ? null : hd.dataset.open; renderAsk(); } else toast('先完成上一步'); return; }
    const dc = e.target.closest('.chip[data-dates]'); if (dc) { const [a, b] = dc.dataset.dates.split(','); applyDates(a, b); return; }
    const pc = e.target.closest('.chip[data-price]'); if (pc) { S.hotelPick.price = S.hotelPick.price === pc.dataset.price ? '' : pc.dataset.price; renderAsk(); return; }
    const tc = e.target.closest('.chip[data-tag]'); if (tc) { const T = S.hotelPick.tags, x = tc.dataset.tag; S.hotelPick.tags = T.includes(x) ? T.filter(y => y !== x) : [...T, x]; renderAsk(); return; }
    const sc = e.target.closest('.chip[data-scen]'); if (sc) { localStep('🧭', `你选了：${Slots.TEMPLATES[sc.dataset.scen].name}`, '带着这个场景重新理解原话', 'parse'); doParse(S.text, sc.dataset.scen); return; }
    const vb = e.target.closest('.chip[data-venue]'); if (vb) { if (vb.dataset.st === 'recommend') setVenueRec(vb.dataset.venue); else { S.venue[vb.dataset.venue] = Object.assign(S.venue[vb.dataset.venue] || {}, { st: 'booked' }); renderAsk(); } return; }
    const cpa = e.target.closest('[data-cpadd]'); if (cpa) { keepPoolInputs(); S.poolIn.riders.push({ name: '', at: '' }); renderAsk(); return; }
    const cpd = e.target.closest('[data-cpdel]'); if (cpd) { keepPoolInputs(); S.poolIn.riders.splice(+cpd.dataset.cpdel, 1); renderAsk(); return; }
    const cpb = e.target.closest('[data-cpback]'); if (cpb) { keepPoolInputs(); S.poolIn.back = cpb.dataset.cpback === '1'; renderAsk(); return; }
    const frb = e.target.closest('.chip[data-frb]'); if (frb) { keepFragInputs(); S.fragIn.budget = +frb.dataset.frb; renderAsk(); return; }
    const hbb = e.target.closest('.chip[data-hb]'); if (hbb) { S.hb = { mode: hbb.dataset.hb }; renderAsk(); return; }
    const ok = e.target.closest('.fs-ok[data-act]');
    if (ok) { const a = ok.dataset.act; if (a === 'dates') applyDates($('#fdA').value, $('#fdB').value); else if (a === 'clients') verifyClients(); else if (a === 'venue') verifyVenue(ok.dataset.id); else if (a === 'hb') verifyHotelBooked(); else if (a === 'frag') verifyFrag(); else if (a === 'carpool') verifyPool(); else if (a === 'openhot') loadHot(); else if (a === 'hbrec') hotelNotBooked(); else applyHotelPrefs(); return; }
    const b = e.target.closest('.ask-btn[data-f]'); if (!b) return;
    const f = S.task.followups[+b.dataset.f]; if (!f) return;
    const next = b.nextElementSibling; if (next && next.classList.contains('chips')) { next.remove(); return; }
    const wrap = document.createElement('div'); wrap.className = 'chips'; wrap.style.width = '100%';
    wrap.innerHTML = f.options.map(o => `<button class="chip">${esc(o)}</button>`).join('');
    wrap.addEventListener('click', ev => { const c = ev.target.closest('.chip'); if (!c) return; S.answers[f.id] = c.textContent; b.textContent = '✓ ' + c.textContent; b.style.borderStyle = 'solid'; wrap.remove(); });
    b.after(wrap);
  });
  $('#s3skip').addEventListener('click', () => go(S.task && S.task.fixedHotel ? 6 : 4));
  $('#hotelScroll').addEventListener('click', async e => {
    const b = e.target.closest('.pick'); if (!b) return;
    const card = b.closest('.hotel-card'), row = S.top.find(r => r.hotel.uid === card.dataset.uid); if (!row) return;
    b.textContent = '计算中…';
    if (!S.hotel || S.hotel.uid !== row.hotel.uid) await selectHotel(row.hotel);
    renderHotels(); toast(`已选 ${short(row.hotel.name)}，打开任务雷达`);
    setTimeout(() => go(5), SHOT ? 0 : 600);
  });
  $('#catPills').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.radar.cat = b.dataset.cat; S.radar.sel = null; renderRadar(); });
  $('#radiusPills').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.radar.r = +b.dataset.r; renderRadar(); });
  $('#poiList').addEventListener('click', async e => {
    const card = e.target.closest('.poi-card'); if (!card) return;
    const p = S.radar.rk && S.radar.rk.inside.find(x => x.uid === card.dataset.uid); if (!p) return;
    if (e.target.classList.contains('add')) {
      if (S.radar.cat === 'client' || S.radar.cat === 'stop') return;
      const { day, replaced } = await addToPlan(p, S.radar.cat);
      toast(`${replaced ? '已替换' : '已加入'} ${day.label}：${short(p.name)}`); renderRadar(); return;
    }
    S.radar.sel = p.uid; renderRadar();
  });
  $('#s5next').addEventListener('click', () => go(6));
  $('#dayPills').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.day === 'plan') { go(6); return; } S.day = b.dataset.day; renderTimeline(); });
  $('#dayCards').addEventListener('click', e => { const c = e.target.closest('.day-card'); if (!c) return; S.day = c.dataset.day; go(7); });
  $('#ovOpen').addEventListener('click', () => { S.day = S.days[0].key; go(7); });
  $('#gapBox').addEventListener('click', e => { const b = e.target.closest('[data-ga]'); if (b && !b.disabled) onGap(b.dataset.gap, b.dataset.ga); });
  $('#ovEdit').addEventListener('click', () => go(2));
  $('#ovChange').addEventListener('click', () => go(8));
  $('#planBtn').addEventListener('click', () => S.pipelineDone ? go(6) : toast('还没有计划，先说一句目标'));
  $('#recentList').addEventListener('click', e => { if (e.target.closest('.recent-plan')) go(6); });
  $('#optBtn').addEventListener('click', optimizeDay);
  $('#s8presets').addEventListener('click', e => { const b = e.target.closest('.chip'); if (b) startChange(b.textContent); });
  $('#approveRow').addEventListener('click', e => { if (e.target.id === 's8allow') applyChange(); if (e.target.id === 's8deny') toast('好的，说说想怎么改：比如换到客户公司附近'); });
  $('#logBtn').addEventListener('click', () => $('#logSheet').classList.toggle('show'));
  $('#logClose').addEventListener('click', () => $('#logSheet').classList.remove('show'));
  $('#fragClose').addEventListener('click', () => $('#fragSheet').classList.remove('show'));
  $('#poolClose').addEventListener('click', () => $('#poolSheet').classList.remove('show'));
  if (params.has('trip')) { await initShare(); window.__ready = true; return; }
  $('#poolBody').addEventListener('click', onPoolClick);
  $('#fragList').addEventListener('click', e => { const b = e.target.closest('[data-frag]'); if (b) addFragToPlan(+b.dataset.frag); });
  $('#dataBadge').addEventListener('click', () => $('#logSheet').classList.add('show'));
  window.addEventListener('resize', () => { if (cur === 5) renderRadar(); if (cur === 6) renderOverview(); if (cur === 7) renderTimeline(); });
  initDrag();
  const h = parseInt(params.get('s') || (location.hash || '#1').slice(1), 10);
  await go(h >= 1 && h <= 8 ? h : 1);
  if (!SHOT) window.addEventListener('hashchange', () => { const n = parseInt(location.hash.slice(1), 10); if (n >= 1 && n <= 8 && n !== cur) go(n); });
  window.__ready = true;
}
window.__app = { S, go, applyChange, startChange, optimizeDay, renderTimeline, renderAsk, findGaps, onGap, openFragment, TR: (a, b) => TR(a, b), renderPool, shareReload: () => S.shareReload && S.shareReload() };
init();
})();
