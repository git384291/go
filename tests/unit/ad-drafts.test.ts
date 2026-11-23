// 광고 소재 초안(PM 6943038907) — 고정 데이터 구조·길이·금지 주장. 매체 실제 집계·심사 통과를 증명하지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { AD_DRAFTS, AD_DRAFT_IDS, AD_TITLE_MAX, AD_DESC_MIN, AD_DESC_MAX, AD_FORBIDDEN_CLAIMS, codePointLength } from '../../src/content/adDrafts';

test('AD1 세 초안: 고정 ID·필수 구조·N6 길이(코드포인트)', () => {
  assert.deepEqual([...AD_DRAFT_IDS], ['moving', 'contract_end', 'general_compare']);
  assert.deepEqual(Object.keys(AD_DRAFTS).sort(), [...AD_DRAFT_IDS].sort());
  for (const id of AD_DRAFT_IDS) {
    const d = AD_DRAFTS[id];
    assert.deepEqual(Object.keys(d).sort(), ['cta', 'description', 'evidence', 'id', 'situation', 'title']);
    assert.equal(d.id, id);
    assert.equal(d.cta, 'UNSET');
    assert.equal(d.evidence, 'HYPOTHESIS_UNVERIFIED');
    assert.ok(codePointLength(d.title) >= 1 && codePointLength(d.title) <= AD_TITLE_MAX, `${id} 제목 ${codePointLength(d.title)}`);
    const dl = codePointLength(d.description);
    assert.ok(dl >= AD_DESC_MIN && dl <= AD_DESC_MAX, `${id} 설명 ${dl}`);
    assert.ok(d.situation.length > 0);
  }
  assert.equal(codePointLength('이사 전 인터넷·TV 확인'), 14);
  assert.equal(codePointLength('😀a'), 2, '서로게이트 쌍도 1자');
});

test('AD2 미확인 주장·URL·연락처 없음', () => {
  for (const id of AD_DRAFT_IDS) {
    const d = AD_DRAFTS[id];
    const text = [d.title, d.description, d.situation].join(' ');
    for (const f of AD_FORBIDDEN_CLAIMS) assert.ok(!text.includes(f), `${id}: '${f}'`);
    assert.ok(!/[0-9]/.test(d.title + d.description), `${id}: 숫자(금액·속도 수치) 없음`);
    assert.ok(!/https?:|www\.|\.com|@|010/.test(text));
  }
});

test('AD3 동결: 목록·초안 외부 변경 불가', () => {
  assert.ok(Object.isFrozen(AD_DRAFTS) && Object.isFrozen(AD_DRAFT_IDS) && Object.isFrozen(AD_FORBIDDEN_CLAIMS));
  const before = JSON.stringify(AD_DRAFTS);
  assert.throws(() => { (AD_DRAFTS as unknown as Record<string, unknown>).extra = {}; });
  assert.throws(() => { (AD_DRAFTS.moving as unknown as { title: string }).title = '최저가 보장'; });
  assert.throws(() => { (AD_DRAFT_IDS as unknown as string[]).push('x'); });
  assert.equal(JSON.stringify(AD_DRAFTS), before);
});

test('AD4 정적: 초안·캠페인 모듈은 네트워크·환경·저장·로그·타이머·SDK가 없고 화면·API에 미배선', () => {
  for (const f of ['src/content/adDrafts.ts', 'src/server/advertising/campaignDraft.ts']) {
    const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/process\.env|fetch\(|console\.|setTimeout|setInterval|localStorage|postgres|supabase|openai|anthropic|naver|import\(|require\(|node:/i.test(src), f);
  }
  const camp = readFileSync('src/server/advertising/campaignDraft.ts', 'utf8');
  assert.match(camp, /^import 'server-only';/);
  assert.match(camp, /executionAllowed: false,\n/);
  assert.ok(!/\b(approve|schedule|publish|charge|submit|execute)\w*\s*\(/i.test(camp.replace(/\/\/.*$/gm, '')), '승인·예약·게시·과금 함수 없음');
  let users = '';
  try {
    users = execFileSync('grep', ['-rlE', 'adDrafts|campaignDraft', 'src'], { encoding: 'utf8' });
  } catch (e) {
    if ((e as { status?: number }).status !== 1) throw e;
  }
  // 사용처는 광고 서버 모듈끼리만(화면·API·라우트 배선 없음). PM 6943345830: 생성 오케스트레이터가 고정 상황 데이터를 읽는다
  const u1 = users.trim().split('\n').filter(Boolean);
  // 정확한 allowlist(PM 6952112639: 디렉터리 전체 허용 금지). 새 사용처는 별도 검수 후 이 목록을 갱신한다
  // PM 6954300094: 영상 storyboard가 고정 상황 ID를 읽는다(새 사용처 1개)
  // PM 11/21 4항: 예산 한도 감시(budgetGuard)가 승인 상한 상수를 읽는다(새 사용처 1개, 검수 필요)
  assert.deepEqual(u1.sort(), ['src/server/advertising/adGeneration.ts', 'src/server/advertising/budgetGuard.ts', 'src/server/advertising/campaignDraft.ts', 'src/server/advertising/video/storyboard.ts', 'src/server/advertising/youtubeAdPreparation.ts']);
  let adv = '';
  try {
    adv = execFileSync('grep', ['-rlE', 'server/advertising|openAiAdGenerator|adGeneration', 'src'], { encoding: 'utf8' });
  } catch (e) {
    if ((e as { status?: number }).status !== 1) throw e;
  }
  const u2 = adv.trim().split('\n').filter(Boolean);
  assert.deepEqual(u2.sort(), [
    'src/server/advertising/boundedHttp.ts',
    // PM 11/23 B·C 승인: 반응형 검색광고 소재 조립이 기존 문구 검증기(validateAdCopy)를 재사용(새 사용처 1개)
    'src/server/advertising/googleAdsCreative.ts',
    'src/server/advertising/openAiAdGenerator.ts',
    'src/server/advertising/video/storyboard.ts',
    'src/server/advertising/youtubeAdPreparation.ts', 'src/server/advertising/youtubePrivatePublisher.ts',
    // PM 11/22 4c7f269 지시 9: 상담 AI 모델 어댑터(미연결 준비 코드)가 범용 HTTP 상한 모듈(boundedHttp)만 재사용(새 사용처 1개, 검수 필요)
    'src/server/consult/openAiChatModel.ts',
  ], '광고 서버 모듈을 import하는 화면·API·route 없음(정확 목록)');
});

test('AD5 정적: AI 생성 모듈은 env·기본 키·SDK·자동 접속·재시도 없음, 고정 endpoint만', () => {
  const gen = readFileSync('src/server/advertising/adGeneration.ts', 'utf8');
  const oa = readFileSync('src/server/advertising/openAiAdGenerator.ts', 'utf8');
  for (const [f, src] of [['adGeneration', gen], ['openAiAdGenerator', oa]] as const) {
    const code = src.replace(/\/\/.*$/gm, '');
    assert.match(src, /^import 'server-only';/, f);
    assert.ok(!/process\.env|from 'openai'|@ai-sdk|require\(|import\(|console\.|localStorage|setInterval|fetch\(/.test(code), f);
  }
  const code = oa.replace(/^\s*\/\/.*$/gm, ''); // 줄 전체 주석만 제거(문자열 속 https:// 보존)
  assert.equal((code.match(/https:\/\//g) ?? []).length, 1, 'endpoint는 상수 1개');
  assert.match(code, /export const OPENAI_RESPONSES_URL = 'https:\/\/api\.openai\.com\/v1\/responses';/);
  assert.match(code, /redirect: 'error'/);
  assert.match(code, /store: false/);
  assert.ok(!/retry|while\s*\(|for\s*\(;;\)/i.test(code), '재시도 루프 없음');
  assert.ok(!/AD_DRAFTS\[[^\]]+\]\.(title|description)/.test(gen.replace(/\/\/.*$/gm, '')), '생성 결과에 고정 초안 제목·설명을 쓰지 않음(fallback 없음)');
});

test('AD6 정적: 유튜브 비공개 어댑터는 env·SDK·기본 fetch·OAuth 발급·공개/예약/삭제가 없고 고정 endpoint만', () => {
  const files = ['src/server/advertising/youtubePrivatePublisher.ts', 'src/server/advertising/youtubeAdPreparation.ts', 'src/server/advertising/boundedHttp.ts'];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    assert.match(src, /^import 'server-only';/, f);
    assert.ok(!/process\.env|googleapis'|from 'google|fetch\(|console\.|localStorage|setInterval|require\(|import\(|oauth2|refresh_token|client_secret/i.test(code), f);
  }
  const pub = readFileSync(files[0]!, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.deepEqual((pub.match(/https:\/\/[^'`]+/g) ?? []).sort(), [
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status',
    'https://www.googleapis.com/youtube/v3/channels?part=id&mine=true',
    'https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=',
  ]);
  assert.match(pub, /status: \{ privacyStatus: 'private' \}/);
  assert.ok(!/publishAt|privacyStatus: 'public'|privacyStatus: 'unlisted'|selfDeclaredMadeForKids|containsSyntheticMedia|videos\/delete|method: 'DELETE'|method: 'PUT'/.test(pub), '공개·예약·삭제·아동/합성 자동 판정 없음');
  const prep = readFileSync(files[1]!, 'utf8');
  assert.match(prep, /publicPublished: false, paidExecutionAllowed: false/);
});
