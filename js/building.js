'use strict';
/* =============================================================
   building.js — 건물 에너지 물리 모델
   -------------------------------------------------------------
   15분마다 "열이 얼마나 들어오고 나가는지"를 계산해서
   다음 실내 온도와 사용한 전력량을 구합니다.

   들어오는 열: 햇빛(창문), 사람 체온, 조명, 컴퓨터 등 기기
   나가는 열:   벽·창문을 통한 열 손실, 환기(창문 열기·환기팬)
   부족하거나 넘치는 열은 냉난방기(히트펌프)가 전기로 채움
   ============================================================= */

const BUILDING = {
  dt: 0.25,            // 계산 간격: 0.25시간 = 15분
  C: 30,               // 열용량(kWh/°C): 건물이 열을 저장하는 능력
  UA_envelope: 1.3,    // 벽·지붕의 열 손실 계수(kW/°C)
  UA_window: 0.35,     // 창문의 열 손실 계수(kW/°C)
  UA_mech: 0.6,        // 환기팬이 돌 때 생기는 열 손실(열회수 후)
  windowArea: 72,      // 남쪽 창문 면적(m²)
  SHGC: 0.4,           // 창문이 햇빛 열을 통과시키는 비율
  lightMaxKW: 10,      // 조명 최대 전력
  fanKW: 3.5,          // 기계식 환기팬 전력
  equipBaseKW: 2,      // 항상 켜진 기기(서버, 냉장고 등)
  equipOccKW: 6,       // 사람이 있을 때 쓰는 기기(컴퓨터 등)
  personKW: 0.08,      // 사람 1명의 체온 열
  hvacMaxKW: 120,      // 냉난방기 최대 능력(열량)
  pvArea: 70,          // 태양광 패널 면적(m²)
  pvEff: 0.20,         // 패널 효율 20%
  battCapKWh: 40,      // 배터리 용량
  battKW: 10,          // 배터리 최대 충·방전 속도
  battEff: 0.92,       // 충전 효율
  // ── 지붕 ──
  roofArea: 300,       // 지붕 면적(m²) = 빗물을 모으는 면적
  roofU: 0.35,         // 지붕 단열 성능(W/m²K)
  // ── 빗물 수력 발전 + 저장 탱크 ──
  roofHeight: 18,      // 지붕에서 지상 탱크까지 물이 떨어지는 높이(m)
  hydroEff: 0.6,       // 소형 수차 효율
  tankCapL: 10000,     // 빗물 탱크 10톤
  toiletLPerStep: 35,  // 근무 시간 15분당 화장실 물 사용량(L)
  sprayLPerStep: 60,   // 옥상 살수 15분당 사용량(L)
  // ── 옥상 소형 풍력 발전기 ──
  windRotorArea: 8,    // 날개가 휩쓰는 면적(m², 지름 약 3.2m)
  windCp: 0.3,         // 바람 에너지 중 전기로 바꾸는 비율
  windRatedKW: 2.5,    // 최대 출력
  windCutIn: 3,        // 이 풍속부터 발전 시작(m/s)
  windCutOut: 20,      // 이 풍속 이상이면 고장 방지를 위해 정지(m/s)
};

// 쾌적 온도 범위(°C)
const COMFORT = { occupied: [21, 25], unoccupied: [17, 28], ideal: 23 };

/* 자연광 비율(0~1): 커튼을 내리면 줄어듦 */
function daylightRatio(I_fac, GHI, c) {
  return clamp((0.6 * I_fac + 0.4 * GHI) / 350, 0, 1) * (1 - 0.9 * c);
}

/* 냉난방기 효율(COP): 전기 1로 열 몇을 옮기는지. 바깥이 너무 춥거나 더우면 떨어짐 */
function heatingCOP(T_out) { return clamp(3.0 + 0.05 * (T_out - 7), 1.8, 4.0); }
function coolingCOP(T_out) { return clamp(3.6 - 0.06 * (T_out - 27), 2.2, 4.5); }

/* 건물 15분 계산
   ctrl = { w: 창문 열림(0~1), c: 커튼 내림(0~1), band: [최저, 최고 온도], light: 조명(0~1) } */
function buildingStep(T_in, env, ctrl) {
  const B = BUILDING, dt = B.dt;
  const occ = env.occ;
  const occupied = occ > 0.05;

  // 1) 들어오는 열(kW)
  const Q_solar = B.windowArea * B.SHGC * env.I_fac / 1000 * (1 - 0.75 * ctrl.c);
  // 햇빛에 달궈진 지붕이 전하는 열. 옥상에 물을 뿌리면(증발 냉각) 크게 줄어듦
  const Q_roof = B.roofArea * B.roofU * (0.7 * env.GHI / 17) / 1000 * (1 - 0.8 * (ctrl.spray || 0));
  const lightKW = B.lightMaxKW * ctrl.light;
  const equipKW = B.equipBaseKW + B.equipOccKW * occ;
  const Q_internal = occ * CLIMATE.maxPeople * B.personKW + lightKW + equipKW;

  // 2) 바깥과 주고받는 열의 통로(kW/°C)
  const UA_cond = B.UA_envelope + B.UA_window * (1 - 0.6 * ctrl.c); // 두꺼운 단열 커튼은 창문 열 손실을 줄임
  const UA_natural = 0.1 + ctrl.w * (1.2 + 0.25 * env.wind);         // 창문 환기(바람 강하면 더 많이)
  const freshByWindow = clamp(ctrl.w / 0.5, 0, 1);                    // 창문을 50% 이상 열면 환기 충분
  const fanFrac = occupied ? 1 - freshByWindow : 0;                    // 부족한 환기는 환기팬이 담당
  const fanKW = B.fanKW * fanFrac;
  const UA_total = UA_cond + UA_natural + B.UA_mech * fanFrac;

  // 3) 냉난방 없이 15분 뒤 온도
  const Q_net = Q_solar + Q_roof + Q_internal + UA_total * (env.T_out - T_in);
  const T_free = T_in + Q_net * dt / B.C;

  // 4) 쾌적 범위를 벗어나면 냉난방
  const [lo, hi] = ctrl.band;
  let Q_heat = 0, Q_cool = 0, T_next = T_free;
  if (T_free < lo) {
    Q_heat = Math.min(B.hvacMaxKW, (lo - T_free) * B.C / dt);
    T_next = T_free + Q_heat * dt / B.C;
  } else if (T_free > hi) {
    Q_cool = Math.min(B.hvacMaxKW, (T_free - hi) * B.C / dt);
    T_next = T_free - Q_cool * dt / B.C;
  }
  const hvacKW = Q_heat / heatingCOP(env.T_out) + Q_cool / coolingCOP(env.T_out);

  // 5) 전력량(kWh) = 전력(kW) × 시간(h)
  const E_ctrl = (hvacKW + lightKW + fanKW) * dt; // AI가 조절할 수 있는 부분
  return {
    T_next, Q_solar, Q_roof, Q_heat, Q_cool, hvacKW, lightKW, fanKW, equipKW, E_ctrl,
    E_total: E_ctrl + equipKW * dt,
    mode: Q_heat > 0 ? 'heat' : Q_cool > 0 ? 'cool' : 'off',
  };
}

/* 일반 건물: 정해진 시간표대로만 운영 */
function baselineControl(env) {
  const scheduleOn = env.hour >= 5 && env.hour < 21; // 타이머: 5시~21시 냉난방
  return {
    w: 0,                                   // 창문 항상 닫힘
    c: 0.3,                                 // 커튼 고정
    band: scheduleOn ? COMFORT.occupied : COMFORT.unoccupied,
    light: env.occ > 0.05 ? 1 : 0.1,        // 근무 시간엔 조명 100%
  };
}

/* 태양광 패널 발전량
   fixed: 남쪽 30° 고정 / track: 태양을 따라 각도 조절 */
function pvOutput(env, mode) {
  const B = BUILDING;
  const alt = env.sunAlt, az = env.sunAz;
  let poa = 0, angle = 0, state = 'night';
  if (alt > 0) {
    if (mode === 'fixed') {
      const tilt = 30;
      const cosInc = Math.sin(alt * DEG) * Math.cos(tilt * DEG) +
                     Math.cos(alt * DEG) * Math.sin(tilt * DEG) * Math.cos((az - 180) * DEG);
      poa = env.DNI * Math.max(0, cosInc) + env.DHI * (1 + Math.cos(tilt * DEG)) / 2;
      state = 'fixed';
      if (env.snowing) poa *= 0.25; // 눈이 쌓여 햇빛을 가림
    } else if (env.wind >= 12) {
      // 강풍: 패널이 부서지지 않게 수평으로 눕힘
      poa = env.DNI * Math.sin(alt * DEG) + env.DHI;
      state = 'stow';
    } else if (env.snowing) {
      // 눈: 패널을 가파르게 세워 눈을 미끄러뜨림
      angle = az < 180 ? 60 : -60;
      poa = (env.DNI * 0.5 + env.DHI) * 0.7;
      state = 'snow';
    } else {
      // 태양 추적: 햇빛을 정면으로 받음
      poa = env.DNI + env.DHI * (1 + Math.cos((90 - alt) * DEG)) / 2;
      angle = clamp((90 - alt) * Math.sin((180 - az) * DEG), -65, 65);
      state = 'track';
    }
  }
  const T_cell = env.T_out + 0.03 * poa; // 패널이 뜨거우면 효율이 떨어짐
  const kW = B.pvArea * B.pvEff * poa / 1000 * clamp(1 - 0.004 * (T_cell - 25), 0.75, 1.1);
  return { kW, angle, state };
}

/* 옥상 소형 풍력 발전기
   바람의 힘 = ½ × 공기 밀도 × 면적 × 풍속³  → 풍속이 2배면 발전량은 8배! */
function windTurbine(env) {
  const B = BUILDING;
  const v = env.wind * 1.3; // 옥상은 지면보다 바람이 강함
  if (v >= B.windCutOut) return { kW: 0, v, state: 'brake' };
  if (v < B.windCutIn) return { kW: 0, v, state: 'calm' };
  const kW = Math.min(B.windRatedKW, 0.5 * 1.225 * B.windRotorArea * v ** 3 * B.windCp / 1000);
  return { kW, v, state: kW >= B.windRatedKW ? 'rated' : 'run' };
}

/* 빗물 시스템: 지붕에 떨어진 빗물을 홈통으로 모아 18m 아래 탱크로 흘려보내며
   중간의 작은 수차를 돌려 발전(위치 에너지 = 질량 × 중력가속도 × 높이)
   모은 빗물은 화장실 물과 옥상 살수에 재활용 */
function rainSystem(tankL, env, sprayOn) {
  const B = BUILDING, dt = B.dt;
  const collectedL = B.roofArea * env.rainRate * dt;         // 1mm × 1m² = 1L
  const hydroKWh = collectedL * 9.81 * B.roofHeight * B.hydroEff / 3.6e6;
  tankL += collectedL;
  const overflowL = Math.max(0, tankL - B.tankCapL);
  tankL -= overflowL;
  const toiletL = Math.min(tankL, B.toiletLPerStep * env.occ);
  tankL -= toiletL;
  const sprayL = sprayOn ? Math.min(tankL, B.sprayLPerStep) : 0;
  tankL -= sprayL;
  return { tankL, collectedL, hydroKW: hydroKWh / dt, hydroKWh, toiletL, sprayL, usedL: toiletL + sprayL, overflowL };
}

/* 배터리 운영(전력 조절)
   netKWh = 건물 사용량 − 태양광 발전량 (양수면 전기가 부족) */
function batteryDispatch(soc, netKWh, env) {
  const B = BUILDING, maxE = B.battKW * B.dt, reserve = 0.15 * B.battCapKWh;
  let charge = 0, discharge = 0, state = 'idle';
  if (netKWh < 0) {
    charge = Math.min(-netKWh, maxE, (B.battCapKWh - soc) / B.battEff);
    if (charge > 0.01) state = 'solar';
  } else if (env.CI <= 0.42 && soc < B.battCapKWh * 0.95) {
    // 전력망이 깨끗한 시간에는 천천히(최대 4kW) 미리 충전
    charge = Math.min(4 * B.dt, (B.battCapKWh - soc) / B.battEff);
    if (charge > 0.01) state = 'grid';
  } else if (env.CI >= 0.49 && soc > reserve) {
    discharge = Math.min(netKWh, maxE, soc - reserve);
    if (discharge > 0.01) state = 'discharge';
  }
  soc = clamp(soc + charge * B.battEff - discharge, 0, B.battCapKWh);
  return { soc, grid: netKWh + charge - discharge, charge, discharge, state };
}
