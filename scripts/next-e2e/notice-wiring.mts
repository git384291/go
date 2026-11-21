// 시험용: 화면 고지 상수 형식과 DB 문구(core.notice_texts) 대조를 실제 DB에서 한 번 실행한다(읽기 전용). 시험용 가상 문구만.
import postgres from 'postgres';
import { compareNoticeTexts, type NoticeConfig } from '../../src/content/requiredNotices';

const sql = postgres(process.env.E2E_ADMIN_URL as string, { max: 1, onnotice: () => {} });
try {
  const rows = (await sql`select version, notice_key, body from core.notice_texts`) as unknown as { version: string; notice_key: string; body: string }[];
  const fromDb = (v: string): NoticeConfig => ({ version: v, confirmed: true, items: rows.filter((r) => r.version === v).map((r) => ({ key: r.notice_key, title: '시험', body: r.body })) });
  const same = fromDb('privacy-test-v1');
  const edited: NoticeConfig = { ...same, items: same.items.map((n, i) => (i === 0 ? { ...n, body: n.body + ' (수정)' } : n)) };
  const dropped: NoticeConfig = { ...same, items: same.items.slice(1) };
  console.log(JSON.stringify({ n: same.items.length, same: compareNoticeTexts(same, rows), edited: compareNoticeTexts(edited, rows), dropped: compareNoticeTexts(dropped, rows), other: compareNoticeTexts({ ...same, version: 'privacy-none' }, rows) }));
} finally { await sql.end(); }
