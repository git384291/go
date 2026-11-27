import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPiiCrypto } from '../../src/server/security/piiCrypto';
import { importNaverForm, parseNaverFormExport, type NaverImportDeps } from '../../src/server/admin/naverFormImport';
import type { StaffIdentity } from '../../src/server/auth/staffSession';
import { POST } from '../../src/app/api/admin/intake/naver/route';

const ENV = { ADMIN_CRM_SOURCE: 'db', NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@127.0.0.1:5432/fideon_lrs_123_abcdef01' };
const OWNER = { actor: '00000000-0000-4000-8000-000000000001', session: '10000000-0000-4000-8000-000000000001', token: 'staff-token', role: 'owner' } as StaffIdentity;
const crypto = createPiiCrypto({ encKeys: { '1': Buffer.alloc(32, 1) }, currentVersion: '1', hmacKey: Buffer.alloc(32, 2), ipHashKey: Buffer.alloc(32, 3) });
const csv = (rows: string) => `응답일시,1. 원하시는 가입 유형,2. 성함,3. 연락처,4. 개인정보 수집 및 이용 동의,5. 설치 희망 지역(시·군·구)\n${rows}`;

function deps(role: StaffIdentity['role'] = 'owner', result = 'imported') {
  const calls = { tx: 0, sql: [] as string[], vals: [] as unknown[][] };
  const d: NaverImportDeps = {
    env: () => ENV, mode: () => 'supabase', requireStaff: async () => ({ ...OWNER, role }), now: () => new Date(), crypto: () => crypto,
    runInTransaction: async (fn) => {
      calls.tx++;
      const tag = (async (s: TemplateStringsArray, ...v: unknown[]) => { calls.sql.push(s.join('?')); calls.vals.push(v); return [{ result }]; }) as never;
      return fn(tag);
    },
  };
  return { d, calls };
}

test('NF1 CSV·TSV 헤더와 따옴표를 읽고 필수 열 누락은 거부한다', () => {
  const a = parseNaverFormExport(csv(`2026-11-28,인터넷+TV,"홍,길동",010-1234-5678,동의합니다,"서울, 강남구"`));
  assert.deepEqual(a[0], { row: 2, kind: '인터넷+TV', name: '홍,길동', phone: '010-1234-5678', consent: '동의합니다', area: '서울, 강남구' });
  const t = `원하시는 가입 유형\t성함\t연락처\t개인정보 수집 및 이용 동의\t설치 희망 지역(시·군·구)\n인터넷+TV\t가상고객\t01011112222\t동의합니다\t서울 강남구`;
  assert.equal(parseNaverFormExport(t).length, 1);
  assert.throws(() => parseNaverFormExport('성함,연락처\n가상,01011112222'), /HEADERS_MISMATCH/);
});

test('NF2 정상 행은 암호화·HMAC 후 대표 전용 DB 함수로 보내고 응답·SQL에 원문이 없다', async () => {
  const { d, calls } = deps();
  const raw = csv(`2026-11-28,인터넷+TV,가상고객,010-1234-5678,동의합니다,서울 강남구`);
  const res = await importNaverForm(d, raw);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(text), { ok: true, imported: 1, duplicates: 0, rejected: [] });
  assert.equal(calls.tx, 1);
  assert.match(calls.sql[0]!, /api\.naver_form_import/);
  for (const secret of ['가상고객', '010-1234-5678', '01012345678', '서울 강남구']) {
    assert.ok(!text.includes(secret));
    assert.ok(!calls.sql[0]!.includes(secret));
    assert.ok(!calls.vals[0]!.some((v) => v === secret));
  }
});

test('NF3 비동의·미승인 상품·잘못된 값은 행 번호만 반환하고 유효 행만 처리한다', async () => {
  const { d, calls } = deps();
  const raw = csv([
    `2026-11-28,인터넷+TV,가상고객,01011112222,동의합니다,서울 강남구`,
    `2026-11-28,인터넷만,가상고객,01011113333,동의합니다,서울 송파구`,
    `2026-11-28,인터넷+TV,가상고객,01011114444,동의하지 않습니다,서울 마포구`,
  ].join('\n'));
  const res = await importNaverForm(d, raw);
  const b = await res.json() as { imported: number; rejected: Array<{ row: number; code: string }> };
  assert.equal(b.imported, 1);
  assert.deepEqual(b.rejected, [{ row: 3, code: 'PRODUCT_NOT_ACTIVE' }, { row: 4, code: 'CONSENT_REQUIRED' }]);
  assert.equal(calls.vals.length, 1);
});

test('NF4 대표 외 역할은 파일 파싱·암호화·DB 전에 차단한다', async () => {
  for (const role of ['counselor', 'reviewer', 'policy_editor'] as const) {
    const { d, calls } = deps(role);
    const res = await importNaverForm(d, csv(`2026-11-28,인터넷+TV,가상고객,01011112222,동의합니다,서울 강남구`));
    assert.equal(res.status, 403);
    assert.equal(calls.tx, 0);
  }
});

test('NF5 행·열·필드 한도와 DB 원문 오류 노출을 막는다', async () => {
  assert.throws(() => parseNaverFormExport(csv(Array.from({ length: 101 }, (_, i) => `x,인터넷+TV,가상${i},01011112222,동의합니다,서울`).join('\n'))), /TOO_MANY_ROWS/);
  const { d } = deps('owner', 'unexpected');
  const res = await importNaverForm(d, csv(`2026-11-28,인터넷+TV,가상고객,01011112222,동의합니다,서울 강남구`));
  assert.deepEqual([res.status, (await res.json() as { code: string }).code], [503, 'DB_UNAVAILABLE']);
});

test('NF6 라우트는 CSV/TSV만 받고 교차 출처·256KB 초과를 인증 전에 차단한다', async () => {
  const media = await POST(new Request('http://x/api/admin/intake/naver', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(media.status, 415);
  const cross = await POST(new Request('http://x/api/admin/intake/naver', { method: 'POST', headers: { 'content-type': 'text/csv', origin: 'https://evil.example' }, body: 'x' }));
  assert.equal(cross.status, 403);
  const large = await POST(new Request('http://x/api/admin/intake/naver', { method: 'POST', headers: { 'content-type': 'text/csv', 'content-length': String(256 * 1024 + 1) }, body: 'x' }));
  assert.equal(large.status, 413);
});
