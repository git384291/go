// PM 11/21: 총판 전달용 신청서 순수 모듈 시험(항목·누락·민감정보 차단·자료 생성).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applicationSummary, neededFields, buildDealerPacket, DEALER_ONLY_ITEMS, missingApplication, nextQuestion, sensitiveReason, validateApplication } from '../../src/content/applicationForm';

const full = { carrier: 'carrier-x', productId: 'p1', regionCode: 'r1', installAddress: '서울시 가상구 시험로 12 101동 1203호', phoneCarrier: 'kt', email: 'test@example.com', currentCarrier: 'kt', installPref: 'asap', existingLine: 'has', ack12m: 'confirmed', ackContract3y: 'confirmed' };

test('AF1 필수 항목이 모두 있으면 누락 0, 하나 빠지면 그 키가 누락(빠진 일반 접수정보를 순서대로 다시 묻는다), 신청서가 없으면 전부 누락', () => {
  assert.deepEqual(missingApplication(full), []);
  assert.deepEqual(missingApplication({ ...full, email: undefined }), ['email']);
  assert.equal(missingApplication(null).length, 3 + neededFields(null).length);
  assert.equal(nextQuestion(null)?.key, 'installAddress');
  assert.equal(nextQuestion({ ...full, email: undefined, existingLine: undefined })?.key, 'email');
  assert.equal(nextQuestion({ ...full, existingLine: undefined })?.key, 'existingLine');
  assert.equal(nextQuestion({ ...full })?.key, 'housingType'); // 필수 뒤에 선택(참고) 항목
  assert.equal(nextQuestion({ ...full, housingType: 'apartment', subscriberType: 'self', tvCount: '1', memo: '문 앞' }), null);
  // 희망일 지정을 고르면 날짜가 필수로 바뀐다
  assert.deepEqual(missingApplication({ ...full, installPref: 'date' }), ['installDate']);
  assert.equal(nextQuestion({ ...full, installPref: 'date' })?.key, 'installDate');
  assert.deepEqual(missingApplication({ ...full, installPref: 'date', installDate: '2026-12-05' }), []);
});

test('AF2 검증: 알려진 키·문자열·선택 목록만, 빈 값은 없음, 길이 초과·알 수 없는 키·비문자열 거부', () => {
  assert.deepEqual(validateApplication({ ...full, memo: '  ' }), { ok: true, value: full });
  for (const bad of [null, [], 'x', { ...full, extra: 'x' }, { ...full, existingLine: 'maybe' }, { ...full, email: 'not-an-email' }, { ...full, installDate: '2026-02-30' }, { ...full, installAddress: 'x'.repeat(101) }, { ...full, installAddress: 'ab' }, { ...full, carrier: 'Bad Code' }, { ...full, tvCount: 2 }, { ...full, rrn: '900101-1234567' }, { ...full, account: '110-123-456789' }, { ...full, memo: 'a\nb' }]) {
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
  assert.equal(JSON.stringify(s).includes('example.com'), false);
  assert.equal(s.existingLine, 'has');
});

test('AF5 총판 전달 양식 출력: 지정 항목·순서, 주민번호·자동이체·사은품계좌는 총판 별도 확인, 승인 정책 값만 사용', () => {
  const quote = { kind: 'quote' as const, text: 'x', fields: { productLabel: '인터넷+TV 가상상품', monthlyFee: '11,111원(부가세 포함)', installFee: '0원(부가세 포함)', gift: '5,000원 상품권' } };
  const lead = { name: '김테스트', phone: '010-1111-2222', interest: 'internet_tv', contactTime: '평일 저녁', createdAt: '2026-11-22 09:00' };
  const p = buildDealerPacket({ lead, app: full, quote, noticeReady: true, generatedAt: '2026-11-22 10:00' });
  assert.equal(p.status, 'ready');
  assert.deepEqual(p.items.map((i) => i.label), ['고객명', '주민번호', '설치주소', '연락처 / 통신사', '이메일', '자동이체', '사은품계좌', '가입 통신사', '신청상품', '월요금', '설치비(기사출동비)', '설치희망일 / 빠른 날짜', '상품권', '이전통신사', '기타: 기존회선 12개월 유지 안내', '기존회선 확인', '약정 3년 및 설치비 안내·확인']);
  for (const l of ['주민번호', '자동이체', '사은품계좌']) assert.ok(p.text.includes(`■ ${l}: 총판 별도 확인`), l);
  assert.ok(p.text.includes('■ 연락처 / 통신사: 010-1111-2222 / KT') && p.text.includes('■ 월요금: 11,111원(부가세 포함)') && p.text.includes('■ 상품권: 5,000원 상품권') && p.text.includes('준비 완료'));
  // 필수 고지 확인이 끝나지 않으면 준비 완료 금지
  const n = buildDealerPacket({ lead, app: full, quote, noticeReady: false, generatedAt: 'x' });
  assert.equal(n.status, 'notice_pending');
  assert.ok(!n.text.includes('총판 전달 준비 완료') && n.text.includes('필수 고지 확인 미완료'));
  // 고객 정보 누락·정책 없음
  const q = buildDealerPacket({ lead, app: { ...full, email: undefined, ack12m: undefined }, quote: null, noticeReady: true, generatedAt: 'x' });
  assert.equal(q.status, 'incomplete');
  assert.deepEqual(q.missingLabels, ['이메일', '기존회선 12개월 유지 안내']);
  assert.ok(q.text.includes('누락 항목: 이메일, 기존회선 12개월 유지 안내') && q.text.includes('■ 월요금: 총판 확인') && !/\d원/.test(q.text.split('■ 월요금')[1].split('■ 설치희망일')[0]));
  assert.equal(buildDealerPacket({ lead, app: null, quote: null, noticeReady: true, generatedAt: 'x' }).status, 'incomplete');
});
