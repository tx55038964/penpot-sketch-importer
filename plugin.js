// Sketch 导入插件 —— 运行在 Penpot 插件沙箱里（可以调用 penpot API，没有 DOM）。
// UI（index.html）负责解压 .sketch，把 JSON 和图片字节发过来；这里负责把图层逐个画到画布上。

penpot.ui.open('Sketch 导入', `?theme=${penpot.theme}`, { width: 380, height: 560 });

penpot.on('themechange', (theme) => penpot.ui.sendMessage({ type: 'theme', theme }));

penpot.ui.onMessage(async (msg) => {
  if (msg && msg.type === 'ready') {
    penpot.ui.sendMessage({ type: 'theme', theme: penpot.theme });
    return;
  }
  if (!msg || msg.type !== 'import') return;
  try {
    const result = await importSketch(msg);
    penpot.ui.sendMessage({ type: 'done', ...result });
  } catch (e) {
    penpot.ui.sendMessage({ type: 'error', message: String((e && e.stack) || e) });
  }
});

// ---------------------------------------------------------------------------
// 几何：2D 仿射矩阵 [a, b, c, d, e, f]，与 SVG matrix() 相同
// ---------------------------------------------------------------------------
const IDENTITY = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const translate = (x, y) => [1, 0, 0, 1, x, y];
const scale = (sx, sy) => [sx, 0, 0, sy, 0, 0];
const rotateDeg = (deg) => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
};
const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const EPS = 1e-6;
const isAxisAligned = (m) => Math.abs(m[1]) < EPS && Math.abs(m[2]) < EPS;

// 图层自身的局部变换（位置 + 翻转 + 旋转），乘到父矩阵上
function layerMatrix(layer, parent) {
  const f = layer.frame;
  let local = translate(f.x, f.y);
  const rot = layer.rotation || 0;
  const fx = layer.isFlippedHorizontal ? -1 : 1;
  const fy = layer.isFlippedVertical ? -1 : 1;
  if (rot || fx < 0 || fy < 0) {
    local = mul(local, translate(f.width / 2, f.height / 2));
    // Sketch 的正角度是逆时针；y 轴向下的坐标系里要取负
    if (rot) local = mul(local, rotateDeg(-rot));
    if (fx < 0 || fy < 0) local = mul(local, scale(fx, fy));
    local = mul(local, translate(-f.width / 2, -f.height / 2));
  }
  return mul(parent, local);
}

// 变换后的包围盒（轴对齐时用它来放置矩形/椭圆/图片）
function boxOf(m, w, h) {
  const pts = [[0, 0], [w, 0], [w, h], [0, h]].map((p) => apply(m, p));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

const parsePoint = (s) => {
  const m = /\{\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*\}/.exec(s || '');
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : [0, 0];
};
const fmt = (n) => (Math.round(n * 1000) / 1000).toString();

// Sketch curvePoint（坐标归一化到 frame）→ SVG path d
function pointsToD(layer, m) {
  const pts = layer.points || [];
  if (!pts.length) return '';
  const { width: w, height: h } = layer.frame;
  const P = (s) => {
    const [x, y] = parsePoint(s);
    const [X, Y] = apply(m, [x * w, y * h]);
    return `${fmt(X)} ${fmt(Y)}`;
  };
  let d = `M ${P(pts[0].point)}`;
  const n = pts.length;
  const segs = layer.isClosed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    if (a.hasCurveFrom || b.hasCurveTo) {
      const c1 = a.hasCurveFrom ? a.curveFrom : a.point;
      const c2 = b.hasCurveTo ? b.curveTo : b.point;
      d += ` C ${P(c1)} ${P(c2)} ${P(b.point)}`;
    } else {
      d += ` L ${P(b.point)}`;
    }
  }
  if (layer.isClosed) d += ' Z';
  return d;
}

// ---------------------------------------------------------------------------
// 样式
// ---------------------------------------------------------------------------
const hex2 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
const colorHex = (c) => `#${hex2(c.red)}${hex2(c.green)}${hex2(c.blue)}`.toUpperCase();
const ctxOpacity = (x) => (x && x.contextSettings ? x.contextSettings.opacity : 1);

const BLEND = ['normal', 'darken', 'multiply', 'color-burn', 'lighten', 'screen', 'color-dodge', 'overlay',
  'soft-light', 'hard-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];

function gradientOf(g, opacity) {
  const [sx, sy] = parsePoint(g.from);
  const [ex, ey] = parsePoint(g.to);
  return {
    // Sketch 的角度渐变（2）Penpot 不支持，按线性处理
    type: g.gradientType === 1 ? 'radial' : 'linear',
    startX: sx, startY: sy, endX: ex, endY: ey,
    width: g.gradientType === 1 ? (g.elipseLength || 1) : 1,
    stops: (g.stops || []).map((s) => ({
      color: colorHex(s.color),
      opacity: s.color.alpha * opacity,
      offset: s.position,
    })),
  };
}

function fillsOf(style, ctx) {
  const out = [];
  for (const f of (style && style.fills) || []) {
    if (!f.isEnabled) continue;
    const op = ctxOpacity(f);
    if (f.fillType === 0) {
      out.push({ fillColor: colorHex(f.color), fillOpacity: f.color.alpha * op });
    } else if (f.fillType === 1 && f.gradient) {
      out.push({ fillColorGradient: gradientOf(f.gradient, op), fillOpacity: op });
    } else if (f.fillType === 4 && f.image) {
      const img = ctx.images.get(f.image._ref);
      if (img) out.push({ fillImage: img, fillOpacity: op });
    }
  }
  // Sketch 的 fills 自下而上，Penpot 的第一个在最上面
  return out.reverse();
}

function strokesOf(style) {
  const out = [];
  const dashed = !!(style && style.borderOptions && (style.borderOptions.dashPattern || []).length);
  for (const b of (style && style.borders) || []) {
    if (!b.isEnabled || !b.thickness) continue;
    const s = {
      strokeWidth: b.thickness,
      strokeAlignment: ['center', 'inner', 'outer'][b.position] || 'center',
      strokeStyle: dashed ? 'dashed' : 'solid',
    };
    const op = ctxOpacity(b);
    if (b.fillType === 1 && b.gradient) {
      s.strokeColorGradient = gradientOf(b.gradient, op);
      s.strokeOpacity = op;
    } else {
      s.strokeColor = colorHex(b.color);
      s.strokeOpacity = b.color.alpha * op;
    }
    out.push(s);
  }
  return out.reverse();
}

function shadowsOf(style) {
  const out = [];
  const add = (list, kind) => {
    for (const s of list || []) {
      if (!s.isEnabled) continue;
      out.push({
        style: kind,
        offsetX: s.offsetX,
        offsetY: s.offsetY,
        blur: s.blurRadius,
        spread: s.spread || 0,
        color: { color: colorHex(s.color), opacity: s.color.alpha * ctxOpacity(s) },
      });
    }
  };
  add(style && style.shadows, 'drop-shadow');
  add(style && style.innerShadows, 'inner-shadow');
  return out;
}

// 单个属性设置失败不影响整体导入，只记一条警告
function set(ctx, shape, key, value) {
  try {
    shape[key] = value;
  } catch (e) {
    ctx.warn(`${shape.name || '图层'}: 设置 ${key} 失败 (${e && e.message ? e.message : e})`);
  }
}

// 通用属性：名称、显隐、透明度、混合模式、阴影、模糊
function applyCommon(ctx, shape, layer, style) {
  set(ctx, shape, 'name', layer.name || layer._class);
  if (layer.isVisible === false) set(ctx, shape, 'hidden', true);
  if (layer.isLocked) set(ctx, shape, 'blocked', true);
  if (!style) return;
  const op = ctxOpacity(style);
  if (op !== 1) set(ctx, shape, 'opacity', op);
  const bm = style.contextSettings && style.contextSettings.blendMode;
  if (bm) set(ctx, shape, 'blendMode', BLEND[bm] || 'normal');
  const sh = shadowsOf(style);
  if (sh.length) set(ctx, shape, 'shadows', sh);
  if (style.blur && style.blur.isEnabled && style.blur.type === 0 && style.blur.radius) {
    set(ctx, shape, 'blur', { type: 'layer-blur', value: style.blur.radius });
  }
}

function applyPaint(ctx, shape, style) {
  set(ctx, shape, 'fills', fillsOf(style, ctx));
  set(ctx, shape, 'strokes', strokesOf(style));
}

// ---------------------------------------------------------------------------
// 字体匹配：Sketch 存的是 PostScript 名（如 PingFangSC-Medium），Penpot 按字体族 + 变体
// ---------------------------------------------------------------------------
const WEIGHTS = [
  [/thin|hairline/i, 100], [/ultra ?light|extra ?light/i, 200], [/light/i, 300],
  [/semi ?bold|demi ?bold/i, 600], [/extra ?bold|ultra ?bold|heavy/i, 800], [/black/i, 900],
  [/bold/i, 700], [/medium/i, 500], [/regular|normal|book|roman/i, 400],
];
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');

function parsePostScript(ps) {
  let family = ps;
  let styleName = 'Regular';
  if (ps.includes('-')) {
    const i = ps.lastIndexOf('-');
    family = ps.slice(0, i);
    styleName = ps.slice(i + 1);
  } else if (ps.includes('_')) {
    // 例如 AlibabaPuHuiTi_2_75_SemiBold：去掉数字字重
    const parts = ps.split('_');
    styleName = parts.pop();
    family = parts.filter((p, i) => !(i === parts.length - 1 && /^\d{2,3}$/.test(p))).join(' ');
  }
  let weight = 400;
  for (const [re, w] of WEIGHTS) if (re.test(styleName)) { weight = w; break; }
  return { family, weight, italic: /italic|oblique/i.test(styleName) };
}

const FALLBACK_FAMILIES = ['PingFang SC', 'Noto Sans SC', 'Source Han Sans SC', 'Source Sans Pro'];

function makeFontResolver(ctx) {
  const cache = new Map();
  let all = null;
  const findFamily = (family) => {
    try {
      const f = penpot.fonts.findByName(family);
      if (f) return f;
    } catch (e) { /* 忽略 */ }
    if (!all) {
      try { all = penpot.fonts.all || []; } catch (e) { all = []; }
    }
    const n = norm(family);
    if (!n) return null;
    return (
      all.find((f) => norm(f.fontFamily) === n || norm(f.name) === n) ||
      all.find((f) => norm(f.fontFamily).startsWith(n) || n.startsWith(norm(f.fontFamily)))
    ) || null;
  };
  return (ps) => {
    if (cache.has(ps)) return cache.get(ps);
    const { family, weight, italic } = parsePostScript(ps);
    let font = findFamily(family);
    if (!font) {
      for (const fb of FALLBACK_FAMILIES) {
        font = findFamily(fb);
        if (font) break;
      }
      ctx.missingFonts.set(ps, font ? font.fontFamily : '默认字体');
    }
    let variant = null;
    if (font && font.variants && font.variants.length) {
      const style = italic ? 'italic' : 'normal';
      const score = (v) => Math.abs(Number(v.fontWeight) - weight) + (v.fontStyle === style ? 0 : 1000);
      variant = font.variants.slice().sort((a, b) => score(a) - score(b))[0];
    }
    const r = { font, variant, weight };
    cache.set(ps, r);
    return r;
  };
}

// ---------------------------------------------------------------------------
// 文字
// ---------------------------------------------------------------------------
const ALIGN = ['left', 'right', 'center', 'justify', 'left'];
const VALIGN = ['top', 'center', 'bottom'];

function applyTextAttrs(ctx, target, attrs, layerFills) {
  const fontAttr = attrs.MSAttributedStringFontAttribute && attrs.MSAttributedStringFontAttribute.attributes;
  const size = fontAttr ? fontAttr.size : 14;
  if (fontAttr && fontAttr.name) {
    const { font, variant, weight } = ctx.resolveFont(fontAttr.name);
    if (font) {
      try {
        if (target.type === 'text') font.applyToText(target, variant || undefined);
        else font.applyToRange(target, variant || undefined);
      } catch (e) {
        set(ctx, target, 'fontId', font.fontId);
        set(ctx, target, 'fontFamily', font.fontFamily);
        if (variant) set(ctx, target, 'fontVariantId', variant.fontVariantId);
      }
    }
    set(ctx, target, 'fontWeight', String(variant ? variant.fontWeight : weight));
  }
  set(ctx, target, 'fontSize', String(size));
  if (typeof attrs.kerning === 'number') set(ctx, target, 'letterSpacing', fmt(attrs.kerning));
  const ps = attrs.paragraphStyle || {};
  if (ps.maximumLineHeight && size) set(ctx, target, 'lineHeight', fmt(ps.maximumLineHeight / size));
  if (typeof ps.alignment === 'number') set(ctx, target, 'align', ALIGN[ps.alignment] || 'left');
  if (attrs.underlineStyle) set(ctx, target, 'textDecoration', 'underline');
  else if (attrs.strikethroughStyle) set(ctx, target, 'textDecoration', 'line-through');
  const tt = attrs.MSAttributedStringTextTransformAttribute;
  if (tt === 1) set(ctx, target, 'textTransform', 'uppercase');
  else if (tt === 2) set(ctx, target, 'textTransform', 'lowercase');
  if (layerFills && layerFills.length) {
    set(ctx, target, 'fills', layerFills);
  } else if (attrs.MSAttributedStringColorAttribute) {
    const c = attrs.MSAttributedStringColorAttribute;
    set(ctx, target, 'fills', [{ fillColor: colorHex(c), fillOpacity: c.alpha }]);
  }
}

function buildText(ctx, layer, m, style, over) {
  const as = layer.attributedString || { string: '', attributes: [] };
  const overridden = over && typeof over.stringValue === 'string';
  const str = overridden ? over.stringValue : as.string;
  if (!str) return null;
  const t = penpot.createText(str);
  if (!t) return null;
  applyCommon(ctx, t, layer, style);

  const box = boxOf(m, layer.frame.width, layer.frame.height);
  const runs = as.attributes || [];
  const layerFills = fillsOf(style, ctx);
  if (runs.length) {
    // 先整体设置第一个样式段，再逐段覆盖
    applyTextAttrs(ctx, t, runs[0].attributes, layerFills);
    const va = runs[0].attributes.textStyleVerticalAlignmentKey;
    if (typeof va === 'number') set(ctx, t, 'verticalAlign', VALIGN[va] || 'top');
    if (!overridden && runs.length > 1) {
      for (const r of runs) {
        if (r.location + r.length > str.length || r.length <= 0) continue;
        try {
          applyTextAttrs(ctx, t.getRange(r.location, r.location + r.length), r.attributes, layerFills);
        } catch (e) {
          ctx.warn(`${layer.name}: 分段样式设置失败`);
        }
      }
    }
  }

  // 0 = 自动宽度, 1 = 固定宽度自动高度, 2 = 固定大小
  const beh = layer.textBehaviour || 0;
  const w = layer.frame.width;
  const h = layer.frame.height;
  try { t.resize(Math.max(1, w), Math.max(1, h)); } catch (e) { /* 忽略 */ }
  set(ctx, t, 'growType', beh === 0 ? 'auto-width' : beh === 1 ? 'auto-height' : 'fixed');
  if (isAxisAligned(m)) {
    set(ctx, t, 'x', box.x);
    set(ctx, t, 'y', box.y);
  } else {
    // 旋转文字：先放在未旋转位置，再绕中心旋转
    const c = apply(m, [w / 2, h / 2]);
    set(ctx, t, 'x', c[0] - w / 2);
    set(ctx, t, 'y', c[1] - h / 2);
    const angle = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
    try { t.rotate(angle); } catch (e) { /* 忽略 */ }
  }
  return t;
}

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------
function cornerRadii(layer) {
  const pts = layer.points || [];
  if (pts.length === 4 && pts.some((p) => p.cornerRadius)) return pts.map((p) => p.cornerRadius || 0);
  const r = layer.fixedRadius || 0;
  return [r, r, r, r];
}

function buildPath(ctx, d, name) {
  if (!d) return null;
  const p = penpot.createPath();
  try {
    p.d = d;
  } catch (e) {
    try { p.content = d; } catch (e2) { ctx.warn(`${name}: 路径写入失败`); }
  }
  return p;
}

// 只生成几何（不带样式），给布尔组合用
function buildGeometry(ctx, layer, m) {
  const f = layer.frame;
  if (layer._class === 'shapeGroup') {
    return buildShapeGroup(ctx, layer, m, null);
  }
  if (isAxisAligned(m) && (layer._class === 'rectangle' || layer._class === 'oval')) {
    const box = boxOf(m, f.width, f.height);
    const s = layer._class === 'oval' ? penpot.createEllipse() : penpot.createRectangle();
    s.x = box.x;
    s.y = box.y;
    s.resize(Math.max(0.01, box.w), Math.max(0.01, box.h));
    if (layer._class === 'rectangle') {
      const [tl, tr, br, bl] = cornerRadii(layer);
      if (tl === tr && tr === br && br === bl) {
        if (tl) set(ctx, s, 'borderRadius', tl);
      } else {
        set(ctx, s, 'borderRadiusTopLeft', tl);
        set(ctx, s, 'borderRadiusTopRight', tr);
        set(ctx, s, 'borderRadiusBottomRight', br);
        set(ctx, s, 'borderRadiusBottomLeft', bl);
      }
    }
    return s;
  }
  return buildPath(ctx, pointsToD(layer, m), layer.name);
}

const BOOL_OPS = ['union', 'difference', 'intersection', 'exclude'];

function buildShapeGroup(ctx, layer, m, style) {
  const kids = [];
  for (const child of layer.layers || []) {
    if (child.isVisible === false) continue;
    const g = buildGeometry(ctx, child, layerMatrix(child, m));
    if (g) kids.push({ shape: g, op: child.booleanOperation });
  }
  if (!kids.length) return null;
  let acc = kids[0].shape;
  // Sketch 的布尔运算按图层顺序依次作用；相同运算的连续段合并成一次
  let i = 1;
  while (i < kids.length) {
    const op = BOOL_OPS[kids[i].op] || 'union';
    const run = [];
    while (i < kids.length && (BOOL_OPS[kids[i].op] || 'union') === op) run.push(kids[i++].shape);
    const b = penpot.createBoolean(op, [acc, ...run]);
    if (!b) {
      ctx.warn(`${layer.name}: 布尔运算失败，改为编组`);
      acc = penpot.group([acc, ...run]) || acc;
    } else {
      acc = b;
    }
  }
  if (style) {
    applyCommon(ctx, acc, layer, style);
    if (acc.type === 'group') {
      for (const c of acc.children) applyPaint(ctx, c, style);
    } else {
      applyPaint(ctx, acc, style);
    }
  }
  return acc;
}

function buildBitmap(ctx, layer, m, style, over) {
  const ref = (over && over.image) || (layer.image && layer.image._ref);
  const img = ref && ctx.images.get(ref);
  const box = boxOf(m, layer.frame.width, layer.frame.height);
  const r = penpot.createRectangle();
  r.x = box.x;
  r.y = box.y;
  r.resize(Math.max(0.01, box.w), Math.max(0.01, box.h));
  applyCommon(ctx, r, layer, style);
  if (img) {
    set(ctx, r, 'fills', [{ fillImage: img, fillOpacity: 1 }]);
  } else {
    set(ctx, r, 'fills', [{ fillColor: '#DDDDDD', fillOpacity: 1 }]);
    ctx.warn(`${layer.name}: 图片 ${ref || '(无)'} 未找到，已用灰色占位`);
  }
  if (!isAxisAligned(m)) ctx.warn(`${layer.name}: 旋转的图片按未旋转放置`);
  return r;
}

// ---------------------------------------------------------------------------
// 容器、蒙版、Symbol
// ---------------------------------------------------------------------------

// 把一组 Sketch 子图层建出来，并处理蒙版（hasClippingMask 会裁切其后的兄弟图层）
function buildChildren(ctx, layers, m, overrides, into) {
  const items = [];
  for (const child of layers || []) {
    const shape = buildLayer(ctx, child, layerMatrix(child, m), overrides);
    if (!shape) continue;
    items.push({ shape, layer: child });
  }
  if (into) {
    // 开启 naturalChildOrdering 后 appendChild 放到最上面；旧版 Penpot 会放到最下面，就倒着加
    const order = ctx.naturalOrdering ? items : items.slice().reverse();
    for (const it of order) into.appendChild(it.shape);
  }

  const out = [];
  let seg = null;
  const flush = () => {
    if (!seg) return;
    const shapes = seg.shapes;
    let g = null;
    try {
      g = penpot.group(shapes);
      if (g) {
        g.makeMask();
        set(ctx, g, 'name', `${seg.name} (蒙版)`);
      }
    } catch (e) {
      ctx.warn(`${seg.name}: 蒙版创建失败`);
    }
    if (g) out.push(g);
    else out.push(...shapes);
    seg = null;
  };
  for (const it of items) {
    if (seg && it.layer.shouldBreakMaskChain) flush();
    if (it.layer.hasClippingMask) {
      flush();
      const shapes = [it.shape];
      // Penpot 的蒙版图形本身不显示；Sketch 会显示它的填充，所以复制一份作为可见内容
      const st = it.layer.style || {};
      const visible = (st.fills || []).some((f) => f.isEnabled) || (st.borders || []).some((b) => b.isEnabled);
      if (visible && it.layer.isVisible !== false) {
        try {
          const copy = it.shape.clone();
          if (into && copy.parent !== into) into.appendChild(copy);
          shapes.push(copy);
        } catch (e) { /* 忽略 */ }
      }
      seg = { name: it.layer.name, shapes };
    } else if (seg) {
      seg.shapes.push(it.shape);
    } else {
      out.push(it.shape);
    }
  }
  flush();
  return out;
}

function makeBoard(ctx, layer, m, style, bgColor) {
  const box = boxOf(m, layer.frame.width, layer.frame.height);
  const b = penpot.createBoard();
  b.x = box.x;
  b.y = box.y;
  b.resize(Math.max(1, box.w), Math.max(1, box.h));
  applyCommon(ctx, b, layer, style);
  set(ctx, b, 'clipContent', true);
  set(ctx, b, 'fills', bgColor ? [{ fillColor: colorHex(bgColor), fillOpacity: bgColor.alpha }] : []);
  return b;
}

function buildArtboard(ctx, layer, m) {
  const bg = layer.hasBackgroundColor ? layer.backgroundColor : { red: 1, green: 1, blue: 1, alpha: 1 };
  const b = makeBoard(ctx, layer, m, layer.style, bg);
  buildChildren(ctx, layer.layers, m, null, b);
  return b;
}

function buildGroup(ctx, layer, m, style, overrides) {
  const kids = buildChildren(ctx, layer.layers, m, overrides, null);
  if (!kids.length) return null;
  const g = penpot.group(kids);
  if (!g) return null;
  applyCommon(ctx, g, layer, style);
  return g;
}

// overrideName 形如 "ID1/ID2_stringValue"
function parseOverrides(list) {
  const map = new Map();
  for (const o of list || []) {
    const i = o.overrideName.lastIndexOf('_');
    if (i < 0) continue;
    const path = o.overrideName.slice(0, i);
    const prop = o.overrideName.slice(i + 1);
    let v = o.value;
    if (v && typeof v === 'object' && v._ref) v = v._ref;
    if (!map.has(path)) map.set(path, {});
    map.get(path)[prop] = v;
  }
  return map;
}

// 取出以 id/ 开头的嵌套 override，给子 Symbol 用
function nestedOverrides(overrides, id) {
  const out = new Map();
  if (!overrides) return out;
  for (const [path, v] of overrides) {
    if (path.startsWith(id + '/')) out.set(path.slice(id.length + 1), v);
  }
  return out;
}

function buildSymbolInstance(ctx, layer, m, style, over, parentOverrides) {
  const symbolID = (over && over.symbolID) || layer.symbolID;
  if (over && over.symbolID === '') return null; // 覆盖为"无"
  const master = ctx.symbols.get(symbolID);
  if (!master) {
    ctx.warn(`${layer.name}: 找不到 Symbol ${symbolID}，已跳过`);
    return null;
  }
  // 外层的覆盖优先于实例自身的覆盖
  const overrides = parseOverrides(layer.overrideValues);
  for (const [k, v] of nestedOverrides(parentOverrides, layer.do_objectID)) {
    overrides.set(k, Object.assign({}, overrides.get(k), v));
  }
  const bg = master.hasBackgroundColor && master.includeBackgroundColorInInstance ? master.backgroundColor : null;
  const board = makeBoard(ctx, layer, m, style, bg);
  const sx = master.frame.width ? layer.frame.width / master.frame.width : 1;
  const sy = master.frame.height ? layer.frame.height / master.frame.height : 1;
  const inner = Math.abs(sx - 1) > EPS || Math.abs(sy - 1) > EPS ? mul(m, scale(sx, sy)) : m;
  buildChildren(ctx, master.layers, inner, overrides, board);
  return board;
}

function buildLayer(ctx, layer, m, overrides) {
  ctx.tick();
  const over = overrides ? overrides.get(layer.do_objectID) : null;
  let style = layer.style;
  if (over && over.layerStyle && ctx.sharedStyles.has(over.layerStyle)) style = ctx.sharedStyles.get(over.layerStyle);

  switch (layer._class) {
    case 'artboard':
    case 'symbolMaster': {
      const b = buildArtboard(ctx, layer, m);
      if (layer._class === 'symbolMaster' && ctx.makeComponents) {
        try { penpot.library.local.createComponent([b]); } catch (e) { ctx.warn(`${layer.name}: 转为组件失败`); }
      }
      return b;
    }
    case 'group':
      return buildGroup(ctx, layer, m, style, overrides);
    case 'symbolInstance':
      return buildSymbolInstance(ctx, layer, m, style, over, overrides);
    case 'text':
      return buildText(ctx, layer, m, style, over);
    case 'bitmap':
      return buildBitmap(ctx, layer, m, style, over);
    case 'shapeGroup':
      return buildShapeGroup(ctx, layer, m, style);
    case 'rectangle':
    case 'oval':
    case 'shapePath':
    case 'star':
    case 'triangle':
    case 'polygon': {
      const s = buildGeometry(ctx, layer, m);
      if (!s) return null;
      applyCommon(ctx, s, layer, style);
      applyPaint(ctx, s, style);
      return s;
    }
    case 'slice':
    case 'MSImmutableHotspotLayer':
    case 'hotspot':
      return null;
    default:
      ctx.warn(`${layer.name}: 不支持的图层类型 ${layer._class}，已跳过`);
      return null;
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
function countLayers(layers) {
  let n = 0;
  for (const l of layers || []) n += 1 + countLayers(l.layers);
  return n;
}

function pageBounds(page) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity;
  for (const l of page.layers || []) {
    minX = Math.min(minX, l.frame.x);
    minY = Math.min(minY, l.frame.y);
    maxX = Math.max(maxX, l.frame.x + l.frame.width);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX } : { minX: 0, minY: 0, maxX: 0 };
}

async function importSketch({ document, pages, symbolPages, images, options }) {
  const warnings = [];
  const ctx = {
    images: new Map(),
    symbols: new Map(),
    sharedStyles: new Map(),
    missingFonts: new Map(),
    makeComponents: !!(options && options.makeComponents),
    naturalOrdering: false,
    warn: (m) => { if (warnings.length < 500) warnings.push(m); },
    done: 0,
    total: 0,
    tick: null,
  };
  ctx.resolveFont = makeFontResolver(ctx);
  try {
    penpot.flags.naturalChildOrdering = true;
    ctx.naturalOrdering = penpot.flags.naturalChildOrdering === true;
  } catch (e) {
    ctx.naturalOrdering = false;
  }

  // Symbol 定义：本文件所有页面 + 外部库
  const collectSymbols = (layers) => {
    for (const l of layers || []) {
      if (l._class === 'symbolMaster') ctx.symbols.set(l.symbolID, l);
      if (l.layers) collectSymbols(l.layers);
    }
  };
  for (const p of [...pages, ...(symbolPages || [])]) collectSymbols(p.layers);
  for (const fs of (document && document.foreignSymbols) || []) {
    if (fs.symbolMaster && !ctx.symbols.has(fs.symbolMaster.symbolID)) ctx.symbols.set(fs.symbolMaster.symbolID, fs.symbolMaster);
  }
  for (const key of ['layerStyles', 'foreignLayerStyles']) {
    const list = document && document[key];
    const objs = Array.isArray(list) ? list.map((x) => x.localSharedStyle || x) : (list && list.objects) || [];
    for (const s of objs) if (s && s.do_objectID && s.value) ctx.sharedStyles.set(s.do_objectID, s.value);
  }

  // 上传图片
  const entries = Object.entries(images || {});
  for (let i = 0; i < entries.length; i++) {
    const [ref, bytes] = entries[i];
    const ext = ref.split('.').pop().toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : null;
    if (!mime) { ctx.warn(`图片 ${ref} 格式不支持 (${ext})`); continue; }
    penpot.ui.sendMessage({ type: 'progress', phase: `上传图片 ${i + 1}/${entries.length}`, done: 0, total: 1 });
    try {
      const data = await penpot.uploadMediaData(ref.split('/').pop(), bytes, mime);
      ctx.images.set(ref, data);
    } catch (e) {
      ctx.warn(`图片 ${ref} 上传失败: ${e && e.message ? e.message : e}`);
    }
  }

  ctx.total = pages.reduce((n, p) => n + countLayers(p.layers), 0);
  ctx.tick = () => {
    ctx.done++;
    if (ctx.done % 40 === 0) penpot.ui.sendMessage({ type: 'progress', phase: '创建图层', done: ctx.done, total: ctx.total });
  };

  // 多个 Sketch 页面横向排开，避免重叠
  const top = [];
  let cursorX = null;
  for (const page of pages) {
    const b = pageBounds(page);
    const dx = cursorX === null ? 0 : cursorX - b.minX;
    const pageM = translate(dx, 0);
    for (const layer of page.layers || []) {
      try {
        const s = buildLayer(ctx, layer, layerMatrix(layer, pageM), null);
        if (s) top.push(s);
      } catch (e) {
        ctx.warn(`${layer.name}: 导入失败 (${e && e.message ? e.message : e})`);
      }
    }
    cursorX = b.maxX + dx + 400;
  }

  try {
    penpot.selection = top;
    penpot.viewport.zoomIntoView(top);
  } catch (e) { /* 忽略 */ }

  return {
    layers: ctx.done,
    topLevel: top.length,
    warnings,
    missingFonts: [...ctx.missingFonts].map(([ps, used]) => ({ ps, used })),
  };
}
