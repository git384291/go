// PR #2 보완 시험 — 데이터 최소화·자유 형식 이름/주소·분할 번호·정상 상담 오탐. Mock 전용, 합성 데이터만, 실제 AI·DB·네트워크 호출 0회.
// 범위: 아래 입력 목록에 대한 Mock 경계 검증이다. 규칙 기반이라 모든 이름·주소·변형을 잡는다는 뜻이 아니다(B7 todo = 알려진 탐지 한계).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerChat } from '../../src/server/consult/chatAnswer';
import { createAiBudget, ModelNotCalledError, SYSTEM_PROMPT } from '../../src/server/consult/chatModel';
import { createOpenAiChatModel, type OpenAiChatModelConfig } from '../../src/server/consult/openAiChatModel';
import { canonicalize, prepareUserText } from '../../src/server/consult/piiBoundary';
import type { BodyTransport } from '../../src/server/advertising/boundedHttp';

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
const reply = (text: string) => JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
function transport() {
  const calls: string[] = [];
  const t: BodyTransport = async (_url, init) => {
    calls.push(new TextDecoder().decode(init.body));
    return { status: 200, body: new Response(reply('문의 감사합니다. 승인된 안내를 확인해 주세요.')).body };
  };
  return { t, calls };
}
const cfg = (t: BodyTransport): OpenAiChatModelConfig => ({ transport: t, endpoint: 'https://model.example.test/v1/responses', apiKey: 'sk-test-' + 'A'.repeat(30), model: 'test-model', executionAllowed: true, costPerCallKrw: 5, maxOutputTokens: 200, timeoutMs: 5000, maxResponseBytes: 8192, prices: [{ model: 'test-model', currency: 'KRW', inputKrwPerMTok: 100, outputKrwPerMTok: 400 }], maxInputTokens: 4000 });
const deps = (t: BodyTransport) => ({ provider: () => [rec], supplierId: 'supplier-a', model: createOpenAiChatModel(cfg(t)), budget: createAiBudget({ CONSULT_AI_MONTHLY_BUDGET_KRW: '1000000' }) }) as never;
const input = (message: string) => ({ message, carrier: 'carrier-x', productId: 'net500-tv-basic', regionCode: 'region-1' });
const userPart = (body: string) => String((JSON.parse(body) as { input: string }).input).split('[고객 문의(개인정보 가림)]\n')[1] ?? '';

/** 차단돼야 하는 글: 전송 0회, 승인 안내문, 응답에 입력 원문 없음 */
async function blocked(list: readonly string[], label: string) {
  for (const m of list) {
    const tr = transport();
    const r = await answerChat(deps(tr.t), input(m), NOW);
    assert.equal(tr.calls.length, 0, `${label}: 전송 0회 (${list.indexOf(m)}번)`);
    assert.ok(r.ok && r.source === 'fallback', label);
    assert.equal(prepareUserText(m).ok, false, label);
  }
}

test('B1 자유 형식 이름: 문맥 단서(이름·성함·명의·예금주) 또는 "성+이름 + 입니다/고객/님" 모양이면 전송하지 않는다', async () => {
  await blocked([
    '홍길동입니다 요금 문의', '김가상이에요 가입할게요', '김가상 고객입니다', '박가상씨 명의로 해주세요', '최가상님 연락 주세요',
    '제 이름은 김가상', '성함: 이가상', '명의자는 정가상', '예금주 윤가상', '가입자명 강가상', '남궁가상입니다'.replace('남궁', '남'),
  ], '이름');
});

test('B2 주소: 도로명·지번 번호, 동·호수, 아파트 이름, 주소 문맥이면 전송하지 않는다', async () => {
  await blocked([
    '테헤란로 123 설치요', '역삼동 123-45 가능?', '가상아파트 101동 1203호', '래미안아파트 설치', '101동 1203호', '주소는 서울 강남구 가상동',
    '사는 곳: 가상시 가상구', '3호에 살아요'.replace('3호에', '1203호에'), '가상빌라 2층', '가상길 7 오피스텔',
  ], '주소');
});

test('B3 분할 전화번호: 공백·기호·글자·한글 숫자로 흩어 써도 전송하지 않는다', async () => {
  await blocked([
    '010 다음 1234 다음 5678', '공일공 일이삼사 오육칠팔', '0하나1둘0 1234 5678'.replace('하나', '').replace('둘', ''), '앞은010 중간은1234 끝은5678',
    '010이고 1234이고 5678', 'zero1zero 1234 5678'.replace('zero1zero', '010'), '01012345678원', '+82 10 1234 5678', '82-10-1234-5678',
  ], '분할 번호');
});

test('B4 정상 상담 과잉 차단 개선: 상품명·금액·설치일·번호이동·인터넷 전화는 그대로 전송된다', async () => {
  const normal = [
    'giga1000mbps 요금?', 'GiGA WiFi 인터넷 되나요', 'GiGA1000Mbps 상품 있나요', 'net500 요금', '인터넷 500M 요금 얼마예요?',
    '36개월 약정이면 월 33,000원 맞나요?', '1,000,000원 이상 사은품?', '월 27500원짜리 있나요', '2026-12-01 설치 가능?', '2026년 12월 1일 설치 원해요',
    '번호이동 하면 혜택 있나요?', '번호이동 3개월 뒤 해지', '인터넷 전화도 같이 되나요?', '전화번호 바뀌나요?', '010 번호 그대로 쓰나요?',
    '저는 인터넷만 쓰려고요', '고객님 상담 원해요', '기사님 방문 언제예요', '이사 가는데 이전 설치 되나요', '서울 강남구도 설치 되나요',
    'TV 채널 200개 이상인가요?', '5G 결합 할인 있나요', '와이파이 공유기 무료인가요', '인터넷입니다 TV도요', '2년 약정 3년 약정 차이',
  ];
  for (const m of normal) {
    const tr = transport();
    const r = await answerChat(deps(tr.t), input(m), NOW);
    assert.equal(tr.calls.length, 1, `정상 상담 전송 (${normal.indexOf(m)}번)`);
    assert.ok(r.ok && r.source === 'model');
    assert.equal(userPart(tr.calls[0]!), canonicalize(m), '보내는 글은 정규화한 원래 글(바꾸지 않음)');
  }
});

test('B5 데이터 최소화: 개인정보 신호가 있으면 고객 글은 가린 형태로도 0자 전송, 어댑터 최종 검사도 같은 규칙', async () => {
  const tr = transport();
  await answerChat(deps(tr.t), input('김가상입니다 010-1234-5678 요금 문의'), NOW);
  assert.equal(tr.calls.length, 0);
  // 어댑터를 직접 불러도(경로 밖 사용) 이름·주소 문맥이 있으면 전송하지 않는다
  for (const user of ['김가상입니다 요금', '테헤란로 123', '6rmA6rCA7IOB 확인']) {
    const t2 = transport();
    await assert.rejects(createOpenAiChatModel(cfg(t2.t)).generate({ system: SYSTEM_PROMPT, user, approved: '월 11,111원' }, new AbortController().signal), (e: unknown) => e instanceof ModelNotCalledError && e.message === 'PII_BLOCKED');
    assert.equal(t2.calls.length, 0);
  }
});

test('B6 오탐 완화가 우회로가 되지 않는다: 금액·날짜·상품명 모양으로 위장한 번호·인코딩은 여전히 차단', async () => {
  await blocked([
    '01012345678원', '010-1234-5678원', '1990-01-01 생일', '1990.01.01', '010,1234,5678', 'MDEwLTEyMzQtNTY3OA', '6rmA6rCA7IOB', 'giga1000mbps 010 1234 5678',
  ], '위장');
});

test('B7 알려진 탐지 한계(통과 아님 — 잔여 위험 기록용)', { todo: '규칙 기반 탐지로는 단서 없는 이름·주소, 긴 단어로 쪼갠 번호를 다 잡지 못한다' }, () => {
  for (const m of ['가상이가 신청했어요', '가상구 가상동 가상마을 앞집', '공 하고 일 하고 공 그다음 일이삼사 오육칠팔', '010 그다음에는 1234 마지막은 5678']) {
    assert.equal(prepareUserText(m).ok, false);
  }
});
