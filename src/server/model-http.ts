import { Store, HttpError } from './db.js';
import { resolveCredential } from './model-credentials.js';
import type { ModelConnection } from '../shared/models.js';

export class ModelHttpError extends HttpError {
  constructor(
    status: number,
    message: string,
    public requestId: string | null,
    public retryAfter: string | null,
  ) {
    super(status, message);
  }
}
// Owns authorization, bounded responses, timeouts and error redaction. Never retries POST.
export async function modelRequest(
  store: Store,
  connection: ModelConnection,
  resource: string,
  init: RequestInit = {},
  request: typeof fetch = fetch,
  beforeSend?: () => void,
) {
  const secret = await resolveCredential(store, connection.data.credential);
  const headers = new Headers(init.headers);
  if (secret) headers.set('Authorization', 'Bearer ' + secret);
  beforeSend?.();
  const response = await request(connection.data.baseUrl.replace(/\/+$/, '') + resource, {
    ...init,
    headers,
    redirect: 'error',
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(120000)])
      : AbortSignal.timeout(120000),
  });
  const requestId = response.headers.get('x-request-id') || response.headers.get('request-id');
  let size = 0;
  const chunks: Uint8Array[] = [];
  if (response.body)
    for await (const chunk of response.body as any) {
      size += chunk.length;
      if (size > 128 * 1024 * 1024) throw new Error('供应商响应超过 128 MB 限制');
      chunks.push(chunk);
    }
  const body = Buffer.concat(chunks).toString('utf8');
  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    data = null;
  }
  if (!response.ok) {
    let message = String(data?.error?.message || data?.message || `HTTP ${response.status}`).slice(
      0,
      1600,
    );
    if (secret) message = message.split(secret).join('[redacted]');
    message = message.replace(/data:[^\s"']+/g, '[media]');
    throw new ModelHttpError(
      response.status,
      message,
      requestId,
      response.headers.get('retry-after'),
    );
  }
  if (data === null) throw new Error('供应商返回非 JSON 响应；请核对受理情况');
  return { data, requestId: requestId || data.request_id || null };
}
