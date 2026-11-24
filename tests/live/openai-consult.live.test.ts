// 실제 AI API 통합 시험(PM 11/24 ④). CI secret CONSULT_AI_API_KEY가 있을 때만 실제 OpenAI를 부른다(없으면 SKIP — 통과로 세지 않음).
// 운영 경로와 같은 코드: consultModelFromEnv(라우트와 같은 전송) → recoveringModelFor → answerChat(가림 → 예약 → 호출 → usage 확정). 비용: 1회 최대 4원 예약.
// 키는 환경변수로만 받고, 결과·기록·콘솔 출력에 나오지 않는지 확인한다. 운영 DB 사용 안 함(메모리 예산).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consultModelFromEnv, createOpenAiChatModel, CONSULT_CALL_LIMITS, CONSULT_RECOVERY_TIMING, parseUsage } from '../../src/server/consult/openAiChatModel';
import type { BodyTransport } from '../../src/server/advertising/boundedHttp';
import { verifiedKrwPrices } from '../../src/server/ai/verifiedPrices';
import { grantBudgetPermit } from '../../src/server/consult/chatModel';
import { OPENAI_RESPONSES_URL, openAiFetchTransport } from '../../src/server/ai/openAiTransport';
import { recoveringModelFor, withRecovery } from '../../src/server/consult/modelRecovery';
import { answerChat, type AiFailureEvent } from '../../src/server/consult/chatAnswer';
import { createAiBudget, type AiBudget, type ChatModel } from '../../src/server/consult/chatModel';

const KEY = process.env.CONSULT_AI_API_KEY ?? '';
const MODEL = process.env.CONSULT_AI_MODEL_LIVE || 'gpt-5.6-luna';
const skip = KEY ? false : 'CI secret CONSULT_AI_API_KEY 없음 — 실제 호출 시험 미실행(통과 아님)';
if (skip) console.log(`SKIP | ${skip}`);
// 진단(LIVE0·LIVE0b)은 일반 CI에서 돌리지 않는다(PM 11/24 보완: 불필요한 실제 과금·외부 변동 방지). 수동: npm run test:live-ai-diag
const diagSkip = skip || (process.env.CONSULT_AI_LIVE_DIAG === '1' ? false : '진단 시험은 수동 실행 전용(CONSULT_AI_LIVE_DIAG=1)');

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
    return { async confirm(a) { ev.push(`confirm:${a}`); return r.confirm(a); }, async cancel() { ev.push('cancel'); return r.cancel(); }, async uncertain(a?: number) { ev.push(a === undefined ? 'uncertain' : `uncertain:${a}`); return r.uncertain!(a); } }; } };
  return { ev, budget };
}
async function run(model: ChatModel | null, wrap: (m: ChatModel | null) => ChatModel | null = (m) => recoveringModelFor(m, CONSULT_RECOVERY_TIMING)) {
  const { ev, budget } = ledger(); const log: AiFailureEvent[] = []; const out: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ['log', 'warn', 'error'] as const) console[k] = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  try {
    const r = await answerChat({ provider: () => [rec] as never, supplierId: 'supplier-a', model: wrap(model), budget, failureLog: (e) => log.push(e) },
      { message: '제 번호는 010-1234-5678 입니다. 인터넷 요금 안내 부탁드려요.', carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1' }, NOW);
    return { r, ev, log, out };
  } finally { Object.assign(console, orig); }
}
const model = (key: string) => consultModelFromEnv({ CONSULT_AI_MODEL: MODEL, CONSULT_AI_ENDPOINT: OPENAI_RESPONSES_URL, CONSULT_AI_API_KEY: key, CONSULT_AI_EXECUTION: 'allow' }, openAiFetchTransport);
// 사용 토큰 기록용(시험 전용): 실제 전송 응답을 그대로 넘기면서 usage만 읽는다(본문·키 미기록)
const usages: ReturnType<typeof parseUsage>[] = [];
const tapped: BodyTransport = async (url, init) => {
  const r = await openAiFetchTransport(url, init);
  const text = await new Response(r.body).text(); usages.push(parseUsage(text));
  return { status: r.status, body: new Response(text).body };
};
const tappedModel = (key: string) => consultModelFromEnv({ CONSULT_AI_MODEL: MODEL, CONSULT_AI_ENDPOINT: OPENAI_RESPONSES_URL, CONSULT_AI_API_KEY: key, CONSULT_AI_EXECUTION: 'allow' }, tapped);

// 진단(통과·실패 판정 없음, 키 노출만 실패): 운영 한도(1회 3.5초·출력 200토큰)와 별개로 실제 응답 시간·결과·사용량을 잰다. 1회 호출
test('LIVE0 진단: 실제 응답 시간·결과(시간 15초·출력 200/512토큰)', { skip: diagSkip, timeout: 60_000 }, async () => {
  for (const maxOutputTokens of [200, 512]) {
    const m = createOpenAiChatModel({ transport: openAiFetchTransport, endpoint: OPENAI_RESPONSES_URL, apiKey: KEY, model: MODEL, executionAllowed: true, costPerCallKrw: 10, prices: verifiedKrwPrices(), ...CONSULT_CALL_LIMITS, maxOutputTokens, timeoutMs: 15_000, maxResponseBytes: 32_768 });
    const meter = { sent: 0 } as { sent: number; usageKrw?: number }; grantBudgetPermit(meter);
    const t0 = Date.now(); let outcome = 'ok'; let len = 0;
    try { len = (await m.generate({ system: '통신 상품 상담원입니다. 한국어로 두 문장 이내로 답하세요.', user: '인터넷 요금 안내 부탁드려요.', approved: '월 11,111원(가상)' }, AbortSignal.timeout(15_000), meter)).length; }
    catch (e) { outcome = `${(e as { kind?: string }).kind ?? 'error'}:${e instanceof Error ? e.message.slice(0, 40) : 'x'}`; }
    const line = `LIVE0 out=${maxOutputTokens} ms=${Date.now() - t0} outcome=${outcome} replyChars=${len} sent=${meter.sent} usageKrw=${meter.usageKrw ?? '-'}`;
    assert.ok(!line.includes(KEY)); console.log(line);
  }
});

// 진단: 상담 경로(실제 프롬프트) 그대로 1회, 모델 오류는 코드만 기록(본문·키 미기록). 판정 없음
test('LIVE0b 진단: 상담 경로 실제 프롬프트 오류 코드', { skip: diagSkip, timeout: 30_000 }, async () => {
  const inner = model(KEY)!; const codes: string[] = []; const t0 = Date.now();
  const spy = { ...inner, async generate(...a: Parameters<typeof inner.generate>) { try { const r = await inner.generate(...a); codes.push(`ok:${r.length}chars`); return r; } catch (e) { codes.push(`${(e as { kind?: string }).kind ?? 'error'}:${e instanceof Error ? e.message.slice(0, 40) : 'x'}`); throw e; } } };
  const { ev } = await run(spy);
  const line = `LIVE0b ms=${Date.now() - t0} codes=${codes.join(',')} ev=${ev.join(',')}`;
  assert.ok(!line.includes(KEY)); console.log(line);
});

test('LIVE1 실제 호출 성공: 예약 1회 → 모델 답변 → usage 기준 확정(1원 이상·예약 이하), 실패 기록 없음, 키 비노출', { skip, timeout: 30_000 }, async () => {
  usages.length = 0;
  const { r, ev, log, out } = await run(tappedModel(KEY));
  assert.deepEqual(log, [], `실패 기록: ${JSON.stringify(log)}`);
  assert.ok(r.ok, 'ok'); // 답변이 금액 가드에 걸리면 승인 안내문으로 대체(source fallback)될 수 있다 — 호출 성공 여부는 실패 기록 없음 + 확정으로 본다
  assert.equal(ev.length, 2, JSON.stringify(ev));
  const reserved = Number(ev[0]!.split(':')[1]); const confirmed = Number(ev[1]!.split(':')[1]);
  assert.match(ev[1]!, /^confirm:\d+$/);
  assert.ok(confirmed >= 1 && confirmed <= reserved, `확정 ${confirmed} / 예약 ${reserved}`);
  const u = usages.at(-1);
  console.log(`LIVE1 model=${MODEL} sends=${usages.length} inputTokens=${u?.inputTokens ?? '-'} cachedTokens=${u?.cachedInputTokens ?? '-'} outputTokens=${u?.outputTokens ?? '-'} reserved=${reserved} confirmed=${confirmed} source=${r.ok ? r.source : '-'}`);
  assert.equal(usages.length, 1, '재시도 없이 1회');
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

test('LIVE3 실제 시간 초과(1회 300ms로 강제): 재시도 없이 1회 전송, 불확실 정산 = 보낸 1회분 3원(예약 6원 전액 아님), 키 비노출', { skip, timeout: 30_000 }, async () => {
  const { r, ev, log, out } = await run(model(KEY), (m) => withRecovery(m!, { attemptMs: 300, totalMs: 300, log: () => {} })); // 라우트와 같은 비율(1회 = 전체), 시간만 짧게
  assert.ok(r.ok && r.source === 'fallback');
  assert.deepEqual(ev, ['reserve:6', 'uncertain:3'], JSON.stringify(ev));
  assert.deepEqual(log.map((e) => [e.code, e.sent, e.settle]), [['TIMEOUT', 1, 'uncertain']]);
  console.log(`LIVE3 ev=${ev.join(',')}`);
  assert.ok(![JSON.stringify(r), JSON.stringify(log), ...out].some((x) => x.includes(KEY)));
});
