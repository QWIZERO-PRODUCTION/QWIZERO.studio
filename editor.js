/* ============================================================
   QWIZERO Studio — ядро фоторедактора
   Слои, инструменты, выделение, фильтры, коррекции, история
   ============================================================ */
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
let __uid = 1;
const uid = () => 'id' + (__uid++) + '_' + Date.now().toString(36);

/* ---------------- Глобальное состояние ---------------- */
const QW = {
  doc: null,                 // { w, h, name, layers: [], active: 0 }
  view: { zoom: 1, ox: 0, oy: 0 },
  tool: 'move',
  fg: '#ffffff',
  bg: '#000000',
  brush: { size: 30, hardness: 0.7, opacity: 1, flow: 1 },
  selPath: null,             // Path2D в координатах документа (для контура и clip)
  selMask: null,             // canvas-маска (для волшебной палочки)
  history: [], hIndex: -1, hBytes: 0,
  mode: 'photo',
  spacePan: false,
  comp: null                 // композиция моушн-редактора (заполняет motion.js)
};
window.QW = QW;

const HIST_LIMIT = 30;
const HIST_BYTES = 700 * 1024 * 1024;

/* ---------------- Модальные окна ---------------- */
function showModal(title, bodyHtml, onOk, okText) {
  const root = $('#modal-root');
  root.innerHTML = '';
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<h3>${title}</h3><div class="mbody">${bodyHtml}</div>
    <div class="mfoot"><button class="cancel">Отмена</button><button class="ok">${okText || 'OK'}</button></div>`;
  root.appendChild(m);
  const close = () => { root.innerHTML = ''; };
  m.querySelector('.cancel').onclick = close;
  m.querySelector('.ok').onclick = () => { if (onOk(m) !== false) close(); };
  return m;
}

/* ---------------- Документ и слои ---------------- */
function makeLayer(name, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return {
    id: uid(), name, canvas: c,
    x: 0, y: 0, scaleX: 1, scaleY: 1, rot: 0,
    opacity: 1, blend: 'source-over',
    visible: true, locked: false, mask: null
  };
}

function newDocument(w, h, name, fill) {
  QW.doc = { w, h, name: name || 'Без названия', layers: [], active: 0 };
  const l = makeLayer('Фон', w, h);
  if (fill) { const ctx = l.canvas.getContext('2d'); ctx.fillStyle = fill; ctx.fillRect(0, 0, w, h); }
  QW.doc.layers.push(l);
  clearSelection();
  QW.history = []; QW.hIndex = -1; QW.hBytes = 0;
  fitToWindow();
  refreshLayersPanel();
  updateStatus();
  render();
}

function activeLayer() {
  if (!QW.doc || !QW.doc.layers.length) return null;
  return QW.doc.layers[QW.doc.active];
}

function addLayer(name, silent) {
  const l = makeLayer(name || ('Слой ' + (QW.doc.layers.length + 1)), QW.doc.w, QW.doc.h);
  QW.doc.layers.splice(QW.doc.active + 1, 0, l);
  QW.doc.active++;
  if (!silent) pushHistory({
    label: 'Новый слой',
    undo: () => { const i = QW.doc.layers.indexOf(l); QW.doc.layers.splice(i, 1); QW.doc.active = Math.max(0, i - 1); afterStruct(); },
    redo: () => { QW.doc.layers.splice(QW.doc.active + 1, 0, l); QW.doc.active++; afterStruct(); }
  });
  afterStruct();
  return l;
}

function afterStruct() { refreshLayersPanel(); render(); }

function structSnapshot() {
  // Полный снапшот структуры (для удаления/объединения/кадрирования)
  return QW.doc.layers.map(l => ({
    ref: l, name: l.name, x: l.x, y: l.y, scaleX: l.scaleX, scaleY: l.scaleY, rot: l.rot,
    opacity: l.opacity, blend: l.blend, visible: l.visible, locked: l.locked,
    img: l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height),
    mask: l.mask ? l.mask.getContext('2d').getImageData(0, 0, l.mask.width, l.mask.height) : null
  }));
}

function restoreStruct(snap, active) {
  QW.doc.layers = snap.map(s => {
    const l = s.ref;
    l.name = s.name; l.x = s.x; l.y = s.y; l.scaleX = s.scaleX; l.scaleY = s.scaleY; l.rot = s.rot;
    l.opacity = s.opacity; l.blend = s.blend; l.visible = s.visible; l.locked = s.locked;
    if (l.canvas.width !== s.img.width || l.canvas.height !== s.img.height) { l.canvas.width = s.img.width; l.canvas.height = s.img.height; }
    l.canvas.getContext('2d').putImageData(s.img, 0, 0);
    if (s.mask) {
      if (!l.mask) l.mask = document.createElement('canvas');
      l.mask.width = s.mask.width; l.mask.height = s.mask.height;
      l.mask.getContext('2d').putImageData(s.mask, 0, 0);
    } else l.mask = null;
    return l;
  });
  QW.doc.active = clamp(active, 0, QW.doc.layers.length - 1);
  afterStruct();
}

/* ---------------- История ---------------- */
function pushHistory(entry) {
  QW.history = QW.history.slice(0, QW.hIndex + 1);
  QW.history.push(entry);
  if (QW.history.length > HIST_LIMIT) QW.history.shift();
  QW.hIndex = QW.history.length - 1;
}

function layerPaintEntry(label, layer, before) {
  const ctx = layer.canvas.getContext('2d');
  const after = ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
  pushHistory({
    label,
    undo: () => { ctx.putImageData(before, 0, 0); render(); refreshLayersPanel(); },
    redo: () => { ctx.putImageData(after, 0, 0); render(); refreshLayersPanel(); }
  });
}

function undo() {
  if (QW.hIndex < 0) return;
  QW.history[QW.hIndex].undo();
  QW.hIndex--;
}

function redo() {
  if (QW.hIndex >= QW.history.length - 1) return;
  QW.hIndex++;
  QW.history[QW.hIndex].redo();
}

/* ---------------- Отрисовка ---------------- */
const view = $('#view');
const vctx = view.getContext('2d');

function resizeView() {
  const ws = $('#workspace');
  const dpr = window.devicePixelRatio || 1;
  view.width = Math.max(1, ws.clientWidth * dpr);
  view.height = Math.max(1, ws.clientHeight * dpr);
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

function fitToWindow() {
  if (!QW.doc) return;
  const ws = $('#workspace');
  const zx = (ws.clientWidth - 60) / QW.doc.w;
  const zy = (ws.clientHeight - 60) / QW.doc.h;
  QW.view.zoom = Math.min(zx, zy, 4);
  QW.view.ox = (ws.clientWidth - QW.doc.w * QW.view.zoom) / 2;
  QW.view.oy = (ws.clientHeight - QW.doc.h * QW.view.zoom) / 2;
}

function docToScreen(x, y) { return [x * QW.view.zoom + QW.view.ox, y * QW.view.zoom + QW.view.oy]; }
function screenToDoc(x, y) { return [(x - QW.view.ox) / QW.view.zoom, (y - QW.view.oy) / QW.view.zoom]; }

function drawChecker(ctx, x, y, w, h, s) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  for (let yy = y - (y % s); yy < y + h; yy += s)
    for (let xx = x - (x % s); xx < x + w; xx += s) {
      ctx.fillStyle = (((xx / s) | 0) + ((yy / s) | 0)) % 2 ? '#26262e' : '#1e1e26';
      ctx.fillRect(xx, yy, s, s);
    }
  ctx.restore();
}

function compositeTo(ctx, W, H) {
  // Собирает документ в произвольный контекст размером W×H (документные координаты)
  for (const l of QW.doc.layers) {
    if (!l.visible) continue;
    ctx.save();
    ctx.globalAlpha = l.opacity;
    ctx.globalCompositeOperation = l.blend;
    const cx = l.x + W / 2, cy = l.y + H / 2;
    ctx.translate(cx, cy);
    ctx.rotate(l.rot * Math.PI / 180);
    ctx.scale(l.scaleX, l.scaleY);
    if (l.mask) {
      const t = document.createElement('canvas');
      t.width = l.canvas.width; t.height = l.canvas.height;
      const tc = t.getContext('2d');
      tc.drawImage(l.canvas, 0, 0);
      tc.globalCompositeOperation = 'destination-in';
      tc.drawImage(l.mask, 0, 0);
      ctx.drawImage(t, -W / 2, -H / 2);
    } else {
      ctx.drawImage(l.canvas, -W / 2, -H / 2);
    }
    ctx.restore();
  }
}

function render() {
  const ws = $('#workspace');
  const cw = ws.clientWidth, ch = ws.clientHeight;
  vctx.clearRect(0, 0, cw, ch);

  if (QW.mode === 'motion' && QW.comp) { if (window.renderCompFrame) window.renderCompFrame(vctx, cw, ch); drawStatus(); return; }
  if (!QW.doc) { drawStatus(); return; }

  const z = QW.view.zoom;
  const [dx, dy] = docToScreen(0, 0);
  const dw = QW.doc.w * z, dh = QW.doc.h * z;

  drawChecker(vctx, dx, dy, dw, dh, Math.max(8, 12 * z));
  vctx.save();
  vctx.translate(dx, dy);
  vctx.scale(z, z);
  vctx.imageSmoothingEnabled = z < 3;
  compositeTo(vctx, QW.doc.w, QW.doc.h);
  vctx.restore();

  vctx.strokeStyle = 'rgba(124,92,255,.6)';
  vctx.lineWidth = 1;
  vctx.strokeRect(dx - .5, dy - .5, dw + 1, dh + 1);

  // Контур выделения («марширующие муравьи»)
  if (QW.selPath) {
    vctx.save();
    vctx.translate(dx, dy);
    vctx.scale(z, z);
    vctx.lineWidth = 1 / z;
    vctx.setLineDash([6 / z, 6 / z]);
    vctx.lineDashOffset = -(Date.now() / 60) % 12;
    vctx.strokeStyle = '#fff';
    vctx.stroke(QW.selPath);
    vctx.strokeStyle = '#000';
    vctx.lineDashOffset += 6 / z;
    vctx.stroke(QW.selPath);
    vctx.restore();
  } else if (QW.selMask) {
    vctx.save();
    vctx.strokeStyle = '#22d3ee';
    vctx.setLineDash([5, 5]);
    vctx.strokeRect(dx, dy, dw, dh);
    vctx.restore();
  }

  if (window.__previewShape) window.__previewShape(vctx);
  drawStatus();
}

let statusTimer = null;
function drawStatus() {
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    $('#st-zoom').textContent = Math.round(QW.view.zoom * 100) + '%';
  }, 80);
}

function updateStatus() {
  if (QW.doc) $('#st-doc').textContent = `${QW.doc.name} — ${QW.doc.w} × ${QW.doc.h} px`;
}

// Анимация муравьёв
setInterval(() => { if (QW.selPath || QW.selMask) render(); }, 90);

/* ---------------- Панель слоёв ---------------- */
const BLEND_NAMES = {};

function refreshLayersPanel() {
  const list = $('#layers-list');
  list.innerHTML = '';
  if (!QW.doc) return;
  const layers = QW.doc.layers;
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    const row = document.createElement('div');
    row.className = 'layer-row' + (i === QW.doc.active ? ' active' : '');
    const eye = document.createElement('span');
    eye.className = 'eye' + (l.visible ? '' : ' off');
    eye.textContent = '👁';
    eye.onclick = e => { e.stopPropagation(); l.visible = !l.visible; refreshLayersPanel(); render(); };

    const th = document.createElement('canvas');
    th.width = 34; th.height = 26;
    const tc = th.getContext('2d');
    const s = Math.min(34 / l.canvas.width, 26 / l.canvas.height);
    tc.drawImage(l.canvas, 0, 0, l.canvas.width * s, l.canvas.height * s);

    const nm = document.createElement('span');
    nm.className = 'lname';
    nm.textContent = l.name + (l.mask ? ' ◐' : '');
    nm.ondblclick = () => {
      const nv = prompt('Имя слоя:', l.name);
      if (nv) { l.name = nv; refreshLayersPanel(); }
    };

    const lock = document.createElement('span');
    lock.className = 'lock';
    lock.textContent = l.locked ? '🔒' : '';
    lock.onclick = e => { e.stopPropagation(); l.locked = !l.locked; refreshLayersPanel(); };

    row.append(eye, th, nm, lock);
    row.onclick = () => {
      QW.doc.active = i;
      $('#layer-opacity').value = Math.round(l.opacity * 100);
      $('#blend-mode').value = l.blend;
      refreshLayersPanel();
    };
    list.appendChild(row);
  }
  const al = activeLayer();
  if (al) { $('#layer-opacity').value = Math.round(al.opacity * 100); $('#blend-mode').value = al.blend; }
}

$('#layer-opacity').addEventListener('input', e => {
  const l = activeLayer(); if (!l) return;
  l.opacity = e.target.value / 100; render();
});
$('#blend-mode').addEventListener('change', e => {
  const l = activeLayer(); if (!l) return;
  l.blend = e.target.value; render();
});
$('#lb-new').onclick = () => addLayer();
$('#lb-dup').onclick = () => {
  const l = activeLayer(); if (!l) return;
  const nl = addLayer(l.name + ' копия', true);
  nl.canvas.getContext('2d').drawImage(l.canvas, 0, 0);
  nl.x = l.x; nl.y = l.y; nl.opacity = l.opacity; nl.blend = l.blend;
  const snap = structSnapshot();
  pushHistory({
    label: 'Дублирование слоя',
    undo: () => { const i = QW.doc.layers.indexOf(nl); QW.doc.layers.splice(i, 1); QW.doc.active = Math.max(0, i - 1); afterStruct(); },
    redo: () => { QW.doc.layers.splice(QW.doc.active + 1, 0, nl); QW.doc.active++; afterStruct(); }
  });
  afterStruct();
};
$('#lb-del').onclick = () => {
  if (!QW.doc || QW.doc.layers.length <= 1) return;
  const snap = structSnapshot(), act = QW.doc.active;
  const removed = QW.doc.layers.splice(QW.doc.active, 1)[0];
  QW.doc.active = clamp(QW.doc.active, 0, QW.doc.layers.length - 1);
  const snapAfter = structSnapshot(), actAfter = QW.doc.active;
  pushHistory({ label: 'Удаление слоя', undo: () => restoreStruct(snap, act), redo: () => restoreStruct(snapAfter, actAfter) });
  afterStruct();
};
$('#lb-up').onclick = () => moveLayer(1);
$('#lb-down').onclick = () => moveLayer(-1);
function moveLayer(dir) {
  const i = QW.doc.active, j = i + dir;
  if (j < 0 || j >= QW.doc.layers.length) return;
  const [l] = QW.doc.layers.splice(i, 1);
  QW.doc.layers.splice(j, 0, l);
  QW.doc.active = j;
  pushHistory({
    label: 'Порядок слоёв',
    undo: () => { const k = QW.doc.layers.indexOf(l); QW.doc.layers.splice(k, 1); QW.doc.layers.splice(i, 0, l); QW.doc.active = i; afterStruct(); },
    redo: () => { const k = QW.doc.layers.indexOf(l); QW.doc.layers.splice(k, 1); QW.doc.layers.splice(j, 0, l); QW.doc.active = j; afterStruct(); }
  });
  afterStruct();
}
$('#lb-merge').onclick = () => {
  const i = QW.doc.active;
  if (i <= 0) return;
  const snap = structSnapshot(), act = i;
  const top = QW.doc.layers[i], bot = QW.doc.layers[i - 1];
  const bc = bot.canvas.getContext('2d');
  bc.save();
  bc.globalAlpha = top.opacity;
  bc.globalCompositeOperation = top.blend;
  bc.translate(top.x, top.y);
  bc.rotate(top.rot * Math.PI / 180);
  bc.scale(top.scaleX, top.scaleY);
  bc.drawImage(top.canvas, 0, 0);
  bc.restore();
  QW.doc.layers.splice(i, 1);
  QW.doc.active = i - 1;
  const snap2 = structSnapshot(), act2 = QW.doc.active;
  pushHistory({ label: 'Объединение слоёв', undo: () => restoreStruct(snap, act), redo: () => restoreStruct(snap2, act2) });
  afterStruct();
};
$('#lb-mask').onclick = () => {
  const l = activeLayer(); if (!l) return;
  if (l.mask) { l.mask = null; refreshLayersPanel(); render(); return; }
  l.mask = document.createElement('canvas');
  l.mask.width = l.canvas.width; l.mask.height = l.canvas.height;
  const mc = l.mask.getContext('2d');
  mc.fillStyle = '#fff'; mc.fillRect(0, 0, l.mask.width, l.mask.height);
  if (QW.selPath || QW.selMask) {
    mc.fillStyle = '#000';
    if (QW.selPath) { mc.save(); mc.clip(QW.selPath); mc.fillRect(0, 0, l.mask.width, l.mask.height); mc.restore(); }
    else if (QW.selMask) { mc.save(); mc.globalCompositeOperation = 'destination-in'; mc.drawImage(QW.selMask, 0, 0); mc.restore(); }
  }
  refreshLayersPanel(); render();
};

/* ---------------- Цвет ---------------- */
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = parseInt(m ? m[1] : 'ffffff', 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0; const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = t => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

function setFg(hex) {
  QW.fg = hex;
  $('#fg-box').style.background = hex;
  $('#color-picker').value = hex;
  const [r, g, b] = hexToRgb(hex);
  $('#cs-r').value = r; $('#cs-g').value = g; $('#cs-b').value = b;
  $('#cs-rv').textContent = r; $('#cs-gv').textContent = g; $('#cs-bv').textContent = b;
}
function setBg(hex) { QW.bg = hex; $('#bg-box').style.background = hex; }

$('#color-picker').addEventListener('input', e => setFg(e.target.value));
$('#color-swap').onclick = () => { const t = QW.fg; setFg(QW.bg); setBg(t); };
$('#color-default').onclick = () => { setFg('#ffffff'); setBg('#000000'); };
['r', 'g', 'b'].forEach(k => {
  $('#cs-' + k).addEventListener('input', () => {
    setFg(rgbToHex(+$('#cs-r').value, +$('#cs-g').value, +$('#cs-b').value));
  });
});

const SWATCH_COLORS = ['#ffffff', '#000000', '#7c5cff', '#22d3ee', '#ff5c7a', '#ffb020', '#3ddc84', '#ff6d00',
  '#e0e0e0', '#808080', '#404040', '#c0c0ff', '#ffd54f', '#a5d6a7', '#90caf9', '#f48fb1',
  '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#8b4513', '#4b0082'];
{
  const sw = $('#swatches');
  SWATCH_COLORS.forEach(c => {
    const d = document.createElement('div');
    d.className = 'swatch'; d.style.background = c;
    d.onclick = () => setFg(c);
    d.oncontextmenu = e => { e.preventDefault(); setBg(c); };
    sw.appendChild(d);
  });
}

/* ---------------- Выделение ---------------- */
function clearSelection() { QW.selPath = null; QW.selMask = null; render(); }
function selectAll() {
  const p = new Path2D();
  p.rect(0, 0, QW.doc.w, QW.doc.h);
  QW.selPath = p; QW.selMask = null; render();
}
function invertSelection() {
  const m = document.createElement('canvas');
  m.width = QW.doc.w; m.height = QW.doc.h;
  const mc = m.getContext('2d');
  mc.fillStyle = '#fff'; mc.fillRect(0, 0, m.width, m.height);
  mc.globalCompositeOperation = 'destination-out';
  if (QW.selPath) { mc.fill(QW.selPath); }
  else if (QW.selMask) mc.drawImage(QW.selMask, 0, 0);
  QW.selMask = m; QW.selPath = null; render();
}

function magicWandSelect(sx, sy, tol) {
  const layer = activeLayer(); if (!layer) return;
  const w = layer.canvas.width, h = layer.canvas.height;
  const data = layer.canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const mask = document.createElement('canvas');
  mask.width = w; mask.height = h;
  const mctx = mask.getContext('2d');
  const out = mctx.createImageData(w, h);
  const lx = clamp(Math.round(sx - layer.x), 0, w - 1), ly = clamp(Math.round(sy - layer.y), 0, h - 1);
  const ti = (ly * w + lx) * 4;
  const tr = data[ti], tg = data[ti + 1], tb = data[ti + 2], ta = data[ti + 3];
  const visited = new Uint8Array(w * h);
  const stack = [ly * w + lx];
  const tol2 = tol * tol * 3;
  while (stack.length) {
    const p = stack.pop();
    if (visited[p]) continue;
    visited[p] = 1;
    const i = p * 4;
    const dr = data[i] - tr, dg = data[i + 1] - tg, db = data[i + 2] - tb, da = data[i + 3] - ta;
    if (dr * dr + dg * dg + db * db + da * da > tol2 * 1.6) continue;
    out.data[i] = 255; out.data[i + 1] = 255; out.data[i + 2] = 255; out.data[i + 3] = 255;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w);
    if (y < h - 1) stack.push(p + w);
  }
  mctx.putImageData(out, 0, 0);
  QW.selMask = mask; QW.selPath = null;
  render();
}

/* ---------------- Пиксельные операции ---------------- */
function applyPixelOp(label, fn) {
  const layer = activeLayer();
  if (!layer || layer.locked) return;
  const ctx = layer.canvas.getContext('2d');
  const w = layer.canvas.width, h = layer.canvas.height;
  const before = ctx.getImageData(0, 0, w, h);
  const out = new ImageData(new Uint8ClampedArray(before.data), w, h);
  fn(out.data, w, h);
  if (QW.selMask || QW.selPath) {
    let md;
    if (QW.selMask) {
      md = QW.selMask.getContext('2d').getImageData(0, 0, w, h).data;
    } else {
      const mc = document.createElement('canvas');
      mc.width = w; mc.height = h;
      const mctx = mc.getContext('2d');
      mctx.fillStyle = '#fff'; mctx.fill(QW.selPath);
      md = mctx.getImageData(0, 0, w, h).data;
    }
    const b = before.data, o = out.data;
    for (let i = 0; i < o.length; i += 4) {
      const m = md[i + 3] / 255;
      if (m === 0) { o[i] = b[i]; o[i + 1] = b[i + 1]; o[i + 2] = b[i + 2]; o[i + 3] = b[i + 3]; }
      else if (m < 1) {
        o[i] = b[i] * (1 - m) + o[i] * m;
        o[i + 1] = b[i + 1] * (1 - m) + o[i + 1] * m;
        o[i + 2] = b[i + 2] * (1 - m) + o[i + 2] * m;
        o[i + 3] = b[i + 3] * (1 - m) + o[i + 3] * m;
      }
    }
  }
  ctx.putImageData(out, 0, 0);
  layerPaintEntry(label, layer, before);
  render(); refreshLayersPanel();
}

/* ---------------- Коррекции ---------------- */
function buildLUT(brightness, contrast, exposure, gamma) {
  const lut = new Uint8ClampedArray(256);
  const c = contrast / 100;
  const cf = (259 * (c * 255 + 255)) / (255 * (259 - c * 255));
  const exp = Math.pow(2, exposure / 100);
  for (let i = 0; i < 256; i++) {
    let v = i * exp;
    v = cf * (v - 128) + 128;
    v += brightness * 1.27;
    if (gamma && gamma !== 1) v = 255 * Math.pow(clamp(v, 0, 255) / 255, 1 / gamma);
    lut[i] = clamp(v, 0, 255);
  }
  return lut;
}

function opBrightnessContrast(d, w, h, br, ct, exp) {
  const lut = buildLUT(br, ct, exp || 0);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
  }
}

function opHueSat(d, w, h, hue, sat, light) {
  const sMul = 1 + sat / 100, lAdd = light * 1.27;
  for (let i = 0; i < d.length; i += 4) {
    let [hh, ss, ll] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    hh += hue; ss = clamp(ss * sMul, 0, 1);
    const [r, g, b] = hslToRgb(hh, ss, ll);
    d[i] = clamp(r + lAdd, 0, 255); d[i + 1] = clamp(g + lAdd, 0, 255); d[i + 2] = clamp(b + lAdd, 0, 255);
  }
}

function opVibrance(d, w, h, amt) {
  const k = amt / 100;
  for (let i = 0; i < d.length; i += 4) {
    const mx = Math.max(d[i], d[i + 1], d[i + 2]);
    const avg = (d[i] + d[i + 1] + d[i + 2]) / 3;
    const sat = (mx - avg) / 255;
    const boost = k * (1 - sat) * 0.6;
    d[i] = clamp(d[i] + (d[i] - avg) * boost, 0, 255);
    d[i + 1] = clamp(d[i + 1] + (d[i + 1] - avg) * boost, 0, 255);
    d[i + 2] = clamp(d[i + 2] + (d[i + 2] - avg) * boost, 0, 255);
  }
}

function opTemperature(d, w, h, t) {
  const r = t * 0.8, b = -t * 0.8;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = clamp(d[i] + r, 0, 255);
    d[i + 2] = clamp(d[i + 2] + b, 0, 255);
  }
}

function opColorBalance(d, w, h, r, g, b) {
  for (let i = 0; i < d.length; i += 4) {
    d[i] = clamp(d[i] + r, 0, 255);
    d[i + 1] = clamp(d[i + 1] + g, 0, 255);
    d[i + 2] = clamp(d[i + 2] + b, 0, 255);
  }
}

function opLevels(d, w, h, inB, inW, gamma, outB, outW) {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    let v = clamp((i - inB) / Math.max(1, inW - inB), 0, 1);
    v = Math.pow(v, 1 / gamma);
    lut[i] = clamp(outB + v * (outW - outB), 0, 255);
  }
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
  }
}

function opInvert(d) { for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } }
function opGrayscale(d) {
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
}
function opSepia(d) {
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    d[i] = clamp(r * 0.393 + g * 0.769 + b * 0.189, 0, 255);
    d[i + 1] = clamp(r * 0.349 + g * 0.686 + b * 0.168, 0, 255);
    d[i + 2] = clamp(r * 0.272 + g * 0.534 + b * 0.131, 0, 255);
  }
}
function opThreshold(d, w, h, t) {
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) >= t ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
}
function opPosterize(d, w, h, levels) {
  const step = 255 / (levels - 1);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.round(d[i] / step) * step;
    d[i + 1] = Math.round(d[i + 1] / step) * step;
    d[i + 2] = Math.round(d[i + 2] / step) * step;
  }
}
function opAutoContrast(d) {
  let mn = 255, mx = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    if (v < mn) mn = v; if (v > mx) mx = v;
  }
  if (mx - mn < 10) return;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = clamp((i - mn) * 255 / (mx - mn), 0, 255);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
  }
}

/* ---------------- Свёртка и размытие ---------------- */
function convolve(d, w, h, kernel, ksize, divisor) {
  const src = new Uint8ClampedArray(d);
  const half = (ksize / 2) | 0;
  divisor = divisor || 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let ky = 0; ky < ksize; ky++) for (let kx = 0; kx < ksize; kx++) {
      const px = clamp(x + kx - half, 0, w - 1), py = clamp(y + ky - half, 0, h - 1);
      const i = (py * w + px) * 4, kv = kernel[ky * ksize + kx];
      r += src[i] * kv; g += src[i + 1] * kv; b += src[i + 2] * kv;
    }
    const o = (y * w + x) * 4;
    d[o] = clamp(r / divisor, 0, 255);
    d[o + 1] = clamp(g / divisor, 0, 255);
    d[o + 2] = clamp(b / divisor, 0, 255);
  }
}

function gaussianKernel(radius) {
  const size = radius * 2 + 1;
  const sigma = Math.max(0.8, radius / 2);
  const k = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - radius;
    k[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += k[i];
  }
  for (let i = 0; i < size; i++) k[i] /= sum;
  return k;
}

function gaussianBlurData(d, w, h, radius) {
  radius = Math.round(clamp(radius, 1, 80));
  const k = gaussianKernel(radius);
  const tmp = new Float32Array(d.length);
  // горизонтальный проход
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let i = -radius; i <= radius; i++) {
      const px = clamp(x + i, 0, w - 1);
      const idx = (y * w + px) * 4, kv = k[i + radius];
      r += d[idx] * kv; g += d[idx + 1] * kv; b += d[idx + 2] * kv; a += d[idx + 3] * kv;
    }
    const o = (y * w + x) * 4;
    tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
  }
  // вертикальный проход
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let i = -radius; i <= radius; i++) {
      const py = clamp(y + i, 0, h - 1);
      const idx = (py * w + x) * 4, kv = k[i + radius];
      r += tmp[idx] * kv; g += tmp[idx + 1] * kv; b += tmp[idx + 2] * kv; a += tmp[idx + 3] * kv;
    }
    const o = (y * w + x) * 4;
    d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
  }
}

function motionBlurData(d, w, h, len, angle) {
  const src = new Uint8ClampedArray(d);
  const rad = angle * Math.PI / 180;
  const dx = Math.cos(rad), dy = Math.sin(rad);
  const half = (len / 2) | 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let i = -half; i <= half; i++) {
      const px = clamp(Math.round(x + dx * i), 0, w - 1);
      const py = clamp(Math.round(y + dy * i), 0, h - 1);
      const idx = (py * w + px) * 4;
      r += src[idx]; g += src[idx + 1]; b += src[idx + 2];
    }
    const o = (y * w + x) * 4, n = half * 2 + 1;
    d[o] = r / n; d[o + 1] = g / n; d[o + 2] = b / n;
  }
}

function sharpenAmount(d, w, h, amount) {
  const blurred = new Uint8ClampedArray(d);
  gaussianBlurData(blurred, w, h, 2);
  const k = 1 + amount * 3;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = clamp(d[i] * k - blurred[i] * (k - 1), 0, 255);
    d[i + 1] = clamp(d[i + 1] * k - blurred[i + 1] * (k - 1), 0, 255);
    d[i + 2] = clamp(d[i + 2] * k - blurred[i + 2] * (k - 1), 0, 255);
  }
}

function opNoise(d, w, h, amt) {
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * amt * 2.55;
    d[i] = clamp(d[i] + n, 0, 255);
    d[i + 1] = clamp(d[i + 1] + n, 0, 255);
    d[i + 2] = clamp(d[i + 2] + n, 0, 255);
  }
}

function opPixelate(d, w, h, size) {
  const src = new Uint8ClampedArray(d);
  for (let by = 0; by < h; by += size) for (let bx = 0; bx < w; bx += size) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let y = by; y < Math.min(by + size, h); y++) for (let x = bx; x < Math.min(bx + size, w); x++) {
      const i = (y * w + x) * 4;
      r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
    }
    r /= n; g /= n; b /= n; a /= n;
    for (let y = by; y < Math.min(by + size, h); y++) for (let x = bx; x < Math.min(bx + size, w); x++) {
      const i = (y * w + x) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
    }
  }
}

function opVignette(d, w, h, amt) {
  const cx = w / 2, cy = h / 2;
  const maxD = Math.sqrt(cx * cx + cy * cy);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / maxD;
    const f = 1 - amt * Math.pow(dist, 2.2);
    const i = (y * w + x) * 4;
    d[i] = clamp(d[i] * f, 0, 255);
    d[i + 1] = clamp(d[i + 1] * f, 0, 255);
    d[i + 2] = clamp(d[i + 2] * f, 0, 255);
  }
}

function opOilPaint(d, w, h, radius, levels) {
  const src = new Uint8ClampedArray(d);
  const bins = levels;
  const inten = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    inten[i] = clamp(((src[i * 4] * 0.299 + src[i * 4 + 1] * 0.587 + src[i * 4 + 2] * 0.114) * bins / 256) | 0, 0, bins - 1);
  }
  const cnt = new Uint16Array(bins), sr = new Uint32Array(bins), sg = new Uint32Array(bins), sb = new Uint32Array(bins);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    cnt.fill(0); sr.fill(0); sg.fill(0); sb.fill(0);
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const px = clamp(x + dx, 0, w - 1), py = clamp(y + dy, 0, h - 1);
      const p = py * w + px, bin = inten[p], i = p * 4;
      cnt[bin]++; sr[bin] += src[i]; sg[bin] += src[i + 1]; sb[bin] += src[i + 2];
    }
    let best = 0;
    for (let b = 1; b < bins; b++) if (cnt[b] > cnt[best]) best = b;
    const o = (y * w + x) * 4, n = Math.max(1, cnt[best]);
    d[o] = sr[best] / n; d[o + 1] = sg[best] / n; d[o + 2] = sb[best] / n;
  }
}

function opHalftone(d, w, h, size) {
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  for (let by = 0; by < h; by += size) for (let bx = 0; bx < w; bx += size) {
    let sum = 0, n = 0;
    for (let y = by; y < Math.min(by + size, h); y++) for (let x = bx; x < Math.min(bx + size, w); x++) { sum += gray[y * w + x]; n++; }
    const avg = sum / n / 255;
    const radius = (1 - avg) * size * 0.7;
    const cx = bx + size / 2, cy = by + size / 2;
    for (let y = by; y < Math.min(by + size, h); y++) for (let x = bx; x < Math.min(bx + size, w); x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const v = dist < radius ? 0 : 255;
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
}

/* ============================================================
   ИНСТРУМЕНТЫ
   ============================================================ */
const ICONS = {
  move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2v20M2 12h20M12 2l-3 3m3-3l3 3M12 22l-3-3m3 3l3-3M2 12l3-3m-3 3l3 3M22 12l-3-3m3 3l-3 3"/></svg>',
  hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 11V5a1.5 1.5 0 013 0v5m0-6a1.5 1.5 0 013 0v6m0-5a1.5 1.5 0 013 0v7m0-4a1.5 1.5 0 013 0v4c0 4-2.5 7-6.5 7S7 19 5.5 15.5L4 11c-.5-1.5 1.5-2.5 2.5-1L8 13"/></svg>',
  zoom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10.5" cy="10.5" r="7"/><path d="M16 16l5.5 5.5M8 10.5h5M10.5 8v5"/></svg>',
  eyedrop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 4l6 6-9.5 9.5a2.1 2.1 0 01-3 0l-3-3a2.1 2.1 0 010-3L14 4zm0 0l2-2 6 6-2 2M7 17l-3.5 3.5"/></svg>',
  rectsel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="3 2"><rect x="3" y="4" width="18" height="16" rx="1"/></svg>',
  ellipsesel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="3 2"><ellipse cx="12" cy="12" rx="9" ry="8"/></svg>',
  lasso: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 4C4 6 3 9 4 12s4 6 8 6 8-2 8-6-3-8-8-8c-2 0-4 .8-5 2"/><circle cx="12" cy="20" r="1.6"/></svg>',
  wand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 21L18 9M15 4l1 2m3 1l2 1m-1 4l2 1M13 7l1-2"/></svg>',
  crop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 2v14a2 2 0 002 2h14M2 6h14a2 2 0 012 2v14"/></svg>',
  brush: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 3l4 4-8.5 8.5-4-4L17 3zM8.5 11.5c-2 0-5.5 2-5.5 6.5 0 1.5-1 2.5-2 3 1.5.5 3 .5 4.5.5 4 0 7-2.5 7-6"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 3l4 4L8 20l-5 1 1-5L17 3z"/></svg>',
  eraser: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 21h13M15 4l6 6-8.5 8.5a2.1 2.1 0 01-3 0l-3-3a2.1 2.1 0 010-3L15 4zM5 13l7 7"/></svg>',
  clone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>',
  blur: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3c3 4 6 7 6 11a6 6 0 01-12 0c0-4 3-7 6-11z"/></svg>',
  dodge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>',
  gradient: '<svg viewBox="0 0 24 24"><defs><linearGradient id="tg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><rect x="3" y="5" width="18" height="14" rx="2" fill="url(#tg)" stroke="currentColor" stroke-width="1.5"/></svg>',
  fill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l6 6.5a4.5 4.5 0 11-6 6.5L5 9l7-6zM19 14s2.5 3 2.5 5a2.5 2.5 0 01-5 0c0-2 2.5-5 2.5-5z"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 5V3h14v2M12 3v18m-3 0h6"/></svg>',
  shape: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="10" height="10" rx="1"/><circle cx="16" cy="16" r="5.5"/></svg>'
};

const toolOptsState = {
  wandTol: 32, fillTol: 32, feather: 0,
  dodgeMode: 'dodge', blurMode: 'blur',
  gradType: 'linear',
  shapeType: 'rect', shapeFill: true, shapeStroke: false, shapeStrokeW: 4, shapeSides: 5,
  textFont: 'Segoe UI', textSize: 64, textBold: false, textItalic: false
};

const brushOptsHtml = `
  <label>Размер <input type="range" id="opt-size" min="1" max="500" value="30"> <span id="opt-size-v">30</span></label>
  <label>Жёсткость <input type="range" id="opt-hard" min="0" max="100" value="70"></label>
  <label>Непрозрачность <input type="range" id="opt-op" min="1" max="100" value="100"></label>`;

function bindBrushOpts() {
  const s = $('#opt-size');
  if (!s) return;
  s.value = QW.brush.size; $('#opt-size-v').textContent = QW.brush.size;
  $('#opt-hard').value = QW.brush.hardness * 100;
  $('#opt-op').value = QW.brush.opacity * 100;
  s.oninput = () => { QW.brush.size = +s.value; $('#opt-size-v').textContent = s.value; };
  $('#opt-hard').oninput = e => QW.brush.hardness = e.target.value / 100;
  $('#opt-op').oninput = e => QW.brush.opacity = e.target.value / 100;
}

const TOOLS = {};
function defTool(id, name, key, optsHtml, handlers) {
  TOOLS[id] = { id, name, key, optsHtml, ...handlers };
}

defTool('move', 'Перемещение', 'V', '<span class="hint">Перетаскивайте активный слой. Стрелки — сдвиг на 1 px.</span>', {
  down(x, y) { this.sy = y; this.sx = x; const l = activeLayer(); this.lx = l ? l.x : 0; this.ly = l ? l.y : 0; },
  move(x, y) { const l = activeLayer(); if (!l || l.locked) return; l.x = this.lx + (x - this.sx); l.y = this.ly + (y - this.sy); render(); },
  up() {}
});
defTool('hand', 'Рука', 'H', '<span class="hint">Перетаскивание холста. Временно: удерживайте Пробел.</span>', {
  down(x, y, e, sx, sy) { this.px = sx; this.py = sy; },
  move(x, y, e, sx, sy) { QW.view.ox += sx - this.px; QW.view.oy += sy - this.py; this.px = sx; this.py = sy; render(); },
  up() {}
});
defTool('zoom', 'Масштаб', 'Z', '<span class="hint">Клик — увеличить, Alt+клик — уменьшить. Колесо мыши тоже масштабирует.</span>', {
  down(x, y, e) { zoomAt(e.altKey ? 1 / 1.3 : 1.3, lastScreen.x, lastScreen.y); }, move() {}, up() {}
});
defTool('eyedrop', 'Пипетка', 'I', '<span class="hint">Клик — основной цвет, Alt+клик — фоновый.</span>', {
  down(x, y, e) { pickColor(x, y, e.altKey); },
  move(x, y, e) { if (pointerDown) pickColor(x, y, e.altKey); },
  up() {}
});
defTool('rectsel', 'Прямоугольное выделение', 'M', '<span class="hint">Перетащите рамку. Ctrl+D — снять выделение.</span>', {
  down(x, y) { this.sx = x; this.sy = y; },
  move(x, y) { drawSelPreview(new Path2D(`M${this.sx} ${this.sy} h${x - this.sx} v${y - this.sy} h${-(x - this.sx)} Z`)); },
  up(x, y) {
    if (Math.abs(x - this.sx) < 2 || Math.abs(y - this.sy) < 2) { clearSelection(); return; }
    const p = new Path2D();
    p.rect(Math.min(this.sx, x), Math.min(this.sy, y), Math.abs(x - this.sx), Math.abs(y - this.sy));
    QW.selPath = p; QW.selMask = null; clearPreview(); render();
  }
});
defTool('ellipsesel', 'Овальное выделение', '', '<span class="hint">Перетащите овал выделения.</span>', {
  down(x, y) { this.sx = x; this.sy = y; },
  move(x, y) {
    const p = new Path2D();
    p.ellipse((this.sx + x) / 2, (this.sy + y) / 2, Math.abs(x - this.sx) / 2, Math.abs(y - this.sy) / 2, 0, 0, Math.PI * 2);
    drawSelPreview(p);
  },
  up(x, y) {
    const p = new Path2D();
    p.ellipse((this.sx + x) / 2, (this.sy + y) / 2, Math.abs(x - this.sx) / 2, Math.abs(y - this.sy) / 2, 0, 0, Math.PI * 2);
    QW.selPath = p; QW.selMask = null; clearPreview(); render();
  }
});
defTool('lasso', 'Лассо', 'L', '<span class="hint">Обведите область от руки.</span>', {
  down(x, y) { this.pts = [[x, y]]; },
  move(x, y) {
    this.pts.push([x, y]);
    const p = new Path2D();
    p.moveTo(this.pts[0][0], this.pts[0][1]);
    this.pts.forEach(pt => p.lineTo(pt[0], pt[1]));
    drawSelPreview(p);
  },
  up() {
    if (this.pts.length < 3) { clearSelection(); return; }
    const p = new Path2D();
    p.moveTo(this.pts[0][0], this.pts[0][1]);
    this.pts.forEach(pt => p.lineTo(pt[0], pt[1]));
    p.closePath();
    QW.selPath = p; QW.selMask = null; clearPreview(); render();
  }
});
defTool('wand', 'Волшебная палочка', 'W',
  '<label>Допуск <input type="range" id="opt-wtol" min="1" max="150" value="32"> <span id="opt-wtol-v">32</span></label><span class="hint">Клик по цвету выделяет похожие пиксели.</span>', {
  init() { $('#opt-wtol').oninput = e => { toolOptsState.wandTol = +e.target.value; $('#opt-wtol-v').textContent = e.target.value; }; },
  down(x, y) { magicWandSelect(x, y, toolOptsState.wandTol); }, move() {}, up() {}
});
defTool('crop', 'Кадрирование', 'C', '<span class="hint">Выделите область и нажмите Enter для кадрирования, Esc — отмена.</span>', {
  down(x, y) { this.sx = x; this.sy = y; this.done = false; },
  move(x, y) {
    const self = this;
    window.__previewShape = (ctx) => {
      const [ax, ay] = docToScreen(Math.min(self.sx, x), Math.min(self.sy, y));
      const [bx, by] = docToScreen(Math.max(self.sx, x), Math.max(self.sy, y));
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.fillRect(0, 0, view.width, view.height);
      ctx.clearRect(ax, ay, bx - ax, by - ay);
      ctx.restore();
      render.cropBox = [Math.min(self.sx, x), Math.min(self.sy, y), Math.abs(x - self.sx), Math.abs(y - self.sy)];
      ctx.save();
      ctx.strokeStyle = '#22d3ee'; ctx.setLineDash([5, 4]);
      ctx.strokeRect(ax, ay, bx - ax, by - ay);
      ctx.restore();
      const cb = render.cropBox;
      drawChecker(ctx, ax, ay, bx - ax, by - ay, 12);
      ctx.save();
      ctx.translate(-docToScreen(0, 0)[0] + ax - cb[0] * QW.view.zoom, -docToScreen(0, 0)[1] + ay - cb[1] * QW.view.zoom);
      const [ox, oy] = docToScreen(0, 0);
      ctx.restore();
      // Перерисуем содержимое внутри рамки
      ctx.save();
      ctx.beginPath(); ctx.rect(ax, ay, bx - ax, by - ay); ctx.clip();
      const z = QW.view.zoom;
      ctx.translate(docToScreen(0, 0)[0], docToScreen(0, 0)[1]);
      ctx.scale(z, z);
      compositeTo(ctx, QW.doc.w, QW.doc.h);
      ctx.restore();
    };
    render();
  },
  up() {}
});
defTool('brush', 'Кисть', 'B', brushOptsHtml, {
  init: bindBrushOpts,
  down(x, y) { startStroke('brush'); stampAt(x, y); },
  move(x, y) { lineTo(x, y); },
  up() { endStroke('Кисть'); }
});
defTool('pencil', 'Карандаш', '', brushOptsHtml, {
  init: bindBrushOpts,
  down(x, y) { startStroke('pencil'); stampAt(x, y); },
  move(x, y) { lineTo(x, y); },
  up() { endStroke('Карандаш'); }
});
defTool('eraser', 'Ластик', 'E', brushOptsHtml, {
  init: bindBrushOpts,
  down(x, y) { startStroke('eraser'); stampAt(x, y); },
  move(x, y) { lineTo(x, y); },
  up() { endStroke('Ластик'); }
});
defTool('clone', 'Штамп', 'S', brushOptsHtml + '<span class="hint">Alt+клик — источник.</span>', {
  init: bindBrushOpts,
  down(x, y, e) {
    if (e.altKey) { cloneSrc = { x, y }; return; }
    if (!cloneSrc) return;
    startStroke('clone');
    cloneOff = { x: cloneSrc.x - x, y: cloneSrc.y - y };
    stampAt(x, y);
  },
  move(x, y) { if (stroke) lineTo(x, y); },
  up() { endStroke('Штамп'); }
});
defTool('blur', 'Размытие/Резкость', 'R',
  `<label>Режим <select id="opt-bmode"><option value="blur">Размытие</option><option value="sharpen">Резкость</option></select></label>` + brushOptsHtml, {
  init() { bindBrushOpts(); $('#opt-bmode').onchange = e => toolOptsState.blurMode = e.target.value; },
  down(x, y) { startStroke('fx'); stampAt(x, y); },
  move(x, y) { lineTo(x, y); },
  up() { endStroke('Размытие/Резкость'); }
});
defTool('dodge', 'Осветлитель/Затемнитель', 'O',
  `<label>Режим <select id="opt-dmode"><option value="dodge">Осветление</option><option value="burn">Затемнение</option></select></label>` + brushOptsHtml, {
  init() { bindBrushOpts(); $('#opt-dmode').onchange = e => toolOptsState.dodgeMode = e.target.value; },
  down(x, y) { startStroke('fx'); stampAt(x, y); },
  move(x, y) { lineTo(x, y); },
  up() { endStroke('Осветление/Затемнение'); }
});
defTool('gradient', 'Градиент', 'G',
  `<label>Тип <select id="opt-gtype"><option value="linear">Линейный</option><option value="radial">Радиальный</option></select></label><span class="hint">Перетащите линию градиента (основной → фоновый).</span>`, {
  init() { $('#opt-gtype').onchange = e => toolOptsState.gradType = e.target.value; },
  down(x, y) { this.sx = x; this.sy = y; },
  move(x, y) {
    const self = this;
    window.__previewShape = ctx => {
      const [ax, ay] = docToScreen(self.sx, self.sy);
      const [bx, by] = docToScreen(x, y);
      ctx.save(); ctx.strokeStyle = '#22d3ee'; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.restore();
    };
    render();
  },
  up(x, y) {
    clearPreview();
    const layer = activeLayer(); if (!layer || layer.locked) return;
    const ctx = layer.canvas.getContext('2d');
    const before = ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
    ctx.save();
    if (QW.selPath) ctx.clip(QW.selPath);
    let g;
    if (toolOptsState.gradType === 'radial') {
      const r = Math.hypot(x - this.sx, y - this.sy) || 1;
      g = ctx.createRadialGradient(this.sx, this.sy, 0, this.sx, this.sy, r);
    } else {
      g = ctx.createLinearGradient(this.sx, this.sy, x, y);
    }
    g.addColorStop(0, QW.fg); g.addColorStop(1, QW.bg);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
    ctx.restore();
    layerPaintEntry('Градиент', layer, before);
    render(); refreshLayersPanel();
  }
});
defTool('fill', 'Заливка', '',
  '<label>Допуск <input type="range" id="opt-ftol" min="0" max="150" value="32"> <span id="opt-ftol-v">32</span></label><span class="hint">Клик — заливка области. Shift+клик — весь слой. Alt — фоновым цветом.</span>', {
  init() { $('#opt-ftol').oninput = e => { toolOptsState.fillTol = +e.target.value; $('#opt-ftol-v').textContent = e.target.value; }; },
  down(x, y, e) { floodFill(x, y, e.altKey ? QW.bg : QW.fg, e.shiftKey ? -1 : toolOptsState.fillTol); },
  move() {}, up() {}
});
defTool('text', 'Текст', 'T',
  `<label>Шрифт <select id="opt-tfont"><option>Segoe UI</option><option>Arial</option><option>Times New Roman</option><option>Courier New</option><option>Georgia</option><option>Impact</option><option>Verdana</option></select></label>
   <label>Размер <input type="number" id="opt-tsize" value="64" min="6" max="800"></label>
   <label><input type="checkbox" id="opt-tbold"> Жирный</label>
   <label><input type="checkbox" id="opt-titalic"> Курсив</label>`, {
  init() {
    $('#opt-tfont').onchange = e => toolOptsState.textFont = e.target.value;
    $('#opt-tsize').onchange = e => toolOptsState.textSize = +e.target.value;
    $('#opt-tbold').onchange = e => toolOptsState.textBold = e.target.checked;
    $('#opt-titalic').onchange = e => toolOptsState.textItalic = e.target.checked;
  },
  down(x, y) {
    showModal('Текст', `<label>Текст <input id="m-text" value="Текст"></label>`, m => {
      const t = m.querySelector('#m-text').value;
      if (!t) return;
      const l = addLayer('Текст: ' + t.slice(0, 16), true);
      const ctx = l.canvas.getContext('2d');
      ctx.font = `${toolOptsState.textItalic ? 'italic ' : ''}${toolOptsState.textBold ? 'bold ' : ''}${toolOptsState.textSize}px "${toolOptsState.textFont}"`;
      ctx.fillStyle = QW.fg;
      ctx.textBaseline = 'top';
      ctx.fillText(t, x, y);
      pushHistory({
        label: 'Текст',
        undo: () => { const i = QW.doc.layers.indexOf(l); QW.doc.layers.splice(i, 1); QW.doc.active = Math.max(0, i - 1); afterStruct(); },
        redo: () => { QW.doc.layers.splice(QW.doc.active + 1, 0, l); QW.doc.active++; afterStruct(); }
      });
      afterStruct();
    }, 'Добавить');
  },
  move() {}, up() {}
});
defTool('shape', 'Фигуры', 'U',
  `<label>Фигура <select id="opt-shape"><option value="rect">Прямоугольник</option><option value="ellipse">Эллипс</option><option value="line">Линия</option><option value="poly">Многоугольник</option></select></label>
   <label><input type="checkbox" id="opt-sfill" checked> Заливка</label>
   <label><input type="checkbox" id="opt-sstroke"> Обводка</label>
   <label>Толщина <input type="number" id="opt-swidth" value="4" min="1" max="100"></label>
   <label>Сторон <input type="number" id="opt-ssides" value="5" min="3" max="24"></label>`, {
  init() {
    $('#opt-shape').onchange = e => toolOptsState.shapeType = e.target.value;
    $('#opt-sfill').onchange = e => toolOptsState.shapeFill = e.target.checked;
    $('#opt-sstroke').onchange = e => toolOptsState.shapeStroke = e.target.checked;
    $('#opt-swidth').onchange = e => toolOptsState.shapeStrokeW = +e.target.value;
    $('#opt-ssides').onchange = e => toolOptsState.shapeSides = +e.target.value;
  },
  down(x, y) { this.sx = x; this.sy = y; },
  move(x, y) {
    const self = this;
    window.__previewShape = ctx => {
      ctx.save();
      ctx.translate(QW.view.ox, QW.view.oy);
      ctx.scale(QW.view.zoom, QW.view.zoom);
      ctx.lineWidth = 1.5 / QW.view.zoom;
      ctx.strokeStyle = '#22d3ee';
      ctx.stroke(shapePath(self.sx, self.sy, x, y));
      ctx.restore();
    };
    render();
  },
  up(x, y) {
    clearPreview();
    const layer = activeLayer(); if (!layer || layer.locked) return;
    if (Math.abs(x - this.sx) < 2 && Math.abs(y - this.sy) < 2) return;
    const ctx = layer.canvas.getContext('2d');
    const before = ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
    ctx.save();
    if (QW.selPath) ctx.clip(QW.selPath);
    const p = shapePath(this.sx, this.sy, x, y);
    if (toolOptsState.shapeFill) { ctx.fillStyle = QW.fg; ctx.fill(p); }
    if (toolOptsState.shapeStroke || toolOptsState.shapeType === 'line') {
      ctx.strokeStyle = toolOptsState.shapeFill && toolOptsState.shapeStroke ? QW.bg : QW.fg;
      ctx.lineWidth = toolOptsState.shapeStrokeW;
      ctx.stroke(p);
    }
    ctx.restore();
    layerPaintEntry('Фигура', layer, before);
    render(); refreshLayersPanel();
  }
});

function shapePath(x1, y1, x2, y2) {
  const p = new Path2D();
  const t = toolOptsState.shapeType;
  if (t === 'rect') p.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  else if (t === 'ellipse') p.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
  else if (t === 'line') { p.moveTo(x1, y1); p.lineTo(x2, y2); }
  else if (t === 'poly') {
    const n = toolOptsState.shapeSides;
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + i * 2 * Math.PI / n;
      const px = cx + Math.cos(a) * rx, py = cy + Math.sin(a) * ry;
      i ? p.lineTo(px, py) : p.moveTo(px, py);
    }
    p.closePath();
  }
  return p;
}

/* ---------------- Механика мазков ---------------- */
let stroke = null, cloneSrc = null, cloneOff = null;
let stampCache = null;

function getStamp(erase, pencil) {
  const size = QW.brush.size;
  const hard = pencil ? 1 : QW.brush.hardness;
  const key = `${size}|${hard}|${QW.fg}|${QW.brush.opacity}|${erase}`;
  if (stampCache && stampCache.key === key) return stampCache.c;
  const c = document.createElement('canvas');
  c.width = c.height = Math.max(2, size);
  const ctx = c.getContext('2d');
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, Math.max(0.1, r * hard * 0.99), r, r, r);
  const col = erase ? '0,0,0' : hexToRgb(QW.fg).join(',');
  g.addColorStop(0, `rgba(${col},${QW.brush.opacity})`);
  g.addColorStop(1, `rgba(${col},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  stampCache = { key, c };
  return c;
}

function startStroke(kind) {
  const layer = activeLayer();
  if (!layer || layer.locked) return;
  const ctx = layer.canvas.getContext('2d');
  stroke = {
    kind, layer, ctx,
    before: ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height),
    lastX: null, lastY: null
  };
}

function stampAt(x, y) {
  if (!stroke) return;
  const { ctx, layer, kind } = stroke;
  const size = QW.brush.size, r = size / 2;
  const lx = x - layer.x, ly = y - layer.y;
  ctx.save();
  if (QW.selPath) { ctx.translate(-layer.x, -layer.y); ctx.clip(QW.selPath); ctx.translate(layer.x, layer.y); }

  if (kind === 'brush' || kind === 'pencil' || kind === 'eraser') {
    ctx.globalCompositeOperation = kind === 'eraser' ? 'destination-out' : 'source-over';
    const st = getStamp(kind === 'eraser', kind === 'pencil');
    ctx.drawImage(st, lx - r, ly - r);
  } else if (kind === 'clone') {
    const sx = lx + cloneOff.x - r, sy = ly + cloneOff.y - r;
    ctx.save();
    ctx.beginPath(); ctx.arc(lx, ly, r, 0, Math.PI * 2); ctx.clip();
    ctx.globalAlpha = QW.brush.opacity;
    ctx.drawImage(layer.canvas, sx, sy, size, size, lx - r, ly - r, size, size);
    ctx.restore();
  } else if (kind === 'fx') {
    const bx = clamp(Math.round(lx - r), 0, layer.canvas.width - 1);
    const by = clamp(Math.round(ly - r), 0, layer.canvas.height - 1);
    const bw = clamp(Math.round(size), 1, layer.canvas.width - bx);
    const bh = clamp(Math.round(size), 1, layer.canvas.height - by);
    const img = ctx.getImageData(bx, by, bw, bh);
    if (QW.tool === 'dodge') {
      const k = QW.brush.opacity * 0.15;
      const dod = toolOptsState.dodgeMode === 'dodge';
      for (let i = 0; i < img.data.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          const v = img.data[i + c];
          img.data[i + c] = dod ? clamp(v + (255 - v) * k, 0, 255) : clamp(v * (1 - k), 0, 255);
        }
      }
    } else {
      if (toolOptsState.blurMode === 'blur') gaussianBlurData(img.data, bw, bh, Math.max(1, size / 12));
      else sharpenAmount(img.data, bw, bh, 0.4);
    }
    // Круглая маска мазка
    const masked = ctx.getImageData(bx, by, bw, bh);
    for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) {
      const d = Math.hypot(xx - (lx - bx), yy - (ly - by)) / r;
      if (d > 1) continue;
      const m = (1 - d) * QW.brush.opacity;
      const i = (yy * bw + xx) * 4;
      for (let c = 0; c < 4; c++) masked.data[i + c] = masked.data[i + c] * (1 - m) + img.data[i + c] * m;
    }
    ctx.putImageData(masked, bx, by);
  }
  ctx.restore();
  render();
}

function lineTo(x, y) {
  if (!stroke) return;
  if (stroke.lastX === null) { stampAt(x, y); stroke.lastX = x; stroke.lastY = y; return; }
  const dist = Math.hypot(x - stroke.lastX, y - stroke.lastY);
  const step = Math.max(1, QW.brush.size * 0.18);
  const n = Math.ceil(dist / step);
  for (let i = 1; i <= n; i++) {
    stampAt(stroke.lastX + (x - stroke.lastX) * i / n, stroke.lastY + (y - stroke.lastY) * i / n);
  }
  stroke.lastX = x; stroke.lastY = y;
}

function endStroke(label) {
  if (!stroke) return;
  layerPaintEntry(label, stroke.layer, stroke.before);
  stroke = null;
  refreshLayersPanel();
}

/* Пипетка */
function pickColor(x, y, toBg) {
  const c = document.createElement('canvas');
  c.width = QW.doc.w; c.height = QW.doc.h;
  const ctx = c.getContext('2d');
  compositeTo(ctx, QW.doc.w, QW.doc.h);
  const d = ctx.getImageData(clamp(Math.round(x), 0, c.width - 1), clamp(Math.round(y), 0, c.height - 1), 1, 1).data;
  const hex = rgbToHex(d[0], d[1], d[2]);
  if (toBg) setBg(hex); else setFg(hex);
}

/* Заливка */
function floodFill(x, y, color, tol) {
  const layer = activeLayer(); if (!layer || layer.locked) return;
  const ctx = layer.canvas.getContext('2d');
  const w = layer.canvas.width, h = layer.canvas.height;
  const before = ctx.getImageData(0, 0, w, h);
  const [fr, fg2, fb] = hexToRgb(color);
  if (tol < 0) {
    ctx.save();
    if (QW.selPath) ctx.clip(QW.selPath);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    layerPaintEntry('Заливка', layer, before);
    render(); refreshLayersPanel();
    return;
  }
  const data = before.data;
  const out = new ImageData(new Uint8ClampedArray(data), w, h);
  const lx = clamp(Math.round(x - layer.x), 0, w - 1), ly = clamp(Math.round(y - layer.y), 0, h - 1);
  const ti = (ly * w + lx) * 4;
  const tr = data[ti], tg = data[ti + 1], tb = data[ti + 2], ta = data[ti + 3];
  const tol2 = tol * tol * 4;
  const visited = new Uint8Array(w * h);
  const stack = [ly * w + lx];
  while (stack.length) {
    const p = stack.pop();
    if (visited[p]) continue;
    visited[p] = 1;
    const i = p * 4;
    const dr = data[i] - tr, dg = data[i + 1] - tg, db = data[i + 2] - tb, da = data[i + 3] - ta;
    if (dr * dr + dg * dg + db * db + da * da > tol2) continue;
    out.data[i] = fr; out.data[i + 1] = fg2; out.data[i + 2] = fb; out.data[i + 3] = 255;
    const px = p % w, py = (p / w) | 0;
    if (px > 0) stack.push(p - 1);
    if (px < w - 1) stack.push(p + 1);
    if (py > 0) stack.push(p - w);
    if (py < h - 1) stack.push(p + w);
  }
  ctx.putImageData(out, 0, 0);
  layerPaintEntry('Заливка', layer, before);
  render(); refreshLayersPanel();
}

/* Превью выделения */
function drawSelPreview(path) {
  window.__previewShape = ctx => {
    ctx.save();
    ctx.translate(QW.view.ox, QW.view.oy);
    ctx.scale(QW.view.zoom, QW.view.zoom);
    ctx.lineWidth = 1 / QW.view.zoom;
    ctx.setLineDash([5 / QW.view.zoom, 4 / QW.view.zoom]);
    ctx.strokeStyle = '#22d3ee';
    ctx.stroke(path);
    ctx.restore();
  };
  render();
}
function clearPreview() { window.__previewShape = null; }

/* Кадрирование */
function cropDocument(x, y, w, h) {
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  if (w < 2 || h < 2) return;
  const snap = structSnapshot(), act = QW.doc.active;
  const oldW = QW.doc.w, oldH = QW.doc.h;
  for (const l of QW.doc.layers) {
    const nc = document.createElement('canvas');
    nc.width = w; nc.height = h;
    nc.getContext('2d').drawImage(l.canvas, -x, -y);
    l.canvas = nc;
  }
  QW.doc.w = w; QW.doc.h = h;
  clearSelection(); clearPreview();
  const snap2 = structSnapshot(), act2 = QW.doc.active;
  pushHistory({ label: 'Кадрирование', undo: () => { QW.doc.w = oldW; QW.doc.h = oldH; restoreStruct(snap, act); fitToWindow(); }, redo: () => { QW.doc.w = w; QW.doc.h = h; restoreStruct(snap2, act2); fitToWindow(); } });
  fitToWindow(); afterStruct(); updateStatus();
}

/* ============================================================
   ПАНЕЛЬ ИНСТРУМЕНТОВ + СОБЫТИЯ ХОЛСТА
   ============================================================ */
let pointerDown = false;
const lastScreen = { x: 0, y: 0 };

function buildToolbar() {
  const bar = $('#toolbar');
  const order = ['move', 'hand', 'zoom', 'eyedrop', null, 'rectsel', 'ellipsesel', 'lasso', 'wand', 'crop', null,
    'brush', 'pencil', 'eraser', 'clone', 'blur', 'dodge', 'gradient', 'fill', 'text', 'shape'];
  for (const id of order) {
    if (!id) { const s = document.createElement('div'); s.className = 'tool-sep'; bar.appendChild(s); continue; }
    const t = TOOLS[id];
    const b = document.createElement('button');
    b.className = 'tool-btn' + (id === QW.tool ? ' active' : '');
    b.id = 'tool-' + id;
    b.title = `${t.name}${t.key ? ' (' + t.key + ')' : ''}`;
    b.innerHTML = ICONS[id];
    b.onclick = () => setTool(id);
    bar.appendChild(b);
  }
}

function setTool(id) {
  QW.tool = id;
  $$('.tool-btn').forEach(b => b.classList.toggle('active', b.id === 'tool-' + id));
  const t = TOOLS[id];
  const bar = $('#toolopts');
  bar.innerHTML = `<b style="color:var(--accent2)">${t.name}</b>` + (t.optsHtml || '');
  if (t.init) t.init();
  const cursors = { move: 'move', hand: 'grab', zoom: 'zoom-in', brush: 'crosshair', eraser: 'crosshair', text: 'text' };
  view.style.cursor = cursors[id] || 'crosshair';
}

function zoomAt(f, sx, sy) {
  const z0 = QW.view.zoom;
  const z1 = clamp(z0 * f, 0.02, 32);
  QW.view.ox = sx - (sx - QW.view.ox) * (z1 / z0);
  QW.view.oy = sy - (sy - QW.view.oy) * (z1 / z0);
  QW.view.zoom = z1;
  render();
}

view.addEventListener('pointerdown', e => {
  if (QW.mode === 'motion') return;
  if (!QW.doc) return;
  view.setPointerCapture(e.pointerId);
  pointerDown = true;
  const r = view.getBoundingClientRect();
  lastScreen.x = e.clientX - r.left; lastScreen.y = e.clientY - r.top;
  const [x, y] = screenToDoc(lastScreen.x, lastScreen.y);
  const tool = (QW.spacePan || e.button === 1) ? TOOLS.hand : TOOLS[QW.tool];
  tool.down(x, y, e, lastScreen.x, lastScreen.y);
});

view.addEventListener('pointermove', e => {
  const r = view.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  lastScreen.x = sx; lastScreen.y = sy;
  const [x, y] = screenToDoc(sx, sy);
  $('#st-pos').textContent = QW.doc ? `X: ${Math.round(x)}  Y: ${Math.round(y)}` : '';
  if (!pointerDown || QW.mode === 'motion') return;
  const tool = (QW.spacePan || e.buttons === 4) ? TOOLS.hand : TOOLS[QW.tool];
  tool.move(x, y, e, sx, sy);
});

view.addEventListener('pointerup', e => {
  if (!pointerDown) return;
  pointerDown = false;
  if (QW.mode === 'motion') return;
  const r = view.getBoundingClientRect();
  const [x, y] = screenToDoc(e.clientX - r.left, e.clientY - r.top);
  const tool = QW.spacePan ? TOOLS.hand : TOOLS[QW.tool];
  tool.up(x, y, e);
});

view.addEventListener('wheel', e => {
  e.preventDefault();
  const r = view.getBoundingClientRect();
  zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

/* ============================================================
   МЕНЮ
   ============================================================ */
const MENUS = [
  ['Файл', [
    ['Новый документ…', 'Ctrl+N', uiNewDocument],
    ['Открыть изображение…', 'Ctrl+O', openImageAsDoc],
    ['Открыть как слой…', '', openImageAsLayer],
    ['Открыть проект (.qwz)…', '', openProject],
    null,
    ['Сохранить проект (.qwz)', 'Ctrl+S', saveProject],
    ['Экспорт PNG', 'Ctrl+E', () => exportImage('png')],
    ['Экспорт JPG', '', () => exportImage('jpeg')],
    ['Экспорт WebP', '', () => exportImage('webp')]
  ]],
  ['Правка', [
    ['Отменить', 'Ctrl+Z', undo],
    ['Повторить', 'Ctrl+Y', redo],
    null,
    ['Залить основным цветом', 'Shift+F5', () => floodFill(0, 0, QW.fg, -1)],
    ['Залить фоновым цветом', '', () => floodFill(0, 0, QW.bg, -1)],
    ['Очистить слой', 'Del', clearLayer]
  ]],
  ['Изображение', [
    ['Размер изображения…', '', uiResizeImage],
    ['Размер холста…', '', uiResizeCanvas],
    null,
    ['Яркость/Контраст…', '', uiBrightnessContrast],
    ['Уровни…', 'Ctrl+L', uiLevels],
    ['Кривые…', 'Ctrl+M', uiCurves],
    ['Тон/Насыщенность…', 'Ctrl+U', uiHueSat],
    ['Цветовой баланс…', 'Ctrl+B', uiColorBalance],
    ['Автоконтраст', '', () => applyPixelOp('Автоконтраст', opAutoContrast)],
    null,
    ['Обрезать по выделению', '', cropToSelection],
    ['Повернуть на 90° по ч.с.', '', () => rotateDoc(90)],
    ['Повернуть на 90° против ч.с.', '', () => rotateDoc(-90)],
    ['Отразить по горизонтали', '', () => flipDoc(true)],
    ['Отразить по вертикали', '', () => flipDoc(false)]
  ]],
  ['Слой', [
    ['Новый слой', 'Ctrl+Shift+N', () => addLayer()],
    ['Дублировать слой', 'Ctrl+J', () => $('#lb-dup').click()],
    ['Удалить слой', '', () => $('#lb-del').click()],
    ['Добавить/убрать маску', '', () => $('#lb-mask').click()],
    null,
    ['Объединить с нижним', 'Ctrl+E', () => $('#lb-merge').click()],
    ['Свести все слои', '', flattenAll],
    null,
    ['Трансформировать слой…', 'Ctrl+T', uiTransformLayer]
  ]],
  ['Выделение', [
    ['Выделить всё', 'Ctrl+A', selectAll],
    ['Снять выделение', 'Ctrl+D', clearSelection],
    ['Инвертировать выделение', 'Ctrl+Shift+I', invertSelection]
  ]],
  ['Фильтры', [
    ['Размытие по Гауссу…', '', () => uiNum('Размытие по Гауссу', 'Радиус, px', 5, 1, 80, v => applyPixelOp('Гауссово размытие', (d, w, h) => gaussianBlurData(d, w, h, v)))],
    ['Размытие в движении…', '', () => uiNum2('Размытие в движении', ['Длина, px', 20, 2, 200], ['Угол, °', 0, -180, 180], (a, b) => applyPixelOp('Размытие в движении', (d, w, h) => motionBlurData(d, w, h, a, b)))],
    ['Радиальное (zoom) размытие…', '', () => uiNum('Радиальное размытие', 'Сила', 10, 2, 40, v => zoomBlurFilter(v))],
    null,
    ['Резкость', '', () => applyPixelOp('Резкость', (d, w, h) => convolve(d, w, h, [0, -1, 0, -1, 5, -1, 0, -1, 0], 3))],
    ['Контурная резкость…', '', () => uiNum('Контурная резкость', 'Эффект, %', 50, 1, 100, v => applyPixelOp('Контурная резкость', (d, w, h) => sharpenAmount(d, w, h, v / 100)))],
    null,
    ['Тиснение', '', () => applyPixelOp('Тиснение', (d, w, h) => convolve(d, w, h, [-2, -1, 0, -1, 1, 1, 0, 1, 2], 3))],
    ['Выделение краёв', '', () => applyPixelOp('Выделение краёв', (d, w, h) => convolve(d, w, h, [-1, -1, -1, -1, 8, -1, -1, -1, -1], 3))],
    ['Масляная живопись…', '', () => uiNum('Масляная живопись', 'Радиус', 3, 1, 8, v => applyPixelOp('Масляная живопись', (d, w, h) => opOilPaint(d, w, h, v, 16)))],
    ['Полутон (растр)…', '', () => uiNum('Полутон', 'Размер точки, px', 6, 2, 30, v => applyPixelOp('Полутон', (d, w, h) => opHalftone(d, w, h, v)))],
    null,
    ['Шум…', '', () => uiNum('Добавить шум', 'Количество, %', 15, 1, 100, v => applyPixelOp('Шум', (d, w, h) => opNoise(d, w, h, v)))],
    ['Пикселизация…', '', () => uiNum('Пикселизация', 'Размер блока, px', 10, 2, 100, v => applyPixelOp('Пикселизация', (d, w, h) => opPixelate(d, w, h, v)))],
    ['Виньетка…', '', () => uiNum('Виньетка', 'Сила, %', 50, 1, 100, v => applyPixelOp('Виньетка', (d, w, h) => opVignette(d, w, h, v / 100)))],
    null,
    ['Инверсия', 'Ctrl+I', () => applyPixelOp('Инверсия', opInvert)],
    ['Чёрно-белое', '', () => applyPixelOp('Ч/Б', opGrayscale)],
    ['Сепия', '', () => applyPixelOp('Сепия', opSepia)],
    ['Порог…', '', () => uiNum('Порог', 'Уровень', 128, 0, 255, v => applyPixelOp('Порог', (d, w, h) => opThreshold(d, w, h, v)))],
    ['Постеризация…', '', () => uiNum('Постеризация', 'Уровней', 4, 2, 32, v => applyPixelOp('Постеризация', (d, w, h) => opPosterize(d, w, h, v)))]
  ]],
  ['Вид', [
    ['Увеличить', 'Ctrl++', () => zoomAt(1.3, view.clientWidth / 2, view.clientHeight / 2)],
    ['Уменьшить', 'Ctrl+-', () => zoomAt(1 / 1.3, view.clientWidth / 2, view.clientHeight / 2)],
    ['По размеру окна', 'Ctrl+0', () => { fitToWindow(); render(); }],
    ['100%', 'Ctrl+1', () => { QW.view.zoom = 1; const ws = $('#workspace'); QW.view.ox = (ws.clientWidth - QW.doc.w) / 2; QW.view.oy = (ws.clientHeight - QW.doc.h) / 2; render(); }]
  ]],
  ['Справка', [
    ['О программе QWIZERO Studio', '', () => showModal('QWIZERO Studio 1.0', '<p style="line-height:1.7;color:var(--dim)">Профессиональный редактор изображений и моушн-графики.<br><br>Режим <b>Фото</b> — слои, маски, 20+ инструментов, фильтры и коррекции.<br>Режим <b>Моушн</b> — композиции, таймлайн, ключевые кадры, экспорт видео.<br><br>© QWIZERO</p>', null, 'Закрыть')]
  ]]
];

function buildMenus() {
  const nav = $('#menus');
  MENUS.forEach(([title, items]) => {
    const root = document.createElement('div');
    root.className = 'menu-root';
    const btn = document.createElement('button');
    btn.textContent = title;
    const drop = document.createElement('div');
    drop.className = 'menu-drop';
    items.forEach(it => {
      if (!it) { const s = document.createElement('div'); s.className = 'menu-sep'; drop.appendChild(s); return; }
      const [label, sc, fn] = it;
      const d = document.createElement('div');
      d.className = 'menu-item';
      d.innerHTML = `<span>${label}</span><span class="sc">${sc || ''}</span>`;
      d.onclick = () => { $$('.menu-root').forEach(m => m.classList.remove('open')); fn(); };
      drop.appendChild(d);
    });
    btn.onclick = e => {
      e.stopPropagation();
      const was = root.classList.contains('open');
      $$('.menu-root').forEach(m => m.classList.remove('open'));
      if (!was) root.classList.add('open');
    };
    root.append(btn, drop);
    nav.appendChild(root);
  });
  document.addEventListener('click', () => $$('.menu-root').forEach(m => m.classList.remove('open')));
}

/* ---------- Диалоги числовых параметров ---------- */
function uiNum(title, label, def, min, max, fn) {
  showModal(title, `<label>${label} <input type="number" id="m-n" value="${def}" min="${min}" max="${max}"></label>`, m => {
    fn(clamp(+m.querySelector('#m-n').value, min, max));
  }, 'Применить');
}
function uiNum2(title, [l1, d1, mn1, mx1], [l2, d2, mn2, mx2], fn) {
  showModal(title,
    `<label>${l1} <input type="number" id="m-a" value="${d1}" min="${mn1}" max="${mx1}"></label>
     <label>${l2} <input type="number" id="m-b" value="${d2}" min="${mn2}" max="${mx2}"></label>`, m => {
    fn(clamp(+m.querySelector('#m-a').value, mn1, mx1), clamp(+m.querySelector('#m-b').value, mn2, mx2));
  }, 'Применить');
}

function zoomBlurFilter(strength) {
  const layer = activeLayer(); if (!layer || layer.locked) return;
  const ctx = layer.canvas.getContext('2d');
  const before = ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
  const tmp = document.createElement('canvas');
  tmp.width = layer.canvas.width; tmp.height = layer.canvas.height;
  const tc = tmp.getContext('2d');
  tc.drawImage(layer.canvas, 0, 0);
  const w = layer.canvas.width, h = layer.canvas.height;
  ctx.save();
  ctx.globalAlpha = 1 / strength;
  for (let i = 1; i <= strength; i++) {
    const s = 1 + i * 0.012;
    ctx.drawImage(tmp, w / 2 - w * s / 2, h / 2 - h * s / 2, w * s, h * s);
  }
  ctx.restore();
  layerPaintEntry('Радиальное размытие', layer, before);
  render(); refreshLayersPanel();
}

/* ---------- Диалоги коррекций ---------- */
function uiBrightnessContrast() {
  showModal('Яркость / Контраст', `
    <label>Яркость <input type="range" id="m-br" min="-100" max="100" value="0"></label>
    <label>Контраст <input type="range" id="m-ct" min="-100" max="100" value="0"></label>
    <label>Экспозиция <input type="range" id="m-ex" min="-100" max="100" value="0"></label>`, m => {
    applyPixelOp('Яркость/Контраст', (d, w, h) => opBrightnessContrast(d, w, h,
      +m.querySelector('#m-br').value, +m.querySelector('#m-ct').value, +m.querySelector('#m-ex').value));
  }, 'Применить');
}
function uiLevels() {
  showModal('Уровни', `
    <label>Входная чёрная точка <input type="number" id="m-ib" value="0" min="0" max="254"></label>
    <label>Входная белая точка <input type="number" id="m-iw" value="255" min="1" max="255"></label>
    <label>Гамма <input type="number" id="m-g" value="1" min="0.1" max="9.9" step="0.1"></label>
    <label>Выходной чёрный <input type="number" id="m-ob" value="0" min="0" max="255"></label>
    <label>Выходной белый <input type="number" id="m-ow" value="255" min="0" max="255"></label>`, m => {
    const ib = +m.querySelector('#m-ib').value, iw = +m.querySelector('#m-iw').value,
      g = +m.querySelector('#m-g').value, ob = +m.querySelector('#m-ob').value, ow = +m.querySelector('#m-ow').value;
    applyPixelOp('Уровни', (d, w, h) => opLevels(d, w, h, ib, iw, g, ob, ow));
  }, 'Применить');
}
function uiCurves() {
  const pts = [[0, 0], [255, 255]];
  showModal('Кривые', `<canvas id="curve-canvas" width="256" height="256"></canvas>
    <p class="hint">Клик — добавить точку. Перетаскивание — двигать. Двойной клик по точке — удалить.</p>`, m => {
    pts.sort((a, b) => a[0] - b[0]);
    const lut = new Uint8ClampedArray(256);
    for (let x = 0; x < 256; x++) {
      let i = 0;
      while (i < pts.length - 2 && pts[i + 1][0] < x) i++;
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      lut[x] = clamp(y0 + (y1 - y0) * clamp(t, 0, 1), 0, 255);
    }
    applyPixelOp('Кривые', (d) => {
      for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
    });
  }, 'Применить');
  const cv = $('#curve-canvas'), cc = cv.getContext('2d');
  let drag = -1;
  const draw = () => {
    cc.clearRect(0, 0, 256, 256);
    cc.strokeStyle = '#33333f';
    for (let i = 64; i < 256; i += 64) { cc.beginPath(); cc.moveTo(i, 0); cc.lineTo(i, 256); cc.moveTo(0, i); cc.lineTo(256, i); cc.stroke(); }
    cc.strokeStyle = '#7c5cff'; cc.lineWidth = 2; cc.beginPath();
    pts.sort((a, b) => a[0] - b[0]);
    pts.forEach((p, i) => { const y = 255 - p[1]; i ? cc.lineTo(p[0], y) : cc.moveTo(p[0], y); });
    cc.stroke();
    cc.fillStyle = '#22d3ee';
    pts.forEach(p => { cc.beginPath(); cc.arc(p[0], 255 - p[1], 5, 0, Math.PI * 2); cc.fill(); });
  };
  const pos = e => { const r = cv.getBoundingClientRect(); return [clamp(e.clientX - r.left, 0, 255), clamp(255 - (e.clientY - r.top), 0, 255)]; };
  cv.addEventListener('pointerdown', e => {
    const [x, y] = pos(e);
    drag = pts.findIndex(p => Math.hypot(p[0] - x, p[1] - y) < 10);
    if (drag < 0) { pts.push([x, y]); pts.sort((a, b) => a[0] - b[0]); drag = pts.findIndex(p => p[0] === x && p[1] === y); }
    cv.setPointerCapture(e.pointerId);
    draw();
  });
  cv.addEventListener('pointermove', e => {
    if (drag < 0) return;
    const [x, y] = pos(e);
    if (drag === 0) pts[drag] = [0, y];
    else if (drag === pts.length - 1) pts[drag] = [255, y];
    else pts[drag] = [x, y];
    draw();
  });
  cv.addEventListener('pointerup', () => { drag = -1; pts.sort((a, b) => a[0] - b[0]); draw(); });
  cv.addEventListener('dblclick', e => {
    const [x, y] = pos(e);
    const i = pts.findIndex(p => Math.hypot(p[0] - x, p[1] - y) < 10);
    if (i > 0 && i < pts.length - 1) { pts.splice(i, 1); draw(); }
  });
  draw();
}
function uiHueSat() {
  showModal('Тон / Насыщенность', `
    <label>Тон, ° <input type="range" id="m-h" min="-180" max="180" value="0"></label>
    <label>Насыщенность <input type="range" id="m-s" min="-100" max="100" value="0"></label>
    <label>Яркость <input type="range" id="m-l" min="-100" max="100" value="0"></label>`, m => {
    applyPixelOp('Тон/Насыщенность', (d, w, h) => opHueSat(d, w, h,
      +m.querySelector('#m-h').value, +m.querySelector('#m-s').value, +m.querySelector('#m-l').value));
  }, 'Применить');
}
function uiColorBalance() {
  showModal('Цветовой баланс', `
    <label>Красный ↔ Голубой <input type="range" id="m-r" min="-100" max="100" value="0"></label>
    <label>Зелёный ↔ Пурпурный <input type="range" id="m-g" min="-100" max="100" value="0"></label>
    <label>Синий ↔ Жёлтый <input type="range" id="m-b" min="-100" max="100" value="0"></label>`, m => {
    applyPixelOp('Цветовой баланс', (d, w, h) => opColorBalance(d, w, h,
      +m.querySelector('#m-r').value, +m.querySelector('#m-g').value, +m.querySelector('#m-b').value));
  }, 'Применить');
}

/* ---------- Действия меню ---------- */
function uiNewDocument() {
  showModal('Новый документ', `
    <label>Название <input id="m-name" value="Без названия"></label>
    <label>Ширина, px <input type="number" id="m-w" value="1920" min="1" max="16000"></label>
    <label>Высота, px <input type="number" id="m-h" value="1080" min="1" max="16000"></label>
    <label>Фон <select id="m-bg"><option value="">Прозрачный</option><option value="#ffffff">Белый</option><option value="#000000">Чёрный</option></select></label>`, m => {
    newDocument(clamp(+m.querySelector('#m-w').value, 1, 16000), clamp(+m.querySelector('#m-h').value, 1, 16000),
      m.querySelector('#m-name').value, m.querySelector('#m-bg').value || null);
  }, 'Создать');
}

function clearLayer() {
  const l = activeLayer(); if (!l || l.locked) return;
  const ctx = l.canvas.getContext('2d');
  const before = ctx.getImageData(0, 0, l.canvas.width, l.canvas.height);
  ctx.save();
  if (QW.selPath) { ctx.clip(QW.selPath); ctx.clearRect(0, 0, l.canvas.width, l.canvas.height); }
  else ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
  ctx.restore();
  layerPaintEntry('Очистка', l, before);
  render(); refreshLayersPanel();
}

function flattenAll() {
  if (!QW.doc) return;
  const snap = structSnapshot(), act = QW.doc.active;
  const base = makeLayer('Фон', QW.doc.w, QW.doc.h);
  compositeTo(base.canvas.getContext('2d'), QW.doc.w, QW.doc.h);
  QW.doc.layers = [base];
  QW.doc.active = 0;
  const snap2 = structSnapshot();
  pushHistory({ label: 'Сведение слоёв', undo: () => restoreStruct(snap, act), redo: () => restoreStruct(snap2, 0) });
  afterStruct();
}

function cropToSelection() {
  if (!QW.selPath) return;
  const layer = activeLayer();
  const ctx = layer.canvas.getContext('2d');
  // Границы выделения через пробные точки (Path2D не отдаёт bbox)
  let minX = QW.doc.w, minY = QW.doc.h, maxX = 0, maxY = 0, found = false;
  const step = 4;
  for (let y = 0; y < QW.doc.h; y += step) for (let x = 0; x < QW.doc.w; x += step) {
    if (ctx.isPointInPath(QW.selPath, x, y)) {
      found = true;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (!found) return;
  cropDocument(minX, minY, maxX - minX + step, maxY - minY + step);
}

function rotateDoc(angle) {
  const snap = structSnapshot(), act = QW.doc.active;
  const oldW = QW.doc.w, oldH = QW.doc.h;
  for (const l of QW.doc.layers) {
    const nc = document.createElement('canvas');
    nc.width = oldH; nc.height = oldW;
    const c = nc.getContext('2d');
    if (angle > 0) { c.translate(oldH, 0); c.rotate(Math.PI / 2); }
    else { c.translate(0, oldW); c.rotate(-Math.PI / 2); }
    c.drawImage(l.canvas, 0, 0);
    l.canvas = nc;
  }
  QW.doc.w = oldH; QW.doc.h = oldW;
  const snap2 = structSnapshot();
  pushHistory({ label: 'Поворот холста', undo: () => { QW.doc.w = oldW; QW.doc.h = oldH; restoreStruct(snap, act); fitToWindow(); }, redo: () => { QW.doc.w = oldH; QW.doc.h = oldW; restoreStruct(snap2, act); fitToWindow(); } });
  fitToWindow(); afterStruct(); updateStatus();
}

function flipDoc(horiz) {
  const snap = structSnapshot(), act = QW.doc.active;
  for (const l of QW.doc.layers) {
    const nc = document.createElement('canvas');
    nc.width = l.canvas.width; nc.height = l.canvas.height;
    const c = nc.getContext('2d');
    c.translate(horiz ? nc.width : 0, horiz ? 0 : nc.height);
    c.scale(horiz ? -1 : 1, horiz ? 1 : -1);
    c.drawImage(l.canvas, 0, 0);
    l.canvas = nc;
  }
  const snap2 = structSnapshot();
  pushHistory({ label: 'Отражение', undo: () => restoreStruct(snap, act), redo: () => restoreStruct(snap2, act) });
  afterStruct();
}

function uiResizeImage() {
  showModal('Размер изображения', `
    <label>Ширина, px <input type="number" id="m-w" value="${QW.doc.w}" min="1" max="16000"></label>
    <label>Высота, px <input type="number" id="m-h" value="${QW.doc.h}" min="1" max="16000"></label>`, m => {
    const nw = clamp(+m.querySelector('#m-w').value, 1, 16000), nh = clamp(+m.querySelector('#m-h').value, 1, 16000);
    const snap = structSnapshot(), act = QW.doc.active;
    const oldW = QW.doc.w, oldH = QW.doc.h;
    for (const l of QW.doc.layers) {
      const nc = document.createElement('canvas');
      nc.width = nw; nc.height = nh;
      nc.getContext('2d').drawImage(l.canvas, 0, 0, nw, nh);
      l.canvas = nc;
    }
    QW.doc.w = nw; QW.doc.h = nh;
    const snap2 = structSnapshot();
    pushHistory({ label: 'Размер изображения', undo: () => { QW.doc.w = oldW; QW.doc.h = oldH; restoreStruct(snap, act); fitToWindow(); }, redo: () => { QW.doc.w = nw; QW.doc.h = nh; restoreStruct(snap2, act); fitToWindow(); } });
    fitToWindow(); afterStruct(); updateStatus();
  }, 'Изменить');
}

function uiResizeCanvas() {
  showModal('Размер холста', `
    <label>Ширина, px <input type="number" id="m-w" value="${QW.doc.w}" min="1" max="16000"></label>
    <label>Высота, px <input type="number" id="m-h" value="${QW.doc.h}" min="1" max="16000"></label>
    <p class="hint">Слои остаются на месте (якорь — верхний левый угол).</p>`, m => {
    const nw = clamp(+m.querySelector('#m-w').value, 1, 16000), nh = clamp(+m.querySelector('#m-h').value, 1, 16000);
    const snap = structSnapshot(), act = QW.doc.active;
    const oldW = QW.doc.w, oldH = QW.doc.h;
    for (const l of QW.doc.layers) {
      const nc = document.createElement('canvas');
      nc.width = nw; nc.height = nh;
      nc.getContext('2d').drawImage(l.canvas, 0, 0);
      l.canvas = nc;
    }
    QW.doc.w = nw; QW.doc.h = nh;
    const snap2 = structSnapshot();
    pushHistory({ label: 'Размер холста', undo: () => { QW.doc.w = oldW; QW.doc.h = oldH; restoreStruct(snap, act); fitToWindow(); }, redo: () => { QW.doc.w = nw; QW.doc.h = nh; restoreStruct(snap2, act); fitToWindow(); } });
    fitToWindow(); afterStruct(); updateStatus();
  }, 'Изменить');
}

function uiTransformLayer() {
  const l = activeLayer(); if (!l) return;
  showModal('Трансформирование слоя', `
    <label>Сдвиг X, px <input type="number" id="m-x" value="${Math.round(l.x)}"></label>
    <label>Сдвиг Y, px <input type="number" id="m-y" value="${Math.round(l.y)}"></label>
    <label>Масштаб X, % <input type="number" id="m-sx" value="${Math.round(l.scaleX * 100)}"></label>
    <label>Масштаб Y, % <input type="number" id="m-sy" value="${Math.round(l.scaleY * 100)}"></label>
    <label>Поворот, ° <input type="number" id="m-r" value="${Math.round(l.rot)}"></label>`, m => {
    const old = { x: l.x, y: l.y, sx: l.scaleX, sy: l.scaleY, r: l.rot };
    l.x = +m.querySelector('#m-x').value; l.y = +m.querySelector('#m-y').value;
    l.scaleX = +m.querySelector('#m-sx').value / 100; l.scaleY = +m.querySelector('#m-sy').value / 100;
    l.rot = +m.querySelector('#m-r').value;
    pushHistory({
      label: 'Трансформирование',
      undo: () => { l.x = old.x; l.y = old.y; l.scaleX = old.sx; l.scaleY = old.sy; l.rot = old.r; render(); },
      redo: () => { l.x = +m.querySelector('#m-x').value; l.y = +m.querySelector('#m-y').value; l.scaleX = +m.querySelector('#m-sx').value / 100; l.scaleY = +m.querySelector('#m-sy').value / 100; l.rot = +m.querySelector('#m-r').value; render(); }
    });
    render();
  }, 'Применить');
}

/* ============================================================
   ФАЙЛЫ: открытие, сохранение, экспорт
   ============================================================ */
const isElectron = !!window.qwizero;

function dataURLtoBytes(durl) {
  const bin = atob(durl.split(',')[1]);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function saveBytes(bytes, defaultPath, filterName, ext) {
  if (isElectron) {
    return window.qwizero.saveFile({ data: bytes, defaultPath, filters: [{ name: filterName, extensions: [ext] }] });
  }
  const blob = new Blob([bytes]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = defaultPath;
  a.click();
  return defaultPath;
}

async function openFileBytes(filters) {
  if (isElectron) return window.qwizero.openFile({ filters });
  return new Promise(res => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return res(null);
      res({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
    };
    inp.click();
  });
}

function bytesToImage(bytes) {
  return new Promise((res, rej) => {
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = rej;
    img.src = url;
  });
}

async function openImageAsDoc() {
  const f = await openFileBytes([{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }]);
  if (!f) return;
  const img = await bytesToImage(f.data);
  newDocument(img.naturalWidth, img.naturalHeight, f.name.replace(/\.[^.]+$/, ''), null);
  const l = activeLayer();
  l.canvas.getContext('2d').drawImage(img, 0, 0);
  render(); refreshLayersPanel();
}

async function openImageAsLayer() {
  if (!QW.doc) return;
  const f = await openFileBytes([{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }]);
  if (!f) return;
  const img = await bytesToImage(f.data);
  const l = addLayer(f.name.replace(/\.[^.]+$/, ''), true);
  const ctx = l.canvas.getContext('2d');
  const s = Math.min(1, QW.doc.w / img.naturalWidth, QW.doc.h / img.naturalHeight);
  const w = img.naturalWidth * s, h = img.naturalHeight * s;
  ctx.drawImage(img, (QW.doc.w - w) / 2, (QW.doc.h - h) / 2, w, h);
  pushHistory({
    label: 'Открытие слоя',
    undo: () => { const i = QW.doc.layers.indexOf(l); QW.doc.layers.splice(i, 1); QW.doc.active = Math.max(0, i - 1); afterStruct(); },
    redo: () => { QW.doc.layers.splice(QW.doc.active + 1, 0, l); QW.doc.active++; afterStruct(); }
  });
  afterStruct();
}

async function saveProject() {
  if (!QW.doc) return;
  const proj = {
    app: 'QWIZERO Studio', version: 1,
    name: QW.doc.name, w: QW.doc.w, h: QW.doc.h, active: QW.doc.active,
    layers: QW.doc.layers.map(l => ({
      name: l.name, x: l.x, y: l.y, scaleX: l.scaleX, scaleY: l.scaleY, rot: l.rot,
      opacity: l.opacity, blend: l.blend, visible: l.visible, locked: l.locked,
      data: l.canvas.toDataURL('image/png'),
      mask: l.mask ? l.mask.toDataURL('image/png') : null
    }))
  };
  const bytes = new TextEncoder().encode(JSON.stringify(proj));
  await saveBytes(bytes, QW.doc.name + '.qwz', 'Проект QWIZERO', 'qwz');
}

async function openProject() {
  const f = await openFileBytes([{ name: 'Проект QWIZERO', extensions: ['qwz', 'json'] }]);
  if (!f) return;
  const proj = JSON.parse(new TextDecoder().decode(f.data));
  newDocument(proj.w, proj.h, proj.name || 'Проект', null);
  QW.doc.layers = [];
  for (const s of proj.layers) {
    const l = makeLayer(s.name, proj.w, proj.h);
    Object.assign(l, { x: s.x, y: s.y, scaleX: s.scaleX, scaleY: s.scaleY, rot: s.rot, opacity: s.opacity, blend: s.blend, visible: s.visible, locked: s.locked });
    const img = await bytesToImage(dataURLtoBytes(s.data));
    l.canvas.getContext('2d').drawImage(img, 0, 0);
    if (s.mask) {
      l.mask = document.createElement('canvas');
      l.mask.width = proj.w; l.mask.height = proj.h;
      const mi = await bytesToImage(dataURLtoBytes(s.mask));
      l.mask.getContext('2d').drawImage(mi, 0, 0);
    }
    QW.doc.layers.push(l);
  }
  QW.doc.active = clamp(proj.active || 0, 0, QW.doc.layers.length - 1);
  QW.history = []; QW.hIndex = -1;
  refreshLayersPanel(); render();
}

async function exportImage(fmt) {
  if (!QW.doc) return;
  const c = document.createElement('canvas');
  c.width = QW.doc.w; c.height = QW.doc.h;
  const ctx = c.getContext('2d');
  if (fmt === 'jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
  compositeTo(ctx, QW.doc.w, QW.doc.h);
  const durl = c.toDataURL('image/' + fmt, 0.92);
  await saveBytes(dataURLtoBytes(durl), QW.doc.name + '.' + (fmt === 'jpeg' ? 'jpg' : fmt), fmt.toUpperCase(), fmt === 'jpeg' ? 'jpg' : fmt);
}

/* ============================================================
   ПАНЕЛЬ КОРРЕКЦИИ
   ============================================================ */
$('#adj-apply').onclick = () => {
  const v = {};
  $$('.adj').forEach(el => v[el.dataset.k] = +el.value);
  if (Object.values(v).every(x => x === 0)) return;
  applyPixelOp('Коррекция', (d, w, h) => {
    if (v.brightness || v.contrast || v.exposure) opBrightnessContrast(d, w, h, v.brightness, v.contrast, v.exposure);
    if (v.hue || v.saturation) opHueSat(d, w, h, v.hue, v.saturation, 0);
    if (v.temperature) opTemperature(d, w, h, v.temperature);
    if (v.vibrance) opVibrance(d, w, h, v.vibrance);
    if (v.sharpen) sharpenAmount(d, w, h, v.sharpen / 100);
  });
};
$('#adj-reset').onclick = () => {
  $$('.adj').forEach(el => { el.value = 0; el.parentElement.querySelector('.adj-v').textContent = '0'; });
};
$$('.adj').forEach(el => el.addEventListener('input', () => {
  el.parentElement.querySelector('.adj-v').textContent = el.value;
}));

/* ============================================================
   ВКЛАДКИ ПАНЕЛЕЙ
   ============================================================ */
$$('.ptab').forEach(b => b.addEventListener('click', () => {
  $$('.ptab').forEach(x => x.classList.toggle('active', x === b));
  $$('.tabpage').forEach(p => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
}));

/* ============================================================
   КЛАВИАТУРА
   ============================================================ */
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  const k = e.key.toLowerCase();
  if (e.code === 'Space') { QW.spacePan = true; view.style.cursor = 'grab'; e.preventDefault(); return; }

  if (e.ctrlKey || e.metaKey) {
    const map = {
      'z': () => e.shiftKey ? redo() : undo(),
      'y': redo,
      'n': () => e.shiftKey ? addLayer() : uiNewDocument(),
      'o': openImageAsDoc,
      's': saveProject,
      'e': () => exportImage('png'),
      'j': () => $('#lb-dup').click(),
      'l': uiLevels,
      'm': uiCurves,
      'u': uiHueSat,
      'b': uiColorBalance,
      't': uiTransformLayer,
      'i': () => e.shiftKey ? invertSelection() : applyPixelOp('Инверсия', opInvert),
      'a': selectAll,
      'd': clearSelection,
      '0': () => { fitToWindow(); render(); },
      '1': () => { QW.view.zoom = 1; render(); },
      '=': () => zoomAt(1.3, view.clientWidth / 2, view.clientHeight / 2),
      '+': () => zoomAt(1.3, view.clientWidth / 2, view.clientHeight / 2),
      '-': () => zoomAt(1 / 1.3, view.clientWidth / 2, view.clientHeight / 2)
    };
    if (map[k]) { e.preventDefault(); map[k](); }
    return;
  }

  if (k === 'enter' && QW.tool === 'crop' && render.cropBox) {
    const [x, y, w, h] = render.cropBox;
    render.cropBox = null;
    cropDocument(x, y, w, h);
    return;
  }
  if (k === 'escape') { clearPreview(); render.cropBox = null; render(); return; }
  if (k === 'delete') { clearLayer(); return; }
  if (k === 'x') { const t = QW.fg; setFg(QW.bg); setBg(t); return; }
  if (k === 'd') { setFg('#ffffff'); setBg('#000000'); return; }
  if (k === '[') { QW.brush.size = Math.max(1, QW.brush.size - 5); setTool(QW.tool); return; }
  if (k === ']') { QW.brush.size = Math.min(500, QW.brush.size + 5); setTool(QW.tool); return; }

  if (QW.tool === 'move' && ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
    const l = activeLayer();
    if (l && !l.locked) {
      if (k === 'arrowup') l.y -= 1;
      if (k === 'arrowdown') l.y += 1;
      if (k === 'arrowleft') l.x -= 1;
      if (k === 'arrowright') l.x += 1;
      render();
    }
    e.preventDefault();
    return;
  }

  for (const id in TOOLS) {
    if (TOOLS[id].key && TOOLS[id].key.toLowerCase() === k) { setTool(id); return; }
  }
});
document.addEventListener('keyup', e => {
  if (e.code === 'Space') { QW.spacePan = false; setTool(QW.tool); }
});

/* ============================================================
   ИНИЦИАЛИЗАЦИЯ
   ============================================================ */
window.addEventListener('resize', resizeView);

buildMenus();
buildToolbar();
setTool('move');
setFg('#ffffff');
setBg('#000000');
newDocument(1920, 1080, 'Без названия', null);
requestAnimationFrame(resizeView);
