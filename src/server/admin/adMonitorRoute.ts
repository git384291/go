import 'server-only';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { adBudgetReady } from './adBudget';
import { adRunPlatform } from './adRun';
import { runAdMonitor, type MonitorTx } from './adMonitor';
import { withRole } from '../db/client';

// /api/internal/ad-monitor 처리(시험에서 env·실행 함수를 주입). 비밀은 32자 이상, 비교는 고정 시간.
const H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' };
const json = (b: unknown, status: number) => new Response(JSON.stringify(b), { status, headers: H });
const digest = (s: string) => createHash('sha256').update(s).digest();

export async function adMonitorHandler(req: Request, env: Readonly<Record<string, string | undefined>>, run: typeof runAdMonitor = runAdMonitor): Promise<Response> {
  // AD_MONITOR_SECRET(직접 호출) 또는 CRON_SECRET(Vercel Cron이 'Authorization: Bearer <CRON_SECRET>'로 자동 전송). 32자 이상만 사용
  const secret = env.AD_MONITOR_SECRET || env.CRON_SECRET;
  let ready = false;
  try { ready = adBudgetReady(env); } catch { ready = false; }
  if (!ready || typeof secret !== 'string' || secret.length < 32) return json({ ok: false, code: 'MONITOR_DISABLED' }, 503);
  const auth = req.headers.get('authorization') ?? '';
  if (!timingSafeEqual(digest(auth), digest(`Bearer ${secret}`))) return json({ ok: false, code: 'UNAUTHORIZED' }, 401);
  const r = await run({
    platform: adRunPlatform(env), now: () => new Date(), runId: randomUUID(),
    runAsMonitor: (fn) => withRole('adMonitor', (tx) => fn(tx as unknown as MonitorTx)),
  });
  // 중복 회차는 409(아무것도 안 함). 정상 아님은 503 — 스케줄러 로그에서 실패로 보인다
  return json({ ok: r.ok, busy: r.busy, checked: r.checked, stopped: r.stopped, unknown: r.unknown, recorded: r.recorded }, r.ok ? 200 : r.busy ? 409 : 503);
}

