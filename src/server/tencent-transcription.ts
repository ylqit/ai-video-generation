import { createHmac } from 'node:crypto';
import { resolveCredential } from './model-credentials.js';
import { Store } from './db.js';
import { ModelHttpError } from './model-http.js';
import type { ModelExecution } from '../shared/models.js';

// Flash ASR uses SHA1 over method + sorted raw query, not Tencent Cloud TC3.
export function flashSignature(
  host: string,
  path: string,
  parameters: Record<string, string>,
  secret: string,
) {
  const query = Object.keys(parameters)
    .sort()
    .map((k) => `${k}=${parameters[k]}`)
    .join('&');
  return createHmac('sha1', secret)
    .update('POST' + host + path + '?' + query)
    .digest('base64');
}
export async function transcribeTencent(
  store: Store,
  execution: ModelExecution,
  bytes: Buffer,
  diarization: boolean,
  signal: AbortSignal,
  request: typeof fetch,
  beforeSend: () => void,
) {
  const c = execution.connection.data;
  if (!c.credentials || !c.appId) throw new Error('腾讯录音识别连接需要 AppID 与成组凭据');
  if (bytes.length > 100 * 1024 * 1024) throw new Error('准备音频超过腾讯 100 MB 限制');
  const secretId = await resolveCredential(store, c.credentials.secretId),
    secret = await resolveCredential(store, c.credentials.secretKey);
  if (!secretId || !secret) throw new Error('腾讯录音识别凭据不可用');
  const url = new URL(c.baseUrl),
    pathname = `/asr/flash/v1/${c.appId}`;
  const params = {
    engine_type: execution.modelId,
    secretid: secretId,
    voice_format: 'wav',
    timestamp: String(Math.floor(Date.now() / 1000)),
    word_info: '1',
    speaker_diarization: diarization ? '1' : '0',
    filter_dirty: '0',
    filter_modal: '0',
    filter_punc: '0',
    convert_num_mode: '0',
    first_channel_only: '1',
  };
  const authorization = flashSignature(url.host, pathname, params, secret);
  url.pathname = pathname;
  url.search = new URLSearchParams(
    Object.entries(params).sort(([a], [b]) => a.localeCompare(b)),
  ).toString();
  beforeSend();
  const response = await request(url, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.length),
    },
    body: bytes as unknown as BodyInit,
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
  });
  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body as any) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new Error('转写响应超过限制');
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!response.ok || data.code !== 0)
    throw new ModelHttpError(
      response.status >= 400 ? response.status : 422,
      `腾讯转写 ${data.code}: ${String(data.message || '失败')
        .split(secret)
        .join('[redacted]')
        .split(secretId)
        .join('[redacted]')
        .slice(0, 600)}`,
      data.request_id || null,
      null,
    );
  return { data, requestId: data.request_id || null };
}
export function flashSegments(data: any, sourceStart: number) {
  if (!Array.isArray(data.flash_result)) throw new Error('转写回执缺少声道结果');
  return data.flash_result.flatMap((channel: any) =>
    (channel.sentence_list || []).map((s: any) => {
      if (
        !Number.isFinite(s.start_time) ||
        !Number.isFinite(s.end_time) ||
        s.end_time < s.start_time
      )
        throw new Error('转写回执时间无效');
      return {
        text: String(s.text || ''),
        start: sourceStart + s.start_time / 1000,
        end: sourceStart + s.end_time / 1000,
        speaker: s.speaker_id ?? null,
        channel: channel.channel_id,
        words: (s.word_list || []).map((w: any) => ({
          text: String(w.word || ''),
          start: sourceStart + w.start_time / 1000,
          end: sourceStart + w.end_time / 1000,
        })),
      };
    }),
  );
}
