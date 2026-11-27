// 카카오톡 상품 문의 링크 판정(PM 6938169689) — 가짜 설정만 사용. 가짜 링크는 열지 않는다.
// 경로 정규식은 가짜 시험용 임시 제약이며 실제 카카오 경로 형식을 검증한 것이 아니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveKakaoInquiry, KAKAO_INQUIRY_HOST } from '../../src/content/kakaoInquiry';

const FAKE = 'https://pf.kakao.com/_fixture0000/chat';
const ok = { globalGate: true, enabled: true, url: FAKE, reviewRef: 'PM-000000' };
const OFFR = (reason: string) => ({ state: 'off', reason });

test('KI1 모두 정확히 true + 유효 URL·검수 근거일 때만 on', () => {
  assert.deepEqual(resolveKakaoInquiry(ok), { state: 'on', href: FAKE, host: KAKAO_INQUIRY_HOST });
  assert.deepEqual(resolveKakaoInquiry({ ...ok, url: 'https://pf.kakao.com/_fixture0000' }).state, 'on');
  for (const [g, e] of [[false, true], [true, false], [false, false], ['true', true], [true, 1], [undefined, true], [true, null]] as const) {
    assert.deepEqual(resolveKakaoInquiry({ ...ok, globalGate: g, enabled: e }), OFFR('DISABLED'), `${g}/${e}`);
  }
});

test('KI2 주소·검수 근거 누락/형식 오류 → off', () => {
  assert.deepEqual(resolveKakaoInquiry({ ...ok, url: null }), OFFR('NOT_SET'));
  assert.deepEqual(resolveKakaoInquiry({ ...ok, reviewRef: null }), OFFR('NOT_SET'));
  assert.deepEqual(resolveKakaoInquiry({ ...ok, url: undefined }), OFFR('NOT_SET'));
  for (const r of ['', 'approved', 'PM-1', 'pm-000000', 'PM-000000 ', 123]) {
    assert.deepEqual(resolveKakaoInquiry({ ...ok, reviewRef: r }), OFFR('INVALID'), String(r));
  }
});

test('KI3 잘못된 URL·다른 호스트·오픈채팅·placeholder → off', () => {
  const bad: unknown[] = [
    '', '#kakao-channel', 'TBD', 'http://pf.kakao.com/_fixture0000', 'https://pf.kakao.com/_fixture0000?utm_source=x',
    'https://pf.kakao.com/_fixture0000#chat', 'https://user@pf.kakao.com/_fixture0000', 'https://pf.kakao.com:8443/_fixture0000',
    'https://pf.kakao.com/_fix%20ture', 'https://open.kakao.com/o/fixture0', 'https://open.kakao.com/me/fixture', 'https://kakao.com/_fixture0000',
    'https://pf.kakao.com.evil.example.com/_fixture0000', 'https://evilpf.kakao.com/_fixture0000', 'https://www.pf.kakao.com/_fixture0000',
    'https://PF.KAKAO.COM/_fixture0000', 'https://pf.kakao.com/', 'https://pf.kakao.com/fixture0000', 'https://pf.kakao.com/_fixture0000/friend',
    'https://pf.kakao.com/_fixture0000/chat/', 'https://pf.kakao.com/_fix-ture', 'https://pf.kakao.com/_' + 'a'.repeat(33),
    'https://127.0.0.1/_fixture0000', 'https://intake-a.example.com/_fixture0000', 123, {}, ['https://pf.kakao.com/_fixture0000'],
  ];
  for (const url of bad) assert.deepEqual(resolveKakaoInquiry({ ...ok, url }), OFFR('INVALID'), String(url));
});

test('KI4 원본 불변·추가 입력 무시·결과 동결', () => {
  const input = { ...ok, extra: 'https://evil.example.net/', phone: '01012345678' };
  const before = JSON.stringify(input);
  const r = resolveKakaoInquiry(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(Object.keys(r).sort(), ['host', 'href', 'state']);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(resolveKakaoInquiry({ ...ok, enabled: false })));
  assert.ok(!JSON.stringify(r).includes('evil') && !JSON.stringify(r).includes('0101234') && !JSON.stringify(r).includes('PM-'));
});

test('KI5 실제 서버 설정: false/null 코드 상수, 환경변수·요청 미사용, 전역 gate 결합', () => {
  const cfg = readFileSync('src/server/inquiry/kakaoInquiryConfig.ts', 'utf8');
  assert.match(cfg, /^import 'server-only';/);
  assert.match(cfg, /export const KAKAO_INQUIRY_ENABLED: boolean = false;/);
  assert.match(cfg, /export const KAKAO_INQUIRY_URL: string \| null = null;/);
  assert.match(cfg, /export const KAKAO_INQUIRY_REVIEW_REF: string \| null = null;/);
  assert.match(cfg, /globalGate: EXTERNAL_CONSULT_ENABLED,/);
  assert.match(cfg, /export function kakaoInquiryLink\(\): KakaoInquiryResult \{/);
  assert.ok(!/process\.env|NEXT_PUBLIC|searchParams|headers\(|cookies\(|fetch\(/.test(cfg.replace(/\/\/.*$/gm, '')));
  const pure = readFileSync('src/content/kakaoInquiry.ts', 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/process\.env|fetch\(|console\.|import\(|require\(/.test(pure));
  // 공식 접수 등록부는 네이버 폼만 고정하며 카카오 문의와 섞지 않는다
  const official = readFileSync('src/server/intake/officialIntakeConfig.ts', 'utf8');
  assert.match(official, /export const OFFICIAL_INTAKE_ENABLED: boolean = true;/);
  assert.match(official, /url: 'https:\/\/form\.naver\.com\/response\/By757YMGRuN'/);
  assert.ok(!/kakao/i.test(official));
});

test('KI6 화면 배선: 상담·인터넷TV만 서버 판정 전달, 표시 컴포넌트는 링크 1개·입력 없음', () => {
  const tv = readFileSync('src/app/products/internet-tv/page.tsx', 'utf8');
  assert.match(tv, /inquiry=\{kakaoInquiryLink\(\)\}/);
  for (const other of ['src/app/page.tsx', 'src/app/products/internet-phone/page.tsx', 'src/app/products/cctv-security/page.tsx', 'src/components/Site.tsx']) {
    assert.ok(!readFileSync(other, 'utf8').includes('kakaoInquiryLink'), other);
  }
  const product = readFileSync('src/components/ProductPage.tsx', 'utf8');
  assert.ok(!/@\/server\//.test(product));
  assert.match(product, /<KakaoInquiryLink inquiry=\{inquiry\} \/>/);
  const comp = readFileSync('src/components/KakaoInquiryLink.tsx', 'utf8');
  assert.ok(!/'use client'|<form|<input|<textarea|<button|<iframe|<script|<img|onClick|useEffect|fetch\(|@\/server\//.test(comp));
  assert.match(comp, /if \(!inquiry \|\| inquiry\.state !== 'on'\) return null;/);
  assert.match(comp, /rel="noopener noreferrer nofollow" referrerPolicy="no-referrer"/);
  assert.equal((comp.match(/<a /g) ?? []).length, 1);
  const form = readFileSync('src/components/ConsultForm.tsx', 'utf8');
  assert.match(form, /<a className="btn btn-kakao" href=\{kakaoUrl\} rel="noopener noreferrer nofollow" referrerPolicy="no-referrer"/);
});
