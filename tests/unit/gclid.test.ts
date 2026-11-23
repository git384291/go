// 광고 사전검증 8번: gclid 수집(화면) → 접수 요청 → 서버 서명(0027 api.lead_gclid_attach)까지. 가상 값만, Google 전송 없음.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATTRIBUTION_STORAGE_KEY, cleanGclid, parseAttribution, resolveAttribution } from '../../src/content/attribution';
import { buildCreateLeadArgs, leadSignedFields, noticeHashes } from '../../src/server/leads/intake';
import { createPiiCrypto } from '../../src/server/security/piiCrypto';
import { signToken } from '../../src/server/security/token';

const G1 = 'Cj0KCQiA_firstClick-001';
const G2 = 'Cj0KCQiA_secondClick-02';
const mem = () => { const m = new Map<string, string>(); return { m, store: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } } }; };

test('GT1 수집: 자동 태그(gclid만)도 읽고, utm과 함께 오면 둘 다 유지', () => {
  assert.deepEqual(parseAttribution(`?gclid=${G1}`), { gclid: G1 });
  assert.deepEqual(parseAttribution(`?utm_source=google&utm_medium=cpc&utm_campaign=move-2611&gclid=${G1}`),
    { utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'move-2611', gclid: G1 });
  assert.deepEqual(parseAttribution('?utm_source=naver'), { utmSource: 'naver' }, 'gclid 없으면 기존 결과 그대로');
});

test('GT2 형식 검증: 짧음·스크립트·전화번호·숫자 9자리 연속·201자·공백·한글·중복 파라미터는 버림(접수는 계속)', () => {
  for (const bad of ['Abc123', '<script>alert(1)</script>', '01012345678', 'Cj0K_010123456789_x', 'Ab'.repeat(100) + 'X', 'Cj0KCQiA first', 'Cj0KCQiA_한글값입니다', '__________', '']) {
    assert.equal(cleanGclid(bad), undefined, JSON.stringify(bad));
    assert.deepEqual(parseAttribution(`?gclid=${encodeURIComponent(bad)}`), {}, JSON.stringify(bad));
  }
  assert.deepEqual(parseAttribution(`?gclid=${G1}&gclid=${G2}`), {}, '중복 파라미터는 모호 → 버림');
  assert.deepEqual(parseAttribution(`?utm_source=google&gclid=${G1}&gclid=${G2}`), { utmSource: 'google' }, '중복 gclid만 버리고 utm은 유지');
  assert.equal(cleanGclid('A'.repeat(200)), 'A'.repeat(200), '200자 경계 허용');
  assert.equal(cleanGclid(12345678901 as unknown), undefined);
});

test('GT3 첫 유입 보존: 저장 → 새로고침 유지 → 같은 세션 두 번째 클릭은 첫 값 유지 → 새 세션(재방문)은 새 값', () => {
  const s = mem();
  assert.equal(resolveAttribution(`?gclid=${G1}`, s.store).gclid, G1);
  assert.equal(JSON.parse(s.m.get(ATTRIBUTION_STORAGE_KEY)!).gclid, G1, '저장됨');
  assert.equal(resolveAttribution(`?gclid=${G1}`, s.store).gclid, G1, '새로고침');
  assert.equal(resolveAttribution('', s.store).gclid, G1, '다른 페이지 이동(주소에 gclid 없음)');
  assert.equal(resolveAttribution(`?gclid=${G2}`, s.store).gclid, G1, '같은 세션 두 번째 광고 클릭 → 첫 값');
  const s2 = mem();
  assert.equal(resolveAttribution(`?gclid=${G2}`, s2.store).gclid, G2, '새 세션(재방문)은 새 클릭 값');
});

test('GT4 UTM 규칙은 그대로: 저장된 출처 우선, gclid는 나중에 와도 따로 보존', () => {
  const s = mem();
  assert.deepEqual(resolveAttribution('?utm_source=naver&utm_medium=cpc', s.store), { utmSource: 'naver', utmMedium: 'cpc' });
  assert.deepEqual(resolveAttribution(`?utm_source=google&gclid=${G1}`, s.store), { utmSource: 'naver', utmMedium: 'cpc', gclid: G1 });
  assert.deepEqual(resolveAttribution('', s.store), { utmSource: 'naver', utmMedium: 'cpc', gclid: G1 });
});

test('GT5 변조된 저장값·저장소 장애: 형식 밖 gclid는 무시, 저장 실패해도 현재 값으로 동작', () => {
  const s = mem();
  s.m.set(ATTRIBUTION_STORAGE_KEY, JSON.stringify({ utmSource: 'naver', gclid: '<script>' }));
  assert.deepEqual(resolveAttribution(`?gclid=${G1}`, s.store), { utmSource: 'naver', gclid: G1 });
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.deepEqual(resolveAttribution(`?gclid=${G1}`, broken), { gclid: G1 });
  assert.deepEqual(resolveAttribution(`?gclid=${G1}`, null), { gclid: G1 });
});

// ───── 서버: 접수 요청 → 서명된 gclid 인자 ─────
const ctx = {
  crypto: createPiiCrypto({ encKeys: { '1': Buffer.alloc(32, 1) }, currentVersion: '1', hmacKey: Buffer.alloc(32, 3), ipHashKey: Buffer.alloc(32, 4) }),
  signingKey: { keyId: 1, secret: Buffer.alloc(32, 0x22) },
  currentPrivacyVersion: 'privacy-test-v1',
  clientIp: '203.0.113.10',
  nowSeconds: 1_800_000_000,
  notices: { version: 'privacy-test-v1', confirmed: true, items: [{ key: 'n1', title: '시험 고지', body: '시험용 문구' }] },
};
const body = {
  name: '테스트고객', phone: '010-0000-0001', interest: 'internet_tv', contactTime: '평일 저녁', consentCollection: true, marketingOptIn: false,
  privacyVersion: 'privacy-test-v1', noticeVersion: 'privacy-test-v1', noticeKeys: ['n1'], noticeHashes: noticeHashes(ctx.notices),
  idempotencyKey: 'gclid-test-request-key-0001', utmSource: 'google',
};

test('GT6 서버: gclid가 오면 [gclid, 요청 키, 연락처 HMAC, gclid] 서명 인자를 만든다(DB 0027과 같은 순서)', () => {
  const a = buildCreateLeadArgs({ ...body, gclid: G1 }, ctx);
  const g = a.gclid;
  if (!g) throw new Error('gclid 인자 없음');
  assert.equal(g.gclid, G1);
  assert.equal(g.idempotencyKey, body.idempotencyKey);
  assert.equal(g.phoneHmac, a.phoneHmac);
  assert.equal(g.token, signToken('lead', ['gclid', body.idempotencyKey, a.phoneHmac, G1], ctx.signingKey, ctx.nowSeconds));
  assert.notEqual(g.token, signToken('lead', ['gclid', body.idempotencyKey, a.phoneHmac, G2], ctx.signingKey, ctx.nowSeconds), '값이 바뀌면 서명도 다름');
});

test('GT7 서버: create_lead 서명 필드는 바뀌지 않는다(본문 고정 함수 호환), gclid 유무와 무관', () => {
  const { token: t1, gclid: _g, ...r1 } = buildCreateLeadArgs({ ...body, gclid: G1 }, ctx);
  const { token: t2, ...r2 } = buildCreateLeadArgs(body, ctx);
  assert.equal(t1, t2);
  assert.deepEqual(leadSignedFields(r1), leadSignedFields(r2));
  assert.equal(_g?.gclid, G1);
});

test('GT8 서버: 형식 밖 gclid는 버리고 접수는 계속(오류 아님), 200자 초과 문자열은 입력 오류', () => {
  for (const bad of ['<script>', '01012345678', 'Abc123', 'Cj0KCQiA first']) {
    const a = buildCreateLeadArgs({ ...body, gclid: bad }, ctx);
    assert.equal(a.gclid, undefined, bad);
    assert.ok(a.token);
  }
  assert.throws(() => buildCreateLeadArgs({ ...body, gclid: 'A'.repeat(201) }, ctx));
  assert.throws(() => buildCreateLeadArgs({ ...body, gclid: 123 }, ctx));
});
