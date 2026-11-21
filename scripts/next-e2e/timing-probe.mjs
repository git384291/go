// PM 11/22 P2 진단(범위 한정): 실제 /api/leads HTTP 요청→응답 시간이 새 접수·같은 내용 재접수·변경 재접수에서 구별되는지 측정한다.
// - 기존 Next E2E 시험 전용 앱(next dev, 고지 확정 fixture)·폐기 DB·가짜 봇 확인 서버(로컬)를 그대로 쓴다. 운영 코드 우회 경로 없음.
// - 레이트리밋(IP당 시간 10건)은 그대로 두고, 요청마다 다른 시험 IP(198.18.0.0/15, 벤치마크 대역)를 쓴다(기존 E2E 격리 방식과 같음).
// - 시간 값은 합격 조건이 아니다. 합격 조건은 '진단이 실행됐고 각 요청의 실제 처리 결과가 의도와 같다'뿐이다.
import fs from 'node:fs';
import path from 'node:path';

const rng = (seed) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const q = (v, p) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const r2 = (x) => Math.round(x * 100) / 100;

/** 보정 표본으로 기준(방향 포함)을 정하고, 평가 표본에서 균형 정확도·오분류를 센다 */
export function thresholdEval(calA, calB, evA, evB) {
  let best = { ba: -1, t: 0, aAbove: true };
  for (const t of [...calA, ...calB]) for (const aAbove of [true, false]) {
    const tpr = calA.filter((v) => (aAbove ? v > t : v <= t)).length / calA.length;
    const tnr = calB.filter((v) => (aAbove ? v <= t : v > t)).length / calB.length;
    if ((tpr + tnr) / 2 > best.ba) best = { ba: (tpr + tnr) / 2, t, aAbove };
  }
  const missA = evA.filter((v) => !(best.aAbove ? v > best.t : v <= best.t)).length;
  const missB = evB.filter((v) => !(best.aAbove ? v <= best.t : v > best.t)).length;
  const ba = ((evA.length - missA) / evA.length + (evB.length - missB) / evB.length) / 2;
  const acc = (evA.length + evB.length - missA - missB) / (evA.length + evB.length);
  const majority = Math.max(evA.length, evB.length) / (evA.length + evB.length);
  return { thresholdMs: r2(best.t), aSlowerThanT: best.aAbove, calibrationBalancedAcc: r2(best.ba), evalBalancedAcc: r2(ba), evalAccuracy: r2(acc), majorityBaseline: r2(majority), evalMisclassified: missA + missB, evalN: evA.length + evB.length };
}

export async function runTimingProbe({ FX, sql, sampleBody, outDir, perCategory = 100, warmup = 20, basePhones = 40, phoneBase = 1000, ipPrefix = '198.18', fileName = 'timing-probe.json', environment = 'Next E2E 시험 전용 앱(next dev 개발 모드, 127.0.0.1), 폐기 PostgreSQL, 가짜 봇 확인 서버(로컬 HTTP), 고지 확정 fixture. 인터넷·운영 환경 아님' }) {
  const tpl = JSON.parse(sampleBody);
  const rand = rng(20261122);
  let ipN = 0; let keyN = 0;
  const ip = () => { ipN++; return `${ipPrefix}.${Math.floor(ipN / 250)}.${(ipN % 250) + 1}`; };
  const key = (c) => `tp-${c}-${String(++keyN).padStart(6, '0')}-${Math.floor(rand() * 1e9).toString(16)}`.slice(0, 64);
  const phone = (i) => `010-7${String(Math.floor(i / 10000)).padStart(3, '0')}-${String(i % 10000).padStart(4, '0')}`;
  const app = (addr) => ({ ...tpl.application, installAddress: addr });
  const send = async (body) => {
    const t0 = performance.now();
    const r = await fetch(`${FX}/api/leads`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify(body) });
    const text = await r.text();
    return { ms: performance.now() - t0, status: r.status, text };
  };
  const state = async () => (await sql.unsafe(`select (select count(*) from core.leads)::int as l, (select count(*) from pii.lead_amendments)::int as a, (select count(*) from core.lead_status_history where reason = 'repeat_inquiry')::int as r`))[0];
  const expect = { new: [1, 0, 0], same: [0, 0, 1], amend: [0, 1, 1] }; // 리드·변경 요청·재문의 증가
  const bad = [];
  let pIdx = phoneBase;
  // 예열(버림) + 기준 연락처(원본) 생성: 결과 확인만, 시간은 버림
  for (let i = 0; i < warmup; i++) await send({ ...tpl, phone: phone(pIdx++), idempotencyKey: key('w'), turnstileToken: 'ok', application: app(`서울시 가상구 예열로 ${i}`) });
  const bases = [];
  for (let i = 0; i < basePhones; i++) {
    const b = { phone: phone(pIdx++), addr: `서울시 가상구 원본로 ${i + 1}` };
    const s0 = await state(); const r = await send({ ...tpl, phone: b.phone, idempotencyKey: key('b'), turnstileToken: 'ok', application: app(b.addr) }); const s1 = await state();
    if (r.status !== 202 || s1.l - s0.l !== 1) bad.push(['base', i, r.status]);
    bases.push(b);
  }
  // 측정: 범주별 perCategory회, 무작위 순서
  const plan = [];
  for (const c of ['new', 'same', 'amend']) for (let i = 0; i < perCategory; i++) plan.push(c);
  for (let i = plan.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [plan[i], plan[j]] = [plan[j], plan[i]]; }
  const rows = []; const seen = { new: 0, same: 0, amend: 0 };
  for (const c of plan) {
    const k = seen[c]++;
    const b = bases[k % bases.length];
    const body = c === 'new' ? { ...tpl, phone: phone(pIdx++), application: app(`서울시 가상구 신규로 ${k + 1}`) }
      : c === 'same' ? { ...tpl, phone: b.phone, application: app(b.addr) } // 원본 내용을 아는 경우(제3자 불가)
      : { ...tpl, phone: b.phone, application: app(`서울시 가상구 임의로 ${k + 1}`) }; // 원본을 모르는 제3자도 보낼 수 있는 입력
    const s0 = await state();
    const r = await send({ ...body, idempotencyKey: key(c[0]), turnstileToken: 'ok' });
    const s1 = await state();
    const d = [s1.l - s0.l, s1.a - s0.a, s1.r - s0.r];
    if (r.status !== 202 || r.text !== '{"ok":true}' || d.join() !== expect[c].join()) bad.push([c, k, r.status, d.join()]);
    rows.push({ c, k, ms: r.ms, initialExists: c !== 'new', delta: d.join() });
  }
  const by = (c) => rows.filter((x) => x.c === c).map((x) => x.ms);
  // 보정/평가 분리: 범주마다 측정 순서상 짝수 번째 = 보정, 홀수 번째 = 평가
  const split = (v) => [v.filter((_, i) => i % 2 === 0), v.filter((_, i) => i % 2 === 1)];
  const [cN, eN] = split(by('new')); const [cS, eS] = split(by('same')); const [cA, eA] = split(by('amend'));
  const stats = Object.fromEntries(['new', 'same', 'amend'].map((c) => { const v = by(c); return [c, { n: v.length, medianMs: r2(q(v, 0.5)), p10Ms: r2(q(v, 0.1)), p90Ms: r2(q(v, 0.9)) }]; }));
  const result = {
    environment,
    perCategory, warmup, basePhones, failures: bad.length, failureSample: bad.slice(0, 5),
    stats,
    // 제3자가 원본 내용을 모른 채 보낼 수 있는 입력: 새 번호 vs 기존 번호(내용 임의 → 변경 요청 경로)
    thirdParty_newVsAmend: thresholdEval(cN, cA, eN, eA),
    // 원본 내용을 알아야 가능한 비교(별도 표시)
    needsOriginal_newVsSame: thresholdEval(cN, cS, eN, eS),
    newVsExisting_all: thresholdEval(cN, [...cS, ...cA], eN, [...eS, ...eA]),
  };
  fs.writeFileSync(path.join(outDir, fileName), JSON.stringify({ ...result, rows }, null, 1));
  return result;
}
