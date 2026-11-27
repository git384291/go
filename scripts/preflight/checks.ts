/**
 * 출시 설정 사전 점검(읽기 전용). 환경 변수의 '존재 여부와 허용 형식'만 판정한다.
 * - 값·URL 원문·쿼리·토큰·키·개인정보를 결과에 싣지 않는다(이름과 상태, 고정 안내 문구만).
 * - 네트워크 호출·DB 접속·쓰기·계정/키 생성·데이터 수집을 하지 않는다.
 * - 전체 통과도 실제 Supabase Auth 설정·풀러·CA 연결·개인정보 처리 적합성·광고 계정 인증을 검증한 것이 아니다(UNVERIFIABLE 항목).
 */
import { isPublicDnsHost, publicSiteOrigin, searchIndexingAllowed } from '../../src/content/seo';
import { ADMIN_AUTH_REQUIRED_ENV, adminAuthMode } from '../../src/server/auth/adminAuthMode';
import { EXTERNAL_CONSULT_ENABLED } from '../../src/content/channels';
import { UTM_REGISTRY, validateRegistry } from '../../src/content/utm';
import { signingKeyFromEnv } from '../../src/server/security/token';
import { REQUIRED_NOTICES, noticeReadiness } from '../../src/content/requiredNotices';
import { leadIntakeGate } from '../../src/server/leads/intake';

export type Status = 'OK' | 'MISSING' | 'INVALID' | 'POLICY' | 'OFF' | 'UNVERIFIABLE' | 'INFO';
export type Check = { id: string; area: string; name: string; status: Status; note: string; where?: string };
type Env = Record<string, string | undefined>;

const VERCEL_ENV_SCREEN = 'Vercel 프로젝트 → Settings → Environment Variables(해당 환경). 필요 권한: 그 프로젝트의 환경 변수를 수정할 수 있는 팀 멤버 권한';
const SUPABASE_DB_SCREEN = 'Supabase 프로젝트 → Project Settings → Database(연결 정보·SSL 인증서). 필요 권한: 프로젝트 Owner 또는 Admin';
const SUPABASE_AUTH_SCREEN = 'Supabase 프로젝트 → Authentication 설정(가입·MFA·세션·URL·JWT 키). 필요 권한: 프로젝트 Owner 또는 Admin';
const MENU_NOTE = ' (메뉴 이름은 서비스 변경으로 다를 수 있음)';

const has = (env: Env, k: string) => (env[k] ?? '').trim() !== '';

/** 광고·상담 목적지(총판 공식 접수 경로 등): https 공개 도메인, 쿼리·조각 없음, FIDEON 내부 경로 아님 */
export function destinationStatus(env: Env): { status: Status; note: string } {
  const raw = (env.LAUNCH_INTAKE_DESTINATION ?? '').trim();
  if (!raw) return { status: 'MISSING', note: '확보된 공식 접수 경로 없음 → 광고 예약·게시·집행 대기' };
  let u: URL;
  try { u = new URL(raw); } catch { return { status: 'INVALID', note: 'URL 형식 아님' }; }
  if (u.protocol !== 'https:') return { status: 'INVALID', note: 'https만 허용' };
  if (u.username || u.password || u.port) return { status: 'INVALID', note: '사용자 정보·포트 포함 불가' };
  if (u.search || u.hash) return { status: 'INVALID', note: '쿼리·조각 포함 불가(추적값은 등록된 UTM으로 광고 매체에서 붙임)' };
  if (!isPublicDnsHost(u.hostname)) return { status: 'INVALID', note: '공개 도메인 아님(IP·내부·예약 이름)' };
  const own = publicSiteOrigin(env);
  if (own && u.origin === own && /^\/(consult|api|admin)(\/|$)/.test(u.pathname)) {
    return { status: 'POLICY', note: 'FIDEON 비활성 접수·관리 경로로 보내지 않음' };
  }
  return { status: 'INFO', note: '형식만 확인됨 — 실제 총판 공식 경로인지·동작하는지는 미확인' };
}

export function runChecks(env: Env, files: { layoutSource: string }): Check[] {
  const c: Check[] = [];
  const add = (x: Check) => c.push(x);

  // 1. 공식 주소·검색
  const origin = publicSiteOrigin(env);
  add({ id: 'P1', area: '검색', name: '공식 주소 PUBLIC_SITE_ORIGIN', status: !has(env, 'PUBLIC_SITE_ORIGIN') ? 'MISSING' : origin ? 'OK' : 'INVALID',
    note: !has(env, 'PUBLIC_SITE_ORIGIN') ? '도메인 미확정 → canonical·sitemap 없음(정상 대기)' : origin ? '형식 통과(소유권 검증 아님)' : 'https 공개 도메인 원본만 허용',
    where: VERCEL_ENV_SCREEN + MENU_NOTE });
  const layoutNoindex = /robots: \{ index: false, follow: false \}/.test(files.layoutSource);
  add({ id: 'P2', area: '검색', name: '검색 노출', status: 'OFF',
    note: `${searchIndexingAllowed(env) ? 'robots·sitemap 허용 조건 충족' : 'robots 전체 차단'}, layout noindex ${layoutNoindex ? '유지' : '해제됨(검수 필요)'} — 공개는 PM 승인 변경안 적용 후` });
  if (!layoutNoindex) c[c.length - 1].status = 'POLICY';

  // 2. 광고·상담 목적지
  const d = destinationStatus(env);
  add({ id: 'P3', area: '광고', name: '광고·상담 목적지 LAUNCH_INTAKE_DESTINATION', ...d, where: VERCEL_ENV_SCREEN + MENU_NOTE });
  let utm: Status = 'OK';
  try { validateRegistry(UTM_REGISTRY); } catch { utm = 'INVALID'; }
  add({ id: 'P4', area: '광고', name: 'UTM 등록부', status: utm, note: `등록 ${UTM_REGISTRY.length}개(미등록 값은 버림)` });
  add({ id: 'P5', area: '광고', name: '광고 계정·매체 자격·플랫폼 강제 예산 한도', status: 'UNVERIFIABLE', note: '이 점검으로 확인 불가(연동 없음). 계정이 있다고 가정하지 않음' });

  // 3. 공개·수집 스위치(현재 정책: 모두 꺼짐)
  const gate = leadIntakeGate(env);
  add({ id: 'P6', area: '수집', name: '서버 접수 LEAD_INTAKE_MODE', status: gate.enabled ? 'POLICY' : 'OFF', note: gate.enabled ? '열려 있음 — 개방 승인 없음' : '꺼짐(정책대로)' });
  const formOn = env.NEXT_PUBLIC_LEAD_FORM_ENABLED === 'true';
  add({ id: 'P7', area: '수집', name: '화면 접수 양식 NEXT_PUBLIC_LEAD_FORM_ENABLED', status: formOn ? 'POLICY' : 'OFF', note: formOn ? '켜짐 — 개방 승인 없음' : '꺼짐(정책대로)' });
  add({ id: 'P8', area: '수집', name: '외부 상담 채널(코드 상수)', status: EXTERNAL_CONSULT_ENABLED ? 'POLICY' : 'OFF', note: EXTERNAL_CONSULT_ENABLED ? '켜짐 — 승인 없음' : '꺼짐(정책대로)' });
  add({ id: 'P9', area: '수집', name: '개인정보 처리 주체·목적·보존·총판 제공 동의', status: 'UNVERIFIABLE', note: '문서·법적 검토 사항. 이 점검으로 확인 불가' });

  // 3. 필수 고지 문구·버전 연결(문구 비노출, 사유 코드만)
  const nr = noticeReadiness(REQUIRED_NOTICES, (env.PRIVACY_POLICY_VERSION ?? '').trim());
  add({ id: 'N1', area: '고지', name: '필수 고지 확정 여부(코드 상수 REQUIRED_NOTICES)', status: nr.ready ? 'INFO' : 'POLICY', note: nr.ready ? '확정됨·형식 OK — 접수 개방은 별도 승인 필요' : `미확정/불완전(${nr.reason}) — 접수 차단 유지` });
  add({ id: 'N2', area: '고지', name: '처리방침 버전 PRIVACY_POLICY_VERSION', status: !has(env, 'PRIVACY_POLICY_VERSION') ? 'MISSING' : REQUIRED_NOTICES.version !== '' && REQUIRED_NOTICES.version === (env.PRIVACY_POLICY_VERSION ?? '').trim() ? 'OK' : 'POLICY', note: !has(env, 'PRIVACY_POLICY_VERSION') ? '없음' : REQUIRED_NOTICES.version === (env.PRIVACY_POLICY_VERSION ?? '').trim() && REQUIRED_NOTICES.version !== '' ? '고지 버전과 일치' : '고지 버전과 불일치 또는 고지 미확정' });
  add({ id: 'N3', area: '고지', name: '화면 고지 문구 = DB core.notice_texts 문구', status: 'UNVERIFIABLE', note: '이 점검은 DB에 접속하지 않음. DB 대조는 compareNoticeTexts(시험: tests/unit, next-e2e N15)로 하며, 실제 확정 문구·버전은 DB에 같은 값을 넣은 뒤 대조' });

  // 4. 관리자 인증
  const mode = adminAuthMode(env);
  add({ id: 'A1', area: '인증', name: '관리자 인증 스위치 ADMIN_AUTH_MODE', status: mode === 'supabase' ? 'INFO' : 'OFF', note: mode === 'supabase' ? '켜짐 조건 충족(운영은 항상 꺼짐)' : '꺼짐' });
  for (const k of ADMIN_AUTH_REQUIRED_ENV) {
    add({ id: `A2:${k}`, area: '인증', name: `필수값 ${k}`, status: has(env, k) ? 'OK' : 'MISSING', note: has(env, k) ? '있음(값 미표시)' : '없음',
      where: (k.startsWith('NEXT_PUBLIC_SUPABASE') ? 'Supabase 프로젝트 → Project Settings → API에서 확인 후 ' : '') + VERCEL_ENV_SCREEN + MENU_NOTE });
  }
  if (has(env, 'FIDEON_STAFF_SIGNING_KEY')) {
    let ok = true;
    try { signingKeyFromEnv('staff', env as NodeJS.ProcessEnv); } catch { ok = false; } // 형식만 확인(Next가 ProcessEnv에 NODE_ENV를 필수로 추가)
    add({ id: 'A3', area: '인증', name: '직원 서명 키 형식', status: ok ? 'OK' : 'INVALID', note: ok ? '<key_id>:<base64 32바이트 이상> 형식(값 미표시). DB server_keys와 일치 여부는 미확인' : '형식 오류' });
  }
  if (has(env, 'NEXT_PUBLIC_SUPABASE_URL')) {
    let ok = false;
    try { const u = new URL(env.NEXT_PUBLIC_SUPABASE_URL!.trim()); ok = u.protocol === 'https:' && isPublicDnsHost(u.hostname) && !u.search && (u.pathname === '/' || u.pathname === ''); } catch { ok = false; }
    add({ id: 'A4', area: '인증', name: 'Supabase URL 형식', status: ok ? 'OK' : 'INVALID', note: ok ? 'https 공개 도메인 원본' : 'https 원본 형식 아님' });
  }
  add({ id: 'A5', area: '인증', name: 'Auth 대시보드 설정(가입 차단·TOTP·세션 time-box·비밀번호·redirect·JWT 키)', status: 'UNVERIFIABLE',
    note: '체크리스트 D3~D8. 이 점검으로 확인 불가', where: SUPABASE_AUTH_SCREEN + MENU_NOTE });

  // 4-1. 봇 확인(Turnstile) 연결 준비 — 존재·형식만(값 미표시, 네트워크 호출 없음)
  const CF_SCREEN = 'Cloudflare 대시보드 → Turnstile → 사이트 설정(사이트 키·비밀 키·허용 호스트명). 필요 권한: 그 계정의 Turnstile 편집 권한';
  add({ id: 'T1', area: '봇 확인', name: '비밀 키 TURNSTILE_SECRET_KEY(서버 전용)', status: has(env, 'TURNSTILE_SECRET_KEY') ? 'OK' : 'MISSING', note: has(env, 'TURNSTILE_SECRET_KEY') ? '있음(값 미표시)' : '없음 — 없으면 서버가 모든 접수를 거부', where: CF_SCREEN + MENU_NOTE });
  add({ id: 'T2', area: '봇 확인', name: '사이트 키 NEXT_PUBLIC_TURNSTILE_SITE_KEY(화면용 공개 키)', status: has(env, 'NEXT_PUBLIC_TURNSTILE_SITE_KEY') ? 'OK' : 'MISSING', note: has(env, 'NEXT_PUBLIC_TURNSTILE_SITE_KEY') ? '있음(값 미표시)' : '없음 — 없으면 접수 양식이 꺼진 채로 남음', where: CF_SCREEN + MENU_NOTE });
  if (!has(env, 'PUBLIC_HOSTNAME')) add({ id: 'T3', area: '봇 확인', name: '기대 호스트명 PUBLIC_HOSTNAME', status: 'MISSING', note: '없음 — 없으면 확인 결과가 항상 거부됨', where: VERCEL_ENV_SCREEN + MENU_NOTE });
  else {
    const h = env.PUBLIC_HOSTNAME!.trim();
    const okHost = !/[/:@?#\s]/.test(h) && isPublicDnsHost(h.toLowerCase());
    add({ id: 'T3', area: '봇 확인', name: '기대 호스트명 PUBLIC_HOSTNAME', status: okHost ? 'OK' : 'INVALID', note: okHost ? '호스트명 형식(스킴·경로·포트 없음). Cloudflare가 돌려주는 hostname과 같아야 함' : '호스트명만 적어야 함(스킴·경로·포트·로컬 주소 불가)' });
  }
  add({ id: 'T4', area: '봇 확인', name: '시험 전용 TURNSTILE_VERIFY_URL_TEST', status: has(env, 'TURNSTILE_VERIFY_URL_TEST') ? 'INVALID' : 'OK', note: has(env, 'TURNSTILE_VERIFY_URL_TEST') ? '시험 전용 값이 설정됨 — 배포 환경에 두지 않음(운영 빌드는 무시하지만 제거해야 함)' : '설정 없음' });
  add({ id: 'T5', area: '봇 확인', name: 'Cloudflare 위젯 설정(허용 호스트명·action lead_form·모드)', status: 'UNVERIFIABLE', note: '이 점검으로 확인 불가(연동 없음)', where: CF_SCREEN + MENU_NOTE });

  // 4-2. AI·광고 실제 연결 전 보안 점검 — 키가 이미 들어 있거나 스위치가 켜져 있으면 알린다(값 미표시)
  const pubSecret = Object.keys(env).filter((k) => /^NEXT_PUBLIC_.*(SERVICE_ROLE|SECRET|PRIVATE|API_KEY|TOKEN|PASSWORD)/i.test(k) && has(env, k));
  add({ id: 'S1', area: '보안', name: '브라우저 공개 변수(NEXT_PUBLIC_*)에 비밀 이름이 없음', status: pubSecret.length ? 'INVALID' : 'OK', note: pubSecret.length ? `비밀로 보이는 공개 변수 ${pubSecret.length}개(이름: ${pubSecret.join(', ')}) — 즉시 서버 전용 이름으로 옮김` : '없음' });
  const keysSet = ['CONSULT_AI_API_KEY', 'AD_API_KEY', 'OPENAI_API_KEY', 'AD_PLATFORM_API_KEY'].filter((k) => has(env, k));
  add({ id: 'S2', area: '보안', name: 'AI·광고 API 키 설정 여부(서버 전용)', status: keysSet.length ? 'POLICY' : 'OFF', note: keysSet.length ? `키 ${keysSet.length}개 설정됨(이름: ${keysSet.join(', ')}) — 실제 연결 승인 없음. 어댑터가 없어 사용되지 않음` : '없음(정책대로)' });
  add({ id: 'S3', area: '보안', name: '광고 실제 집행 스위치 AD_EXECUTION_ENABLED', status: env.AD_EXECUTION_ENABLED === 'true' ? 'POLICY' : 'OFF', note: env.AD_EXECUTION_ENABLED === 'true' ? '켜짐 — 집행 승인 없음' : '꺼짐(정책대로)' });
  const model = (env.CONSULT_AI_MODEL ?? '').trim();
  add({ id: 'S4', area: '보안', name: '상담 AI 모델 CONSULT_AI_MODEL', status: model === '' ? 'OFF' : model === 'mock' ? 'INFO' : 'INVALID', note: model === '' ? '없음(담당자 확인 안내문만)' : model === 'mock' ? '무료 모의 모델' : '지원하는 어댑터가 없는 값(모델 없음으로 처리됨)' });
  const b64len = (v: string | undefined) => (v && /^[A-Za-z0-9+/=]+$/.test(v) ? Buffer.from(v, 'base64').length : 0);
  let piiOk = false;
  try { const m = JSON.parse(env.PII_ENC_KEYS ?? '{}') as Record<string, string>; piiOk = Object.keys(m).length > 0 && (env.PII_ENC_CURRENT ?? '') in m && Object.values(m).every((k) => b64len(k) === 32) && b64len(env.PII_HMAC_KEY) >= 32 && b64len(env.PII_IP_HASH_KEY) >= 32; } catch { piiOk = false; }
  const piiAny = has(env, 'PII_ENC_KEYS') || has(env, 'PII_HMAC_KEY') || has(env, 'PII_IP_HASH_KEY');
  add({ id: 'S5', area: '보안', name: '개인정보 암호화 키(PII_ENC_KEYS·PII_ENC_CURRENT·PII_HMAC_KEY·PII_IP_HASH_KEY)', status: !piiAny ? 'MISSING' : piiOk ? 'OK' : 'INVALID', note: !piiAny ? '없음 — 없으면 접수 저장이 실패' : piiOk ? '형식 OK(암호화 키 32바이트, 해시 키 32바이트 이상, 현재 버전 존재). 값 미표시' : '형식 오류' });
  add({ id: 'S6', area: '보안', name: '상담 세션 서명 키 CONSULT_SESSION_KEY', status: !has(env, 'CONSULT_SESSION_KEY') ? 'MISSING' : b64len(env.CONSULT_SESSION_KEY) >= 32 ? 'OK' : 'INVALID', note: !has(env, 'CONSULT_SESSION_KEY') ? '없음 — 없으면 AI 상담 경로가 닫힘' : b64len(env.CONSULT_SESSION_KEY) >= 32 ? 'base64 32바이트 이상(값 미표시)' : '형식 오류' });

  // 4-3. 관리자 데이터 출처 스위치 — 로컬 폐기 시험 DB 전용. 배포 환경에 있으면 안 된다(있어도 코드가 닫지만 제거해야 함)
  for (const k of ['ADMIN_LEADS_SOURCE', 'ADMIN_POLICY_SOURCE', 'ADMIN_AD_SOURCE', 'ADMIN_CRM_SOURCE']) {
    const v = (env[k] ?? '').trim();
    add({ id: `R:${k}`, area: '출처', name: `${k}(로컬 시험 DB 전용)`, status: v === 'db' ? 'POLICY' : 'OFF', note: v === 'db' ? '배포 환경에 db가 설정됨 — 제거. 지정된 로컬 폐기 시험 DB 밖에서는 서버가 503으로 닫지만 설정 자체를 두지 않음' : '미설정 또는 mock(정책대로)' });
  }

  // 5. DB 연결 설정
  if (!has(env, 'DATABASE_URL')) {
    add({ id: 'D1', area: 'DB', name: 'DATABASE_URL', status: 'MISSING', note: '없음', where: SUPABASE_DB_SCREEN + MENU_NOTE });
  } else {
    let u: URL | null = null;
    try { u = new URL(env.DATABASE_URL!.trim()); } catch { u = null; }
    const proto = u && (u.protocol === 'postgres:' || u.protocol === 'postgresql:');
    const local = !!u && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
    add({ id: 'D1', area: 'DB', name: 'DATABASE_URL 형식', status: proto && u!.hostname ? (local ? 'INFO' : 'OK') : 'INVALID',
      note: !proto ? 'postgres:// 형식 아님' : local ? '로컬 가상 DB(운영·개발 원격 아님)' : '원격 DB 형식(값 미표시). 실제 접속·풀러 모드는 미확인' });
    if (proto && !local) {
      const ca = env.SUPABASE_DB_CA_CERT ?? '';
      const certs = (ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).length;
      add({ id: 'D2', area: 'DB', name: 'CA 인증서 SUPABASE_DB_CA_CERT', status: !ca.trim() ? 'MISSING' : certs > 0 ? 'OK' : 'INVALID',
        note: !ca.trim() ? '원격 DB에는 필수(서버 인증서 검증)' : certs > 0 ? `PEM 인증서 ${certs}개 형식(내용 미표시). 실제 검증 성공은 미확인(D10)` : 'PEM 형식 아님',
        where: SUPABASE_DB_SCREEN + MENU_NOTE });
    }
  }
  add({ id: 'D3', area: 'DB', name: '풀러 set local role·CA 실제 검증·release_auditor 실접속', status: 'UNVERIFIABLE', note: '체크리스트 D2·D9·D10. 실제 연결 시험 필요' });
  return c;
}

export function renderChecks(checks: Check[]): string {
  const lines = checks.map((x) => `${x.status.padEnd(12)} ${x.id.padEnd(30)} [${x.area}] ${x.name} — ${x.note}${x.where && (x.status === 'MISSING' || x.status === 'INVALID') ? `\n${' '.repeat(13)}설정 위치: ${x.where}` : ''}`);
  const count = (s: Status) => checks.filter((x) => x.status === s).length;
  lines.push('', `요약: OK ${count('OK')} · MISSING ${count('MISSING')} · INVALID ${count('INVALID')} · POLICY ${count('POLICY')} · OFF ${count('OFF')} · UNVERIFIABLE ${count('UNVERIFIABLE')} · INFO ${count('INFO')}`);
  lines.push('주의: 이 결과는 설정의 존재·형식 점검이다. 실제 Auth·풀러·CA·개인정보 적합성·광고 계정·총판 경로를 검증하지 않았다.');
  return lines.join('\n');
}
