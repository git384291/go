import 'server-only';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { adBudgetReady } from './adBudget';
import { adRunPlatform } from './adRun';
import { runAdScheduler, type SchedulerTx } from './adScheduler';
import { withRole } from '../db/client';

// /api/internal/ad-scheduler 처리(시험에서 env·실행 함수를 주입). 외부 스케줄러(Cloud Scheduler·GitHub Actions 등 HTTP 호출)가 부른다.
// 비밀은 AD_SCHEDULER_SECRET 하나(32자 이상, 고정 시간 비교). 특정 호스팅의 자동 비밀(CRON_SECRET)은 쓰지 않는다.
const H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' };
const json = (b: unknown, status: number) => new Response(JSON.stringify(b), { status, headers: H });
const digest = (s: string) => createHash('sha256').update(s).digest();

export async function adSchedulerHandler(req: Request, env: Readonly<Record<string, string | undefined>>, run: typeof runAdScheduler = runAdScheduler): Promise<Response> {
  const secret = env.AD_SCHEDULER_SECRET;
  let ready = false;
  try { ready = adBudgetReady(env); } catch { ready = false; }
  if (!ready || typeof secret !== 'string' || secret.length < 32) return json({ ok: false, code: 'SCHEDULER_DISABLED' }, 503);
  if (req.method !== 'POST') return json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405);
  const auth = req.headers.get('authorization') ?? '';
  if (!timingSafeEqual(digest(auth), digest(`Bearer ${secret}`))) return json({ ok: false, code: 'UNAUTHORIZED' }, 401);
  const r = await run({
    platform: adRunPlatform(env), runId: randomUUID(),
    runAsScheduler: (fn) => withRole('adScheduler', (tx) => fn(tx as unknown as SchedulerTx)),
  });
  // 정상 아님(중지 실패·불명·판정 오류)은 503 — 스케줄러 로그에서 실패로 보인다(감시 실패 경고)
  return json({ ok: r.ok, code: r.code, campaign: r.campaign, reason: r.reason }, r.ok ? 200 : 503);
}
