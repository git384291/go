// PM 6907697718 A: 상담 폼 보조 모듈(필드 검증·요청 키 계약·응답 분류). 가상 값만 쓴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyResponse,
  firstErrorField,
  FIELD_MESSAGES,
  IdempotencyKeeper,
  NETWORK_FAILURE,
  normalizePhoneDigits,
  OUTCOME_MESSAGES,
  readResponseBody,
  submissionFingerprint,
  validateConsultInput,
  type ConsultInput,
} from '../../src/components/consultSubmit';
import { normalizeMobile } from '../../src/server/security/piiCrypto';

const ok: ConsultInput = { name: '테스트', phone: '010-0000-0001', interest: 'internet_tv', contactTime: '', consent: true, marketing: false };

test('C1 필드 검증: 필수·형식·동의를 필드별로, 화면 순서대로 첫 오류', () => {
  assert.deepEqual(validateConsultInput(ok), {});
  const e = validateConsultInput({ ...ok, name: ' ', phone: '', consent: false });
  assert.deepEqual(e, { name: FIELD_MESSAGES.NAME_REQUIRED, phone: FIELD_MESSAGES.PHONE_REQUIRED, consent: FIELD_MESSAGES.CONSENT_REQUIRED });
  assert.equal(firstErrorField(e), 'name');
  assert.equal(firstErrorField({ consent: 'x', phone: 'y' }), 'phone');
  assert.equal(validateConsultInput({ ...ok, name: '홍길동1' }).name, FIELD_MESSAGES.NAME_FORMAT);
  assert.equal(validateConsultInput({ ...ok, name: '가'.repeat(21) }).name, FIELD_MESSAGES.NAME_FORMAT);
  assert.equal(validateConsultInput({ ...ok, phone: '02-123-4567' }).phone, FIELD_MESSAGES.PHONE_FORMAT);
  assert.equal(validateConsultInput({ ...ok, phone: '010-12' }).phone, FIELD_MESSAGES.PHONE_FORMAT);
});

test('C2 번호 정규화는 서버 normalizeMobile과 같은 판정', () => {
  for (const p of ['010-0000-0001', '01000000001', '+82 10 0000 0001', '011-000-0001', '019 0000 0001', '02-123-4567', '010-12', 'abc', '', '010-0000-00011', '+8210000000012']) {
    let server: string | null;
    try {
      server = normalizeMobile(p);
    } catch {
      server = null;
    }
    assert.equal(normalizePhoneDigits(p), server, p);
  }
});

test('C3 요청 키: 같은 내용 재시도 = 같은 키, 내용이 바뀌면 새 키, 되돌려도 직전과 다르면 새 키', () => {
  let n = 0;
  const k = new IdempotencyKeeper(() => `key-${++n}`);
  const fp = (i: ConsultInput) => submissionFingerprint(i, 'v1');
  const a = k.keyFor(fp(ok));
  assert.equal(k.keyFor(fp(ok)), a, '응답 유실 뒤 같은 내용 재시도');
  assert.equal(k.keyFor(fp({ ...ok, phone: '01000000001' })), a, '번호 표기만 다름(같은 번호) → 같은 내용');
  assert.equal(k.keyFor(fp({ ...ok, name: ' 테스트 ' })), a, '앞뒤 공백만 다름 → 같은 내용');
  const b = k.keyFor(fp({ ...ok, phone: '010-0000-0002' }));
  assert.notEqual(b, a, '번호 변경');
  const c = k.keyFor(fp({ ...ok, phone: '010-0000-0002', contactTime: '저녁' }));
  assert.notEqual(c, b, '연락 시간 변경');
  assert.notEqual(k.keyFor(fp({ ...ok, phone: '010-0000-0002', contactTime: '저녁', marketing: true })), c, '선택 동의 변경');
  assert.notEqual(k.keyFor(submissionFingerprint(ok, 'v2')), a, '처리방침 버전 변경');
  assert.notEqual(k.keyFor(fp(ok)), a, '이전 내용으로 되돌려도 직전 시도와 다르면 새 키');
});

test('C4 응답 분류: 202만 접수, 허용 목록 코드만 고정 문구, 목록 밖·원문은 반사 안 함', () => {
  assert.equal(classifyResponse(202, null).kind, 'accepted');
  assert.equal(classifyResponse(202, { ok: false, code: 'X' }).kind, 'accepted', '202는 본문과 관계없이 신규·중복 구분 없는 접수');
  assert.equal(classifyResponse(200, { ok: true }).kind, 'unknown', '202가 아닌 2xx는 접수로 보지 않음(결과 미확인)');
  const table: [number, string, string, string?][] = [
    [400, 'INVALID_PHONE', 'field', 'phone'],
    [400, 'CONSENT_REQUIRED', 'field', 'consent'],
    [400, 'INVALID_INPUT', 'input'],
    [400, 'CONSENT_VERSION_MISMATCH', 'consent_version'],
    [429, 'RATE_LIMITED', 'rate'],
    [403, 'BOT_SUSPECTED', 'bot'],
    [503, 'BOT_CHECK_UNAVAILABLE', 'temporary'],
    [503, 'SERVICE_NOT_READY', 'not_ready'],
    [503, 'LEAD_INTAKE_DISABLED', 'not_ready'],
    [403, 'PRODUCT_NOT_ACTIVE', 'not_ready'],
    [500, 'INTERNAL', 'unknown'],
  ];
  for (const [status, code, kind, field] of table) {
    const o = classifyResponse(status, { ok: false, code });
    assert.equal(o.kind, kind, code);
    assert.equal(o.field, field, code);
  }
  const allowed = new Set<string>([...Object.values(OUTCOME_MESSAGES), ...Object.values(FIELD_MESSAGES)]);
  const hostile = ['<img src=x onerror=alert(1)>', 'toString', '__proto__', 'constructor', 'DB error: relation pii.customers', '010-1234-5678'];
  for (const code of hostile) {
    for (const status of [400, 403, 429, 500, 503, 418]) {
      const o = classifyResponse(status, { ok: false, code, message: code });
      assert.ok(allowed.has(o.message), `${status} ${code}`);
      assert.ok(!o.message.includes(code), `${status} ${code} 반사`);
    }
  }
  for (const body of [null, 'INVALID_PHONE', ['INVALID_PHONE'], 1, { code: 1 }]) {
    assert.equal(classifyResponse(400, body).kind, 'unknown', JSON.stringify(body));
  }
  assert.equal(classifyResponse(429, null).kind, 'rate');
  assert.equal(classifyResponse(503, null).kind, 'not_ready');
  // 응답 유실·해석 불가는 '접수되지 않았습니다'라고 단정하지 않는다(PM 6908334832 4항)
  assert.equal(NETWORK_FAILURE.kind, 'unknown');
  assert.ok(NETWORK_FAILURE.message.includes('확인하지 못했습니다') && !NETWORK_FAILURE.message.includes('접수되지 않았'));
  assert.ok(!classifyResponse(502, '<html>bad gateway</html>').message.includes('접수되지 않았'));
  for (const m of Object.values(OUTCOME_MESSAGES)) assert.ok(!/개통|가입 완료|확정|분 안에|오늘 중/.test(m), `과장 약속 금지: ${m}`);
});

test('C5 응답 본문 읽기: JSON만, 과대·깨진 본문은 무시', async () => {
  const j = (t: string, type = 'application/json') => new Response(t, { headers: { 'content-type': type } });
  assert.deepEqual(await readResponseBody(j('{"ok":false,"code":"RATE_LIMITED"}')), { ok: false, code: 'RATE_LIMITED' });
  assert.equal(await readResponseBody(j('<html>err</html>', 'text/html')), null);
  assert.equal(await readResponseBody(j('{broken')), null);
  assert.equal(await readResponseBody(j(JSON.stringify({ code: 'x'.repeat(3000) }))), null);
});
