export async function api<T = any>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch('/api' + url, {
    method,
    headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(data.error);
  }
  return r.json();
}
export function assetUrl(id: string, revision?: number) {
  return `/api/assets/${encodeURIComponent(id)}/file${revision ? `?revision=${revision}` : ''}`;
}
export function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
