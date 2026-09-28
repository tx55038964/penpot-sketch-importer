// 离线测试：用模拟的 penpot 对象运行 plugin.js，把生成的图层树渲染成 SVG，和 Sketch 预览图对比。
// 用法：node test/mock-render.mjs <解压后的 sketch 目录> <输出 html>
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const [dir, outFile] = process.argv.slice(2);
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(dir, p), 'utf8'));

// ---------------- 模拟 Penpot ----------------
let nextId = 1;
const root = { type: 'root', children: [] };
const calls = {};
const count = (k) => { calls[k] = (calls[k] || 0) + 1; };

function detach(s) {
  if (s.parent) {
    const i = s.parent.children.indexOf(s);
    if (i >= 0) s.parent.children.splice(i, 1);
  }
}
function makeShape(type) {
  const s = {
    id: nextId++, type, name: type, x: 0, y: 0, width: 100, height: 100, hidden: false, opacity: 1,
    fills: type === 'board' ? [{ fillColor: '#FFFFFF', fillOpacity: 1 }] : [], strokes: [], shadows: [], children: [], parent: null,
    borderRadius: 0,
    resize(w, h) { this.width = w; this.height = h; },
    rotate(a) { this.rotation = (this.rotation || 0) + a; },
    appendChild(c) { detach(c); c.parent = this; if (flags.naturalChildOrdering) this.children.push(c); else this.children.unshift(c); },
    makeMask() { this.mask = true; },
    clone() {
      const c = deepClone(this);
      const p = this.parent; const i = p.children.indexOf(this);
      c.parent = p; p.children.splice(i + 1, 0, c); return c;
    },
    getRange(a, b) { const r = { start: a, end: b }; (this.ranges ||= []).push(r); return r; },
  };
  root.children.push(s); s.parent = root;
  return s;
}
function deepClone(s) {
  const c = Object.assign(Object.create(null), s);
  Object.assign(c, s, { id: nextId++ });
  c.children = s.children.map((k) => { const kk = deepClone(k); kk.parent = c; return kk; });
  return c;
}
function groupOf(type, shapes) {
  if (!shapes.length) return null;
  const parent = shapes[0].parent;
  const idx = Math.max(...shapes.map((s) => parent.children.indexOf(s)));
  const g = makeShape(type);
  detach(g);
  // 放到最上面那个元素的位置
  const kids = [...shapes].sort((a, b) => parent.children.indexOf(a) - parent.children.indexOf(b));
  for (const k of kids) { if (k.parent !== parent) throw new Error('group: shapes 不在同一父级'); }
  let insertAt = idx - (kids.length - 1);
  for (const k of kids) detach(k);
  parent.children.splice(insertAt, 0, g); g.parent = parent;
  for (const k of kids) { k.parent = g; g.children.push(k); }
  return g;
}

const fontsAll = [
  { name: 'Source Sans Pro', fontFamily: 'sourcesanspro', fontId: 'sourcesanspro', variants: [{ fontVariantId: 'regular', fontWeight: '400', fontStyle: 'normal' }, { fontVariantId: '700', fontWeight: '700', fontStyle: 'normal' }] },
  { name: 'Noto Sans SC', fontFamily: 'Noto Sans SC', fontId: 'gfont-noto-sans-sc', variants: [400, 500, 600, 700].map((w) => ({ fontVariantId: String(w), fontWeight: String(w), fontStyle: 'normal' })) },
];
for (const f of fontsAll) f.applyToText = function (t, v) { count('applyToText'); t.fontFamily = this.fontFamily; };
for (const f of fontsAll) f.applyToRange = function (r, v) { count('applyToRange'); r.fontFamily = this.fontFamily; r.fontWeight = v ? v.fontWeight : '400'; };

let handler = null;
// 和真实 Penpot 一样：默认 appendChild 放到最下面；MOCK_FLAGS=off 模拟不支持 flags 的旧版本
const flags = { naturalChildOrdering: false };
const flagsApi = process.env.MOCK_FLAGS === 'off' ? undefined : flags;
const messages = [];
const penpot = {
  theme: 'light',
  flags: flagsApi,
  on() {},
  ui: { open() {}, onMessage(cb) { handler = cb; }, sendMessage(m) { messages.push(m); } },
  createRectangle: () => (count('rect'), makeShape('rectangle')),
  createEllipse: () => (count('ellipse'), makeShape('ellipse')),
  createBoard: () => (count('board'), makeShape('board')),
  createPath: () => (count('path'), makeShape('path')),
  createText: (t) => { count('text'); const s = makeShape('text'); s.characters = t; return s; },
  createBoolean: (op, shapes) => { count('boolean'); const g = groupOf('boolean', shapes); g.boolType = op; return g; },
  group: (shapes) => (count('group'), groupOf('group', shapes)),
  uploadMediaData: async (name, bytes, mime) => ({ id: name, name, mtype: mime, width: 1, height: 1, __uri: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` }),
  fonts: { all: fontsAll, findByName: (n) => fontsAll.find((f) => f.name === n) || null },
  library: { local: { createComponent: () => count('component') } },
  viewport: { zoomIntoView() {} },
  selection: [],
};

const code = fs.readFileSync(new URL('../plugin.js', import.meta.url), 'utf8');
vm.runInNewContext(code, { penpot, console, setTimeout });

// ---------------- 运行导入 ----------------
const document = readJSON('document.json');
const pages = document.pages.map((r) => readJSON(r._ref + '.json'));
const images = {};
for (const f of fs.readdirSync(path.join(dir, 'images'))) images['images/' + f] = new Uint8Array(fs.readFileSync(path.join(dir, 'images', f)));
const mainPages = pages.filter((p) => !p.layers.every((l) => l._class === 'symbolMaster'));
const symbolPages = pages.filter((p) => !mainPages.includes(p));
await handler({ type: 'import', document, pages: mainPages, symbolPages, images, options: {} });
const done = messages.find((m) => m.type === 'done' || m.type === 'error');
if (done.type === 'error') { console.error(done.message); process.exit(1); }
console.log('calls', calls);
console.log('layers', done.layers, 'top', done.topLevel);
console.log('missingFonts', done.missingFonts);
console.log('warnings', done.warnings.length, done.warnings.slice(0, 30));

// ---------------- 渲染成 SVG ----------------
let defs = '';
let uid = 0;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function paint(fill, w, h) {
  if (fill.fillImage) {
    const id = 'p' + uid++;
    defs += `<pattern id="${id}" patternUnits="objectBoundingBox" width="1" height="1" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><image href="${fill.fillImage.__uri}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/></pattern>`;
    return [`url(#${id})`, fill.fillOpacity ?? 1];
  }
  if (fill.fillColorGradient || fill.strokeColorGradient) {
    const g = fill.fillColorGradient || fill.strokeColorGradient;
    const id = 'g' + uid++;
    const stops = g.stops.map((s) => `<stop offset="${s.offset}" stop-color="${s.color}" stop-opacity="${s.opacity ?? 1}"/>`).join('');
    defs += g.type === 'radial'
      ? `<radialGradient id="${id}" cx="${g.startX}" cy="${g.startY}" r="${Math.hypot(g.endX - g.startX, g.endY - g.startY)}">${stops}</radialGradient>`
      : `<linearGradient id="${id}" x1="${g.startX}" y1="${g.startY}" x2="${g.endX}" y2="${g.endY}">${stops}</linearGradient>`;
    return [`url(#${id})`, fill.fillOpacity ?? fill.strokeOpacity ?? 1];
  }
  if (fill.strokeColor) return [fill.strokeColor, fill.strokeOpacity ?? 1];
  return [fill.fillColor, fill.fillOpacity ?? 1];
}
function geom(s) {
  if (s.type === 'rectangle' || s.type === 'board') return `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="${s.borderRadius || s.borderRadiusTopLeft || 0}"/>`;
  if (s.type === 'ellipse') return `<ellipse cx="${s.x + s.width / 2}" cy="${s.y + s.height / 2}" rx="${s.width / 2}" ry="${s.height / 2}"/>`;
  if (s.type === 'path') return `<path d="${s.d}"/>`;
  if (s.type === 'boolean' || s.type === 'group') return s.children.map(geom).join('');
  return '';
}
function shapeWithPaint(s, g) {
  const fills = [...(s.fills || [])].reverse();
  let out = '';
  for (const f of fills) { const [c, o] = paint(f, s.width, s.height); out += g.replace(/^<(\w+)/, `<$1 fill="${c}" fill-opacity="${o}"`); }
  for (const st of s.strokes || []) { const [c, o] = paint(st, s.width, s.height); out += g.replace(/^<(\w+)/, `<$1 fill="none" stroke="${c}" stroke-opacity="${o}" stroke-width="${st.strokeWidth}"`); }
  return out;
}
function booleanGeom(s) {
  const kids = s.children;
  if (s.boolType === 'difference') {
    const id = 'm' + uid++;
    defs += `<mask id="${id}" maskUnits="userSpaceOnUse" x="-10000" y="-10000" width="30000" height="30000"><g fill="#fff">${geom(kids[0])}</g><g fill="#000">${kids.slice(1).map(geom).join('')}</g></mask>`;
    return `<g mask="url(#${id})">${geom(kids[0])}</g>`;
  }
  return `<g>${kids.map((k) => (k.type === 'boolean' ? booleanGeom(k) : geom(k))).join('')}</g>`;
}
function render(s) {
  if (s.hidden) return '';
  const attrs = s.opacity !== 1 ? ` opacity="${s.opacity}"` : '';
  let body = '';
  switch (s.type) {
    case 'board': {
      const id = 'c' + uid++;
      defs += `<clipPath id="${id}"><rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}"/></clipPath>`;
      body = `<g clip-path="url(#${id})">${shapeWithPaint(s, geom(s))}${s.children.map(render).join('')}</g>`;
      break;
    }
    case 'group': {
      if (s.mask) {
        const id = 'c' + uid++;
        defs += `<clipPath id="${id}">${geom(s.children[0])}</clipPath>`;
        body = `<g clip-path="url(#${id})">${s.children.slice(1).map(render).join('')}</g>`;
      } else body = s.children.map(render).join('');
      break;
    }
    case 'boolean': {
      const g = booleanGeom(s);
      const fills = [...s.fills].reverse();
      for (const f of fills) { const [c, o] = paint(f, s.width, s.height); body += `<g fill="${c}" fill-opacity="${o}">${g}</g>`; }
      break;
    }
    case 'text': {
      const fill = (s.fills && s.fills[0]) || {};
      const w = s.growType === 'auto-width' ? s.width + 40 : s.width;
      const ta = s.align || 'left';
      const lh = s.lineHeight ? `line-height:${s.lineHeight};` : '';
      body = `<foreignObject x="${s.x}" y="${s.y}" width="${w}" height="${s.height + 20}"><div xmlns="http://www.w3.org/1999/xhtml" style="font-family:'PingFang SC';font-size:${s.fontSize}px;font-weight:${s.fontWeight || 400};color:${fill.fillColor || '#000'};opacity:${fill.fillOpacity ?? 1};text-align:${ta};${lh}white-space:${s.growType === 'auto-width' ? 'pre' : 'pre-wrap'};letter-spacing:${s.letterSpacing || 0}px">${esc(s.characters)}</div></foreignObject>`;
      break;
    }
    default:
      body = shapeWithPaint(s, geom(s));
  }
  return `<g${attrs} data-name="${esc(s.name)}">${body}</g>`;
}
const content = root.children.map(render).join('');
const xs = root.children.map((s) => [s.x, s.y, s.x + s.width, s.y + s.height]);
const X0 = Math.min(...xs.map((b) => b[0])) - 20; const Y0 = Math.min(...xs.map((b) => b[1])) - 20;
const W = Math.max(...xs.map((b) => b[2])) + 20 - X0; const H = Math.max(...xs.map((b) => b[3])) + 20 - Y0;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${X0} ${Y0} ${W} ${H}"><defs>${defs}</defs>${content}</svg>`;
fs.writeFileSync(outFile, `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#ddd">${svg}</body>`);
console.log('wrote', outFile, W, H);
