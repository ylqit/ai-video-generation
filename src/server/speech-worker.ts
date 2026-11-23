import { assertAssistantMaySubmit } from './assistant-usage.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store, HttpError } from './db.js';
import type { Job } from '../shared/contracts.js';
import { isSpeechProtocol, voiceHandleIdentity } from '../shared/speech.js';
import { generationDigest } from './h3-guided.js';
import { modelAvailable } from '../shared/models.js';
import { VoiceLibrary } from './voice-library.js';
import { speechAdapters } from './speech-providers.js';
import { speechContext, type VoiceResult } from './speech-transport.js';
import { hashFile, runProcess, ingestAsset, probeMedia } from './media.js';
import { config, inside } from './config.js';
import { executeLipSync } from './sync-lipsync-worker.js';
import { resolveCredential } from './model-credentials.js';

export async function executeSpeechJob(
  store: Store,
  root: string,
  job: Job,
  signal: AbortSignal,
  request: typeof fetch,
) {
  if (job.output.waitSuspended) return;
  if (job.kind === 'lipsync') return executeLipSync(store, root, job, signal, request);
  const e = job.input.modelExecution,
    protocol = e.protocol;
  if (!isSpeechProtocol(protocol)) throw new HttpError(400, '任务协议不是已实现的语音服务');
  const adapter = speechAdapters[protocol],
    library = new VoiceLibrary(store);
  const dir = inside(root, `jobs/${job.id}/speech`);
  if (job.state === 'queued') {
    if (e.protocol === 'tencent-speech') {
      await resolveCredential(store, e.connection.data.credentials.secretId);
      await resolveCredential(store, e.connection.data.credentials.secretKey);
    } else await resolveCredential(store, e.connection.data.credential);
  }
  await fs.mkdir(dir, { recursive: true });
  const patchOutput = (patch: any) =>
    store.patchJob(job.id, { output: { ...store.job(job.id).output, ...patch } });
  const context = speechContext(
    store,
    e.connection,
    e.modelId,
    job.id,
    {
      receiptDir: ['queued', 'preparing', 'unknown', 'submitting'].includes(job.state)
        ? path.join(dir, 'exchanges')
        : undefined,
      replayOnly: ['unknown', 'submitting'].includes(job.state),
      checkpoint: job.output.uploads || {},
      saveCheckpoint(patch) {
        patchOutput({ uploads: { ...store.job(job.id).output.uploads, ...patch } });
      },
      beforeSubmit() {
        if (['unknown', 'submitting'].includes(job.state)) return;
        assertAssistantMaySubmit(store, job);
        const current = store.job(job.id),
          connection = store.db
            .prepare('SELECT data FROM model_connections WHERE id=?')
            .get(e.connection.id);
        if (current.cancelRequested) throw new HttpError(409, '提交前已取消');
        if (
          !connection ||
          !modelAvailable(JSON.parse(String(connection.data)), e.modelId) ||
          !library.voice(job.input.voice.id).enabled
        ) {
          store.patchJob(job.id, { state: 'queued', holdReason: 'model_connection_disabled' });
          throw new HttpError(409, '连接或音色已停用，尚未提交');
        }
        store.patchJob(job.id, {
          state: 'submitting',
          output: { ...current.output, executionDir: dir },
          error: null,
        });
      },
    },
    signal,
    request,
  );
  if (job.state === 'archiving' && job.output.descriptor) {
    await archiveSpeechResult(store, root, job, job.output.descriptor, signal, request);
    return;
  }
  let result: VoiceResult;
  if (['submitted', 'running'].includes(job.state)) {
    if (!job.output.remoteId) throw new Error('缺少已受理声音任务身份');
    if (Date.now() - (job.output.lastCheckedAt || 0) < 1000) return;
    result = await adapter.query(context, job.output.remoteId, job.input);
  } else {
    if (job.state === 'queued') {
      const currentVoice = library.voice(job.input.voice.id);
      if (!currentVoice.enabled) {
        store.patchJob(job.id, { holdReason: 'voice_disabled' });
        return;
      }
      if (job.kind === 'speech') {
        const status = store.setting<any>(
          `voice_probe:${generationDigest(voiceHandleIdentity(job.input.voice.data.handle))}`,
          null,
        );
        const expires = status ? status.expiresAt : job.input.voice.data.handle?.expiresAt;
        if ((status && status.state !== 'ready') || (expires && expires <= Date.now())) {
          store.patchJob(job.id, { holdReason: 'voice_unavailable' });
          return;
        }
      }
      const line = job.input.line;
      if (line) {
        const ep = store.get(line.episode.id),
          actual = ep.data.shots
            ?.find((s: any) => s.id === line.shotId)
            ?.directing?.sound?.dialogue?.find((l: any) => l.id === line.lineId);
        if (
          !actual ||
          actual.text !== job.input.text ||
          actual.instanceId !== line.instanceId ||
          JSON.stringify(actual.voiceProfile) !== JSON.stringify(line.voiceProfile) ||
          store.get(line.voiceProfile.id).data.stale
        ) {
          store.patchJob(job.id, { holdReason: 'dependencies_need_review' });
          return;
        }
      }
      store.patchJob(job.id, { state: 'preparing', error: null });
      await fs.writeFile(path.join(dir, 'input.json'), JSON.stringify(job.input, null, 2));
    }
    if (job.kind === 'voice_clone') {
      const sample = job.input.sampleMedia.data,
        file = inside(root, sample.path);
      if ((await hashFile(file)) !== sample.sha256) throw new Error('克隆样本内容已变化');
      const target = path.join(dir, 'sample.wav');
      await runProcess(
        config.ffmpeg,
        [
          '-y',
          '-v',
          'error',
          '-i',
          file,
          '-ss',
          String(job.input.sample.in),
          '-t',
          String(job.input.sample.out - job.input.sample.in),
          '-vn',
          '-ac',
          '1',
          '-ar',
          '24000',
          '-c:a',
          'pcm_s16le',
          target,
        ],
        { signal },
      );
      result = await adapter.clone(context, job.input, await fs.readFile(target));
    } else result = await adapter.synthesize(context, job.input);
  }
  signal.throwIfAborted();
  const suspended = store.job(job.id).output.waitSuspended;
  if (result.state === 'pending') {
    store.patchJob(job.id, {
      state: suspended ? 'cancelled' : 'submitted',
      promptId: result.remoteId || null,
      error: null,
      output: {
        ...store.job(job.id).output,
        remoteId: result.remoteId,
        providerStatus: result.providerStatus,
        lastCheckedAt: Date.now(),
      },
    });
  } else if (result.state === 'failed') {
    store.patchJob(job.id, {
      state: 'failed',
      error: `远端声音任务失败：${result.providerStatus}`,
      output: {
        ...store.job(job.id).output,
        remoteId: result.remoteId,
        providerStatus: result.providerStatus,
      },
    });
  } else {
    let descriptor: any = { ...result, receivedAt: Date.now() };
    if (result.audio?.bytes) {
      const file = path.join(dir, `response.${result.audio.ext}`);
      await fs.writeFile(file, result.audio.bytes);
      descriptor = {
        ...descriptor,
        audio: {
          ext: result.audio.ext,
          file: path.relative(root, file).replaceAll('\\', '/'),
          sha256: await hashFile(file),
        },
      };
    }
    store.patchJob(job.id, {
      state: suspended ? 'cancelled' : 'archiving',
      error: null,
      output: {
        ...store.job(job.id).output,
        descriptor,
        remoteId: result.remoteId || null,
        usage: result.usage || null,
      },
    });
  }
}

export async function archiveSpeechResult(
  store: Store,
  root: string,
  job: Job,
  descriptor: any,
  signal: AbortSignal,
  request: typeof fetch,
) {
  const library = new VoiceLibrary(store),
    dir = inside(root, `jobs/${job.id}/speech`);
  let media: any;
  if (descriptor.audio) {
    let file: string;
    if (descriptor.audio.file) {
      file = inside(root, descriptor.audio.file);
      if ((await hashFile(file)) !== descriptor.audio.sha256)
        throw new Error('声音回执文件哈希不匹配');
    } else {
      file = path.join(dir, `download.${descriptor.audio.ext}`);
      const url = new URL(descriptor.audio.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('供应商媒体地址无效');
      const response = await request(url, {
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
      });
      if (!response.ok)
        throw new Error(`声音归档下载失败 HTTP ${response.status}；保留原任务，不重新合成`);
      const chunks: Uint8Array[] = [];
      let count = 0;
      if (response.body)
        for await (const chunk of response.body as any) {
          count += chunk.length;
          if (count > 128 * 1024 ** 2) throw new Error('声音下载超过上限');
          chunks.push(chunk);
        }
      await fs.writeFile(file, Buffer.concat(chunks));
      descriptor = {
        ...descriptor,
        audio: {
          ...descriptor.audio,
          file: path.relative(root, file).replaceAll('\\', '/'),
          sha256: await hashFile(file),
        },
      };
      store.patchJob(job.id, { output: { ...store.job(job.id).output, descriptor } });
    }
    const existing = job.projectId
      ? store
          .list('asset', job.projectId)
          .find((a) => a.data.jobId === job.id && a.data.mediaType === 'audio')
      : store.db
          .prepare(
            "SELECT i.id FROM library_items i JOIN library_versions v ON v.id=i.id AND v.revision=i.revision WHERE json_extract(v.bundle,'$.kind')='voice_media' AND json_extract(v.bundle,'$.data.jobId')=?",
          )
          .get(job.id);
    media = existing
      ? job.projectId
        ? existing
        : library.get(existing.id as string)
      : job.projectId
        ? await ingestAsset(store, root, job.projectId, file, {
            name: job.input.name,
            category: 'dialogue_candidate',
            jobId: job.id,
            episodeId: job.episodeId,
          })
        : await library.importAudio(root, file, job.input.name + '／试听', job.id);
    const probe = await probeMedia(file),
      audio = probe.streams.find((s: any) => s.type === 'audio');
    const timeBase = audio?.timeBase?.split('/').map(Number),
      exactSamples =
        audio?.durationTs !== undefined && timeBase?.length === 2
          ? ((audio.durationTs * timeBase[0]) / timeBase[1]) * Number(audio.sampleRate)
          : null;
    store.patchJob(job.id, {
      output: {
        ...store.job(job.id).output,
        audioTiming: {
          duration: probe.duration,
          sampleRate: Number(audio?.sampleRate),
          sampleCount: exactSamples === null ? null : Math.round(exactSamples),
          sampleCountBasis: exactSamples === null ? 'unavailable' : 'stream duration_ts/time_base',
          workingFps: 24,
          mapping: 'source seconds; playbackRate=1; EDL boundaries separately chosen',
        },
      },
    });
  }
  signal.throwIfAborted();
  if (store.job(job.id).output.waitSuspended) return;
  store.transaction(() => {
    let voiceResult = store.job(job.id).output.voiceResult;
    if (job.kind === 'voice_clone' && !voiceResult) {
      if (!descriptor.voiceId) throw new Error('复刻结果缺少可用音色身份');
      const current = library.voice(job.input.voice.id),
        e = job.input.modelExecution;
      const data = {
        ...job.input.voice.data,
        state:
          descriptor.state === 'verification_required' ? 'verification_required' : 'auditionable',
        handle: {
          connection: e.selection.connection,
          protocol: e.protocol,
          modelId: e.modelId,
          region: e.connection.data.region || '',
          voiceId: descriptor.voiceId,
          providerStatus: descriptor.providerStatus,
          expiresAt: descriptor.expiresAt || null,
          jobId: job.id,
        },
        review: null,
        audition: media ? { id: media.id, revision: media.revision } : null,
      };
      const saved =
        current.revision === job.input.voice.revision
          ? library.write('global_voice', data, current.id, current.revision)
          : library.write('global_voice', { ...data, name: `${data.name}／复刻候选` });
      voiceResult = { id: saved.id, revision: saved.revision };
    }
    store.patchJob(job.id, {
      state: 'succeeded',
      error: null,
      output: {
        ...store.job(job.id).output,
        voiceResult,
        ...(media
          ? job.projectId
            ? { assetIds: [media.id] }
            : { libraryMedia: { id: media.id, revision: media.revision } }
          : {}),
        reviewState: 'unreviewed',
      },
    });
    if (job.kind === 'speech') {
      const key = `voice_probe:${generationDigest(voiceHandleIdentity(job.input.voice.data.handle))}`,
        observedAt = descriptor.receivedAt || job.createdAt,
        previous = store.setting<any>(key, null);
      // Archiving old audio proves availability at receipt time, not after a newer failed probe.
      if (!previous || previous.at <= observedAt)
        store.setSetting(key, {
          state: 'ready',
          providerStatus: 'synthesis_confirmed',
          expiresAt:
            job.input.modelExecution.protocol === 'minimax-speech' ||
            job.input.modelExecution.protocol === 'doubao-speech'
              ? null
              : job.input.voice.data.handle.expiresAt,
          at: observedAt,
          jobId: job.id,
        });
    }
  });
}
