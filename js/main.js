'use strict';
/* =============================================================
   main.js — 전체를 연결하고 시간을 흐르게 하는 파일
   -------------------------------------------------------------
   매 프레임: 시간 진행 → 15분마다 doStep() → 화면 그리기
   doStep(): 환경 갱신 → 일반 건물 계산 → AI 판단 → AI 건물 계산 → 기록
   ============================================================= */

const $ = id => document.getElementById(id);
const f1 = v => v.toFixed(1);
const pct = v => Math.round(v * 100) + '%';
const hhmm = h => {
  const m = Math.round((h % 24) * 60) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
};

function newStats() {
  const s = () => ({ use: 0, pv: 0, grid: 0, co2: 0, ok: 0, n: 0, wind: 0, hydro: 0, rainL: 0 });
  return { base: s(), ai: s() };
}

const sim = {
  clock: 7, nextStep: 7, running: true, speed: 40, // speed: 실제 1초당 흐르는 분
  env: new Environment(),
  base: { T_in: 22 },
  ai: { T_in: 22, soc: 0.5 * BUILDING.battCapKWh, tankL: 3000, ctrl: { w: 0, c: 0.25 } },
  hist: [],
  today: newStats(), total: newStats(), statsDay: 0,
  lastDec: null, lastPred: null,
};

function makeDisp(w, c, light) {
  return {
    w, c, light, panelAngle: 0, hvacMode: 'off', hvacKW: 0, T_in: 22, totalKW: 0, pvKW: 0, genKW: 0, soc: 0.5, battState: 'idle',
    windKW: 0, windState: 'calm', hydroKW: 0, tankFrac: 0.3, spray: 0,
  };
}
const disp = { base: makeDisp(0, 0.3, 1), ai: makeDisp(0, 0.25, 0.5) };
const target = { base: { ...disp.base }, ai: { ...disp.ai } };

/* ───────────── 15분 한 단계 ───────────── */
function doStep() {
  const t = sim.nextStep, dt = BUILDING.dt;
  const env = sim.env;
  env.update(t);

  const day = Math.floor(t / 24);
  if (day !== sim.statsDay) { sim.statsDay = day; sim.today = newStats(); }

  // ① 일반 건물: 시간표대로
  const bCtrl = baselineControl(env);
  const bRes = buildingStep(sim.base.T_in, env, bCtrl);
  const bPV = pvOutput(env, 'fixed');
  const bGrid = bRes.E_total - bPV.kW * dt;
  sim.base.T_in = bRes.T_next;

  // ② AI 건물: 신경망 예측 → 최적 조합 선택
  const spray = aiSprayRule(env, sim.ai.tankL) ? 1 : 0;
  const dec = AI.decide(env, sim.ai.T_in, sim.ai.ctrl, spray);
  const aCtrl = aiControlFrom(env, dec.w, dec.c, dec.mode, spray);
  const aRes = buildingStep(sim.ai.T_in, env, aCtrl);
  const aPV = pvOutput(env, 'track');
  const wt = windTurbine(env);
  const rain = rainSystem(sim.ai.tankL, env, spray);
  const genKW = aPV.kW + wt.kW + rain.hydroKW; // 태양광 + 풍력 + 빗물 수력
  const batt = batteryDispatch(sim.ai.soc, aRes.E_total - genKW * dt, env);
  sim.ai.T_in = aRes.T_next;
  sim.ai.soc = batt.soc;
  sim.ai.tankL = rain.tankL;
  sim.ai.ctrl = { w: dec.w, c: dec.c };

  // ③ 기록
  for (const S of [sim.today, sim.total]) {
    addStats(S.base, { use: bRes.E_total, pv: bPV.kW * dt, grid: bGrid, T: bRes.T_next }, env);
    addStats(S.ai, {
      use: aRes.E_total, pv: aPV.kW * dt, grid: batt.grid, T: aRes.T_next,
      wind: wt.kW * dt, hydro: rain.hydroKWh, rainL: rain.usedL,
    }, env);
  }

  sim.hist.push({
    label: hhmm(t), baseKW: bGrid / dt, aiKW: batt.grid / dt, genKW,
    predE: dec.pred.E, realE: aRes.E_ctrl,
  });
  if (sim.hist.length > 96) sim.hist.shift();
  sim.lastPred = { pred: dec.pred.E, real: aRes.E_ctrl };

  // ④ 화면용 목표값(애니메이션이 부드럽게 따라감)
  Object.assign(target.base, {
    w: bCtrl.w, c: bCtrl.c, light: bCtrl.light, panelAngle: 0, hvacMode: bRes.mode, hvacKW: bRes.hvacKW,
    T_in: bRes.T_next, totalKW: bRes.E_total / dt, pvKW: bPV.kW, genKW: bPV.kW,
  });
  Object.assign(target.ai, {
    w: aCtrl.w, c: aCtrl.c, light: aCtrl.light, panelAngle: aPV.angle, hvacMode: aRes.mode, hvacKW: aRes.hvacKW,
    T_in: aRes.T_next, totalKW: aRes.E_total / dt, pvKW: aPV.kW, genKW, soc: batt.soc / BUILDING.battCapKWh, battState: batt.state,
    windKW: wt.kW, windState: wt.state, hydroKW: rain.hydroKW, tankFrac: rain.tankL / BUILDING.tankCapL, spray,
  });
  disp.base.hvacMode = bRes.mode; disp.ai.hvacMode = aRes.mode; disp.ai.battState = batt.state; disp.ai.windState = wt.state;

  sim.lastDec = dec;
  renderDecision(env, dec, aRes, aPV, batt, aCtrl, wt, rain);
  renderGrid(dec, env);
  renderKPI();
  renderChips(env);
  renderCharts();
  sim.nextStep += dt;
}

function addStats(s, r, env) {
  s.use += r.use; s.pv += r.pv; s.grid += r.grid; s.co2 += r.grid * env.CI;
  s.wind += r.wind || 0; s.hydro += r.hydro || 0; s.rainL += r.rainL || 0;
  if (env.occ > 0.05) { s.n++; if (r.T >= 20.5 && r.T <= 25.5) s.ok++; }
}

/* ───────────── 화면 갱신 ───────────── */
function renderChips(env) {
  const wi = WEATHER_INFO[env.weather];
  const wlabel = env.snowing ? '❄️ 눈' : `${wi.icon} ${wi.label}`;
  $('envChips').innerHTML = [
    `🌡️ 바깥 ${f1(env.T_out)}°C`,
    wlabel + (env.precip ? ` ${Math.round(env.rainRate)} mm/h` : ''),
    `🔆 일사량 ${Math.round(env.GHI)} W/m²`,
    `💨 바람 ${f1(env.wind)} m/s`,
    `😷 미세먼지 ${Math.round(env.pm)}㎍/㎥ ${pmGrade(env.pm)}`,
    `👥 재실 ${env.people}명`, `🏭 전력 탄소계수 ${env.CI.toFixed(2)}`,
  ].map(s => `<span class="chip">${s}</span>`).join('');
}

function renderKPI() {
  const T = sim.today, b = T.base, a = T.ai;
  const comfort = s => (s.n ? Math.round(100 * s.ok / s.n) + '%' : '–');
  const TB = sim.total.base, TA = sim.total.ai;
  const saving = TB.co2 > 0.5 ? (1 - TA.co2 / TB.co2) * 100 : null;
  const saved = TB.co2 - TA.co2;
  $('kpi').innerHTML = `
    <table class="kpi">
      <thead><tr><th>오늘 (${sim.statsDay + 1}일차)</th><th>일반 건물</th><th class="ai">AI 건물</th></tr></thead>
      <tbody>
        <tr><td>건물 전력 소비</td><td>${Math.round(b.use)} kWh</td><td class="ai">${Math.round(a.use)} kWh</td></tr>
        <tr><td>태양광 발전</td><td>${f1(b.pv)} kWh</td><td class="ai">${f1(a.pv)} kWh</td></tr>
        <tr><td>풍력 발전</td><td>없음</td><td class="ai">${f1(a.wind)} kWh</td></tr>
        <tr><td>빗물 수력 발전</td><td>없음</td><td class="ai">${a.hydro.toFixed(2)} kWh</td></tr>
        <tr><td>빗물 재활용</td><td>0 L</td><td class="ai">${Math.round(a.rainL).toLocaleString()} L</td></tr>
        <tr><td>전력망 사용</td><td>${Math.round(b.grid)} kWh</td><td class="ai">${Math.round(a.grid)} kWh</td></tr>
        <tr><td>탄소 배출</td><td>${f1(b.co2)} kg</td><td class="ai">${f1(a.co2)} kg</td></tr>
        <tr><td>쾌적 시간 비율</td><td>${comfort(b)}</td><td class="ai">${comfort(a)}</td></tr>
      </tbody>
    </table>
    <div class="saving">${saving === null ? '기록을 모으는 중…' :
      saving >= 0 ? `시작부터 지금까지 AI가 탄소 배출을 <b>${saving.toFixed(1)}%</b> 줄였어요` :
      `지금까지는 AI 건물이 <b>${(-saving).toFixed(1)}%</b> 더 배출했어요`}</div>
    <div class="total">누적 절감 CO₂ ${f1(saved)} kg = 소나무 약 ${Math.max(0, saved / 6.6).toFixed(1)}그루가 1년 동안 흡수하는 양
      (30년생 소나무 1그루 ≈ 연 6.6kg)</div>`;
}

function decRow(icon, name, value, bar, reason) {
  return `<div class="dec-row"><div class="dec-icon">${icon}</div><div>
    <div class="dec-head"><span>${name}</span><b>${value}</b></div>
    <div class="bar"><i style="width:${Math.round(clamp(bar, 0, 1) * 100)}%"></i></div>
    <p>${reason}</p></div></div>`;
}

function renderDecision(env, dec, res, pv, batt, ctrl, wt, rain) {
  const T_in = res.T_next;
  const sunny = env.I_fac > 120;
  const dl = daylightRatio(env.I_fac, env.GHI, ctrl.c);

  // 창문
  let wr;
  if (env.precip) wr = `${env.snowing ? '눈이' : env.storm ? '폭우가' : '비가'} 와서 창문을 닫았어요.`;
  else if (env.pm > 35) wr = `미세먼지가 ${pmGrade(env.pm)}이라 창문을 닫고 필터 환기 장치를 돌려요.`;
  else if (env.wind >= 12) wr = '바람이 너무 강해 창문을 거의 닫았어요.';
  else if (dec.w >= 0.5) wr = `바깥이 ${f1(env.T_out)}°C로 알맞아 창문을 열어 자연 환기 → 환기팬 전력 ${BUILDING.fanKW}kW 절약.`;
  else if (dec.w > 0) wr = '조금만 열어 신선한 공기를 들이고, 열 손실은 줄였어요.';
  else if (env.occ <= 0.05) wr = '사람이 없는 시간이라 보안을 위해 닫았어요.';
  else if (env.T_out < T_in - 2) wr = '바깥이 추워서 난방 열이 새지 않게 닫았어요.';
  else if (env.T_out > T_in) wr = '바깥이 더워서 뜨거운 공기가 들어오지 않게 닫았어요.';
  else wr = 'AI 예측상 닫아 두는 편이 에너지가 덜 들어요.';

  // 커튼
  let cr;
  if (env.I_fac < 5) cr = dec.c >= 0.5 ? '밤에는 커튼을 쳐서 창문 단열 효과를 높였어요.' : '밤이라 햇빛 영향이 없어요.';
  else if (res.mode === 'cool' && dec.c >= 0.5) cr = `햇빛 열을 막아 냉방 부담을 줄여요 (들어오는 햇빛 열 ${f1(res.Q_solar)}kW).`;
  else if (dec.c <= 0.25 && sunny && env.T_out < 15) cr = `햇빛을 최대한 받아 공짜 난방을 해요 (햇빛 열 ${f1(res.Q_solar)}kW).`;
  else if (dec.c <= 0.25) cr = '커튼을 올려 자연광으로 조명 전력을 줄였어요.';
  else cr = '햇빛 열과 자연광 사이에서 균형을 맞췄어요.';

  // 태양광
  const pr = {
    night: '해가 없어 대기 중이에요.',
    stow: '강풍! 패널이 부서지지 않게 수평으로 눕혔어요.',
    snow: '눈이 쌓이지 않게 패널을 가파르게 세웠어요.',
    track: `태양(고도 ${Math.round(env.sunAlt)}°)을 따라 각도를 ${Math.round(Math.abs(pv.angle))}° ${pv.angle >= 0 ? '동쪽' : '서쪽'}으로 기울였어요.`,
  }[pv.state];

  // 조명
  const lr = env.occ <= 0.05 ? '사람이 없어 조명을 껐어요 (보안등만 켜짐).'
    : `자연광이 ${pct(dl)} 들어와서 조명을 ${pct(ctrl.light)}로 낮췄어요.`;

  // 배터리
  const br = {
    solar: '쓰고 남은 태양광 전기를 저장하는 중이에요.',
    grid: '지금은 전력망 탄소계수가 낮은 시간 → 미리 충전해 둬요.',
    discharge: '탄소가 많이 나오는 저녁 피크 → 저장한 전기를 써요.',
    idle: '대기 중 (탄소계수가 보통인 시간).',
  }[batt.state];
  const bv = batt.state === 'discharge' ? '방전' : batt.state === 'idle' ? '대기' : '충전';

  // 냉난방
  const [lo, hi] = dec.band;
  const modeText = dec.mode ? (env.occ <= 0.05 ? '출근 전에 미리 온도를 맞춰요.' : '근무 시간: 쾌적 범위를 유지해요.')
    : '사람이 없는 시간: 범위를 넓혀 전기를 아껴요.';
  const hv = res.mode === 'heat' ? `난방 ${f1(res.hvacKW)}kW` : res.mode === 'cool' ? `냉방 ${f1(res.hvacKW)}kW` : '정지';

  // 풍력
  const wtr = {
    calm: `옥상 바람이 ${f1(wt.v)} m/s로 약해요. 3 m/s부터 발전해요.`,
    run: `옥상 바람 ${f1(wt.v)} m/s로 발전 중. 발전량은 풍속의 세제곱에 비례해서 바람이 2배면 8배가 돼요.`,
    rated: `바람이 강해(${f1(wt.v)} m/s) 최대 출력 ${BUILDING.windRatedKW}kW로 발전 중이에요.`,
    brake: `태풍급 강풍(${f1(wt.v)} m/s)! 날개가 부서지지 않게 브레이크로 멈췄어요.`,
  }[wt.state];

  // 빗물 수력 + 재활용
  const tankPct = rain.tankL / BUILDING.tankCapL;
  let rr;
  if (rain.collectedL > 0) {
    rr = `비 ${Math.round(env.rainRate)}mm/h → 지붕에서 15분에 ${Math.round(rain.collectedL).toLocaleString()}L를 모아 ${BUILDING.roofHeight}m 아래로 흘리며 수차를 돌려요. ` +
         `폭우여도 수력 발전량은 작아서, 모은 빗물은 화장실 물·옥상 살수에 재활용해요.` +
         (rain.overflowL > 0 ? ' 탱크가 가득 차 넘친 물은 하수도로 보내요.' : '');
  } else if (rain.toiletL > 0) {
    rr = `비가 오지 않아요. 모아 둔 빗물 ${Math.round(rain.toiletL)}L로 화장실 물을 대신해 수돗물을 아꼈어요.`;
  } else {
    rr = rain.tankL < 1 ? '탱크에 빗물이 없어요. 비가 오면 다시 모아요.' : '비가 오면 빗물을 모아 발전하고 저장해요.';
  }

  // 옥상 살수
  let sr;
  if (ctrl.spray) sr = `덥고 햇빛이 강해서 모아 둔 빗물을 지붕에 뿌려 식혀요 (지붕으로 들어오는 열 ${f1(res.Q_roof)}kW로 줄임).`;
  else if (env.T_out > 26 && env.GHI > 400 && rain.tankL <= 200) sr = '덥지만 탱크에 빗물이 부족해서 뿌릴 수 없어요.';
  else sr = '덥지 않거나 햇빛이 약해서 지붕을 식힐 필요가 없어요.';

  // 미세먼지
  const pmr = env.pm > 75 ? '매우 나빠요! 창문을 모두 닫고 고성능 필터로만 환기해요.'
    : env.pm > 35 ? '나빠요. 창문 환기 대신 필터가 달린 환기 장치를 써요.'
    : '공기가 깨끗해서 창문으로 자연 환기를 할 수 있어요.';

  $('modeTag').textContent = dec.mode ? '쾌적 모드' : '절전 모드';
  $('decision').innerHTML =
    decRow('🪟', '창문', `열림 ${pct(dec.w)}`, dec.w, wr) +
    decRow('😷', '미세먼지 대응', `${Math.round(env.pm)}㎍/㎥ · ${pmGrade(env.pm)}`, env.pm / 100, pmr) +
    decRow('🎚️', '커튼', `내림 ${pct(dec.c)}`, dec.c, cr) +
    decRow('☀️', '태양광 패널', `${Math.round(pv.angle)}° · ${f1(pv.kW)}kW`, pv.kW / 14, pr) +
    decRow('🌬️', '풍력 발전기', wt.state === 'brake' ? '정지(강풍)' : `${f1(wt.kW)}kW`, wt.kW / BUILDING.windRatedKW, wtr) +
    decRow('💧', '빗물 수력·저장', `탱크 ${pct(tankPct)} · ${rain.hydroKW.toFixed(2)}kW`, tankPct, rr) +
    decRow('🚿', '옥상 살수 냉각', ctrl.spray ? '작동' : '꺼짐', ctrl.spray, sr) +
    decRow('💡', '조명 밝기', pct(ctrl.light), ctrl.light, lr) +
    decRow('🔋', '배터리', `${pct(batt.soc / BUILDING.battCapKWh)} · ${bv}`, batt.soc / BUILDING.battCapKWh, br) +
    decRow('🌡️', '냉난방', `${hv} · ${lo}~${hi}°C`, res.hvacKW / 40, `실내 ${f1(T_in)}°C. ${modeText}`);
}

function renderGrid(dec, env) {
  const ok = dec.candidates.filter(k => !k.blocked);
  const min = Math.min(...ok.map(k => k.cost)), max = Math.max(...ok.map(k => k.cost));
  let html = '<div class="og"><div class="og-corner">창문 ↓<br>커튼 →</div>' +
    AI.C_OPTIONS.map(c => `<div class="og-h">${c * 100}%</div>`).join('');
  for (const w of AI.W_OPTIONS) {
    html += `<div class="og-h">${w * 100}%</div>`;
    for (const c of AI.C_OPTIONS) {
      const k = dec.candidates.find(q => q.w === w && q.c === c);
      if (k.blocked) {
        html += `<div class="og-cell blocked" title="${k.blocked} 때문에 선택 불가">🚫<small>${k.blocked}</small></div>`;
      } else {
        const t = max > min ? (k.cost - min) / (max - min) : 0;
        const best = k === dec.pred;
        html += `<div class="og-cell${best ? ' best' : ''}" style="background:hsl(${Math.round(130 - 125 * t)} 60% var(--og-l))"
          title="예상 실내 ${f1(k.T)}°C · 비용 ${k.cost.toFixed(2)}">${f1(k.E)}<small>${best ? '✔ 선택' : 'kWh'}</small></div>`;
      }
    }
  }
  $('optGrid').innerHTML = html + '</div>';
  const p = dec.pred, r = dec.ref;
  const diff = r ? r.E - p.E : 0;
  $('predNote').innerHTML = `<b>AI 선택:</b> 창문 ${pct(p.w)} · 커튼 ${pct(p.c)} → 15분 동안 냉난방·조명·환기에 <b>${f1(p.E)} kWh</b> 예상
    (CO₂ ${(p.E * env.CI).toFixed(2)} kg).` +
    (r && diff > 0.05 ? ` 일반 방식(창문 닫힘·커튼 25%)보다 <b>${f1(diff)} kWh</b> 절약 예상.` : '');
}

function renderCharts() {
  const H = sim.hist, labels = H.map(h => h.label);
  drawLineChart($('chartPower'), [
    { data: H.map(h => h.genKW), color: cssVar('--pv'), fill: true, width: 1.5 },
    { data: H.map(h => h.baseKW), color: cssVar('--base') },
    { data: H.map(h => h.aiKW), color: cssVar('--accent'), width: 2.5 },
  ], { labels, unit: '' , n: 96 });
  drawLineChart($('chartPred'), [
    { data: H.map(h => h.realE), color: cssVar('--accent'), width: 2.5 },
    { data: H.map(h => h.predE), color: cssVar('--pred'), dash: [5, 4] },
  ], { labels, n: 96, ymin: 0 });
  if (sim.lastPred) {
    const { pred, real } = sim.lastPred;
    const recent = H.slice(-32);
    const mae = recent.reduce((s, h) => s + Math.abs(h.predE - h.realE), 0) / recent.length;
    $('predAcc').innerHTML = `직전 15분 — AI 예측 <b>${pred.toFixed(2)} kWh</b> / 실제 <b>${real.toFixed(2)} kWh</b>.
      최근 8시간 평균 오차 <b>${mae.toFixed(2)} kWh</b>.`;
  }
}

function renderTraining() {
  const hst = AI.history;
  drawLineChart($('chartTrain'), [
    { data: hst.map(h => h.train), color: cssVar('--muted') },
    { data: hst.map(h => h.test), color: cssVar('--pred'), width: 2.5 },
  ], { labels: hst.map((_, i) => (i + 1) % 10 === 0 ? `${i + 1}회` : ''), n: AI.EPOCHS, ymin: 0 });
  if (AI.trained) {
    const m = AI.metrics;
    $('trainInfo').innerHTML = `신경망 구조: 입력 ${AI.LAYERS.slice(0, -1).join(' → ')} → 출력 2 (매개변수 ${AI.net.paramCount.toLocaleString()}개)<br>
      학습 데이터 ${AI.N_TRAIN.toLocaleString()}개로 ${AI.EPOCHS}번 반복 학습, 처음 보는 시험 데이터 ${AI.N_TEST.toLocaleString()}개로 평가:<br>
      전력량 예측 평균 오차 <b>${m.maeE.toFixed(2)} kWh</b> (평균값 ${m.meanE.toFixed(1)} kWh), 결정계수 R² <b>${m.r2.toFixed(3)}</b>,
      온도 변화 예측 오차 <b>${m.maeT.toFixed(3)}°C</b><br>
      <span class="muted">입력: ${FEATURE_NAMES.join(', ')}</span>`;
  } else {
    $('trainInfo').innerHTML = `학습 중… ${Math.round(AI.progress * 100)}%`;
  }
}

/* ───────────── 컨트롤 ───────────── */
function setupControls() {
  const season = m => (m <= 2 || m === 12 ? '겨울' : m <= 5 ? '봄' : m <= 8 ? '여름' : '가을');
  $('selMonth').innerHTML = Array.from({ length: 12 }, (_, i) =>
    `<option value="${i + 1}">${i + 1}월 (${season(i + 1)}, 평균 ${CLIMATE.monthlyMeanTemp[i]}°C)</option>`).join('');
  $('selMonth').value = sim.env.month;
  $('selMonth').onchange = e => { sim.env.month = +e.target.value; sim.env.T_out = null; };
  $('selWeather').onchange = e => {
    sim.env.weatherMode = e.target.value;
    if (e.target.value !== 'auto') sim.env.weather = e.target.value;
    else sim.env.nextWeatherCheck = sim.clock + 3;
  };
  $('selWind').onchange = e => { sim.env.windMode = e.target.value; };
  $('selPM').onchange = e => { sim.env.pmMode = e.target.value; };
  $('rngTemp').oninput = e => {
    sim.env.tempOffset = +e.target.value;
    $('lblTemp').textContent = (e.target.value > 0 ? '+' : '') + e.target.value + '°C';
  };
  $('selSpeed').onchange = e => { sim.speed = +e.target.value; };
  $('btnPlay').onclick = () => {
    sim.running = !sim.running;
    $('btnPlay').textContent = sim.running ? '⏸ 일시정지' : '▶ 재생';
  };
  $('btnSkip').onclick = () => {
    if (!AI.trained) return;
    for (let i = 0; i < 12; i++) doStep();
    sim.clock = sim.nextStep - BUILDING.dt;
    for (const k of ['base', 'ai']) Object.assign(disp[k], target[k]);
  };
  $('btnRetrain').onclick = () => { AI.init(); renderTraining(); };
}

/* ───────────── 애니메이션 루프 ───────────── */
function approach(d, t, dt) {
  const k = Math.min(1, dt * 3);
  for (const key of ['w', 'c', 'light', 'panelAngle', 'hvacKW', 'T_in', 'totalKW', 'pvKW', 'genKW', 'soc', 'windKW', 'hydroKW', 'tankFrac', 'spray']) {
    d[key] += (t[key] - d[key]) * k;
  }
}

let lastFrame = performance.now();
let trainUiTimer = 0;
function frame(now) {
  const dtReal = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  if (!AI.trained) {
    AI.trainChunk(22);
    trainUiTimer += dtReal;
    if (trainUiTimer > 0.25 || AI.trained) { trainUiTimer = 0; renderTraining(); }
    if (AI.trained) doStep(); // 학습이 끝나면 바로 첫 판단
  } else if (sim.running) {
    sim.clock += dtReal * sim.speed / 60;
    let guard = 0;
    while (sim.clock >= sim.nextStep && guard++ < 50) doStep();
  }

  approach(disp.base, target.base, dtReal);
  approach(disp.ai, target.ai, dtReal);
  $('clockDay').textContent = `${Math.floor(sim.clock / 24) + 1}일차 · ${sim.env.month}월`;
  $('clockTime').textContent = hhmm(sim.clock);

  const env = sim.env;
  renderer.draw({
    hour: sim.clock % 24, month: env.month, sun: sunPosition(env.month, sim.clock % 24),
    weather: env.weather, snowing: env.snowing, wind: env.wind, T_out: env.T_out, pm: env.pm, rainRate: env.rainRate,
    base: disp.base, ai: disp.ai,
    training: AI.trained ? null : {
      progress: AI.progress, epoch: AI.epoch,
      loss: AI.history.length ? AI.history[AI.history.length - 1].test : null,
    },
  }, dtReal);
  requestAnimationFrame(frame);
}

/* ───────────── 시작 ───────────── */
const renderer = new SceneRenderer($('scene'));
sim.env.update(sim.clock);
renderChips(sim.env);
setupControls();
AI.init();
renderTraining();
window.addEventListener('resize', () => { if (AI.trained) renderCharts(); renderTraining(); });
requestAnimationFrame(frame);
