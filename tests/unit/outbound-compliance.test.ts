// 코사장 11/27 광고성 전화 합법성 게이트(OB1~OB14). 순수 함수·닫힌 Mock만 — 실제 발신·두낫콜·통신사 연결 0회.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { auditRecord, decideOutbound, planDialOrder, withinCallingHours, OUTBOUND_RULES, type CallContext, type Target } from '../../src/server/outbound/compliance';
import { ClosedMockDialer, ClosedMockDnc, ClosedMockSuppressionStore, OutboundError, placeOutboundCall, selectDncChecker, selectOutboundDialer, selectSuppressionStore } from '../../src/server/outbound/providers';

const H = (c: string) => c.repeat(64);
const NOON = new Date('2026-11-27T03:00:00Z'); // KST 12:00
const kst = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 27, h - 9, m));
const target = (o: Partial<Target> = {}): Target => ({
  phoneHmac: H('a'), source: { kind: 'customer_inquiry', recordId: 'lead-1', lawfulVerified: true, label: '홈페이지 상담 신청' },
  adConsent: null, attempts: 0, lastAttemptAt: null, ...o,
});
const consent = { explicit: true as const, channel: 'phone' as const, evidenceId: 'consent-1', purposeId: 'ad-internet-tv', granteeBusinessId: 'bareun365', at: new Date('2026-11-01T00:00:00Z'), withdrawnAt: null };
const ctx = (o: Partial<CallContext> = {}): CallContext => ({
  now: NOON, mode: 'live_agent', dialer: 'manual', purposeId: 'ad-internet-tv', businessId: 'bareun365',
  seller: { telemarketingRegistered: true, registrationNo: '제2026-인천-0001호' },
  disclosure: { businessName: '바른365', purpose: '인터넷·TV 가입 안내', announcesSource: true },
  callerIdShown: true, businessNameShown: true, humanAgentReady: true, agentReserved: null,
  dnc: { result: 'clear', checkedAt: NOON }, suppression: { result: 'clear', checkedAt: NOON }, ...o,
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
    [{ humanAgentReady: null }, {}, 'AGENT_NOT_READY'],
    [{ humanAgentReady: false }, {}, 'AGENT_NOT_READY'],
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
  assert.deepEqual(decideOutbound(target({ adConsent: consent }), ctx({ mode: 'ars_ad', humanAgentReady: null })), { allowed: true, basis: 'consent', reasons: [] });
  assert.ok(reasons(target({ adConsent: { ...consent, evidenceId: '' } }), ctx({ mode: 'ars_ad' })).includes('NO_PRIOR_CONSENT'));
  assert.ok(reasons(target({ adConsent: { ...consent, withdrawnAt: NOON } }), ctx({ mode: 'ars_ad' })).includes('CONSENT_WITHDRAWN'));
});

test('OB4-1 전화권유판매업 신고는 동의·ARS 여부와 무관하게 운영 전 필수(예외는 법률 자문 전 미개방)', () => {
  for (const mode of ['live_agent', 'ars_ad'] as const) {
    const d = decideOutbound(target({ adConsent: consent }), ctx({
      mode,
      seller: { telemarketingRegistered: false, registrationNo: null },
      humanAgentReady: mode === 'live_agent' ? true : null,
    }));
    assert.equal(d.allowed, false, mode);
    assert.ok(d.reasons.includes('NOT_REGISTERED'), mode);
  }
});

test('OB5 PDS(예측발신): 상담원 예약 확인 + 육성 모드일 때만, ARS와 결합 불가', () => {
  assert.ok(reasons(target(), ctx({ dialer: 'pds', agentReserved: null })).includes('PDS_REQUIRES_AGENT'));
  assert.ok(reasons(target({ adConsent: consent }), ctx({ dialer: 'pds', mode: 'ars_ad', agentReserved: true })).includes('PDS_REQUIRES_AGENT'));
  assert.equal(decideOutbound(target(), ctx({ dialer: 'pds', agentReserved: true })).allowed, true);
});

test('OB6 번호 자동 생성·순차 생성·외부 목록 자동 등록·출처 불명은 항상 차단', () => {
  for (const kind of ['generated', 'sequential', 'external_auto_import', 'unknown', 'scraped', 'purchased_list', ''] as never[]) {
    const d = decideOutbound(target({ source: { kind, recordId: 'r', lawfulVerified: true, label: 'x' }, adConsent: consent }), ctx());
    assert.equal(d.allowed, false); assert.ok(d.reasons.includes('FORBIDDEN_SOURCE'), kind);
  }
});

test('OB7 발신 시간: KST 08:00~20:59만, 21:00·07:59 차단(야간 별도 동의 기능 없음)', () => {
  assert.equal(withinCallingHours(kst(8, 0)), true);
  assert.equal(withinCallingHours(kst(20, 59)), true);
  assert.equal(withinCallingHours(kst(21, 0)), false);
  assert.equal(withinCallingHours(kst(7, 59)), false);
  assert.ok(reasons(target({ adConsent: consent }), ctx({ now: kst(22), dnc: { result: 'clear', checkedAt: kst(22) }, suppression: { result: 'clear', checkedAt: kst(22) } })).includes('NIGHT_BLOCKED'));
});

test('OB8 발신번호·상호 표시 필수', () => {
  assert.ok(reasons(target(), ctx({ callerIdShown: false })).includes('CALLER_ID_REQUIRED'));
  assert.ok(reasons(target(), ctx({ businessNameShown: false })).includes('CALLER_ID_REQUIRED'));
});

test('OB9 내부 수신거부: 저장소 조회 결과만 믿음 — 차단·미확인·오류·5분 지난 조회는 모두 차단(동의가 있어도)', () => {
  const old = new Date(NOON.getTime() - OUTBOUND_RULES.suppressionMaxAgeMs - 1);
  for (const [sup, why] of [[{ result: 'blocked', checkedAt: NOON }, 'OPTED_OUT'], [{ result: 'unknown', checkedAt: null }, 'SUPPRESSION_UNCONFIRMED'],
    [{ result: 'error', checkedAt: NOON }, 'SUPPRESSION_UNCONFIRMED'], [{ result: 'clear', checkedAt: old }, 'SUPPRESSION_UNCONFIRMED'], [{ result: 'clear', checkedAt: null }, 'SUPPRESSION_UNCONFIRMED']] as const) {
    const d = decideOutbound(target({ adConsent: consent }), ctx({ suppression: sup }));
    assert.equal(d.allowed, false); assert.ok(d.reasons.includes(why), why);
  }
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
  const t = target(); const c = ctx({ humanAgentReady: null }); const a = auditRecord(t, c, decideOutbound(t, c));
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

test('OB15 런타임 형태 검사: 누락·잘못된 객체·Invalid Date·잘못된 lastAttemptAt은 예외 없이 INVALID_INPUT', () => {
  const bad: [unknown, unknown][] = [
    [null, ctx()], [target(), null], [target(), { ...ctx(), dnc: undefined }], [target(), { ...ctx(), seller: undefined }],
    [target(), { ...ctx(), disclosure: null }], [target(), { ...ctx(), suppression: undefined }], [target(), { ...ctx(), now: new Date('x') }],
    [target(), { ...ctx(), dnc: { result: 'clear', checkedAt: new Date('x') } }], [target(), { ...ctx(), dnc: { result: 'maybe', checkedAt: NOON } }],
    [target(), { ...ctx(), mode: 'robocall' }], [target(), { ...ctx(), purposeId: undefined }], [target(), { ...ctx(), callerIdShown: 'yes' }],
    [target({ lastAttemptAt: new Date('x') }), ctx()], [target({ lastAttemptAt: '2026-11-01' as never }), ctx()],
    [target({ attempts: 1.5 }), ctx()], [target({ attempts: -1 }), ctx()], [target({ source: undefined as never }), ctx()],
    [target({ adConsent: { ...consent, at: new Date('x') } }), ctx()], [target({ adConsent: 'yes' as never }), ctx()], [{ ...target(), phoneHmac: '01012345678' }, ctx()],
  ];
  for (const [t, c] of bad) {
    let d; assert.doesNotThrow(() => { d = decideOutbound(t as Target, c as CallContext); });
    assert.deepEqual(d, { allowed: false, basis: null, reasons: ['INVALID_INPUT'] }, JSON.stringify(c && (c as CallContext).mode));
  }
  assert.doesNotThrow(() => auditRecord(null as never, { now: new Date('x') } as never, { allowed: false, basis: null, reasons: ['INVALID_INPUT'] }));
});

test('OB16 사전동의: 미래 시각·목적 불일치·사업자 불일치는 근거가 되지 않음(ARS·consent 모두)', () => {
  const future = { ...consent, at: new Date(NOON.getTime() + 60_000) };
  assert.ok(reasons(target({ adConsent: future }), ctx({ mode: 'ars_ad' })).includes('NO_PRIOR_CONSENT'));
  for (const c of [{ ...consent, purposeId: 'ad-mobile' }, { ...consent, granteeBusinessId: 'other-dealer' }, { ...consent, purposeId: '' }]) {
    const d = decideOutbound(target({ adConsent: c }), ctx({ mode: 'ars_ad' }));
    assert.equal(d.allowed, false); assert.ok(d.reasons.includes('CONSENT_SCOPE_MISMATCH') && d.reasons.includes('NO_PRIOR_CONSENT'));
  }
  const live = decideOutbound(target({ adConsent: { ...consent, granteeBusinessId: 'other' } }), ctx());
  assert.equal(live.allowed, false, '범위 불일치 동의는 육성 예외로 넘어가도 차단 사유가 남음');
  assert.ok(live.reasons.includes('CONSENT_SCOPE_MISMATCH'));
});

test('OB17 오케스트레이터: 발신 직전 두낫콜·수신거부를 새로 조회해 판정, 통과 시에만 dial(호출자 값 무시)', async () => {
  const dialer = new ClosedMockDialer(); const sup = new ClosedMockSuppressionStore();
  const dnc = new ClosedMockDnc({ [H('a')]: 'clear', [H('b')]: 'listed', [H('c')]: 'clear' });
  const { dnc: _d, suppression: _s, now: _n, ...base } = ctx();
  void _d; void _s; void _n;
  const clock = () => NOON;
  const ok = await placeOutboundCall({ dnc, suppression: sup, dialer, clock }, target({ phoneHmac: H('a') }), base);
  assert.equal(ok.decision.allowed, true); assert.equal(ok.callId, 'mock-1');
  const listed = await placeOutboundCall({ dnc, suppression: sup, dialer, clock }, target({ phoneHmac: H('b') }), { ...base, dnc: { result: 'clear', checkedAt: NOON } } as never);
  assert.equal(listed.callId, null); assert.ok(listed.decision.reasons.includes('DNC_LISTED'), '호출자가 넣은 clear를 무시');
  await sup.block(H('c'), NOON);
  const blocked = await placeOutboundCall({ dnc, suppression: sup, dialer, clock }, target({ phoneHmac: H('c') }), base);
  assert.ok(blocked.decision.reasons.includes('OPTED_OUT')); assert.equal(blocked.callId, null);
  const failing = await placeOutboundCall({ dnc, suppression: new ClosedMockSuppressionStore(true), dialer, clock }, target({ phoneHmac: H('a') }), base);
  assert.ok(failing.decision.reasons.includes('SUPPRESSION_UNCONFIRMED'));
  const throwing = await placeOutboundCall({ dnc: { name: 'x', check: async () => { throw new Error('down'); } }, suppression: sup, dialer, clock }, target({ phoneHmac: H('a') }), base);
  assert.ok(throwing.decision.reasons.includes('DNC_UNCONFIRMED'));
  assert.equal(dialer.placed.length, 1, '실제 발신 기록은 통과 1건뿐(비용 0 Mock)');
  assert.equal(sup.persistent, false, '지속 저장 아님(미완료)');
  assert.throws(() => selectSuppressionStore({ OUTBOUND_SUPPRESSION_MODE: 'db' }), (e: unknown) => e instanceof OutboundError && e.code === 'LIVE_OUTBOUND_NOT_APPROVED');
});

test('OB-ORCH 발신 경계: src 전체에서 .dial( 호출은 placeOutboundCall(providers.ts) 한 곳뿐', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const f = `${d}/${n}`; return statSync(f).isDirectory() ? walk(f) : [f]; });
  const hits = walk('src').filter((f) => /\.(ts|tsx)$/.test(f)).flatMap((f) => {
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    return [...src.matchAll(/\.dial\(/g)].map(() => f);
  });
  assert.deepEqual(hits, ['src/server/outbound/providers.ts']);
});

test('OB18 시각 위조 불가: base.now(낮)를 넣어도 서버 Clock(밤 22시)으로 판정·조회·감사', async () => {
  const night = kst(22);
  const dialer = new ClosedMockDialer();
  const seen: Date[] = [];
  const dnc = { name: 'spy', check: async (_h: string, now: Date) => { seen.push(now); return { result: 'clear' as const, checkedAt: now }; } };
  const { dnc: _d, suppression: _s, ...withNow } = ctx({ now: NOON }); void _d; void _s;
  const r = await placeOutboundCall({ dnc, suppression: new ClosedMockSuppressionStore(), dialer, clock: () => night }, target(), withNow as never);
  assert.equal(r.decision.allowed, false); assert.ok(r.decision.reasons.includes('NIGHT_BLOCKED'));
  assert.equal(r.audit.at, night.toISOString()); assert.deepEqual(seen, [night]); assert.equal(dialer.placed.length, 0);
});

test('OB19 placeOutboundCall은 예외 없음: null·형태 불량·동기 throw 조회·발신 실패를 차단 결과로 반환', async () => {
  const { dnc: _d, suppression: _s, now: _n, ...base } = ctx(); void _d; void _s; void _n;
  const clock = () => NOON;
  const good = { dnc: new ClosedMockDnc({ [H('a')]: 'clear' }), suppression: new ClosedMockSuppressionStore(), dialer: new ClosedMockDialer(), clock };
  for (const [deps, t] of [[null, target()], [{ ...good, dnc: null }, target()], [good, null], [good, { phoneHmac: 'x' }], [{ ...good, clock: () => { throw new Error('clock'); } }, target()]] as const) {
    const r = await placeOutboundCall(deps as never, t as never, base);
    assert.deepEqual(r.decision.reasons, ['INVALID_INPUT']); assert.equal(r.callId, null);
  }
  const syncThrow = { ...good, dnc: { name: 'x', check: (() => { throw new Error('sync'); }) as never } };
  const r1 = await placeOutboundCall(syncThrow, target(), base);
  assert.ok(r1.decision.reasons.includes('DNC_UNCONFIRMED')); assert.equal(r1.callId, null);
  const syncSup = { ...good, suppression: { name: 'x', persistent: false, check: (() => { throw new Error('sync'); }) as never, block: async () => {} } };
  assert.ok((await placeOutboundCall(syncSup, target(), base)).decision.reasons.includes('SUPPRESSION_UNCONFIRMED'));
  const failDial = { ...good, dialer: { name: 'x', dial: (() => { throw new Error('carrier'); }) as never } };
  const r2 = await placeOutboundCall(failDial, target(), base);
  assert.equal(r2.decision.allowed, true); assert.equal(r2.callId, null); assert.equal(r2.error, 'DIAL_FAILED');
});

test('OB20 dial 계약: live_agent 요청에 mode 전달(자동음성 금지·사람 상담원만), 사람 상담원 미배정이면 발신 안 함', async () => {
  const { dnc: _d, suppression: _s, now: _n, ...base } = ctx(); void _d; void _s; void _n;
  const dialer = new ClosedMockDialer(); const clock = () => NOON;
  const deps = { dnc: new ClosedMockDnc({ [H('a')]: 'clear' }), suppression: new ClosedMockSuppressionStore(), dialer, clock };
  await placeOutboundCall(deps, target(), base);
  assert.deepEqual(dialer.placed.map((p) => p.mode), ['live_agent']);
  const r = await placeOutboundCall(deps, target(), { ...base, humanAgentReady: false });
  assert.ok(r.decision.reasons.includes('AGENT_NOT_READY')); assert.equal(dialer.placed.length, 1);
  const pds = await placeOutboundCall(deps, target(), { ...base, dialer: 'pds', agentReserved: null });
  assert.ok(pds.decision.reasons.includes('PDS_REQUIRES_AGENT'));
  const src = readFileSync('src/server/outbound/providers.ts', 'utf8');
  assert.match(src, /자동 음성 재생 금지/); assert.match(src, /사람 상담원에게만 연결/);
});
