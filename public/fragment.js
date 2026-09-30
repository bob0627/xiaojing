/* v2 M3 碎片时间推荐（纯函数，浏览器和 Node 共用；接口调用在 app.js）
   见 agent-flow-v1.md 7.4 / 8.5：
   - 半径按空闲时长：≤75 分钟 步行 800m；≤150 驾车 3km；≤210 驾车 6km；更长 8km（一个片区）
   - 有下一站：绕路 = 当前→候选 + 候选→下一站 − 当前→下一站，绕路 ≤ 总时长 1/3；没有下一站：来回路程 ≤ 1/3
   - 能待 = 总时长 − 去 − 往下一站（或回来）；要 ≥ 该类最短停留；营业时间要盖住整段停留
   - 出 2–3 个不同类别的选项，每个写「路上 X · 能待 Y · HH:MM 往回走」 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./planner.js'));
  else root.Frag = factory(root.Planner);
})(typeof self !== 'undefined' ? self : this, function (PL) {
  'use strict';
  const CATS = [
    // tag：百度 POI 的分类标签（如「美食;咖啡厅」「购物;服装」），用来剔除搜「美术馆」搜出来的服装店这类；maxStay：建议最多待多久
    { id: 'cafe', label: '咖啡', emo: '☕', query: '咖啡馆', minStay: 30, maxStay: 90, tag: /咖啡|美食|茶/, color: '#92400E' },
    { id: 'book', label: '书店', emo: '📚', query: '书店', minStay: 30, maxStay: 90, tag: /书店|文化|图书/, color: '#2563EB' },
    { id: 'park', label: '公园', emo: '🌳', query: '公园', minStay: 30, maxStay: 120, tag: /公园|景点|风景|植物园|绿地/, bad: /口袋公园|街心|小区|停车|广场绿地|医院|大学|学院|中学|小学|幼儿园|酒店|写字楼|大厦/, color: '#059669' },
    { id: 'museum', label: '看展', emo: '🖼', query: '美术馆', minStay: 60, maxStay: 150, tag: /美术馆|博物馆|展览|文化|艺术|景点/, book: '热门展可能要提前预约/买票', color: '#BE185D' },
    { id: 'sport', label: '运动', emo: '🏸', query: '羽毛球馆', minStay: 60, maxStay: 120, tag: /运动|体育|健身|球/, book: '场地一般要提前订', color: '#0F766E' },
    { id: 'food', label: '吃点东西', emo: '🍜', query: '美食', minStay: 45, maxStay: 75, tag: /美食|餐/, meal: true, color: '#DC2626' },
  ];
  function radiusFor(T) {
    if (T <= 75) return { m: 800, mode: 'walking', why: '1 小时左右 → 步行 800m 内' };
    if (T <= 150) return { m: 3000, mode: 'driving', why: '2 小时左右 → 打车 3km 内' };
    if (T <= 210) return { m: 6000, mode: 'driving', why: '3 小时左右 → 打车 6km 内' };
    return { m: 8000, mode: 'driving', why: '4 小时 → 一个片区（8km）' };
  }
  const mealTime = (s, e) => (s < 13.5 * 60 && e > 11 * 60) || (s < 20 * 60 && e > 17 * 60);
  function pickCats(T, s, e) {
    return CATS.filter(c => c.minStay <= T * 0.6 && (!c.meal || mealTime(s, e)) && (T >= 90 || !['museum', 'sport'].includes(c.id)));
  }
  /* cands: [{uid,name,lat,lng,rating,hours,cat}]；go(c)/back(c) 返回 {min}；direct: 当前→下一站分钟（没有下一站传 null） */
  // 类别对不对得上：有标签就看标签；名字命中黑名单（口袋公园、停车场…）直接不要
  function fits(c) {
    const cat = CATS.find(x => x.id === c.cat) || CATS[0];
    if (cat.bad && cat.bad.test(c.name || '')) return false;
    if (/停车|出入口|售票|卫生间|入口|东门|西门|南门|北门/.test(c.name || '')) return false;
    return !c.tag || cat.tag.test(c.tag);
  }
  function evaluate(cands, go, back, direct, o) {
    const T = o.end - o.start, out = [], rejected = { far: 0, short: 0, closed: 0 };
    cands.forEach(c => {
      const cat = CATS.find(x => x.id === c.cat) || CATS[0];
      const g = go(c), b = back(c); if (!g || !b) return;
      const travel = g.min + b.min, detour = direct == null ? travel : travel - direct;
      const stay = T - travel, arrive = o.start + g.min, leave = o.end - b.min;
      if (detour > T / 3) { rejected.far++; return; }
      if (stay < cat.minStay) { rejected.short++; return; }
      const open = PL.openDuring(c.hours, arrive, leave);
      if (open === false) { rejected.closed++; return; }
      const score = (c.rating || 4.0) * 10 + Math.min(stay, 120) / 6 - Math.max(0, detour) / 3;
      out.push(Object.assign({}, c, { catInfo: cat, go: g, back: b, travel, detour: Math.max(0, detour), stay, suggest: Math.min(stay, cat.maxStay || stay), arrive, leave, open, score: +score.toFixed(1) }));
    });
    return { list: out.sort((a, b) => b.score - a.score), rejected };
  }
  // 每类取最好的一个，出 2–3 个不同类别
  function choose(list, n = 3) {
    const seen = new Set(), pick = [];
    for (const c of list) { if (seen.has(c.cat)) continue; seen.add(c.cat); pick.push(c); if (pick.length >= n) break; }
    return pick;
  }
  return { CATS, radiusFor, pickCats, evaluate, choose, mealTime, fits };
});
