import { ref } from 'vue';
export const serviceOffline = ref(false);
export async function api<T = any>(url: string, method = 'GET', body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch('/api' + url, {
      method,
      headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    serviceOffline.value = true;
    throw new Error('Studio 后台暂不可达；本机草稿保留，保存结果需恢复连接后核对。');
  }
  if (!r.ok) {
    const data = await r.json().catch(() => null);
    if (!data && r.status >= 500) {
      serviceOffline.value = true;
      throw new Error('Studio 后台暂不可达；本机草稿保留，恢复后核对保存版本。');
    }
    serviceOffline.value = false;
    throw new Error(data?.error || `请求失败（${r.status}）`);
  }
  serviceOffline.value = false;
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
