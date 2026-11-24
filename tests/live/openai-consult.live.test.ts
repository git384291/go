// 실제 AI API 통합 시험(PM 11/24 ④). CI secret CONSULT_AI_API_KEY가 있을 때만 실제 OpenAI를 부른다(없으면 SKIP — 통과로 세지 않음).
// 운영 경로와 같은 코드: consultModelFromEnv(라우트와 같은 전송) → recoveringModelFor → answerChat(가림 → 예약 → 호출 → usage 확정). 비용: 1회 최대 4원 예약.
// 키는 환경변수로만 받고, 결과·기록·콘솔 출력에 나오지 않는지 확인한다. 운영 DB 사용 안 함(메모리 예산).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consultModelFromEnv } from '../../src/server/consult/openAiChatModel';
import { OPENAI_RESPONSES_URL, openAiFetchTransport } from '../../src/server/ai/openAiTransport';
import { recoveringModelFor } from '../../src/server/consult/modelRecovery';
import { answerChat, type AiFailureEvent } from '../../src/server/consult/chatAnswer';
import { createAiBudget, type AiBudget, type ChatModel } from '../../src/server/consult/chatModel';

const KEY = process.env.CONSULT_AI_API_KEY ?? '';
const MODEL = process.env.CONSULT_AI_MODEL_LIVE || 'gpt-5.6-luna';
const skip = KEY ? false : 'CI secret CONSULT_AI_API_KEY 없음 — 실제 호출 시험 미실행(통과 아님)';
if (skip) console.log(`SKIP | ${skip}`);

const NOW = new Date();
const day = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString();
const K = <T,>(value: T) => ({ known: true as const, value });
const rec = {
  supplierId: 'supplier-a', segment: 'household', carrier: 'carrier-x', productId: 'net500-tv-basic', productLabel: '인터넷 500M + TV 기본(가상)', category: 'internet_tv', version: 'v-live-1',
  sourceKind: 'official_policy_sheet', reviewStatus: 'approved', confirmedAt: day(-1), validFrom: day(-1), validUntil: K(day(1)),
  monthlyFee: K({ amountKrw: 11111, vat: 'included' }), contractMonths: K(36), equipmentMonthlyFee: K({ amountKrw: 0, vat: 'included' }), installFee: K({ amountKrw: 2222, vat: 'included' }),
  bundlePrerequisites: K([]), regionScope: K('nationwide'),
  customerBenefit: K({ amountKrw: 3333, form: 'gift_card', payoutCondition: K('개통 후 지급(가상)'), cancellationCondition: K('약정 내 해지 시 환수(가상)') }),
  internal: { commissionKrw: 999999, sourceRef: 'internal://fixture' },
};
function ledger() {
  const ev: string[] = []; const inner = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '100' });
  const budget: AiBudget = { async reserve(c, ctx) { ev.push(`reserve:${c}`); const r = await inner.reserve(c, ctx); if (!r) return null;
    return { async confirm(a) { ev.push(`confirm:${a}`); return r.confirm(a); }, async cancel() { ev.push('cancel'); return r.cancel(); }, async uncertain() { ev.push('uncertain'); return r.uncertain!(); } }; } };
  return { ev, budget };
}
async function run(model: ChatModel | null) {
  const { ev, budget } = ledger(); const log: AiFailureEvent[] = []; const out: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ['log', 'warn', 'error'] as const) console[k] = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  try {
    const r = await answerChat({ provider: () => [rec] as never, supplierId: 'supplier-a', model: recoveringModelFor(model), budget, failureLog: (e) => log.push(e) },
      { message: '제 번호는 010-1234-5678 입니다. 인터넷 요금 안내 부탁드려요.', carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1' }, NOW);
    return { r, ev, log, out };
  } finally { Object.assign(console, orig); }
}
const model = (key: string) => consultModelFromEnv({ CONSULT_AI_MODEL: MODEL, CONSULT_AI_ENDPOINT: OPENAI_RESPONSES_URL, CONSULT_AI_API_KEY: key, CONSULT_AI_EXECUTION: 'allow' }, openAiFetchTransport);

test('LIVE1 실제 호출 성공: 예약 1회 → 모델 답변 → usage 기준 확정(1원 이상·예약 이하), 실패 기록 없음, 키 비노출', { skip, timeout: 30_000 }, async () => {
  const { r, ev, log, out } = await run(model(KEY));
  assert.deepEqual(log, [], `실패 기록: ${JSON.stringify(log)}`);
  assert.ok(r.ok, 'ok'); // 답변이 금액 가드에 걸리면 승인 안내문으로 대체(source fallback)될 수 있다 — 호출 성공 여부는 실패 기록 없음 + 확정으로 본다
  assert.equal(ev.length, 2, JSON.stringify(ev));
  const reserved = Number(ev[0]!.split(':')[1]); const confirmed = Number(ev[1]!.split(':')[1]);
  assert.match(ev[1]!, /^confirm:\d+$/);
  assert.ok(confirmed >= 1 && confirmed <= reserved, `확정 ${confirmed} / 예약 ${reserved}`);
  console.log(`LIVE1 model=${MODEL} reserved=${reserved} confirmed=${confirmed} source=${r.ok ? r.source : '-'}`);
  assert.ok(![JSON.stringify(r), JSON.stringify(log), ...out].some((s) => s.includes(KEY)), '키 노출');
});

test('LIVE2 잘못된 키(401): 재시도 없이 1회 정산, 상담은 안전 안내, 키·오류 원문 비노출', { skip, timeout: 30_000 }, async () => {
  const bad = 'sk-invalid-' + 'C'.repeat(40);
  const { r, ev, log, out } = await run(model(bad));
  assert.ok(r.ok && r.source === 'fallback');
  assert.equal(ev.filter((e) => e.startsWith('reserve')).length, 1);
  assert.equal(ev.filter((e) => /^(confirm|cancel|uncertain)/.test(e)).length, 1, JSON.stringify(ev));
  assert.equal(log.length, 1);
  assert.equal(log[0]!.sent, 1, '4xx는 재시도하지 않음');
  assert.equal(log[0]!.status, 401);
  assert.ok(![JSON.stringify(r), JSON.stringify(log), ...out].some((s) => s.includes(bad) || s.includes(KEY)));
});
