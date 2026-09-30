'use strict';
/* 大模型层（与厂商无关，OpenAI 兼容的 chat/completions 协议）。
   优先：百度千帆 · 文心 ERNIE（QIANFAN_API_KEY，https://qianfan.baidubce.com/v2，Bearer 鉴权）
   备选：OpenAI（OPENAI_API_KEY）。LLM_PROVIDER=qianfan|openai 可强制指定。Key 只从环境变量读取。
   结构化输出：千帆文档写明 json_schema 目前只对部分开源模型（DeepSeek/GLM/Qwen）开放，ERNIE 默认用 json_object，
   并把 JSON Schema 写进系统提示词，返回后在本地校验；OpenAI 用 json_schema strict。 */
function provider() {
  const force = (process.env.LLM_PROVIDER || '').toLowerCase();
  const qf = process.env.QIANFAN_API_KEY, oa = process.env.OPENAI_API_KEY;
  if ((force === 'qianfan' || !force) && qf) return { name: 'qianfan', label: '文心 ERNIE（千帆）', key: qf,
    base: (process.env.QIANFAN_BASE_URL || 'https://qianfan.baidubce.com/v2').replace(/\/$/, ''),
    model: process.env.QIANFAN_MODEL || 'ernie-4.5-turbo-128k', jsonMode: process.env.QIANFAN_JSON_MODE || 'json_object' };
  if ((force === 'openai' || !force || !qf) && oa) return { name: 'openai', label: 'OpenAI', key: oa,
    base: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini', jsonMode: 'json_schema' };
  return null;
}
const MODEL = () => { const p = provider(); return p ? p.model : (process.env.QIANFAN_MODEL || 'ernie-4.5-turbo-128k'); };
function enabled() { return !!provider() && process.env.MOCK !== '1'; }

const S = (props, extra = {}) => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props, ...extra });
const str = (d) => ({ type: 'string', description: d });
const KINDS = ['tennis', 'bar', 'food', 'cafe', 'gym', 'sight', 'museum', 'event', 'other'];

const PARSE_SCHEMA = S({
  city: str('城市'),
  start_date: str('YYYY-MM-DD'),
  end_date: str('YYYY-MM-DD'),
  summary: str('一句话概括任务'),
  clients: { type: 'array', items: S({
    id: str('A/B/C...'), name: str('客户A · 公司名'), address: str('可直接地理编码的完整地址，含城市'), place: str('写字楼/地标名'),
    date: str('YYYY-MM-DD'), start: str('HH:MM'), end: str('HH:MM'), duration_min: { type: 'integer' },
    time_is_assumed: { type: 'boolean', description: '用户没给具体时间时为 true' },
  }) },
  activities: { type: 'array', items: S({
    id: str('短 id'), kind: { type: 'string', enum: KINDS }, label: str('中文短标签'), query: str('用于百度地点检索的关键词，如 网球场 / 酒吧 / 中餐厅'),
    date: str('YYYY-MM-DD'), window_start: str('HH:MM 最早开始'), window_end: str('HH:MM 最晚结束'), duration_min: { type: 'integer' },
    near: { type: 'string', enum: ['hotel', 'client', 'midpoint', 'any'] }, max_radius_km: { type: 'number' },
    status: { type: 'string', enum: ['undecided', 'recommend', 'unknown'], description: 'undecided=用户说要做但没说在哪（可能已约好）；recommend=用户明确要你推荐（想/找个/推荐）' },
  }) },
  stops: { type: 'array', description: '用户点名了具体地点（和时间）的行程点；需要检索推荐的放 activities', items: S({
    id: str('短 id，如 s1'), name: str('用户说的地点名，照抄原话'), query: str('用于百度地点检索的规范地名（原话有明显语音同音字/口误时可纠正，否则同 name）'),
    kind: { type: 'string', enum: KINDS }, purpose: str('去做什么，如 打网球 / 看展 / 看比赛'),
    date: str('YYYY-MM-DD'), start: str('HH:MM 用户给的开始时间；没给填空串'), end: str('HH:MM 用户给的结束时间（「1点到2点」→14:00，「四五点」→开始16:00结束17:00）；没给填空串'), duration_min: { type: 'integer' },
    status: { type: 'string', enum: ['booked', 'named', 'unknown'], description: 'booked=说了时间且像是约好的；named=只点名了地方' },
    duration_is_assumed: { type: 'boolean', description: '用户没说时长、由你按常识假设时为 true' },
    back_to_hotel_after: { type: 'boolean', description: '用户说了这项之后回酒店时为 true' },
  }) },
  hotel: S({ status: { type: 'string', enum: ['booked', 'recommend', 'none', 'unknown'], description: 'booked=点名或说订好了；recommend=要你推荐或给了预算；none=不住酒店；其他 unknown' }, name: str('用户点名要住的酒店，照抄原话；没点名填空串'), budget_max: { type: 'number', description: '每晚预算，未知填 0' }, min_rating: { type: 'number' }, brands: { type: 'array', items: { type: 'string' } }, nights: { type: 'integer' } }),
  scenario_guess: S({ primary: { type: 'string', enum: ['business', 'fixed_trip', 'open_plan', 'carpool', 'free_time', 'general', 'unclear'], description: 'business=出差见客户；fixed_trip=已定好时间地点的行程；open_plan=空出几天要出主意；carpool=开车接送几个人；free_time=现在有一段空闲时间；看不出填 unclear' }, reason: str('一句话依据') }),
  time: S({ arrive_part: str('到达城市的时段，如 上午/下午/10:00；没说填空串'), free_budget_min: { type: 'integer', description: '用户说「有 X 小时空」时的分钟数，否则 0' } }),
  people: { type: 'array', description: '接送/同行的人（拼车场景），没有给空数组', items: S({ name: str('称呼'), role: { type: 'string', enum: ['driver', 'passenger', 'friend', 'unknown'] }, from: str('上车/出发地，没说填空串') }) },
  followups: { type: 'array', description: '缺信息时的按钮式追问，2-4 个', items: S({ id: str('id'), question: str('问题'), options: { type: 'array', items: { type: 'string' } } }) },
  assumptions: { type: 'array', items: { type: 'string' } },
});

const REPLAN_SCHEMA = S({
  intent: str('用户想改什么'),
  ops: { type: 'array', items: S({
    op: { type: 'string', enum: ['replace', 'add', 'remove', 'move'] },
    target_kind: { type: 'string', enum: [...KINDS, 'client', 'none'] }, target_name: str('被改的项名称，没有填空串'),
    new_kind: { type: 'string', enum: [...KINDS, 'none'] }, query: str('百度地点检索关键词'), label: str('新项标签'),
    window_start: str('HH:MM 或空'), window_end: str('HH:MM 或空'), duration_min: { type: 'integer' },
    near: { type: 'string', enum: ['hotel', 'client', 'midpoint', 'current', 'ask'], description: '不确定放哪里时填 ask' },
    needs: str('硬需求，如 包间，没有填空串'),
  }) },
  question: S({ text: str('需要追问时的问题，否则空串'), options: { type: 'array', items: { type: 'string' } } }),
  explanation: str('一句话说明，只描述改什么，不要编时间和距离'),
});

/* 本地校验：检查 required 字段与基本类型，缺数组补空数组；不合格返回错误说明。
   实测 ERNIE（json_object）偶尔把枚举字段填成空串（如 near:""）或把数字写成字符串：
   这类可安全修正的情况按 ENUM_DEFAULT 修正并记到 fixes（写进日志），其余仍判不合格、退回规则解析。 */
const ENUM_DEFAULT = { near: 'hotel', kind: 'other', target_kind: 'none', new_kind: 'none', status: 'unknown', primary: 'unclear', role: 'unknown' };
function validate(v, schema, path = '$', fixes = [], defs = ENUM_DEFAULT) {
  if (schema.type === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return `${path} 不是对象`;
    for (const k of schema.required || []) {
      const ps = schema.properties[k], t = ps.type;
      if (!(k in v) || v[k] === null) {
        if (t === 'array') v[k] = []; else if (t === 'string') v[k] = ''; else if (t === 'integer' || t === 'number') { v[k] = 0; fixes.push(`${path}.${k} 缺失→0`); } else if (t === 'boolean') { v[k] = false; fixes.push(`${path}.${k} 缺失→false`); } else if (t === 'object') { v[k] = {}; fixes.push(`${path}.${k} 缺失→{}`); } else return `${path}.${k} 缺失`;
      }
      if ((t === 'integer' || t === 'number') && typeof v[k] === 'string' && v[k].trim() !== '' && !isNaN(+v[k])) { v[k] = +v[k]; fixes.push(`${path}.${k} 字符串→数字`); }
      if (t === 'boolean' && (v[k] === 'true' || v[k] === 'false')) { v[k] = v[k] === 'true'; fixes.push(`${path}.${k} 字符串→布尔`); }
      if (t === 'string' && ps.enum && !ps.enum.includes(v[k]) && defs[k] && ps.enum.includes(defs[k])) { fixes.push(`${path}.${k} "${v[k]}"→${defs[k]}`); v[k] = defs[k]; }
      const e = validate(v[k], ps, `${path}.${k}`, fixes, defs); if (e) return e;
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(v)) return `${path} 不是数组`;
    for (let i = 0; i < v.length; i++) { const e = validate(v[i], schema.items, `${path}[${i}]`, fixes, defs); if (e) return e; }
  } else if (schema.type === 'number' || schema.type === 'integer') { if (typeof v !== 'number') return `${path} 不是数字`; }
  else if (schema.type === 'boolean') { if (typeof v !== 'boolean') return `${path} 不是布尔`; }
  else if (schema.type === 'string') { if (typeof v !== 'string') return `${path} 不是字符串`; if (schema.enum && !schema.enum.includes(v)) return `${path} 取值 ${v} 不在枚举内`; }
  return null;
}
function extractJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a > -1 && b > a) return JSON.parse(t.slice(a, b + 1)); throw new Error('返回内容不是 JSON'); }
}

/* v2.2：ERNIE 偶尔返回截断/非 JSON 或不合 schema 的内容 → 自动重试一次（HTTP 错误、超时不重试） */
async function structured(system, user, name, schema, defs = ENUM_DEFAULT) {
  const first = await structuredOnce(system, user, name, schema, defs);
  if (first.ok || !/不是 JSON|不符合 schema|空响应|Unexpected|JSON/.test(first.reason || '')) return first;
  const second = await structuredOnce(system, user, name, schema, defs);
  second.ms = (second.ms || 0) + (first.ms || 0);
  if (second.ok) { second.fixes = [`第一次${first.reason.replace(/^.*?：/, '')}，已自动重试`, ...(second.fixes || [])]; second.retried = true; }
  else second.reason = `${second.reason}（已重试 1 次）`;
  return second;
}
async function structuredOnce(system, user, name, schema, defs = ENUM_DEFAULT) {
  const p = provider();
  if (!p) return { ok: false, reason: '未设置 QIANFAN_API_KEY / OPENAI_API_KEY', ms: 0 };
  const t0 = Date.now();
  const post = async (mode) => {
    const sys = mode === 'json_schema' ? system
      : `${system}\n\n只输出一个 JSON 对象，不要 Markdown、不要解释。JSON 必须符合下面的 JSON Schema（所有 required 字段都要有；enum 字段只能取枚举里的值，不能是空串）：\n${JSON.stringify(schema)}`;
    const body = { model: p.model, temperature: 0.1, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      response_format: mode === 'json_schema' ? { type: 'json_schema', json_schema: { name, strict: true, schema } } : { type: 'json_object' } };
    const r = await fetch(p.base + '/chat/completions', { method: 'POST', signal: AbortSignal.timeout(60000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { r, j };
  };
  try {
    let mode = p.jsonMode, { r, j } = await post(mode);
    if (!r.ok && mode === 'json_schema' && p.name === 'qianfan') { mode = 'json_object'; ({ r, j } = await post(mode)); } // 该模型不支持 json_schema 时退回
    const err = j.error && (j.error.message || j.error.code);
    if (!r.ok || err) return { ok: false, reason: `${p.label} HTTP ${r.status}${err ? '：' + String(err).slice(0, 140) : ''}`, ms: Date.now() - t0 };
    const msg = j.choices && j.choices[0] && j.choices[0].message;
    if (!msg || msg.refusal || !msg.content) return { ok: false, reason: `${p.label} 拒答或空响应`, ms: Date.now() - t0 };
    const data = extractJson(msg.content);
    const fixes = [];
    const bad = validate(data, schema, '$', fixes, defs);
    if (bad) return { ok: false, reason: `${p.label} 输出不符合 schema：${bad}`, ms: Date.now() - t0 };
    return { ok: true, data, fixes, ms: Date.now() - t0, model: j.model || p.model, provider: p.label, jsonMode: mode, usage: j.usage };
  } catch (e) {
    return { ok: false, reason: `${p.label} 调用失败：` + (e.name === 'TimeoutError' ? '超时' : e.message), ms: Date.now() - t0 };
  }
}

function parseTask(text, today, hint) {
  const sys = `你是地图任务 Agent 的任务解析器。把用户的一句话出行任务拆成结构化 JSON，只做理解，不推荐具体地点、不编造距离时间。
今天是 ${today}（Asia/Shanghai）。"下周一" 指下一个自然周的周一。
规则：客户地址写成可地理编码的完整地址（含城市、区、路、门牌）；用户没给时间时给出合理默认（上午 09:30、下午 14:00，各 90 分钟）并把 time_is_assumed 设为 true；
客户 name 写成「客户A · 用户给的公司名」（用户说「A 公司」就写 A 公司）；多个客户分摊到各天；
活动时间窗 window_start=最早开始、window_end=最晚结束，要比时长宽至少 2 小时，几项活动的时间窗错开（默认 网球 16:00–21:30、酒吧 20:30–23:59、晚饭 18:30–21:30）；
活动（网球、酒吧等）每项只出现一次（用户没说「每天」就不要复制到别的天），默认排在第一天晚上（最后一天要返程），给出时间窗与时长，默认在酒店 2km 内；酒店预算没有填 0；
followups 必须给 2-4 个按钮式追问（每个 2-3 个选项），如果日期落在法定节假日（如国庆 10-01 至 10-08）第一个追问要问客户那天是否上班；
hotel.min_rating 用户没说时填 4.3；hotel.nights = 天数 - 1；assumptions 写出你做的默认假设。
clients 只放商务拜访的客户公司，没有就给空数组。用户点名了具体地点和时间（「X点去某某球场/美术馆/场馆」）的放进 stops（不要再放进 activities，也不要当成 clients）；
stops 按时间顺序，start 用用户给的时间（下午1点=13:00），「第二天」= start_date 后一天；时长没说时按常识假设（运动 120 分钟、看展 120 分钟、看比赛 180 分钟）并把 duration_is_assumed 设为 true、在 assumptions 写明、在 followups 里问；
用户说「打完回酒店 / 再回酒店」就把那一项的 back_to_hotel_after 设为 true；同一个场馆的不同叫法 query 写成同一个规范名；用户点名了酒店时写进 hotel.name（不用推荐酒店）。
用户给了时间段（「下午1点到2点」「四五点」「13–14点」）时 start/end 都要填，duration_min=结束-开始，duration_is_assumed=false；
用户说了要做某事但没说在哪（如「和朋友看个展」「晚上吃个饭」）放进 activities 且 status=undecided，不要替他选地点；说「想/找个/推荐」的 status=recommend；
拼车接送（「X开车接我和B去某地」）：people 里司机 role=driver、被接的人 role=passenger（用户自己写「我」），from 填原话里说的出发地/上车地（没说填空串，不要编）；目的地放进 stops，start 填「几点前到」的时间；不要放进 clients；
开放式安排（「多待两天给点建议」）：只填日期、hotel、已经定了的事，不要替用户编活动；
scenario_guess 判断整句话属于哪种场景，拿不准就填 unclear；不要编造原话里没有的活动。${hint ? `
用户已经明确选择了场景：${hint}，scenario_guess.primary 就填它。` : ''}`;
  return structured(sys, text, 'trip_task', PARSE_SCHEMA);
}
function replan(text, plan) {
  const sys = `你是地图任务 Agent 的变更解析器。用户要改当前日程，你只输出结构化修改指令（diff），不要计算时间、距离，也不要指定具体店名，由算法去检索和排时间。
「把 X 换成 Y」只输出一个 op=replace（target_kind=X 的类别，new_kind=Y 的类别），不要拆成 remove + add；window_start/window_end 按新活动的常识时段（晚饭 18:30–21:30），时间窗要比时长宽至少 1 小时。
不确定新地点放在哪里（酒店附近/客户附近/中间）时 near 填 ask 并在 question 里给按钮选项。`;
  return structured(sys, `当前日程：${JSON.stringify(plan).slice(0, 3000)}\n用户说：${text}`, 'plan_diff', REPLAN_SCHEMA, Object.assign({}, ENUM_DEFAULT, { near: 'ask' }));
}
/* 地点核对：用户说的名字（可能有语音同音字）在百度候选里对应哪一个。只在代码按名称匹配不确定时调用 */
const PICK_SCHEMA = S({ index: { type: 'integer', description: '候选序号，从 0 开始；都不对填 -1' },
  match: { type: 'string', enum: ['exact', 'alias', 'homophone', 'guess', 'none'] }, note: str('一句话理由，如 「家庭」与「嘉廷」同音') });
function pickPlace(said, kind, cands) {
  const sys = `你是地点核对器。用户口述了一个地点名，可能有语音识别造成的同音字/近音字错误。从百度地图候选里选出用户最可能指的那一个。
match：exact=名称基本一致；alias=同一地点的不同叫法；homophone=同音或近音字错误；guess=只是最接近、需要用户确认；none=都不对（index=-1）。不要编造候选以外的地点。`;
  const list = cands.map((c, i) => `${i}. ${c.name} | ${c.address || ''} | ${c.tag || ''}`).join('\n');
  return structured(sys, `用户说的：${said}（类别：${kind}）\n百度候选：\n${list}`, 'place_pick', PICK_SCHEMA, { match: 'guess' });
}
/* v2.4 场景 3：① 从搜索摘要里抽活动（抽取，不是创作）② 出 2–3 个主题（只出主题名和类别 id，不出店名） */
const EVENTS_SCHEMA = S({ events: { type: 'array', items: S({
  name: str('活动名，照抄原文'), venue: str('举办场馆名（能在地图上搜到的名字），原文没写填空串'),
  date_from: str('YYYY-MM-DD，原文写的开始日期；没写填空串'), date_to: str('YYYY-MM-DD，原文写的结束日期；单日活动同 date_from'),
  kind: { type: 'string', enum: ['exhibition', 'market', 'show', 'sport', 'other'] }, ref: { type: 'integer', description: '来自第几条摘要（从 0 开始）' } }) } });
function extractEvents(city, year, refs) {
  const sys = `你是信息抽取器。只从给定的网页摘要里抽取在${city}举办、写明了日期的活动（展览、市集、演出、赛事）。
规则：只抄原文，不补充、不推测；原文没写日期或没写场馆的活动也可以输出，但对应字段填空串；年份没写按 ${year}；最多 8 条；ref 填摘要编号。`;
  const list = refs.map((r, i) => `[${i}] 标题：${r.title}（发布于 ${r.date || '未知'}）\n${r.content}`).join('\n\n');
  return structured(sys, list, 'events', EVENTS_SCHEMA, { kind: 'other' });
}
const THEME_IDS = ['sport', 'walk', 'food', 'art', 'kids', 'night'];
const THEMES_SCHEMA = S({ themes: { type: 'array', items: S({
  title: str('主题名，≤ 12 个字，如「网球 + 看展的松弛一天」'), why: str('一句话依据，说明按用户哪条兴趣/哪个活动'),
  cats: { type: 'array', items: { type: 'string', enum: THEME_IDS } }, events: { type: 'array', items: { type: 'string' }, description: '用到的活动 id，没有给空数组' } }) } });
function themes(city, dates, interests, pace, events) {
  const sys = `你是出行助理，给用户想 2–3 个${city}的主题方案（每个方案 ${dates.length} 天）。只出主题名、依据、类别组合和用到的活动 id，不要出店名和地址（地点会由百度地图检索）。
类别只能从这里选（每个方案 2–4 个）：sport=运动 walk=City Walk food=美食咖啡 art=展览演出 kids=亲子 night=夜生活。
用户明说的兴趣必须有一个方案完整覆盖；节奏：${pace === 'full' ? '排满' : '松一点'}。活动只能用给出的 id，日期已经核对过。`;
  const user = `兴趣（用户说过的）：${interests.map(x => x.w).join('、') || '没说'}\n日期：${dates.join('、')}\n近期活动：\n${events.map(e => `${e.id} ${e.name} @${e.venue} ${e.date_from}~${e.date_to}`).join('\n') || '（没有）'}`;
  return structured(sys, user, 'themes', THEMES_SCHEMA, {});
}
async function ping() { // 供 check-keys 使用：最小调用
  return structured('Reply with JSON.', 'Say ok', 'ping', S({ ok: { type: 'boolean' } }));
}
module.exports = { enabled, parseTask, replan, pickPlace, extractEvents, themes, ping, MODEL, provider };
