// 시험용: 실제 DB에 저장된 시험 문구와 "총판 원문"(시험 가상 원문)의 대조를 한 번 실행한다(읽기 전용).
import postgres from 'postgres';
import { verifyNoticeSource } from '../../src/content/requiredNotices';

const sql = postgres(process.env.E2E_ADMIN_URL as string, { max: 1, onnotice: () => {} });
try {
  const rows = (await sql`select version, notice_key, body from core.notice_texts`) as unknown as { version: string; notice_key: string; body: string }[];
  const saved = rows.find((r) => r.version === 'next-e2e-v1' && r.notice_key === 'collection_purpose')?.body ?? '';
  const r = (src: Record<string, string>) => verifyNoticeSource('next-e2e-v1', rows, src).map((x) => `${x.key}:${x.result}`);
  console.log(JSON.stringify({ saved: saved !== '', same: r({ collection_purpose: saved }), crlf: r({ collection_purpose: ` ${saved}\r\n` }), ws: r({ collection_purpose: saved.replace(/ /g, '  ') }), diff: r({ collection_purpose: saved + '1' }), missing: r({ other_key: 'x' }) }));
} finally { await sql.end(); }
