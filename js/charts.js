'use strict';
/* =============================================================
   charts.js — 간단한 선 그래프 그리기
   ============================================================= */

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}

/* series: [{ data: [숫자...], color, dash, fill, width }]
   opt: { labels: [x축 글자...], unit, ymin, ymax, n } */
function drawLineChart(canvas, series, opt = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const pad = { l: 44, r: 10, t: 10, b: 22 };
  const all = series.flatMap(s => s.data).filter(v => Number.isFinite(v));
  const n = opt.n || Math.max(2, ...series.map(s => s.data.length));
  let ymin = opt.ymin ?? Math.min(0, ...all);
  let ymax = opt.ymax ?? Math.max(1, ...all);
  const step = niceStep((ymax - ymin) / 4 || 1);
  ymin = Math.floor(ymin / step) * step;
  ymax = Math.ceil(ymax / step) * step;
  if (ymax === ymin) ymax = ymin + step;

  const X = i => pad.l + (i / (n - 1)) * (w - pad.l - pad.r);
  const Y = v => pad.t + (1 - (v - ymin) / (ymax - ymin)) * (h - pad.t - pad.b);

  ctx.font = `11px ${FONT}`;
  ctx.fillStyle = cssVar('--muted');
  ctx.strokeStyle = cssVar('--grid');
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  for (let v = ymin; v <= ymax + 1e-9; v += step) {
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(+v.toFixed(3) + (opt.unit || ''), pad.l - 6, y + 4);
  }
  if (ymin < 0 && ymax > 0) {
    ctx.strokeStyle = cssVar('--muted');
    ctx.beginPath(); ctx.moveTo(pad.l, Y(0)); ctx.lineTo(w - pad.r, Y(0)); ctx.stroke();
  }
  ctx.textAlign = 'center';
  if (opt.labels) {
    const every = Math.max(1, Math.ceil(n / 6));
    opt.labels.forEach((lab, i) => {
      if (i % every === 0 && lab) ctx.fillText(lab, X(i), h - 6);
    });
  }
  ctx.textAlign = 'left';

  for (const s of series) {
    if (s.data.length < 2) continue;
    ctx.beginPath();
    s.data.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
    if (s.fill) {
      ctx.save();
      ctx.lineTo(X(s.data.length - 1), Y(Math.max(ymin, 0)));
      ctx.lineTo(X(0), Y(Math.max(ymin, 0)));
      ctx.closePath();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = s.color;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      s.data.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
    }
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width || 2;
    ctx.setLineDash(s.dash || []);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
