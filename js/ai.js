'use strict';
/* =============================================================
   ai.js — AI 두뇌: 학습 + 예측 + 최적 제어
   -------------------------------------------------------------
   1) 과거 데이터 만들기: 다양한 날씨·상황에서 건물이 쓴 에너지 기록 6,000개
   2) 신경망 학습: "이런 상황에서 이렇게 조절하면 → 에너지 얼마, 온도 몇 도"를 배움
   3) 실시간 최적 제어: 15분마다 창문 4단계 × 커튼 5단계 = 20가지 조합을
      신경망으로 미리 예측해 보고, 탄소 배출 + 불쾌감이 가장 적은 조합을 선택
   ============================================================= */

/* 사람이 있거나 출근 2시간 전이면 '쾌적 모드' */
function aiComfortMode(hour, occ) {
  return occ > 0.05 || (hour >= 5 && hour < 7) ? 1 : 0;
}
function aiBand(mode) { return mode ? COMFORT.occupied : COMFORT.unoccupied; }

/* AI 건물의 조명: 자연광이 부족한 만큼만 켬(디밍), 사람 없으면 끔 */
function aiLightLevel(occ, daylight) {
  return occ > 0.05 ? clamp(1 - daylight, 0, 1) : 0.02;
}

function aiControlFrom(env, w, c, mode, spray = 0) {
  return {
    w, c, spray,
    band: aiBand(mode),
    light: aiLightLevel(env.occ, daylightRatio(env.I_fac, env.GHI, c)),
  };
}

/* 옥상 살수 규칙: 덥고 햇빛이 강하고, 모아 둔 빗물이 있을 때만 */
function aiSprayRule(env, tankL) {
  return tankL > 200 && env.GHI > 400 && env.T_out > 26 && !env.precip;
}

/* 신경망 입력 10개 */
const FEATURE_NAMES = ['바깥 기온', '실내 기온', '창문 면 일사량', '수평 일사량', '풍속', '재실률', '쾌적 모드', '창문 열림', '커튼 내림', '옥상 살수'];
function makeFeatures(env, T_in, mode, w, c, spray = 0) {
  return [env.T_out, T_in, env.I_fac, env.GHI, env.wind, env.occ, mode, w, c, spray];
}

const AI = {
  W_OPTIONS: [0, 0.25, 0.5, 1],
  C_OPTIONS: [0, 0.25, 0.5, 0.75, 1],
  N_TRAIN: 6000,
  N_TEST: 1000,
  EPOCHS: 50,
  BATCH: 64,
  LAYERS: [10, 32, 32, 16, 2],
  trained: false,

  /* 과거 데이터 1개 생성: 무작위 상황 → 물리 모델로 결과 기록 */
  _sample() {
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    const sunUp = Math.random() < 0.65;
    const GHI = sunUp ? Math.random() * 1000 : 0;
    const I_fac = sunUp ? Math.random() * Math.min(800, 150 + GHI) : 0;
    const env = {
      T_out: -15 + Math.random() * 53,
      I_fac, GHI,
      wind: Math.random() * 15,
      occ: Math.random() < 0.45 ? 0 : 0.2 + Math.random() * 0.8,
    };
    const mode = env.occ > 0.05 ? 1 : (Math.random() < 0.3 ? 1 : 0);
    const T_in = 15 + Math.random() * 15;
    const w = Math.random() < 0.75 ? pick(this.W_OPTIONS) : Math.random();
    const c = Math.random() < 0.75 ? pick(this.C_OPTIONS) : Math.random();
    const spray = GHI > 300 && Math.random() < 0.35 ? 1 : 0;
    const r = buildingStep(T_in, env, aiControlFrom(env, w, c, mode, spray));
    // 출력 2개: 15분 동안 쓴 전력량(kWh), 실내 온도 변화(°C)
    return { x: makeFeatures(env, T_in, mode, w, c, spray), y: [r.E_ctrl, r.T_next - T_in] };
  },

  init() {
    this.trained = false;
    const all = [];
    for (let i = 0; i < this.N_TRAIN + this.N_TEST; i++) all.push(this._sample());
    const train = all.slice(0, this.N_TRAIN), test = all.slice(this.N_TRAIN);

    // 정규화: 값의 크기를 비슷하게 맞추면 학습이 잘 됨
    const stats = (rows, key, n) => {
      const mean = new Array(n).fill(0), std = new Array(n).fill(0);
      rows.forEach(r => r[key].forEach((v, i) => { mean[i] += v / rows.length; }));
      rows.forEach(r => r[key].forEach((v, i) => { std[i] += (v - mean[i]) ** 2 / rows.length; }));
      return { mean, std: std.map(s => Math.sqrt(s) || 1) };
    };
    this.inNorm = stats(train, 'x', this.LAYERS[0]);
    this.outNorm = stats(train, 'y', 2);
    const nIn = x => Float64Array.from(x, (v, i) => (v - this.inNorm.mean[i]) / this.inNorm.std[i]);
    const nOut = y => Float64Array.from(y, (v, i) => (v - this.outNorm.mean[i]) / this.outNorm.std[i]);
    this.trainX = train.map(s => nIn(s.x)); this.trainY = train.map(s => nOut(s.y));
    this.testX = test.map(s => nIn(s.x));   this.testY = test.map(s => nOut(s.y));
    this.testRaw = test;
    this._normIn = nIn;

    this.net = new NeuralNetwork(this.LAYERS);
    this.order = [...Array(this.N_TRAIN).keys()];
    this._shuffle();
    this.epoch = 0; this.batchIdx = 0;
    this.epochLoss = 0; this.epochBatches = 0;
    this.history = [];
    this.metrics = null;
  },

  _shuffle() {
    for (let i = this.order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    }
  },

  get batchesPerEpoch() { return Math.ceil(this.N_TRAIN / this.BATCH); },
  get progress() { return (this.epoch + this.batchIdx / this.batchesPerEpoch) / this.EPOCHS; },

  _testLoss() {
    let s = 0;
    for (let i = 0; i < this.testX.length; i++) {
      const p = this.net.predict(this.testX[i]);
      s += (p[0] - this.testY[i][0]) ** 2 + (p[1] - this.testY[i][1]) ** 2;
    }
    return s / (this.testX.length * 2);
  },

  /* 화면이 멈추지 않도록 정해진 시간(ms)만큼만 학습하고 다음 프레임에 이어서 */
  trainChunk(budgetMs) {
    const t0 = performance.now();
    while (!this.trained && performance.now() - t0 < budgetMs) {
      const start = this.batchIdx * this.BATCH;
      if (start >= this.N_TRAIN) {
        this.history.push({ train: this.epochLoss / this.epochBatches, test: this._testLoss() });
        this.epoch++; this.batchIdx = 0; this.epochLoss = 0; this.epochBatches = 0;
        this._shuffle();
        if (this.epoch >= this.EPOCHS) this._finish();
        continue;
      }
      const idx = this.order.slice(start, start + this.BATCH);
      const lr = 0.003 * (1 - 0.8 * this.epoch / this.EPOCHS);
      this.epochLoss += this.net.trainBatch(idx.map(i => this.trainX[i]), idx.map(i => this.trainY[i]), lr);
      this.epochBatches++;
      this.batchIdx++;
    }
  },

  /* 시험 데이터(학습에 안 쓴 데이터)로 정확도 측정 */
  _finish() {
    let maeE = 0, maeT = 0, ssRes = 0, ssTot = 0;
    const meanE = this.testRaw.reduce((s, r) => s + r.y[0], 0) / this.testRaw.length;
    this.testRaw.forEach((r, i) => {
      const p = this._denorm(this.net.predict(this.testX[i]));
      maeE += Math.abs(p[0] - r.y[0]);
      maeT += Math.abs(p[1] - r.y[1]);
      ssRes += (p[0] - r.y[0]) ** 2;
      ssTot += (r.y[0] - meanE) ** 2;
    });
    const n = this.testRaw.length;
    this.metrics = { maeE: maeE / n, maeT: maeT / n, r2: 1 - ssRes / ssTot, meanE };
    this.trained = true;
  },

  _denorm(p) {
    return [p[0] * this.outNorm.std[0] + this.outNorm.mean[0], p[1] * this.outNorm.std[1] + this.outNorm.mean[1]];
  },

  /* 신경망 예측: 이 조합으로 15분 운영하면? */
  predict(env, T_in, mode, w, c, spray = 0) {
    const p = this._denorm(this.net.predict(this._normIn(makeFeatures(env, T_in, mode, w, c, spray))));
    return { E: Math.max(0, p[0]), T: T_in + p[1] };
  },

  /* 최적 제어: 20가지 조합을 모두 예측해 보고 비용이 가장 낮은 것 선택
     비용 = 예상 탄소 배출(kg) + 쾌적 온도(23°C)에서 벗어난 정도 + 너무 자주 바꾸는 것 방지 */
  decide(env, T_in, prev, spray = 0) {
    const mode = aiComfortMode(env.hour, env.occ);
    const candidates = [];
    let best = null;
    for (const w of this.W_OPTIONS) {
      for (const c of this.C_OPTIONS) {
        let blocked = null; // 안전·건강·보안 규칙
        if (env.precip && w > 0) blocked = env.snowing ? '눈' : env.storm ? '폭우' : '비';
        else if (env.pm > 35 && w > 0) blocked = '미세먼지';
        else if (env.wind >= 12 && w > 0.25) blocked = '강풍';
        else if (env.occ <= 0.05 && w > 0.25) blocked = '보안';
        const cand = { w, c, blocked };
        if (!blocked) {
          const p = this.predict(env, T_in, mode, w, c, spray);
          cand.E = p.E; cand.T = p.T;
          // 사람이 없을 때도 실내가 21~25°C에서 너무 멀어지면 아침에 다시 맞추는 에너지가 드니 약하게 감점
          const [lo, hi] = COMFORT.occupied;
          const comfort = mode ? 0.3 * Math.abs(p.T - COMFORT.ideal)
                               : 0.15 * Math.max(0, lo - p.T, p.T - hi);
          const change = 0.03 * (Math.abs(w - prev.w) + Math.abs(c - prev.c));
          cand.cost = p.E * env.CI + comfort + change;
          if (!best || cand.cost < best.cost) best = cand;
        }
        candidates.push(cand);
      }
    }
    // 비교용: 일반 건물처럼 창문 닫고 커튼 25%일 때의 예측
    const ref = candidates.find(k => k.w === 0 && k.c === 0.25);
    return { w: best.w, c: best.c, mode, band: aiBand(mode), pred: best, ref, candidates };
  },
};
