import { validateIssueTarget } from './review-evidence.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { CreationService } from './creation.js';
import { authoringPrompt } from './creation-prompts.js';
import { DomainService } from './domain-service.js';
import { WorkspaceService, resolveScope } from './workspace.js';
import { generationDigest } from './h3-guided.js';
import { inside } from './config.js';
import { probeMedia, hashFile } from './media.js';
import { edlSchema, type Job, type RecordDoc } from '../shared/contracts.js';
import {
  creationMessageSchema,
  deliveryManifestSchema,
  discussionResponseSchema,
} from '../shared/creation-media.js';
import { creationRefSchema } from '../shared/creation.js';
import { fileCleared } from './media-retention.js';

export class CreationMediaService {
  constructor(
    public store: Store,
    public root: string,
  ) {}

  async confirmReferences(runId: string, raw: unknown) {
    const input = z
      .object({
        runRevision: z.number().int().positive(),
        idempotencyKey: z.string().min(8),
        items: z
          .array(
            z
              .object({
                requirementId: z.string().min(1),
                asset: creationRefSchema,
                asGroupStart: z.boolean().optional(),
                inspected: z.literal(true),
                conclusion: z.string().trim().min(1),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict()
      .parse(raw);
    const digest = generationDigest(input),
      creation = new CreationService(this.store);
    const replay = (run: RecordDoc) => {
      const receipt = (run.data.referenceConfirmations || []).find(
        (r: any) => r.key === input.idempotencyKey,
      );
      if (receipt && receipt.digest !== digest)
        throw new HttpError(409, '参考确认幂等键用于不同内容');
      return receipt;
    };
    const run = creation.get(runId);
    if (replay(run)) return run;
    if (run.revision !== input.runRevision) throw new HttpError(409, '运行已变化，请重新核对需求');
    if (new Set(input.items.map((i) => i.requirementId)).size !== input.items.length)
      throw new HttpError(400, '同一批次不能重复确认同一需求');
    this.store.inFlightMutations++;
    try {
      const assets = new Map<string, RecordDoc>();
      for (const item of input.items) {
        const asset = creation.inputRecord(run.projectId, item.asset);
        if (
          asset.kind !== 'asset' ||
          this.store.get(asset.id).revision !== asset.revision ||
          fileCleared(this.store, asset.data.path)
        )
          throw new HttpError(409, '参考版本已变化或文件已清理，请先恢复并核对');
        const file = inside(this.root, asset.data.path);
        if ((await hashFile(file)) !== asset.data.sha256)
          throw new HttpError(409, '参考文件哈希不符');
        const metadata = await probeMedia(file);
        if (metadata.mediaType !== asset.data.mediaType)
          throw new HttpError(409, '实际参考媒体类型不符');
        assets.set(asset.id, asset);
      }
      return this.store.transaction(() => {
        let fresh = creation.get(runId);
        if (replay(fresh)) return fresh;
        if (fresh.revision !== input.runRevision)
          throw new HttpError(409, '核验期间需求已变化，请重新核对');
        for (const [id, asset] of assets) {
          if (
            this.store.get(id).revision !== asset.revision ||
            fileCleared(this.store, asset.data.path)
          )
            throw new HttpError(409, '核验期间参考版本已变化');
          if (!asset.data.adopted)
            assets.set(id, this.store.update(id, asset.revision, { ...asset.data, adopted: true }));
        }
        for (const item of input.items) {
          const asset = assets.get(item.asset.id)!;
          fresh = creation.bindAsset(runId, {
            ...item,
            asset: { id: asset.id, revision: asset.revision },
            revision: fresh.revision,
          });
        }
        return this.store.update(runId, fresh.revision, {
          ...fresh.data,
          referenceConfirmations: [
            ...(fresh.data.referenceConfirmations || []),
            { key: input.idempotencyKey, digest, items: input.items, confirmedAt: Date.now() },
          ],
        });
      });
    } finally {
      this.store.inFlightMutations--;
    }
  }

  message(runId: string, raw: unknown) {
    const body = creationMessageSchema.parse(raw),
      digest = generationDigest(body);
    return this.store.transaction(() => {
      const creation = new CreationService(this.store),
        run = creation.get(runId);
      const prior = this.store
        .list('creation_message', run.projectId)
        .find((d) => d.parentId === runId && d.data.key === body.idempotencyKey);
      if (prior) {
        if (prior.data.digest !== digest) throw new HttpError(409, '会话幂等键对应其他指令');
        return {
          run,
          message: prior,
          job: prior.data.jobId ? this.store.job(prior.data.jobId) : null,
        };
      }
      if (run.revision !== body.revision) throw new HttpError(409, '会话状态已变化');
      const records = body.references.map((ref) => {
        const doc = new DomainService(this.store).owned(run.projectId, ref);
        if (
          ref.subjectKey &&
          !doc.data.result?.subjects?.some((s: any) => s.key === ref.subjectKey)
        )
          throw new HttpError(400, '主体不属于固定结果');
        if (
          ref.shotId &&
          !doc.data.result?.shots?.some((s: any) => s.id === ref.shotId) &&
          !doc.data.shots?.some((s: any) => s.id === ref.shotId)
        )
          throw new HttpError(400, '引用版本中不存在该镜头');
        if (
          ref.sceneId &&
          !doc.data.result?.scenes?.some((s: any) => s.id === ref.sceneId) &&
          !doc.data.result?.shots?.some((s: any) => s.sceneId === ref.sceneId)
        )
          throw new HttpError(400, '引用版本中不存在该场景');
        return { ref, record: doc };
      });
      let next: RecordDoc = run,
        job: Job | null = null,
        response = '',
        at = Date.now();
      if (body.mode === 'discuss') {
        const context = {
          schemaVersion: 9,
          mode: 'discussion',
          projectId: run.projectId,
          runId,
          epoch: run.data.epoch,
          runRevision: run.revision,
          request: body.request,
          references: records,
          capabilities: {
            text: true,
            inspectMedia: false,
            generateMedia: false,
            imageWorkflow: 'fixed_task_package_and_upload',
            transcribeAudio: false,
          },
          results: Object.values(run.data.results).map((r: any) =>
            this.store.get(r.id, r.revision),
          ),
          digest: '',
        };
        if (JSON.stringify(context).length > 180000)
          throw new HttpError(400, '讨论上下文超过预算；请缩小引用范围，固定引用未被截断');
        context.digest = generationDigest({ ...context, digest: '' });
        job = this.store.createJob(
          'creative',
          run.projectId,
          run.data.episodeId,
          { context, creationRunId: runId, messageKey: body.idempotencyKey },
          `discussion:${runId}:${body.idempotencyKey}`,
        );
      } else if (body.mode === 'revise') {
        if (!body.stage) throw new HttpError(400, '修订需要明确阶段');
        next = creation.revise(runId, body.stage, body.request, [], false, body.writable);
        at = next.data.messages.at(-1).at;
        const context = creation.context(runId, body.stage);
        context.records.push(
          ...records.map(({ ref, record }) => ({
            id: ref.id,
            revision: ref.revision,
            kind: 'fixed_reference_evidence',
            data: {
              reference: ref,
              record,
              authority:
                'Read-only historical evidence. This does not broaden the explicit writable scope or add a live adoption dependency. Output sources may cite this reference only if it already occurs in context.dependencies; the conversation and frozen context retain its historical provenance.',
            },
          })),
        );
        if (authoringPrompt(context).length > 300000)
          throw new HttpError(400, '修订固定引用超过上下文预算；请缩小范围，引用未被截断');
        context.digest = generationDigest({ ...context, digest: '' });
        job = this.store.createJob(
          'creative',
          run.projectId,
          run.data.episodeId,
          { context, creationRunId: runId, messageKey: body.idempotencyKey },
          `revision:${runId}:${body.idempotencyKey}`,
        );
        next = this.store.update(next.id, next.revision, {
          ...next.data,
          pendingJobId: job.id,
          state: 'working',
        });
        response = '修订指令已记录；将按明确阶段和范围生成新草稿，完成后显示实际成果。';
      } else {
        if (!body.action) throw new HttpError(400, '执行需要选择明确操作');
        if (body.action.type === 'prepare_scope') {
          const scope = resolveScope(this.store, run);
          const prepared = new WorkspaceService(this.store).preview(
            scope.id,
            scope.revision,
            run.revision,
          );
          next = prepared.run;
          response = prepared.preview
            ? '当前范围的生成预览已准备，请查看固定输入并确认后提交。'
            : `当前范围尚未就绪：${prepared.issues.map((i: any) => i.message).join('；')}`;
        } else if (['pause', 'resume'].includes(body.action.type)) {
          next = creation.pause(runId, run.revision, body.action.type === 'pause');
          response = body.action.type === 'pause' ? '后续推进已暂停。' : '后续推进已恢复。';
        } else
          throw new HttpError(
            400,
            '不支持此执行操作；请选择准备当前范围、暂停或恢复。图片请使用素材任务包交付。',
          );
      }
      const message = this.store.create(
        'creation_message',
        run.projectId,
        {
          runId,
          role: 'user',
          text: body.request,
          at,
          mode: body.mode,
          references: body.references,
          key: body.idempotencyKey,
          digest,
          jobId: job?.id || null,
          epoch: next.data.epoch,
        },
        runId,
      );
      new DomainService(this.store).dependencies(message, body.references);
      if (response)
        this.store.create(
          'creation_message',
          run.projectId,
          {
            runId,
            role: 'assistant',
            text: response,
            at: at + 1,
            mode: body.mode,
            replyTo: message.id,
            resultLinks: [],
            epoch: next.data.epoch,
          },
          runId,
        );
      return { run: next, message, job };
    });
  }

  completeDiscussion(job: Job, raw: unknown) {
    const context = job.input.context,
      parsed = discussionResponseSchema.parse(raw);
    if (
      context.mode !== 'discussion' ||
      context.projectId !== job.projectId ||
      context.digest !== generationDigest({ ...context, digest: '' })
    )
      throw new HttpError(400, '讨论上下文摘要或归属不匹配');
    const available = [...context.references.map((r: any) => r.record), ...context.results];
    for (const link of parsed.resultLinks)
      if (!available.some((d: any) => d.id === link.id && d.revision === link.revision))
        throw new HttpError(400, '讨论输出引用不在固定上下文中');
    return this.store.transaction(() => {
      const run = new CreationService(this.store).get(context.runId);
      const prior = this.store
        .list('creation_message', job.projectId)
        .find((m) => m.data.jobId === job.id && m.data.role === 'assistant');
      if (prior) return prior;
      const message = this.store.create(
        'creation_message',
        job.projectId,
        {
          role: 'assistant',
          mode: 'discuss',
          runId: run.id,
          text: parsed.answer,
          resultLinks: parsed.resultLinks,
          at: Date.now(),
          jobId: job.id,
          historical: run.data.epoch !== context.epoch || run.revision !== context.runRevision,
          epoch: context.epoch,
        },
        run.id,
      );
      new DomainService(this.store).dependencies(message, parsed.resultLinks);
      return message;
    });
  }

  assetTasks(runId: string, requirementId?: string) {
    const run = new CreationService(this.store).get(runId);
    return this.store
      .list('asset_task', run.projectId)
      .filter(
        (task) =>
          task.data.creationRunId === runId &&
          (!requirementId || task.data.requirementId === requirementId),
      );
  }

  createAssetTask(runId: string, raw: unknown) {
    const body = z
      .object({
        revision: z.number().int().positive(),
        requirementId: z.string().min(1),
        idempotencyKey: z.string().min(8),
        maxRevisions: z.number().int().min(0).max(2).default(2),
      })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const run = new CreationService(this.store).get(runId),
        tasks = this.assetTasks(runId),
        digest = generationDigest(body);
      const receipt = tasks.find((t) =>
        t.data.receipts?.some((r: any) => r.key === body.idempotencyKey),
      );
      if (receipt) {
        if (
          !receipt.data.receipts.some(
            (r: any) => r.key === body.idempotencyKey && r.digest === digest,
          )
        )
          throw new HttpError(409, '素材任务幂等键冲突');
        return { task: receipt };
      }
      if (run.revision !== body.revision) throw new HttpError(409, '作品版本已变化');
      const assetsRef = run.data.results.assets,
        scriptRef = run.data.results.script;
      if (!assetsRef || !scriptRef) throw new HttpError(409, '请先采用剧本和素材需求');
      const assetsResult = this.store.get(assetsRef.id, assetsRef.revision),
        script = this.store.get(scriptRef.id, scriptRef.revision);
      if (
        [assetsResult, script].some(
          (d) =>
            d.projectId !== run.projectId ||
            d.parentId !== runId ||
            d.kind !== 'authoring_result' ||
            !d.data.adopted,
        ) ||
        assetsResult.data.stage !== 'assets' ||
        script.data.stage !== 'script'
      )
        throw new HttpError(409, '素材任务需要本作品已采用的剧本与素材需求固定版本');
      const requirement = assetsResult.data.result.items.find(
        (i: any) => i.id === body.requirementId,
      );
      if (!requirement || requirement.mediaType !== 'image')
        throw new HttpError(400, '请选择当前图片素材需求');
      const current = tasks.find(
        (t) =>
          t.data.requirementId === body.requirementId &&
          t.data.assetsResult.id === assetsRef.id &&
          t.data.assetsResult.revision === assetsRef.revision &&
          t.data.scriptResult?.id === scriptRef.id &&
          t.data.scriptResult.revision === scriptRef.revision,
      );
      if (current && current.data.maxRevisions !== body.maxRevisions)
        throw new HttpError(409, '当前任务已有固定修订预算，请使用现有任务包');
      if (current)
        return {
          task: this.store.update(current.id, current.revision, {
            ...current.data,
            receipts: [...current.data.receipts, { key: body.idempotencyKey, digest }],
          }),
        };
      const subject = script.data.result.subjects.find(
        (s: any) => s.key === requirement.subjectKey,
      );
      if (!subject) throw new HttpError(400, '素材需求缺少当前剧本主体');
      const domain = new DomainService(this.store);
      const entityData = {
        name: subject.name,
        type: ['human', 'animal'].includes(subject.kind)
          ? 'character'
          : subject.kind === 'environment'
            ? 'environment'
            : 'object',
        subtype: subject.kind,
        description: subject.description,
        instances: [{ id: `${run.id}:${subject.key}:handoff`, name: subject.name }],
        attributes: subject.attributes.map((a: any) => ({ ...a, continuity: 'scene' })),
        anchors: [],
      };
      const entityDigest = generationDigest(entityData);
      const oldEntity = this.store
        .list('entity', run.projectId)
        .find((e) => e.data.instances?.some((i: any) => i.id === entityData.instances[0].id));
      let entity = oldEntity;
      if (!entity || entity.data.handoffDigest !== entityDigest) {
        const saved = domain.save(
          run.projectId,
          'entity',
          entityData,
          oldEntity?.id,
          oldEntity?.revision,
        );
        entity = this.store.update(saved.id, saved.revision, {
          ...saved.data,
          handoffDigest: entityDigest,
        });
      }
      const task = domain.save(run.projectId, 'asset_task', {
        name: requirement.description || requirement.id,
        entity: { id: entity.id, revision: entity.revision },
        requirements: `${requirement.description}\n${requirement.prompt}\n版式：${requirement.layout}`,
        views: [{ id: requirement.id, view: requirement.view, instruction: requirement.prompt }],
        references: [],
      });
      const next = this.store.update(task.id, task.revision, {
        ...task.data,
        creationRunId: runId,
        creationRun: { id: run.id, revision: run.revision },
        requirementId: requirement.id,
        shotIds: requirement.shotIds,
        assetsResult: assetsRef,
        scriptResult: scriptRef,
        maxRevisions: body.maxRevisions,
        state: 'waiting_codex',
        receipts: [{ key: body.idempotencyKey, digest }],
        deliveries: [],
      });
      domain.dependencies(next, [
        { id: run.id, revision: run.revision },
        assetsRef,
        scriptRef,
        { id: entity.id, revision: entity.revision },
      ]);
      return { task: next };
    });
  }

  async deliver(taskId: string, raw: unknown, files: { path: string; originalname: string }[]) {
    const manifest = deliveryManifestSchema.parse(raw);
    this.store.get(taskId);
    let frozen: RecordDoc;
    try {
      frozen = this.store.get(taskId, manifest.taskRevision);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404)
        throw new HttpError(409, '交付任务版本不存在');
      throw e;
    }
    if (manifest.taskId !== taskId || frozen.kind !== 'asset_task')
      throw new HttpError(409, '交付任务标识或版本不匹配');
    if (
      manifest.assets.length !== files.length ||
      manifest.assets.length !== frozen.data.views.length ||
      new Set(files.map((f) => f.originalname)).size !== files.length ||
      new Set(manifest.assets.map((a) => a.file)).size !== files.length ||
      new Set(manifest.assets.map((a) => a.viewId)).size !== files.length
    )
      throw new HttpError(400, '交付文件与视图清单不匹配');
    const staged: {
      item: { viewId: string; file: string };
      file: { path: string; originalname: string };
      ext: string;
      sha256: string;
      metadata: Awaited<ReturnType<typeof probeMedia>>;
    }[] = [];
    for (const item of manifest.assets) {
      const file = files.find((f) => f.originalname === item.file),
        ext = path.extname(item.file).toLowerCase();
      if (
        !file ||
        !frozen.data.views.some((v: any) => v.id === item.viewId) ||
        !['.png', '.jpg', '.jpeg', '.webp'].includes(ext)
      )
        throw new HttpError(400, '交付视图或图片格式无效');
      const metadata = await probeMedia(file.path),
        sha256 = await hashFile(file.path);
      if (
        !metadata.width ||
        !metadata.height ||
        metadata.duration > 0.1 ||
        metadata.hasAudio ||
        !metadata.streams.some(
          (s: any) => s.type === 'video' && ['png', 'mjpeg', 'webp'].includes(s.codec),
        )
      )
        throw new HttpError(400, '交付必须是静态图片');
      if (metadata.bytes > 512 * 1024 ** 2) throw new HttpError(400, '单素材上限 512 MB');
      staged.push({ item, file, ext, sha256, metadata });
    }
    const digest = generationDigest({
      manifest,
      files: staged
        .map((s) => ({ viewId: s.item.viewId, sha256: s.sha256 }))
        .sort((a, b) => a.viewId.localeCompare(b.viewId)),
    });
    const existing = this.store
      .get(taskId)
      .data.deliveries.find((d: any) => d.deliveryId === manifest.deliveryId);
    if (existing) {
      if (existing.digest !== digest) throw new HttpError(409, '交付标识已对应不同清单或图片内容');
      return { task: this.store.get(taskId), delivery: existing, replayed: true };
    }
    const space = await fs.statfs(this.root);
    if (
      space.bavail * space.bsize <
      staged.reduce((n, s) => n + s.metadata.bytes, 0) + 64 * 1024 ** 2
    )
      throw new HttpError(507, '交付归档磁盘空间不足');
    await fs.mkdir(inside(this.root, 'assets'), { recursive: true });
    for (const item of staged) {
      const destination = inside(this.root, `assets/${item.sha256}${item.ext}`),
        temporary = inside(this.root, `assets/.incoming-${randomUUID()}${item.ext}`);
      try {
        await fs.copyFile(item.file.path, temporary, 1);
        try {
          await fs.link(temporary, destination);
        } catch (e: any) {
          if (e.code !== 'EEXIST') throw e;
        }
        if ((await hashFile(destination)) !== item.sha256)
          throw new HttpError(409, '归档文件哈希冲突');
      } finally {
        await fs.unlink(temporary).catch((e) => {
          if (e.code !== 'ENOENT') throw e;
        });
      }
    }
    return this.store.transaction(() => {
      const current = this.store.get(taskId),
        prior = current.data.deliveries.find((d: any) => d.deliveryId === manifest.deliveryId);
      if (prior) {
        if (prior.digest !== digest) throw new HttpError(409, '并发交付标识冲突');
        return { task: current, delivery: prior, replayed: true };
      }
      const run = frozen.data.creationRunId
        ? new CreationService(this.store).get(frozen.data.creationRunId)
        : null;
      const stale =
        generationDigest({ ...current.data, deliveries: [], receipts: [], state: '' }) !==
          generationDigest({ ...frozen.data, deliveries: [], receipts: [], state: '' }) ||
        Boolean(
          run &&
          (run.data.results.assets?.id !== frozen.data.assetsResult?.id ||
            run.data.results.assets?.revision !== frozen.data.assetsResult?.revision ||
            run.data.results.script?.id !== frozen.data.scriptResult?.id ||
            run.data.results.script?.revision !== frozen.data.scriptResult?.revision),
        );
      const candidates = staged.map((s) => {
        const asset = this.store.create(
          'asset',
          frozen.projectId,
          {
            ...s.metadata,
            mediaType: 'image',
            duration: 0,
            name: `${frozen.data.name} · ${s.item.viewId}`,
            category: 'reference',
            entityId: frozen.data.entity.id,
            variant: frozen.data.appearance?.id || '默认',
            path: `assets/${s.sha256}${s.ext}`,
            sha256: s.sha256,
            adopted: false,
            sourceAssetIds: frozen.data.references.map((r: any) => r.id),
            prompt: frozen.data.requirements,
            jobId: null,
            production: {
              taskId,
              taskRevision: manifest.taskRevision,
              deliveryId: manifest.deliveryId,
              viewId: s.item.viewId,
            },
          },
          frozen.projectId,
        );
        return { viewId: s.item.viewId, asset: { id: asset.id, revision: asset.revision } };
      });
      const delivery = {
        deliveryId: manifest.deliveryId,
        taskRevision: manifest.taskRevision,
        digest,
        candidates,
        stale,
        at: Date.now(),
        executionReceipt: manifest.executionReceipt
          ? { ...manifest.executionReceipt, evidence: 'reported' }
          : null,
      };
      const task = this.store.update(taskId, current.revision, {
        ...current.data,
        state: stale ? current.data.state : 'completed',
        deliveries: [...current.data.deliveries, delivery],
      });
      new DomainService(this.store).dependencies(task, [
        ...new DomainService(this.store).refs(current.data),
        ...candidates.map((c) => c.asset),
      ]);
      return { task, delivery };
    });
  }

  async validateReview(projectId: string, runId: string, raw: unknown) {
    const edl = edlSchema.parse(raw),
      run = new CreationService(this.store).get(runId);
    if (edl.schemaVersion !== 2 || edl.episodeId !== run.data.episodeId)
      throw new HttpError(400, '审看编辑需要本作品分集的 EDL v2');
    const assets = new Map<string, RecordDoc>();
    for (const [audioOnly, clips] of [
      [false, edl.clips],
      [true, edl.audio],
    ] as const)
      for (const clip of clips) {
        if ('selection' in clip || 'dialogueTake' in clip)
          throw new HttpError(400, '审看编辑不使用正式采用或对白确认引用');
        const key = `${clip.assetId}:${clip.revision}`;
        const asset =
          assets.get(key) ||
          new DomainService(this.store).owned(
            projectId,
            { id: clip.assetId, revision: clip.revision },
            'asset',
          );
        const metadata = await probeMedia(inside(this.root, asset.data.path));
        if ((await hashFile(inside(this.root, asset.data.path))) !== asset.data.sha256)
          throw new HttpError(409, '固定素材内容校验失败');
        if (
          audioOnly
            ? metadata.mediaType !== 'audio' && !metadata.hasAudio
            : metadata.mediaType === 'audio'
        )
          throw new HttpError(400, '媒体轨道类型不匹配');
        if (metadata.mediaType === 'image') {
          if (clip.in !== 0) throw new HttpError(400, '静态图片入点必须为零');
        } else {
          const rate = metadata.streams
            .find((s: any) => s.type === 'video')
            ?.frameRate?.split('/')
            .map(Number);
          const duration =
            metadata.frameCount && rate?.[0]
              ? (metadata.frameCount * (rate[1] || 1)) / rate[0]
              : metadata.duration;
          if (!(duration > 0) || clip.out > duration + 0.000001)
            throw new HttpError(400, '裁剪超出媒体实际帧数或时长');
        }
        assets.set(key, asset);
      }
    return {
      edl,
      assets: [...assets.values()],
      sourceRefs: [...assets.values()].map((a) => ({ id: a.id, revision: a.revision })),
    };
  }

  reviewEdits(runId: string) {
    const run = new CreationService(this.store).get(runId);
    return this.store
      .list('creation_review_edit', run.projectId)
      .filter((r) => r.parentId === runId);
  }

  async saveReview(runId: string, raw: any, editId?: string) {
    const body = z
      .object({
        runRevision: z.number().int().positive().optional(),
        revision: z.number().int().positive().optional(),
        name: z.string().trim().min(1).max(200),
        edl: z.unknown(),
      })
      .strict()
      .parse(raw);
    const run = new CreationService(this.store).get(runId);
    const validated = await this.validateReview(run.projectId, runId, body.edl);
    return this.store.transaction(() => {
      if (!editId && this.store.get(runId).revision !== body.runRevision)
        throw new HttpError(409, '作品版本已变化');
      const old = editId ? this.store.get(editId) : null;
      if (
        old &&
        (old.kind !== 'creation_review_edit' ||
          old.parentId !== runId ||
          old.projectId !== run.projectId)
      )
        throw new HttpError(400, '审看编辑归属无效');
      const data = {
        runId,
        purpose: 'review',
        name: body.name,
        edl: validated.edl,
        sourceRefs: validated.sourceRefs,
      };
      const record = old
        ? this.store.update(old.id, body.revision ?? -1, data)
        : this.store.create('creation_review_edit', run.projectId, data, runId);
      new DomainService(this.store).dependencies(record, validated.sourceRefs);
      return record;
    });
  }

  async exportReview(editId: string, raw: unknown) {
    const body = z
      .object({ revision: z.number().int().positive(), idempotencyKey: z.string().min(8) })
      .strict()
      .parse(raw);
    const edit = this.store.get(editId);
    if (edit.kind !== 'creation_review_edit') throw new HttpError(400, '不是审看编辑');
    const row = this.store.db
      .prepare('SELECT id FROM jobs WHERE idempotency_key=?')
      .get(body.idempotencyKey);
    const existing = row ? this.store.job(String(row.id)) : null;
    if (existing) {
      if (
        existing.input.reviewEdit?.id !== editId ||
        existing.input.reviewEdit.revision !== body.revision
      )
        throw new HttpError(409, '导出幂等键冲突');
      return existing;
    }
    if (edit.revision !== body.revision) throw new HttpError(409, '审看编辑版本已变化');
    const validated = await this.validateReview(edit.projectId, edit.data.runId, edit.data.edl);
    return this.store.transaction(() => {
      if (this.store.get(editId).revision !== body.revision)
        throw new HttpError(409, '审看编辑在校验期间已变化');
      return this.store.createJob(
        'export',
        edit.projectId,
        validated.edl.episodeId,
        {
          name: edit.data.name,
          purpose: 'candidate_review',
          creationRunId: edit.data.runId,
          reviewEdit: { id: editId, revision: edit.revision },
          edl: validated.edl,
          assets: validated.assets,
          sourceAssets: validated.sourceRefs,
          sourceJobIds: [
            ...new Set(
              validated.assets.flatMap((a) =>
                a.data.jobId
                  ? [a.data.jobId]
                  : a.data.derivedSource?.jobId
                    ? [a.data.derivedSource.jobId]
                    : [],
              ),
            ),
          ],
        },
        body.idempotencyKey,
      );
    });
  }

  mediaIssue(runId: string, raw: unknown) {
    const body = z
      .object({
        object: creationRefSchema,
        jobId: z.string().optional(),
        shotId: z.string().min(1).optional(),
        interactionId: z.string().min(1).optional(),
        eventId: z.string().min(1).optional(),
        lineId: z.string().min(1).optional(),
        category: z.string().trim().min(1).max(100),
        description: z.string().trim().min(1).max(10000),
        evidence: z.enum(['user', 'machine', 'unverified']),
        startFrame: z.number().int().nonnegative().optional(),
        endFrame: z.number().int().positive().optional(),
      })
      .strict()
      .parse(raw);
    const run = new CreationService(this.store).get(runId),
      asset = new DomainService(this.store).owned(run.projectId, body.object, 'asset');
    if ((body.shotId || body.interactionId || body.eventId || body.lineId) && !body.jobId)
      throw new HttpError(400, '关联镜头的问题需要原生成任务');
    if (body.jobId) {
      const job = this.store.job(body.jobId);
      if (
        job.projectId !== run.projectId ||
        asset.data.jobId !== job.id ||
        job.input.creationRunId !== runId
      )
        throw new HttpError(400, '问题任务与候选版本归属不匹配');
      validateIssueTarget(job.input.prepared?.shotSpecs || [], body);
    }
    const frames = asset.data.frameCount || Math.floor(asset.data.duration * 24);
    if (
      (body.startFrame !== undefined && (!frames || body.startFrame >= frames)) ||
      (body.endFrame !== undefined &&
        (!frames || body.endFrame > frames || body.endFrame <= (body.startFrame ?? 0)))
    )
      throw new HttpError(400, '问题区间超出候选');
    const issue = this.store.create(
      'creation_media_issue',
      run.projectId,
      { ...body, runId, at: Date.now() },
      runId,
    );
    new DomainService(this.store).dependencies(issue, [body.object]);
    return issue;
  }
}
