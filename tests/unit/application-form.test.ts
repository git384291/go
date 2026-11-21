// PM 11/21: 총판 전달용 신청서 순수 모듈 시험(항목·누락·민감정보 차단·자료 생성).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPLICATION_FIELDS, applicationSummary, buildDealerPacket, DEALER_ONLY_ITEMS, missingApplication, nextQuestion, sensitiveReason, validateApplication } from '../../src/content/applicationForm';

const full = { carrier: 'carrier-x', productId: 'p1', regionCode: 'r1', installAddress: '서울시 가상구 시험로 12 101동 1203호', housingType: 'apartment', subscriberType: 'self', currentCarrier: 'kt', installPref: 'asap' };

test('AF1 필수 항목이 모두 있으면 누락 0, 하나 빠지면 그 키가 누락, 신청서가 없으면 전부 누락', () => {
  assert.deepEqual(missingApplication(full), []);
  assert.deepEqual(missingApplication({ ...full, housingType: undefined }), ['housingType']);
  assert.equal(missingApplication(null).length, 3 + APPLICATION_FIELDS.filter((f) => f.required).length);
  assert.equal(nextQuestion(null)?.key, 'installAddress');
  assert.equal(nextQuestion({ ...full })?.key, 'tvCount');
  assert.equal(nextQuestion({ ...full, tvCount: '1', memo: '문 앞' }), null);
});

test('AF2 검증: 알려진 키·문자열·선택 목록만, 빈 값은 없음, 길이 초과·알 수 없는 키·비문자열 거부', () => {
  assert.deepEqual(validateApplication({ ...full, memo: '  ' }), { ok: true, value: full });
  for (const bad of [null, [], 'x', { ...full, extra: 'x' }, { ...full, housingType: 'castle' }, { ...full, installAddress: 'x'.repeat(101) }, { ...full, installAddress: 'ab' }, { ...full, carrier: 'Bad Code' }, { ...full, tvCount: 2 }, { ...full, memo: 'a\nb' }]) {
    assert.deepEqual(validateApplication(bad), { ok: false, code: 'APPLICATION_INVALID' }, JSON.stringify(bad));
  }
});

test('AF3 주민번호·계좌·카드·자동이체 표현은 어떤 글 항목에서도 저장 전에 거부(SENSITIVE_INPUT)', () => {
  for (const t of ['주민번호 900101-1234567', '9001011234567', '110-123-456789', '123456789012', '1234-5678-9012-3456', '국민 계좌 알려드릴게요', '자동이체로 할게요', '카드번호는', '비밀번호 1234']) {
    assert.deepEqual(validateApplication({ ...full, memo: t }), { ok: false, code: 'SENSITIVE_INPUT' }, t);
    assert.deepEqual(validateApplication({ ...full, installAddress: `서울시 ${t}` }), { ok: false, code: 'SENSITIVE_INPUT' }, t);
  }
  assert.equal(sensitiveReason('서울시 가상구 시험로 12 101동 1203호'), null);
  assert.equal(sensitiveReason('문 앞에 두세요 1층 현관'), null);
});

test('AF4 요약(평문 저장용)에는 주소·메모가 없고 범주형 값·누락 목록만 있다', () => {
  const s = applicationSummary({ ...full, memo: '문 앞' });
  assert.equal(JSON.stringify(s).includes('시험로'), false);
  assert.equal(JSON.stringify(s).includes('문 앞'), false);
  assert.deepEqual(s.missing, []);
  assert.equal(s.housingType, 'apartment');
});

test('AF5 총판 전달용 자료: 섹션·누락 표시·총판 별도 확인 항목(주민번호·자동이체·계좌) 포함, 승인 정책 문장만 사용', () => {
  const quote = { kind: 'quote' as const, text: '월 11,111원(승인 정책)' };
  const lead = { name: '김테스트', phone: '010-1111-2222', interest: 'internet_tv', contactTime: '평일 저녁', createdAt: '2026-11-22 09:00' };
  const p = buildDealerPacket({ lead, app: full, quote, generatedAt: '2026-11-22 10:00' });
  assert.equal(p.status, 'complete');
  assert.ok(p.text.includes('김테스트') && p.text.includes('시험로 12') && p.text.includes('아파트') && p.text.includes('월 11,111원(승인 정책)'));
  for (const d of DEALER_ONLY_ITEMS.slice(0, 3)) assert.ok(p.text.includes(d.label));
  assert.ok(p.text.includes('수집하지 않음'));
  const q = buildDealerPacket({ lead, app: { ...full, housingType: undefined, installPref: undefined }, quote: null, generatedAt: 'x' });
  assert.equal(q.status, 'incomplete');
  assert.deepEqual(q.missingLabels, ['주거 형태', '희망 설치 시기']);
  assert.ok(q.text.includes('누락 항목: 주거 형태, 희망 설치 시기') && q.text.includes('승인 정책 안내 없음'));
  assert.equal(buildDealerPacket({ lead, app: null, quote: null, generatedAt: 'x' }).status, 'incomplete');
});
