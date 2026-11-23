import { ref } from 'vue';
import { api } from './api';
export interface ImportItem {
  key: string;
  name: string;
  size: number;
  modified: number;
  target: any;
  status: string;
  progress: number;
  error: string;
  receipt?: any;
  file?: File;
}
/** Owns per-file progress, persisted request identity and reconciliation after lost responses. */
export function useWorkbenchImports(projectId: string) {
  const storage = 'studio:imports:' + projectId;
  const items = ref<ImportItem[]>([]);
  try {
    items.value = JSON.parse(localStorage.getItem(storage) || '[]').map((i: ImportItem) => ({
      ...i,
      status: i.status === 'ready' ? 'ready' : 'needs-file',
    }));
  } catch {
    /* A malformed local list cannot alter archived assets. */
  }
  const persist = () =>
    localStorage.setItem(
      storage,
      JSON.stringify(items.value.map(({ file, ...i }) => i).slice(-100)),
    );
  async function upload(item: ImportItem) {
    item.error = '';
    item.status = 'reconciling';
    persist();
    try {
      const prior = await api('/projects/' + projectId + '/imports/' + item.key);
      if (prior.status === 'ready') {
        item.receipt = prior;
        item.status = 'ready';
        item.progress = 100;
        persist();
        return prior;
      }
      if (!item.file) {
        item.status = 'needs-file';
        item.error = '请重新选择原文件；已保存回执不会重复入库';
        persist();
        return null;
      }
      item.status = 'uploading';
      const form = new FormData();
      form.append('file', item.file);
      form.append('idempotencyKey', item.key);
      form.append('target', JSON.stringify(item.target));
      const receipt = await new Promise<any>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/projects/' + projectId + '/imports');
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) item.progress = Math.round((e.loaded / e.total) * 100);
        };
        xhr.upload.onload = () => (item.status = 'processing');
        xhr.onload = () => {
          let r: any;
          try {
            r = JSON.parse(xhr.responseText);
          } catch {
            reject(new Error('上传响应无法读取，请核对回执'));
            return;
          }
          if (xhr.status >= 200 && xhr.status < 300) resolve(r);
          else reject(new Error(r.error || '导入失败'));
        };
        xhr.onerror = () => reject(new Error('响应中断，先核对原导入回执'));
        xhr.send(form);
      });
      item.receipt = receipt;
      item.status = 'ready';
      item.progress = 100;
      persist();
      return receipt;
    } catch (e: any) {
      item.status = 'failed';
      item.error = e.message;
      persist();
      return null;
    }
  }
  async function add(files: File[], target: any) {
    const queue = files.map((file, index) => {
      const destination = {
        ...target,
        ...(target.position
          ? { position: { x: target.position.x + index * 35, y: target.position.y + index * 35 } }
          : {}),
      };
      const prior = items.value.find(
        (i) =>
          i.status !== 'ready' &&
          i.name === file.name &&
          i.size === file.size &&
          i.modified === file.lastModified &&
          JSON.stringify(i.target) === JSON.stringify(destination),
      );
      if (prior) {
        prior.file = file;
        return prior;
      }
      const item = {
        key: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        modified: file.lastModified,
        target: destination,
        status: 'queued',
        progress: 0,
        error: '',
        file,
      };
      items.value.push(item);
      return items.value[items.value.length - 1];
    });
    persist();
    const results = [];
    for (const item of queue) {
      const r = await upload(item);
      if (r) results.push(r);
    }
    return results;
  }
  return { items, add, reconcile: upload };
}
