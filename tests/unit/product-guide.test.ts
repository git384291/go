// 개인정보 없는 상품 안내 규칙 응답(PM 6924799021) — 가상 입력만 사용. 화면·API에는 연결되지 않았다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { answerGuide, guideMenu, GUIDE_TOPICS } from '../../src/content/productGuide';
import type { OfficialIntakeResult } from '../../src/content/officialIntake';

const UNSUP = { status: 'unsupported', source: 'rules', lines: ['선택하신 항목은 안내할 수 없습니다. 아래 목록에서 인터넷 + TV 주제를 골라 주세요.'] };
const OFF: OfficialIntakeResult = { state: 'off', reason: 'DISABLED' };
const ON: OfficialIntakeResult = { state: 'on', links: [{ id: 'fake-a', label: '가상 접수처 A', href: 'https://intake-a.example.com/apply', host: 'intake-a.example.com' }] };
const PRICE = /[0-9][0-9,]*\s*(원|만원|%)|무료|최저|당일|전국|보장|사은품 [0-9]/;

test('PG1 정상 주제: 모두 고정 응답, 규칙 출처 표시, 금액·보장 문구 없음', () => {
  for (const topic of GUIDE_TOPICS) {
    const r = answerGuide({ product: 'internet-tv', topic });
    assert.equal(r.status, 'ok', topic);
    assert.equal(r.source, 'rules');
    if (r.status === 'ok') {
      assert.equal(r.topic, topic);
      assert.ok(r.title.length > 0 && r.lines.length > 0);
      for (const l of [r.title, ...r.lines]) assert.ok(!PRICE.test(l), `${topic}: ${l}`);
      assert.ok(!/AI|인공지능|자동 상담/.test(JSON.stringify(r)), '생성형 AI 상담으로 표시하지 않음');
    }
    assert.deepEqual(answerGuide({ topic, product: 'internet-tv' }), r, '같은 입력 → 같은 응답(키 순서 무관)');
  }
  // 정책·가격·지역·결합 주제는 확인 필요로 둔다
  for (const t of ['fees', 'install', 'bundle', 'moving'] as const) {
    const r = answerGuide({ product: 'internet-tv', topic: t });
    assert.equal(r.status === 'ok' && r.kind, 'needs_check', t);
  }
});

test('PG2 미지원·null·배열·오타·예약 상품·추가 키·자유 문구 → 고정 안전 안내', () => {
  const bad: unknown[] = [
    undefined, null, 0, 'speed', ['internet-tv', 'speed'], [], {}, { topic: 'speed' }, { product: 'internet-tv' },
    { product: 'internet-tv', topic: 'Speed' }, { product: 'internet-tv', topic: ' speed' }, { product: 'internet-tv', topic: 'speed ' },
    { product: 'internet-tv', topic: 'price' }, { product: 'internet-tv', topic: '__proto__' }, { product: 'internet-tv', topic: 'constructor' },
    { product: 'internet-tv', topic: 'toString' }, { product: 'internet-tv', topic: 1 }, { product: 'internet-tv', topic: null },
    { product: 'internet-phone', topic: 'speed' }, { product: 'cctv-security', topic: 'install' }, { product: 'mobile', topic: 'fees' },
    { product: 'internet_tv', topic: 'speed' }, { product: 'INTERNET-TV', topic: 'speed' },
    { product: 'internet-tv', topic: 'speed', name: '홍길동' }, { product: 'internet-tv', topic: 'speed', phone: '01012345678' },
    { product: 'internet-tv', topic: 'speed', address: '서울시 어딘가 1-1' }, { product: 'internet-tv', topic: 'speed', text: '요금 얼마예요?' },
    { product: 'internet-tv', topic: '01012345678' }, { product: 'internet-tv', topic: '설치 되나요 서울 강남구' },
    new (class G { product = 'internet-tv'; topic = 'speed'; })(), new Map([['product', 'internet-tv'], ['topic', 'speed']]),
  ];
  for (const b of bad) assert.deepEqual(answerGuide(b), UNSUP, String(JSON.stringify(b)));
  // 접근자 예외·Proxy도 닫힌다
  const throwing = { product: 'internet-tv', get topic(): string { throw new Error('boom'); } };
  assert.deepEqual(answerGuide(throwing), UNSUP);
  const proxy = new Proxy({ product: 'internet-tv', topic: 'speed' }, { ownKeys() { throw new Error('x'); } });
  assert.deepEqual(answerGuide(proxy), UNSUP);
});

test('PG3 신청 안내: 꺼진 접수 경로면 접수 가능으로 약속하지 않음, 켜져도 주소·완료 문구 없음', () => {
  for (const intake of [undefined, OFF, { state: 'off', reason: 'EMPTY' } as const, { state: 'off', reason: 'INVALID' } as const, { state: 'on', links: [] } as const]) {
    const r = answerGuide({ product: 'internet-tv', topic: 'apply' }, intake);
    assert.equal(r.status, 'ok');
    if (r.status === 'ok') {
      assert.equal(r.officialIntake, 'unavailable');
      assert.equal(r.kind, 'not_ready');
      assert.ok(r.lines.some((l) => l.includes('준비 중')));
      assert.ok(!r.lines.some((l) => /신청할 수 있|접수 가능|연결해 드|연락드/.test(l)));
    }
  }
  const r = answerGuide({ product: 'internet-tv', topic: 'apply' }, ON);
  assert.equal(r.status === 'ok' && r.officialIntake, 'available');
  const s = JSON.stringify(r);
  assert.ok(!/https?:|example\.com|fake-a|가상 접수처/.test(s), '목적지 주소·등록 정보를 응답에 넣지 않음');
  for (const t of [r, answerGuide({ product: 'internet-tv', topic: 'apply' })]) {
    assert.ok(!/신청 완료|접수 완료|담당자 연결 완료|배정되었|연락드리겠/.test(JSON.stringify(t)), '완료·연결 생성 없음');
  }
  // 다른 주제에는 접수 상태를 붙이지 않는다
  const other = answerGuide({ product: 'internet-tv', topic: 'speed' }, ON);
  assert.ok(!('officialIntake' in other));
});

test('PG4 원본 불변·입력 미반환', () => {
  const input = { product: 'internet-tv', topic: 'fees' };
  const before = JSON.stringify(input);
  const a = answerGuide(input);
  assert.equal(JSON.stringify(input), before, '입력 원본 불변');
  assert.ok(Object.isFrozen(a) && a.status === 'ok' && Object.isFrozen(a.lines));
  assert.throws(() => { (a.lines as string[]).push('변조'); });
  assert.throws(() => { (a as { title: string }).title = '변조'; });
  assert.deepEqual(answerGuide({ product: 'internet-tv', topic: 'fees' }), a, '변조 시도 뒤에도 같은 응답');
  assert.deepEqual(Object.keys(a).sort(), ['kind', 'lines', 'source', 'status', 'title', 'topic'], '내부 표식·추가 필드 없음');
  const u = answerGuide({ product: 'internet-tv', topic: 'x', secret: 'S3CR3T' });
  assert.ok(!JSON.stringify(u).includes('S3CR3T') && !JSON.stringify(u).includes('"x"'));
  assert.ok(Object.isFrozen(u));
  const menu = guideMenu();
  assert.deepEqual(menu.map((m) => m.topic), [...GUIDE_TOPICS]);
  assert.ok(Object.isFrozen(menu) && Object.isFrozen(menu[0]));
});

test('PG6 공유 목록·메뉴·응답은 runtime에서도 동결, 외부 수정 시도로 바뀌지 않음', () => {
  const snapshot = JSON.stringify({ topics: GUIDE_TOPICS, menu: guideMenu(), all: GUIDE_TOPICS.map((t) => answerGuide({ product: 'internet-tv', topic: t })) });
  assert.ok(Object.isFrozen(GUIDE_TOPICS));
  const topics = GUIDE_TOPICS as unknown as string[];
  assert.throws(() => { topics.push('price'); });
  assert.throws(() => { topics[0] = 'price'; });
  assert.throws(() => { topics.length = 0; });
  const menu = guideMenu() as unknown as { topic: string; title: string }[];
  assert.throws(() => { menu.push({ topic: 'x', title: 'x' }); });
  assert.throws(() => { menu[0]!.title = '변조된 제목'; });
  for (const t of GUIDE_TOPICS) {
    const a = answerGuide({ product: 'internet-tv', topic: t }) as unknown as { lines: string[]; kind: string };
    assert.throws(() => { a.lines[0] = '변조'; });
    assert.throws(() => { a.kind = 'general'; });
  }
  assert.deepEqual(answerGuide({ product: 'internet-tv', topic: 'price' }), UNSUP, '추가 시도된 주제는 여전히 미지원');
  assert.equal(JSON.stringify({ topics: GUIDE_TOPICS, menu: guideMenu(), all: GUIDE_TOPICS.map((t) => answerGuide({ product: 'internet-tv', topic: t })) }), snapshot);
  // 설치·이사 문구는 확인 완료·설치 가능을 약속하지 않는다
  for (const t of ['install', 'moving'] as const) {
    const a = answerGuide({ product: 'internet-tv', topic: t });
    assert.ok(a.status === 'ok' && a.lines.some((l) => l.includes('공식 접수처에서 별도 확인이 필요')), t);
    assert.ok(!a.lines.some((l) => /접수 단계에서 확인됩니다|설치 가능합니다|설치해 드립니다/.test(l)), t);
  }
});

test('PG5 정적: 저장·로그·네트워크·환경·LLM 접근 없음, 표시 경로는 ProductGuidePanel 하나뿐', () => {
  const src = readFileSync('src/content/productGuide.ts', 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/process\.env|fetch\(|console\.|localStorage|sessionStorage|document\.|window\.|import\(|require\(|node:|postgres|supabase|openai|anthropic|https?:\/\//i.test(src));
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./officialIntake']);
  assert.match(src, /^import type \{ OfficialIntakeResult \} from '\.\/officialIntake';$/m);
  // 규칙 응답을 쓰는 곳은 정확히 이 표시 경로 하나(HTTP·API·정책·SDK 연결 없음)
  let users = '';
  try {
    users = execFileSync('grep', ['-rlE', "content/productGuide|/productGuide'|answerGuide|guideMenu", 'src'], { encoding: 'utf8' });
  } catch (e) {
    if ((e as { status?: number }).status !== 1) throw e; // grep 1 = 일치 없음
  }
  assert.deepEqual(users.trim().split('\n').filter(Boolean).sort(), ['src/components/ProductGuidePanel.tsx', 'src/content/productGuide.ts']);
  let panelUsers = '';
  try {
    panelUsers = execFileSync('grep', ['-rl', 'ProductGuidePanel', 'src'], { encoding: 'utf8' });
  } catch (e) {
    if ((e as { status?: number }).status !== 1) throw e;
  }
  assert.deepEqual(panelUsers.trim().split('\n').filter(Boolean).sort(), ['src/components/ProductGuidePanel.tsx', 'src/components/ProductPage.tsx']);
  const panel = readFileSync('src/components/ProductGuidePanel.tsx', 'utf8');
  assert.ok(!/'use client'|<form|<input|<textarea|<select|<button|<script|<iframe|<img|onClick|onKeyDown|useState|useEffect|fetch\(|href=|@\/server\/|process\.env|console\./.test(panel), '정적 details/summary만');
  assert.equal((panel.match(/<details /g) ?? []).length, 1);
  assert.match(panel, /<summary>/);
  assert.match(panel, /\{a\.topic === 'apply' && a\.officialIntake === 'available' && <OfficialIntakeCta intake=\{intake\} \/>\}/);
  // 기본 꺼짐 코드 상수, 인터넷TV에서만
  assert.match(readFileSync('src/content/channels.ts', 'utf8'), /export const PRODUCT_GUIDE_ENABLED: boolean = false;/);
  const product = readFileSync('src/components/ProductPage.tsx', 'utf8');
  assert.match(product, /\{PRODUCT_GUIDE_ENABLED && slug === 'internet-tv' && <ProductGuidePanel intake=\{intake \?\? GUIDE_INTAKE_OFF\} \/>\}/);
  assert.match(product, /const GUIDE_INTAKE_OFF: OfficialIntakeResult = Object\.freeze\(\{ state: 'off', reason: 'DISABLED' \}\);/);
});
