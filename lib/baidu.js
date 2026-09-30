'use strict';
/* 百度地图 Web 服务 API 调用（服务端 AK）。AK 只从环境变量读取，绝不写入日志或响应。 */
const crypto = require('crypto');
const HOST = 'https://api.map.baidu.com';
const cache = new Map();
const last = { status: null, message: '', at: null }; // 最近一次真实调用的状态（不含 URL/Key）

function ak() { return process.env.BAIDU_MAP_AK || ''; }
function enabled() { return !!ak() && process.env.MOCK !== '1'; }

// 可选：AK 设为「sn 校验」方式时，设置 BAIDU_MAP_SK 即自动签名（未实测，默认用 IP 白名单方式即可）
function signedQuery(path, params) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const sk = process.env.BAIDU_MAP_SK;
  if (!sk) return qs;
  const raw = `${path}?${qs}${sk}`;
  const sn = crypto.createHash('md5').update(encodeURIComponent(raw)).digest('hex');
  return `${qs}&sn=${sn}`;
}

/* 返回 { ok, data, status, message, ms, cached }；status != 0 视为失败，由调用方降级为示例数据 */
const RETRY = new Set([401, 402]); // 并发/QPS 超限：稍等重试（天配额 302 不重试）
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(path, params, opts = {}) {
  let r;
  for (let i = 0; i < 3; i++) {
    r = await call1(path, params, opts);
    if (!RETRY.has(r.status)) break;
    await sleep(400 * (i + 1));
  }
  return r;
}
async function call1(path, params, opts = {}) {
  const t0 = Date.now();
  const pub = new URLSearchParams(params).toString();
  const key = path + '?' + pub;
  if (!opts.fresh && cache.has(key)) return Object.assign({}, cache.get(key), { ms: 0, cached: true });
  const full = { ...params, output: 'json', ak: ak() };
  const url = `${HOST}${path}?${signedQuery(path, full)}`;
  let res;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { status: -1, message: `非 JSON 响应（HTTP ${r.status}）` }; }
    const status = data.status === undefined ? -1 : Number(data.status);
    res = { ok: status === 0, data, status, message: data.message || data.msg || '', ms: Date.now() - t0 };
  } catch (e) {
    res = { ok: false, data: null, status: -2, message: '网络错误：' + (e.name === 'TimeoutError' ? '超时' : e.message), ms: Date.now() - t0 };
  }
  Object.assign(last, { status: res.status, message: res.ok ? '' : reasonOf(res), at: Date.now() });
  if (res.ok) cache.set(key, res);
  return res;
}

const STATUS_HINT = {
  2: '参数错误', 101: 'AK 参数不存在', 102: '不通过白名单或者安全码不对（检查 AK 的 IP 白名单）',
  200: 'APP 不存在，AK 有误', 210: 'APP IP 校验失败（IP 白名单不含本机出口 IP）', 211: 'APP SN 校验失败',
  220: 'APP Referer 校验失败（误用了浏览器端 AK？服务端请用「服务端」类型 AK）', 240: 'APP 服务被禁用（到控制台为该 AK 勾选对应服务）',
  250: '用户不存在', 260: '服务不存在', 261: '服务被禁用', 301: '永久配额超限', 302: '天配额超限',
  401: '当前并发量已经超过约定并发配额', 402: '当前并发量已经超过约定并发配额，并且服务总并发量也已经超过设定的总并发配额',
};
function reasonOf(r) {
  const hint = STATUS_HINT[r.status], msg = String(r.message || '');
  let text = hint || msg;
  if (hint && msg && !hint.includes(msg)) text = `${msg}（${hint}）`;
  return `百度返回 status ${r.status}${text ? '：' + text : ''}`;
}

const num = v => (v === undefined || v === null || v === '' || isNaN(+v) ? null : +v);
function normPlace(p) {
  const d = p.detail_info || {};
  return {
    uid: p.uid, name: p.name, lat: p.location && p.location.lat, lng: p.location && p.location.lng,
    address: p.address || '', rating: num(d.overall_rating) || null, price: num(d.price) ? Math.round(num(d.price)) : null, // 百度评分 0 = 无评分；价格/人均取整
    hours: d.shop_hours || null, tag: d.tag || d.type || '', distance: num(d.distance), mock: false,
  };
}
function parsePath(str) { return String(str || '').split(';').filter(Boolean).map(s => s.split(',').map(Number)); }

module.exports = { call, enabled, reasonOf, normPlace, parsePath, last };
