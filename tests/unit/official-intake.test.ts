// 총판 공식 접수 경로 연결 준비(PM 6920265190 / 6920404685) — 순수 검증·판정과 기본 꺼짐 정적 확인.
// 실제 목적지·활성 변경은 이 시험의 범위가 아니다. 가상 주소는 IANA 예시 도메인(example.com)만 쓴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resolveOfficialIntake,
  validateOfficialIntakeUrl,
  OFFICIAL_INTAKE_MAX_ENTRIES,
  type OfficialIntakeEntry,
} from '../../src/content/officialIntake';

const GOOD: OfficialIntakeEntry = { id: 'fake-a', label: '가상 접수처 A', url: 'https://intake-a.example.com/apply', products: ['internet-tv'], reviewRef: 'PM-000000' };
const on = (registry: unknown, slug: 'internet-tv' | 'internet-phone' | 'cctv-security' = 'internet-tv') =>
  resolveOfficialIntake({ enabled: true, registry, slug });

test('OI1 정상 고정 https 주소만 통과', () => {
  for (const u of ['https://intake-a.example.com/apply', 'https://a.example.co.kr/', 'https://shop.example.com/internet-tv/apply_v2.html', 'https://x1.example.net/a-b/c~d']) {
    const r = validateOfficialIntakeUrl(u);
    assert.equal(r.ok, true, u);
    if (r.ok) assert.equal(r.href, u);
  }
});

test('OI2 차단: 형식·스킴·자격증명·포트·query·fragment·인코딩', () => {
  const cases: [unknown, string][] = [
    [undefined, 'TYPE'], [null, 'TYPE'], [123, 'TYPE'], ['', 'LENGTH'], ['https://a.example.com/' + 'a'.repeat(600), 'LENGTH'],
    ['http://intake.example.com/', 'SCHEME'], ['HTTPS://intake.example.com/', 'SCHEME'], ['javascript:alert(1)', 'SCHEME'],
    ['//intake.example.com/', 'SCHEME'], ['/consult', 'SCHEME'], ['#kakao-channel', 'SCHEME'], ['about:blank', 'SCHEME'],
    ['https://user:pw@intake.example.com/', 'CREDENTIALS'], ['https://intake.example.com@evil.example.net/', 'CREDENTIALS'],
    ['https://intake.example.com:8443/', 'PORT'], ['https://intake.example.com:443/', 'PORT'],
    ['https://intake.example.com/?dealer=1', 'QUERY'], ['https://intake.example.com/?', 'QUERY'],
    ['https://intake.example.com/apply?utm_source=x', 'QUERY'], ['https://intake.example.com/#top', 'FRAGMENT'],
    ['https://intake.example.com/%2e%2e/', 'ENCODING'], ['https://intake.example.com/a%20b', 'ENCODING'],
    ['https://intake.example.com/ apply', 'CHARSET'], ['https://intake.example.com/\napply', 'CHARSET'], ['https://접수.example.com/', 'CHARSET'],
    ['https://intake.example.com\\@evil.example.net/', 'CREDENTIALS'], ['https://intake.example.com/a\\b', 'BACKSLASH'],
  ];
  for (const [u, code] of cases) {
    const r = validateOfficialIntakeUrl(u);
    assert.equal(r.ok, false, String(u));
    if (!r.ok) assert.equal(r.code, code, String(u));
  }
});

test('OI3 차단: IP·localhost·내부·예약 도메인·IDN·한 단어 호스트·비정규 경로', () => {
  const bad = [
    'https://127.0.0.1/', 'https://10.0.0.5/apply', 'https://169.254.169.254/', 'https://[::1]/', 'https://0x7f000001/', 'https://2130706433/',
    'https://localhost/', 'https://app.localhost/', 'https://intake.local/', 'https://svc.internal/', 'https://router.lan/',
    'https://intake.test/', 'https://intake.invalid/', 'https://intake.example/', 'https://x.home.arpa/', 'https://abc.onion/',
    'https://xn--80ak6aa92e.com/', 'https://intake/', 'https://-bad.example.com/', 'https://intake.example.com',
    'https://intake.example.com/a//b', 'https://intake.example.com/a/../b', 'https://intake.example.com/./a', 'https://INTAKE.example.com/',
    'https://intake.example.com./',
  ];
  for (const u of bad) assert.equal(validateOfficialIntakeUrl(u).ok, false, u);
});

test('OI4 기본·꺼짐·빈 등록부·placeholder → 링크 없음', () => {
  assert.deepEqual(resolveOfficialIntake({ enabled: false, registry: [GOOD], slug: 'internet-tv' }), { state: 'off', reason: 'DISABLED' });
  for (const en of ['true', 1, 'on', undefined, null, {}]) {
    assert.deepEqual(resolveOfficialIntake({ enabled: en, registry: [GOOD], slug: 'internet-tv' }), { state: 'off', reason: 'DISABLED' }, String(en));
  }
  assert.deepEqual(on([]), { state: 'off', reason: 'EMPTY' });
  assert.deepEqual(on(undefined), { state: 'off', reason: 'INVALID' });
  assert.deepEqual(on('https://intake-a.example.com/apply'), { state: 'off', reason: 'INVALID' });
  for (const url of ['#official-intake', 'TBD', '', 'https://', 'about:blank', 'https://intake-a.example.com/apply?dealer=PLACEHOLDER']) {
    assert.deepEqual(on([{ ...GOOD, url }]), { state: 'off', reason: 'INVALID' }, url);
  }
});

test('OI5 항목 하나라도 무효면 등록부 전체 거부(fail closed)', () => {
  const bads: unknown[] = [
    { ...GOOD, id: 'A' }, { ...GOOD, id: 'x' }, { ...GOOD, label: '' }, { ...GOOD, label: 'intake.example.com' }, { ...GOOD, label: '010-1234-5678' },
    { ...GOOD, label: ' 앞공백' }, { ...GOOD, reviewRef: 'approved' }, { ...GOOD, reviewRef: '' }, { ...GOOD, products: [] },
    { ...GOOD, products: ['internet-phone'] }, { ...GOOD, products: ['internet-tv', 'internet-tv'] }, { ...GOOD, extra: 1 },
    { id: GOOD.id, label: GOOD.label, url: GOOD.url, products: GOOD.products }, null, 'x', [GOOD],
  ];
  for (const b of bads) assert.deepEqual(on([GOOD, b]), { state: 'off', reason: 'INVALID' }, JSON.stringify(b));
  // 중복 id·중복 주소·상한 초과
  assert.deepEqual(on([GOOD, { ...GOOD, url: 'https://intake-b.example.com/apply' }]), { state: 'off', reason: 'INVALID' });
  assert.deepEqual(on([GOOD, { ...GOOD, id: 'fake-b' }]), { state: 'off', reason: 'INVALID' });
  const many = Array.from({ length: OFFICIAL_INTAKE_MAX_ENTRIES + 1 }, (_, i) => ({ ...GOOD, id: `fake-${i}0`, url: `https://intake-${i}.example.com/apply` }));
  assert.deepEqual(on(many), { state: 'off', reason: 'INVALID' });
});

test('OI6 정상 경로: 활성+유효 등록부+해당 상품일 때만 고정 링크', () => {
  const b = { ...GOOD, id: 'fake-b', label: '가상 접수처 B', url: 'https://intake-b.example.com/internet-tv' };
  const r = on([GOOD, b]);
  assert.equal(r.state, 'on');
  if (r.state === 'on') {
    assert.deepEqual(r.links.map((l) => [l.id, l.href, l.host]), [
      ['fake-a', 'https://intake-a.example.com/apply', 'intake-a.example.com'],
      ['fake-b', 'https://intake-b.example.com/internet-tv', 'intake-b.example.com'],
    ]);
    assert.ok(Object.isFrozen(r.links) && Object.isFrozen(r.links[0]));
    for (const l of r.links) assert.ok(!/[?#@%]/.test(l.href), '링크에 query·fragment·자격증명·인코딩 없음');
  }
  // 1단계 연결 대상이 아닌 상품은 등록부가 유효해도 링크 없음
  assert.deepEqual(on([GOOD], 'internet-phone'), { state: 'off', reason: 'NO_MATCH' });
  assert.deepEqual(on([GOOD], 'cctv-security'), { state: 'off', reason: 'NO_MATCH' });
});

test('OI7 판정 함수는 요청·고객 입력을 받지 않는다(추가 입력은 무시, 목적지 주입 불가)', () => {
  const injected = { enabled: true, registry: [GOOD], slug: 'internet-tv' as const, url: 'https://evil.example.net/', searchParams: { to: 'https://evil.example.net/' }, name: '홍길동', phone: '01012345678' };
  const r = resolveOfficialIntake(injected);
  assert.equal(r.state, 'on');
  if (r.state === 'on') {
    assert.deepEqual(r.links.map((l) => l.href), ['https://intake-a.example.com/apply']);
    assert.ok(!JSON.stringify(r).includes('evil') && !JSON.stringify(r).includes('홍길동') && !JSON.stringify(r).includes('0101234'));
  }
});

test('OI8 실제 서버 설정은 꺼짐·빈 등록부·코드 상수(환경변수 미사용)·server-only', () => {
  const src = readFileSync('src/server/intake/officialIntakeConfig.ts', 'utf8');
  assert.match(src, /^import 'server-only';/);
  assert.match(src, /export const OFFICIAL_INTAKE_ENABLED: boolean = false;/);
  assert.match(src, /export const OFFICIAL_INTAKE_REGISTRY: readonly OfficialIntakeEntry\[\] = Object\.freeze\(\[\]\);/);
  assert.ok(!/process\.env|NEXT_PUBLIC|searchParams|headers\(|cookies\(/.test(src), '환경변수·요청 값 미사용');
  const pure = readFileSync('src/content/officialIntake.ts', 'utf8');
  assert.ok(!/process\.env|fetch\(|https:\/\/(?!')[a-z]/.test(pure.replace(/\/\/.*$/gm, '')), '순수 모듈에 실제 목적지·환경·요청 없음');
});

test('OI9 화면 배선: 홈·상품 화면은 서버 상수 판정만 쓰고 주소 값을 읽지 않는다', () => {
  const home = readFileSync('src/app/page.tsx', 'utf8');
  const product = readFileSync('src/components/ProductPage.tsx', 'utf8');
  const tv = readFileSync('src/app/products/internet-tv/page.tsx', 'utf8');
  assert.match(home, /officialIntakeFor\('internet-tv'\)/);
  assert.match(product, /officialIntakeFor\(slug\)/);
  for (const s of [home, product, tv]) assert.ok(!/searchParams|useSearchParams|headers\(|cookies\(/.test(s));
  const cta = readFileSync('src/components/OfficialIntakeCta.tsx', 'utf8');
  assert.ok(!/'use client'|<form|<input|<iframe|<script|<img|fetch\(|useEffect/.test(cta), '링크만 그린다');
  assert.match(cta, /rel="noopener noreferrer nofollow"/);
  assert.match(cta, /referrerPolicy="no-referrer"/);
  assert.match(cta, /if \(intake\.state !== 'on' \|\| intake\.links\.length === 0\) return null;/);
});
