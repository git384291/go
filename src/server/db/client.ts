import 'server-only';
import postgres from 'postgres';
import { isLocalDatabaseUrl } from '../auth/adminAuthMode';

/**
 * 서버 전용 DB 연결 (Supabase 연결 풀러, 트랜잭션 모드).
 * - prepared statement 끔: 트랜잭션 모드 풀러는 연결 간 공유 불가
 * - SSL: CA 인증서로 서버 인증서 검증
 * - 역할은 트랜잭션 안에서만 전환(set local role)
 */
let client: postgres.Sql | null = null;

export function db(): postgres.Sql {
  if (client) return client;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const isLocal = isLocalDatabaseUrl(url); // 관리자 인증 스위치와 같은 판단(주소 해석 실패는 원격 취급)
  const ca = process.env.SUPABASE_DB_CA_CERT?.trim();
  if (!isLocal && !ca) throw new Error('SUPABASE_DB_CA_CERT is required for non-local databases');
  client = postgres(url, {
    prepare: false,
    ssl: isLocal ? false : { ca, rejectUnauthorized: true },
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return client;
}

const ROLE_SQL = {
  public: 'set local role app_public',
  staff: 'set local role app_staff',
  ai: 'set local role app_ai',
  adMonitor: 'set local role app_ad_monitor', // 0021 광고 정기 감시 전용(감시 함수 3개만)
  call: 'set local role app_call', // 0054~0056 통화 수신·변환·요약 작업 전용
} as const;

export type DbRole = keyof typeof ROLE_SQL;

export async function withRole<T>(role: DbRole, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return withRoleOn(db(), role, fn);
}

/** withRole과 같은 트랜잭션 배선. 통합 시험이 로컬 가상 DB 연결을 넘길 수 있도록 분리했다. */
export async function withRoleOn<T>(sql: postgres.Sql, role: DbRole, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(ROLE_SQL[role]); // 고정 문자열만 사용
    await tx.unsafe("set local statement_timeout = '5s'");
    await tx.unsafe("set local idle_in_transaction_session_timeout = '10s'");
    return fn(tx);
  }) as Promise<T>;
}
