/* v2.4 场景 3 开放式安排（纯函数，浏览器和 Node 共用）
   三层素材：① 画像（用户说过/确认过的兴趣）② 近期热点（千帆百度搜索，服务端）③ 分类菜单（下面的固定字典）
   护栏：主题 ≤ 3；每个主题的类别只能取字典里的（≤ 5）；百度检索词由字典给，模型不临场编；
   每个地点都要是百度结果（有 uid）；每个活动都要有原文链接和发布日期。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpenPlan = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // 固定分类菜单：id → 百度检索词（按兴趣挑一个）、类别、时长、时段
  const MENU = {
    sport: { label: '运动', emo: '🎾', subs: [
      { q: '网球场', kind: 'tennis', dur: 120, when: ['am', 'pm'], if: /网球/ },
      { q: '羽毛球馆', kind: 'gym', dur: 90, when: ['am', 'pm'], if: /羽毛球/ },
      { q: '体育公园', kind: 'sight', dur: 90, when: ['am', 'pm'] }] },
    walk: { label: 'City Walk', emo: '🚶', subs: [
      { q: '历史文化街区', kind: 'sight', dur: 90, when: ['am', 'pm'] },
      { q: '创意园区', kind: 'sight', dur: 90, when: ['pm', 'am'] }] },
    food: { label: '美食咖啡', emo: '🍜', subs: [
      { q: '本帮菜', kind: 'food', dur: 75, when: ['lunch', 'dinner'] },
      { q: '咖啡厅', kind: 'cafe', dur: 60, when: ['pm'] }] },
    art: { label: '展览演出', emo: '🖼', subs: [
      { q: '美术馆', kind: 'museum', dur: 120, when: ['am', 'pm'] },
      { q: '博物馆', kind: 'museum', dur: 120, when: ['am', 'pm'] }] },
    kids: { label: '亲子', emo: '🧸', subs: [
      { q: '科技馆', kind: 'sight', dur: 150, when: ['am', 'pm'] },
      { q: '亲子乐园', kind: 'sight', dur: 150, when: ['pm', 'am'] }] },
    night: { label: '夜生活', emo: '🌃', subs: [
      { q: '酒吧', kind: 'bar', dur: 90, when: ['night'] },
      { q: '观景台', kind: 'sight', dur: 60, when: ['night'] }] },
  };
  const IDS = Object.keys(MENU);
  // 原话/画像里的兴趣词 → 类别（只认明说的词，不推断性格）
  const INTEREST = [
    [/网球/, 'sport', '网球'], [/羽毛球/, 'sport', '羽毛球'], [/运动|健身|跑步|打球/, 'sport', '运动'],
    [/看展|展览|美术馆|博物馆/, 'art', '看展'], [/演出|话剧|音乐剧|livehouse|音乐会/i, 'art', '看演出'],
    [/city\s*walk|逛街|老洋房|街区|散步|压马路/i, 'walk', 'City Walk'],
    [/美食|好吃|吃吃|小吃|本帮菜|咖啡/, 'food', '美食咖啡'],
    [/亲子|孩子|娃|小朋友/, 'kids', '亲子'], [/酒吧|夜景|喝一杯|夜生活/, 'night', '夜生活'],
  ];
  function interestsOf(text) {
    const out = [];
    INTEREST.forEach(([re, cat, w]) => { if (re.test(text || '') && !out.some(x => x.w === w)) out.push({ w, cat }); });
    return out;
  }
  const catOfWord = w => { const hit = INTEREST.find(([re, , ww]) => ww === w || re.test(w)); return hit ? hit[1] : ''; };
  // 某类别按兴趣挑检索词（网球 → 网球场；没说 → 该类第一个默认词）
  function subsFor(cat, words) {
    const m = MENU[cat]; if (!m) return [];
    const said = m.subs.filter(s => s.if && words.some(w => s.if.test(w)));
    const plain = m.subs.filter(s => !s.if);
    if (cat === 'food') return m.subs; // 午饭 + 下午咖啡
    return said.length ? said : plain.slice(0, 1);
  }
  // 规则主题（模型失败或不够时用）：一定有一个覆盖用户兴趣的主题
  function ruleThemes(interests, events) {
    const cats = [...new Set(interests.map(x => x.cat))];
    const out = [];
    const nm = c => MENU[c].label;
    if (cats.length) out.push({ title: `${interests.slice(0, 2).map(x => x.w).join(' + ')}的一天`, why: `按你说过喜欢${interests.map(x => x.w).join('、')}来排`, cats: [...cats.slice(0, 3), ...(cats.includes('food') ? [] : ['food'])].slice(0, 4), events: [], rule: true });
    if (events.length) out.push({ title: '近期活动 + 周边逛逛', why: '把最近搜到、日期对得上的活动排进去', cats: ['art', 'walk', 'food'], events: events.slice(0, 2).map(e => e.id), rule: true });
    out.push({ title: '老街 City Walk + 咖啡', why: '分类菜单兜底：不累、随时能停', cats: ['walk', 'food'], events: [], rule: true });
    if (out.length < 3) out.push({ title: '看展 + 夜景', why: '分类菜单兜底', cats: ['art', 'food', 'night'], events: [], rule: true });
    return out.slice(0, 3).map(t => Object.assign(t, { cats: t.cats.filter(c => MENU[c]), label: t.cats.map(nm) }));
  }
  // 校验模型出的主题：类别只能是字典里的、≤ 5；活动 id 必须存在；≤ 3 个；缺用户兴趣就补一个规则主题
  function checkThemes(raw, interests, events) {
    const fixes = [], ev = new Set(events.map(e => e.id));
    let out = (raw || []).map(t => {
      const cats = [...new Set((t.cats || []).filter(c => { const ok = !!MENU[c]; if (!ok) fixes.push(`类别「${c}」不在菜单里，去掉`); return ok; }))].slice(0, 5);
      const evs = [...new Set(t.events || [])].filter(id => { const ok = ev.has(id); if (!ok) fixes.push(`活动 ${id} 不存在，去掉`); return ok; }); // 实测 ERNIE 给过 [e2, e2]
      return { title: String(t.title || '').slice(0, 18), why: String(t.why || '').slice(0, 60), cats, events: evs };
    }).filter(t => t.title && t.cats.length >= 1);
    if (out.length > 3) { fixes.push(`主题 ${out.length} 个 → 3 个`); out = out.slice(0, 3); }
    const want = [...new Set(interests.map(x => x.cat))];
    if (want.length && !out.some(t => want.every(c => t.cats.includes(c)) || want.filter(c => t.cats.includes(c)).length >= 2)) {
      const r = ruleThemes(interests, events)[0]; out = [r, ...out].slice(0, 3); fixes.push('没有覆盖你兴趣的主题 → 补一个规则主题');
    }
    if (out.length < 2) { const add = ruleThemes(interests, events).filter(r => !out.some(t => t.title === r.title)); out = [...out, ...add].slice(0, Math.max(2, out.length)); fixes.push('主题不够 2 个 → 用分类菜单补'); }
    return { themes: out.map(t => Object.assign(t, { label: t.cats.map(c => MENU[c].label) })), fixes };
  }
  // 候选过滤：去掉入口/停车场/公司之类；评分有的要 ≥ 4.0
  const BAD = /停车|售票|入口|出口|厕所|卫生间|公司|有限|办公|写字楼|服务中心|游客中心|培训|招生|工作室$|直营|批发|配送|外卖/;
  function goodCand(p) { return p && p.uid && p.lat && !BAD.test(p.name || '') && !(p.rating && p.rating < 4.0); }
  const km = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 95);
  // k-means（k = 天数），初始中心用最远点法；返回每个点的簇号和中心
  function cluster(pts, k) {
    if (!pts.length) return { labels: [], centers: [] };
    k = Math.max(1, Math.min(k, pts.length));
    // 初始中心：沿分布最长的方向取分位点（最远点法会被一个离群点带偏，实测复兴岛自己成了一天）
    const la = pts.map(p => p.lat), ln = pts.map(p => p.lng), byLat = (Math.max(...la) - Math.min(...la)) * 111 >= (Math.max(...ln) - Math.min(...ln)) * 95;
    const sorted = pts.slice().sort((a, b) => byLat ? a.lat - b.lat : a.lng - b.lng);
    const centers = Array.from({ length: k }, (_, i) => sorted[Math.min(sorted.length - 1, Math.floor((i + 0.5) / k * sorted.length))]);
    let C = centers.map(c => ({ lat: c.lat, lng: c.lng })), labels = [];
    for (let it = 0; it < 12; it++) {
      labels = pts.map(p => { let bi = 0; C.forEach((c, i) => { if (km(p, c) < km(p, C[bi])) bi = i; }); return bi; });
      C = C.map((c, i) => { const m = pts.filter((_, j) => labels[j] === i); return m.length ? { lat: m.reduce((a, p) => a + p.lat, 0) / m.length, lng: m.reduce((a, p) => a + p.lng, 0) / m.length } : c; });
    }
    return { labels, centers: C };
  }
  // 时段模板：松一点 = 每天 2–3 个点、中午留空；排满 = 4–5 个
  const SLOTS = {
    loose: [{ id: 'am', at: '10:00', to: '12:30' }, { id: 'lunch', at: '12:00', to: '14:00' }, { id: 'pm', at: '14:30', to: '18:00' }],
    full: [{ id: 'am', at: '09:30', to: '12:00' }, { id: 'lunch', at: '12:00', to: '13:30' }, { id: 'pm', at: '13:45', to: '16:00' }, { id: 'pm', at: '16:00', to: '18:00' }, { id: 'dinner', at: '18:00', to: '20:00' }],
  };
  /* 排天：cands = [{...百度地点, cat, sub, ev?}]；events 的场馆只放在日期覆盖的那天。
     每天一个区域（簇），按时段模板挑类别不同的点；本簇没有就借最近的（≤ 6km）。 */
  function arrange(cands, dates, theme, pace, openFn) {
    const k = dates.length, pts = cands.filter(goodCand), reg = pts.filter(p => !p.ev && !p.nearEv); // nearEv = 某个远处活动场馆周边补搜的点，只给那天用、不参与分区
    const cl = cluster(reg.length ? reg : pts, k), centers = cl.centers;
    const labels = pts.map(p => { if (p.nearEv) return -2; const j = (reg.length ? reg : pts).indexOf(p); if (j >= 0) return cl.labels[j]; let bi = 0; centers.forEach((c, i) => { if (km(p, c) < km(p, centers[bi])) bi = i; }); return bi; });
    const used = new Set();
    // 区域 ↔ 天 ↔ 活动 一起定：枚举「第 i 天用哪个区域」（k ≤ 5，最多 120 种），活动放到日期覆盖、离那天区域最近、没满的那天；
    // 选活动离所在区域总距离最小的一种。这样活动和当天其它点在同一片，不会上午长宁、下午杨浦。
    const hasNear = p => pts.some(q => q.nearEv === p.uid); // 已经在它周边补搜过：它就是「以活动为中心」那天，不参与区域分配
    const cap = pace === 'full' ? 2 : 1, evs = pts.filter(p => p.ev && !hasNear(p)).sort((a, b) => (b.rating || 4.2) - (a.rating || 4.2));
    const perms = (arr) => arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perms([...arr.slice(0, i), ...arr.slice(i + 1)]).map(r => [x, ...r]));
    let best = null;
    for (const perm of perms(centers.map((_, i) => i)).slice(0, 120)) {
      const cnt = dates.map(() => 0), asg = new Map(); let cost = 0;
      evs.forEach(p => {
        const ok = dates.map((d, i) => i).filter(i => p.ev.date_from <= dates[i] && p.ev.date_to >= dates[i] && cnt[i] < cap && centers[perm[i]] && km(p, centers[perm[i]]) <= 10)
          .sort((x, y) => km(p, centers[perm[x]]) - km(p, centers[perm[y]]));
        if (ok.length) { asg.set(p.uid, ok[0]); cnt[ok[0]]++; cost += km(p, centers[perm[ok[0]]]); } else cost += 25;
      });
      if (!best || cost < best.cost) best = { perm, asg, cost };
    }
    const perm = best ? best.perm : centers.map((_, i) => i), evDay = best ? best.asg : new Map(), far = [];
    const days = dates.map((d, i) => ({ date: d, center: centers[perm[i]] || centers[0], cluster: perm[i], picks: [] }));
    // 离所有区域都远的活动（实测「劳力士大师赛 @旗忠」）：找一天还没有活动的，让它「以活动为中心」——当天其它点围着活动场馆找
    // 最多一半的天（至少 1 天）可以「以活动为中心」；和主题对得上的活动优先（运动主题 → 赛事）
    const maxAnchor = Math.max(1, Math.floor(dates.length / 2)), pri = p => (theme.cats.includes('sport') && p.ev.kind === 'sport' ? 2 : 0) + (p.rating || 4.2) / 10;
    [...pts.filter(p => p.ev && hasNear(p)), ...evs.filter(p => !evDay.has(p.uid)).sort((a, b) => pri(b) - pri(a))].forEach(p => {
      const free = days.filter(d => d.anchor).length >= maxAnchor ? [] : days.map((d, i) => i).filter(i => p.ev.date_from <= days[i].date && p.ev.date_to >= days[i].date && ![...evDay.values()].includes(i) && !days[i].anchor);
      if (free.length) { const i = free[free.length - 1]; evDay.set(p.uid, i); Object.assign(days[i], { anchor: p.name, anchorUid: p.uid, anchorPt: { lat: p.lat, lng: p.lng }, center: { lat: p.lat, lng: p.lng }, cluster: -1 }); }
      else far.push({ name: p.ev.name, why: dates.some(d => p.ev.date_from <= d && p.ev.date_to >= d) ? '离其它点都超过 10km；最多一半的天围着远处的活动排，已经排了更对口的' : '日期对不上' });
    });
    const tmpl = SLOTS[pace === 'full' ? 'full' : 'loose'].map(s => Object.assign({}, s));
    if (theme.cats.includes('night')) { tmpl.push({ id: 'night', at: '20:00', to: '23:30' }); if (pace !== 'full') tmpl.shift(); else tmpl.splice(3, 1); } // 有夜生活：松一点晚点出门；排满去掉 16:00 那段（每天 ≤ 5 个）
    const catOrder = theme.cats.filter(c => c !== 'food' && c !== 'night');
    const hm = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(s); return m ? +m[1] * 60 + +m[2] : 0; };
    // 营业时间：从时段开始算，停留 + 路上 30′ 都要在营业内（openFn 不给就不查）
    const openOk = (p, slot) => !openFn || openFn(p, hm(slot.at), hm(slot.at) + (p.sub.dur || 60) + 30) !== false;
    const toHM = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    days.forEach((day, di) => {
      const evHere = pts.filter(p => p.ev && !used.has(p.uid) && evDay.get(p.uid) === di);
      let ci = di, busy = 0; // 每天轮换类别起点，两天不重样；busy = 上一个点结束（含路上 30′）
      tmpl.forEach(slot0 => {
        // 上一个点很长（实测旗忠大师赛 180′）：这段往后顺延，营业时间按顺延后的时间查（不然午饭排到人家午休）
        const slot = busy > hm(slot0.at) ? Object.assign({}, slot0, { at: toHM(busy) }) : slot0;
        if (hm(slot.at) >= hm(slot.to)) return;
        const fits = p => !used.has(p.uid) && p.sub.when.includes(slot.id === 'dinner' ? 'dinner' : slot.id) && openOk(p, slot);
        let pick = null;
        if ((slot.id === 'am' || slot.id === 'pm') && evHere.length) pick = evHere.find(p => !used.has(p.uid) && openOk(p, slot)) || null;
        if (!pick) {
          const rot = [...catOrder.slice(ci % Math.max(1, catOrder.length)), ...catOrder.slice(0, ci % Math.max(1, catOrder.length))];
          const usedToday = c => day.picks.filter(x => x.cat === c).length;
          const want = slot.id === 'lunch' || slot.id === 'dinner' ? ['food'] : slot.id === 'night' ? ['night'] : [...rot.slice().sort((a, b) => usedToday(a) - usedToday(b)), 'food']; // 当天没用过的类别优先，不连排三个美术馆
          for (const pass of ['home', 'near', 'far']) { // 先在本区域里找；没有再借近的（≤ 6km）；再没有借 12km 内最近的
            for (const c of want) {
              if (usedToday(c) >= (PER_DAY[c] || 2)) continue; // 一天最多：运动/亲子 1 个，其它 2 个（不连排三个网球场）
              const pool = pts.filter(p => p.cat === c && fits(p) && !p.ev && (!p.nearEv || p.nearEv === day.anchorUid) && (pass === 'home' ? labels[pts.indexOf(p)] === day.cluster : km(p, day.center) <= (pass === 'near' ? 6 : 12)));
              pick = pool.sort((a, b) => pass === 'far' ? km(a, day.center) - km(b, day.center) : score(b, day.center) - score(a, day.center))[0] || null;
              if (pick) { if (slot.id === 'am' || slot.id === 'pm') ci++; break; }
            }
            if (pick) break;
          }
        }
        if (pick) { busy = hm(slot.at) + (pick.sub.dur || 60) + 30; used.add(pick.uid); day.picks.push(Object.assign({}, pick, { slot: slot.id, at: slot.at, to: slot.to, borrowed: !pick.ev && !pick.nearEv && labels[pts.indexOf(pick)] !== day.cluster })); }
      });
    });
    days.far = far; // 没排进去的活动（界面上照样列出，写原因）
    return days;
  }
  const PER_DAY = { sport: 1, kids: 1, art: 2, walk: 2, food: 2, night: 1 };
  // 评分高、离当天区域中心近的优先（评分缺失按 4.2）
  const score = (p, c) => (p.rating || 4.2) - 0.08 * km(p, c) + (p.ev ? 1 : 0);
  return { MENU, IDS, INTEREST, interestsOf, catOfWord, subsFor, ruleThemes, checkThemes, goodCand, cluster, arrange, SLOTS, km };
});
