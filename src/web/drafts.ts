import { ref, watch, onBeforeUnmount, type Ref } from 'vue';

let database: Promise<IDBDatabase> | undefined;
function openDrafts() {
  return (database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('studio-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'key' });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  }));
}
// Owns draft storage, version conflicts and component lifecycle; never writes business records.
export function useDraft(key: () => string, revision: () => number, value: Ref<any>) {
  const message = ref(''),
    conflict = ref<any>(null);
  let timer: ReturnType<typeof setTimeout> | undefined,
    loaded = '',
    loadedRevision = -1,
    ticket = 0,
    pending: any;
  async function write(entry: any) {
    if (!entry) return;
    try {
      const db = await openDrafts();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('drafts', 'readwrite');
        tx.objectStore('drafts').put(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e: any) {
      message.value = '本机草稿保存失败：' + e.message;
    }
  }
  watch(
    () => [key(), revision()] as const,
    async ([id, rev]) => {
      const current = ++ticket;
      const initialValue = JSON.stringify(value.value);
      loaded = '';
      conflict.value = null;
      if (timer) clearTimeout(timer);
      await write(pending);
      pending = null;
      if (!id) return;
      try {
        const db = await openDrafts(),
          entry: any = await new Promise((resolve, reject) => {
            const r = db.transaction('drafts').objectStore('drafts').get(id);
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
          });
        if (current !== ticket) return;
        const editedDuringLoad = JSON.stringify(value.value) !== initialValue;
        if (entry && (entry.baseRevision !== rev || editedDuringLoad)) {
          conflict.value = entry;
          message.value = editedDuringLoad
            ? '读取草稿期间已有编辑，保留当前内容；请比较存储草稿。'
            : '本机草稿基于旧版本，请导出检查；不会覆盖当前版本。';
        } else if (entry) {
          value.value = entry.data;
          message.value =
            JSON.stringify(entry.data) === initialValue
              ? '本机草稿与当前固定版本一致。'
              : '已恢复本机草稿，尚未保存或审核。';
        }
        loaded = id;
        loadedRevision = rev;
        if (!entry && editedDuringLoad)
          await write({
            key: id,
            baseRevision: rev,
            data: JSON.parse(JSON.stringify(value.value)),
            updatedAt: Date.now(),
          });
      } catch (e: any) {
        message.value = '草稿读取失败：' + e.message;
      }
    },
    { immediate: true, flush: 'post' },
  );
  watch(
    value,
    () => {
      if (!loaded || loaded !== key() || loadedRevision !== revision() || conflict.value) return;
      pending = {
        key: loaded,
        baseRevision: revision(),
        data: JSON.parse(JSON.stringify(value.value)),
        updatedAt: Date.now(),
      };
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const entry = pending;
        pending = null;
        void write(entry);
      }, 500);
    },
    { deep: true },
  );
  async function discard() {
    const discardedKey = key();
    if (timer) clearTimeout(timer);
    pending = null;
    const db = await openDrafts();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite');
      tx.objectStore('drafts').delete(discardedKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    if (key() === discardedKey) {
      conflict.value = null;
      message.value = '本机草稿已清除';
    }
  }
  onBeforeUnmount(() => {
    ticket++;
    if (timer) clearTimeout(timer);
    void write(pending);
  });
  return { message, conflict, discard };
}
