import { ref } from 'vue';
import type { ContextReference } from '../shared/workbench-context';
import type { useNodeWorkbench } from './useNodeWorkbench';
import { useWorkbenchImports } from './useWorkbenchImports';
import { api } from './api';

// Coordinates import receipts, fixed reading references and input bindings across
// the canvas, composer and model tray. None of these operations grants write scope.
export function useWorkbenchTransfers(
  projectId: string,
  workbench: ReturnType<typeof useNodeWorkbench>,
) {
  const { current, save, refresh, showAgent, selected, action, locate, switchCanvas } = workbench;
  const agentAdditions = ref<{ key: number; references: ContextReference[] }>();
  const imports = useWorkbenchImports(projectId),
    showImports = ref(false);
  async function importFiles(files: File[], target: any) {
    await action(async () => {
      showImports.value = true;
      if (target.nodeId) await save([target.nodeId]);
      const receipts = await imports.add(files, { ...target, canvasId: current.value!.id });
      await refresh();
      if (target.kind === 'assistant') {
        agentAdditions.value = { key: Date.now(), references: receipts.map((r) => r.reference) };
        showAgent.value = true;
      }
    });
  }
  async function retryImport(item: any) {
    const receipt = await imports.reconcile(item);
    await refresh();
    if (receipt && item.target.kind === 'assistant') {
      agentAdditions.value = { key: Date.now(), references: [receipt.reference] };
      showAgent.value = true;
    }
  }
  async function extractCurrentFrame(id: string, frame: number) {
    await action(async () => {
      await save([id]);
      const base = '/canvases/' + current.value!.id + '/nodes/' + id,
        operation = { action: 'frame', request: { frame } };
      const prepared = await api(base + '/operation-preview', 'POST', operation);
      await api(base + '/operation-run', 'POST', {
        operation,
        digest: prepared.digest,
        idempotencyKey: crypto.randomUUID(),
      });
      await refresh();
    });
  }
  async function saveReferences(ids: string[]) {
    if (ids.length) await save(ids);
    return current.value!;
  }
  async function addReferences(ids: string[]) {
    await action(async () => {
      const c = await saveReferences(ids);
      agentAdditions.value = {
        key: Date.now(),
        references: ids.map((nodeId) => ({
          kind: 'node',
          canvas: { id: c.id, revision: c.revision },
          nodeId,
          imageHandling: 'image',
        })),
      };
      showAgent.value = true;
    });
  }
  async function locateReference(r: any) {
    if (r.canvas?.id && r.canvas.id !== current.value?.id) await switchCanvas(r.canvas.id);
    if (r.nodeId) locate(r.nodeId);
  }
  async function bindReferences(references: ContextReference[], purpose: string) {
    await action(async () => {
      await save([selected.value]);
      await api(
        '/canvases/' + current.value!.id + '/nodes/' + selected.value + '/references',
        'POST',
        {
          revision: current.value!.revision,
          references,
          purpose,
          idempotencyKey: crypto.randomUUID(),
        },
      );
      await refresh();
    });
  }
  return {
    imports,
    showImports,
    agentAdditions,
    importFiles,
    retryImport,
    extractCurrentFrame,
    saveReferences,
    addReferences,
    locateReference,
    bindReferences,
  };
}
