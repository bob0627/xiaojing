'use strict';
/* 点名地点核对（纯函数，无网络）：百度地点检索结果 → 合并子点（北门/停车场/大堂/洗手间…）→ 按名称相似度排序。
   用户口述的名字可能有同音字（如 家庭≈嘉廷），代码只判断「是否确定」；不确定时由后端再让大模型从候选里挑。 */
const SUB_TAG = /^(出入口|交通设施|生活服务;(其他|公共厕所))/;
const SUB_SUFFIX = /(地上|地下)?停车场$|(北|南|东|西|东北|东南|西北|西南)?门$|\d+号门$|大堂$|洗手间$|入口$|出口$|会议中心$/;
const NOISE_TAG = /公司企业|房地产;写字楼|培训|教培/;
const HOTEL_WORD = /酒店|宾馆|旅馆|客栈|公寓|民宿|饭店/;

function parentName(name, tag) {
  let n = String(name || '');
  if (n.includes('-') && (SUB_TAG.test(tag || '') || SUB_SUFFIX.test(n.split('-').pop()))) n = n.slice(0, n.lastIndexOf('-'));
  return n.replace(SUB_SUFFIX, '').replace(/-$/, '') || n;
}
// 去掉括号分店名、空格；「上海」前缀只在去掉后仍 ≥ 4 字时去（「上海美术馆」≠「美术馆」）
const core = n => { const x = String(n || '').replace(/[（(].*?[）)]/g, '').replace(/[\s·・]/g, ''); const y = x.replace(/^上海市?/, ''); return y.length >= 4 ? y : x; };
function bigrams(s) { const o = []; for (let i = 0; i < s.length - 1; i++) o.push(s.slice(i, i + 2)); return o.length ? o : [s]; }
function similarity(a, b) {
  const x = core(a), y = core(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (Math.min(x.length, y.length) >= 4 && (y.includes(x) || x.includes(y))) return 0.9; // 「美术馆」这种通用词包含不算
  const bx = bigrams(x), by = new Set(bigrams(y));
  return bx.filter(g => by.has(g)).length / Math.max(bx.length, by.size);
}
/* results: normPlace() 后的列表（保持百度排序）。返回合并后的候选，每个带 score / subOf */
function collapse(results, kind) {
  const groups = [];
  const km = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 95);
  results.forEach((p, rank) => {
    const base = parentName(p.name, p.tag);
    const isSub = base !== p.name;
    // 同一地点的子点名称写法可能不同（「虹桥嘉廷酒店-大堂」与「上海虹桥嘉廷酒店(娄山关路地铁站店)-北门」）：核心名相同且相距 < 300m 视为同一处
    let g = groups.find(x => core(x.name) === core(base) && km(x.at, p) < 0.3);
    if (!g) { g = { name: base, at: p, rank, subs: [], main: null }; groups.push(g); }
    if (base.length > g.name.length) g.name = base;
    if (isSub) g.subs.push(p); else if (!g.main) g.main = p;
    g.rank = Math.min(g.rank, rank);
  });
  return groups.map(g => {
    const m = g.main || g.subs.find(s => /大堂/.test(s.name)) || g.subs.find(s => /门/.test(s.name)) || g.subs[0];
    return Object.assign({}, m, { name: g.name, baiduName: m.name, viaSub: !g.main, rank: g.rank, uid: (g.main || m).uid, tag: g.main ? g.main.tag : m.tag });
  }).filter(c => (kind === 'client' || !NOISE_TAG.test(c.tag || '')) && (kind !== 'hotel' || HOTEL_WORD.test(c.name) || /酒店/.test(c.tag || ''))) // 客户本来就在写字楼/公司里，不当噪声
    .filter((c, _, all) => kind !== 'client' || !TRANSIT_TAG.test(c.tag || '') || all.every(x => TRANSIT_TAG.test(x.tag || ''))); // 客户不会在地铁站里（「漕河泾开发区」同名地铁站）
}
const TRANSIT_TAG = /^交通设施/;
/* v2：分店和区域也要对上（实测「外婆家(来福士广场店)」被当成百联徐汇店「名称一致」；「静安香格里拉」被当成浦东香格里拉「同一地点」） */
const AREAS = ['浦东', '静安', '徐汇', '黄浦', '长宁', '普陀', '虹口', '杨浦', '闵行', '宝山', '嘉定', '金山', '松江', '青浦', '奉贤', '崇明', '陆家嘴', '前滩', '虹桥', '人民广场', '南京西路', '南京东路', '外滩', '北外滩', '徐家汇', '五角场', '中山公园', '静安寺', '新天地', '张江', '世纪公园', '川沙', '迪士尼', '七宝', '莘庄', '漕河泾', '来福士', '大悦城', '嘉里中心', '太古汇', '环球港', '国金', '正大广场', '朝阳', '海淀', '东城', '西城', '福田', '南山', '天河', '西湖', '滨江'];
const branchOf = n => { const m = String(n || '').match(/[（(](.*?)[）)]/); return m ? m[1].replace(/^上海市?/, '').replace(/(分店|店)$/, '') : ''; };
const areasIn = n => AREAS.filter(a => String(n || '').includes(a));
function penalty(said, name) {
  const sb = branchOf(said), cb = branchOf(name);
  let f = 1, why = '';
  if (sb) {
    if (!cb) { f *= 0.8; why = '没有分店名'; }
    else if (cb === sb) f *= 1; // 分店完全一致
    else if (cb.includes(sb) || sb.includes(cb)) f *= 0.97;
    else if (similarity(sb, cb) >= 0.5) f *= 0.93;
    else { f *= 0.55; why = `分店不同（你说${sb}，这家是${cb}）`; }
  }
  const sa = areasIn(said), ca = areasIn(name);
  if (sa.length && ca.length && !sa.some(a => ca.includes(a))) { f *= 0.5; why = why || `区域不同（你说${sa[0]}，这家在${ca[0]}）`; }
  return { f, why };
}
function rank(said, query, cands) {
  return cands.map(c => { const p = penalty(said, c.name); return Object.assign(c, { score: +(Math.max(similarity(said, c.name), similarity(query || said, c.name)) * p.f).toFixed(2), mismatch: p.why }); })
    .sort((a, b) => b.score - a.score || a.rank - b.rank);
}
/* 确定：名称一致/包含（≥0.9），或相似度 ≥0.6 且明显领先第二名 */
function confident(list) {
  const [a, b] = list;
  if (!a) return false;
  if (a.score >= 0.9) return true;
  return a.score >= 0.6 && (!b || a.score - b.score >= 0.2);
}
module.exports = { parentName, similarity, collapse, rank, confident, core, branchOf, penalty };
