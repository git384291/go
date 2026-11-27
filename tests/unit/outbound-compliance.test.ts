// 코사장 11/27 광고성 전화 합법성 게이트(OB1~OB14). 순수 함수·닫힌 Mock만 — 실제 발신·두낫콜·통신사 연결 0회.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auditRecord, decideOutbound, planDialOrder, SuppressionList, withinCallingHours, OUTBOUND_RULES, type CallContext, type Target } from '../../src/server/outbound/compliance';
import { ClosedMockDialer, ClosedMockDnc, OutboundError, selectDncChecker, selectOutboundDialer } from '../../src/server/outbound/providers';

const H = (c: string) => c.repeat(64);
const NOON = new Date('2026-11-27T03:00:00Z'); // KST 12:00
const kst = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 27, h - 9, m));
const target = (o: Partial<Target> = {}): Target => ({
  phoneHmac: H('a'), source: { kind: 'customer_inquiry', recordId: 'lead-1', lawfulVerified: true, label: '홈페이지 상담 신청' },
  adConsent: null, attempts: 0, lastAttemptAt: null, ...o,
});
const consent = { explicit: true as const, channel: 'phone' as const, evidenceId: 'consent-1', at: new Date('2026-11-01T00:00:00Z'), withdrawnAt: null };
const ctx = (o: Partial<CallContext> = {}): CallContext => ({
  now: NOON, mode: 'live_agent', dialer: 'manual',
  seller: { telemarketingRegistered: true, registrationNo: '제2026-인천-0001호' },
  disclosure: { businessName: '바른365', purpose: '인터넷·TV 가입 안내', announcesSource: true },
  callerIdShown: true, businessNameShown: true, agentConnected: true, agentReserved: null,
  dnc: { result: 'clear', checkedAt: NOON }, internalOptOut: false, ...o,
});
const reasons = (t: Target, c: CallContext) => decideOutbound(t, c).reasons;

test('OB1 육성 예외: 모든 조건 확인 시에만 허용(근거 live_exception)', () => {
  assert.deepEqual(decideOutbound(target(), ctx()), { allowed: true, basis: 'live_exception', reasons: [] });
});

test('OB2 육성 예외: 조건 하나라도 미확인이면 차단(신고·고지·수집출처·상담원)', () => {
  const cases: [Partial<CallContext>, Partial<Target>, string][] = [
    [{ seller: { telemarketingRegistered: null, registrationNo: null } }, {}, 'NOT_REGISTERED'],
    [{ seller: { telemarketingRegistered: true, registrationNo: '' } }, {}, 'NOT_REGISTERED'],
    [{ disclosure: { businessName: '바른365', purpose: '안내', announcesSource: false } }, {}, 'DISCLOSURE_MISSING'],
    [{ disclosure: { businessName: '바른365', purpose: '', announcesSource: true } }, {}, 'DISCLOSURE_MISSING'],
    [{}, { source: { kind: 'customer_inquiry', recordId: 'x', lawfulVerified: false, label: 'x' } }, 'SOURCE_UNVERIFIED'],
    [{ agentConnected: null }, {}, 'AGENT_NOT_CONNECTED'],
    [{ agentConnected: false }, {}, 'AGENT_NOT_CONNECTED'],
  ];
  for (const [c, t, why] of cases) {
    const d = decideOutbound(target(t), ctx(c));
    assert.equal(d.allowed, false, why);
    assert.ok(d.reasons.includes(why as never), `${why} in ${d.reasons}`);
  }
});

test('OB3 두낫콜: 등록·미조회·조회 실패·24시간 지난 결과는 모두 차단(동의가 있어도)', () => {
  const old = new Date(NOON.getTime() - OUTBOUND_RULES.dncMaxAgeMs - 1);
  for (const [dnc, why] of [[{ result: 'listed', checkedAt: NOON }, 'DNC_LISTED'], [{ result: 'unknown', checkedAt: null }, 'DNC_UNCONFIRMED'],
    [{ result: 'error', checkedAt: NOON }, 'DNC_UNCONFIRMED'], [{ result: 'clear', checkedAt: old }, 'DNC_UNCONFIRMED'], [{ result: 'clear', checkedAt: null }, 'DNC_UNCONFIRMED']] as const) {
    assert.ok(reasons(target({ adConsent: consent }), ctx({ dnc })).includes(why), why);
  }
});

test('OB4 ARS 광고: 명시적 사전동의 증거만 허용, 육성 예외 적용 안 됨', () => {
  assert.deepEqual(reasons(target(), ctx({ mode: 'ars_ad' })), ['NO_PRIOR_CONSENT']);
  assert.deepEqual(decideOutbound(target({ adConsent: consent }), ctx({ mode: 'ars_ad', agentConnected: null })), { allowed: true, basis: 'consent', reasons: [] });
  assert.ok(reasons(target({ adConsent: { ...consent, evidenceId: '' } }), ctx({ mode: 'ars_ad' })).includes('NO_PRIOR_CONSENT'));
  assert.ok(reasons(target({ adConsent: { ...consent, withdrawnAt: NOON } }), ctx({ mode: 'ars_ad' })).includes('CONSENT_WITHDRAWN'));
});

test('OB5 PDS(예측발신): 상담원 예약 확인 + 육성 모드일 때만, ARS와 결합 불가', () => {
  assert.ok(reasons(target(), ctx({ dialer: 'pds', agentReserved: null })).includes('PDS_REQUIRES_AGENT'));
  assert.ok(reasons(target({ adConsent: consent }), ctx({ dialer: 'pds', mode: 'ars_ad', agentReserved: true })).includes('PDS_REQUIRES_AGENT'));
  assert.equal(decideOutbound(target(), ctx({ dialer: 'pds', agentReserved: true })).allowed, true);
});

test('OB6 번호 자동 생성·순차 생성·외부 목록 자동 등록·출처 불명은 항상 차단', () => {
  for (const kind of ['generated', 'sequential', 'external_auto_import', 'unknown'] as const) {
    const d = decideOutbound(target({ source: { kind, recordId: 'r', lawfulVerified: true, label: 'x' }, adConsent: consent }), ctx());
    assert.equal(d.allowed, false); assert.ok(d.reasons.includes('FORBIDDEN_SOURCE'), kind);
  }
});

test('OB7 발신 시간: KST 08:00~20:59만, 21:00·07:59 차단(야간 별도 동의 기능 없음)', () => {
  assert.equal(withinCallingHours(kst(8, 0)), true);
  assert.equal(withinCallingHours(kst(20, 59)), true);
  assert.equal(withinCallingHours(kst(21, 0)), false);
  assert.equal(withinCallingHours(kst(7, 59)), false);
  assert.ok(reasons(target({ adConsent: consent }), ctx({ now: kst(22), dnc: { result: 'clear', checkedAt: kst(22) } })).includes('NIGHT_BLOCKED'));
});

test('OB8 발신번호·상호 표시 필수', () => {
  assert.ok(reasons(target(), ctx({ callerIdShown: false })).includes('CALLER_ID_REQUIRED'));
  assert.ok(reasons(target(), ctx({ businessNameShown: false })).includes('CALLER_ID_REQUIRED'));
});

test('OB9 수신거부: 즉시·영구 차단(동의가 있어도), 해제 함수 없음', () => {
  const s = new SuppressionList();
  s.add(H('a'));
  assert.ok(reasons(target({ adConsent: consent }), ctx({ internalOptOut: s.has(H('a')) })).includes('OPTED_OUT'));
  assert.equal('remove' in s || 'delete' in s || 'clear' in s, false);
  assert.throws(() => s.add('01012345678'), /INVALID_INPUT/);
});

test('OB10 재시도 상한 3회·24시간 간격', () => {
  assert.ok(reasons(target({ attempts: 3 }), ctx()).includes('RETRY_LIMIT'));
  assert.ok(reasons(target({ attempts: 1, lastAttemptAt: new Date(NOON.getTime() - 3_600_000) }), ctx()).includes('RETRY_TOO_SOON'));
  assert.equal(decideOutbound(target({ attempts: 2, lastAttemptAt: new Date(NOON.getTime() - 25 * 3_600_000) }), ctx()).allowed, true);
});

test('OB11 무작위 순서: 입력 목록의 부분집합만(새 번호 0), 중복 1건, 판정 탈락 제외', () => {
  const list = [target({ phoneHmac: H('a') }), target({ phoneHmac: H('b') }), target({ phoneHmac: H('a') }), target({ phoneHmac: H('c'), attempts: 3 }), target({ phoneHmac: H('d') })];
  let seed = 7; const rng = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const out = planDialOrder(list, () => ctx(), rng);
  assert.deepEqual(out.map((t) => t.phoneHmac).sort(), [H('a'), H('b'), H('d')].sort());
  for (const t of out) assert.ok(list.includes(t), '입력 객체 그대로(생성 없음)');
});

test('OB12 감사 기록: 연락처 HMAC·사유만, 전화번호 원문·이름 없음', () => {
  const t = target(); const c = ctx({ agentConnected: null }); const a = auditRecord(t, c, decideOutbound(t, c));
  const s = JSON.stringify(a);
  assert.equal(/01[016789]-?\d{3,4}-?\d{4}/.test(s), false);
  assert.deepEqual(Object.keys(a).sort(), ['allowed', 'at', 'basis', 'dialer', 'mode', 'phoneHmac', 'reasons']);
  assert.equal(a.allowed, false);
});

test('OB13 연동: live 선택은 LIVE_OUTBOUND_NOT_APPROVED, 기본은 닫힌 Mock(외부 호출 0)', async () => {
  for (const env of [{ OUTBOUND_DNC_MODE: 'live' }, { OUTBOUND_DNC_MODE: 'kisa' }]) assert.throws(() => selectDncChecker(env), (e: unknown) => e instanceof OutboundError && e.code === 'LIVE_OUTBOUND_NOT_APPROVED');
  for (const env of [{ OUTBOUND_DIAL_MODE: 'live' }, { OUTBOUND_DIAL_MODE: 'twilio' }]) assert.throws(() => selectOutboundDialer(env), (e: unknown) => e instanceof OutboundError && e.code === 'LIVE_OUTBOUND_NOT_APPROVED');
  assert.ok(selectDncChecker({}) instanceof ClosedMockDnc);
  assert.ok(selectOutboundDialer({}) instanceof ClosedMockDialer);
  const dnc = new ClosedMockDnc({ [H('a')]: 'clear', [H('b')]: 'listed', [H('c')]: 'error' });
  assert.equal((await dnc.check(H('a'), NOON)).result, 'clear');
  assert.equal((await dnc.check(H('b'), NOON)).result, 'listed');
  assert.equal((await dnc.check(H('c'), NOON)).result, 'error');
  assert.equal((await dnc.check(H('e'), NOON)).result, 'unknown', '정하지 않은 번호는 미확인 = 차단');
});

test('OB14 코드 금지 점검: 모듈에 번호 생성·외부 호출·실제 발신 코드가 없음', () => {
  for (const f of ['src/server/outbound/compliance.ts', 'src/server/outbound/providers.ts']) {
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.equal(/\bfetch\(|https?:\/\/|node:(http|https|net|tls)|child_process|padStart|010\d|randomInt/.test(src), false, f);
  }
});
