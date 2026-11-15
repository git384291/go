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
