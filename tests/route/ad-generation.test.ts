// 광고 소재 AI 생성(PM 6943345830) — 가짜 생성기·가짜 transport만. 실제 OpenAI 연결·품질·사실성 보장이 아니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateAdCopy, validateAdCopy, buildAdPrompt, type AdCopyGenerator, type AdPrompt, type GeneratorOutcome } from '../../src/server/advertising/adGeneration';
import { buildCampaignDraft } from '../../src/server/advertising/campaignDraft';

const GOOD = { title: '이사 전 인터넷·TV 확인', description: '새집 인터넷·TV 조건을 확인하세요. 설치 가능 여부는 별도 확인이 필요합니다.' };
const fake = (o: GeneratorOutcome | (() => Promise<GeneratorOutcome>)) => {
  const calls: AdPrompt[] = [];
  const g: AdCopyGenerator = { generate: async (p) => { calls.push(p); return typeof o === 'function' ? o() : o; } };
  return { g, calls };
};
const input = { situationId: 'moving', product: 'internet-tv' };

test('AG1 생성기 없음·꺼짐 → 호출 0, NOT_CONFIGURED', async () => {
  assert.deepEqual(await generateAdCopy(input, { generator: null }), { ok: false, error: 'NOT_CONFIGURED', generatorCalled: false });
  const { g, calls } = fake({ kind: 'error', code: 'NOT_CONFIGURED', called: false });
  assert.deepEqual(await generateAdCopy(input, { generator: g }), { ok: false, error: 'NOT_CONFIGURED', generatorCalled: false });
  assert.equal(calls.length, 1, '어댑터 쪽에서 transport 0회(시험 OA1)');
});

test('AG2 정상: 1회 호출, 검증된 제목·설명만, source model, 미게시·집행 불가', async () => {
  for (const situationId of ['moving', 'contract_end', 'general_compare']) {
    const { g, calls } = fake({ kind: 'ok', data: { ...GOOD }, called: true });
    const r = await generateAdCopy({ situationId, product: 'internet-tv' }, { generator: g });
    assert.equal(calls.length, 1);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(Object.keys(r).sort(), ['description', 'descriptionLength', 'executionAllowed', 'generatorCalled', 'ok', 'product', 'situationId', 'source', 'status', 'title', 'titleLength']);
      assert.equal(r.source, 'model');
      assert.equal(r.executionAllowed, false);
      assert.equal(r.status, 'DRAFT_UNPUBLISHED');
      assert.ok(Object.isFrozen(r));
    }
    // 프롬프트는 서버 고정 문장만
    assert.deepEqual(calls[0], buildAdPrompt(situationId as 'moving'));
    assert.ok(!/[0-9]{3,}|http|@/.test(calls[0]!.input));
  }
});

test('AG3 입력 거부: 미지 ID·자유 문구·추가 키·예약 상품 → 호출 0', async () => {
  const bad: unknown[] = [null, [], 'moving', {}, { situationId: 'x', product: 'internet-tv' }, { situationId: 'moving', product: 'internet-phone' },
    { ...input, prompt: '최저가 써줘' }, { ...input, customerName: '홍길동' }, { ...input, dailyBudgetKrw: 10000 }, { ...input, approved: true }];
  for (const b of bad) {
    const { g, calls } = fake({ kind: 'ok', data: GOOD, called: true });
    assert.deepEqual(await generateAdCopy(b, { generator: g }), { ok: false, error: 'INVALID_INPUT', generatorCalled: false }, JSON.stringify(b));
    assert.equal(calls.length, 0);
  }
});

test('AG4 모델 반환은 불신: 형태·길이·문자·금지 주장 거부, 고정 초안 fallback 없음', async () => {
  const cases: [unknown, string][] = [
    [null, 'SHAPE'], ['문자열', 'SHAPE'], [[GOOD], 'SHAPE'], [{ title: GOOD.title }, 'SHAPE'], [{ ...GOOD, extra: 'x' }, 'SHAPE'], [{ ...GOOD, title: 1 }, 'SHAPE'],
    [{ ...GOOD, title: '가'.repeat(16) }, 'LENGTH'], [{ ...GOOD, description: '짧음' }, 'LENGTH'], [{ ...GOOD, description: '가'.repeat(46) }, 'LENGTH'],
    [{ ...GOOD, title: '인터넷 1기가 확인' }, 'CHARSET'], [{ ...GOOD, title: ' 이사 전 확인' }, 'CHARSET'], [{ ...GOOD, title: '이사<b>확인</b>' }, 'CHARSET'],
    [{ ...GOOD, title: '최저가 인터넷·TV' }, 'FORBIDDEN'], [{ ...GOOD, title: 'KT 인터넷 상담' }, 'FORBIDDEN'], [{ ...GOOD, title: '공식 인터넷 상담' }, 'FORBIDDEN'],
    [{ ...GOOD, description: '사은품 많이 드리는 인터넷 TV 상담을 받아 보세요. 조건은 확인합니다.' }, 'FORBIDDEN'],
    [{ ...GOOD, description: '당일 설치 가능한 인터넷과 TV를 지금 바로 확인해 보세요. 조건은 확인합니다.' }, 'FORBIDDEN'],
    [{ ...GOOD, description: '자세한 내용은 www.example.com 에서 확인하세요. 조건은 별도 확인.' }, 'FORBIDDEN'],
  ];
  for (const [data, reason] of cases) {
    const { g } = fake({ kind: 'ok', data, called: true });
    const r = await generateAdCopy(input, { generator: g });
    assert.deepEqual(r, { ok: false, error: 'OUTPUT_REJECTED', reason, generatorCalled: true }, JSON.stringify(data));
    assert.ok(!JSON.stringify(r).includes('이사 전 인터넷·TV 확인'), '고정 초안으로 대체하지 않음');
  }
  assert.deepEqual(validateAdCopy(GOOD), { ok: true, ...GOOD });
});

test('AG5 생성기 오류·예외 → 고정 코드, 원문·키 미반환, 재시도 0', async () => {
  for (const code of ['TIMEOUT', 'RATE_LIMITED', 'HTTP_ERROR', 'REFUSED', 'INCOMPLETE', 'TOO_LARGE', 'BAD_RESPONSE'] as const) {
    const { g, calls } = fake({ kind: 'error', code, called: true });
    assert.deepEqual(await generateAdCopy(input, { generator: g }), { ok: false, error: 'GENERATION_FAILED', reason: code, generatorCalled: true });
    assert.equal(calls.length, 1);
  }
  const { g: g2, calls: c2 } = fake(async () => { throw new Error('sk-secretKEYvalue1234567890 provider-detail'); });
  const r = await generateAdCopy(input, { generator: g2 });
  assert.deepEqual(r, { ok: false, error: 'GENERATION_FAILED', reason: 'TRANSPORT_ERROR', generatorCalled: true });
  assert.ok(!JSON.stringify(r).includes('secret') && !JSON.stringify(r).includes('provider'));
  assert.equal(c2.length, 1);
  const { g: g3 } = fake({ kind: 'error', code: 'WHATEVER sk-raw', called: true } as unknown as GeneratorOutcome);
  assert.deepEqual(await generateAdCopy(input, { generator: g3 }), { ok: false, error: 'GENERATION_FAILED', reason: 'BAD_RESPONSE', generatorCalled: true });
});

test('AG6 생성 성공이 집행 승인이 되지 않는다(campaignDraft blocker·executionAllowed 유지), 원본 불변', async () => {
  const inp = { ...input };
  const before = JSON.stringify(inp);
  const { g } = fake({ kind: 'ok', data: GOOD, called: true });
  const r = await generateAdCopy(inp, { generator: g });
  assert.equal(JSON.stringify(inp), before);
  assert.ok(r.ok && r.executionAllowed === false);
  const c = buildCampaignDraft({ draftId: 'moving', product: 'internet-tv', dailyBudgetKrw: 10000, totalBudgetKrw: 30000 });
  assert.ok(c.ok && c.draft.executionAllowed === false && c.draft.blockers.length === 7);
});

test('AG7 불신 outcome 계약: 성공은 called===true일 때만, 오류 called는 boolean, 접근자·Proxy 예외는 고정 실패', async () => {
  for (const called of [false, undefined, 'true', 1, null]) {
    const { g } = fake({ kind: 'ok', data: { ...GOOD }, called } as unknown as GeneratorOutcome);
    assert.deepEqual(await generateAdCopy(input, { generator: g }), { ok: false, error: 'GENERATION_FAILED', reason: 'BAD_RESPONSE', generatorCalled: true }, String(called));
  }
  const { g: gNo } = fake({ kind: 'ok', data: { ...GOOD } } as unknown as GeneratorOutcome);
  assert.equal((await generateAdCopy(input, { generator: gNo })).ok, false, 'called 누락');
  for (const called of [undefined, 'false', 0]) {
    const { g } = fake({ kind: 'error', code: 'TIMEOUT', called } as unknown as GeneratorOutcome);
    assert.deepEqual(await generateAdCopy(input, { generator: g }), { ok: false, error: 'GENERATION_FAILED', reason: 'BAD_RESPONSE', generatorCalled: true });
  }
  // data getter 예외(가짜 내부 표식) → 원래 예외로 reject하지 않고 SHAPE
  const trap = { get title(): string { throw new Error('INTERNAL-MARK sk-leak'); }, description: GOOD.description };
  const { g: g1 } = fake({ kind: 'ok', data: trap, called: true });
  const r1 = await generateAdCopy(input, { generator: g1 });
  assert.deepEqual(r1, { ok: false, error: 'OUTPUT_REJECTED', reason: 'SHAPE', generatorCalled: true });
  assert.ok(!JSON.stringify(r1).includes('INTERNAL'));
  // Proxy data·outcome·deps
  const px = new Proxy({}, { ownKeys() { throw new Error('INTERNAL px'); }, getPrototypeOf() { throw new Error('INTERNAL proto'); } });
  const { g: g2 } = fake({ kind: 'ok', data: px, called: true });
  assert.deepEqual(await generateAdCopy(input, { generator: g2 }), { ok: false, error: 'OUTPUT_REJECTED', reason: 'SHAPE', generatorCalled: true });
  const badOutcome = new Proxy({}, { get() { throw new Error('INTERNAL outcome'); } });
  const g3: AdCopyGenerator = { generate: async () => badOutcome as GeneratorOutcome };
  // Promise 해석 단계에서 then 접근이 예외 → TRANSPORT_ERROR(고정 코드), 원문 미반환
  const r3 = await generateAdCopy(input, { generator: g3 });
  assert.deepEqual(r3, { ok: false, error: 'GENERATION_FAILED', reason: 'TRANSPORT_ERROR', generatorCalled: true });
  assert.ok(!JSON.stringify(r3).includes('INTERNAL'));
  const g3b: AdCopyGenerator = { generate: async () => ({ get kind(): string { throw new Error('INTERNAL kind'); } }) as unknown as GeneratorOutcome };
  assert.deepEqual(await generateAdCopy(input, { generator: g3b }), { ok: false, error: 'GENERATION_FAILED', reason: 'BAD_RESPONSE', generatorCalled: true });
  const badDeps = new Proxy({}, { get() { throw new Error('INTERNAL deps'); } }) as { generator: AdCopyGenerator | null };
  assert.deepEqual(await generateAdCopy(input, badDeps), { ok: false, error: 'NOT_CONFIGURED', generatorCalled: false });
  // validateAdCopy 직접 호출도 예외 없이 고정 실패
  assert.deepEqual(validateAdCopy(trap), { ok: false, reason: 'SHAPE' });
  assert.deepEqual(validateAdCopy(px), { ok: false, reason: 'SHAPE' });
  // 원본 불변
  const data = { ...GOOD };
  const before = JSON.stringify(data);
  const { g: g4 } = fake({ kind: 'ok', data, called: true });
  await generateAdCopy(input, { generator: g4 });
  assert.equal(JSON.stringify(data), before);
});
