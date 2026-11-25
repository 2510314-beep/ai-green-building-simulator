'use strict';
/* =============================================================
   render.js — 건물과 날씨를 그림으로 그리는 파일
   -------------------------------------------------------------
   캔버스(canvas)에 하늘·해·구름·비·건물을 매 프레임 그립니다.
   왼쪽: 일반 건물(고정 운영) / 오른쪽: AI 건물(스마트 운영)
   ============================================================= */

const FONT = '"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif';

function hexRGB(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mixRGB(A, B, t) { t = clamp(t, 0, 1); return [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]; }
function rgba(c, a = 1) { return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`; }

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const SCENE = { W: 1000, H: 560, groundY: 470, baseX: 60, aiX: 610, bW: 330 };

class SceneRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.time = 0;
    this.fan = { base: 0, ai: 0 };
    this.rotor = 0;      // 풍력 발전기 날개 각도
    this.wheel = 0;      // 빗물 수차 각도
    this.flash = 0;      // 번개
    this.haze = 0;       // 미세먼지 뿌연 정도
    this.cover = 0.1;
    this.clouds = Array.from({ length: 10 }, (_, i) => ({
      x: i * 115 + Math.random() * 60, y: 30 + Math.random() * 120, s: 0.6 + Math.random() * 0.8,
    }));
    this.drops = [];
    this.stars = Array.from({ length: 80 }, () => ({
      x: Math.random() * SCENE.W, y: Math.random() * 330, r: Math.random() * 1.3 + 0.3, tw: Math.random() * 6,
    }));
    // 배경 도시 실루엣
    this.skyline = [];
    for (let x = -10; x < SCENE.W; ) {
      const w = 30 + Math.random() * 50;
      this.skyline.push({ x, w, h: 50 + Math.random() * 110 });
      x += w + Math.random() * 8;
    }
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const cssW = this.canvas.parentElement.clientWidth;
    const cssH = cssW * SCENE.H / SCENE.W;
    this.canvas.style.height = cssH + 'px';
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.scale = cssW * dpr / SCENE.W;
  }

  draw(v, dt) {
    const ctx = this.ctx;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    this.time += dt;
    const day = clamp((v.sun.alt + 6) / 18, 0, 1); // 0 = 밤, 1 = 낮
    this.cover += (WEATHER_INFO[v.weather].cloud - this.cover) * Math.min(1, dt * 0.8);

    this.drawSky(v, day);
    if (day < 0.6) this.drawStars(1 - day / 0.6);
    this.drawSunMoon(v, day);
    this.drawClouds(v, dt, day);
    this.drawSkyline(day);
    // 미세먼지: 하늘과 먼 도시가 뿌옇게
    this.haze += (clamp((v.pm - 20) / 100, 0, 0.5) - this.haze) * Math.min(1, dt * 1.5);
    if (this.haze > 0.01) {
      ctx.fillStyle = rgba(mixRGB([60, 55, 50], [196, 178, 150], day), this.haze);
      ctx.fillRect(0, 0, SCENE.W, SCENE.groundY);
    }
    this.drawGround(v, day);
    this.drawSunRays(v);
    this.drawTree(28, v, day, 0.9);
    this.drawTree(470, v, day, 1.0);
    this.drawBuilding(SCENE.baseX, v.base, { key: 'base', label: '일반 건물', sub: '정해진 시간표대로 운영', isAI: false }, v, day, dt);
    this.drawBuilding(SCENE.aiX, v.ai, { key: 'ai', label: 'AI 건물', sub: '딥러닝 실시간 최적 제어', isAI: true }, v, day, dt);
    this.drawBattery(540, v.ai, day);
    this.drawRainSystem(SCENE.aiX + SCENE.bW, v.ai, v, day, dt);
    this.drawPrecip(v, dt);
    // 폭우: 가끔 번개
    if (v.weather === 'storm' && Math.random() < dt * 0.25) this.flash = 1;
    if (this.flash > 0.01) {
      ctx.fillStyle = `rgba(235,240,255,${this.flash * 0.55})`;
      ctx.fillRect(0, 0, SCENE.W, SCENE.H);
      this.flash *= Math.exp(-dt * 7);
    }
    this.drawCompass(day);
    if (v.training) this.drawTraining(v.training);
  }

  drawSky(v, day) {
    const ctx = this.ctx, g = SCENE.groundY;
    const dayTop = { clear: '#4f9be0', cloudy: '#8896a7', rain: '#5f6a78', storm: '#3c434e' }[v.weather];
    const dayBot = { clear: '#cfe7ff', cloudy: '#c4ccd6', rain: '#9aa3ad', storm: '#727a85' }[v.weather];
    let top = mixRGB(hexRGB('#0b1433'), hexRGB(dayTop), day);
    let bot = mixRGB(hexRGB('#1f2c50'), hexRGB(dayBot), day);
    const dusk = clamp(1 - Math.abs(v.sun.alt - 2) / 10, 0, 1) * (v.weather === 'clear' ? 0.8 : 0.35);
    bot = mixRGB(bot, hexRGB('#f6a46c'), dusk);
    top = mixRGB(top, hexRGB('#6d5a8a'), dusk * 0.4);
    const grad = ctx.createLinearGradient(0, 0, 0, g);
    grad.addColorStop(0, rgba(top));
    grad.addColorStop(1, rgba(bot));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, SCENE.W, g);
  }

  drawStars(a) {
    const ctx = this.ctx;
    for (const s of this.stars) {
      ctx.fillStyle = `rgba(255,255,255,${a * (0.5 + 0.5 * Math.sin(this.time * 2 + s.tw)) * (1 - this.cover * 0.8)})`;
      ctx.fillRect(s.x, s.y, s.r, s.r);
    }
  }

  sunXY(sun) {
    const x = clamp(SCENE.W / 2 + ((180 - sun.az) / 90) * 420, 30, SCENE.W - 30);
    // 해가 지붕보다 높게 보이도록 하늘 위쪽에 그림(고도 0° ≈ 지붕 높이)
    const y = Math.max(28, 205 - sun.alt * (180 / 75));
    return { x, y };
  }

  drawSunMoon(v, day) {
    const ctx = this.ctx;
    if (v.sun.alt > -4) {
      const { x, y } = this.sunXY(v.sun);
      const vis = clamp(1 - this.cover * 0.92, 0.06, 1); // 구름이 두꺼우면 해가 거의 안 보임
      const glow = ctx.createRadialGradient(x, y, 5, x, y, 70);
      glow.addColorStop(0, `rgba(255,236,160,${0.75 * vis})`);
      glow.addColorStop(1, 'rgba(255,236,160,0)');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(x, y, 70, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = v.sun.alt < 8 ? '#ffbe6b' : '#ffe27a';
      ctx.globalAlpha = vis;
      ctx.beginPath(); ctx.arc(x, y, 22, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (day < 0.5) {
      const p = ((v.hour - 18 + 24) % 24) / 12;
      if (p <= 1) {
        const x = 900 - p * 800, y = 210 - Math.sin(p * Math.PI) * 140;
        ctx.globalAlpha = (1 - day * 2) * (1 - this.cover * 0.6);
        ctx.fillStyle = '#f4f1de';
        ctx.beginPath(); ctx.arc(x, y, 16, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = rgba(mixRGB(hexRGB('#0b1433'), hexRGB('#1f2c50'), y / 470));
        ctx.beginPath(); ctx.arc(x + 7, y - 4, 14, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  drawClouds(v, dt, day) {
    const ctx = this.ctx;
    const n = Math.round(this.cover * this.clouds.length + 0.4);
    const base = v.weather === 'storm' ? [82, 88, 98] : v.weather === 'rain' ? [120, 128, 140] : v.weather === 'cloudy' ? [205, 210, 218] : [250, 252, 255];
    const col = mixRGB([55, 62, 82], base, 0.25 + 0.75 * day);
    for (let i = 0; i < this.clouds.length; i++) {
      const c = this.clouds[i];
      c.x += (6 + v.wind * 5) * dt * c.s;
      if (c.x > SCENE.W + 120) c.x = -140;
      if (i >= n) continue;
      ctx.fillStyle = rgba(col, 0.88);
      const s = c.s * (v.weather === 'rain' || v.weather === 'storm' ? 1.4 : 1);
      ctx.beginPath();
      ctx.arc(c.x, c.y, 26 * s, 0, Math.PI * 2);
      ctx.arc(c.x + 30 * s, c.y - 12 * s, 30 * s, 0, Math.PI * 2);
      ctx.arc(c.x + 62 * s, c.y, 24 * s, 0, Math.PI * 2);
      ctx.arc(c.x + 30 * s, c.y + 8 * s, 26 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawSkyline(day) {
    const ctx = this.ctx, g = SCENE.groundY;
    ctx.fillStyle = rgba(mixRGB([26, 34, 56], [176, 190, 205], day), 0.9);
    for (const b of this.skyline) ctx.fillRect(b.x, g - b.h, b.w, b.h);
    if (day < 0.4) { // 밤에 멀리 보이는 창문 불빛
      ctx.fillStyle = `rgba(255,220,140,${0.5 * (1 - day / 0.4)})`;
      for (const b of this.skyline) {
        for (let yy = g - b.h + 8; yy < g - 6; yy += 14) {
          for (let xx = b.x + 5; xx < b.x + b.w - 5; xx += 10) {
            if (Math.sin(xx * 12.9898 + yy * 78.233) > 0.3) ctx.fillRect(xx, yy, 3, 4);
          }
        }
      }
    }
  }

  drawGround(v, day) {
    const ctx = this.ctx, g = SCENE.groundY;
    const summer = (Math.cos(2 * Math.PI * (v.month - 7.5) / 12) + 1) / 2;
    let grass = mixRGB(hexRGB('#a49f78'), hexRGB('#64a64c'), summer);
    if (v.snowing) grass = hexRGB('#e9eff4');
    grass = mixRGB([22, 32, 30], grass, 0.3 + 0.7 * day);
    ctx.fillStyle = rgba(grass);
    ctx.fillRect(0, g, SCENE.W, SCENE.H - g);
    ctx.fillStyle = rgba(mixRGB([40, 42, 46], [196, 196, 190], day));
    ctx.fillRect(0, g + 10, SCENE.W, 16);
    ctx.fillStyle = rgba(mixRGB([28, 30, 34], [92, 96, 102], day));
    ctx.fillRect(0, g + 40, SCENE.W, 50);
    ctx.fillStyle = rgba(mixRGB([90, 90, 70], [240, 230, 160], day));
    for (let x = 10; x < SCENE.W; x += 60) ctx.fillRect(x, g + 63, 30, 3);
  }

  drawTree(x, v, day, s) {
    const ctx = this.ctx, g = SCENE.groundY;
    const sway = Math.sin(this.time * 2 + x) * v.wind * 0.006;
    ctx.save();
    ctx.translate(x, g + 4);
    ctx.rotate(sway);
    ctx.fillStyle = rgba(mixRGB([30, 24, 20], [110, 80, 56], day));
    ctx.fillRect(-4 * s, -50 * s, 8 * s, 50 * s);
    const summer = (Math.cos(2 * Math.PI * (v.month - 7.5) / 12) + 1) / 2;
    let leaf = v.month >= 10 && v.month <= 11 ? hexRGB('#d98b3a') : mixRGB(hexRGB('#7b8a5a'), hexRGB('#3f8f3a'), summer);
    leaf = mixRGB([18, 30, 22], leaf, 0.3 + 0.7 * day);
    ctx.fillStyle = rgba(leaf);
    ctx.beginPath();
    ctx.arc(0, -70 * s, 26 * s, 0, Math.PI * 2);
    ctx.arc(-16 * s, -56 * s, 18 * s, 0, Math.PI * 2);
    ctx.arc(16 * s, -56 * s, 18 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawSunRays(v) {
    if (v.sun.alt <= 2) return;
    const ctx = this.ctx;
    const { x, y } = this.sunXY(v.sun);
    const top = SCENE.groundY - 24 - 4 * 70;
    for (const [bx, d] of [[SCENE.baseX, v.base], [SCENE.aiX, v.ai]]) {
      const a = clamp(d.pvKW / 30, 0, 0.35);
      if (a < 0.02) continue;
      ctx.strokeStyle = `rgba(255,230,120,${a})`;
      ctx.lineWidth = 2;
      for (const px of [bx + 55, bx + 135, bx + 215]) {
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(px, top - 28); ctx.stroke();
      }
    }
  }

  drawBuilding(x, d, opt, v, day, dt) {
    const ctx = this.ctx, g = SCENE.groundY, W = SCENE.bW, fh = 70, pl = 24, floors = 4;
    const top = g - pl - floors * fh;

    // 그림자
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath(); ctx.ellipse(x + W / 2, g + 6, W / 2 + 24, 9, 0, 0, Math.PI * 2); ctx.fill();

    // 벽
    const wall = mixRGB([52, 58, 72], opt.isAI ? [233, 239, 244] : [228, 222, 212], 0.3 + 0.7 * day);
    ctx.fillStyle = rgba(wall);
    ctx.fillRect(x, top, W, floors * fh + pl);
    ctx.fillStyle = 'rgba(0,0,0,0.07)';
    ctx.fillRect(x + W - 12, top, 12, floors * fh + pl);
    ctx.fillStyle = rgba(mixRGB(wall, [0, 0, 0], 0.12));
    for (let f = 0; f < floors; f++) ctx.fillRect(x, top + f * fh + fh - 4, W, 4);
    if (opt.isAI) { // AI 건물 표시용 초록 띠
      ctx.fillStyle = rgba(mixRGB([20, 70, 50], [40, 170, 120], day));
      ctx.fillRect(x, top, 5, floors * fh + pl);
    }

    // 1층 입구
    ctx.fillStyle = rgba(mixRGB([60, 64, 72], [150, 152, 156], day));
    ctx.fillRect(x, g - pl, W, pl);
    const doorLit = mixRGB(mixRGB([30, 38, 50], [160, 180, 196], day * 0.7), [255, 226, 150], d.light * 0.6);
    ctx.fillStyle = rgba(doorLit);
    ctx.fillRect(x + W / 2 - 24, g - pl + 3, 48, pl - 3);
    ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + W / 2, g - pl + 3); ctx.lineTo(x + W / 2, g); ctx.stroke();

    // 창문 16개
    for (let f = 0; f < floors; f++) {
      for (let i = 0; i < 4; i++) {
        this.drawWindow(x + 24 + i * 78, top + f * fh + 10, 56, 48, d, v, day);
      }
    }

    // 옥상 난간
    ctx.fillStyle = rgba(mixRGB(wall, [0, 0, 0], 0.22));
    ctx.fillRect(x - 6, top - 8, W + 12, 10);

    // 태양광 패널 3개
    for (const px of [x + 55, x + 135, x + 215]) this.drawPanel(px, top - 8, d.panelAngle, d.pvKW, day);

    // 냉난방 실외기
    this.drawHVAC(x + 268, top - 8, d, opt.key, dt, day);

    if (opt.isAI) {
      this.drawWindTurbine(x + 95, top - 8, d, dt, day);
      if (d.spray > 0.05) this.drawSpray(x, top - 8, d.spray);
    }

    // 이름표(건물 앞 바닥)
    this.drawLabel(x + W / 2, g + 16, opt, d);
  }

  drawWindow(x, y, w, h, d, v, day) {
    const ctx = this.ctx;
    // 창틀
    ctx.fillStyle = rgba(mixRGB([70, 76, 88], [196, 204, 214], day));
    ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
    // 실내(조명 켜지면 노랗게)
    let inner = mixRGB([22, 30, 42], [150, 170, 188], day * 0.7);
    inner = mixRGB(inner, [255, 224, 140], d.light * (0.3 + 0.6 * (1 - day)));
    ctx.fillStyle = rgba(inner);
    ctx.fillRect(x, y, w, h);
    // 커튼(위에서 아래로 내려옴)
    const ch = h * d.c;
    if (ch > 0.5) {
      ctx.fillStyle = rgba(mixRGB([84, 74, 64], [232, 214, 182], 0.35 + 0.65 * Math.max(day, d.light * 0.8)));
      ctx.fillRect(x, y, w, ch);
      ctx.strokeStyle = 'rgba(0,0,0,0.1)'; ctx.lineWidth = 1;
      for (let k = 1; k < 7; k++) {
        ctx.beginPath(); ctx.moveTo(x + k * w / 7, y); ctx.lineTo(x + k * w / 7, y + ch); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(60,40,20,0.45)';
      ctx.fillRect(x, y + ch - 2, w, 2);
    }
    // 유리창: 오른쪽 창이 왼쪽으로 미끄러지며 열림
    const open = d.w * (w / 2);
    const glass = `rgba(190,225,250,${0.16 + 0.18 * day})`;
    ctx.fillStyle = glass;
    ctx.fillRect(x, y, w / 2, h);
    ctx.fillRect(x + w / 2 - open, y, w / 2, h);
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w - open, h); ctx.clip();
    ctx.fillStyle = `rgba(255,255,255,${0.08 + 0.12 * day})`;
    ctx.beginPath(); ctx.moveTo(x + 8, y + h); ctx.lineTo(x + 22, y + h); ctx.lineTo(x + 42, y); ctx.lineTo(x + 28, y); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = rgba(mixRGB([60, 66, 76], [150, 160, 172], day));
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w / 2 - 2, h - 2);
    ctx.strokeRect(x + w / 2 - open + 1, y + 1, w / 2 - 2, h - 2);
    // 열린 창으로 들어오는 바람(파랑 = 시원한 공기, 주황 = 따뜻한 공기)
    if (open > 1.5) {
      const gx = x + w - open / 2, gy = y + h * 0.55;
      ctx.strokeStyle = v.T_out < d.T_in ? 'rgba(70,160,255,0.9)' : 'rgba(255,140,60,0.9)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 5]);
      ctx.lineDashOffset = -this.time * 25;
      ctx.beginPath(); ctx.moveTo(gx + 26, gy + 16); ctx.quadraticCurveTo(gx + 14, gy - 8, gx, gy); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  drawPanel(cx, roofY, angle, pv, day) {
    const ctx = this.ctx;
    ctx.strokeStyle = rgba(mixRGB([50, 55, 62], [100, 108, 118], day));
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx, roofY); ctx.lineTo(cx, roofY - 18); ctx.stroke();
    ctx.save();
    ctx.translate(cx, roofY - 18);
    ctx.rotate(angle * DEG);
    const pw = 66, ph = 8;
    const shine = clamp(pv / 14, 0, 1);
    ctx.fillStyle = rgba(mixRGB(mixRGB([14, 22, 44], [28, 54, 110], day), [70, 130, 220], shine * 0.5));
    ctx.fillRect(-pw / 2, -ph, pw, ph);
    ctx.strokeStyle = 'rgba(180,200,230,0.5)'; ctx.lineWidth = 1;
    for (let k = -pw / 2 + 8; k < pw / 2; k += 8) {
      ctx.beginPath(); ctx.moveTo(k, -ph); ctx.lineTo(k, 0); ctx.stroke();
    }
    ctx.strokeStyle = '#c9d2dc';
    ctx.strokeRect(-pw / 2, -ph, pw, ph);
    ctx.restore();
  }

  drawHVAC(x, roofY, d, key, dt, day) {
    const ctx = this.ctx;
    const on = d.hvacKW > 0.3;
    if (on) this.fan[key] += dt * (4 + Math.min(16, d.hvacKW * 0.7));
    const bx = x - 4, by = roofY - 34;
    ctx.fillStyle = rgba(mixRGB([60, 64, 70], [190, 194, 200], day));
    roundRectPath(ctx, bx, by, 52, 34, 4); ctx.fill();
    const cx = bx + 26, cy = by + 17;
    if (on) {
      const col = d.hvacMode === 'heat' ? '255,90,60' : '70,150,255';
      const glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, 30);
      glow.addColorStop(0, `rgba(${col},0.55)`);
      glow.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(cx, cy, 30, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(${col},0.8)`; ctx.lineWidth = 2;
      for (let k = 0; k < 3; k++) { // 위로 올라가는 공기
        const yy = by - 6 - ((this.time * 20 + k * 8) % 22);
        ctx.beginPath();
        ctx.moveTo(cx - 12, yy); ctx.quadraticCurveTo(cx - 6, yy - 4, cx, yy); ctx.quadraticCurveTo(cx + 6, yy + 4, cx + 12, yy);
        ctx.stroke();
      }
    }
    ctx.fillStyle = 'rgba(20,24,30,0.75)';
    ctx.beginPath(); ctx.arc(cx, cy, 12, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(this.fan[key]);
    ctx.fillStyle = '#d7dde4';
    for (let k = 0; k < 3; k++) {
      ctx.rotate(Math.PI * 2 / 3);
      ctx.beginPath(); ctx.ellipse(0, -6, 3, 6, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  /* 옥상 풍력 발전기: 바람이 셀수록 빨리 돌고, 태풍이면 브레이크로 멈춤 */
  drawWindTurbine(mx, roofY, d, dt, day) {
    const ctx = this.ctx;
    const hubY = roofY - 92;
    const spin = d.windState === 'brake' ? 0 : d.windState === 'calm' ? 0.4 : 2 + d.windKW * 4;
    this.rotor += dt * spin;
    ctx.strokeStyle = rgba(mixRGB([70, 76, 86], [205, 210, 218], day));
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(mx, roofY); ctx.lineTo(mx, hubY); ctx.stroke();
    ctx.save();
    ctx.translate(mx, hubY);
    ctx.rotate(this.rotor);
    ctx.fillStyle = rgba(mixRGB([90, 96, 106], [245, 247, 250], day));
    for (let k = 0; k < 3; k++) {
      ctx.rotate(Math.PI * 2 / 3);
      ctx.beginPath();
      ctx.moveTo(-2.5, 0); ctx.quadraticCurveTo(-5, -16, -1.5, -30); ctx.lineTo(1.5, -30); ctx.lineTo(2.5, 0);
      ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = d.windState === 'brake' ? '#e5534b' : '#3cc794';
    ctx.beginPath(); ctx.arc(mx, hubY, 4, 0, Math.PI * 2); ctx.fill();
    if (d.windState === 'brake') {
      ctx.font = `700 11px ${FONT}`;
      ctx.fillStyle = '#ff6b5e';
      ctx.textAlign = 'center';
      ctx.fillText('⛔ 강풍 정지', mx, hubY - 38);
      ctx.textAlign = 'left';
    }
  }

  /* 옥상 살수: 모아 둔 빗물을 지붕에 뿌려 증발 냉각 */
  drawSpray(x, roofY, a) {
    const ctx = this.ctx;
    ctx.fillStyle = `rgba(120,190,255,${0.85 * a})`;
    for (let k = 0; k < 9; k++) {
      const px = x + 18 + k * 37;
      for (let j = 0; j < 4; j++) {
        const ph = (this.time * 1.4 + j / 4 + k * 0.13) % 1;
        ctx.beginPath();
        ctx.arc(px + ph * 16 - 8, roofY - 2 - Math.sin(ph * Math.PI) * 14, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /* 빗물 홈통 → 수차(수력 발전) → 빗물 탱크 */
  drawRainSystem(bx, d, v, day, dt) {
    const ctx = this.ctx, g = SCENE.groundY;
    const top = g - 24 - 4 * 70;
    const px = bx + 5, tx = 950, tw = 42, th = 66, ty = g - th;
    const wheelY = g - 150;
    const flowing = v.rainRate > 0.1;
    // 홈통
    ctx.strokeStyle = rgba(mixRGB([60, 64, 72], [150, 158, 168], day));
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(bx - 6, top - 4); ctx.lineTo(px, top - 4); ctx.lineTo(px, ty - 10); ctx.lineTo(tx + tw / 2, ty - 10); ctx.lineTo(tx + tw / 2, ty); ctx.stroke();
    if (flowing) { // 흐르는 물
      ctx.strokeStyle = 'rgba(90,170,255,0.95)';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 6]);
      ctx.lineDashOffset = -this.time * (40 + v.rainRate * 3);
      ctx.beginPath(); ctx.moveTo(bx - 6, top - 4); ctx.lineTo(px, top - 4); ctx.lineTo(px, ty - 10); ctx.lineTo(tx + tw / 2, ty - 10); ctx.lineTo(tx + tw / 2, ty); ctx.stroke();
      ctx.setLineDash([]);
    }
    // 수차
    this.wheel += dt * (flowing ? 1.5 + v.rainRate * 0.2 : 0);
    ctx.fillStyle = rgba(mixRGB([40, 44, 52], [90, 98, 110], day));
    ctx.beginPath(); ctx.arc(px, wheelY, 11, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.translate(px, wheelY); ctx.rotate(this.wheel);
    ctx.strokeStyle = flowing ? '#7cc4ff' : '#c9d2dc';
    ctx.lineWidth = 2;
    for (let k = 0; k < 6; k++) {
      ctx.rotate(Math.PI / 3);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -10); ctx.stroke();
    }
    ctx.restore();
    // 탱크
    ctx.fillStyle = rgba(mixRGB([40, 46, 56], [120, 132, 146], day));
    roundRectPath(ctx, tx, ty, tw, th, 6); ctx.fill();
    const ih = (th - 8) * clamp(d.tankFrac, 0, 1);
    ctx.fillStyle = 'rgba(70,160,255,0.9)';
    ctx.fillRect(tx + 4, ty + 4 + (th - 8 - ih), tw - 8, ih);
    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.fillText(`${Math.round(d.tankFrac * 100)}%`, tx + tw / 2, ty + th / 2 + 4);
    ctx.font = `600 11px ${FONT}`;
    ctx.fillStyle = day > 0.5 ? '#1d2430' : '#e6ebf2';
    ctx.fillText('💧빗물', tx + tw / 2, ty - 26);
    if (flowing) {
      ctx.fillStyle = '#5fb3ff';
      ctx.fillText(`⚡${d.hydroKW.toFixed(2)}`, tx + tw / 2 + 2, ty - 13);
    }
    ctx.textAlign = 'left';
  }

  drawLabel(cx, y, opt, d) {
    const ctx = this.ctx;
    const w = 300, h = 50;
    ctx.fillStyle = opt.isAI ? 'rgba(14,92,64,0.88)' : 'rgba(60,58,54,0.85)';
    roundRectPath(ctx, cx - w / 2, y, w, h, 10); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.font = `700 16px ${FONT}`;
    ctx.fillText(`${opt.isAI ? '🤖 ' : '🏢 '}${opt.label}`, cx, y + 20);
    ctx.font = `500 12.5px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fillText(`실내 ${d.T_in.toFixed(1)}°C · 소비 ${d.totalKW.toFixed(1)}kW · 발전 ${d.genKW.toFixed(1)}kW`, cx, y + 39);
    ctx.textAlign = 'left';
  }

  drawBattery(x, d, day) {
    const ctx = this.ctx, g = SCENE.groundY;
    const bw = 38, bh = 62, by = g - bh;
    ctx.fillStyle = rgba(mixRGB([40, 44, 52], [70, 78, 90], day));
    roundRectPath(ctx, x, by, bw, bh, 6); ctx.fill();
    ctx.fillRect(x + bw / 2 - 7, by - 5, 14, 6);
    const lvl = clamp(d.soc, 0, 1);
    const col = lvl > 0.5 ? '#3cc794' : lvl > 0.2 ? '#f2b705' : '#e5534b';
    ctx.fillStyle = col;
    const ih = (bh - 10) * lvl;
    ctx.fillRect(x + 5, by + 5 + (bh - 10 - ih), bw - 10, ih);
    ctx.fillStyle = '#fff';
    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(lvl * 100)}%`, x + bw / 2, by + bh / 2 + 4);
    const st = { solar: ['▲ 태양광 충전', '#3cc794'], grid: ['▲ 저탄소 충전', '#5fb3ff'], discharge: ['▼ 방전 중', '#ff9b4a'] }[d.battState];
    ctx.font = `600 11px ${FONT}`;
    ctx.fillStyle = day > 0.5 ? '#1d2430' : '#e6ebf2';
    ctx.fillText('🔋 배터리', x + bw / 2, by - 24);
    if (st) { ctx.fillStyle = st[1]; ctx.fillText(st[0], x + bw / 2, by - 10); }
    ctx.textAlign = 'left';
  }

  drawPrecip(v, dt) {
    const ctx = this.ctx, g = SCENE.groundY;
    const want = v.weather === 'storm' ? (v.snowing ? 260 : 520) : v.weather === 'rain' ? (v.snowing ? 160 : 240) : 0;
    while (this.drops.length < want) this.drops.push({ x: Math.random() * (SCENE.W + 200) - 100, y: Math.random() * g, v: 0.7 + Math.random() * 0.6 });
    if (this.drops.length > want) this.drops.length = want;
    if (!want) return;
    ctx.strokeStyle = v.snowing ? 'rgba(255,255,255,0.9)' : 'rgba(200,220,240,0.55)';
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.3;
    const fall = v.snowing ? 60 : v.weather === 'storm' ? 720 : 520, drift = v.wind * (v.snowing ? 6 : 10);
    for (const p of this.drops) {
      p.y += fall * p.v * dt;
      p.x += drift * dt + (v.snowing ? Math.sin(this.time * 2 + p.v * 10) * 0.4 : 0);
      if (p.y > g + 20) { p.y = -10; p.x = Math.random() * (SCENE.W + 200) - 100; }
      if (v.snowing) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 2 * p.v, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + drift * 0.02, p.y + 12); ctx.stroke();
      }
    }
  }

  drawCompass(day) {
    const ctx = this.ctx;
    ctx.font = `600 11.5px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText('← 서쪽(해 지는 쪽)', 8, SCENE.H - 6);
    ctx.textAlign = 'right';
    ctx.fillText('동쪽(해 뜨는 쪽) →', SCENE.W - 8, SCENE.H - 6);
    ctx.textAlign = 'center';
    ctx.fillText('보이는 면 = 건물의 남쪽 면', SCENE.W / 2, SCENE.H - 6);
    ctx.textAlign = 'left';
  }

  drawTraining(t) {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(8,14,28,0.72)';
    ctx.fillRect(0, 0, SCENE.W, SCENE.H);
    const cx = SCENE.W / 2, cy = SCENE.H / 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = `700 26px ${FONT}`;
    ctx.fillText('🧠 AI가 과거 데이터로 학습하는 중…', cx, cy - 50);
    ctx.font = `500 15px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(`건물 운영 기록 ${AI.N_TRAIN.toLocaleString()}개 · 에포크 ${Math.min(t.epoch + 1, AI.EPOCHS)} / ${AI.EPOCHS}` +
      (t.loss != null ? ` · 시험 오차 ${t.loss.toFixed(4)}` : ''), cx, cy - 18);
    const bw = 420, bh = 14;
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    roundRectPath(ctx, cx - bw / 2, cy + 4, bw, bh, 7); ctx.fill();
    ctx.fillStyle = '#3cc794';
    roundRectPath(ctx, cx - bw / 2, cy + 4, Math.max(14, bw * t.progress), bh, 7); ctx.fill();
    ctx.font = `500 13px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillText('학습이 끝나면 AI가 건물을 직접 조절하기 시작합니다', cx, cy + 46);
    ctx.textAlign = 'left';
  }
}
