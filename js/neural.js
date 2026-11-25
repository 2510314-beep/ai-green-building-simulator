'use strict';
/* =============================================================
   neural.js — 직접 만든 작은 딥러닝 신경망
   -------------------------------------------------------------
   라이브러리 없이 "다층 퍼셉트론(MLP)"을 구현했습니다.
   입력(9개) → 은닉층 32 → 32 → 16 → 출력(2개)

   학습 원리
   1) 순전파: 입력에 가중치를 곱하고 더해 예측값을 만든다
   2) 오차 계산: 예측값 − 실제값
   3) 역전파: 오차를 거꾸로 전달해 각 가중치가 오차에 얼마나 책임 있는지 계산
   4) Adam 최적화: 오차가 줄어드는 방향으로 가중치를 조금씩 수정
   ============================================================= */

class NeuralNetwork {
  constructor(sizes) {
    this.sizes = sizes;
    this.L = sizes.length - 1; // 가중치 층 개수
    this.W = []; this.b = [];
    this.gW = []; this.gb = [];
    this.mW = []; this.vW = []; this.mb = []; this.vb = [];
    for (let l = 0; l < this.L; l++) {
      const nin = sizes[l], nout = sizes[l + 1];
      const limit = Math.sqrt(6 / (nin + nout)); // Xavier 초기화
      const W = new Float64Array(nin * nout);
      for (let k = 0; k < W.length; k++) W[k] = (Math.random() * 2 - 1) * limit;
      this.W.push(W);
      this.b.push(new Float64Array(nout));
      this.gW.push(new Float64Array(nin * nout)); this.gb.push(new Float64Array(nout));
      this.mW.push(new Float64Array(nin * nout)); this.vW.push(new Float64Array(nin * nout));
      this.mb.push(new Float64Array(nout)); this.vb.push(new Float64Array(nout));
    }
    this.step = 0;
  }

  /* 순전파: 각 층의 출력을 모두 돌려줌(역전파에 필요) */
  forward(x) {
    const acts = [x];
    let a = x;
    for (let l = 0; l < this.L; l++) {
      const nin = this.sizes[l], nout = this.sizes[l + 1];
      const W = this.W[l], b = this.b[l];
      const z = new Float64Array(nout);
      const hidden = l < this.L - 1;
      for (let j = 0; j < nout; j++) {
        let s = b[j];
        const off = j * nin;
        for (let i = 0; i < nin; i++) s += W[off + i] * a[i];
        z[j] = hidden ? Math.tanh(s) : s; // 은닉층은 tanh 활성화, 출력층은 그대로
      }
      acts.push(z);
      a = z;
    }
    return acts;
  }

  predict(x) {
    const acts = this.forward(x);
    return acts[acts.length - 1];
  }

  /* 미니배치 하나로 학습하고 평균 제곱 오차를 돌려줌 */
  trainBatch(X, Y, lr) {
    for (let l = 0; l < this.L; l++) { this.gW[l].fill(0); this.gb[l].fill(0); }
    let loss = 0;
    for (let s = 0; s < X.length; s++) {
      const acts = this.forward(X[s]);
      const out = acts[this.L], y = Y[s];
      let delta = new Float64Array(out.length);
      for (let j = 0; j < out.length; j++) {
        const e = out[j] - y[j];
        delta[j] = e;
        loss += e * e;
      }
      // 역전파
      for (let l = this.L - 1; l >= 0; l--) {
        const nin = this.sizes[l], nout = this.sizes[l + 1];
        const aPrev = acts[l], W = this.W[l], gW = this.gW[l], gb = this.gb[l];
        const prevDelta = l > 0 ? new Float64Array(nin) : null;
        for (let j = 0; j < nout; j++) {
          const dj = delta[j];
          if (dj === 0) continue;
          gb[j] += dj;
          const off = j * nin;
          for (let i = 0; i < nin; i++) {
            gW[off + i] += dj * aPrev[i];
            if (prevDelta) prevDelta[i] += W[off + i] * dj;
          }
        }
        if (prevDelta) {
          for (let i = 0; i < nin; i++) prevDelta[i] *= 1 - aPrev[i] * aPrev[i]; // tanh 미분
          delta = prevDelta;
        }
      }
    }
    // Adam 최적화
    this.step++;
    const b1 = 0.9, b2 = 0.999, eps = 1e-8, n = X.length;
    const c1 = 1 - Math.pow(b1, this.step), c2 = 1 - Math.pow(b2, this.step);
    const adam = (P, G, M, V) => {
      for (let k = 0; k < P.length; k++) {
        const g = G[k] / n;
        M[k] = b1 * M[k] + (1 - b1) * g;
        V[k] = b2 * V[k] + (1 - b2) * g * g;
        P[k] -= lr * (M[k] / c1) / (Math.sqrt(V[k] / c2) + eps);
      }
    };
    for (let l = 0; l < this.L; l++) {
      adam(this.W[l], this.gW[l], this.mW[l], this.vW[l]);
      adam(this.b[l], this.gb[l], this.mb[l], this.vb[l]);
    }
    return loss / (n * Y[0].length);
  }

  get paramCount() {
    let n = 0;
    for (let l = 0; l < this.L; l++) n += this.W[l].length + this.b[l].length;
    return n;
  }
}
