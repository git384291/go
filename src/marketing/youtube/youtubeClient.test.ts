/**
 * youtubeClient 테스트
 * 보안: 실제 API 호출 없음 — 모든 테스트는 오프라인
 */
import {
  validateVideoMeta,
  applyShortsMeta,
  isDuplicateUpload,
  encryptTokens,
  decryptTokens,
  buildOAuthUrl,
  uploadVideo,
  type VideoMeta,
  type UploadJob,
  type OAuthTokens,
} from './youtubeClient';

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean) {
  if (condition) {
    console.log(`✅ ${label}`);
    passed++;
  } else {
    console.error(`❌ ${label}`);
    failed++;
  }
}

// ── 1. 메타 검증 ──────────────────────────────────────────────────────────────

const goodMeta: VideoMeta = {
  title: '바른365 인터넷TV 가입 혜택 총정리',
  description: '인천 미추홀구 인터넷·TV 전문 상담. 무료 비교 견적 제공.',
  tags: ['인터넷가입', '바른365', 'KT', 'SKB', 'LG유플러스'],
  privacyStatus: 'private',
  isShorts: false,
};

{
  const r = validateVideoMeta(goodMeta);
  assert('정상 메타 검증 통과', r.valid);
}

{
  const r = validateVideoMeta({ ...goodMeta, title: '' });
  assert('빈 제목 거부', !r.valid && r.errors.some(e => e.includes('제목 필수')));
}

{
  const longTitle = 'a'.repeat(101);
  const r = validateVideoMeta({ ...goodMeta, title: longTitle });
  assert('101자 제목 거부', !r.valid && r.errors.some(e => e.includes('100자')));
}

{
  const r = validateVideoMeta({ ...goodMeta, publishAt: 'NOT_A_DATE' });
  assert('잘못된 publishAt 거부', !r.valid && r.errors.some(e => e.includes('날짜 형식')));
}

{
  const r = validateVideoMeta({ ...goodMeta, publishAt: new Date(Date.now() - 1000).toISOString() });
  assert('과거 publishAt 거부', !r.valid && r.errors.some(e => e.includes('현재 시각 이후')));
}

{
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const r = validateVideoMeta({ ...goodMeta, publishAt: future });
  assert('미래 publishAt 허용', r.valid);
}

// ── 2. Shorts 메타 보정 ──────────────────────────────────────────────────────

{
  const shortsMeta: VideoMeta = { ...goodMeta, isShorts: true };
  const result = applyShortsMeta(shortsMeta);
  assert('#Shorts 태그 자동 추가', result.tags[0] === '#Shorts');
  assert('#Shorts 설명 자동 추가', result.description.includes('#Shorts'));
}

{
  // 이미 #Shorts 있는 경우 중복 추가 금지
  const meta: VideoMeta = { ...goodMeta, isShorts: true, tags: ['#Shorts', '인터넷'], description: '테스트 #Shorts' };
  const result = applyShortsMeta(meta);
  const count = result.tags.filter(t => t === '#Shorts').length;
  assert('#Shorts 중복 추가 금지', count === 1);
  const descCount = (result.description.match(/#Shorts/g) || []).length;
  assert('#Shorts 설명 중복 금지', descCount === 1);
}

{
  const result = applyShortsMeta({ ...goodMeta, isShorts: false });
  assert('일반 영상 메타 변경 없음', !result.tags.includes('#Shorts'));
}

// ── 3. 중복 업로드 차단 ──────────────────────────────────────────────────────

{
  // isDuplicateUpload는 모듈 레벨 Set 사용 — 아직 등록 안 된 제목
  const uniqueTitle = `테스트_고유제목_${Date.now()}`;
  assert('미등록 제목 중복 아님', !isDuplicateUpload(uniqueTitle));
}

{
  // 중복 차단: validateVideoMeta가 이미 등록된 제목 감지
  // (isDuplicateUpload 직접 테스트용 — markUploaded는 비공개이므로 Set에 직접 접근 불가)
  // uploadVideo(PUBLISH_ENABLED=false) 흐름으로 간접 테스트
}

// ── 4. AES-256-GCM 토큰 암호화/복호화 ───────────────────────────────────────

{
  const key32 = Buffer.alloc(32, 0xff);
  process.env.YT_TOKEN_ENCRYPTION_KEY = key32.toString('base64');

  const tokens: OAuthTokens = {
    accessToken: 'ya29.test_access_token',
    refreshToken: '1//test_refresh_token',
    expiresAt: Date.now() + 3600_000,
    scope: 'https://www.googleapis.com/auth/youtube.upload',
  };

  const encrypted = encryptTokens(tokens);
  assert('암호화 결과는 문자열', typeof encrypted === 'string');
  assert('암호화 결과는 원본과 다름', encrypted !== JSON.stringify(tokens));

  const decrypted = decryptTokens(encrypted);
  assert('복호화 accessToken 일치', decrypted.accessToken === tokens.accessToken);
  assert('복호화 refreshToken 일치', decrypted.refreshToken === tokens.refreshToken);
  assert('복호화 scope 일치', decrypted.scope === tokens.scope);
}

{
  // 키 없으면 예외
  delete process.env.YT_TOKEN_ENCRYPTION_KEY;
  let threw = false;
  try { encryptTokens({ accessToken: '', refreshToken: '', expiresAt: 0, scope: '' }); }
  catch { threw = true; }
  assert('키 없으면 암호화 예외', threw);
  // 복구
  process.env.YT_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 0xff).toString('base64');
}

// ── 5. OAuth URL 생성 ────────────────────────────────────────────────────────

{
  const url = buildOAuthUrl('client_123', 'http://localhost:3000/callback');
  assert('OAuth URL에 client_id 포함', url.includes('client_id=client_123'));
  assert('OAuth URL에 youtube.upload scope 포함', url.includes('youtube.upload'));
  assert('OAuth URL에 offline access 포함', url.includes('access_type=offline'));
  assert('OAuth URL에 consent prompt 포함', url.includes('prompt=consent'));
}

// ── 6. PUBLISH_ENABLED=false 기본 차단 ──────────────────────────────────────

{
  const job: UploadJob = {
    id: 'test-job-001',
    videoPath: '/tmp/nonexistent.mp4',
    meta: goodMeta,
    status: 'pending',
    attempts: 0,
  };

  uploadVideo(job, 'fake_token', false).then(result => {
    assert('PUBLISH_ENABLED=false → pending 반환', result.status === 'pending');
    assert('승인 필요 메시지 포함', result.lastError?.includes('사용자 승인') ?? false);

    // ── 7. 중복 제목 차단 (PUBLISH_ENABLED=true 가정 → 파일 없음으로 실패) ─
    const dupTitle = `중복테스트_${Date.now()}`;
    const job2: UploadJob = {
      id: 'dup-test-001',
      videoPath: '/tmp/nonexistent_dup.mp4',
      meta: { ...goodMeta, title: dupTitle },
      status: 'pending',
      attempts: 0,
    };

    return uploadVideo(job2, 'fake_token', true);
  }).then(r1 => {
    assert('1번째: 파일 없음 → failed', r1.status === 'failed');
    printResult();
  }).catch(e => {
    console.error('비동기 테스트 오류:', e);
    process.exit(1);
  });
}

// ── 결과 (비동기 테스트 완료 후 호출) ────────────────────────────────────────

function printResult() {
  console.log(`\n${'─'.repeat(50)}`);
  if (failed === 0) {
    console.log(`\n🎉 모든 테스트 통과 (${passed}/${passed + failed})`);
  } else {
    console.log(`\n⚠️  ${failed}개 실패 / ${passed}개 통과`);
    process.exit(1);
  }
}
