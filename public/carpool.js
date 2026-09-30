/* v2.3 M4 场景 4 多人拼车接送（简化版）的纯函数：浏览器、服务端（分享页状态）和测试共用。见 agent-flow-v1.md 8.4
   - 从原话抽：司机、司机从哪出发、每个乘客在哪上车、目的地、几点前到、回程要不要反着送
   - 接人顺序：乘客 ≤ 5 人时枚举所有顺序，目标「总时长最短」或「最公平」（最长坐车时间最短）
   - 倒推：到达 = 截止 − 10 分钟；每段路 × 1.15（周末路况查不到，按现在路况加 15%）；每个上车点等 3 分钟；乘客提前 2 分钟下楼
   - 实时（简单版）：司机点「出发了 / 接到 X 了」，位置 = 上一个上车点，下一段用实时路况重算，后面各段用排好的 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Carpool = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const RULE = { buffer: 10, traffic: 1.15, wait: 3, down: 2 };
  const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
  const num = s => (/^\d+$/.test(s) ? +s : CN[s] || 0);
  const hm = m => { m = Math.round(m); const r = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`; };
  const NAME = '[\\u4e00-\\u9fa5A-Za-z]{1,4}';
  const PLACE = '[\\u4e00-\\u9fa5A-Za-z0-9·]{2,14}?';

  /* 原话 → { driver, driverFrom, riders:[{name, at}], dest, deadline:'HH:MM', purpose, back } ；抽不到的留空，由追问卡补 */
  function fromText(text) {
    const t = String(text || '');
    const out = { driver: '', driverFrom: '', riders: [], dest: '', deadline: '', purpose: '', back: /反过来送|原路送|送回|回来.{0,4}送|再送回/.test(t) };
    let m = t.match(new RegExp(`(${NAME}?)\\s*开车`)); if (m) out.driver = m[1].replace(/^(周[一二三四五六日天]|明天|后天|今天|下周.)/, '') || '';
    if (!out.driver && /我开车/.test(t)) out.driver = '我';
    m = t.match(new RegExp(`从\\s*(${PLACE})\\s*(?:出发|开过来|开车)`)); if (m) out.driverFrom = m[1].replace(/^(他|她)?家$/, '');
    // 「到徐家汇接我」「去静安寺接小李」「先接我（徐家汇）」「接上B」
    const re = new RegExp(`(?:(?:先|再|然后|顺路)?\\s*(?:到|去)\\s*(${PLACE})\\s*)?(?:先|再|然后|顺路|顺便)?\\s*接(?:上)?\\s*(${NAME})(?:[（(]\\s*(?:在)?\\s*(${PLACE})\\s*[）)])?`, 'g');
    let r; const seen = new Set();
    while ((r = re.exec(t))) {
      let name = r[2].replace(/(一起|再|然后|和|去|到|回)+.*$/, '');
      if (!name || seen.has(name)) continue;
      // 「接我和B」→ 两个人
      const parts = name.split(/和|跟|、/).filter(Boolean);
      parts.forEach(n => { if (!seen.has(n)) { seen.add(n); out.riders.push({ name: n, at: (r[1] || r[3] || '').replace(/^(先|再)/, '') }); } });
    }
    const and = t.match(new RegExp(`接\\s*(${NAME})\\s*和\\s*(${NAME})`)); if (and) [and[1], and[2]].forEach(n => { n = n.replace(/(一起|去|到).*$/, ''); if (n && !seen.has(n)) { seen.add(n); out.riders.push({ name: n, at: '' }); } });
    // 「我在徐家汇」「小李在静安寺」补上车点
    out.riders.forEach(x => { const q = t.match(new RegExp(`${x.name}\\s*(?:家)?\\s*在\\s*(${PLACE})(?:[，,。）)]|$)`)); if (q && !x.at) x.at = q[1]; });
    m = t.match(new RegExp(`(?:一起|一块儿?)?\\s*去\\s*(${PLACE})\\s*(看|打|吃|参加|玩|听|逛|爬|露营|徒步|[，,。]|$)`, 'g'));
    if (m) { const last = m[m.length - 1].match(new RegExp(`去\\s*(${PLACE})\\s*(看|打|吃|参加|玩|听|逛|爬|露营|徒步|[，,。]|$)`)); if (last) { out.dest = last[1]; } }
    out.dest = out.dest.replace(/(爬山|露营|徒步|看比赛|看球|看演出|看展|打球|吃饭|玩)$/, '');
    m = t.match(/(看比赛|看球|看演出|看展|打球|爬山|吃饭|露营|听音乐会|看演唱会)/); if (m) out.purpose = m[1];
    m = t.match(/(上午|中午|下午|晚上)?\s*(\d{1,2}|十[一二]?|[一两二三四五六七八九])\s*点(半)?\s*(?:前|之前|以前)?\s*(?:到|赶到)/);
    if (m) { let h = num(m[2]); if ((m[1] === '下午' || m[1] === '晚上') && h < 12) h += 12; out.deadline = `${String(h).padStart(2, '0')}:${m[3] ? '30' : '00'}`; }
    return out;
  }

  function* perms(a, n = a.length) { if (n <= 1) { yield a.slice(); return; } for (let i = 0; i < n; i++) { yield* perms(a, n - 1); const j = n % 2 ? 0 : i; [a[n - 1], a[j]] = [a[j], a[n - 1]]; } }
  /* M：(k+2)×(k+2) 分钟矩阵，下标 0 = 司机出发地，1..k = 乘客，k+1 = 目的地。返回每个顺序的 总时长 / 每人坐车时间 */
  function evalOrder(M, order) {
    const pts = [0, ...order, M.length - 1]; let total = 0; const legs = [];
    for (let i = 1; i < pts.length; i++) { legs.push(M[pts[i - 1]][pts[i]]); total += M[pts[i - 1]][pts[i]]; }
    // 乘客 order[i] 从上车到下车 = 之后各段 + 中途等人
    const ride = order.map((_, i) => legs.slice(i + 1).reduce((a, b) => a + b, 0) + RULE.wait * (order.length - 1 - i));
    return { order, legs, total: total + RULE.wait * order.length, maxRide: Math.max(0, ...ride), ride };
  }
  function bestOrders(M, said) {
    const k = M.length - 2, ids = Array.from({ length: k }, (_, i) => i + 1);
    const all = []; if (k <= 5) for (const p of perms(ids.slice())) all.push(evalOrder(M, p));
    const asSaid = evalOrder(M, said || ids);
    const fast = all.reduce((b, x) => (!b || x.total < b.total ? x : b), null) || asSaid;
    const fair = all.reduce((b, x) => (!b || x.maxRide < b.maxRide || (x.maxRide === b.maxRide && x.total < b.total) ? x : b), null) || asSaid;
    return { said: asSaid, fast, fair, tried: all.length };
  }

  /* 倒推：legsMin = [司机→第1个上车点, …, 最后一个→目的地]（路况原值，分钟）。返回每个点的时间 */
  function backSchedule(legsMin, deadline, rule = RULE) {
    const L = legsMin.map(x => Math.ceil(x * rule.traffic));
    const arrive = toMin(deadline) - rule.buffer, stops = [];
    let t = arrive;
    for (let i = L.length - 1; i >= 1; i--) { // 上车点 i（1..k）
      const leave = t - L[i], car = leave - rule.wait;
      stops.unshift({ car, leave, down: car - rule.down, legAfter: L[i] });
      t = car;
    }
    const depart = t - L[0];
    return { depart, stops, arrive, legs: L, deadline: toMin(deadline), rule };
  }
  /* 回程：从 start（散场时间）起，按反向顺序送；legsMin = [目的地→最后上车的人, …, 第一个人→司机家] */
  function forwardSchedule(legsMin, start, rule = RULE) {
    const L = legsMin.map(x => Math.ceil(x * rule.traffic)); let t = toMin(start); const drops = [];
    L.forEach((x, i) => { t += x; drops.push({ at: t, leg: x }); if (i < L.length - 1) t += 1; });
    return { start: toMin(start), drops, end: t, legs: L };
  }
  /* 实时（简单版）：events 按时间排 [{type:'depart'|'picked'|'arrived', idx, at}]；fresh = 下一段实时路况分钟。返回各站新 ETA 和下一步 */
  function liveEta(plan, events, fresh, now) {
    const k = plan.stops.length, legs = plan.legs; // legs 已含 15%
    const last = events[events.length - 1];
    if (!last) return { state: 'waiting', next: 0, eta: plan.stops.map(s => s.car), arrive: plan.arrive };
    if (last.type === 'arrived') return { state: 'done', next: k + 1, eta: [], arrive: last.at };
    const pos = last.type === 'depart' ? 0 : last.idx + 1; // 已经到/离开了第 pos 个点（0 = 司机出发地）
    let t = last.at, eta = plan.stops.map(s => null);
    for (let i = pos; i <= k; i++) {
      const leg = i === pos && fresh != null ? Math.ceil(fresh * plan.rule.traffic) : legs[i];
      t += leg; if (i < k) { eta[i] = t; t += plan.rule.wait; }
    }
    return { state: pos === 0 && last.type === 'depart' ? 'driving' : 'driving', next: pos, eta, arrive: t, late: t > plan.deadline ? t - plan.deadline : 0 };
  }
  function toMin(t) { if (typeof t === 'number') return t; const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); }
  return { RULE, fromText, bestOrders, evalOrder, backSchedule, forwardSchedule, liveEta, hm, toMin };
});
