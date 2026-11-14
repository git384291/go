// PHASE 1: 상품 상태(코드) · 예약 상품 차단 · 코드 ↔ DB 기준값 일치
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { ACTIVE_INTERESTS, CATALOG, fixedConsultInterest, isActiveInterest } from '../../src/content/catalog';
import { ACTIVE_PRODUCTS, PRODUCTS, isActiveSlug } from '../../src/content/products';
import { buildCreateLeadArgs, LeadRejected } from '../../src/server/leads/intake';
import { createPiiCrypto } from '../../src/server/security/piiCrypto';

const ctx = {
  crypto: createPiiCrypto({
    encKeys: { '1': Buffer.alloc(32, 1) },
    currentVersion: '1',
    hmacKey: Buffer.alloc(32, 3),
    ipHashKey: Buffer.alloc(32, 4),
  }),
  signingKey: { keyId: 1, secret: Buffer.alloc(32, 0x22) },
  currentPrivacyVersion: 'privacy-test-v1',
  clientIp: '203.0.113.10',
  nowSeconds: 1_800_000_000,
};
const valid = {
  name: '테스트고객',
  phone: '010-0000-0001',
  interest: 'internet_tv',
  consentCollection: true,
  privacyVersion: 'privacy-test-v1',
  idempotencyKey: 'a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab',
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof LeadRejected ? e.code : 'OTHER';
  }
  return 'NO_ERROR';
};

test('G1 활성 상품은 인터넷+TV 하나, 상담 대상도 인터넷+TV 고정', () => {
  assert.deepEqual([...ACTIVE_INTERESTS], ['internet_tv']);
  assert.equal(fixedConsultInterest(), 'internet_tv');
});

test('G2 집전화·CCTV·인터넷만·기타·휴대폰은 예약, 동판 키는 없음', () => {
  for (const k of ['internet_phone', 'cctv_security', 'internet_only', 'other', 'mobile'] as const) {
    assert.equal(CATALOG[k].status, 'reserved', k);
  }
  const keys = Object.keys(CATALOG);
  assert.ok(!keys.some((k) => /dong|동판/i.test(k)));
  assert.ok(!Object.values(CATALOG).some((e) => e.label.includes('동판')));
});

test('G3 상태값은 실행 중 바꿀 수 없다(동결 객체)', () => {
  assert.throws(() => {
    (CATALOG.cctv_security as { status: string }).status = 'active';
  }, TypeError);
  assert.throws(() => {
    (CATALOG as Record<string, unknown>).dongpan = { status: 'active', label: 'x', note: '' };
  }, TypeError);
  assert.equal(isActiveInterest('cctv_security'), false);
});

test('G4 알 수 없는 값·변형 값·프로토타입 키는 모두 비활성', () => {
  for (const v of ['INTERNET_TV', ' internet_tv', 'internet_tv ', 'internet-tv', '__proto__', 'toString', 'constructor', '', null, undefined, 1, {}]) {
    assert.equal(isActiveInterest(v), false, String(v));
  }
});

test('G5 상태값은 환경변수로 바꿀 수 없다(catalog.ts에 process.env 없음)', () => {
  const src = readFileSync('src/content/catalog.ts', 'utf8');
  assert.ok(!/process\.env/.test(src));
});

test('G6 서버 접수: 예약 상품은 PRODUCT_NOT_ACTIVE, 인터넷+TV는 정상', () => {
  for (const k of ['internet_phone', 'cctv_security', 'internet_only', 'other']) {
    assert.equal(code(() => buildCreateLeadArgs({ ...valid, interest: k }, ctx)), 'PRODUCT_NOT_ACTIVE', k);
  }
  assert.equal(code(() => buildCreateLeadArgs({ ...valid, interest: 'mobile' }, ctx)), 'INVALID_INPUT'); // 휴대폰은 접수 형식 자체에 없음
  assert.equal(code(() => buildCreateLeadArgs(valid, ctx)), 'NO_ERROR');
});

test('G7 화면 노출 상품은 인터넷+TV 하나, 기존 상품 문구는 보존', () => {
  assert.deepEqual(ACTIVE_PRODUCTS.map((p) => p.slug), ['internet-tv']);
  assert.deepEqual(PRODUCTS.map((p) => p.slug), ['internet-tv', 'internet-phone', 'cctv-security']);
  assert.equal(isActiveSlug('internet-tv'), true);
  for (const s of ['internet-phone', 'cctv-security', 'mobile', 'unknown', '']) assert.equal(isActiveSlug(s), false, s);
});

test('G8 코드 기준값 = DB 기준값(0004 마이그레이션) — 불일치하면 실패', () => {
  const sql = readFileSync('db/migrations/0004_product_scope.sql', 'utf8');
  const block = sql.split('insert into core.product_catalog (product_key, label, status, activated_at) values')[1]?.split(';')[0];
  assert.ok(block, '0004 기준값 insert 문을 찾지 못함');
  const rows = [...block.matchAll(/\('([a-z_]+)',\s*'([^']+)',\s*'(active|reserved)'/g)].map((m) => [m[1], m[2], m[3]]);
  const fromCode = Object.entries(CATALOG).map(([k, e]) => [k, e.label, e.status]);
  assert.deepEqual(rows.sort(), fromCode.sort());
  // DB의 product_key 허용 목록도 코드 키와 같아야 한다
  const check = sql.match(/check \(product_key in \(([^)]*)\)\)/)?.[1] ?? '';
  const dbKeys = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(dbKeys, Object.keys(CATALOG).sort());
});

test('G9 기존 마이그레이션의 상담 신청 함수 본문은 그대로이고, 0004는 상품 확인 한 단계만 추가', () => {
  const v1 = readFileSync('db/migrations/0002_leads.sql', 'utf8');
  const v2 = readFileSync('db/migrations/0004_product_scope.sql', 'utf8');
  const fn = (s: string) => s.slice(s.indexOf('create or replace function api.create_lead('), s.indexOf('$$;', s.indexOf('create or replace function api.create_lead(')) + 3);
  const added = /\n  -- 1-1\) PHASE 1:[\s\S]*?raise exception 'PRODUCT_NOT_ACTIVE' using errcode = 'FP001';\n  end if;\n/;
  assert.match(fn(v2), added);
  assert.equal(fn(v2).replace(added, ''), fn(v1));
});

test('G10 브라우저로 내려가는 코드(use client)에는 예약 상품 이름·값이 없고 상품 목록 모듈을 불러오지 않는다', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(`${dir}/${d.name}`) : [`${dir}/${d.name}`]));
  const clientFiles = walk('src').filter((f) => /\.tsx?$/.test(f) && /^['"]use client['"]/m.test(readFileSync(f, 'utf8')));
  assert.ok(clientFiles.length > 0);
  const reserved = ['internet_phone', 'cctv_security', 'internet_only', "'other'", 'mobile', '집전화', 'CCTV', '동판'];
  for (const f of clientFiles) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/from ['"](@\/content\/(catalog|products)|\.\.?\/.*content\/(catalog|products))['"]/.test(src), `${f}: 상품 목록 모듈 import`);
    for (const r of reserved) assert.ok(!src.includes(r), `${f}: '${r}' 포함`);
    assert.ok(!/휴대폰(?! 번호)/.test(src), `${f}: 상품명 '휴대폰' 포함('휴대폰 번호' 입력란은 제외)`);
  }
});
