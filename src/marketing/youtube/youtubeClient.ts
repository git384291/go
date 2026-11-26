/**
 * 바른통신365 — YouTube Data API v3 클라이언트
 * 보안: PUBLISH_ENABLED=false 기본 — 사용자 승인 전 실제 게시 금지
 * 과금·계정 생성·배포 금지
 * 구글 유료 광고 보류 유지 (광고 API 미사용)
 */

// ─── 타입 ─────────────────────────────────────────────────────────────────────

export type PrivacyStatus = 'private' | 'unlisted' | 'public';

export interface VideoMeta {
  title: string;           // 최대 100자
  description: string;    // 최대 5000자
  tags: string[];         // 각 태그 최대 500자, 합계 500자
  privacyStatus: PrivacyStatus;
  publishAt?: string;     // ISO 8601 — 예약 게시 (private → public 전환)
  isShorts: boolean;      // true면 #Shorts 태그 자동 추가 + 세로 영상 권고
  categoryId?: string;    // 기본 '22' (People & Blogs)
}

export interface UploadJob {
  id: string;             // 중복 방지용 고유 ID
  videoPath: string;      // 로컬 파일 경로
  meta: VideoMeta;
  status: 'pending' | 'uploading' | 'done' | 'failed' | 'duplicate';
  attempts: number;
  lastError?: string;
  youtubeVideoId?: string;
}

// ─── 중복 방지 레지스트리 ──────────────────────────────────────────────────────

const uploadedTitles = new Set<string>();

export function isDuplicateUpload(title: string): boolean {
  return uploadedTitles.has(title.trim().toLowerCase());
}

function markUploaded(title: string): void {
  uploadedTitles.add(title.trim().toLowerCase());
}

// ─── 메타 검증 ────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateVideoMeta(meta: VideoMeta): ValidationResult {
  const errors: string[] = [];

  if (!meta.title || meta.title.trim().length === 0)
    errors.push('제목 필수');
  if (meta.title.length > 100)
    errors.push(`제목 최대 100자 (현재 ${meta.title.length}자)`);
  if (meta.description.length > 5000)
    errors.push(`설명 최대 5000자 (현재 ${meta.description.length}자)`);

  const tagTotal = meta.tags.join(',').length;
  if (tagTotal > 500)
    errors.push(`태그 합계 최대 500자 (현재 ${tagTotal}자)`);

  if (meta.publishAt) {
    const pub = new Date(meta.publishAt);
    if (isNaN(pub.getTime()))
      errors.push('publishAt 날짜 형식 오류 (ISO 8601 필요)');
    else if (pub.getTime() <= Date.now())
      errors.push('publishAt은 현재 시각 이후여야 함');
  }

  if (isDuplicateUpload(meta.title))
    errors.push(`중복 제목 차단: "${meta.title}"`);

  return { valid: errors.length === 0, errors };
}

// ─── Shorts 메타 보정 ─────────────────────────────────────────────────────────

export function applyShortsMeta(meta: VideoMeta): VideoMeta {
  if (!meta.isShorts) return meta;
  const tags = [...meta.tags];
  if (!tags.includes('#Shorts')) tags.unshift('#Shorts');
  const description = meta.description.includes('#Shorts')
    ? meta.description
    : `${meta.description}\n\n#Shorts`;
  return { ...meta, tags, description };
}

// ─── OAuth 토큰 구조 (암호화 저장용) ─────────────────────────────────────────

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  scope: string;
}

/**
 * 토큰을 AES-256-GCM으로 암호화해 환경변수 키로 저장.
 * 실제 저장/복호화는 piiCrypto.ts 패턴 재사용 (DB 없이 env 기반).
 * 키: process.env.YT_TOKEN_ENCRYPTION_KEY (base64, 32바이트 이상)
 */
export function encryptTokens(tokens: OAuthTokens): string {
  const { createCipheriv, randomBytes } = require('node:crypto');
  const keyEnv = process.env.YT_TOKEN_ENCRYPTION_KEY;
  if (!keyEnv) throw new Error('YT_TOKEN_ENCRYPTION_KEY 환경변수 없음');
  const key = Buffer.from(keyEnv, 'base64');
  if (key.length < 32) throw new Error('YT_TOKEN_ENCRYPTION_KEY 32바이트 이상 필요');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.slice(0, 32), iv);
  const plain = Buffer.from(JSON.stringify(tokens), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv(12) + tag(16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptTokens(encrypted: string): OAuthTokens {
  const { createDecipheriv } = require('node:crypto');
  const keyEnv = process.env.YT_TOKEN_ENCRYPTION_KEY;
  if (!keyEnv) throw new Error('YT_TOKEN_ENCRYPTION_KEY 환경변수 없음');
  const key = Buffer.from(keyEnv, 'base64');
  const buf = Buffer.from(encrypted, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key.slice(0, 32), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as OAuthTokens;
}

// ─── OAuth URL 생성 (사용자가 브라우저에서 직접 인증) ────────────────────────

export function buildOAuthUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube',
    ].join(' '),
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// ─── 토큰 갱신 ───────────────────────────────────────────────────────────────

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`토큰 갱신 실패: ${res.status} ${body}`);
  }
  const data = await res.json() as { access_token: string; expires_in: number };
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

// ─── 업로드 (resumable upload) ────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * YouTube resumable upload.
 * PUBLISH_ENABLED=false(기본)면 실제 업로드 없이 'pending' 반환.
 * 사용자 승인 후에만 true로 변경 가능.
 */
export async function uploadVideo(
  job: UploadJob,
  accessToken: string,
  PUBLISH_ENABLED = false,
): Promise<UploadJob> {
  // 1. 승인 전 차단
  if (!PUBLISH_ENABLED) {
    return { ...job, status: 'pending', lastError: '사용자 승인 필요 — 실제 업로드 금지' };
  }

  // 2. 중복 체크
  if (isDuplicateUpload(job.meta.title)) {
    return { ...job, status: 'duplicate', lastError: `중복 제목 차단: "${job.meta.title}"` };
  }

  // 3. 메타 검증
  const finalMeta = applyShortsMeta(job.meta);
  const validation = validateVideoMeta(finalMeta);
  if (!validation.valid) {
    return { ...job, status: 'failed', lastError: validation.errors.join('; ') };
  }

  // 4. 파일 읽기
  const { readFileSync, statSync } = require('node:fs');
  let fileBuffer: Buffer;
  let fileSize: number;
  try {
    fileSize = statSync(job.videoPath).size;
    fileBuffer = readFileSync(job.videoPath);
  } catch (e) {
    return { ...job, status: 'failed', lastError: `파일 읽기 실패: ${e}` };
  }

  // 5. resumable upload 시작 요청
  const snippet = {
    title: finalMeta.title,
    description: finalMeta.description,
    tags: finalMeta.tags,
    categoryId: finalMeta.categoryId ?? '22',
  };
  const status: Record<string, unknown> = { privacyStatus: finalMeta.privacyStatus };
  if (finalMeta.publishAt) status.publishAt = finalMeta.publishAt;

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    attempt++;
    try {
      // 업로드 세션 초기화
      const initRes = await fetch(
        'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'X-Upload-Content-Type': 'video/*',
            'X-Upload-Content-Length': String(fileSize),
          },
          body: JSON.stringify({ snippet, status }),
        },
      );

      if (!initRes.ok) {
        const body = await initRes.text();
        if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS); continue; }
        return { ...job, status: 'failed', attempts: attempt, lastError: `업로드 초기화 실패: ${initRes.status} ${body}` };
      }

      const uploadUrl = initRes.headers.get('Location');
      if (!uploadUrl) {
        return { ...job, status: 'failed', attempts: attempt, lastError: 'Location 헤더 없음' };
      }

      // 실제 업로드
      const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'video/*',
          'Content-Length': String(fileSize),
        },
        body: fileBuffer,
      });

      if (uploadRes.ok || uploadRes.status === 201) {
        const data = await uploadRes.json() as { id: string };
        markUploaded(finalMeta.title);
        return { ...job, status: 'done', attempts: attempt, youtubeVideoId: data.id };
      }

      if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS); continue; }
      const errBody = await uploadRes.text();
      return { ...job, status: 'failed', attempts: attempt, lastError: `업로드 실패: ${uploadRes.status} ${errBody}` };

    } catch (e) {
      if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS); continue; }
      return { ...job, status: 'failed', attempts: attempt, lastError: `예외: ${e}` };
    }
  }

  return { ...job, status: 'failed', attempts: attempt, lastError: '최대 재시도 초과' };
}
