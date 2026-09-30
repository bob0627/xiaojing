/* v2 统一任务模型（浏览器和 Node 共用，纯函数，不调接口、不用大模型）
   5 个栏目：锚点 anchors / 时间 time / 要找的东西 targets / 偏好 prefs / 缺口 gaps
   - 文心只负责把原话翻译进栏目（scenario_guess、stops、activities、hotel.status…）
   - 场景识别、缺口（该问什么、按什么顺序问）只由这里的代码决定
   见 hackathons/library/baidu-maps/agent-flow-v1.md 第 2、3、5、6 节 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./carpool.js'));
  else root.Slots = factory(root.Carpool);
})(typeof self !== 'undefined' ? self : this, function (CP) {
  'use strict';

  /* ---------- 场景模板表：加新场景 = 加一行 ---------- */
  const TEMPLATES = {
    business:   { no: 1, name: '出差见客户', anchors: '客户公司 + 酒店', required: ['dates', 'clients'], ask: ['dates', 'clients', 'venue', 'hotel_booked', 'hotel'], mode: 'client_hub', ready: true },
    fixed_trip: { no: 2, name: '定好时间的行程', anchors: '点名场馆 + 酒店', required: ['dates', 'venue', 'hotel_booked'], ask: ['dates', 'venue', 'hotel_booked', 'hotel'], mode: 'fixed_sequence', ready: true,
                  gap: { askMin: 60, restOk: 45, restTight: 20, arriveEarly: 10 } },
    open_plan:  { no: 3, name: '开放式安排', anchors: '酒店 / 出发点', required: ['dates'], ask: ['dates', 'hotel_booked', 'open'], mode: 'theme_cluster', ready: true },
    carpool:    { no: 4, name: '多人拼车接送', anchors: '司机家 + 上车点 + 目的地', required: ['dest', 'people'], ask: ['dates', 'carpool'], mode: 'pickup_chain', ready: true },
    free_time:  { no: 5, name: '碎片时间推荐', anchors: '当前位置 + 下一站', required: ['here', 'budget'], ask: ['frag'], mode: 'time_box', ready: true },
    general:    { no: 0, name: '通用', anchors: '任意', required: ['dates'], ask: ['dates', 'venue', 'hotel_booked'], mode: 'fixed_sequence', ready: true },
  };
  const CHOICES = [
    { id: 'business', label: '出差见客户，帮我排酒店和路线' },
    { id: 'fixed_trip', label: '我已经定好几个安排，帮我算时间' },
    { id: 'open_plan', label: '空出来几天，帮我出主意' },
    { id: 'carpool', label: '开车接送几个人' },
    { id: 'free_time', label: '现在有空，附近干点啥' },
  ];
  const STATUS_LABEL = { booked: '已订', named: '点名', undecided: '没定', recommend: '要推荐', unknown: '待问', none: '不需要' };

  /* ---------- 原话里的硬信号（代码判，不交给模型） ---------- */
  const CN = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5 };
  const cnNum = s => /^\d+$/.test(s) ? +s : s === '十' ? 10 : s.length === 2 && s[0] === '十' ? 10 + CN[s[1]] : s.length === 2 && s[1] === '十' ? CN[s[0]] * 10 : CN[s] ?? NaN;
  function clientCount(text) {
    const m = String(text).match(/(\d+|[一两二三四五六])\s*(个|家|位)\s*(客户|公司)/);
    return m ? Math.min(6, cnNum(m[1]) || 0) : 0;
  }
  const saidDates = text => /\d{1,2}\s*月\s*\d{1,2}|\d{1,2}\s*[\/.]\s*\d{1,2}|\d{4}-\d{1,2}-\d{1,2}|[下本这]周[一二三四五六日天末]?|周[一二三四五六日天]|星期|礼拜|明天|后天|今天|今晚|现在|月底|月初|国庆|五一|元旦|端午|中秋|周末|\d{1,2}\s*[号日]/.test(text);
  const saidHotelPrefs = text => /预算|\d{3,5}\s*(元|块)|\d{3,5}\s*(以内|以下|左右)|品牌|全季|亚朵|汉庭|如家|桔子|希尔顿|万豪|洲际|凯悦|锦江|维也纳|近地铁|地铁.{0,4}(近|旁|边)|星级|经济型|快捷酒店/.test(text);
  const wantHotelRec = text => /(推荐|帮我找|找个|找一?家|订个|安排)[^，。]{0,6}(酒店|住的|住处)|酒店.{0,4}(推荐|帮我找)/.test(text) || saidHotelPrefs(text);
  const noHotel = text => /不住酒店|住朋友家|住家里|住我家|当天(来回|往返|回去)|不用住/.test(text);
  const hotelBookedWords = text => /酒店.{0,4}(订好|已订|订了)|订好.{0,6}酒店|住在?[\u4e00-\u9fa5A-Za-z0-9·]{2,20}(酒店|宾馆|饭店)/.test(text);
  // 「想打网球、去个酒吧」「帮我找个餐厅」：用户明确要推荐 → 不问「定了没」
  const wantRec = (text, kindWord) => new RegExp(`(想|去个|找个|找一?家|推荐|帮我找|随便)[^，。；]{0,6}(${kindWord})`).test(text);
  const KIND_WORD = { tennis: '网球|打球|球场', bar: '酒吧|清吧|喝一杯', food: '吃饭|晚饭|晚餐|午饭|餐厅|饭', cafe: '咖啡', gym: '健身', sight: '逛|景点|走走', museum: '展|美术馆|博物馆', event: '比赛|演出|看球', other: '[\\u4e00-\\u9fa5]' };
  // 用户给了起止时间或时长：「1点到2点」「13-14点」「四五点」「打1小时」
  const RANGE_RE = /(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:[点:：]\s*(?:\d{2}|半)?)?\s*(?:到|至|-|–|—|~)\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:[点:：]|$)|[一二三四五六七八九十]{2}点/;
  const DUR_RE = /\d+(\.\d+)?\s*(个)?(小时|钟头|分钟)|[一两二三四半]\s*(个)?(半)?(小时|钟头)/;
  const saidTimes = text => RANGE_RE.test(text) || DUR_RE.test(text);
  function freeBudget(text) {
    const m = String(text).match(/(?:有|空出?|剩|还有)\s*(\d+(?:\.\d+)?|[一两二三四五六半])\s*(个)?(半)?\s*(小时|钟头)/);
    if (!m) return 0;
    return Math.round(((cnNum(m[1]) || 0) + (m[3] ? 0.5 : 0)) * 60);
  }
  const carpoolWords = text => /开车(去|来)?接|开车带|顺路(带|接)|拼车|送回去|反过来送|接上|先接|再接|去接/.test(text);
  const openWords = text => /多待|给点建议|出主意|随便逛|玩玩|逛逛|怎么玩|去哪玩|有什么好玩|推荐.{0,4}(去处|地方|行程)|空出来?[\d一两三四五几]\s*天|[\d一两三四五几]\s*天.{0,4}(玩|逛|转转)/.test(text);

  /* ---------- 场景识别：模型先猜，代码用硬信号确认；都没信号 → 问一道选择题 ---------- */
  function identify(task, text, hint) {
    const clients = task.clients || [], stops = task.stops || [], acts = task.activities || [];
    const dates = datesOf(task);
    const sig = [];
    if (clients.length || clientCount(text) || /客户|拜访/.test(text)) sig.push('business');
    if (stops.some(x => x.start)) sig.push('fixed_trip');
    if ((task.people || []).some(p => p.role === 'driver') || carpoolWords(text)) sig.unshift('carpool'); // 「开车接人」是最强信号（目的地常带「12点前到」，别被当成固定行程）
    const fb = (task.time && task.time.free_budget_min) || freeBudget(text);
    const freeWord = /(点|点半)(以后|之后)有空|现在有空|这会儿?有空|有空闲|空出来?\s*(\d|[一两三四半])\s*个?\s*(半)?\s*小时/.test(text);
    const timedVisit = stops.filter(x => x.start).length >= 2 || clients.length;
    // 明说「2个小时空」「有空」：即使模型给地点都填了时间，也按碎片时间（M2 那类行程句里没有这种说法）
    const strongFree = /(\d|[一两二三四五六半])\s*个?\s*(半)?\s*(小时|钟头)\s*(的)?\s*(空|空闲|空档)|有空|空闲/.test(text);
    if ((fb > 0 && fb <= 360 || freeWord) && (!timedVisit || (strongFree && !clients.length)) && datesOf(task).length <= 1 + (saidDates(text) ? 0 : 1)) {
      // 「现在有2小时空，5点要到X」：只有一个定时点、又明说了空闲 → 碎片时间优先于固定行程
      const fi = sig.indexOf('fixed_trip'); if (fi >= 0) sig.splice(fi, 1, 'free_time', 'fixed_trip'); else sig.push('free_time');
    }
    if (openWords(text) && !stops.some(x => x.start)) sig.push('open_plan');
    const guess = (task.scenario_guess && task.scenario_guess.primary) || '';
    let primary, source;
    if (hint && TEMPLATES[hint]) { primary = hint; source = 'user'; }
    else if (sig.length) { primary = sig[0]; source = guess === sig[0] ? 'both' : 'code'; }
    // 模型猜了但原话里没有对应的硬信号 → 不采信（例：「晚上和朋友吃个饭」模型猜 free_time）；有东西可排就走通用流程
    else if (stops.length || acts.length) { primary = 'general'; source = TEMPLATES[guess] && guess !== 'general' ? 'model_rejected' : 'code'; }
    else return { primary: '', unclear: true, signals: sig, guess, source: 'none', segments: [], reason: '原话里看不出是哪种安排' };
    const extra = sig.filter(s => s !== primary);
    // 混合：按天拆（例：周一二见客户，周三四多待两天玩 → 两段，共享酒店）
    let segments = [{ scenario: primary, dates }];
    if (primary === 'business' && extra.includes('open_plan')) {
      const busy = new Set(clients.map(c => c.date).filter(Boolean));
      const rest = dates.filter(d => !busy.has(d));
      if (busy.size && rest.length) segments = [{ scenario: 'business', dates: dates.filter(d => busy.has(d)) }, { scenario: 'open_plan', dates: rest }];
    }
    return { primary, extra, segments, signals: sig, guess, source, unclear: false,
      reason: source === 'user' ? '你选的' : source === 'model_rejected' ? `模型猜「${TEMPLATES[guess].name}」但原话里没有对应信号，按通用流程` : sig.length ? `原话信号：${sig.map(s => TEMPLATES[s].name).join('、')}` : '有具体要做的事，按通用流程' };
  }
  function datesOf(task) {
    const a = task.start_date, b = task.end_date || a; if (!a) return [];
    const out = []; const d = new Date(a + 'T12:00:00'), e = new Date(b + 'T12:00:00');
    while (d <= e && out.length < 7) { out.push(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); }
    return out;
  }

  /* ---------- 规范化状态（模型说了不算的地方由代码判） ---------- */
  function normalize(task, text) {
    const post = [];
    task.hotel = task.hotel || {};
    const h = task.hotel;
    // 酒店状态：点名了 → 已订；原话要推荐/给了预算 → 要推荐；不住 → none；其它一律「待问」（永远问一句订好了吗）
    const hs = h.name ? 'booked' : noHotel(text) ? 'none' : wantHotelRec(text) ? 'recommend' : hotelBookedWords(text) ? 'booked_unnamed' : 'unknown';
    if (h.status !== hs) { if (h.status) post.push(`酒店状态 ${h.status || '空'}→${hs}`); h.status = hs; }
    (task.stops || []).forEach(x => {
      // 时长：原话给了起止/时长才算用户给的，模型的 duration_is_assumed 不作数
      const s = toMin(x.start), e = toMin(x.end);
      if (x.start && x.end && e > s && saidTimes(text)) { x.duration_min = e - s; x.duration_is_assumed = false; x.duration_from = 'user'; }
      else x.duration_from = x.duration_is_assumed === false && saidTimes(text) ? 'user' : 'default';
      x.status = x.status && x.status !== 'unknown' ? x.status : (x.start ? 'booked' : 'named');
    });
    (task.activities || []).forEach(a => {
      const rec = wantRec(text, KIND_WORD[a.kind] || KIND_WORD.other);
      const st = rec ? 'recommend' : (a.status === 'recommend' ? 'recommend' : 'undecided');
      if (a.status !== st) { a.status = st; }
    });
    return post;
  }
  const toMin = hm => { const m = /^(\d{1,2}):(\d{2})$/.exec(hm || ''); return m ? +m[1] * 60 + +m[2] : NaN; };

  /* ---------- 缺口：按模板顺序，说过的跳过（只由代码算） ---------- */
  function clientLocated(c, text) {
    const addr = String(c.address || '').replace(/^(上海|北京|深圳|广州|杭州|南京|成都)市?/, '');
    return [c.place, addr].some(x => x && x.length >= 3 && text.includes(x));
  }
  function computeGaps(task, text, scen) {
    if (scen.unclear) return [{ type: 'scenario', label: '想让我帮你做哪种？', why: '一句话里看不出是哪种安排，选一个我就按那套流程问' }];
    const T = TEMPLATES[scen.primary] || TEMPLATES.general, gaps = [];
    const order = [...new Set([...T.ask, ...scen.segments.flatMap(s => (TEMPLATES[s.scenario] || {}).ask || [])])];
    for (const g of order) {
      if (g === 'dates' && !saidDates(text) && scen.primary !== 'free_time') gaps.push({ type: 'dates', label: '哪几天去？', why: '营业时间、节假日、公交时刻都看日期' });
      if (g === 'clients' && scen.primary === 'business') {
        const n = Math.max(clientCount(text), (task.clients || []).length) || (scen.source === 'user' ? 1 : 0); // 用户自己选了「出差见客户」但没说几个 → 至少问 1 个
        const located = (task.clients || []).filter(c => clientLocated(c, text));
        if (n && located.length < n) gaps.push({ type: 'clients', count: n, located: located.length, label: `${n} 个客户分别在哪？`, why: '酒店要围着客户选，先告诉我客户在哪' });
      }
      if (g === 'venue') {
        const items = [...(task.activities || []).filter(a => a.status === 'undecided').map(a => ({ id: a.id, from: 'activity', label: a.label || a.kind, kind: a.kind })),
          ...(task.stops || []).filter(x => x.status === 'undecided' && !x.name).map(x => ({ id: x.id, from: 'stop', label: x.purpose || x.kind, kind: x.kind }))];
        if (items.length) gaps.push({ type: 'venue', items, label: items.length > 1 ? '这几件事地方定好了吗？' : `${items[0].label}定好地方了吗？`, why: '说了要做但没说在哪，多半已经约好了；没定我再帮你找' });
      }
      if (g === 'hotel_booked' && ['unknown', 'booked_unnamed'].includes(task.hotel.status)) gaps.push({ type: 'hotel_booked', label: task.hotel.status === 'booked_unnamed' ? '订的是哪家酒店？' : '酒店订好了吗？', why: '订了就把它当每天的起点终点；没订等地点都定了再按位置推荐' });
      if (g === 'carpool') { // 场景 4：原话抽 + 模型 people 补；上车点都要用百度核对
        const c = CP.fromText(text), ppl = task.people || [];
        const drv = ppl.find(p => p.role === 'driver');
        if (!c.driver && drv) c.driver = drv.name; if (!c.driverFrom && drv && drv.from && !/家$/.test(drv.from)) c.driverFrom = drv.from;
        ppl.filter(p => p.role !== 'driver' && p.name).forEach(p => { const x = c.riders.find(r => r.name === p.name); if (x) { if (!x.at && p.from && !/^(他|她|我)?家$/.test(p.from)) x.at = p.from; } else if (c.riders.length < 5 && p.name !== c.driver) c.riders.push({ name: p.name, at: /^(他|她|我)?家$/.test(p.from || '') ? '' : (p.from || '') }); });
        const dest = (task.stops || []).find(x => x.start) || (task.stops || [])[0];
        if (!c.dest && dest) c.dest = dest.name; if (!c.deadline && dest && dest.start) c.deadline = dest.start;
        gaps.push(Object.assign({ type: 'carpool', label: '谁开车、在哪接人、几点到？', why: '每个上车点都用百度核对；从到达时间倒推每人几点下楼' }, c));
      }
      if (g === 'frag') {
        const nmPre = String(text).match(/(?:到|去|赶到|回)\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,14}?)(?:[，,。]|$|开会|见|看|吃)/);
        const timed = (task.stops || []).filter(x => x.start);
        // 下一站 = 原话「X点要到Y」的 Y；否则最后一个定时点
        const nxt = timed.find(x => nmPre && (x.name.includes(nmPre[1]) || nmPre[1].includes(x.name))) || timed[timed.length - 1];
        const here = (task.stops || []).find(x => x !== nxt && (!x.start || timed.length > 1));
        // 规则兜底：「在徐家汇附近」「现在在静安寺」「5点要到浦东美术馆」
        const hm = String(text).match(/在\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,14}?)(?:附近|这边|旁边|周边|一带|[，,。]|$)/);
        const nm = String(text).match(/(\d{1,2}|[一两二三四五六七八九十]{1,2})\s*点(半)?\s*(?:要|得|必须)?\s*(?:到|去|赶到|回)\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,14}?)(?:[，,。]|$|开会|见|看|吃)/);
        let nAt = nxt ? nxt.start : '';
        if (!nAt && nm) { let h = cnNum(nm[1]) || 0; if (h < 8) h += 12; nAt = `${String(h).padStart(2, '0')}:${nm[2] ? '30' : '00'}`; }
        gaps.push({ type: 'frag', label: '你在哪、空多久？', why: '按空闲时长定搜索半径；路上（或绕路）最多占 1/3', here: (() => { const said = hm ? hm[1].replace(/^(现在|我|在)+/, '') : ''; const nn = nxt ? nxt.name : nm ? nm[3] : ''; // 原话「在X」优先；不能和下一站是同一个
          if (said && !(nn && (nn.includes(said) || said.includes(nn)))) return said; return here ? here.name : ''; })(), next: nxt ? nxt.name : nm ? nm[3] : '', nextAt: nAt,
          budget: (task.time && task.time.free_budget_min) || freeBudget(text), startAt: fragStart(text),
          startVague: !/(\d{1,2}|[一两二三四五六七八九十]{1,2})\s*点(半)?\s*(?:以后|之后|开始|起|到)/.test(text) });
      }
      if (g === 'open' && scen.primary === 'open_plan') gaps.push({ type: 'open', label: '你喜欢什么、想排满还是松一点？', why: '按你说过的兴趣 + 近期活动（网页搜索）+ 分类菜单，给 2–3 个方向让你挑' }); // 场景 3
      if (g === 'hotel' && task.hotel.status === 'recommend' && !saidHotelPrefs(text)) gaps.push({ type: 'hotel', label: '酒店有什么要求？', why: '可跳过，按默认（评分 4.3 以上）' });
    }
    return gaps;
  }

  /* ---------- 5 栏视图（给界面和日志看；缺口也放进来） ---------- */
  function toSlots(task, gaps) {
    const cg0 = gaps.find(g => g.type === 'carpool') || (task.followups || []).find(g => g.type === 'carpool');
    if (cg0 || (task.scenario && task.scenario.primary === 'carpool')) {
      const c = cg0 || { riders: [] };
      const anchors = [{ role: '司机', said: `${c.driver || '?'}${c.driverFrom ? ' 从' + c.driverFrom : ''}`, status: c.driverFrom ? 'named' : 'unknown' },
        ...c.riders.map(r => ({ role: '接', said: `${r.name}${r.at ? ' @' + r.at : ''}`, status: r.at ? 'named' : 'unknown' })),
        { role: '目的地', said: c.dest || '', time: c.deadline ? c.deadline + ' 前到' : '', status: c.dest ? 'named' : 'unknown' }];
      return { anchors, time: { dates: datesOf(task), arrive: '', free_budget_min: 0 }, targets: [], prefs: ['到达留 10′', '路况 +15%', '每站等 3′', c.back ? '回程反向送' : ''].filter(Boolean), gaps: gaps.map(g => g.type) };
    }
    if (task.scenario && task.scenario.primary === 'open_plan') { // 场景 3：锚点 = 酒店/出发点；要找的 = 选定主题的类别（选之前是「待选」）
      const h = task.hotel || {}, op = task.openPlan || {};
      return { anchors: [{ role: '酒店', said: h.name || '', status: h.status === 'booked_unnamed' ? 'unknown' : h.status }], time: { dates: datesOf(task), arrive: '', free_budget_min: 0 },
        targets: op.theme ? [{ kind: 'mix', said: op.theme, status: 'recommend' }] : [{ kind: 'mix', said: '主题方案（兴趣 + 近期活动 + 分类菜单）', status: 'unknown' }],
        prefs: [op.pace === 'full' ? '排满 · 每天 4–5 个点' : '松一点 · 每天 2–3 个点', ...(op.words || [])].filter(Boolean), gaps: gaps.map(g => g.type) };
    }
    const fg = gaps.find(g => g.type === 'frag');
    if (fg || (task.scenario && task.scenario.primary === 'free_time')) { // 场景5：锚点 = 你在哪 + 之后去哪（或回原地），没有酒店
      const f = fg || {};
      const anchors = [{ role: '当前位置', said: f.here || '', status: f.here ? 'named' : 'unknown' }, { role: '之后去', said: f.next || '回原地', time: f.next && f.nextAt ? f.nextAt + ' 要到' : '', status: f.next ? 'named' : 'none' }];
      return { anchors, time: { dates: datesOf(task), arrive: f.startAt || (task.time && task.time.arrive_part) || '', free_budget_min: f.budget || (task.time && task.time.free_budget_min) || 0 }, targets: [{ kind: 'mix', said: '咖啡/书店/公园/看展/运动（按时长挑）', status: 'recommend' }], prefs: ['路上 ≤ 1/3', '营业时间盖住停留'], gaps: gaps.map(g => g.type) };
    }
    const anchors = [
      ...(task.clients || []).map(c => ({ role: '客户', said: c.place || c.name, status: c.pending ? 'unknown' : 'named' })),
      ...(task.stops || []).map(x => ({ role: '地点', said: x.name, status: x.status, time: x.start ? `${x.start}${x.end ? '–' + x.end : ''}` : '', dur: x.duration_from })),
      { role: '酒店', said: task.hotel.name || '', status: task.hotel.status === 'booked_unnamed' ? 'unknown' : task.hotel.status },
    ];
    const targets = (task.activities || []).map(a => ({ kind: a.kind, said: a.label, status: a.status }));
    const prefs = [task.hotel.budget_max ? `≤ ¥${task.hotel.budget_max}` : '', task.hotel.near_metro ? '近地铁' : '', ...(task.hotel.brands || [])].filter(Boolean);
    return { anchors, time: { dates: datesOf(task), arrive: task.time && task.time.arrive_part || '', free_budget_min: task.time && task.time.free_budget_min || 0 }, targets, prefs, gaps: gaps.map(g => g.type) };
  }

  /* ---------- 入口：规范化 → 识别 → 缺口 → 追问（typed followups） ---------- */
  const TYPED = ['scenario', 'dates', 'clients', 'venue', 'hotel_booked', 'hotel', 'frag', 'carpool', 'open'];
  // 碎片时间从几点开始：原话说「现在」→ 空串（前端用当前时间）；「下午/晚上/上午」→ 该时段常见起点；「3点」→ 15:00
  function fragStart(text) {
    const m = String(text).match(/(上午|中午|下午|晚上)?\s*(\d{1,2}|[一两二三四五六七八九十]{1,2})\s*点(半)?\s*(?:以后|之后|开始|起|到)/);
    if (m) { let h = cnNum(m[2]) || 0; if ((m[1] === '下午' || m[1] === '晚上') && h < 12) h += 12; else if (!m[1] && h < 8) h += 12; return `${String(h).padStart(2, '0')}:${m[3] ? '30' : '00'}`; }
    if (/现在|马上|这会|眼下/.test(text)) return '';
    if (/下午/.test(text)) return '14:00'; if (/晚上/.test(text)) return '19:00'; if (/上午/.test(text)) return '09:30'; if (/中午/.test(text)) return '12:00';
    return '';
  }
  function plan(task, text, hint) {
    const post = normalize(task, text);
    if (task.hotel && /地铁/.test(text)) task.hotel.near_metro = true;
    const scen = identify(task, text, hint);
    task.scenario = scen;
    // 场景 3：原话里的「打网球 / 看展」是兴趣，不是已经定了的事 → 并进画像，由主题方案来排（避免同一件事排两遍）
    if (scen.primary === 'open_plan' && (task.activities || []).length) { post.push(`开放式：「${task.activities.map(a => a.label).join('、')}」当兴趣，不单独排`); task.openInterests = task.activities.map(a => a.label); task.activities = []; task.assumptions = (task.assumptions || []).filter(x => !/默认(安排|时长)|具体时间/.test(x)); }
    const gaps = computeGaps(task, text, scen);
    // 客户位置没给：先放 N 个占位客户（前端填名字/地址，用百度核对）
    const cg = gaps.find(g => g.type === 'clients');
    if (cg) {
      const located = (task.clients || []).filter(c => clientLocated(c, text));
      task.clients = Array.from({ length: cg.count }, (_, i) => located[i] ? Object.assign({}, located[i], { id: String.fromCharCode(65 + i) })
        : { id: String.fromCharCode(65 + i), name: `客户${i + 1}`, place: '', address: '', pending: true, date: task.start_date, start: '', end: '', duration_min: 90, time_is_assumed: true });
    }
    if (gaps.some(g => g.type === 'dates')) task.dates_pending = true;
    // 模型自己出的追问：和代码缺口重复的去掉，剩下的放后面（按钮式，可不答）
    const has = t => gaps.some(g => g.type === t);
    let rest = (task.followups || []).filter(f => !TYPED.includes(f.type) && !TYPED.includes(f.id));
    if (has('dates') || has('scenario')) rest = rest.filter(f => !/日期|哪天|哪几天|几号|几月|日程|安排是|国庆|假期|节假|上班|工作日/.test(f.question || ''));
    if (has('clients')) rest = rest.filter(f => !/客户|公司|地址|在哪|哪家|位置/.test(f.question || ''));
    if (has('hotel_booked') || has('hotel')) rest = rest.filter(f => !/酒店|预算|品牌|价位|住宿|房价|会员|住哪/.test(f.question || ''));
    if (has('venue')) rest = rest.filter(f => !/定好|在哪|哪个馆|哪家店|地点/.test(f.question || ''));
    // 用户给了时长/起止时间的项目，不再问「时长多久」（模型常问）
    const assumed = (task.stops || []).filter(x => x.duration_from !== 'user');
    if (!assumed.length) rest = rest.filter(f => !/时长|多久|几个?小时|分钟/.test(f.question || ''));
    else rest = rest.filter(f => !/时长|多久|几个?小时|分钟/.test(f.question || '') || assumed.some(x => (f.question || '').includes(x.purpose || '@@') || (f.question || '').includes(x.name || '@@') || f.id === 'dur-' + x.id));
    if (has('scenario') || has('frag') || has('carpool') || has('open')) rest = []; // 这几种场景的问题都在卡片里问完
    task.followups = [...gaps.map(g => Object.assign({ id: g.type, question: g.label, options: ['回答'] }, g)), ...rest].slice(0, 6);
    task.slots = toSlots(task, gaps);
    if (gaps.length) post.push('追问顺序：' + gaps.map(g => ({ scenario: '场景', dates: '日期', clients: '客户位置', venue: '定了没', hotel_booked: '酒店订了吗', hotel: '酒店偏好', frag: '在哪/空多久', carpool: '接谁/在哪/几点到', open: '兴趣/节奏/方案' })[g.type]).join(' → '));
    post.unshift(scen.unclear ? '场景不清楚 → 问一道选择题' : `场景：${TEMPLATES[scen.primary].name}（${scen.reason}）${scen.segments.length > 1 ? ' · 按天拆成 ' + scen.segments.map(s => TEMPLATES[s.scenario].name).join(' + ') : ''}`);
    return post;
  }

  return { TEMPLATES, CHOICES, STATUS_LABEL, identify, normalize, computeGaps, toSlots, plan, clientCount, saidDates, saidHotelPrefs, saidTimes, freeBudget, datesOf, fragStart };
});
