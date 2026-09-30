'use strict';
/* v2.4 近期热点：千帆 AI 搜索 · 百度搜索（/v2/ai_search/web_search）。
   免费额度 1500 次/月 → 每个方案最多 2 次搜索；同城市 + 同日期当天缓存（内存 + data/hot/*.json）；
   月度计数存 data/hot/usage.json，超过 HOT_MONTH_CAP（默认 300）就只用缓存。Key 只从环境变量读，不写日志。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DIR = path.join(__dirname, '..', 'data', 'hot');
const mem = new Map();
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const month = () => today().slice(0, 7);
function usage() { try { const u = JSON.parse(fs.readFileSync(path.join(DIR, 'usage.json'), 'utf8')); return u.month === month() ? u : { month: month(), calls: 0 }; } catch { return { month: month(), calls: 0 }; } }
function bump() { const u = usage(); u.calls++; fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, 'usage.json'), JSON.stringify(u)); return u; }
const CAP = () => +process.env.HOT_MONTH_CAP || 300;
function cacheGet(key) {
  const k = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  const m = mem.get(k); if (m && m.day === today()) return m;
  try { const d = JSON.parse(fs.readFileSync(path.join(DIR, k + '.json'), 'utf8')); if (d.day === today()) { mem.set(k, d); return d; } } catch {}
  return null;
}
function cacheSet(key, val) {
  const k = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16), d = Object.assign({ day: today(), key }, val);
  mem.set(k, d); try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, k + '.json'), JSON.stringify(d)); } catch {}
  return d;
}
/* 一次搜索：返回 { ok, refs:[{title,url,date,content}], ms, cached, reason } */
async function search(q, topK = 8) {
  const hit = cacheGet('q|' + q);
  if (hit) return { ok: true, refs: hit.refs, ms: 0, cached: true, q };
  const key = process.env.QIANFAN_API_KEY;
  if (!key) return { ok: false, reason: '未设置 QIANFAN_API_KEY', refs: [], q };
  if (usage().calls >= CAP()) return { ok: false, reason: `本月搜索已用 ${usage().calls} 次，达到应用上限 ${CAP()}（免费额度 1500/月），只用缓存`, refs: [], q };
  const t0 = Date.now();
  try {
    const r = await fetch('https://qianfan.baidubce.com/v2/ai_search/web_search', { method: 'POST', signal: AbortSignal.timeout(25000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ messages: [{ role: 'user', content: q }], search_source: 'baidu_search_v2', resource_type_filter: [{ type: 'web', top_k: topK }], search_recency_filter: 'month' }) });
    bump(); // 发出去就算一次（失败也可能计费）
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.code || j.error) return { ok: false, reason: `千帆搜索 HTTP ${r.status}${j.message ? '：' + String(j.message).slice(0, 100) : ''}`, refs: [], ms: Date.now() - t0, q, counted: true };
    const refs = (j.references || []).map(x => ({ title: String(x.title || '').slice(0, 80), url: String(x.url || ''), date: String(x.date || '').slice(0, 10), content: String(x.content || x.snippet || '').replace(/\s+/g, ' ').slice(0, 500), site: x.website || x.web_anchor || '' }))
      .filter(x => /^https?:\/\//.test(x.url));
    cacheSet('q|' + q, { refs });
    return { ok: true, refs, ms: Date.now() - t0, cached: false, q, counted: true };
  } catch (e) { return { ok: false, reason: '千帆搜索失败：' + (e.name === 'TimeoutError' ? '超时' : e.message), refs: [], ms: Date.now() - t0, q }; }
}
const md = d => `${+d.slice(5, 7)}月${+d.slice(8, 10)}日`;
/* 检索词：固定模板（模型不编检索词）。第 1 条：城市 + 日期 + 活动类型；第 2 条：用户明说的兴趣（如 网球）才加 */
function queries(city, dates, words) {
  const q = [`${city} ${md(dates[0])}${dates.length > 1 ? '至' + md(dates[dates.length - 1]) : ''} 展览 市集 演出 活动`];
  const w = (words || []).find(x => /网球|羽毛球|篮球|足球|跑/.test(x));
  if (w) q.push(`${city} ${w} 比赛 ${+dates[0].slice(5, 7)}月`);
  return q.slice(0, 2);
}
/* 代码校验：日期覆盖行程、原文有发布日期且在 60 天内、名字/场馆在原文里出现过 */
function checkEvents(raw, refs, dates) {
  const out = [], dropped = [], t = today();
  const days60 = new Date(Date.parse(t) - 60 * 864e5).toISOString().slice(0, 10);
  const iso = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : '';
  const seen = new Set();
  (raw || []).forEach(e => {
    const ref = refs[e.ref], name = String(e.name || '').trim().slice(0, 40), venue = String(e.venue || '').trim().slice(0, 30);
    const f = iso(e.date_from), to = iso(e.date_to) || f;
    const why = !ref ? '没有对应的原文' : !name ? '没有活动名' : !venue ? '没说在哪个场馆' : !f ? '原文里没有明确日期' : !ref.date ? '原文没有发布日期' : ref.date < days60 ? `原文发布于 ${ref.date}，太旧` :
      !dates.some(d => f <= d && to >= d) ? `日期 ${f.slice(5)}–${to.slice(5)} 不覆盖你那几天` : !grams(name, 3).concat(grams(venue, 3)).some(g => (ref.title + ref.content).includes(g)) ? '原文里找不到这个名字（可能是模型编的）' : seen.has(name) ? '重复' : '';
    if (why) { dropped.push({ name: name || '（无名）', why }); return; }
    seen.add(name);
    out.push({ id: 'e' + (out.length + 1), name, venue, date_from: f, date_to: to, kind: e.kind || 'other', ref: { title: ref.title, url: ref.url, date: ref.date, site: ref.site } });
  });
  return { events: out, dropped };
}
function grams(s, n) { const a = []; for (let i = 0; i + n <= s.length; i++) a.push(s.slice(i, i + n)); return a.length ? a : [s]; }
module.exports = { search, queries, checkEvents, usage, cacheGet, cacheSet, CAP, today };
