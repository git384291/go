// P0 AI 사용량·비용 하드 한도 Mock 검증 (TEST-01~14). 가짜 transport만 사용 — 실제 AI API 호출 0회, 운영 DB·고객정보 미사용.
// - 기존 구현(answerChat·createAiBudget·createOpenAiChatModel·createOpenAiAdGenerator)만 재사용한다. 새 기능을 만들지 않는다.
// - 기존 구현에 없는 한도는 { todo: 'GAP …' }로 둔다: 실행은 하되 실패해도 CI를 막지 않고, TAP에 "not ok … # TODO"로 남는다(= FAIL로 보고).
// - 메모리 예산(createAiBudget)은 단일 프로세스 참고용이다. 원자성·다중 인스턴스 검증은 scripts/ai-cost-db-concurrency.sh(로컬 가상 DB)에서 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { answerChat } from '../../src/server/consult/chatAnswer';
import { createAiBudget, type AiBudget, type Reservation } from '../../src/server/consult/chatModel';
import { createOpenAiChatModel, type OpenAiChatModelConfig } from '../../src/server/consult/openAiChatModel';
import { withRecovery, RECOVERY_LIMITS } from '../../src/server/consult/modelRecovery';
import { createInflightGuard } from '../../src/server/consult/chatHandler';
import { createOpenAiAdGenerator } from '../../src/server/advertising/openAiAdGenerator';
import type { BodyTransport } from '../../src/server/advertising/boundedHttp';

const NOW = new Date('2026-11-23T12:00:00+09:00');
const KEY = 'sk-test-' + 'A'.repeat(30); // 가짜 키(실제 아님)
const EP = 'https://model.example.test/v1/responses'; // 가짜 주소
const K = <T,>(value: T) => ({ known: true as const, value });
const rec = {
  supplierId: 'supplier-a', segment: 'household', carrier: 'carrier-x', productId: 'net500-tv-basic',
  productLabel: '인터넷 500M + TV 기본(가상)', category: 'internet_tv', version: 'v-fixture-1',
  sourceKind: 'official_policy_sheet', reviewStatus: 'approved',
  confirmedAt: '2026-11-23T09:00:00+09:00', validFrom: '2026-11-23T00:00:00+09:00', validUntil: K('2026-11-24T00:00:00+09:00'),
  monthlyFee: K({ amountKrw: 11111, vat: 'included' }), contractMonths: K(36),
  equipmentMonthlyFee: K({ amountKrw: 0, vat: 'included' }), installFee: K({ amountKrw: 2222, vat: 'included' }),
  bundlePrerequisites: K([]), regionScope: K('nationwide'),
  customerBenefit: K({ amountKrw: 3333, form: 'gift_card', payoutCondition: K('개통 후 지급(가상)'), cancellationCondition: K('약정 내 해지 시 환수(가상)') }),
  internal: { commissionKrw: 999999, sourceRef: 'internal://fixture' },
};
const input = (message = '요금이 얼마예요?') => ({ message, carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1' });
const okBody = (text = '안녕하세요. 승인된 안내입니다.', extra: Record<string, unknown> = {}) =>
  JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], ...extra });

/** Mock Provider: 호출 횟수를 센다. mode로 정상·오류·무응답을 흉내 낸다 */
function mockProvider(mode: { status?: number; text?: string; hang?: boolean } = {}) {
  const calls: string[] = [];
  const t: BodyTransport = async (_url, init) => {
    calls.push(new TextDecoder().decode(init.body));
    if (mode.hang) return new Promise(() => undefined); // 응답 없음
    return { status: mode.status ?? 200, body: new Response(mode.text ?? okBody()).body };
  };
  return { t, calls };
}
const cfg = (t: BodyTransport | null, over: Partial<OpenAiChatModelConfig> = {}): OpenAiChatModelConfig => ({
  transport: t, endpoint: EP, apiKey: KEY, model: 'test-model', executionAllowed: true,
  costPerCallKrw: 10, maxOutputTokens: 200, timeoutMs: 1000, maxResponseBytes: 8192, ...over,
});
/** 예약·확정·취소를 기록하는 예산 감시 래퍼 */
function spyBudget(inner: AiBudget) {
  const log: string[] = [];
  const b: AiBudget = {
    async reserve(cost) {
      const r = await inner.reserve(cost);
      log.push(`reserve(${cost})=${r ? 'ok' : 'denied'}`);
      if (!r) return null;
      const w: Reservation = {
        async confirm(a) { log.push(`confirm(${a})`); return r.confirm(a); },
        async cancel() { log.push('cancel'); return r.cancel(); },
      };
      return w;
    },
  };
  return { b, log };
}
const deps = (over: Record<string, unknown>) => ({ provider: () => [rec], supplierId: 'supplier-a', ...over }) as never;

const SRC = path.resolve(__dirname, '../../src');
const MIG = path.resolve(__dirname, '../../db/migrations');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = path.join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const srcFiles = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f));
const grepSrc = (re: RegExp) => srcFiles.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f));
const sql = readdirSync(MIG).filter((f) => f.endsWith('.sql')).map((f) => readFileSync(path.join(MIG, f), 'utf8')).join('\n');

// ───────── 하드 한도 10종 중 기존 구현이 있는 것 ─────────
test('L02 요청당 최대 출력 토큰: 설정 상한(512) 초과·미달은 전송 0회, 본문에 max_output_tokens 강제', async () => {
  for (const maxOutputTokens of [0, 15, 513, 100000, Number.NaN, 1.5]) {
    const p = mockProvider();
    const r = await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t, { maxOutputTokens })), budget: createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' }) }), input(), NOW);
    assert.equal(p.calls.length, 0, `maxOutputTokens=${maxOutputTokens}`);
    assert.ok(r.ok && r.source === 'fallback');
  }
  const p = mockProvider();
  await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t)), budget: createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' }) }), input(), NOW);
  assert.equal(p.calls.length, 1);
  assert.equal(JSON.parse(p.calls[0]!).max_output_tokens, 200);
});
test('L01 요청당 입력 한도: 300자 초과 입력은 전송 0회(※ 토큰이 아니라 글자 수 기준)', async () => {
  const p = mockProvider();
  const r = await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t)), budget: createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' }) }), input('가'.repeat(301)), NOW);
  assert.equal(r.ok, false);
  assert.equal(p.calls.length, 0);
});
test('L03 요청당 예상 최대 비용: costPerCallKrw가 1~1000 정수가 아니면 전송 0회', async () => {
  for (const costPerCallKrw of [0, -1, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const p = mockProvider();
    await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t, { costPerCallKrw })), budget: createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '100000' }) }), input(), NOW);
    assert.equal(p.calls.length, 0, `cost=${costPerCallKrw}`);
  }
});
test('L09 AI 호출 횟수 한도: 상담 채팅 공용 횟수 제한(0024, DB 원자 증가)이 존재 — 요청 횟수 기준이며 분 단위 창만 있음', () => {
  assert.match(sql, /api\.consult_rate_hit/);
  assert.match(sql, /chat/);
});
test('L04~L07 사용자별·일일 한도: 예약 원장에 사용자/세션/일 단위 구분이 있어야 한다', { todo: 'GAP: core.ai_usage_ledger는 month(월)·cost만 가진다. 사용자·세션·일 단위 한도 없음(서비스 전체 월 한도 1개뿐)' }, () => {
  const m = /create table core\.ai_usage_ledger \(([\s\S]*?)\);/.exec(sql);
  assert.ok(m, 'ledger 정의를 찾지 못함');
  assert.match(m![1]!, /user|session|actor/i, '사용자/세션 구분 없음');
  assert.match(sql, /ai_budget_config[\s\S]{0,400}daily_limit/i, '일일 한도 설정 없음');
});
test('L08 동시 요청 한도: 진행 중 AI 호출 수를 세는 장치가 있어야 한다', { todo: 'GAP: 동시 진행 호출 상한(in-flight 카운터·세마포어) 없음' }, () => {
  assert.ok(grepSrc(/in.?flight|semaphore|maxConcurrent|concurrency/i).some((f) => f.startsWith('server/consult') || f.startsWith('server/advertising')));
});
test('L10 관리자 긴급 차단 스위치: 전용 스위치가 있어야 한다', { todo: 'GAP: 전용 긴급 차단 스위치 없음(월 한도 0원이 사실상 차단 수단)' }, () => {
  assert.ok(/kill.?switch|emergency|ai_disabled|ai_enabled|ai_paused/i.test(sql) || grepSrc(/kill.?switch|emergency|aiDisabled|aiPaused/i).length > 0);
});

// ───────── TEST-01~14 ─────────
test('TEST-01 정상 호출: 예약(10) → 전송 1회 → 확정(10) → 잔액 정확(예약 잔여 없음)', async () => {
  const p = mockProvider();
  const s = spyBudget(createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' }));
  const r = await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t)), budget: s.b }), input(), NOW);
  assert.ok(r.ok && r.source === 'model');
  assert.equal(p.calls.length, 1);
  assert.deepEqual(s.log, ['reserve(10)=ok', 'confirm(10)']);
  // 사용액이 정확히 10원인지: 990 예약은 되고 991은 거부
  assert.ok(await s.b.reserve(990));
  assert.equal(await s.b.reserve(1), null);
});

test('TEST-02 일일 한도 1,000원·확정 990원·예상 20원 → 차단, Provider 0회', { todo: 'GAP: 일일 한도 없음 — 월 한도만 있어 일일 초과를 막지 못한다' }, async () => {
  const p = mockProvider();
  const env = { CONSULT_AI_MONTHLY_BUDGET_KRW: '1000000' }; // 월 한도는 넉넉, "일일 1,000원" 설정 자리가 없다
  const b = createAiBudget(env);
  const pre = await b.reserve(990); await pre!.confirm(990);
  const r = await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t, { costPerCallKrw: 20 })), budget: b }), input(), NOW);
  assert.ok(r.ok && r.source === 'fallback', '일일 한도를 넘었는데 모델이 호출됨');
  assert.equal(p.calls.length, 0);
});

test('TEST-03 월 한도 10,000원·사용 9,995원·예상 10원 → 차단, Provider 0회, 확정·취소 기록 없음', async () => {
  const p = mockProvider();
  const s = spyBudget(createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '10000' }));
  assert.ok(await s.b.reserve(9995));
  s.log.length = 0;
  const r = await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t, { costPerCallKrw: 10 })), budget: s.b }), input(), NOW);
  assert.ok(r.ok && r.source === 'fallback');
  assert.equal(p.calls.length, 0);
  assert.deepEqual(s.log, ['reserve(10)=denied']);
});

test('TEST-04a (메모리·참고용, 완료 판정에 불포함) 남은 100원·A 80·B 80 동시 → 최대 1건', async () => {
  const b = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '100' });
  const [a, c] = await Promise.all([b.reserve(80), b.reserve(80)]);
  assert.equal([a, c].filter(Boolean).length, 1);
  // 자바스크립트는 단일 스레드라 이 통과는 원자성 증거가 아니다. 다중 세션 검증은 scripts/ai-cost-db-concurrency.sh.
});

test('TEST-05 Provider 무응답: 전송 1회(중복 호출 없음), 예약은 환불하지 않고 전액 확정(보수적), 안전 안내문', async () => {
  const p = mockProvider({ hang: true });
  const s = spyBudget(createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' }));
  const r = await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t)), budget: s.b, timeoutMs: 40 }), input(), NOW);
  assert.ok(r.ok && r.source === 'fallback');
  assert.equal(p.calls.length, 1);
  assert.deepEqual(s.log, ['reserve(10)=ok', 'confirm(10)']); // cancel 없음
});
test('TEST-05b 과금 불확실 예약의 별도 "조정 대기" 상태', { todo: 'GAP: 불확실 예약을 확정(전액)으로만 처리 — 사용량 확인 후 조정하는 상태·절차가 없다' }, () => {
  assert.match(sql, /ai_usage_closures[\s\S]{0,300}kind[\s\S]{0,200}(pending|adjust|uncertain|unknown)/i);
});

test('TEST-06 Provider 429·500·503: 재시도 없이 전송 1회, 비용 확정(한도에 포함), 안전 안내문(오류 원문·키 미노출)', async () => {
  for (const status of [429, 500, 503]) {
    const p = mockProvider({ status, text: 'upstream error ' + KEY });
    const s = spyBudget(createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' }));
    const r = await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t)), budget: s.b }), input(), NOW);
    assert.ok(r.ok && r.source === 'fallback', `status ${status}`);
    assert.equal(p.calls.length, 1, `status ${status}: 재시도 없음`);
    assert.deepEqual(s.log, ['reserve(10)=ok', 'confirm(10)']);
    assert.ok(!JSON.stringify(r).includes(KEY) && !/HTTP_|upstream/.test(JSON.stringify(r)));
  }
});

test('TEST-07 사용량 데이터 누락: 0원으로 정산하지 않고 예약 비용을 그대로 확정(보수적)', async () => {
  for (const extra of [{}, { usage: null }, { usage: { input_tokens: 1, output_tokens: 1 } }]) {
    const p = mockProvider({ text: okBody('안녕하세요. 승인된 안내입니다.', extra) });
    const s = spyBudget(createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' }));
    await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t)), budget: s.b }), input(), NOW);
    assert.deepEqual(s.log, ['reserve(10)=ok', 'confirm(10)']);
  }
});

test('TEST-08a 긴급 차단(대체 수단): 월 한도 0원이면 신규 호출 전송 0회', async () => {
  const p = mockProvider();
  const r = await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t)), budget: createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '0' }) }), input(), NOW);
  assert.ok(r.ok && r.source === 'fallback');
  assert.equal(p.calls.length, 0);
});
test('TEST-08b 전용 긴급 차단 스위치 + 진행 중 요청 처리 상태 기록', { todo: 'GAP: 전용 스위치·진행 중 요청 기록 없음(L10과 동일 근거). 광고 생성 경로는 월 한도 0원으로도 막히지 않음(TEST-14)' }, () => {
  assert.ok(/kill.?switch|emergency|ai_disabled|ai_paused/i.test(sql));
});

test('TEST-09a 월 한도 환경변수 오류(미설정·음수·문자·NaN·Infinity·빈값): 모두 호출 차단', async () => {
  for (const v of [undefined, '', '-5', 'abc', 'NaN', 'Infinity', '1e999', '0', '-0', '12abc']) {
    const b = createAiBudget(v === undefined ? {} : { CONSULT_AI_MONTHLY_BUDGET_KRW: v });
    assert.equal(await b.reserve(1), null, `value=${String(v)}`);
  }
});
test('TEST-09b 형식 엄격 검증: 10진 정수가 아닌 문자열(0x10·1e3)은 한도로 인정하면 안 된다', { todo: 'GAP: Number() 변환이라 "0x10"→16, "1e3"→1000이 유효 한도로 받아들여짐(추측 해석)' }, async () => {
  for (const v of ['0x10', '1e3', '0b11']) {
    assert.equal(await createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: v }).reserve(1), null, `value=${v}`);
  }
});
test('TEST-09c 잘못된 모델·요금·실행 설정: 전송 0회', async () => {
  for (const over of [{ executionAllowed: 'true' }, { executionAllowed: 1 }, { model: null }, { model: 'BAD MODEL' }, { endpoint: 'http://x.example.test/a' }, { apiKey: 'short' }, { costPerCallKrw: -3 }]) {
    const p = mockProvider();
    await answerChat(deps({ model: createOpenAiChatModel(cfg(p.t, over as never)), budget: createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' }) }), input(), NOW);
    assert.equal(p.calls.length, 0, JSON.stringify(over));
  }
});
test('TEST-09d 설정 오류를 관리자가 확인할 수 있게 기록', { todo: 'GAP: 설정 오류는 조용히 fallback될 뿐 관리자용 오류 기록(로그·감사·경고)이 없다' }, () => {
  assert.ok(grepSrc(/CONSULT_AI_MONTHLY_BUDGET_KRW/).some((f) => /audit|alert|logConfig|reportConfig/i.test(readFileSync(path.join(SRC, f), 'utf8'))));
});

test('TEST-10a 비용은 정수 원 단위(1~1000)로만 예약·확정된다 — 소수·음수·초과는 거부', async () => {
  const b = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '100000' });
  for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(await b.reserve(bad), null, String(bad));
});
test('TEST-10b 토큰·캐시·모델별 가격 기반 비용 계산(입력/출력/캐시 토큰, 가격표, 통화)', { todo: 'GAP: 토큰 사용량·가격표·캐시·통화 처리 없음 — 호출당 고정 금액(costPerCallKrw)만 쓴다. 응답의 usage는 읽지 않는다' }, () => {
  assert.ok(grepSrc(/(?<!max_)(input_tokens|output_tokens)|cached_tokens|pricePer|tokenPrice/i).length > 0);
});

test('TEST-11a 메모리 예산은 기간 개념이 없다(월 전환 시 초기화 불가) — 운영 경로는 DB(KST 월 키)여야 한다', () => {
  assert.match(sql, /to_char\(now\(\) at time zone 'Asia\/Seoul', 'YYYY-MM'\)/);
  const mem = readFileSync(path.join(SRC, 'server/consult/chatModel.ts'), 'utf8');
  assert.match(mem, /프로세스 재시작 시 0/);
});
test('TEST-11b 한국 시간 기준 일일 한도·자정 전환', { todo: 'GAP: 일 단위 집계 키 없음(월 키만 존재)' }, () => {
  assert.match(/create table core\.ai_usage_ledger \(([\s\S]*?)\);/.exec(sql)![1]!, /\b(day|date)\b/i, '일 단위 키 없음');
});

test('TEST-12 같은 요청 반복: 멱등성(같은 요청 ID는 1회만 예약·전송)', { todo: 'GAP: 요청 ID·멱등 키 없음 — 같은 입력을 두 번 보내면 예약 2건·전송 2건' }, async () => {
  const p = mockProvider();
  const d = deps({ model: createOpenAiChatModel(cfg(p.t)), budget: createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' }) });
  await Promise.all([answerChat(d, input(), NOW), answerChat(d, input(), NOW)]);
  assert.equal(p.calls.length, 1);
});
test('TEST-12b 같은 예약의 중복 정산 방지(확정·취소는 예약당 1회) — DB 함수는 scripts/ai-cost-db-concurrency.sh에서 검증', async () => {
  const b = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '100' });
  const r = (await b.reserve(60))!;
  await r.confirm(60); await r.confirm(60); await r.cancel();
  assert.ok(await b.reserve(40));
  assert.equal(await b.reserve(1), null); // 60 + 40 = 100, 중복 정산으로 잔액이 늘지 않음
});

test('TEST-13 상담 중 한도 도달: 새 호출 차단, 승인된 안내문만 표시(모델 문구·추측 없음)', async () => {
  const p = mockProvider();
  const budget = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '15' });
  const d = deps({ model: createOpenAiChatModel(cfg(p.t)), budget });
  const first = await answerChat(d, input(), NOW);
  const second = await answerChat(d, input(), NOW);
  const baseline = await answerChat(deps({ model: null, budget }), input(), NOW);
  assert.ok(first.ok && first.source === 'model');
  assert.ok(second.ok && second.source === 'fallback');
  assert.equal(p.calls.length, 1); // 두 번째는 전송 0회
  assert.ok(second.ok && baseline.ok && second.text === baseline.text, '한도 초과 응답은 모델 없는 승인 안내문과 같아야 한다');
  assert.ok(second.ok && !second.text.includes('승인된 안내입니다.'));
});

test('TEST-14a 정적 점검: Provider 호출 코드 위치 목록(누락 경로 탐지)', () => {
  const callers = grepSrc(/OPENAI_RESPONSES_URL|api\.openai\.com|max_output_tokens:/);
  assert.deepEqual(callers.sort(), ['server/advertising/openAiAdGenerator.ts', 'server/consult/openAiChatModel.ts']);
});
test('TEST-14b 광고 생성 어댑터가 공통 비용 게이트(예약) 없이 Provider를 호출할 수 있다', { todo: 'GAP: createOpenAiAdGenerator는 예산 의존성이 없다 — 주입만 하면 한도 0원이어도 호출된다(현재 어디에도 연결되지 않은 준비 코드)' }, async () => {
  let calls = 0;
  const gen = createOpenAiAdGenerator({
    transport: (async () => { calls++; return { status: 200, body: new Response(okBody(JSON.stringify({ title: 't', description: 'd' }))).body }; }) as never,
    apiKey: KEY, model: 'test-model', executionAllowed: true, maxOutputTokens: 200, timeoutMs: 1000, maxResponseBytes: 8192,
  });
  await gen.generate({ instructions: 'i', input: 'x' } as never);
  assert.equal(calls, 0, '예산 예약 없이 Provider가 호출됨');
});
test('TEST-14c 상담 모델 어댑터를 직접 호출하면 비용 게이트를 우회한다(게이트가 어댑터가 아니라 answerChat에 있음)', { todo: 'GAP: createOpenAiChatModel().generate() 직접 호출 시 예약 없이 전송' }, async () => {
  const p = mockProvider();
  await createOpenAiChatModel(cfg(p.t)).generate({ system: 's', user: 'u', approved: 'a' }, new AbortController().signal);
  assert.equal(p.calls.length, 0, '예약 없이 Provider가 호출됨');
});
test('TEST-14d 상담 경로는 모델을 한도 예약을 거쳐서만 부른다(예약 거부 시 generate 미호출)', async () => {
  let generated = 0;
  const model = { name: 'fake', costPerCallKrw: 10, async generate() { generated++; return 'x'; } };
  await answerChat(deps({ model, budget: createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '5' }) }), input(), NOW);
  assert.equal(generated, 0);
});

// ───────── a2acdbc(PM 11/24 1번 복구 래퍼) 반영: 재시도 비용·차단기·중복 방어 ─────────
const noSleep = async () => undefined;
const recovering = (t: BodyTransport, over: Partial<OpenAiChatModelConfig> = {}, rc: Record<string, unknown> = {}) =>
  withRecovery(createOpenAiChatModel(cfg(t, over)), { sleep: noSleep, ...rc } as never);

test('TEST-06r 복구 래퍼: 429·500·503은 상한(기본 2회, 어떤 설정도 3회 초과 불가) 안에서만 재시도하고 실제 전송 횟수만큼 한도에 포함', async () => {
  for (const status of [429, 500, 503]) {
    const p = mockProvider({ status });
    const s = spyBudget(createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' }));
    const r = await answerChat(deps({ model: recovering(p.t), budget: s.b }), input(), NOW);
    assert.ok(r.ok && r.source === 'fallback');
    assert.equal(p.calls.length, 2, `status ${status}`);
    assert.deepEqual(s.log, ['reserve(20)=ok', 'confirm(20)']); // 재시도 포함 최대 비용을 먼저 예약, 보낸 횟수(2×10)만큼 확정
    assert.ok(await s.b.reserve(980)); assert.equal(await s.b.reserve(1), null); // 사용액이 정확히 20원
  }
  const p = mockProvider({ status: 503 });
  await answerChat(deps({ model: recovering(p.t, {}, { maxAttempts: 99 }), budget: createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' }) }), input(), NOW);
  assert.equal(p.calls.length, RECOVERY_LIMITS.maxAttempts);
});
test('TEST-06r2 재시도 비용이 남은 한도를 넘으면(예약 20 > 잔여 15) 첫 호출도 하지 않는다', async () => {
  const p = mockProvider({ status: 503 });
  const s = spyBudget(createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '15' }));
  const r = await answerChat(deps({ model: recovering(p.t), budget: s.b }), input(), NOW);
  assert.ok(r.ok && r.source === 'fallback');
  assert.equal(p.calls.length, 0);
  assert.deepEqual(s.log, ['reserve(20)=denied']);
});
test('TEST-06r3 4xx(인증·형식)는 재시도하지 않는다 — 전송 1회, 비용 10원만 확정', async () => {
  for (const status of [400, 401, 403]) {
    const p = mockProvider({ status });
    const s = spyBudget(createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' }));
    await answerChat(deps({ model: recovering(p.t), budget: s.b }), input(), NOW);
    assert.equal(p.calls.length, 1, `status ${status}`);
    assert.deepEqual(s.log, ['reserve(20)=ok', 'confirm(10)']);
  }
});
test('TEST-06r4 차단기: 연속 3회 실패 뒤에는 Provider 0회·예약 취소(0원)로 즉시 승인 안내문', async () => {
  const p = mockProvider({ status: 503 });
  const model = recovering(p.t);
  const budget = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' });
  for (let i = 0; i < 3; i++) await answerChat(deps({ model, budget }), input(), NOW);
  const before = p.calls.length;
  const s = spyBudget(budget);
  const r = await answerChat(deps({ model, budget: s.b }), input(), NOW);
  assert.ok(r.ok && r.source === 'fallback');
  assert.equal(p.calls.length, before, '차단기가 열린 뒤 Provider 호출 0회');
  assert.deepEqual(s.log, ['reserve(20)=ok', 'cancel']);
});
test('TEST-05r 복구 래퍼 + 무응답: 상담 전체 시간 초과 시 추가 시도 없이 전송 1회, 보낸 1회분(10원) 확정', async () => {
  const p = mockProvider({ hang: true });
  const s = spyBudget(createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000' }));
  const r = await answerChat(deps({ model: recovering(p.t), budget: s.b, timeoutMs: 40 }), input(), NOW);
  assert.ok(r.ok && r.source === 'fallback');
  assert.equal(p.calls.length, 1);
  assert.deepEqual(s.log, ['reserve(20)=ok', 'confirm(10)']);
});
test('TEST-12r 같은 세션 처리 중 중복 요청 방어(단일 프로세스 메모리): 두 번째 입장 거부, 종료·만료 뒤 허용', () => {
  const g = createInflightGuard(1000);
  assert.equal(g.enter('s:a', 0), true);
  assert.equal(g.enter('s:a', 10), false);
  assert.equal(g.enter('s:b', 10), true);
  g.leave('s:a'); assert.equal(g.enter('s:a', 20), true);
  assert.equal(g.enter('s:a', 1500), true); // ttl 만료
});
test('TEST-12s 처리 중 중복 방어가 여러 서버 인스턴스에서도 동작', { todo: 'GAP: InflightGuard는 프로세스 메모리 Map — 인스턴스가 여러 개면 인스턴스별로만 막는다(공유 저장소·DB 멱등 키 없음)' }, () => {
  assert.match(readFileSync(path.join(SRC, 'server/consult/chatHandler.ts'), 'utf8'), /inflight[\s\S]{0,400}(rpc|api\.|tx`|redis|database)/i);
});
