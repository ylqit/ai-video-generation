import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModelConnection } from '../shared/models.js';
import { Store, HttpError } from './db.js';
import { resolveCredential } from './model-credentials.js';
import { ModelHttpError } from './model-http.js';

export interface VoiceResult {
  state: 'pending' | 'ready' | 'verification_required' | 'failed';
  remoteId?: string;
  voiceId?: string;
  providerStatus: string;
  expiresAt?: number | null;
  audio?: { bytes?: Buffer; url?: string; ext: string };
  usage?: unknown;
}
export interface SpeechContext {
  connection: ModelConnection;
  modelId: string;
  requestId: string;
  call(
    resource: string,
    body?: unknown,
    options?: {
      method?: string;
      action?: string;
      service?: 'vrs' | 'tts';
      headers?: Record<string, string>;
      form?: FormData;
    },
  ): Promise<{ data: any; bytes: Buffer; contentType: string }>;
  beforeSubmit(): void;
  checkpoint: Record<string, any>;
  saveCheckpoint(patch: Record<string, any>): void;
}
export interface SpeechAdapter {
  clone(ctx: SpeechContext, input: any, sample: Buffer): Promise<VoiceResult>;
  query(ctx: SpeechContext, remoteId: string, input: any): Promise<VoiceResult>;
  synthesize(ctx: SpeechContext, input: any): Promise<VoiceResult>;
}

export function tencentHeaders(
  secretId: string,
  secretKey: string,
  url: URL,
  service: 'vrs' | 'tts',
  action: string,
  payload: string,
  timestamp: number,
  region?: string,
) {
  const hash = (v: string) => createHash('sha256').update(v).digest('hex');
  const hmac = (key: string | Buffer, v: string) => createHmac('sha256', key).update(v).digest();
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = 'application/json; charset=utf-8';
  const canonical = [
    'POST',
    url.pathname || '/',
    '',
    `content-type:${contentType}\nhost:${url.host}\n`,
    'content-type;host',
    hash(payload),
  ].join('\n');
  const scope = `${date}/${service}/tc3_request`;
  const signingKey = hmac(hmac(hmac('TC3' + secretKey, date), service), 'tc3_request');
  const signature = hmac(
    signingKey,
    ['TC3-HMAC-SHA256', timestamp, scope, hash(canonical)].join('\n'),
  ).toString('hex');
  return {
    'Content-Type': contentType,
    Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
    'X-TC-Action': action,
    'X-TC-Version': service === 'vrs' ? '2020-08-24' : '2019-08-23',
    'X-TC-Timestamp': String(timestamp),
    ...(region ? { 'X-TC-Region': region } : {}),
  };
}

// Owns binary/JSON/SSE response bounds and provider authentication; never retries any POST.
export function speechContext(
  store: Store,
  connection: ModelConnection,
  modelId: string,
  requestId: string,
  lifecycle: Pick<SpeechContext, 'beforeSubmit' | 'checkpoint' | 'saveCheckpoint'> & {
    receiptDir?: string;
    replayOnly?: boolean;
  },
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): SpeechContext {
  return {
    connection,
    modelId,
    requestId,
    ...lifecycle,
    async call(resource, body, options = {}) {
      const protocol = connection.data.protocol,
        service = options.service || 'vrs';
      const base =
        protocol === 'tencent-speech' && service === 'tts'
          ? connection.data.ttsBaseUrl || 'https://tts.tencentcloudapi.com'
          : connection.data.baseUrl;
      const url = new URL(base.replace(/\/+$/, '') + resource);
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const formFields = options.form
        ? await Promise.all(
            [...options.form.entries()].map(async ([name, value]) =>
              typeof value === 'string'
                ? { name, value }
                : {
                    name,
                    fileName: value.name,
                    type: value.type,
                    size: value.size,
                    sha256: createHash('sha256')
                      .update(new Uint8Array(await value.arrayBuffer()))
                      .digest('hex'),
                  },
            ),
          )
        : null;
      const requestHash = createHash('sha256')
        .update(
          JSON.stringify({
            resource,
            action: options.action,
            service,
            body: body ?? null,
            form: formFields,
          }),
        )
        .digest('hex');
      const receipt = lifecycle.receiptDir && path.join(lifecycle.receiptDir, requestHash);
      if (receipt && (lifecycle.replayOnly || (options.method !== 'GET' && body !== undefined))) {
        const cached = await fs.readFile(receipt + '.json', 'utf8').catch(() => null);
        if (cached) {
          const meta = JSON.parse(cached),
            bytes = await fs.readFile(receipt + '.bin');
          if (meta.sha256 && meta.sha256 !== createHash('sha256').update(bytes).digest('hex'))
            throw new Error('供应商回执内容哈希不符；未重新提交');
          return { ...meta, bytes };
        }
      }
      if (lifecycle.replayOnly) throw new Error('原请求尚无完整回执，必须核对原任务；未重新提交');
      if (receipt) {
        await fs.mkdir(path.dirname(receipt), { recursive: true });
        await fs.writeFile(
          receipt + '.request.json',
          JSON.stringify({
            resource,
            method: options.method || 'POST',
            action: options.action,
            service,
            body,
            formFields,
          }),
        );
      }
      const secret = await resolveCredential(store, connection.data.credential);
      const headers = new Headers(options.headers);
      const sensitive: string[] = secret ? [secret] : [];
      if (protocol === 'tencent-speech') {
        const refs = connection.data.credentials;
        if (!refs || !options.action) throw new HttpError(400, '腾讯签名缺少成组凭据或操作');
        const id = (await resolveCredential(store, refs.secretId))!,
          key = (await resolveCredential(store, refs.secretKey))!;
        sensitive.push(id, key);
        for (const [k, v] of Object.entries(
          tencentHeaders(
            id,
            key,
            url,
            service,
            options.action,
            payload || '{}',
            Math.floor(Date.now() / 1000),
            connection.data.region,
          ),
        ))
          headers.set(k, v);
      } else if (protocol === 'doubao-speech' || protocol === 'sync-lipsync') {
        headers.set('X-Api-Key', secret!);
        headers.set('X-Api-Request-Id', requestId);
        if (
          protocol === 'doubao-speech' &&
          resource.includes('unidirectional') &&
          connection.data.speechResourceId
        )
          headers.set('X-Api-Resource-Id', connection.data.speechResourceId);
      } else if (secret) headers.set('Authorization', 'Bearer ' + secret);
      if (!options.form && payload !== undefined && !headers.has('Content-Type'))
        headers.set('Content-Type', 'application/json');
      const response = await request(url, {
        method: options.method || (body !== undefined || options.form ? 'POST' : 'GET'),
        headers,
        body: options.form || payload,
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(180000)])
          : AbortSignal.timeout(180000),
      });
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body)
        for await (const chunk of response.body as any) {
          size += chunk.length;
          if (size > 128 * 1024 ** 2) throw new Error('声音响应超过 128 MB');
          chunks.push(chunk);
        }
      const bytes = Buffer.concat(chunks),
        contentType = response.headers.get('content-type') || '';
      let data: any = null;
      if (!contentType.startsWith('audio/')) {
        try {
          data = JSON.parse(bytes.toString('utf8'));
        } catch {
          /* SSE is parsed by its protocol adapter. */
        }
      }
      const providerError = data?.Response?.Error || data?.error;
      if (!response.ok || providerError) {
        let message = String(
          providerError?.Message ||
            providerError?.message ||
            data?.message ||
            `HTTP ${response.status}`,
        ).slice(0, 1200);
        for (const value of sensitive) message = message.split(value).join('[redacted]');
        throw new ModelHttpError(
          response.ok ? 422 : response.status,
          message,
          response.headers.get('x-request-id'),
          response.headers.get('retry-after'),
        );
      }
      if (receipt) {
        await fs.writeFile(receipt + '.bin', bytes);
        await fs.writeFile(
          receipt + '.json',
          JSON.stringify({
            data,
            contentType,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          }),
        );
      }
      return { data, bytes, contentType };
    },
  };
}
