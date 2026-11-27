// PM 11/21: /admin/* 전체 페이지·/api/admin/* 전체 라우트가 서버에서 직원 확인(requireStaff)을 거치는지 정적 점검.
// 새 관리자 페이지·라우트가 생기면 이 시험이 자동으로 검사한다(가드 없으면 실패).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const f = path.join(d, n); return statSync(f).isDirectory() ? walk(f) : [f]; });
const GUARD = /requireStaff|defaultLeadsServerDeps/;

test('AG1 모든 /admin 페이지(로그인 제외)와 /api/admin 라우트는 서버 쪽 직원 확인을 사용한다', () => {
  const pages = walk('src/app/admin').filter((f) => /(^|\/)page\.tsx$/.test(f) && !f.includes(`${path.sep}login${path.sep}`));
  const routes = walk('src/app/api/admin').filter((f) => /(^|\/)route\.ts$/.test(f));
  assert.ok(pages.length >= 6 && routes.length >= 8, `${pages.length},${routes.length}`);
  for (const f of [...pages, ...routes]) assert.ok(GUARD.test(readFileSync(f, 'utf8')), `${f}: 직원 확인 없음`);
  // 관리자 경로에 레이아웃·템플릿·미들웨어가 가드를 우회하는 정적 공개 파일을 두지 않는다
  for (const f of walk('src/app/admin')) assert.ok(!/(^|\/)(opengraph-image|sitemap|robots)\./.test(f), f);
});
test('AG2 요청 헤더·쿼리로 역할을 받는 코드가 없다(role·actor·token은 서버가 정한다)', () => {
  for (const f of [...walk('src/app/admin'), ...walk('src/app/api/admin')].filter((p) => /\.(ts|tsx)$/.test(p))) {
    const s = readFileSync(f, 'utf8');
    assert.ok(!/(headers|searchParams|nextUrl\.searchParams|url\.searchParams)[^;\n]*\.(get|getAll)\(\s*['"](role|actor|token|session|x-role|x-staff)['"]/.test(s), `${f}: 요청값으로 권한 입력`);
  }
});
test('AG3 middleware는 /admin 전체를 덮고(검색 제외·no-store·갱신) 인증 서버 장애는 503으로 닫는다', () => {
  const m = readFileSync('src/middleware.ts', 'utf8');
  assert.ok(m.includes("'/admin'") && m.includes("'/admin/:path*'"));
  const a = readFileSync('src/server/auth/adminMiddleware.ts', 'utf8');
  assert.ok(/503/.test(a) && /no-store/.test(a));
});
