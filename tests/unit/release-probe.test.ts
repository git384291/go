// PHASE 1 최종 보완: 배포 전 점검(catalog_audit.sql)의 고정값이 실제 마이그레이션·코드와 일치하는지 확인한다.
// 함수를 고치고 점검의 해시를 갱신하지 않으면 여기서 먼저 실패한다(운영 배포 단계까지 가지 않도록).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { ACTIVE_INTERESTS, CATALOG } from '../../src/content/catalog';

const MIGRATIONS = readdirSync('db/migrations').filter((f) => /^0\d+_.*\.sql$/.test(f)).sort();
const AUDIT = readFileSync('db/audit/catalog_audit.sql', 'utf8');

/** 마이그레이션 순서대로 읽어 함수의 '마지막 정의' 본문($$ 사이, PostgreSQL prosrc와 같은 값)을 돌려준다 */
function lastBody(qualified: string): { file: string; body: string } {
  let found: { file: string; body: string } | null = null;
  for (const f of MIGRATIONS) {
    const s = readFileSync(`db/migrations/${f}`, 'utf8');
    const head = `create or replace function ${qualified}(`;
    let i = s.indexOf(head);
    while (i >= 0) {
      const a = s.indexOf('$$', i) + 2;
      const b = s.indexOf('$$', a);
      found = { file: f, body: s.slice(a, b) };
      i = s.indexOf(head, b);
    }
  }
  assert.ok(found, `${qualified} 정의를 찾지 못함`);
  return found;
}

test('V13 고정 해시 = 마이그레이션의 마지막 함수 본문 md5 (5개 함수 모두)', () => {
  const rows = [...AUDIT.matchAll(/\('(api|core)', '([a-z_]+)', '([^']*)', '([0-9a-f]{32})'\)/g)];
  assert.equal(rows.length, 5, 'pinned_funcs 5행');
  for (const [, nsp, fname, , md5] of rows) {
    const { file, body } = lastBody(`${nsp}.${fname}`);
    assert.equal(createHash('md5').update(body, 'utf8').digest('hex'), md5, `${nsp}.${fname} (${file})`);
  }
  // 상품 차단에 관여하는 함수가 빠지지 않았는지
  const names = rows.map((r) => `${r[1]}.${r[2]}`).sort();
  assert.deepEqual(names, ['api.create_lead', 'api.release_probe_product_scope', 'core.block_truncate', 'core.product_approval_guard', 'core.product_catalog_guard']);
});

test('점검 함수의 기준값 = 코드 상품 상태(catalog.ts)', () => {
  const { body } = lastBody('api.release_probe_product_scope');
  const arr = (name: string) => {
    const m = body.match(new RegExp(`${name}\\s+constant text\\[\\] := array\\[([^\\]]*)\\]`));
    assert.ok(m, name);
    return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  };
  assert.deepEqual(arr('expected_keys'), Object.keys(CATALOG).sort());
  assert.deepEqual(arr('expected_active'), [...ACTIVE_INTERESTS]);
});

test('점검 함수는 읽기 전용(STABLE)이고 쓰기 문장이 없으며, 점검 계정에는 이 함수 실행 권한만 준다', () => {
  const s = readFileSync('db/migrations/0006_release_probe.sql', 'utf8');
  assert.match(s, /returns setof text\s+language plpgsql stable security definer set search_path = ''/);
  const { body } = lastBody('api.release_probe_product_scope');
  assert.ok(!/\b(insert|update|delete|truncate|alter|drop|create|grant|perform\s+set_config)\b/i.test(body.replace(/--[^\n]*/g, '')));
  const grants = [...s.matchAll(/^grant [^;]+;/gm)].map((m) => m[0]);
  assert.deepEqual(grants, [
    'grant usage on schema api to release_auditor;',
    'grant execute on function api.release_probe_product_scope() to release_auditor;',
  ]);
});
