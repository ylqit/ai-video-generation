import { z } from 'zod';
import {
  creationRefSchema,
  creationSettingsSchema,
  type AuthoringStage,
  type CreationRef,
  type DirectorResult,
  type ScriptResult,
} from './creation.js';
import type { Job, RecordDoc } from './contracts.js';
import { executionTextSchema, type ExecutionText } from './execution-text.js';
import { incomingV2Schema } from './shot-semantics.js';

// Execution needs visible subjects, offscreen speakers and boundary participants.
// Use the same set for readiness, workspace requirement status and invalidation.
export function scopeSubjectKeys(script: ScriptResult | undefined, shots: DirectorResult['shots']) {
  const keys = new Set(
    shots.flatMap((s) => [
      ...s.visibleSubjectKeys,
      ...s.entryState.map((f) => f.subjectKey),
      ...s.exitState.map((f) => f.subjectKey),
      ...[...s.entryRelations, ...s.exitRelations].flatMap((r) => [r.objectKey, r.targetKey]),
      ...(s.interactions || []).flatMap((i) => [i.actorKey, i.targetKey]),
      ...(s.performances || []).flatMap((p) =>
        p.attention?.subjectKey ? [p.attention.subjectKey] : [],
      ),
      ...(s.staging
        ? [...s.staging.entry, ...s.staging.exit, ...s.staging.paths].map((p) => p.subjectKey)
        : []),
    ]),
  );
  for (const line of script?.scenes.flatMap((s) => s.dialogue) || [])
    if (shots.some((s) => s.dialogue.some((d) => d.lineId === line.id))) keys.add(line.speakerKey);
  return keys;
}

export function requirementInScope(
  item: { shotIds: string[]; purpose: string; subjectKey: string },
  script: ScriptResult | undefined,
  shots: DirectorResult['shots'],
) {
  if (item.shotIds.length) return shots.some((s) => item.shotIds.includes(s.id));
  if (item.purpose === 'style') return true;
  if (item.purpose === 'voice')
    return (script?.scenes.flatMap((s) => s.dialogue) || []).some(
      (line) =>
        line.speakerKey === item.subjectKey &&
        shots.some((shot) => shot.dialogue.some((d) => d.lineId === line.id)),
    );
  return shots.some((s) => s.visibleSubjectKeys.includes(item.subjectKey));
}

export function referenceStartGroup(
  item: { mediaType: string; purpose: string; shotIds: string[] },
  groups: DirectorResult['groups'],
) {
  if (item.mediaType !== 'image' || !['composition', 'action_start'].includes(item.purpose))
    return null;
  const matching = groups.filter((g) => g.shotIds.some((id) => item.shotIds.includes(id)));
  return matching.length === 1 && item.shotIds.includes(matching[0].shotIds[0])
    ? matching[0]
    : null;
}

export const scopeInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    mode: z.enum(['full', 'selection']),
    shotIds: z.array(z.string().min(1)).max(10000).default([]),
    groupIds: z.array(z.string().min(1)).max(10000).default([]),
    executionText: executionTextSchema.optional(),
    continuations: z.record(z.string().min(1), incomingV2Schema).optional(),
    experiment: creationRefSchema
      .extend({ digest: z.string().length(64), caseId: z.string().min(1) })
      .strict()
      .optional(),
    output: creationSettingsSchema.shape.output
      .unwrap()
      .extend({ seed: z.number().int().nonnegative().default(0) })
      .optional(),
  })
  .strict();
export type ScopeInput = z.infer<typeof scopeInputSchema>;
export interface CreationScope {
  experiment?: { id: string; revision: number; digest: string; caseId: string };
  continuations?: Record<string, z.infer<typeof incomingV2Schema>>;
  executionText?: ExecutionText;
  candidates?: { jobId: string; shotIds: string[]; reason: string }[];
  version: number;
  runId: string;
  name: string;
  mode: 'full' | 'selection';
  pending: boolean;
  authoring: Partial<Record<AuthoringStage, CreationRef>>;
  shotIds: string[];
  groupIds: string[];
  windows: { shotId: string; startFrame: number; endFrame: number }[];
  totalFrames: number;
  requestedFrames: number;
  output: { width: number; height: number; steps: number; seed: number };
}
export const workspaceLayoutSchema = z
  .object({
    positions: z
      .record(z.string(), z.object({ x: z.number().finite(), y: z.number().finite() }).strict())
      .default({}),
    view: z
      .enum(['canvas', 'story', 'visual', 'storyboard', 'candidates', 'timeline'])
      .default('canvas'),
    assistantWidth: z.number().min(340).max(560).default(400),
    assistantCollapsed: z.boolean().default(false),
    filters: z.record(z.string(), z.array(z.string())).default({}),
  })
  .strict();
export type WorkspaceLayout = z.infer<typeof workspaceLayoutSchema>;
export interface WorkspaceCandidate {
  detailPending?: boolean;
  id: string;
  label: string;
  segmentId: string;
  shotIds: string[];
  video: RecordDoc | null;
  audio: RecordDoc | null;
  review: RecordDoc | null;
  exports: RecordDoc[];
  evidence?: (RecordDoc & { cleared: boolean; pinned: boolean; issues: any[] })[];
  state: Job['state'];
  epoch: number | null;
  scope: CreationRef | null;
}
export interface WorkspaceCard {
  id: string;
  title: string;
  type: string;
  group: string;
  record: CreationRef | null;
  asset: CreationRef | null;
  status: string;
  shotIds: string[];
  summary?: string;
}
export interface WorkspaceSnapshot {
  productionRequirements?: {
    fixed: import('./production-plan.js').EffectiveEpisodePlan | null;
    current: import('./production-plan.js').EffectiveEpisodePlan;
    predecessor: import('./production-plan.js').PredecessorStatus;
  } | null;
  storyCoverage?: Array<{
    sceneId: string;
    sceneTitle: string;
    eventId: string;
    description: string;
    sources: any[];
    shots: any[];
    evidence: any[];
    status: string;
  }>;
  project: RecordDoc;
  context?: WorkspaceContext;
  episodes: RecordDoc[];
  run: RecordDoc | null;
  results: Partial<Record<AuthoringStage, RecordDoc>>;
  sources: RecordDoc[];
  subjects: any[];
  assets: RecordDoc[];
  scope: RecordDoc<CreationScope> | null;
  scopes: RecordDoc<CreationScope>[];
  allowance: {
    enabled: boolean;
    maxGenerations: number;
    maxGeneratedSeconds: number;
    usedGenerations: number;
    usedSeconds: number;
    remainingGenerations: number;
    remainingSeconds: number;
  };
  layout: { id: string | null; revision: number; data: WorkspaceLayout };
  requirements: any[];
  candidates: WorkspaceCandidate[];
  jobs: (Omit<Job, 'input'> & { stage: string; epoch: number | null; scope: CreationRef | null })[];
  messages: {
    id: string;
    role: string;
    text: string;
    at: number;
    mode?: string;
    historical?: boolean;
    resultLinks?: (CreationRef & { title?: string; shotId?: string; sceneId?: string })[];
  }[];
  cards: WorkspaceCard[];
  edges: { id: string; from: string; to: string; relation: string }[];
  timing: {
    totalFrames: number;
    requestedFrames: number;
    actualFrames: number;
    adoptedFrames: number;
  };
}
export interface WorkspaceIssue {
  code: string;
  message: string;
  severity: 'blocking' | 'review' | 'info';
  gate: 'authoring' | 'prepare' | 'adopt' | 'deliver';
  inScope: boolean;
  target: CreationRef | null;
  field: string;
  shotId?: string;
  requirementId?: string;
  jobId?: string;
  destination: 'series' | 'authoring' | 'references' | 'scope' | 'candidate' | 'delivery' | 'job';
}
export interface WorkspaceContext {
  series: CreationRef | null;
  episode: CreationRef | null;
  profile: CreationRef | null;
  selectionRequired: 'series' | 'episode' | 'run' | null;
  seriesChoices: { id: string; revision: number; title: string }[];
  runChoices: { id: string; revision: number; title: string; episodeId: string }[];
  issues: WorkspaceIssue[];
}
export const scopedRevisionSchema = z
  .object({
    shotIds: z.array(z.string().min(1)).default([]),
    sceneIds: z.array(z.string().min(1)).default([]),
    subjectKeys: z.array(z.string().min(1)).default([]),
    baseline: creationRefSchema,
  })
  .strict()
  .refine(
    (v) => v.shotIds.length + v.sceneIds.length + v.subjectKeys.length > 0,
    '请明确可修改镜头或场景',
  );
export type ScopedRevision = Omit<z.infer<typeof scopedRevisionSchema>, 'subjectKeys'> & {
  subjectKeys?: string[];
};
