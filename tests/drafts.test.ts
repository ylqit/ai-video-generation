import test from 'node:test';
import assert from 'node:assert/strict';
import * as Vue from 'vue';
import { useDraft } from '../src/web/drafts.js';

test('actual draft storage preserves editing during a slow read and does not recreate a saved version as a dirty draft', async (t) => {
  const original = globalThis.indexedDB;
  const entries = new Map<string, any>([
    ['series', { key: 'series', baseRevision: 1, data: { text: 'stored' } }],
  ]);
  let pendingRead: (() => void) | undefined;
  let holdRead = true;
  const database = {
    transaction() {
      const tx: any = {
        objectStore: () => ({
          get(key: string) {
            const request: any = {};
            const finish = () => {
              request.result = entries.get(key);
              request.onsuccess?.();
            };
            if (holdRead) pendingRead = finish;
            else queueMicrotask(finish);
            return request;
          },
          put(entry: any) {
            entries.set(entry.key, structuredClone(entry));
            queueMicrotask(() => tx.oncomplete?.());
          },
          delete(key: string) {
            entries.delete(key);
            queueMicrotask(() => tx.oncomplete?.());
          },
        }),
      };
      return tx;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {
      open() {
        const request: any = {};
        queueMicrotask(() => {
          request.result = database;
          request.onsuccess?.();
        });
        return request;
      },
    },
  });
  const value = Vue.ref({ text: 'server' }),
    revision = Vue.ref(1),
    key = Vue.ref('series');
  let draft!: ReturnType<typeof useDraft>;
  const renderer = Vue.createRenderer<any, any>({
    patchProp() {},
    insert() {},
    remove() {},
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    setText() {},
    setElementText() {},
    parentNode: () => null,
    nextSibling: () => null,
  });
  const app = renderer.createApp({
    setup() {
      draft = useDraft(
        () => key.value,
        () => revision.value,
        value,
      );
      return () => null;
    },
  });
  app.mount({});
  t.after(() => {
    app.unmount();
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: original });
  });
  await new Promise((resolve) => setImmediate(resolve));
  value.value = { text: 'typed while IndexedDB was reading' };
  await Vue.nextTick();
  pendingRead!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.value.text, 'typed while IndexedDB was reading');
  assert.equal(draft.conflict.value.data.text, 'stored');
  await draft.discard();
  holdRead = false;
  revision.value = 2;
  value.value = { text: 'saved canonical version' };
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 520));
  assert.equal(entries.has('series'), false);
  value.value.text = 'new unsaved edit';
  await Vue.nextTick();
  await new Promise((resolve) => setTimeout(resolve, 520));
  assert.equal(entries.get('series').baseRevision, 2);
  assert.equal(entries.get('series').data.text, 'new unsaved edit');
});
