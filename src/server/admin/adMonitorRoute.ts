import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { adBudgetReady } from './adBudget';
import { adRunPlatform } from './adRun';
import { runAdMonitor, type MonitorTx } from './adMonitor';
import { withRole } from '../db/client';

// /api/internal/ad-monitor 처리(시험에서 env·실행 함수를 주입). 비밀은 32자 이상, 비교는 고정 시간.
const H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' };
const json = (b: unknown, status: number) => new Response(JSON.stringify(b), { status, headers: H });
const digest = (s: string) => createHash('sha256').update(s).digest();

export async function adMonitorHandler(req: Request, env: Readonly<Record<string, string | undefined>>, run: typeof runAdMonitor = runAdMonitor): Promise<Response> {
  const secret = env.AD_MONITOR_SECRET;
  let ready = false;
  try { ready = adBudgetReady(env); } catch { ready = false; }
  if (!ready || typeof secret !== 'string' || secret.length < 32) return json({ ok: false, code: 'MONITOR_DISABLED' }, 503);
  const auth = req.headers.get('authorization') ?? '';
  if (!timingSafeEqual(digest(auth), digest(`Bearer ${secret}`))) return json({ ok: false, code: 'UNAUTHORIZED' }, 401);
  const r = await run({
    platform: adRunPlatform(env), now: () => new Date(),
    runAsMonitor: (fn) => withRole('adMonitor', (tx) => fn(tx as unknown as MonitorTx)),
  });
  return json({ ok: r.ok, checked: r.checked, stopped: r.stopped, unknown: r.unknown, recorded: r.recorded }, r.ok ? 200 : 503);
}

