/* 确定性编排器（不用大模型）：浏览器和 Node 共用。
   - 酒店：先按预算/评分/通勤上限过滤，再按「通勤 50% + 评分 30% + 价格 20%」打分排序（通勤来自批量算路）
   - 地点：先按半径、营业时间过滤，再按评分排序
   - 行程：客户时间窗是硬约束；少量点全排列求最优；新增地点用最便宜插入法；拖拽后重算时间 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Planner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const toMin = t => { if (typeof t === 'number') return t; const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
  const toHM = m => { m = Math.round(m); const d = Math.floor(m / 1440); const r = ((m % 1440) + 1440) % 1440;
    return `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}${d > 0 ? '⁺¹' : ''}`; };

  function haversineKm(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function ptKey(p) { return (+p.lat).toFixed(5) + ',' + (+p.lng).toFixed(5); }

  /* 营业时间："07:00-22:00" / "17:00-01:00"（跨夜）/ "24小时" / 多段；解析不了返回 null（未知） */
  function parseHours(str) {
    if (!str) return null;
    str = String(str);
    if (/24\s*小时|全天|00:00\s*[-–~至到]\s*(24:00|23:59)/.test(str)) return [[0, 2880]];
    const re = /(\d{1,2})[:：](\d{2})\s*[-–~至到]\s*(次日)?\s*(\d{1,2})[:：](\d{2})/g;
    const out = []; let m;
    while ((m = re.exec(str))) {
      const s = +m[1] * 60 + +m[2]; let e = +m[4] * 60 + +m[5];
      if (e <= s || m[3]) e += 1440;
      out.push([s, e]);
    }
    return out.length ? out : null;
  }
  function openDuring(hours, s, e) {
    const iv = Array.isArray(hours) ? hours : parseHours(hours);
    if (!iv) return null;
    return iv.some(([a, b]) => (s >= a && e <= b) || (s + 1440 >= a && e + 1440 <= b) || (s - 1440 >= a && e - 1440 <= b));
  }

  /* 交通：直线 × 1.3 ≤ 2km 默认步行，否则驾车/打车；优先用批量算路结果，没有时才估算并标注 */
  const MODES = { walking: { emo: '🚶', label: '步行', kmh: 4.8, add: 0 }, riding: { emo: '🚲', label: '骑行', kmh: 12, add: 1 }, driving: { emo: '🚕', label: '打车', kmh: 20, add: 4 } };
  function chooseMode(a, b) { return haversineKm(a, b) * 1.3 <= 2 ? 'walking' : 'driving'; }
  function estimateLeg(a, b, mode) {
    const km = haversineKm(a, b) * 1.3; const M = MODES[mode] || MODES.driving;
    return { m: Math.round(km * 1000), s: Math.round((km / M.kmh * 60 + (km > 0.05 ? M.add : 0)) * 60), est: true };
  }
  /* lookup(a, b, mode) -> { m, s } | null（来自百度批量算路） */
  function makeTravel(lookup) {
    const cache = new Map();
    return (a, b) => {
      const k = ptKey(a) + '>' + ptKey(b);
      if (cache.has(k)) return cache.get(k);
      if (ptKey(a) === ptKey(b)) { const z = { km: 0, min: 0, mode: 'walking', emo: '·', label: '同地点', source: 'same' }; cache.set(k, z); return z; }
      const mode = chooseMode(a, b);
      const got = lookup && lookup(a, b, mode);
      const r = got || estimateLeg(a, b, mode);
      const res = { km: r.m / 1000, min: Math.max(1, Math.round(r.s / 60)), mode, emo: MODES[mode].emo, label: MODES[mode].label, source: got ? (got.mock ? 'matrix-mock' : 'matrix') : 'estimate' };
      cache.set(k, res);
      return res;
    };
  }

  /* 排时间：items = [酒店(起点), ...中间点, 酒店(终点)] */
  function schedule(items, travel, opts = {}) {
    const buffer = opts.buffer ?? 10;
    const legs = []; let t = 0, conflicts = 0, fixedConflicts = 0;
    items.forEach((it, i) => {
      it.conflict = null; it.wait = 0; it.tight = null;
      if (i === 0) {
        const next = items.find((x, j) => j > 0 && x.fixed);
        if (it.autoStart && items[1]) {
          if (items[1].fixed) {
            const lg = travel(it, items[1]);
            it.s = Math.floor((toMin(items[1].start) - lg.min - buffer) / 5) * 5;
          } else it.s = toMin(it.start || '09:00');
        } else it.s = toMin(it.start || (next ? next.start : '09:00'));
        it.e = it.s + (it.dur || 0); t = it.e; return;
      }
      const lg = travel(items[i - 1], it); legs.push(lg);
      const arrive = t + lg.min;
      if (it.fixed) {
        it.s = toMin(it.start);
        // 赶不上时按实际到达时间往后排（时间不能倒流，否则优化器会把固定客户挪到晚上"省"通勤）
        if (arrive > it.s) { it.conflict = `赶不上：预计 ${toHM(arrive)} 到，晚 ${arrive - it.s} 分钟`; it.s = arrive; fixedConflicts++; }
        else { it.wait = it.s - arrive; if (i > 1 && opts.tight !== 0 && it.wait < (opts.tight || 15)) it.tight = `余量只有 ${it.wait} 分钟`; }
      } else if (it.kind === 'hotel') {
        it.s = arrive;
      } else {
        let s = Math.ceil(arrive / 5) * 5;
        if (it.notBefore) s = Math.max(s, toMin(it.notBefore));
        it.wait = s - arrive;
        it.s = s;
        if (it.notAfter && s + (it.dur || 0) > toMin(it.notAfter) + (toMin(it.notAfter) < 360 ? 1440 : 0)) it.conflict = `超出时间窗（最晚 ${it.notAfter} 结束）`;
        const open = openDuring(it.hours, s, s + (it.dur || 0));
        if (open === false) it.conflict = `这段时间不营业（${it.hours}）`;
      }
      it.e = it.s + (it.dur || 0);
      if (it.conflict) conflicts++;
      t = it.e;
    });
    const totalKm = legs.reduce((a, l) => a + l.km, 0), totalMin = legs.reduce((a, l) => a + l.min, 0);
    return { legs, conflicts, fixedConflicts, totalKm, totalMin, start: items[0] ? items[0].s : 0, end: items.length ? items[items.length - 1].e : 0 };
  }
  const clone = items => items.map(i => Object.assign({}, i));
  function cost(items, travel) { const r = schedule(clone(items), travel); return r.totalMin + 600 * r.conflicts + 3000 * r.fixedConflicts + r.end * 0.01; }

  function* permute(arr, n = arr.length) {
    if (n <= 1) { yield arr.slice(); return; }
    for (let i = 0; i < n; i++) {
      yield* permute(arr, n - 1);
      const j = n % 2 ? 0 : i; [arr[n - 1], arr[j]] = [arr[j], arr[n - 1]];
    }
  }
  /* 一键优化：中间点 ≤ 7 个时全排列，否则固定项按时间排 + 灵活项最便宜插入 */
  function optimize(items, travel) {
    if (items.length < 4) return { items: items.slice(), method: 'none', tried: 0 };
    const head = items[0], tail = items[items.length - 1], mids = items.slice(1, -1);
    if (mids.length <= 7) {
      let best = items.slice(), bestC = cost(items, travel), tried = 0;
      for (const p of permute(mids.slice())) {
        tried++;
        const c = cost([head, ...p, tail], travel);
        if (c < bestC - 1e-9) { bestC = c; best = [head, ...p, tail]; }
      }
      return { items: best, method: 'permutation', tried };
    }
    const fixed = mids.filter(i => i.fixed).sort((a, b) => toMin(a.start) - toMin(b.start));
    let route = [head, ...fixed, tail];
    mids.filter(i => !i.fixed).forEach(f => { route = cheapestInsert(route, f, travel).items; });
    return { items: route, method: 'cheapest-insertion', tried: 0 };
  }
  function cheapestInsert(items, item, travel) {
    let best = null, bestC = Infinity, pos = -1;
    const base = cost(items, travel);
    for (let k = 1; k < items.length; k++) {
      const trial = [...items.slice(0, k), item, ...items.slice(k)];
      const c = cost(trial, travel);
      if (c < bestC) { bestC = c; best = trial; pos = k; }
    }
    return { items: best || [...items, item], pos, addedCost: bestC - base };
  }

  /* 地点：先按半径 + 营业时间过滤，再按评分排序（同分按距离） */
  function rankPois(pois, center, radiusKm, win) {
    const inside = [], outside = [], closed = [];
    pois.forEach(p => {
      const d = haversineKm(center, p);
      const q = Object.assign({}, p, { distKm: d });
      if (d > radiusKm) outside.push(q);
      else if (win && openDuring(p.hours, toMin(win.s), toMin(win.s) + (win.dur || 60)) === false) closed.push(q);
      else inside.push(q);
    });
    inside.sort((a, b) => (b.rating || 0) - (a.rating || 0) || a.distKm - b.distKm);
    outside.sort((a, b) => a.distKm - b.distKm);
    return { inside, outside, closed };
  }

  /* 酒店：先过滤（预算、评分、单程通勤上限），再打分 */
  function scoreHotels(hotels, clients, commute, prefs = {}) {
    const budget = prefs.budget || 0, minRating = prefs.minRating || 0, maxCommute = prefs.maxCommute || 60;
    const ranked = [], rejected = [];
    hotels.forEach(h => {
      const cs = clients.map(c => Object.assign({ client: c.id }, commute(h, c)));
      const avg = cs.reduce((a, c) => a + c.min, 0) / Math.max(1, cs.length);
      const max = Math.max(...cs.map(c => c.min));
      const row = { hotel: h, commutes: cs, avg, max };
      if (budget && h.price && h.price > budget) rejected.push(Object.assign(row, { reason: `超预算 ¥${h.price - budget}` }));
      else if (minRating && h.rating && h.rating < minRating) rejected.push(Object.assign(row, { reason: `评分 ${h.rating} < ${minRating}` }));
      else if (max > maxCommute) rejected.push(Object.assign(row, { reason: `单程通勤最长 ${max} 分钟 > ${maxCommute}` }));
      else ranked.push(row);
    });
    ranked.forEach(r => {
      const c = Math.max(0, Math.min(100, 100 - (r.avg - 8) * 2.5));
      const rt = r.hotel.rating ? Math.max(0, Math.min(100, (r.hotel.rating - 3.5) / 1.5 * 100)) : 50;
      const p = budget && r.hotel.price ? Math.max(0, Math.min(100, (budget - r.hotel.price) / budget * 100 * 2)) : 50;
      r.parts = { commute: Math.round(c), rating: Math.round(rt), price: Math.round(p) };
      r.score = Math.round(0.5 * c + 0.3 * rt + 0.2 * p);
      r.priceUnknown = !r.hotel.price;
    });
    ranked.sort((a, b) => b.score - a.score || a.avg - b.avg);
    return { ranked, rejected };
  }

  /* 改动前后对比 */
  function diffPlans(before, after, travel) {
    const b = clone(before), a = clone(after);
    const rb = schedule(b, travel), ra = schedule(a, travel);
    const bu = new Set(b.map(i => i.uid)), au = new Set(a.map(i => i.uid));
    const removed = b.filter(i => !au.has(i.uid)), added = a.filter(i => !bu.has(i.uid));
    const changed = a.filter(i => bu.has(i.uid)).filter(i => { const o = b.find(x => x.uid === i.uid); return o.s !== i.s || o.e !== i.e; });
    const unchanged = a.filter(i => bu.has(i.uid) && !changed.includes(i));
    return { before: b, after: a, rb, ra, removed, added, changed, unchanged,
      endDelta: ra.end - rb.end, kmDelta: ra.totalKm - rb.totalKm, minDelta: ra.totalMin - rb.totalMin, conflictsAfter: ra.conflicts };
  }

  return { toMin, toHM, haversineKm, ptKey, parseHours, openDuring, chooseMode, estimateLeg, makeTravel, schedule, optimize, cheapestInsert, rankPois, scoreHotels, diffPlans, MODES };
});
