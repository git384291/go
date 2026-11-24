import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PiiKeys } from '../security/piiCrypto';

/**
 * 통화 녹취 파일 암호화(PM 11/25 ①). 서버에서만 실행한다.
 * - AES-256-GCM, 개인정보 암호화 키(PII_ENC_KEYS)와 같은 키 버전 체계. 파일 형식: 'FCR1' | iv(12) | tag(16) | 암호문
 * - audio_sha256 = 원본 음성의 sha256. 복호화 뒤 다시 계산해 다르면 거부(파일 바꿔치기·손상 차단).
 * - 저장 경로는 무작위 UUID만 쓴다(연락처·이름이 경로에 들어가지 않음).
 */
const MAGIC = Buffer.from('FCR1');
export const MAX_AUDIO_BYTES = 200_000_000;

export class RecordingError extends Error {}

export type EncryptedRecording = { data: Buffer; audioSha256: string; keyVersion: string; audioBytes: number };

export const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');
export const newRecordingPath = () => `calls/${randomUUID()}.bin`;
export const isRecordingPath = (p: string) => /^calls\/[0-9a-f-]{36}\.bin$/.test(p);

export function encryptRecording(keys: PiiKeys, audio: Buffer): EncryptedRecording {
  if (audio.length < 1 || audio.length > MAX_AUDIO_BYTES) throw new RecordingError('INVALID_AUDIO_SIZE');
  const key = keys.encKeys[keys.currentVersion];
  if (!key || key.length !== 32) throw new RecordingError('KEY_UNAVAILABLE');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(audio), c.final()]);
  return {
    data: Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]),
    audioSha256: sha256Hex(audio),
    keyVersion: keys.currentVersion,
    audioBytes: audio.length,
  };
}

export function decryptRecording(keys: PiiKeys, data: Buffer, keyVersion: string, expectedSha256: string): Buffer {
  const key = keys.encKeys[keyVersion];
  if (!key) throw new RecordingError(`KEY_VERSION_UNAVAILABLE:${keyVersion}`);
  if (data.length < 33 || !data.subarray(0, 4).equals(MAGIC)) throw new RecordingError('INVALID_RECORDING');
  let audio: Buffer;
  try {
    const d = createDecipheriv('aes-256-gcm', key, data.subarray(4, 16));
    d.setAuthTag(data.subarray(16, 32));
    audio = Buffer.concat([d.update(data.subarray(32)), d.final()]);
  } catch {
    throw new RecordingError('RECORDING_TAMPERED');
  }
  if (sha256Hex(audio) !== expectedSha256) throw new RecordingError('RECORDING_HASH_MISMATCH');
  return audio;
}

/** 녹취 저장소. 운영 저장소(Supabase Storage 등) 연결은 PM 승인 전 금지 — 지금은 메모리 Mock만 있다. */
export interface RecordingStore {
  put(path: string, data: Buffer): Promise<void>;
  get(path: string): Promise<Buffer>;
  delete(path: string): Promise<void>;
}

export class MemoryRecordingStore implements RecordingStore {
  readonly files = new Map<string, Buffer>();
  async put(path: string, data: Buffer) {
    if (!isRecordingPath(path)) throw new RecordingError('INVALID_PATH');
    if (this.files.has(path)) throw new RecordingError('PATH_EXISTS');
    this.files.set(path, Buffer.from(data));
  }
  async get(path: string) {
    const f = this.files.get(path);
    if (!f) throw new RecordingError('NOT_FOUND');
    return Buffer.from(f);
  }
  async delete(path: string) {
    this.files.delete(path);
  }
}
