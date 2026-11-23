import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { Store } from './db.js';
import { config, inside } from './config.js';
import { runProcess, ingestAsset } from './media.js';
import type { Job } from '../shared/contracts.js';

// Owns the disposable offscreen browser, protocol deadlines and persisted frame checkpoint.
export async function renderDirectorJob(store: Store, root: string, job: Job, signal: AbortSignal) {
  const dir = inside(root, `jobs/${job.id}/previs`),
    scene = job.input.scene;
  await fs.mkdir(dir, { recursive: true });
  const paths = [
    process.env.STUDIO_CHROMIUM,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].filter(Boolean) as string[];
  let executable = '';
  for (const p of paths)
    if (
      await fs.access(p).then(
        () => true,
        () => false,
      )
    ) {
      executable = p;
      break;
    }
  if (!executable)
    throw new Error('预演导出需要本机 Chrome/Edge；可设置 STUDIO_CHROMIUM。其他制作功能仍可使用。');
  const entry = fileURLToPath(new URL('../shared/director-renderer.js', import.meta.url));
  const source = await fs.access(entry).then(
    () => entry,
    () => entry.replace(/\.js$/, '.ts'),
  );
  const bundle = await build({
    entryPoints: [source],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'StudioDirector',
  });
  const html =
    '<!doctype html><canvas id="stage"></canvas><script src="/renderer.js"></script><script>window.director=StudioDirector.createDirectorRenderer(document.querySelector("canvas"));window.ready=true;</script>';
  const server = createServer((req, res) => {
    if (req.url === '/renderer.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(bundle.outputFiles[0].text);
    } else {
      res.setHeader('content-type', 'text/html');
      res.end(html);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as any).port,
    profile = path.join(dir, 'browser-profile');
  await fs.mkdir(profile, { recursive: true });
  const active = path.join(profile, 'DevToolsActivePort');
  await fs.unlink(active).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  });
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      '--remote-debugging-port=0',
      '--user-data-dir=' + profile,
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  let launchError: Error | null = null;
  child.once('error', (error) => {
    launchError = error;
  });
  let socket: WebSocket | undefined,
    seq = 0;
  const pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const call = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      signal.throwIfAborted();
      const id = ++seq,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`离屏渲染 ${method} 超时`));
        }, 30000);
      pending.set(id, { resolve, reject, timer });
      socket!.send(JSON.stringify({ id, method, params }));
    });
  try {
    let debugPort = 0;
    for (let n = 0; n < 100; n++) {
      signal.throwIfAborted();
      if (launchError) throw launchError;
      debugPort = Number((await fs.readFile(active, 'utf8').catch(() => '')).split('\n')[0]);
      if (debugPort) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!debugPort) throw new Error('本机离屏浏览器未能启动');
    const pages = (await (
      await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal })
    ).json()) as any[];
    socket = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('离屏浏览器连接超时')), 15000);
      socket!.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket!.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    socket.on('message', (raw) => {
      const m = JSON.parse(String(raw)),
        p = pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    });
    await call('Page.enable');
    await call('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    for (let i = 0; i < 100; i++) {
      const r = await call('Runtime.evaluate', {
        expression: 'Boolean(window.ready)',
        returnByValue: true,
      });
      if (r.result.value) break;
      if (i === 99) throw new Error('离屏 Three.js 初始化失败');
      await new Promise((r) => setTimeout(r, 100));
    }
    const movie = job.input.nodeOperation.action === 'previs_video',
      count = movie ? scene.frames : 1;
    store.patchJob(job.id, { state: 'running', error: null });
    for (let i = 0; i < count; i++) {
      signal.throwIfAborted();
      const name = path.join(dir, `frame-${String(i).padStart(6, '0')}.png`);
      if (
        i < (store.job(job.id).output.renderedFrames || 0) &&
        (await fs.access(name).then(
          () => true,
          () => false,
        ))
      )
        continue;
      const frame = movie ? i : job.input.nodeOperation.frame;
      const result = await call('Runtime.evaluate', {
        expression: `director.draw(${JSON.stringify(scene)},${frame});director.png()`,
        returnByValue: true,
      });
      if (result.exceptionDetails || !result.result.value?.startsWith('data:image/png;base64,'))
        throw new Error('预演帧渲染失败');
      await fs.writeFile(name + '.part', Buffer.from(result.result.value.split(',')[1], 'base64'));
      await fs.rename(name + '.part', name);
      store.patchJob(job.id, {
        output: { ...store.job(job.id).output, renderedFrames: i + 1, totalFrames: count },
      });
    }
    const output = movie ? path.join(dir, 'previs.mp4') : path.join(dir, 'frame-000000.png');
    if (movie)
      await runProcess(
        config.ffmpeg,
        [
          '-y',
          '-framerate',
          '24',
          '-i',
          path.join(dir, 'frame-%06d.png'),
          '-frames:v',
          String(count),
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          output,
        ],
        { signal, timeout: 600000 },
      );
    const asset = await ingestAsset(store, root, job.projectId!, output, {
      name: job.input.name,
      category: 'previsualization',
      jobId: job.id,
      processingSource: {
        version: 1,
        jobId: job.id,
        action: job.input.nodeOperation.action,
        sources: [job.input.source],
        parameters: {
          frame: job.input.nodeOperation.frame,
          frames: count,
          renderer: 'three-offscreen-v1',
        },
        previewOnly: true,
      },
    });
    store.patchJob(job.id, {
      state: 'succeeded',
      output: { ...store.job(job.id).output, assetIds: [asset.id] },
      error: null,
    });
  } finally {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('渲染已结束'));
    }
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ id: ++seq, method: 'Browser.close' }));
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    socket?.close();
    server.close();
  }
}
