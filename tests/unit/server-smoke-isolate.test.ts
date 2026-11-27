// 서버 스모크 격리 루트: 원본의 dotenv 파일을 가져가지 않고, 내용을 바꾸거나 옮기지 않는다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dotenvFilesIn, prepareIsolatedRoot } from '../../scripts/server-smoke/isolate.mjs';

function fixture(withBuild = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fideon-isolate-test-'));
  if (withBuild) mkdirSync(path.join(dir, '.next'));
  mkdirSync(path.join(dir, 'node_modules'));
  writeFileSync(path.join(dir, 'package.json'), '{"private":true}');
  writeFileSync(path.join(dir, 'next.config.ts'), 'export default {};');
  for (const n of ['.env', '.env.local', '.env.production', '.env.production.local']) writeFileSync(path.join(dir, n), 'ADMIN_AUTH_MODE=supabase\nDATABASE_URL=postgres://fake@127.0.0.1:1/x\n');
  writeFileSync(path.join(dir, '.envrc'), 'not dotenv');
  return dir;
}

test('I1 dotenv 이름만 찾는다(.envrc 등은 제외)', () => {
  const dir = fixture();
  try {
    assert.deepEqual(dotenvFilesIn(dir), ['.env', '.env.local', '.env.production', '.env.production.local']);
    assert.deepEqual(dotenvFilesIn(path.join(dir, 'missing')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('I2 격리 루트: .env* 없음, .next·node_modules는 링크, 설정·package만 복사, 원본 dotenv는 그대로', () => {
  const dir = fixture();
  const before = Object.fromEntries(dotenvFilesIn(dir).map((n) => [n, { body: readFileSync(path.join(dir, n), 'utf8'), mtime: statSync(path.join(dir, n)).mtimeMs }]));
  const iso = prepareIsolatedRoot(dir);
  try {
    assert.deepEqual(dotenvFilesIn(iso.root), []);
    assert.ok(lstatSync(path.join(iso.root, '.next')).isSymbolicLink());
    assert.ok(lstatSync(path.join(iso.root, 'node_modules')).isSymbolicLink());
    assert.ok(existsSync(path.join(iso.root, 'next.config.ts')) && existsSync(path.join(iso.root, 'package.json')));
    assert.ok(!existsSync(path.join(iso.root, '.envrc')));
    for (const [n, b] of Object.entries(before)) {
      assert.equal(readFileSync(path.join(dir, n), 'utf8'), b.body, `${n} 내용 변경 없음`);
      assert.equal(statSync(path.join(dir, n)).mtimeMs, b.mtime, `${n} 수정 없음`);
    }
  } finally {
    iso.cleanup();
    assert.ok(!existsSync(iso.root), '격리 루트 정리');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('I3 빌드 산출물 없으면 격리 루트를 만들지 않고 실패', () => {
  const dir = fixture(false);
  try { assert.throws(() => prepareIsolatedRoot(dir), /ISOLATE_NO_BUILD/); } finally { rmSync(dir, { recursive: true, force: true }); }
});
