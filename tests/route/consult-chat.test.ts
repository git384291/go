// AI 상담 답변 시험 — 무료 모의 모델·가상 정책만 사용. 실제 API 호출 없음
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { answerChat } from '../../src/server/consult/chatAnswer';
import { createAiBudget, createDbAiBudget, createModel, mockModel, ModelNotCalledError } from '../../src/server/consult/chatModel';
import type { ChatModel, ModelInput } from '../../src/server/consult/chatModel';
import { maskPii } from '../../src/server/consult/piiMask';
import { createLimiter, handleChat } from '../../src/server/consult/chatHandler';
import { NEEDS_REVIEW_GUIDANCE } from '../../src/server/policies';
import { POLICY_UNVERIFIED_GUIDANCE } from '../../src/content/consultGuidance';
const dbDown = () => { throw new Error('db down'); };

const NOW = new Date('2026-11-23T12:00:00+09:00');
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
const input = (message: unknown = '요금이 얼마예요?') => ({ message, carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1' });
const deps = (over: Record<string, unknown> = {}) => ({ provider: () => [rec], supplierId: 'supplier-a', model: mockModel, budget: createAiBudget({}), ...over }) as never;
const fake = (fn: (i: ModelInput, s: AbortSignal) => Promise<string>, cost = 0): ChatModel => ({ name: 'fake', costPerCallKrw: cost, generate: fn });

test('CH1 승인 정책이면 모의 모델이 승인 금액만 안내하고 가입 신청으로 이어진다', async () => {
  const r = await answerChat(deps(), input(), NOW);
  assert.ok(r.ok && r.kind === 'quote' && r.source === 'model' && r.next === 'signup');
  assert.ok(r.ok && r.text.includes('11,111') && r.text.includes('3,333'));
  assert.ok(r.ok && !r.text.includes('999') && !r.text.includes('internal'));
});
test('CH2 정책 없음·공급자 오류는 담당자 확인 안내(금액·혜택 없음)', async () => {
  for (const provider of [() => [], () => { throw new Error('boom'); }]) {
    const r = await answerChat(deps({ provider }), input(), NOW);
    assert.ok(r.ok && r.kind === 'needs_review');
    assert.ok(r.ok && !/\d{3,}/.test(r.text));
  }
});
test('CH3 모델이 승인 밖 금액·혜택을 지어내면 승인 안내문으로 대체', async () => {
  for (const evil of ['월 9,900원에 해 드려요', '사은품 5만원 추가 드려요', '월 삼만원입니다', '월 11,111원이고 사은품 30만원']) {
    const r = await answerChat(deps({ model: fake(async () => evil) }), input(), NOW);
    assert.ok(r.ok && r.source === 'fallback' && !r.text.includes(evil.slice(0, 6)), evil);
  }
  // 승인 정책이 없는데 혜택을 말하면 막힘
  const r = await answerChat(deps({ provider: () => [], model: fake(async () => '상품권을 드립니다') }), input(), NOW);
  assert.ok(r.ok && r.source === 'fallback' && r.text === NEEDS_REVIEW_GUIDANCE);
});
test('CH4 모델 장애·시간 초과는 안전 안내문, 오류 문구는 고객에게 안 감', async () => {
  const boom = await answerChat(deps({ model: fake(async () => { throw new Error('SECRET api key sk-123'); }) }), input(), NOW);
  assert.ok(boom.ok && boom.source === 'fallback' && !JSON.stringify(boom).includes('sk-123'));
  const slow = await answerChat(deps({ timeoutMs: 20, model: fake((_i, s) => new Promise((res) => { s.addEventListener('abort', () => res('late')); })) }), input(), NOW);
  assert.ok(slow.ok && slow.source === 'fallback');
});
test('CH5 사용료 예약·확정·취소: 기본 0원이면 유료 모델 호출 0회, 한도 초과 뒤 호출 안 함, 호출 전 실패만 취소, 집계 오류는 호출 금지', async () => {
  let calls = 0;
  const paid = fake(async () => { calls++; return '안내'; }, 5);
  const r0 = await answerChat(deps({ model: paid, budget: createAiBudget({}) }), input(), NOW);
  assert.ok(r0.ok && r0.source === 'fallback' && calls === 0);
  const b = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '10' });
  for (let i = 0; i < 4; i++) await answerChat(deps({ model: paid, budget: b }), input(), NOW);
  assert.equal(calls, 2);
  // 호출 전 실패(ModelNotCalledError)는 취소(0원) → 한도 안에서 다시 호출 가능, 그 밖의 실패는 확정(비용 유지)
  const nb = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '5' });
  const notCalled = fake(async () => { throw new ModelNotCalledError('no key'); }, 5);
  for (let i = 0; i < 3; i++) assert.ok((await answerChat(deps({ model: notCalled, budget: nb }), input(), NOW)).ok);
  assert.ok(await nb.reserve(5), '취소된 예약은 비용 0원이라 다시 예약 가능');
  const eb = createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '5' });
  await answerChat(deps({ model: fake(async () => { throw new Error('upstream 500'); }, 5), budget: eb }), input(), NOW);
  assert.equal(await eb.reserve(5), null, '장애로 실패한 호출은 비용이 났을 수 있어 확정(한도 소진)');
  assert.equal(await createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '-5' }).reserve(1), null);
  assert.equal(await createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: 'abc' }).reserve(1), null);
  assert.ok(await createAiBudget({}).reserve(0));
  // DB 집계: hold 번호가 있어야 통과, 확정·취소는 번호로 DB 함수 호출, 오류는 거부/삼킴
  const log: string[] = [];
  const mk = (rows: unknown, boom = false) => createDbAiBudget(async (fn) => { if (boom) throw new Error('db down'); return fn(((s: TemplateStringsArray, ...v: unknown[]) => { log.push(s.join('?') + '|' + v.join(',')); return Promise.resolve(rows); }) as never); });
  const res = await mk([{ id: '42' }]).reserve(5);
  assert.ok(res);
  await res.confirm(3);
  await res.cancel();
  assert.ok(log[0].includes('api.ai_budget_hold') && log[1].includes('api.ai_budget_confirm') && log[1].endsWith('42,3') && log[2].includes('api.ai_budget_release') && log[2].endsWith('42'));
  for (const bad of [[{ id: null }], [], [{ id: 'abc' }], [{ id: 5 }], null]) assert.equal(await mk(bad).reserve(5), null);
  assert.equal(await mk([], true).reserve(5), null);
  const free = createDbAiBudget(async () => { throw new Error('호출되면 안 됨'); });
  assert.ok(await free.reserve(0));
  assert.equal(await mk([{ id: '1' }]).reserve(-1), null);
  // 정산 중 DB 오류는 삼킨다(미정산 = 예약 비용 전액으로 DB가 계산)
  let first = true;
  const flaky = createDbAiBudget(async (fn) => { if (!first) throw new Error('down'); first = false; return fn((() => Promise.resolve([{ id: '7' }])) as never); });
  const h = await flaky.reserve(5);
  assert.ok(h);
  await h.confirm(5);
  await h.cancel();
});
test('CH6 개인정보는 모델에 가려서만 전달된다', async () => {
  let seen = '';
  const spy = fake(async (i) => { seen = JSON.stringify(i); return '확인했습니다'; });
  const msg = '이름은 김철수 전화 010-1234-5678 메일 a.b@c.com 주민 900101-1234567 서울시 강남구 테헤란로 123 101호 요금?';
  await answerChat(deps({ model: spy }), input(msg), NOW);
  for (const raw of ['김철수', '1234-5678', '010-1234', 'a.b@c.com', '900101', '1234567', '테헤란로']) assert.ok(!seen.includes(raw), raw);
  assert.ok(seen.includes('[전화]') && seen.includes('[이메일]'));
  assert.equal(maskPii('요금 문의'), '요금 문의');
});
test('CH7 모델 이름 설정: mock만 모델이 있고 나머지(실제 API 이름 포함)는 모델 없음 → 안전 안내', async () => {
  assert.equal(createModel({ CONSULT_AI_MODEL: 'mock' }), mockModel);
  for (const v of [undefined, '', 'openai', 'gpt-x', 'MOCK']) assert.equal(createModel({ CONSULT_AI_MODEL: v }), null);
  const r = await answerChat(deps({ model: null }), input(), NOW);
  assert.ok(r.ok && r.source === 'fallback' && r.kind === 'quote');
});
test('CH8 입력 검사: 빈 글·301자·문자열 아님', async () => {
  for (const m of ['', '   ', 'a'.repeat(301), 5, null, { a: 1 }]) assert.deepEqual(await answerChat(deps(), input(m), NOW), { ok: false, code: 'INVALID_INPUT' });
});
const KEY = Buffer.alloc(32, 7);
const HD = (over: Record<string, unknown> = {}) => ({ enabled: true, chat: deps(), limiter: createLimiter(2, 60_000), ip: '203.0.113.9', now: () => NOW, sessionKey: KEY, newSessionLimiter: createLimiter(50, 60_000), botCheck: async () => 'ok', rateLimit: async () => true, ...over }) as never;
const post = (b: unknown, raw?: string) => new Request('http://x/api/consult/chat', { method: 'POST', body: raw ?? JSON.stringify(b) });
const good = { carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1', message: '요금?' };
test('CH9 핸들러: 꺼짐 503·크기 413·형식 400·여분 키 400·횟수 제한 429·no-store', async () => {
  assert.equal((await handleChat(post(good), HD({ enabled: false }))).status, 503);
  assert.equal((await handleChat(post(good), HD({ chat: null }))).status, 503);
  assert.equal((await handleChat(post(null, 'x'.repeat(5000)), HD())).status, 413);
  assert.equal((await handleChat(post(null, '{bad'), HD())).status, 400);
  assert.equal((await handleChat(post({ ...good, extra: 1 }), HD())).status, 400);
  assert.equal((await handleChat(post({ ...good, session: 'short' }), HD())).status, 400);
  assert.equal((await handleChat(post(good), HD({ sessionKey: null }))).status, 503);
  assert.equal((await handleChat(post({ ...good, campaign: 'Bad Key!' }), HD())).status, 400);
  assert.equal((await handleChat(post({ ...good, carrier: 'Bad Key!' }), HD())).status, 400);
  assert.equal((await handleChat(post({ ...good, message: '' }), HD())).status, 400);
  const d = HD();
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await handleChat(post(good), d)).status);
  assert.deepEqual(codes, [200, 200, 429]);
  const ok = await handleChat(post(good), HD());
  assert.equal(ok.headers.get('cache-control'), 'private, no-store');
  const j = await ok.json();
  assert.ok(j.ok && j.kind === 'quote' && !JSON.stringify(j).includes('CONSULT_AI'));
});
test('CH10 정적: 키 환경변수는 서버 모듈에서만, 클라이언트 파일은 상담 서버 모듈·키를 import하지 않음, 실제 AI 주소·SDK 없음', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = path.join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  for (const f of walk('src').filter((p) => /\.(ts|tsx)$/.test(p))) {
    const s = readFileSync(f, 'utf8');
    if (/^['"]use client['"]/.test(s.trimStart())) assert.ok(!/server\/consult|CONSULT_AI|API_KEY/.test(s), `${f}: 클라이언트 파일`);
    if (f.startsWith(path.join('src', 'server', 'consult'))) assert.ok(!/api\.openai\.com|api\.anthropic\.com|from ['"]openai['"]|fetch\(/.test(s), `${f}: 실제 API 호출 없음`);
    if (/CONSULT_AI_API_KEY/.test(s)) assert.ok(f.startsWith(path.join('src', 'server')), `${f}: 키는 서버 코드에서만`);
  }
});

test('CH11 상담 시작 기록: 서버 발급 세션만 기록, 같은 세션 재전송은 같은 id, 캠페인은 있을 때만, 기록 실패·입력 오류·꺼짐·횟수 제한 처리', async () => {
  const seen: [string, string | null][] = [];
  const rec = async (s: string, c: string | null) => { seen.push([s, c]); };
  const r1 = await handleChat(post({ ...good, campaign: 'camp-q' }), HD({ recordConsult: rec }));
  assert.equal(r1.status, 200);
  const tok = (await r1.json()).session as string;
  assert.match(tok, /^[0-9a-f]{32}\.\d+\.[0-9a-f]{64}$/);
  assert.equal((await handleChat(post({ ...good, session: tok }), HD({ recordConsult: rec }))).status, 200);
  assert.equal(seen.length, 2);
  assert.equal(seen[0][0], seen[1][0]); // 같은 세션 id → DB가 1건만 센다
  assert.deepEqual([seen[0][1], seen[1][1]], ['camp-q', null]);
  const before = seen.length;
  await handleChat(post({ ...good, message: '' }), HD({ recordConsult: rec }));
  await handleChat(post(good), HD({ recordConsult: rec, enabled: false }));
  const d = HD({ recordConsult: rec, limiter: createLimiter(1, 60_000) });
  await handleChat(post(good), d);
  await handleChat(post(good), d);
  assert.equal(seen.length, before + 1);
  const bad = await handleChat(post(good), HD({ recordConsult: async () => { throw new Error('db down'); } }));
  assert.equal(bad.status, 200);
});
test('CH12 세션 조작 방지: 위조·변조·만료·다른 키·브라우저가 만든 id → 400 기록 0, 새 세션은 IP별 제한', async () => {
  const seen: string[] = [];
  const rec = async (s: string) => { seen.push(s); };
  const tok = (await (await handleChat(post(good), HD({ recordConsult: rec }))).json()).session as string;
  const [id, exp, sig] = tok.split('.');
  const flip = sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a');
  const NOWSEC = Math.floor(NOW.getTime() / 1000);
  const forged = [`${id}.${exp}.${flip}`, `${'0'.repeat(32)}.${exp}.${sig}`, `${id}.${Number(exp) + 999}.${sig}`, 'sess-0123456789abcdef', `${id}.${NOWSEC - 5}.${sig}`, 'x'.repeat(500)];
  for (const f of forged) assert.equal((await handleChat(post({ ...good, session: f }), HD({ recordConsult: rec }))).status, 400, f.slice(0, 20));
  assert.equal((await handleChat(post({ ...good, session: tok }), HD({ recordConsult: rec, sessionKey: Buffer.alloc(32, 9) }))).status, 400);
  assert.equal((await handleChat(post({ ...good, session: tok }), HD({ recordConsult: rec, now: () => new Date(NOW.getTime() + 25 * 3600_000) }))).status, 400);
  assert.equal(seen.length, 1);
  const nl = createLimiter(2, 60_000);
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await handleChat(post(good), HD({ newSessionLimiter: nl, limiter: createLimiter(99, 60_000) }))).status);
  assert.deepEqual(codes, [200, 200, 429]);
});
test('CH13 AI 정산 재시도: 일시 장애는 최대 3회까지 다시 시도, 끝내 실패해도 예외 없음, 성공 뒤 중복 호출 없음, 확정·취소는 각각 1종 호출', async () => {
  const mkb = (failFirst: number) => { const log: string[] = []; let n = 0;
    const b = createDbAiBudget(async (fn) => fn(((s: TemplateStringsArray) => { const q = s.join('?'); if (q.includes('ai_budget_hold')) return Promise.resolve([{ id: '5' }]); log.push(q); if (++n <= failFirst) return Promise.reject(new Error('down')); return Promise.resolve([{}]); }) as never));
    return { b, log }; };
  for (const [fails, calls] of [[0, 1], [1, 2], [2, 3], [3, 3], [9, 3]] as const) {
    const { b, log } = mkb(fails);
    const h = await b.reserve(5);
    assert.ok(h);
    await assert.doesNotReject(h.confirm(3));
    assert.equal(log.length, calls, `실패 ${fails}회`);
    assert.ok(log.every((q) => q.includes('ai_budget_confirm')));
  }
  const { b, log } = mkb(1);
  const h = await b.reserve(5);
  await h?.cancel();
  assert.deepEqual([log.length, log.every((q) => q.includes('ai_budget_release'))], [2, true]);
});

// PM 11/22 P1: 혜택 약속은 견적 유무와 관계없이 서버 승인 정책 값(allow)과 대조. 막히면 승인 안내문(fallback)
const recWith = (o: { form?: string; amount?: number; install?: number; equip?: number }) => ({
  ...rec,
  installFee: K({ amountKrw: o.install ?? 2222, vat: 'included' }),
  equipmentMonthlyFee: K({ amountKrw: o.equip ?? 0, vat: 'included' }),
  customerBenefit: K({ amountKrw: o.amount ?? 3333, form: o.form ?? 'gift_card', payoutCondition: K('개통 후 지급(가상)'), cancellationCondition: K('약정 내 해지 시 환수(가상)') }),
});
const say = async (r: Record<string, unknown>, text: string, provider?: () => unknown[]) =>
  answerChat(deps({ provider: provider ?? (() => [r]), model: fake(async () => text) }), input(), NOW);
test('BN1 승인된 혜택 PASS: 승인 상품권·승인 현금·승인 요금할인·승인 0원 설치비는 모델 답변 그대로', async () => {
  const ok: [Record<string, unknown>, string][] = [
    [recWith({}), '월 11,111원이고 사은품은 3,333원 상품권입니다.'],
    [recWith({ form: 'cash' }), '월 11,111원, 현금 3,333원을 지급 조건에 따라 드립니다.'],
    [recWith({ form: 'bill_discount' }), '월 11,111원이고 요금 할인 3,333원이 적용됩니다.'],
    [recWith({ install: 0 }), '월 11,111원, 설치비는 무료(0원)입니다.'],
    [recWith({}), '장비 임대료는 무료이고 월 11,111원입니다.'],
  ];
  for (const [r, t] of ok) { const a = await say(r, t); assert.ok(a.ok && a.source === 'model' && a.text === t, t); }
});
test('BN2 미승인 혜택 BLOCK: 승인 형태와 다른 혜택(상품권 정책에 현금·할인, 사은품 없음 정책에 상품권)', async () => {
  const bad: [Record<string, unknown>, string][] = [
    [recWith({}), '월 11,111원, 현금 3,333원 드립니다.'],
    [recWith({}), '월 11,111원이고 3,333원 할인됩니다.'],
    [recWith({ form: 'none', amount: 0 }), '월 11,111원이고 상품권도 드려요.'],
    [recWith({ form: 'none', amount: 0 }), '월 11,111원, 사은품 챙겨 드려요.'],
  ];
  for (const [r, t] of bad) { const a = await say(r, t); assert.ok(a.ok && a.source === 'fallback', t); }
});
test('BN3 금액 없는 허위 혜택 BLOCK: 설치비 무료(승인 2,222원)·추가 상품권·현금 지원·무상 제공·면제·페이백', async () => {
  for (const t of ['월 11,111원입니다. 설치비 무료에 상품권도 드려요.', '월 11,111원, 추가 상품권 드려요.', '월 11,111원, 현금 지원 가능합니다.',
    '공유기 무상 제공해 드려요.', '설치비 면제됩니다.', '페이백 해 드립니다.', 'TV는 무료로 드려요.', '월 11,111원에 상품권 더 드려요.']) {
    const a = await say(recWith({}), t); assert.ok(a.ok && a.source === 'fallback', t);
  }
});
test('BN4 표현만 바꾼 허위 혜택 BLOCK(사은품 없음·설치비 2,222원 정책): 띄어쓰기·기호·영문·유사어 우회', async () => {
  for (const t of ['상 품-권 드립니다', '현.금 드려요', 'gift card 드려요', '캐쉬 말고 캐시백 드려요', '설치는 공짜예요', '설치비 안 받아요',
    '설치비 0원', '기프티콘 쏩니다', '깎아 드릴게요', '반값에 해 드려요', '포인트 적립해 드려요']) {
    const a = await say(recWith({ form: 'none', amount: 0 }), t); assert.ok(a.ok && a.source === 'fallback', t);
  }
});
test('BN5 정책 조회 실패·정책 없음이면 어떤 혜택 언급도 BLOCK(담당자 확인)', async () => {
  for (const provider of [dbDown, () => []]) {
    for (const t of ['상품권 드려요', '설치비 무료', '혜택 많아요']) {
      const a = await say(rec, t, provider as never);
      // PM 11/24: 조회 실패는 정책 검증 장애(B) → B 안내·접수 잠금, 정책 없음은 정상 '담당자 확인'
      assert.ok(a.ok && a.source === 'fallback' && (provider === dbDown ? a.text === POLICY_UNVERIFIED_GUIDANCE && a.next === 'blocked' : a.text === NEEDS_REVIEW_GUIDANCE), t);
    }
  }
});

// PM 11/22 B: 금전 표현과 일반 숫자 구분. 일반 숫자는 허용, 금액·할인율은 승인 값과 대조
test('MB1 일반 숫자 PASS: 24시간·36개월·날짜·500M·인원은 금전이 아니므로 그대로', async () => {
  for (const t of ['월 11,111원, 약정 36개월입니다. 24시간 상담 가능해요.', '월 11,111원이고 2026년 11월 23일부터 가능합니다.', '2026-11-23 기준 월 11,111원, 500M 인터넷과 TV 150채널입니다.',
    '월 11,111원, 1000Mbps 속도, 3명이 함께 쓸 수 있어요.', '2026.11.23 기준 월 11,111원입니다.']) {
    const a = await say(recWith({}), t); assert.ok(a.ok && a.source === 'model' && a.text === t, t);
  }
});
test('MB2 승인 금액은 표기 달라도 통과, 미승인 금액·단위 우회는 BLOCK', async () => {
  const ok = ['월 11,111원이고 사은품 3,333원 상품권입니다.', '월 1만1111원이고 3333원 상품권입니다.', '월 ₩11,111, 상품권 3,333원입니다.'];
  for (const t of ok) { const a = await say(recWith({}), t); assert.ok(a.ok && a.source === 'model', t); }
  for (const t of ['월 3만원 할인', '월 3만 할인해 드려요', '월 3만5천원에 해 드려요', '월 30000원입니다', '월 30,000 won 입니다', '월 $30 입니다', '월 11,111원, 사은품 5천원 상품권', '월 11111 원 그리고 9900', '월 십일만원', '월 이만 원']) {
    const a = await say(recWith({}), t); assert.ok(a.ok && a.source === 'fallback', t);
  }
});
test('MB3 할인율: 승인 문장에 없는 %·퍼센트·할·한글 수사는 BLOCK', async () => {
  for (const t of ['월 11,111원, 10% 할인됩니다', '20퍼센트 깎아 드려요', '3할 할인', '십퍼센트 할인', '월 11,111원에 50 % 할인', '월 11,111원, 100% 만족']) {
    const a = await say(recWith({ form: 'bill_discount' }), t); assert.ok(a.ok && a.source === 'fallback', t);
  }
});
test('MB4 정책값 확인 불가(조회 실패·정책 없음)면 금액·할인율·혜택 모두 담당자 확인으로 전환', async () => {
  for (const provider of [dbDown, () => []]) {
    for (const t of ['월 11,111원입니다', '10% 할인', '36개월 약정이고 3만원 드려요']) {
      const a = await say(rec, t, provider as never);
      // PM 11/24: 조회 실패는 정책 검증 장애(B) → B 안내·접수 잠금, 정책 없음은 정상 '담당자 확인'
      assert.ok(a.ok && a.source === 'fallback' && (provider === dbDown ? a.text === POLICY_UNVERIFIED_GUIDANCE && a.next === 'blocked' : a.text === NEEDS_REVIEW_GUIDANCE), t);
    }
  }
});

test('CB 대표 직접 연락 동의 질문: 승인 견적이 없거나 고객이 잘 모르겠다고 하면 next=callback·고정 문구, 견적+일반 질문은 signup', async () => {
  const { needsCallback, CALLBACK_PROMPT } = await import('../../src/server/consult/chatAnswer');
  assert.equal(needsCallback('요금 알려주세요', 'needs_review'), true);
  assert.equal(needsCallback('잘 모르겠어요', 'quote'), true);
  assert.equal(needsCallback('뭐가 좋은지 헷갈려요', 'quote'), true);
  assert.equal(needsCallback('설치 언제 돼요?', 'quote'), false);
  assert.ok(CALLBACK_PROMPT.startsWith('대표가 직접 연락드려도 될까요?'));
  assert.ok(!/\d/.test(CALLBACK_PROMPT));  const none = await answerChat(deps({ provider: () => [] }), input(), NOW);
  // PM 11/24 결정: 게시 정책이 없으면 접수(연락 동의 포함 신청 양식)를 잠근다 → 연락 동의 질문 대신 next 'blocked', 안내문은 그대로
  assert.ok(none.ok && none.next === 'blocked' && !('callbackPrompt' in none) && none.text === NEEDS_REVIEW_GUIDANCE);
  const unsure = await answerChat(deps(), input('잘 모르겠어요'), NOW);
  assert.ok(unsure.ok && unsure.kind === 'quote' && unsure.next === 'callback');
  const plain = await answerChat(deps(), input(), NOW);
  assert.ok(plain.ok && plain.next === 'signup' && plain.callbackPrompt === undefined);
});

test('CH-F1 서버 측 봇 확인·DB 공용 한도: 새 세션은 봇 확인 통과+세션 한도 안에서만, 메시지마다 chat 한도, 확인 불가·DB 오류는 503(모델 호출 0회)', async () => {
  const calls: string[] = [];
  let gen = 0;
  const spy = { name: 'spy', costPerCallKrw: 0, generate: async (i: { approved: string }) => { gen++; return i.approved; } };
  const hd = (o: Record<string, unknown> = {}) => HD({ chat: deps({ model: spy }), rateLimit: async (k: string) => { calls.push(k); return true; }, ...o });
  const ok = await handleChat(post({ ...good, turnstileToken: 'tok' }), hd({ botCheck: async (t: string, ip: string) => (t === 'tok' && ip === '203.0.113.9' ? 'ok' : 'rejected') }));
  assert.equal(ok.status, 200); assert.deepEqual(calls, ['session', 'chat']); assert.equal(gen, 1);
  const tok = (await ok.json()).session as string;
  calls.length = 0;
  assert.equal((await handleChat(post({ ...good, session: tok }), hd({ botCheck: async () => { throw new Error('must not call'); } }))).status, 200);
  assert.deepEqual(calls, ['chat'], '기존 세션은 봇 확인 없이 chat 한도만');
  gen = 0;
  const st = async (o: Record<string, unknown>, b: unknown = { ...good, turnstileToken: 'tok' }) => { const r = await handleChat(post(b), hd(o)); return [r.status, (await r.json()).code]; };
  assert.deepEqual(await st({ botCheck: async () => 'rejected' }), [403, 'BOT_CHECK_FAILED']);
  assert.deepEqual(await st({ botCheck: async () => 'rejected' }, good), [403, 'BOT_CHECK_FAILED']); // 토큰 없이 새 세션 불가
  assert.deepEqual(await st({ botCheck: async () => 'unavailable' }), [503, 'BOT_CHECK_UNAVAILABLE']);
  assert.deepEqual(await st({ botCheck: async () => { throw new Error('x'); } }), [503, 'BOT_CHECK_UNAVAILABLE']);
  assert.deepEqual(await st({ rateLimit: async (k: string) => k !== 'session' }), [429, 'SESSION_LIMIT']);
  assert.deepEqual(await st({ rateLimit: async (k: string) => k !== 'chat' }), [429, 'RATE_LIMITED']);
  assert.deepEqual(await st({ rateLimit: async () => { throw new Error('db down'); } }), [503, 'RATE_CHECK_UNAVAILABLE']);
  assert.deepEqual(await st({}, { ...good, session: tok, turnstileToken: 'tok' }), [400, 'INVALID_INPUT']);
  assert.equal(gen, 0, '막힌 요청은 모델 호출 0회');
  const route = readFileSync('src/app/api/consult/chat/route.ts', 'utf8');
  assert.match(route, /botCheck: \(token, from\) => verifyTurnstile\(token, from\)/);
  assert.match(route, /api\.consult_rate_hit\(\$\{h\}, \$\{kind\}\)/);
  assert.match(route, /ipHash\(rateKeyIp\(ip\)\)/); // PM 11/24: 회선 키(IPv6 /64)의 HMAC
});
