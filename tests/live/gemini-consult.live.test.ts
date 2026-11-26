// Gemini 무료 등급 실제 호출 시험(PM 11/26 승인). 키가 없으면 SKIP(통과로 세지 않음). 가상 정책·가짜 상담 문구만 쓴다(개인정보 없음).
// 키: 환경변수 GEMINI_API_KEY_DEV, 없으면 파일(기본 ~/.fideon-gemini/key, GEMINI_KEY_FILE로 변경). 키·본문은 출력하지 않는다.
// 무료 호출도 1회=1원 요청 단위 메모리 한도(100)로 센다. 전체 시험의 실제 호출은 최대 약 6회. 운영 DB 사용 안 함.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { geminiFreeModelFromEnv } from '../../src/server/consult/geminiChatModel';
import { geminiFetchTransport } from '../../src/server/ai/geminiTransport';
import { CONSULT_RECOVERY_TIMING } from '../../src/server/consult/openAiChatModel';
import { recoveringModelFor, withRecovery } from '../../src/server/consult/modelRecovery';
import { answerChat, type AiFailureEvent } from '../../src/server/consult/chatAnswer';
import { createAiBudget, type AiBudget, type ChatModel } from '../../src/server/consult/chatModel';

function readKey(): string {
  const e = process.env.GEMINI_API_KEY_DEV; if (e) return e.trim(); // 전용 변수만(CONSULT_AI_API_KEY는 OpenAI 키일 수 있어 구글로 보내지 않는다)
  try { return readFileSync(process.env.GEMINI_KEY_FILE || path.join(homedir(), '.fideon-gemini', 'key'), 'utf8').trim(); } catch { return ''; }
}
const KEY = readKey();
const MODEL = process.env.GEMINI_MODEL_LIVE || 'gemini-3.5-flash-lite'; // 공식 모델 목록(11/26 조회)의 안정판 Flash-Lite. 다르면 GEMINI_MODEL_LIVE로 바꾼다
const skip = KEY ? false : '키 없음 — Gemini 실제 호출 시험 미실행(통과 아님)';
if (skip) console.log(`SKIP | ${skip}`);

const NOW = new Date();
const day = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString();
const K = <T,>(value: T) => ({ known: true as const, value });
const policy = (fee: number, version: string, confirmedDays: number) => ({
  supplierId: 'supplier-a', segment: 'household', carrier: 'carrier-x', productId: 'net500-tv-basic', productLabel: '인터넷 500M + TV 기본(가상)', category: 'internet_tv', version,
  sourceKind: 'official_policy_sheet', reviewStatus: 'approved', confirmedAt: day(confirmedDays), validFrom: day(confirmedDays), validUntil: K(day(1)),
  monthlyFee: K({ amountKrw: fee, vat: 'included' }), contractMonths: K(36), equipmentMonthlyFee: K({ amountKrw: 0, vat: 'included' }), installFee: K({ amountKrw: 2222, vat: 'included' }),
  bundlePrerequisites: K([]), regionScope: K('nationwide'),
  customerBenefit: K({ amountKrw: 3333, form: 'gift_card', payoutCondition: K('개통 후 지급(가상)'), cancellationCondition: K('약정 내 해지 시 환수(가상)') }),
  internal: { commissionKrw: 999999, sourceRef: 'internal://fixture' },
});
function ledger() {
  const ev: string[] = []; const inner = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '100' });
  const budget: AiBudget = { async reserve(c, ctx) { ev.push(`reserve:${c}`); const r = await inner.reserve(c, ctx); if (!r) return null;
    return { async confirm(a) { ev.push(`confirm:${a}`); return r.confirm(a); }, async cancel() { ev.push('cancel'); return r.cancel(); }, async uncertain(a?: number) { ev.push(a === undefined ? 'uncertain' : `uncertain:${a}`); return r.uncertain!(a); } }; } };
  return { ev, budget };
}
async function run(model: ChatModel | null, rec: unknown, wrap: (m: ChatModel | null) => ChatModel | null = (m) => recoveringModelFor(m, CONSULT_RECOVERY_TIMING)) {
  const { ev, budget } = ledger(); const log: AiFailureEvent[] = []; const out: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ['log', 'warn', 'error'] as const) console[k] = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  try {
    const r = await answerChat({ provider: () => [rec] as never, supplierId: 'supplier-a', model: wrap(model), budget, failureLog: (e) => log.push(e) },
      { message: '인터넷이랑 TV 결합 요금 안내 부탁드려요.', carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1' }, NOW);
    return { r, ev, log, out };
  } finally { Object.assign(console, orig); }
}
const env = (key: string) => ({ CONSULT_AI_PROVIDER: 'gemini-free', CONSULT_AI_MODEL: MODEL, CONSULT_AI_API_KEY: key, CONSULT_AI_EXECUTION: 'allow', APP_ENV: 'dev' });
const model = (key: string) => geminiFreeModelFromEnv(env(key), geminiFetchTransport);
const leaks = (key: string, ...xs: unknown[]) => xs.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).some((s) => s.includes(key));

test('GLIVE1 실제 호출 성공: 예약 1회 → 모델 답변 → 확정(1원 단위), 실패 기록 없음, 키 비노출', { skip, timeout: 30_000 }, async () => {
  const { r, ev, log, out } = await run(model(KEY), policy(11111, 'v-live-1', -1));
  assert.deepEqual(log, [], `실패 기록: ${JSON.stringify(log)}`);
  assert.ok(r.ok);
  assert.deepEqual(ev, ['reserve:1', 'confirm:1'], JSON.stringify(ev));
  console.log(`GLIVE1 model=${MODEL} source=${r.ok ? r.source : '-'} ev=${ev.join(',')}`);
  assert.ok(!leaks(KEY, r, log, out), '키 노출');
});

test('GLIVE2 최신 정책 반영: 게시된 정책을 v1(11,111원)→v2(22,222원)로 바꾸면 답변도 최신 금액만 안내(이전 금액 없음)', { skip, timeout: 60_000 }, async () => {
  const a = await run(model(KEY), policy(11111, 'v-live-1', -2));
  const b = await run(model(KEY), policy(22222, 'v-live-2', -1));
  const ta = JSON.stringify(a.r); const tb = JSON.stringify(b.r);
  console.log(`GLIVE2 v1_has11,111=${ta.includes('11,111')} v1_has22,222=${ta.includes('22,222')} v2_has22,222=${tb.includes('22,222')} v2_has11,111=${tb.includes('11,111')} src1=${a.r.ok ? a.r.source : '-'} src2=${b.r.ok ? b.r.source : '-'} fail1=${a.log.length} fail2=${b.log.length}`);
  assert.ok(ta.includes('11,111') && !ta.includes('22,222'), 'v1 답변');
  assert.ok(tb.includes('22,222') && !tb.includes('11,111'), 'v2 답변은 최신 금액만');
  assert.ok(!leaks(KEY, a.r, b.r, a.log, b.log, a.out, b.out), '키 노출');
});

test('GLIVE3 잘못된 키: 재시도 없이 1회 정산, 상담은 안전 안내, 키·오류 원문 비노출', { skip, timeout: 30_000 }, async () => {
  const bad = 'AIza_invalid_' + 'C'.repeat(30);
  const { r, ev, log, out } = await run(model(bad), policy(11111, 'v-live-1', -1));
  assert.ok(r.ok && r.source === 'fallback');
  assert.equal(ev.filter((e) => e.startsWith('reserve')).length, 1);
  assert.equal(ev.filter((e) => /^(confirm|cancel|uncertain)/.test(e)).length, 1, JSON.stringify(ev));
  assert.equal(log.length, 1);
  assert.equal(log[0]!.sent, 1, '4xx는 재시도하지 않음');
  console.log(`GLIVE3 status=${log[0]!.status} code=${log[0]!.code} ev=${ev.join(',')}`);
  assert.ok(!leaks(bad, r, log, out) && !leaks(KEY, r, log, out));
});

test('GLIVE4 실제 시간 초과(1회 300ms로 강제): 재시도 없이 1회 전송, 불확실 정산, 안전 안내, 키 비노출', { skip, timeout: 30_000 }, async () => {
  const { r, ev, log, out } = await run(model(KEY), policy(11111, 'v-live-1', -1), (m) => withRecovery(m!, { attemptMs: 300, totalMs: 300, log: () => {} }));
  assert.ok(r.ok && r.source === 'fallback');
  console.log(`GLIVE4 ev=${ev.join(',')} log=${JSON.stringify(log.map((e) => [e.code, e.sent, e.settle]))}`);
  assert.equal(ev.filter((e) => e.startsWith('reserve')).length, 1);
  assert.equal(ev.filter((e) => /^uncertain/.test(e)).length, 1, JSON.stringify(ev));
  assert.deepEqual(log.map((e) => [e.code, e.sent, e.settle]), [['TIMEOUT', 1, 'uncertain']]);
  assert.ok(!leaks(KEY, r, log, out));
});
