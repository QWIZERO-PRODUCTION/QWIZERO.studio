/* ============================================================
   QWIZERO Studio — моушн-редактор
   Композиции, таймлайн, ключевые кадры, плейбэк, экспорт видео
   ============================================================ */
'use strict';

(function () {
  const PPS = 80;              // пикселей на секунду на таймлайне
  const PROPS = ['x', 'y', 'scale', 'rot', 'op'];

  const M = {
    comp: null,
    time: 0,
    playing: false,
    sel: -1,                   // индекс выбранного слоя композиции
    _raf: 0
  };
  window.QWMotion = M;

  /* ---------------- Модель ---------------- */
  function makeCompLayer(name, type, extra) {
    return Object.assign({
      id: uid(), name, type, visible: true,
      base: { x: 0, y: 0, scale: 100, rot: 0, op: 100 },
      keys: { x: [], y: [], scale: [], rot: [], op: [] },
      blur: 0
    }, extra || {});
  }

  function newComp(w, h, fps, duration, bg) {
    M.comp = { w, h, fps, duration, bg: bg || '#000000', layers: [] };
    QW.comp = M.comp;
    M.time = 0; M.sel = -1;
    $('#tl-fps').value = fps;
    $('#tl-dur').value = duration;
    rebuildTimeline();
    render();
  }

  function sample(layer, prop, t) {
    const ks = layer.keys[prop];
    if (!ks.length) return layer.base[prop];
    if (t <= ks[0].t) return ks[0].v;
    if (t >= ks[ks.length - 1].t) return ks[ks.length - 1].v;
    for (let i = 0; i < ks.length - 1; i++) {
      if (t >= ks[i].t && t <= ks[i + 1].t) {
        let p = (t - ks[i].t) / (ks[i + 1].t - ks[i].t || 1);
        if ($('#tl-ease').value === 'ease') p = p * p * (3 - 2 * p); // smoothstep
        return ks[i].v + (ks[i + 1].v - ks[i].v) * p;
      }
    }
    return layer.base[prop];
  }

  function addKey(layer, prop, t, v) {
    const ks = layer.keys[prop];
    const ex = ks.find(k => Math.abs(k.t - t) < 0.02);
    if (ex) { ex.v = v; return; }
    ks.push({ t, v });
    ks.sort((a, b) => a.t - b.t);
  }

  function layerSourceCanvas(layer) {
    // Источник изображения для слоя композиции
    if (layer.type === 'photo') {
      const pl = QW.doc && QW.doc.layers.find(l => l.id === layer.refId);
      return pl ? pl.canvas : null;
    }
    if (layer._cache) return layer._cache;
    const c = document.createElement('canvas');
    if (layer.type === 'solid') {
      c.width = layer.w; c.height = layer.h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = layer.color;
      ctx.fillRect(0, 0, c.width, c.height);
    } else if (layer.type === 'text') {
      const tmp = document.createElement('canvas').getContext('2d');
      tmp.font = `${layer.italic ? 'italic ' : ''}${layer.bold ? 'bold ' : ''}${layer.size}px "${layer.font}"`;
      const tw = Math.ceil(tmp.measureText(layer.text).width) + 8;
      c.width = Math.max(2, tw); c.height = Math.ceil(layer.size * 1.4);
      const ctx = c.getContext('2d');
      ctx.font = tmp.font;
      ctx.fillStyle = layer.color;
      ctx.textBaseline = 'top';
      ctx.fillText(layer.text, 2, 2);
    }
    layer._cache = c;
    return c;
  }

  /* ---------------- Отрисовка кадра ---------------- */
  function drawComp(ctx, comp, t, W, H) {
    ctx.save();
    ctx.fillStyle = comp.bg;
    ctx.fillRect(0, 0, W, H);
    for (const layer of comp.layers) {
      if (!layer.visible) continue;
      const src = layerSourceCanvas(layer);
      if (!src) continue;
      const x = sample(layer, 'x', t), y = sample(layer, 'y', t);
      const s = sample(layer, 'scale', t) / 100;
      const rot = sample(layer, 'rot', t);
      const op = sample(layer, 'op', t) / 100;
      ctx.save();
      ctx.globalAlpha = clamp(op, 0, 1);
      ctx.translate(x, y);
      ctx.rotate(rot * Math.PI / 180);
      ctx.scale(s, s);
      if (layer.blur > 0) ctx.filter = `blur(${layer.blur}px)`;
      ctx.drawImage(src, -src.width / 2, -src.height / 2);
      ctx.restore();
    }
    ctx.restore();
  }

  // Вызывается из editor.js render() в режиме motion
  window.renderCompFrame = function (vctx, cw, ch) {
    const comp = M.comp;
    if (!comp) return;
    const z = Math.min((cw - 60) / comp.w, (ch - 60) / comp.h);
    const ox = (cw - comp.w * z) / 2, oy = (ch - comp.h * z) / 2;
    drawChecker(vctx, ox, oy, comp.w * z, comp.h * z, Math.max(8, 12 * z));
    vctx.save();
    vctx.translate(ox, oy);
    vctx.scale(z, z);
    drawComp(vctx, comp, M.time, comp.w, comp.h);
    vctx.restore();
    vctx.strokeStyle = 'rgba(34,211,238,.6)';
    vctx.strokeRect(ox - .5, oy - .5, comp.w * z + 1, comp.h * z + 1);
  };

  /* ---------------- Таймлайн UI ---------------- */
  function rebuildTimeline() {
    const comp = M.comp;
    const lcol = $('#tl-layers');
    const area = $('#tl-trackarea');
    const ruler = $('#tl-ruler');
    lcol.innerHTML = ''; area.innerHTML = ''; ruler.innerHTML = '';
    if (!comp) return;

    const width = comp.duration * PPS + 60;
    ruler.style.width = width + 'px';
    area.style.width = width + 'px';

    for (let s = 0; s <= comp.duration; s++) {
      const tick = document.createElement('div');
      tick.className = 'ruler-tick';
      tick.style.left = (s * PPS) + 'px';
      tick.textContent = s + 'с';
      ruler.appendChild(tick);
    }

    comp.layers.forEach((layer, i) => {
      const row = document.createElement('div');
      row.className = 'tl-lrow' + (i === M.sel ? ' active' : '');
      const eye = document.createElement('span');
      eye.className = 'eye';
      eye.textContent = layer.visible ? '👁' : '—';
      eye.onclick = e => { e.stopPropagation(); layer.visible = !layer.visible; render(); rebuildTimeline(); };
      const nm = document.createElement('span');
      nm.textContent = layer.name;
      nm.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
      const del = document.createElement('span');
      del.className = 'del';
      del.textContent = '✕';
      del.title = 'Удалить слой';
      del.onclick = e => {
        e.stopPropagation();
        comp.layers.splice(i, 1);
        if (M.sel >= comp.layers.length) M.sel = comp.layers.length - 1;
        rebuildTimeline(); syncPropsBar(); render();
      };
      row.append(eye, nm, del);
      row.onclick = () => { M.sel = i; rebuildTimeline(); syncPropsBar(); };
      lcol.appendChild(row);

      const track = document.createElement('div');
      track.className = 'tl-track' + (i === M.sel ? ' active' : '');
      track.style.width = width + 'px';
      // все ключи всех свойств одним рядом (ромбики)
      const allT = new Map();
      for (const p of PROPS) for (const k of layer.keys[p]) {
        if (!allT.has(k.t)) allT.set(k.t, []);
        allT.get(k.t).push(p);
      }
      for (const [t] of allT) {
        const kd = document.createElement('div');
        kd.className = 'tl-key';
        kd.style.left = (t * PPS) + 'px';
        kd.title = 't = ' + t.toFixed(2) + ' с (перетаскивание — сдвиг, двойной клик — удалить)';
        kd.addEventListener('pointerdown', e => {
          e.stopPropagation();
          kd.setPointerCapture(e.pointerId);
          const startX = e.clientX;
          let curT = t;
          const onMove = ev => {
            const nt = Math.round(clamp(curT + (ev.clientX - startX) / PPS, 0, comp.duration) * 100) / 100;
            if (nt === curT) return;
            moveKeys(layer, curT, nt);
            curT = nt;
            kd.style.left = (nt * PPS) + 'px';
          };
          const onUp = () => {
            kd.removeEventListener('pointermove', onMove);
            kd.removeEventListener('pointerup', onUp);
            rebuildTimeline();
          };
          kd.addEventListener('pointermove', onMove);
          kd.addEventListener('pointerup', onUp);
        });
        kd.addEventListener('dblclick', () => {
          for (const p of PROPS) layer.keys[p] = layer.keys[p].filter(k => Math.abs(k.t - t) > 0.001);
          rebuildTimeline();
        });
        track.appendChild(kd);
      }
      area.appendChild(track);
    });
    updatePlayhead();
    updateTimeLabel();
  }

  function moveKeys(layer, fromT, toT) {
    for (const p of PROPS) {
      const k = layer.keys[p].find(kk => Math.abs(kk.t - fromT) < 0.001);
      if (k) { k.t = toT; layer.keys[p].sort((a, b) => a.t - b.t); }
    }
  }

  function updatePlayhead() {
    $('#tl-playhead').style.left = (M.time * PPS) + 'px';
  }

  function updateTimeLabel() {
    if (M.comp) $('#tl-time').textContent = M.time.toFixed(2) + ' / ' + M.comp.duration.toFixed(2) + ' с';
  }

  // Скраббинг по линейке
  {
    const ruler = $('#tl-ruler');
    let scrubbing = false;
    const seek = e => {
      const r = ruler.getBoundingClientRect();
      const x = e.clientX - r.left + $('#tl-scroll').scrollLeft * 0; // ruler уже прокручен вместе с контейнером
      const t = clamp((e.clientX - r.left) / PPS, 0, M.comp ? M.comp.duration : 0);
      M.time = t;
      updatePlayhead(); updateTimeLabel(); render();
    };
    ruler.addEventListener('pointerdown', e => { if (!M.comp) return; scrubbing = true; ruler.setPointerCapture(e.pointerId); seek(e); });
    ruler.addEventListener('pointermove', e => { if (scrubbing) seek(e); });
    ruler.addEventListener('pointerup', () => scrubbing = false);
  }

  /* ---------------- Панель свойств ---------------- */
  function selLayer() { return M.comp && M.sel >= 0 ? M.comp.layers[M.sel] : null; }

  function syncPropsBar() {
    const l = selLayer();
    $('#tl-selname').textContent = l ? l.name : 'Слой не выбран';
    if (!l) return;
    const t = M.time;
    $('#mp-x').value = Math.round(sample(l, 'x', t));
    $('#mp-y').value = Math.round(sample(l, 'y', t));
    $('#mp-scale').value = Math.round(sample(l, 'scale', t));
    $('#mp-rot').value = Math.round(sample(l, 'rot', t));
    $('#mp-op').value = Math.round(sample(l, 'op', t));
    $('#mp-blur').value = l.blur;
  }

  const propInputs = { x: '#mp-x', y: '#mp-y', scale: '#mp-scale', rot: '#mp-rot', op: '#mp-op' };
  for (const p in propInputs) {
    $(propInputs[p]).addEventListener('change', e => {
      const l = selLayer(); if (!l) return;
      const v = +e.target.value;
      if (l.keys[p].length) addKey(l, p, M.time, v);   // есть ключи — анимируем
      else l.base[p] = v;                               // нет ключей — статичное значение
      rebuildTimeline(); render();
    });
  }
  $('#mp-blur').addEventListener('change', e => {
    const l = selLayer(); if (!l) return;
    l.blur = Math.max(0, +e.target.value);
    render();
  });

  $('#tl-key-all').onclick = () => {
    const l = selLayer(); if (!l) return;
    for (const p of PROPS) addKey(l, p, M.time, sample(l, p, M.time));
    rebuildTimeline();
  };
  $('#tl-key-del').onclick = () => {
    const l = selLayer(); if (!l) return;
    for (const p of PROPS) l.keys[p] = l.keys[p].filter(k => Math.abs(k.t - M.time) > 0.02);
    rebuildTimeline();
  };

  /* ---------------- Кнопки тулбара ---------------- */
  $('#tl-newcomp').onclick = () => {
    showModal('Новая композиция', `
      <label>Ширина, px <input type="number" id="m-w" value="1920" min="16" max="7680"></label>
      <label>Высота, px <input type="number" id="m-h" value="1080" min="16" max="7680"></label>
      <label>Кадров/с <input type="number" id="m-fps" value="30" min="1" max="120"></label>
      <label>Длительность, с <input type="number" id="m-d" value="10" min="1" max="600"></label>
      <label>Фон <input type="color" id="m-bg" value="#000000"></label>`, m => {
      newComp(clamp(+m.querySelector('#m-w').value, 16, 7680), clamp(+m.querySelector('#m-h').value, 16, 7680),
        clamp(+m.querySelector('#m-fps').value, 1, 120), clamp(+m.querySelector('#m-d').value, 1, 600),
        m.querySelector('#m-bg').value);
      setMode('motion');
    }, 'Создать');
  };

  $('#tl-fromdoc').onclick = () => {
    if (!QW.doc) return;
    newComp(QW.doc.w, QW.doc.h, 30, 10, '#000000');
    QW.doc.layers.forEach(pl => {
      M.comp.layers.push(makeCompLayer(pl.name, 'photo', { refId: pl.id }));
    });
    M.comp.layers.forEach(l => { l.base.x = M.comp.w / 2; l.base.y = M.comp.h / 2; });
    rebuildTimeline(); setMode('motion');
  };

  $('#tl-addsolid').onclick = () => {
    if (!M.comp) return;
    showModal('Плашка (цветной слой)', `
      <label>Название <input id="m-name" value="Плашка"></label>
      <label>Цвет <input type="color" id="m-color" value="#7c5cff"></label>
      <label>Ширина, px <input type="number" id="m-w" value="400" min="1" max="7680"></label>
      <label>Высота, px <input type="number" id="m-h" value="300" min="1" max="7680"></label>`, m => {
      const l = makeCompLayer(m.querySelector('#m-name').value, 'solid', {
        color: m.querySelector('#m-color').value,
        w: clamp(+m.querySelector('#m-w').value, 1, 7680),
        h: clamp(+m.querySelector('#m-h').value, 1, 7680)
      });
      l.base.x = M.comp.w / 2; l.base.y = M.comp.h / 2;
      M.comp.layers.push(l);
      M.sel = M.comp.layers.length - 1;
      rebuildTimeline(); syncPropsBar(); render();
    }, 'Добавить');
  };

  $('#tl-addtext').onclick = () => {
    if (!M.comp) return;
    showModal('Текстовый слой', `
      <label>Текст <input id="m-text" value="QWIZERO Studio"></label>
      <label>Шрифт <select id="m-font"><option>Segoe UI</option><option>Arial</option><option>Impact</option><option>Georgia</option><option>Courier New</option></select></label>
      <label>Размер, px <input type="number" id="m-size" value="96" min="6" max="800"></label>
      <label>Цвет <input type="color" id="m-color" value="#ffffff"></label>
      <label><input type="checkbox" id="m-bold" checked> Жирный</label>`, m => {
      const t = m.querySelector('#m-text').value;
      if (!t) return;
      const l = makeCompLayer('Текст: ' + t.slice(0, 14), 'text', {
        text: t, font: m.querySelector('#m-font').value,
        size: clamp(+m.querySelector('#m-size').value, 6, 800),
        color: m.querySelector('#m-color').value,
        bold: m.querySelector('#m-bold').checked, italic: false
      });
      l.base.x = M.comp.w / 2; l.base.y = M.comp.h / 2;
      M.comp.layers.push(l);
      M.sel = M.comp.layers.length - 1;
      rebuildTimeline(); syncPropsBar(); render();
    }, 'Добавить');
  };

  $('#tl-fps').addEventListener('change', e => { if (M.comp) M.comp.fps = clamp(+e.target.value, 1, 120); });
  $('#tl-dur').addEventListener('change', e => {
    if (!M.comp) return;
    M.comp.duration = clamp(+e.target.value, 1, 600);
    rebuildTimeline();
  });

  /* ---------------- Плейбэк ---------------- */
  let playStart = 0, playTime0 = 0;
  function tick(now) {
    if (!M.playing) return;
    const comp = M.comp;
    M.time = playTime0 + (now - playStart) / 1000;
    if (M.time >= comp.duration) { M.time = 0; playStart = now; playTime0 = 0; }
    updatePlayhead(); updateTimeLabel(); render();
    M._raf = requestAnimationFrame(tick);
  }
  $('#tl-play').onclick = () => {
    if (!M.comp) return;
    M.playing = !M.playing;
    $('#tl-play').textContent = M.playing ? '⏸' : '▶';
    if (M.playing) { playStart = performance.now(); playTime0 = M.time; M._raf = requestAnimationFrame(tick); }
    else { cancelAnimationFrame(M._raf); syncPropsBar(); }
  };
  $('#tl-tostart').onclick = () => { M.time = 0; updatePlayhead(); updateTimeLabel(); render(); };

  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && QW.mode === 'motion' && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      e.stopPropagation();
      $('#tl-play').click();
    }
  }, true);

  /* ---------------- Экспорт видео ---------------- */
  async function renderAllFrames(onFrame) {
    const comp = M.comp;
    const c = document.createElement('canvas');
    c.width = comp.w; c.height = comp.h;
    const ctx = c.getContext('2d');
    const total = Math.round(comp.duration * comp.fps);
    for (let f = 0; f < total; f++) {
      drawComp(ctx, comp, f / comp.fps, comp.w, comp.h);
      await onFrame(c, f, total);
    }
    return total;
  }

  function exportProgress(f, total) {
    $('#tl-time').textContent = `Экспорт: ${f + 1} / ${total}`;
  }

  $('#tl-export-webm').onclick = async () => {
    if (!M.comp) return;
    const comp = M.comp;
    const c = document.createElement('canvas');
    c.width = comp.w; c.height = comp.h;
    const ctx = c.getContext('2d');
    const stream = c.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise(res => rec.onstop = res);
    rec.start();
    const total = Math.round(comp.duration * comp.fps);
    for (let f = 0; f < total; f++) {
      drawComp(ctx, comp, f / comp.fps, comp.w, comp.h);
      if (track.requestFrame) track.requestFrame();
      exportProgress(f, total);
      await new Promise(r => setTimeout(r, 5));
    }
    rec.stop();
    await done;
    const blob = new Blob(chunks, { type: 'video/webm' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const path = await saveBytes(bytes, 'композиция.webm', 'WebM видео', 'webm');
    updateTimeLabel();
    if (path) showModal('Экспорт завершён', `<p style="color:var(--dim)">Видео сохранено:<br><b style="color:var(--text)">${path}</b></p>`, null, 'OK');
  };

  $('#tl-export-mp4').onclick = async () => {
    if (!M.comp) return;
    if (!isElectron) {
      showModal('MP4 недоступен в браузере', '<p style="color:var(--dim)">Экспорт MP4 работает в настольном приложении QWIZERO Studio (через FFmpeg). Используйте экспорт WebM.</p>', null, 'OK');
      return;
    }
    try {
      const dir = await window.qwizero.mp4Begin();
      const total = Math.round(M.comp.duration * M.comp.fps);
      await renderAllFrames(async (c, f) => {
        const durl = c.toDataURL('image/png');
        await window.qwizero.mp4Frame(dir, f, dataURLtoBytes(durl));
        exportProgress(f, total);
      });
      const path = await window.qwizero.mp4Finish({ dir, fps: M.comp.fps, defaultPath: 'композиция.mp4' });
      updateTimeLabel();
      if (path) showModal('Экспорт завершён', `<p style="color:var(--dim)">Видео сохранено:<br><b style="color:var(--text)">${path}</b></p>`, null, 'OK');
    } catch (err) {
      updateTimeLabel();
      showModal('Ошибка экспорта', `<p style="color:#ff5c7a">${String(err.message || err)}</p>`, null, 'OK');
    }
  };

  /* ---------------- Переключение режимов ---------------- */
  function setMode(mode) {
    QW.mode = mode;
    $('#mode-photo').classList.toggle('active', mode === 'photo');
    $('#mode-motion').classList.toggle('active', mode === 'motion');
    $('#timeline-wrap').classList.toggle('hidden', mode !== 'motion');
    resizeView();
    if (mode === 'motion') { rebuildTimeline(); syncPropsBar(); }
  }
  window.setMode = setMode;
  $('#mode-photo').onclick = () => setMode('photo');
  $('#mode-motion').onclick = () => {
    if (!M.comp) {
      // Первая композиция — из текущего документа или пустая
      if (QW.doc) $('#tl-fromdoc').click();
      else $('#tl-newcomp').click();
      return;
    }
    setMode('motion');
  };
})();
