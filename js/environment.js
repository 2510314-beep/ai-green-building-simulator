'use strict';
/* =============================================================
   environment.js — 건물 주변 환경 모델
   -------------------------------------------------------------
   건물 "바깥"의 상황을 계산하는 파일입니다.
   - 태양의 위치(고도·방위각): 천문학 공식으로 계산
   - 일사량(햇빛 세기): 맑음 / 흐림 / 비에 따라 달라짐
   - 바깥 기온: 서울 월평균 기온 + 하루 중 온도 변화
   - 바람, 재실 인원(출퇴근 시간표), 전력망 탄소계수
   ============================================================= */

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

const CLIMATE = {
  latitude: 37.57, // 서울의 위도(°)
  // 서울 월평균 기온(°C, 기상청 평년값 근사)
  monthlyMeanTemp: [-2.4, 0.4, 5.7, 12.5, 17.8, 22.2, 24.9, 25.7, 21.2, 14.8, 7.2, 0.4],
  // 달마다 비가 올 확률(장마철인 7~8월이 높음)
  monthlyRainChance: [0.08, 0.08, 0.12, 0.12, 0.14, 0.22, 0.38, 0.32, 0.18, 0.10, 0.12, 0.10],
  maxPeople: 80, // 건물에서 일하는 최대 인원
  // 월별 평균 초미세먼지(PM2.5, ㎍/㎥) 근사: 겨울·봄(황사)에 높고 여름에 낮음
  monthlyPM: [38, 40, 42, 34, 26, 22, 16, 15, 16, 20, 28, 34],
};

// 초미세먼지 등급(환경부 기준)
function pmGrade(pm) {
  if (pm <= 15) return '좋음';
  if (pm <= 35) return '보통';
  if (pm <= 75) return '나쁨';
  return '매우 나쁨';
}
const PM_LEVELS = { good: 10, bad: 55, verybad: 110 };

// 날씨별 특성: direct = 직사광 비율, diffuse = 산란광 배율, amp = 하루 기온 변화 폭
const WEATHER_INFO = {
  clear:  { label: '맑음', icon: '☀️', direct: 1.00, diffuse: 1.0, amp: 5.0, adj: 0.0,  cloud: 0.08 },
  cloudy: { label: '흐림', icon: '☁️', direct: 0.25, diffuse: 2.2, amp: 3.2, adj: -0.8, cloud: 0.65 },
  rain:   { label: '비',   icon: '🌧️', direct: 0.03, diffuse: 1.3, amp: 2.0, adj: -2.0, cloud: 1.0 },
  storm:  { label: '폭우', icon: '⛈️', direct: 0.00, diffuse: 0.9, amp: 1.5, adj: -2.5, cloud: 1.0 },
};

const WIND_LEVELS = { calm: 1, normal: 5, strong: 14, typhoon: 23 };

/* 시간대별 재실률(0~1): 7시 출근 시작, 12시 점심, 18~20시 퇴근 */
function occupancyAt(hour) {
  if (hour < 7 || hour >= 20) return 0;
  if (hour < 9) return (hour - 7) / 2;
  if (hour >= 12 && hour < 13) return 0.6;
  if (hour >= 18) return 1 - (hour - 18) / 2;
  return 1;
}

/* 전력망 탄소계수(kg CO₂/kWh)
   한국 평균은 약 0.46. 낮에는 태양광 발전이 많아 낮아지고,
   저녁 피크 시간에는 화력 발전이 늘어 높아진다고 가정했습니다. */
function carbonIntensityAt(hour) {
  const solar = hour > 7 && hour < 18 ? Math.sin(Math.PI * (hour - 7) / 11) : 0;
  const evening = Math.exp(-Math.pow(hour - 19.5, 2) / 3);
  return 0.46 - 0.06 * solar + 0.06 * evening;
}

/* 태양 위치 계산 (고도 alt: 지평선 위 각도, 방위각 az: 북=0°, 동=90°, 남=180°, 서=270°) */
function sunPosition(month, hour) {
  const n = 15 + 30.42 * (month - 1); // 그 달 중순의 '1년 중 몇 번째 날'
  const decl = 23.45 * Math.sin(2 * Math.PI * (284 + n) / 365); // 태양 적위
  const lat = CLIMATE.latitude;
  const H = 15 * (hour - 12); // 시간각: 1시간 = 15°
  const sinAlt = Math.sin(lat * DEG) * Math.sin(decl * DEG) +
                 Math.cos(lat * DEG) * Math.cos(decl * DEG) * Math.cos(H * DEG);
  const alt = Math.asin(clamp(sinAlt, -1, 1)) / DEG;
  const cosAlt = Math.cos(alt * DEG);
  let az = 180;
  if (cosAlt > 1e-6) {
    const cosAz = (Math.sin(decl * DEG) - sinAlt * Math.sin(lat * DEG)) / (cosAlt * Math.cos(lat * DEG));
    az = Math.acos(clamp(cosAz, -1, 1)) / DEG;
    if (H > 0) az = 360 - az; // 오후에는 서쪽
  }
  return { alt, az };
}

/* 맑은 날 기준 햇빛 세기(W/m²): 태양이 낮을수록 공기층을 길게 지나 약해짐 */
function clearSkyIrradiance(alt) {
  if (alt <= 0) return { dni: 0, dhi: 0 };
  const airMass = 1 / (Math.sin(alt * DEG) + 0.50572 * Math.pow(alt + 6.07995, -1.6364));
  const dni = 1353 * Math.pow(0.7, Math.pow(airMass, 0.678)); // 직달 일사
  const dhi = 0.1 * dni + 10;                                 // 산란 일사
  return { dni, dhi };
}

class Environment {
  constructor() {
    this.month = 5;
    this.weatherMode = 'auto'; // auto | clear | cloudy | rain
    this.weather = 'clear';
    this.windMode = 'auto';    // auto | calm | normal | strong
    this.tempOffset = 0;       // 사용자가 조절하는 기온 보정값
    this.dayOffset = 0;        // 날마다 조금씩 다른 기온
    this.currentDay = -1;
    this.nextWeatherCheck = 0;
    this.T_out = null;
    this.wind = null;
    this.pmMode = 'auto';     // auto | good | bad | verybad
    this.pmDay = 1;           // 날마다 다른 미세먼지 농도
    this.pm = null;
    this.rainRate = 0;        // 강수량(mm/h)
  }

  _randomWeather() {
    if (Math.random() < 0.45) return; // 날씨는 보통 몇 시간 유지됨
    const rainP = CLIMATE.monthlyRainChance[this.month - 1];
    const r = Math.random();
    const stormShare = [7, 8].includes(this.month) ? 0.35 : 0.12; // 여름 장마철엔 폭우가 잦음
    if (r < rainP) this.weather = Math.random() < stormShare ? 'storm' : 'rain';
    else if (r < rainP + 0.33) this.weather = 'cloudy';
    else this.weather = 'clear';
  }

  /* t = 시뮬레이션 시작부터 흐른 시간(시간 단위) */
  update(t) {
    const day = Math.floor(t / 24);
    const hour = t - day * 24;
    this.t = t; this.day = day; this.hour = hour;

    if (day !== this.currentDay) {
      this.currentDay = day;
      this.dayOffset = (Math.random() - 0.5) * 4;
      this.pmDay = 0.6 + Math.random() * 0.9;
    }
    if (this.weatherMode === 'auto') {
      if (t >= this.nextWeatherCheck) { this._randomWeather(); this.nextWeatherCheck = t + 3; }
    } else {
      this.weather = this.weatherMode;
    }
    const wi = WEATHER_INFO[this.weather];

    // ── 태양과 일사량 ──
    const sun = sunPosition(this.month, hour);
    this.sunAlt = sun.alt; this.sunAz = sun.az;
    const cs = clearSkyIrradiance(sun.alt);
    this.DNI = cs.dni * wi.direct;
    this.DHI = cs.dhi * wi.diffuse;
    this.GHI = this.DNI * Math.max(0, Math.sin(sun.alt * DEG)) + this.DHI; // 수평면 일사
    // 건물 남쪽 벽(창문 면)에 닿는 햇빛: 겨울엔 해가 낮아 많이, 여름엔 높아 적게 들어옴
    const cosInc = Math.cos(sun.alt * DEG) * Math.cos((sun.az - 180) * DEG);
    this.I_fac = sun.alt > 0 ? this.DNI * Math.max(0, cosInc) + this.DHI * 0.5 + this.GHI * 0.1 : 0;

    // ── 기온: 오후 3시에 가장 덥고 새벽에 가장 추움 ──
    const mean = CLIMATE.monthlyMeanTemp[this.month - 1];
    const target = mean + wi.amp * Math.cos(2 * Math.PI * (hour - 15) / 24) + wi.adj + this.dayOffset + this.tempOffset;
    this.T_out = this.T_out === null ? target : this.T_out + (target - this.T_out) * 0.35;

    this.storm = this.weather === 'storm';
    this.precip = this.weather === 'rain' || this.storm;
    this.snowing = this.precip && this.T_out <= 1;
    this.raining = this.precip && !this.snowing;

    // ── 강수량(mm/h): 보통 비 3~7, 폭우 25~45 ──
    if (!this.precip) this.rainRate = 0;
    else if (this.storm) this.rainRate = 25 + 20 * (0.5 + 0.5 * Math.sin(t * 2.3));
    else this.rainRate = 3 + 4 * (0.5 + 0.5 * Math.sin(t * 1.7));

    // ── 바람 ──
    let wind;
    if (this.windMode === 'auto') {
      wind = 2.2 + 1.3 * Math.sin(2 * Math.PI * (hour - 9) / 24) +
             (this.storm ? 9 : this.weather === 'rain' ? 3 : this.weather === 'cloudy' ? 1 : 0) +
             ([12, 1, 2, 3].includes(this.month) ? 1.2 : 0);
    } else {
      wind = WIND_LEVELS[this.windMode];
    }
    this.wind = this.wind === null ? wind : this.wind + (wind - this.wind) * 0.6;

    // ── 초미세먼지: 비가 오면 씻겨 내려가고, 바람이 강하면 흩어짐 ──
    let pm;
    if (this.pmMode === 'auto') {
      pm = CLIMATE.monthlyPM[this.month - 1] * this.pmDay *
           (this.precip ? 0.4 : 1) / (1 + this.wind / 10) *
           (1 + 0.2 * Math.sin(2 * Math.PI * (hour - 4) / 24)) * 1.4;
    } else {
      pm = PM_LEVELS[this.pmMode];
    }
    this.pm = this.pm === null ? pm : this.pm + (pm - this.pm) * 0.5;

    this.occ = occupancyAt(hour);
    this.people = Math.round(this.occ * CLIMATE.maxPeople);
    this.CI = carbonIntensityAt(hour);
  }
}
