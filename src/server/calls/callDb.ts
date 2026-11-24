import 'server-only';
import { withRole } from '../db/client';
import type { CallIngestArgs } from './ingest';
import type { SttClaim } from './stt';
import type { SummaryClaim, SummaryValue } from './summary';

/**
 * 통화 작업 DB 연결(app_call 역할 함수만, AI 비용은 app_ai 역할). 운영 실행(스케줄러·웹훅 라우트 연결)은 PM 승인 전 금지 —
 * 이 파일은 배선만 제공하고 어떤 라우트·예약 작업에도 아직 연결하지 않았다.
 */
export async function dbCallIngest(token: string, a: CallIngestArgs): Promise<string> {
  const rows = await withRole('call', (tx) => tx`select api.call_ingest(${token}, ${a.provider}, ${a.providerCallId}, ${a.direction},
    ${a.phoneHmac}, ${a.startedEpoch}::bigint, ${a.durationSec}::int, ${a.noticeVersion}, ${a.storagePath}, ${a.audioSha256},
    ${a.audioBytes}::int, ${a.keyVersion}, ${a.agentId}::uuid) as r`);
  return String((rows as unknown as { r: string }[])[0].r);
}

export async function dbSttClaim(): Promise<SttClaim | null> {
  const rows = (await withRole('call', (tx) => tx`select * from api.call_stt_claim()`)) as unknown as Record<string, unknown>[];
  const r = rows[0];
  if (!r) return null;
  return {
    jobId: String(r.job_id), leaseToken: String(r.lease_token), callId: String(r.call_id), storagePath: String(r.storage_path),
    audioSha256: String(r.audio_sha256), keyVersion: String(r.key_version), durationSec: Number(r.duration_sec), reservedKrw: Number(r.reserved_krw),
  };
}

export async function dbSttComplete(c: SttClaim, enc: string, masked: string, provider: string, actualKrw: number): Promise<string> {
  const rows = await withRole('call', (tx) =>
    tx`select api.call_stt_complete(${c.jobId}::bigint, ${c.leaseToken}::uuid, ${enc}, ${masked}, ${provider}, ${actualKrw}::int) as r`);
  return String((rows as unknown as { r: string }[])[0].r);
}

export async function dbJobFail(jobId: string, lease: string, code: string, retryable: boolean, chargedKrw: number): Promise<string> {
  const rows = await withRole('call', (tx) =>
    tx`select api.call_job_fail(${jobId}::bigint, ${lease}::uuid, ${code}, ${retryable}, ${chargedKrw}::int) as r`);
  return String((rows as unknown as { r: string }[])[0].r);
}

export async function dbSummaryClaim(reservation: string): Promise<SummaryClaim | null> {
  const rows = (await withRole('call', (tx) => tx`select * from api.call_summary_claim(${reservation}::bigint)`)) as unknown as Record<string, unknown>[];
  const r = rows[0];
  if (!r) return null;
  return { jobId: String(r.job_id), leaseToken: String(r.lease_token), callId: String(r.call_id), transcriptMasked: String(r.transcript_masked) };
}

export async function dbSummaryComplete(c: SummaryClaim, v: SummaryValue): Promise<string> {
  const rows = await withRole('call', (tx) =>
    tx`select api.call_summary_complete(${c.jobId}::bigint, ${c.leaseToken}::uuid, ${v.product}, ${v.outcome},
       ${v.callbackEpoch}::bigint, ${v.summary}, ${JSON.stringify(v.evidence)}::jsonb) as r`);
  return String((rows as unknown as { r: string }[])[0].r);
}

export async function dbAiHold(costKrw: number): Promise<string | null> {
  const rows = await withRole('ai', (tx) => tx`select api.ai_budget_hold(${costKrw}::int) as r`);
  const r = (rows as unknown as { r: unknown }[])[0].r;
  return r === null || r === undefined ? null : String(r);
}

export async function dbAiConfirm(reservation: string, actualKrw: number): Promise<boolean> {
  const rows = await withRole('ai', (tx) => tx`select api.ai_budget_confirm(${reservation}::bigint, ${actualKrw}::int) as r`);
  return (rows as unknown as { r: boolean }[])[0].r === true;
}

export async function dbAiRelease(reservation: string): Promise<boolean> {
  const rows = await withRole('ai', (tx) => tx`select api.ai_budget_release(${reservation}::bigint) as r`);
  return (rows as unknown as { r: boolean }[])[0].r === true;
}
