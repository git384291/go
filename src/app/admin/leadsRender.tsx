import type { ReactElement, ReactNode } from 'react';
import type { AdminAuthMode } from '@/server/auth/adminAuthMode';
import { StaffAuthError } from '@/server/auth/staffAssertion';
import type { StaffIdentity } from '@/server/auth/staffSession';
import { listMaskedLeads, type TxRunner } from '@/server/admin/leadsReadStore';
import { dbReadReady, leadsSource } from '@/server/admin/leadsSource';
import { LeadsReadLocked, LeadsReadView } from './LeadsReadView';

/**
 * /admin 응답 결정(시험용으로 분리, PM 6915664371). 의존성은 page.tsx가 서버 기본값으로 넘긴다(요청으로 주입 불가).
 * - mock(기본·미설정): 기존 화면 그대로(인증 꺼짐이면 로컬 개발 서버에서만 가상 화면, 켜지면 requireStaff 뒤 가상 화면)
 * - invalid·db: mock 화면으로 대체하지 않는다. 인증 꺼짐·준비 미충족·권한 없음·장애에서는 잠금·실패 화면만(행 데이터 로드·직렬화 없음)
 * - db + 준비됨 + owner·counselor: 기존 마스킹 어댑터로 7키 DTO만 읽어 읽기 전용 목록
 * 페이지 인자는 offset 하나(숫자만), 페이지 크기는 고정. role·actor·token은 query에서 받지 않는다.
 */
export const PAGE_SIZE = 20;
type Env = Readonly<Record<string, string | undefined>>;

export type AdminLeadsPageDeps = {
  env: () => Env;
  mode: () => AdminAuthMode;
  mockVisible: () => boolean;
  requireStaff: () => Promise<StaffIdentity>;
  runInTransaction: TxRunner;
  searchParams: Readonly<Record<string, string | string[] | undefined>>;
  headerExtra: (role: StaffIdentity['role']) => ReactNode;
  mockView: (headerExtra?: ReactNode) => ReactElement;
};

export type AdminLeadsPageResult = { redirect: '/admin/login' } | { element: ReactElement };

function offsetFrom(sp: AdminLeadsPageDeps['searchParams']): number | null {
  const v = sp.offset;
  if (v === undefined) return 0;
  if (typeof v !== 'string' || !/^\d{1,6}$/.test(v)) return null;
  const n = Number(v);
  return n <= 100_000 && n % PAGE_SIZE === 0 ? n : null;
}

export async function renderAdminLeads(deps: AdminLeadsPageDeps): Promise<AdminLeadsPageResult> {
  let source: 'mock' | 'db' | 'invalid' = 'invalid';
  let ready = false;
  try {
    const env = deps.env();
    source = leadsSource(env);
    ready = dbReadReady(env);
  } catch {
    source = 'invalid';
  }

  if (source === 'mock') {
    // 기존 동작 그대로
    if (deps.mode() === 'disabled') {
      if (!deps.mockVisible()) return { element: <main className="admin-locked">관리자 화면은 인증 연결 후 열립니다.</main> };
      return { element: deps.mockView() };
    }
    let role: StaffIdentity['role'] | null = null;
    try {
      role = (await deps.requireStaff()).role;
    } catch {
      role = null;
    }
    if (!role) return { redirect: '/admin/login' };
    return { element: deps.mockView(deps.headerExtra(role)) };
  }

  if (source === 'invalid') return { element: <LeadsReadLocked kind="source" /> };
  if (!ready) return { element: <LeadsReadLocked kind="not_ready" /> };
  let mode: AdminAuthMode = 'disabled';
  try {
    mode = deps.mode();
  } catch {
    mode = 'disabled';
  }
  if (mode !== 'supabase') return { element: <LeadsReadLocked kind="auth_off" /> };

  let who: StaffIdentity;
  try {
    who = await deps.requireStaff();
  } catch (e) {
    if (e instanceof StaffAuthError && e.status === 401) return { redirect: '/admin/login' };
    if (e instanceof StaffAuthError) return { element: <LeadsReadLocked kind="forbidden" /> };
    return { element: <LeadsReadLocked kind="failed" /> };
  }
  const header = deps.headerExtra(who.role);
  if (who.role !== 'owner' && who.role !== 'counselor') return { element: <LeadsReadLocked kind="forbidden" headerExtra={header} /> };

  const offset = offsetFrom(deps.searchParams);
  if (offset === null) return { element: <LeadsReadLocked kind="failed" headerExtra={header} /> };

  let result;
  try {
    result = await listMaskedLeads({ enabled: () => true, runInTransaction: deps.runInTransaction }, who, { limit: PAGE_SIZE, offset });
  } catch {
    return { element: <LeadsReadLocked kind="failed" headerExtra={header} /> };
  }
  if (!result.ok) {
    return { element: <LeadsReadLocked kind={result.code === 'FORBIDDEN' ? 'forbidden' : 'failed'} headerExtra={header} /> };
  }
  return { element: <LeadsReadView items={result.items} actor={who.actor} offset={offset} limit={PAGE_SIZE} headerExtra={header} /> };
}
