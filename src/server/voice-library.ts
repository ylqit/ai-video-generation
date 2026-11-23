import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import {
  globalVoiceSchema,
  voiceHandleIdentity,
  type GlobalVoice,
  type SpeechProtocol,
} from '../shared/speech.js';
import { hashFile, probeMedia } from './media.js';
import { inside } from './config.js';
import { ModelRegistry } from './model-registry.js';
import { generationDigest } from './h3-guided.js';

export class VoiceLibrary {
  constructor(public store: Store) {}
  get(id: string, revision?: number) {
    const row = this.store.db
      .prepare(
        `SELECT i.id,i.revision headRevision,i.created_at,m.*,m.revision revision_meta,v.revision,v.bundle
      FROM library_items i JOIN library_metadata m ON m.id=i.id
      JOIN library_versions v ON v.id=i.id AND v.revision=COALESCE(?,i.revision) WHERE i.id=?`,
      )
      .get(revision ?? null, id);
    if (!row) throw new HttpError(404, '全局声音版本不存在');
    return {
      id,
      revision: Number(row.revision),
      headRevision: Number(row.headRevision),
      kind: String(row.kind),
      data: JSON.parse(String(row.bundle)).data,
      folderId: row.folder_id as string | null,
      enabled: !!row.enabled,
      favorite: !!row.favorite,
      metadataRevision: Number(row.revision_meta || 0),
    };
  }
  voice(id: string, revision?: number): ReturnType<VoiceLibrary['get']> & { data: GlobalVoice } {
    const record = this.get(id, revision);
    if (record.kind !== 'global_voice') throw new HttpError(400, '需要音色版本');
    return { ...record, data: globalVoiceSchema.parse(record.data) };
  }
  list(query: {
    folderId?: string | null;
    search?: string;
    favorite?: boolean;
    offset: number;
    limit: number;
  }) {
    const where = `m.kind='global_voice' AND (?=1 OR m.folder_id IS ?) AND (?='' OR i.name LIKE ? OR v.bundle LIKE ?) AND (?=0 OR m.favorite=1)`;
    const args = [
      query.folderId === undefined ? 1 : 0,
      query.folderId ?? null,
      query.search || '',
      `%${query.search || ''}%`,
      `%${query.search || ''}%`,
      query.favorite ? 1 : 0,
    ];
    const from =
      'library_items i JOIN library_metadata m ON m.id=i.id JOIN library_versions v ON v.id=i.id AND v.revision=i.revision';
    return {
      items: this.store.db
        .prepare(
          `SELECT i.id FROM ${from} WHERE ${where} ORDER BY i.created_at DESC,i.id LIMIT ? OFFSET ?`,
        )
        .all(...args, query.limit, query.offset)
        .map((r) => {
          const voice = this.voice(String(r.id));
          const job = this.store.db
            .prepare(
              "SELECT id,state,error FROM jobs WHERE kind='voice_clone' AND json_extract(input,'$.voice.id')=? ORDER BY created_at DESC,id DESC LIMIT 1",
            )
            .get(voice.id);
          const probe = voice.data.handle
            ? this.store.setting<any>(
                `voice_probe:${generationDigest(voiceHandleIdentity(voice.data.handle))}`,
                null,
              )
            : null;
          return {
            ...voice,
            activity: job
              ? { id: String(job.id), state: String(job.state), error: job.error }
              : null,
            availability: probe
              ? { state: probe.state, providerStatus: probe.providerStatus, at: probe.at }
              : null,
          };
        }),
      total: Number(
        this.store.db.prepare(`SELECT count(*) n FROM ${from} WHERE ${where}`).get(...args)?.n,
      ),
      ...query,
    };
  }
  write(kind: 'global_voice' | 'voice_media', data: any, id?: string, revision = 0) {
    return this.store.transaction(() => {
      const old = id ? this.get(id) : null;
      if ((old?.revision || 0) !== revision || (old && old.kind !== kind))
        throw new HttpError(409, '声音资料已变化，请比较后保存');
      const key = id || randomUUID(),
        next = revision + 1;
      this.store.db
        .prepare(
          'INSERT INTO library_items VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,name=excluded.name',
        )
        .run(key, next, data.name, Date.now());
      this.store.db
        .prepare('INSERT INTO library_versions VALUES(?,?,?)')
        .run(key, next, JSON.stringify({ kind, data, roots: [], documents: [] }));
      if (!old)
        this.store.db.prepare('INSERT INTO library_metadata(id,kind) VALUES(?,?)').run(key, kind);
      this.store.event(null, 'voice_library', { id: key, revision: next, kind });
      return this.get(key);
    });
  }
  save(
    raw: unknown,
    id?: string,
    revision = 0,
    idempotencyKey?: string,
  ): ReturnType<VoiceLibrary['get']> {
    if (idempotencyKey)
      return this.store.transaction(() => {
        const key = `voice_save:${idempotencyKey}`,
          digest = generationDigest({ raw, id: id || null, revision }),
          prior = this.store.setting<any>(key, null);
        if (prior) {
          if (prior.digest !== digest) throw new HttpError(409, '保存回执与输入不符');
          return this.voice(prior.id, prior.revision);
        }
        const saved = this.save(raw, id, revision);
        this.store.setSetting(key, { id: saved.id, revision: saved.revision, digest });
        return saved;
      });
    const data = globalVoiceSchema.parse(raw),
      old = id ? this.voice(id) : null;
    // Lifecycle and remote identity require their own evidence-bearing operations.
    if (
      JSON.stringify(data.handle) !== JSON.stringify(old?.data.handle ?? null) ||
      data.state !== (old?.data.state || 'draft') ||
      JSON.stringify(data.review) !== JSON.stringify(old?.data.review ?? null) ||
      JSON.stringify(data.audition) !== JSON.stringify(old?.data.audition ?? null)
    )
      throw new HttpError(400, '远端音色、试听与确认状态由专用操作更新');
    for (const sample of data.samples) {
      const media = this.get(sample.media.id, sample.media.revision);
      if (media.kind !== 'voice_media' || sample.out > media.data.duration)
        throw new HttpError(400, '样本范围不属于固定音频');
    }
    return this.write('global_voice', data, id, revision);
  }
  register(id: string, revision: number, raw: any) {
    const voice = this.voice(id, revision),
      body = z
        .object({
          connection: z.object({ id: z.string(), revision: z.number().int().positive() }),
          modelId: z.string().min(1),
          voiceId: z.string().min(1),
          providerStatus: z.string().min(1),
          expiresAt: z.number().nullable().default(null),
        })
        .strict()
        .parse(raw);
    const execution = new ModelRegistry(this.store).resolveSelection({
      connection: body.connection,
      modelId: body.modelId,
    });
    if (execution.capabilities.kind !== 'speech') throw new HttpError(400, '需要语音模型');
    return this.write(
      'global_voice',
      {
        ...voice.data,
        state: 'auditionable',
        review: null,
        audition: null,
        handle: {
          ...body,
          protocol: execution.protocol as SpeechProtocol,
          region: execution.connection.data.region || '',
        },
      },
      id,
      revision,
    );
  }
  confirm(id: string, revision: number, raw: any) {
    const voice = this.voice(id, revision),
      body = z
        .object({
          audition: z.object({ id: z.string(), revision: z.number().int().positive() }),
          listened: z.literal(true),
          notes: z.string().trim().min(1),
        })
        .strict()
        .parse(raw);
    const media = this.get(body.audition.id, body.audition.revision);
    if (!voice.data.handle || media.kind !== 'voice_media' || !media.data.jobId)
      throw new HttpError(400, '请先生成并听审此音色的试听');
    const job = this.store.job(media.data.jobId);
    if (
      job.state !== 'succeeded' ||
      !(
        (job.kind === 'speech' &&
          job.input.voice.id === id &&
          JSON.stringify(job.input.voice.data.handle) === JSON.stringify(voice.data.handle)) ||
        (job.kind === 'voice_clone' &&
          job.output.voiceResult?.id === id &&
          voice.data.handle.jobId === job.id)
      )
    )
      throw new HttpError(409, '试听不是当前音色句柄的实际结果');
    return this.write(
      'global_voice',
      {
        ...voice.data,
        state: 'confirmed',
        audition: body.audition,
        review: { listened: true, notes: body.notes, at: Date.now() },
      },
      id,
      revision,
    );
  }
  metadata(id: string, raw: unknown) {
    const body = z
      .object({
        revision: z.number().int().positive(),
        folderId: z.string().nullable(),
        enabled: z.boolean(),
        favorite: z.boolean(),
      })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      this.get(id);
      if (
        body.folderId &&
        !this.store.db.prepare('SELECT id FROM voice_folders WHERE id=?').get(body.folderId)
      )
        throw new HttpError(400, '目录不存在');
      const result = this.store.db
        .prepare(
          'UPDATE library_metadata SET folder_id=?,enabled=?,favorite=?,revision=revision+1 WHERE id=? AND revision=?',
        )
        .run(body.folderId, +body.enabled, +body.favorite, id, body.revision);
      if (!result.changes) throw new HttpError(409, '整理信息已变化');
      return this.get(id);
    });
  }
  folders(parentId: string | null) {
    return this.store.db
      .prepare(
        `SELECT f.*, (SELECT count(*) FROM voice_folders c WHERE c.parent_id=f.id) children FROM voice_folders f WHERE parent_id IS ? ORDER BY name,id`,
      )
      .all(parentId);
  }
  folderPath(id: string) {
    const path: { id: string; name: string; parent_id: string | null }[] = [],
      seen = new Set<string>();
    let current: string | null = id;
    while (current) {
      if (seen.has(current)) throw new HttpError(409, '目录关系存在循环');
      seen.add(current);
      const row = this.store.db
        .prepare('SELECT id,name,parent_id FROM voice_folders WHERE id=?')
        .get(current) as (typeof path)[number] | undefined;
      if (!row) throw new HttpError(404, '目录不存在');
      path.unshift(row);
      current = row.parent_id;
    }
    return path;
  }
  folder(raw: unknown, id?: string) {
    const body = z
      .object({
        name: z.string().trim().min(1).max(120),
        parentId: z.string().nullable(),
        revision: z.number().int().nonnegative(),
      })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const key = id || randomUUID();
      let parent = body.parentId;
      const seen = new Set([key]);
      while (parent) {
        if (seen.has(parent)) throw new HttpError(400, '目录不能循环');
        seen.add(parent);
        const row = this.store.db
          .prepare('SELECT parent_id FROM voice_folders WHERE id=?')
          .get(parent);
        if (!row) throw new HttpError(404, '父目录不存在');
        parent = row.parent_id as string | null;
      }
      if (id) {
        if (
          !this.store.db
            .prepare(
              'UPDATE voice_folders SET name=?,parent_id=?,revision=revision+1 WHERE id=? AND revision=?',
            )
            .run(body.name, body.parentId, id, body.revision).changes
        )
          throw new HttpError(409, '目录版本已变化');
      } else {
        if (body.revision !== 0) throw new HttpError(409, '新目录版本应为 0');
        this.store.db
          .prepare('INSERT INTO voice_folders VALUES(?,?,?,1)')
          .run(key, body.parentId, body.name);
      }
      return this.store.db.prepare('SELECT * FROM voice_folders WHERE id=?').get(key);
    });
  }
  deleteFolder(id: string, revision: number) {
    return this.store.transaction(() => {
      if (
        this.store.db
          .prepare(
            'SELECT id FROM voice_folders WHERE parent_id=? UNION ALL SELECT id FROM library_metadata WHERE folder_id=? LIMIT 1',
          )
          .get(id, id)
      )
        throw new HttpError(409, '先移动目录中的内容');
      if (
        !this.store.db
          .prepare('DELETE FROM voice_folders WHERE id=? AND revision=?')
          .run(id, revision).changes
      )
        throw new HttpError(409, '目录版本已变化');
    });
  }
  async importAudio(root: string, file: string, name: string, jobId?: string, sourceName = file) {
    const stat = await fs.stat(file);
    if (stat.size > 128 * 1024 ** 2) throw new HttpError(400, '音频上限 128 MB');
    const media = await probeMedia(file);
    if (media.mediaType !== 'audio' || media.duration <= 0)
      throw new HttpError(400, '需要有效音频');
    const sha256 = await hashFile(file),
      ext = path.extname(sourceName).toLowerCase();
    if (!['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac'].includes(ext))
      throw new HttpError(400, '不支持此音频容器');
    const relative = `media/global/${sha256}${ext}`;
    await fs.mkdir(path.dirname(inside(root, relative)), { recursive: true });
    await fs.copyFile(file, inside(root, relative));
    return this.write('voice_media', {
      ...media,
      name,
      path: relative,
      sha256,
      jobId: jobId || null,
    });
  }
  async convertProfile(root: string, id: string, revision: number) {
    const old = this.store.get(id, revision);
    if (old.kind !== 'voice_profile' || old.data.version !== 1)
      throw new HttpError(400, '需要旧声音资料固定版本');
    const key = `voice_conversion:${id}:${revision}`;
    const existing = this.store.setting<any>(key, null);
    if (existing) return this.voice(existing.id, existing.revision);
    const samples: GlobalVoice['samples'] = [];
    for (const s of old.data.samples) {
      const asset = this.store.get(s.asset.id, s.asset.revision);
      if (
        asset.kind !== 'asset' ||
        asset.projectId !== old.projectId ||
        asset.data.mediaType !== 'audio'
      )
        throw new HttpError(400, '旧样本不是本作品固定音频');
      const file = inside(root, asset.data.path);
      if ((await hashFile(file)) !== asset.data.sha256)
        throw new HttpError(409, '旧样本内容已变化');
      const media = await this.importAudio(root, file, asset.data.name);
      samples.push({
        media: { id: media.id, revision: media.revision },
        in: s.in,
        out: s.out,
        purpose: 'reference',
        source: `原声音 ${id} v${revision} / 素材 ${asset.id} v${asset.revision}`,
        transcript: '',
        listened: s.inspected,
        notes: s.notes,
      });
    }
    return this.store.transaction(() => {
      const applied = this.store.setting<any>(key, null);
      if (applied) return this.voice(applied.id, applied.revision);
      const result = this.save({
        name: old.data.name,
        language: old.data.language,
        description: old.data.timbre,
        pronunciation: old.data.pronunciation,
        performance: old.data.performance,
        samples,
      });
      this.store.setSetting(key, { id: result.id, revision: result.revision });
      return result;
    });
  }
}
