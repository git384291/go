// 검색 노출 준비: 닫힌 기본값, 공식 주소 검증, 비공개 경로 제외
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NEVER_INDEX, PAGE_META, SITEMAP_PATHS, pageMetadata, publicSiteOrigin, robotsRules, searchIndexingAllowed, sitemapEntries } from '../../src/content/seo';
import { CATALOG } from '../../src/content/catalog';

const OPEN = { VERCEL_ENV: 'production', SEARCH_INDEXING: 'allow', PUBLIC_SITE_ORIGIN: 'https://www.fideon-real.kr' };

test('S1 기본값은 닫힘: robots 전체 차단·sitemap 없음, canonical·OG URL 없음', () => {
  for (const env of [{}, { VERCEL_ENV: 'preview', SEARCH_INDEXING: 'allow', PUBLIC_SITE_ORIGIN: OPEN.PUBLIC_SITE_ORIGIN }, { ...OPEN, SEARCH_INDEXING: 'true' }, { ...OPEN, PUBLIC_SITE_ORIGIN: '' }]) {
    assert.equal(searchIndexingAllowed(env), false, JSON.stringify(env));
    assert.deepEqual(robotsRules(env), { rules: [{ userAgent: '*', disallow: '/' }] });
    assert.deepEqual(sitemapEntries(env), []);
  }
  const m = pageMetadata('home', {});
  assert.equal('alternates' in m, false);
  assert.equal('openGraph' in m, false);
});

test('S2 공식 주소 검증: https 원본만, example·localhost·vercel.app·IP·경로·포트·쿼리 거부', () => {
  assert.equal(publicSiteOrigin({ PUBLIC_SITE_ORIGIN: 'https://www.fideon-real.kr' }), 'https://www.fideon-real.kr');
  assert.equal(publicSiteOrigin({ PUBLIC_SITE_ORIGIN: 'https://www.fideon-real.kr/' }), 'https://www.fideon-real.kr');
  for (const bad of ['http://fideon-real.kr', 'https://example.com', 'https://a.example.org', 'https://localhost', 'https://fideon.vercel.app',
    'https://1.2.3.4', 'https://fideon-real.kr/path', 'https://fideon-real.kr:8443', 'https://fideon-real.kr/?a=1', 'https://u:p@fideon-real.kr', 'not a url', 'javascript:alert(1)']) {
    assert.equal(publicSiteOrigin({ PUBLIC_SITE_ORIGIN: bad }), null, bad);
  }
});

test('S3 허용 조건에서도 관리자·API 차단, sitemap은 활성 공개 경로만(준비 중 접수 화면 제외)', () => {
  const r = robotsRules(OPEN) as { rules: { disallow: string[] }[]; sitemap: string };
  for (const p of NEVER_INDEX) assert.ok(r.rules[0].disallow.includes(p) && r.rules[0].disallow.includes(`${p}/`));
  assert.equal(r.sitemap, 'https://www.fideon-real.kr/sitemap.xml');
  const urls = sitemapEntries(OPEN).map((e) => e.url);
  assert.deepEqual(urls, SITEMAP_PATHS.map((p) => `https://www.fideon-real.kr${p}`));
  for (const u of urls) {
    assert.ok(!/\/admin|\/api|\/consult|internet-phone|cctv|mobile|internet-only/.test(u), u);
  }
  assert.equal(pageMetadata('internetTv', OPEN).alternates?.canonical, 'https://www.fideon-real.kr/products/internet-tv');
});

test('S4 메타 문구: 페이지마다 고유, 가격·혜택 약속·평점·보장 표현 없음, 예약 상품 미언급', () => {
  const titles = Object.values(PAGE_META).map((m) => m.title);
  assert.equal(new Set(titles).size, titles.length);
  const text = Object.values(PAGE_META).map((m) => `${m.title} ${m.description}`).join(' ');
  for (const bad of [/\d[\d,]*\s*원/, /최저가|무료|현금|사은품|당일|보장|평점|후기|1위/, /CCTV|집전화|휴대폰|동판/]) assert.ok(!bad.test(text), String(bad));
  assert.ok(CATALOG.internet_tv);
});

test('S5 루트 layout의 noindex는 유지, robots·sitemap은 동적이며 content/seo만 사용', () => {
  assert.match(readFileSync('src/app/layout.tsx', 'utf8'), /robots: \{ index: false, follow: false \}/);
  for (const f of ['src/app/robots.ts', 'src/app/sitemap.ts']) {
    const s = readFileSync(f, 'utf8');
    assert.match(s, /export const dynamic = 'force-dynamic'/);
    assert.match(s, /from '@\/content\/seo'/);
  }
});
