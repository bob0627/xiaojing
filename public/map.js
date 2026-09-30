/* 地图适配层：有浏览器端 AK 时用百度 JS API GL（BMapGL），否则用 SVG 示意底图。
   spec = { markers:[{lat,lng,kind,text,emoji,color,selected,name,onClick}], circles:[{lat,lng,rKm,main,label}],
            lines:[{path:[[lng,lat],...],color,dash,width}], view:{lat,lng,rKm} | null(自动适配) } */
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
  const KM_LAT = 111.0;
  const kmLng = lat => 111.32 * Math.cos(lat * Math.PI / 180);

  // 示意底图用的上海水系（近似 BD09 坐标，仅作方位参考，不是真实地图）
  const HUANGPU = [[121.535, 31.300], [121.531, 31.268], [121.515, 31.252], [121.500, 31.249], [121.503, 31.240], [121.503, 31.229], [121.497, 31.214], [121.485, 31.201], [121.472, 31.190], [121.463, 31.172], [121.462, 31.150]];
  const SUZHOU = [[121.500, 31.249], [121.484, 31.251], [121.468, 31.248], [121.452, 31.243], [121.440, 31.238], [121.428, 31.240], [121.410, 31.229], [121.390, 31.222]];
  const AREAS = [['静安', 121.452, 31.236], ['黄浦', 121.482, 31.229], ['陆家嘴', 121.520, 31.236], ['徐汇', 121.442, 31.192], ['长宁', 121.418, 31.214], ['虹口', 121.492, 31.268], ['浦东', 121.552, 31.220], ['普陀', 121.420, 31.250]];

  function bounds(spec) {
    if (spec.view) return { lat: spec.view.lat, lng: spec.view.lng, rKm: spec.view.rKm };
    const pts = [...spec.markers, ...spec.lines.flatMap(l => l.path.map(p => ({ lng: p[0], lat: p[1] })))];
    (spec.circles || []).filter(c => c.main).forEach(c => { const dLat = c.rKm / KM_LAT, dLng = c.rKm / kmLng(c.lat);
      pts.push({ lat: c.lat + dLat, lng: c.lng }, { lat: c.lat - dLat, lng: c.lng }, { lat: c.lat, lng: c.lng + dLng }, { lat: c.lat, lng: c.lng - dLng }); });
    if (!pts.length) return { lat: 31.2304, lng: 121.4737, rKm: 4 };
    const lats = pts.map(p => p.lat), lngs = pts.map(p => p.lng);
    const lat = (Math.min(...lats) + Math.max(...lats)) / 2, lng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
    return { lat, lng, wKm: (Math.max(...lngs) - Math.min(...lngs)) * kmLng(lat), hKm: (Math.max(...lats) - Math.min(...lats)) * KM_LAT };
  }

  class SvgView {
    constructor(host) { this.host = host; this.kind = 'svg'; }
    render(spec) {
      const host = this.host;
      host.querySelectorAll('svg.map-svg').forEach(s => s.remove());
      const w = host.clientWidth || 390, h = host.clientHeight || 300;
      const top = spec.padTop ?? 40, bottom = spec.padBottom ?? 20;
      const svg = el('svg', { class: 'map-svg', viewBox: `0 0 ${w} ${h}` });
      host.insertBefore(svg, host.firstChild);
      const b = bounds(spec);
      const ah = h - top - bottom;
      let s; // px per km
      if (b.rKm) s = Math.min(w - 20, ah) / (2 * b.rKm);
      else s = Math.min((w - 120) / Math.max(b.wKm, 0.8), (ah - 50) / Math.max(b.hKm, 0.8));
      const cy0 = top + ah / 2;
      const proj = (lat, lng) => [w / 2 + (lng - b.lng) * kmLng(b.lat) * s, cy0 - (lat - b.lat) * KM_LAT * s];
      this.proj = proj;
      // 底图
      el('rect', { x: 0, y: 0, width: w, height: h, fill: '#EEF3EA' }, svg);
      const grid = el('g', { stroke: '#FFFFFF', 'stroke-width': Math.max(1, s * 0.035), opacity: .9 }, svg);
      const step = 0.7 / 111, [x0, y0] = proj(b.lat, b.lng);
      for (let i = -30; i <= 30; i++) {
        const [ax, ay] = proj(b.lat + i * step, b.lng - 0.3), [bx, by] = proj(b.lat + i * step + 0.002, b.lng + 0.3);
        el('path', { d: `M${ax} ${ay} L${bx} ${by}` }, grid);
        const [cx, cy] = proj(b.lat - 0.3, b.lng + i * step * 1.2), [dx, dy] = proj(b.lat + 0.3, b.lng + i * step * 1.2 + 0.002);
        el('path', { d: `M${cx} ${cy} L${dx} ${dy}` }, grid);
      }
      const river = (pts, width) => el('path', { d: pts.map((p, i) => (i ? 'L' : 'M') + proj(p[1], p[0]).map(v => v.toFixed(1)).join(' ')).join(' '), stroke: '#BFE0F5', 'stroke-width': width, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
      river(HUANGPU, Math.max(8, s * 0.35)); river(SUZHOU, Math.max(3, s * 0.1));
      const fs = Math.max(10, Math.min(14, s * 0.3));
      AREAS.forEach(([t, lng, lat]) => { const [px, py] = proj(lat, lng); if (px < 0 || px > w || py < 0 || py > h) return; const tx = el('text', { x: px, y: py, 'font-size': fs, fill: '#9AA79A', 'text-anchor': 'middle', 'font-weight': 600, 'letter-spacing': 2 }, svg); tx.textContent = t; });
      // 圈
      (spec.circles || []).forEach(c => {
        const [cx, cy] = proj(c.lat, c.lng);
        el('circle', { cx, cy, r: c.rKm * s, fill: c.main ? 'rgba(61,178,245,.13)' : 'none', stroke: '#3DB2F5', 'stroke-width': c.main ? 2 : 1, 'stroke-dasharray': c.main ? '' : '3 4', opacity: c.main ? 1 : .5 }, svg);
        if (c.label) { const t = el('text', { x: cx + c.rKm * s * 0.707 + 3, y: cy + c.rKm * s * 0.707 + 10, 'font-size': 10, fill: '#3D8FC0', 'font-weight': 700 }, svg); t.textContent = c.label; }
      });
      // 线
      const pills = [];
      (spec.lines || []).forEach(l => {
        const d = l.path.map((p, i) => (i ? 'L' : 'M') + proj(p[1], p[0]).map(v => v.toFixed(1)).join(' ')).join(' ');
        if (!l.dash) el('path', { d, stroke: '#fff', 'stroke-width': (l.width || 4) + 3, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
        const a = { d, stroke: l.color || '#3DB2F5', 'stroke-width': l.width || 4, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
        if (l.dash) a['stroke-dasharray'] = '6 4';
        el('path', a, svg);
        if (l.pill && l.path.length > 1) {
          const mid = l.path[Math.floor(l.path.length / 2)];
          const [px, py] = proj(mid[1], mid[0]);
          const [ax, ay] = proj(l.path[0][1], l.path[0][0]), [bx, by] = proj(l.path[l.path.length - 1][1], l.path[l.path.length - 1][0]);
          if (Math.hypot(bx - ax, by - ay) > 70) pills.push({ x: px, y: py, c: l.color, t: l.pill });
        }
      });
      // 点
      const boxes = [], marks = [];
      const drawn = new Set();
      (spec.markers || []).forEach(m => {
        const [px, py] = proj(m.lat, m.lng);
        const key = Math.round(px) + ',' + Math.round(py) + m.kind;
        if (m.kind === 'hotel' && drawn.has(key)) return; drawn.add(key);
        const g = el('g', { class: 'pin' }, svg);
        if (m.kind === 'emoji') {
          if (m.selected) el('circle', { cx: px, cy: py, r: 21, fill: '#111' }, g);
          el('circle', { cx: px, cy: py, r: m.selected ? 18 : 15, fill: '#fff', stroke: m.selected ? '#111' : (m.color || '#3DB2F5'), 'stroke-width': 2 }, g);
          const t = el('text', { x: px, y: py + 6, 'font-size': m.selected ? 18 : 15, 'text-anchor': 'middle' }, g); t.textContent = m.emoji;
        } else {
          const isH = m.kind === 'hotel', r = isH ? 14 : 12;
          el('circle', { cx: px, cy: py, r, fill: isH ? (m.color || '#111') : (m.color || '#3DB2F5'), stroke: '#fff', 'stroke-width': 2.5 }, g);
          const t = el('text', { x: px, y: py + 4, 'font-size': 11.5, fill: '#fff', 'text-anchor': 'middle', 'font-weight': 800 }, g); t.textContent = m.text || (isH ? '宿' : '');
        }
        if (m.onClick) g.addEventListener('click', m.onClick);
        boxes.push({ x: px - 14, y: py - 14, w: 28, h: 28 });
        marks.push({ px, py, m, g });
      });
      const hit = q => boxes.some(o => q.x < o.x + o.w && q.x + q.w > o.x && q.y < o.y + o.h && q.y + q.h > o.y);
      pills.forEach(p => {
        const tw = p.t.length * 6.8 + 14;
        const spot = [0, 20, -20].map(dy => ({ x: p.x - tw / 2, y: p.y - 9 + dy, w: tw, h: 18 })).find(q => q.x > 2 && q.x + q.w < w - 2 && q.y > top && q.y + q.h < h - 4 && !hit(q));
        if (!spot) return; boxes.push(spot);
        el('rect', { x: spot.x, y: spot.y, width: tw, height: 18, rx: 9, fill: p.c }, svg);
        const t = el('text', { x: spot.x + tw / 2, y: spot.y + 13, 'font-size': 10.5, fill: '#fff', 'text-anchor': 'middle', 'font-weight': 700 }, svg); t.textContent = p.t;
      });
      marks.forEach(({ px, py, m }) => {
        if (!m.name || m.noLabel) return;
        const nm = m.name.replace(/（.*?）/g, '').replace(/ · .*/, '').slice(0, 10);
        const tw = nm.length * 11 + 10;
        const dark = m.selected;
        const off = m.selected ? 24 : 16;
        const cands = [{ x: px + off, y: py - 9 }, { x: px - off - tw, y: py - 9 }, { x: px - tw / 2, y: py - off - 20 }, { x: px - tw / 2, y: py + off }, { x: px + 12, y: py - 30 }, { x: px + 12, y: py + 12 }];
        const spot = cands.find(c => c.x > 2 && c.x + tw < w - 2 && c.y > top - 6 && c.y + 18 < h - 4 && !hit({ x: c.x - 1, y: c.y - 1, w: tw + 2, h: 20 }));
        if (!spot) return;
        boxes.push({ x: spot.x, y: spot.y, w: tw, h: 18 });
        el('rect', { x: spot.x, y: spot.y, width: tw, height: 18, rx: 6, fill: dark ? '#111' : 'rgba(255,255,255,.94)' }, svg);
        const nt = el('text', { x: spot.x + 5, y: spot.y + 13, 'font-size': 11, fill: dark ? '#fff' : '#222', 'font-weight': 600 }, svg); nt.textContent = nm;
      });
      marks.filter(x => x.m.selected).forEach(x => svg.appendChild(x.g));
      if (spec.legend) {
        const tw = spec.legend.length * 10 + 16;
        el('rect', { x: 10, y: h - 28, width: tw, height: 18, rx: 9, fill: 'rgba(255,255,255,.9)' }, svg);
        const lg = el('text', { x: 18, y: h - 15, 'font-size': 10, fill: '#4A6B85', 'font-weight': 600 }, svg); lg.textContent = spec.legend;
      }
    }
  }

  /* 百度 JS API GL。坐标全程 bd09ll（和 Web 服务 API 一致，不做转换）。
     视野：用墨卡托坐标自己算缩放和中心（BMapGL 每像素 = 2^(18-zoom) 墨卡托单位），考虑顶部/底部浮层，不用带动画的 setViewport；
     标签：先定视野再用 pointToPixel 算像素位置，名字按 右/左/上/下 选不重叠的位置，放不下就不显示（和 SVG 版一致）。 */
  const shortName = n => String(n || '').replace(/（.*?）/g, '').replace(/\(.*?\)/g, '').replace(/ · .*/, '').slice(0, 11);
  const escH = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  class BaiduView {
    constructor(host) {
      this.host = host; this.kind = 'baidu'; this.loaded = false; this.renderAt = 0; this.lastView = '';
      this.div = document.createElement('div'); this.div.className = 'bmap';
      host.insertBefore(this.div, host.firstChild);
      this.map = new BMapGL.Map(this.div, { enableIconClick: false });
      this.map.enableScrollWheelZoom(true);
      this.map.centerAndZoom(new BMapGL.Point(121.4737, 31.2304), 13);
      this.targetZoom = 13;
      // 只认目标视野的 tilesloaded（构造时默认视野的那次不算，否则截图时下半张还是灰格子）
      // 低缩放（总览）时，瓦片晚到会把市区里的线盖掉 → 瓦片到齐后把线摘下再挂上（重排到上层），挂好后才算 loaded
      this.map.addEventListener('tilesloaded', () => {
        this.tilesAt = Date.now();
        if (Math.abs(this.map.getZoom() - this.targetZoom) >= 0.02) return;
        if (!this.lowZoom || !this.polys || !this.polys.length) { this.loaded = true; return; }
        clearTimeout(this.reAddT);
        this.reAddT = setTimeout(() => { const m = this.map; this.polys.forEach(o => m.removeOverlay(o)); this.polys.forEach(o => m.addOverlay(o)); this.loaded = true; }, 150);
      });
      this.tilesAt = 0; this.wasHidden = false;
      // 所在屏被隐藏（display:none）时 GL 画布变 0×0；切回来后同样的中心/缩放不会触发重绘，瓦片和覆盖物错位。
      // 实测 checkResize 不够，要 map.resize()：尺寸从 0 恢复时 resize 并按上次的 spec 重画
      if (window.ResizeObserver) new ResizeObserver(([e]) => {
        const { width, height } = e.contentRect;
        if (!width || !height) { this.wasHidden = true; return; }
        if (!this.wasHidden) return;
        this.wasHidden = false;
        // 要等 GL 自己的尺寸监听先跑完，所以稍后再 resize + 重画
        setTimeout(() => { if (this.map.resize) this.map.resize(); this.lastView = ''; if (this.spec && this.host.offsetParent !== null) this.render(this.spec); }, 80);
      }).observe(this.div);
    }
    fit(spec, w, h) {
      const map = this.map, top = spec.padTop ?? 40, bottom = this.bottomPad(spec);
      let pts, side;
      if (spec.view) {
        const { lat, lng, rKm } = spec.view, dLat = rKm / KM_LAT, dLng = rKm / kmLng(lat);
        pts = [[lng, lat + dLat], [lng, lat - dLat], [lng + dLng, lat], [lng - dLng, lat]]; side = 10;
      } else {
        pts = [...(spec.markers || []).map(m => [m.lng, m.lat]), ...(spec.lines || []).flatMap(l => l.path)];
        (spec.circles || []).filter(c => c.main).forEach(c => pts.push([c.lng, c.lat + c.rKm / KM_LAT], [c.lng, c.lat - c.rKm / KM_LAT]));
        side = 44; // 给名字标签留位置
      }
      if (!pts.length) pts = [[121.4737, 31.2304]];
      const merc = pts.map(p => map.lnglatToMercator(p[0], p[1]));
      const xs = merc.map(m => m[0]), ys = merc.map(m => m[1]);
      const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
      const aw = Math.max(80, w - 2 * side), ah = Math.max(80, h - top - bottom - (spec.view ? 0 : 36));
      const units = Math.max((maxx - minx) / aw, (maxy - miny) / ah, 2); // 最多放大到 17 级
      let zoom = Math.max(4, 18 - Math.log2(units));
      // minZoom：百度 GL 在 11 级以下（10 级瓦片）会把市区的线盖掉。若少留点边就能放进 minZoom，就用 minZoom
      if (spec.minZoom && zoom < spec.minZoom && !spec.view) {
        const tight = Math.max((maxx - minx) / Math.max(80, w - 28), (maxy - miny) / Math.max(80, h - top - bottom - 8));
        if (18 - Math.log2(tight) >= spec.minZoom) zoom = spec.minZoom;
      }
      const units2 = Math.pow(2, 18 - zoom);
      const d = top + (h - top - bottom) / 2 - h / 2; // 可视区中心相对画布中心的下移量（像素）
      const ll = map.mercatorToLnglat((minx + maxx) / 2, (miny + maxy) / 2 + d * units2);
      const key = ll.map(v => v.toFixed(6)).join(',') + '@' + zoom.toFixed(3) + '|' + w + 'x' + h;
      if (key !== this.lastView) { this.loaded = false; this.lastView = key; }
      this.targetZoom = zoom;
      map.centerAndZoom(new BMapGL.Point(ll[0], ll[1]), zoom, { noAnimation: true });
    }
    // 百度 logo + 版权占底部约 26px，有图例再加 22px；雷达的 logo 被抬到半径条上方，底部浮层照旧
    bottomPad(spec) { return Math.max(spec.padBottom ?? 20, (spec.logoLift ? 0 : 26) + (spec.legend ? 22 : 0)); }
    render(spec) {
      const map = this.map;
      this.host.classList.toggle('bm-lift', !!spec.logoLift);
      const w = this.div.clientWidth || this.host.clientWidth, h = this.div.clientHeight || this.host.clientHeight;
      if (!w || !h || this.host.offsetParent === null) return; // 所在屏隐藏时不画，切回来会重画
      const sz = map.getSize ? map.getSize() : null;
      if (sz && (Math.abs(sz.width - w) > 1 || Math.abs(sz.height - h) > 1)) { if (map.resize) map.resize(); else if (map.checkResize) map.checkResize(); this.lastView = ''; }
      map.clearOverlays();
      this.renderAt = Date.now(); this.spec = spec;
      this.fit(spec, w, h);
      const P = (lat, lng) => new BMapGL.Point(lng, lat);
      const px = (lat, lng) => { const q = map.pointToPixel(P(lat, lng)); return [q.x, q.y]; };
      const top = spec.padTop ?? 40, bottom = this.bottomPad(spec);
      const boxes = [];
      const hit = q => boxes.some(o => q.x < o.x + o.w && q.x + q.w > o.x && q.y < o.y + o.h && q.y + q.h > o.y);
      const inView = q => q.x > 2 && q.x + q.w < w - 2 && q.y > top - 6 && q.y + q.h < h - bottom + 4;
      const label = (html, lat, lng, ox, oy, z) => { const lab = new BMapGL.Label(html, { position: P(lat, lng), offset: new BMapGL.Size(ox, oy) });
        lab.setStyle({ border: 'none', background: 'transparent', padding: '0', lineHeight: 'normal' }); if (z && lab.setZIndex) lab.setZIndex(z); map.addOverlay(lab); return lab; };
      // 圈 + 半径标注
      (spec.circles || []).forEach(c => {
        map.addOverlay(new BMapGL.Circle(P(c.lat, c.lng), c.rKm * 1000, { strokeColor: '#1E88E5', strokeWeight: c.main ? 2.5 : 1.2, strokeOpacity: c.main ? .95 : .6,
          fillColor: '#3DB2F5', fillOpacity: c.main ? .14 : 0, strokeStyle: c.main ? 'solid' : 'dashed' }));
        if (c.label) { const la = c.lat - c.rKm / KM_LAT * 0.707, ln = c.lng + c.rKm / kmLng(c.lat) * 0.707; label(`<div class="bm-rlab">${escH(c.label)}</div>`, la, ln, 2, 0, 5); }
      });
      // 线：白色描边 + 彩色主线（虚线 = 第二天）。
      // 实测：BMapGL 在缩放 < ~10.8 级时，市区里的「实线」Polyline 会被底图盖住（与颜色/透明度/描边无关；虚线正常），
      // 总览这类跨半个上海的视野落在 10 级左右，所以低缩放时全部画虚线，靠颜色区分天（图例写明），瓦片到齐后再重挂一次线（见 tilesloaded）。
      // 叠 DOM/SVG 层会让 GL 画布在 headless 下变白，所以不用
      const pills = [], lowZoom = this.targetZoom < 11, polys = [];
      this.lowZoom = lowZoom; this.polys = polys;
      const addLine = o => { polys.push(o); map.addOverlay(o); };
      (spec.lines || []).forEach(l => {
        const path = l.path.map(p => new BMapGL.Point(p[0], p[1]));
        if (path.length < 2) return;
        const wd = l.width || 5;
        if (!lowZoom) addLine(new BMapGL.Polyline(path, { strokeColor: '#FFFFFF', strokeWeight: wd + 3, strokeOpacity: .95 }));
        addLine(new BMapGL.Polyline(path, { strokeColor: l.color || '#3DB2F5', strokeWeight: lowZoom ? Math.max(wd, 4) : wd, strokeOpacity: .95, strokeStyle: l.dash || lowZoom ? 'dashed' : 'solid' }));
        if (l.pill) {
          const mid = l.path[Math.floor(l.path.length / 2)], a = px(l.path[0][1], l.path[0][0]), b = px(l.path[l.path.length - 1][1], l.path[l.path.length - 1][0]);
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 70) pills.push({ lat: mid[1], lng: mid[0], c: l.color || '#3DB2F5', t: l.pill });
        }
      });
      // 点（同位置的酒店只画一次），先占位，再放名字
      const drawn = new Set(), marks = [];
      (spec.markers || []).forEach(m => {
        const [x, y] = px(m.lat, m.lng), k = Math.round(x) + ',' + Math.round(y) + m.kind;
        if (m.kind === 'hotel' && drawn.has(k)) return; drawn.add(k);
        const r = m.selected ? 18 : 15;
        boxes.push({ x: x - r, y: y - r, w: 2 * r, h: 2 * r });
        marks.push({ m, x, y, r });
      });
      pills.forEach(p => {
        const [x, y] = px(p.lat, p.lng), tw = p.t.length * 6.6 + 14;
        const spot = [0, 20, -20].map(dy => ({ x: x - tw / 2, y: y - 9 + dy, w: tw, h: 18 })).find(q => inView(q) && !hit(q));
        if (!spot) return; boxes.push(spot);
        label(`<div class="bm-pill" style="background:${p.c}">${escH(p.t)}</div>`, p.lat, p.lng, spot.x - x, spot.y - y, 6);
      });
      // 名字按重要性放：选中 > 酒店 > 其它；绘制顺序仍让选中的在最上层
      const pri = mk => (mk.m.selected ? 0 : mk.m.kind === 'hotel' ? 1 : 2);
      marks.sort((a, b) => pri(a) - pri(b));
      marks.forEach(({ m, x, y, r }) => {
        const isE = m.kind === 'emoji', isH = m.kind === 'hotel';
        const bg = isE ? '#fff' : (isH ? (m.color || '#111') : (m.color || '#3DB2F5'));
        let nameHtml = '';
        if (m.name && !m.noLabel) {
          const nm = shortName(m.name), tw = nm.length * 11 + 12, off = r + 4;
          const cands = [{ x: x + off, y: y - 9 }, { x: x - off - tw, y: y - 9 }, { x: x - tw / 2, y: y - off - 20 }, { x: x - tw / 2, y: y + off }];
          const spot = cands.find(c => inView({ x: c.x, y: c.y, w: tw, h: 18 }) && !hit({ x: c.x - 1, y: c.y - 1, w: tw + 2, h: 20 }));
          if (spot) { boxes.push({ x: spot.x, y: spot.y, w: tw, h: 18 }); nameHtml = `<div class="bm-name ${m.selected ? 'sel' : ''}" style="left:${Math.round(spot.x - x + r)}px;top:${Math.round(spot.y - y + r)}px">${escH(nm)}</div>`; }
        }
        const html = `<div class="bm-mk" style="width:${2 * r}px;height:${2 * r}px"><div class="bm-pin ${m.selected ? 'sel' : ''} ${isE ? 'emo' : ''}" style="width:${2 * r}px;height:${2 * r}px;background:${bg};${isE ? `border-color:${m.selected ? '#111' : (m.color || '#3DB2F5')}` : ''}">${isE ? m.emoji : escH(m.text || (isH ? '宿' : ''))}</div>${nameHtml}</div>`;
        const lab = label(html, m.lat, m.lng, -r, -r, m.selected ? 30 : isH ? 20 : 10);
        if (m.onClick) lab.addEventListener('click', m.onClick);
      });
      // 图例（DOM，放在百度 logo 上方）
      this.host.querySelectorAll('.bm-legend').forEach(e => e.remove());
      if (spec.legend) { const lg = document.createElement('div'); lg.className = 'bm-legend'; lg.textContent = spec.legend; this.host.appendChild(lg); }
    }
  }

  let loading = null;
  function loadBaidu(ak) {
    if (!ak) return Promise.resolve(false);
    if (loading) return loading;
    loading = new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 8000);
      window.__bmapReady = () => { clearTimeout(timer); resolve(!!(window.BMapGL && window.BMapGL.Map)); };
      const s = document.createElement('script');
      s.src = `https://api.map.baidu.com/api?v=3.0&type=webgl&ak=${encodeURIComponent(ak)}&callback=__bmapReady`; // callback 形式：加载器用 createElement 引 getscript，不走 document.write
      s.onerror = () => { clearTimeout(timer); resolve(false); };
      document.head.appendChild(s);
    });
    return loading;
  }
  const views = new WeakMap(), all = [];
  window.MapView = {
    loadBaidu, _views: all,
    /* 截图用：当前可见的百度地图瓦片都加载完（或渲染后已过 8 秒）才算空闲；SVG 立即空闲 */
    idle() { return all.filter(v => v.kind === 'baidu' && v.host.offsetParent !== null).every(v => (v.loaded && Date.now() - v.renderAt > 800 && Date.now() - v.tilesAt > 700) || Date.now() - v.renderAt > 10000); },
    get(host) {
      let v = views.get(host);
      if (!v) {
        if (window.BMapGL && window.__useBaidu) { try { v = new BaiduView(host); } catch (e) { console.warn('BMapGL 初始化失败，改用 SVG', e); v = new SvgView(host); } }
        else v = new SvgView(host);
        views.set(host, v); all.push(v);
      }
      return v;
    },
  };
})();
