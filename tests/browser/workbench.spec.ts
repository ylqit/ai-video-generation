import { test, expect } from '@playwright/test';
import path from 'node:path';
async function openWorkspace(page: any, request: any) {
  const project = await (
    await request.post('/api/projects', {
      data: { title: 'SDD 浏览器 ' + Date.now(), mode: 'short', brief: '' },
    })
  ).json();
  const canvas = await (
    await request.post('/api/projects/' + project.id + '/canvases', {
      data: {
        version: 2,
        title: '交互核查',
        nodes: ['A', 'B', 'C'].map((id, i) => ({
          id,
          type: 'note',
          title: '节点 ' + id,
          text: '正文 ' + id,
          x: 80 + i * 340,
          y: 100,
        })),
        edges: [],
      },
    })
  ).json();
  await page.goto('/#project=' + project.id);
  await expect(page.getByLabel('当前画布')).toBeVisible();
  return { project, canvas };
}
test('CTX-UI explicit multi-selection survives focus changes, removal, refresh and input keyboard shortcuts', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkspace(page, request);
  for (const id of ['A', 'B', 'C'])
    await page.getByRole('checkbox', { name: '勾选 节点 ' + id, exact: true }).check();
  await page.getByRole('button', { name: '加入助手 · 3', exact: true }).click();
  await expect(page.locator('.reference-chips > article')).toHaveCount(3);
  await page.getByRole('checkbox', { name: '勾选 节点 A', exact: true }).uncheck();
  await page.locator('.node-card header strong').nth(1).click();
  await expect(page.locator('.reference-chips > article')).toHaveCount(3);
  await page.getByLabel('助手消息').fill('保留这份消息');
  await page.getByLabel('助手消息').press('Control+a');
  await page.getByLabel('助手消息').press('Control+c');
  await expect(page.locator('.node-card')).toHaveCount(3);
  await page.getByRole('button', { name: '移除引用 节点 A', exact: true }).click();
  await expect(page.locator('.reference-chips > article')).toHaveCount(2);
  await page.reload();
  await page.getByRole('button', { name: '✧ 助手', exact: true }).click();
  await expect(page.locator('.reference-chips > article')).toHaveCount(2);
  await expect(page.getByLabel('助手消息')).toHaveValue('保留这份消息');
});
test('UPLOAD-RECOVERY response loss reconciles an already saved import and partial failure leaves successful files intact', async ({
  page,
  request,
}) => {
  const { canvas } = await openWorkspace(page, request);
  let lost = false;
  await page.route('**/api/projects/*/imports', async (route) => {
    if (route.request().method() === 'POST' && !lost) {
      lost = true;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await page.locator('.node-shelf input[type=file]').setInputFiles([
    { name: 'once.md', mimeType: 'text/markdown', buffer: Buffer.from('一次成功') },
    { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') },
  ]);
  await expect(page.locator('.import-progress')).toContainText('broken.png');
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/canvases/' + canvas.id)).json()).canvas.data.nodes.length,
    )
    .toBe(4);
  await page
    .locator('.import-progress article')
    .filter({ hasText: 'once.md' })
    .getByRole('button')
    .click();
  await expect(
    page.locator('.import-progress article').filter({ hasText: 'once.md' }),
  ).toContainText('就绪');
  expect(
    (await (await request.get('/api/canvases/' + canvas.id)).json()).canvas.data.nodes,
  ).toHaveLength(4);
});
test('GEN-UI node tray preserves values across H3/Seedance switches and produces an Images candidate in place', async ({
  page,
  request,
}) => {
  const { project, canvas } = await openWorkspace(page, request);
  const models = (await (await request.get('/api/model-catalog')).json()).models;
  const h3 = models.find((m: any) => m.protocol === 'comfy-h3');
  const c = (await (await request.get('/api/canvases/' + canvas.id)).json()).canvas;
  await request.put('/api/canvases/' + c.id, {
    data: {
      revision: c.revision,
      data: {
        ...c.data,
        nodes: [
          {
            id: 'video',
            type: 'video_generate',
            title: '视频制作',
            x: 60,
            y: 70,
            text: 'Keep this camera direction.',
            generation: {
              model: {
                connection: { id: h3.connection.id, revision: h3.connection.revision },
                modelId: h3.id,
                mode: 'authored',
                promptProfile: 'automatic',
                parameters: { steps: 20, seed: 123 },
              },
              mode: 't2v',
              seconds: 5,
            },
          },
          {
            id: 'image',
            type: 'image_generate',
            title: '图片制作',
            x: 490,
            y: 70,
            text: 'A quiet classroom.',
          },
        ],
        edges: [],
      },
    },
  });
  await page.reload();
  await page.getByText('视频制作', { exact: true }).click();
  const tray = page.getByLabel('节点制作托盘');
  await expect(tray).toBeVisible();
  const select = tray.getByLabel('制作模型');
  const seedance = await select
    .locator('option')
    .filter({ hasText: 'Seedance' })
    .getAttribute('value');
  await select.selectOption(seedance!);
  await expect(tray).toContainText('steps=20 不适用');
  await expect(tray.getByLabel('画面与动作 / Prompt')).toHaveValue('Keep this camera direction.');
  const old = await select
    .locator('option')
    .filter({ hasText: 'H3 协议模拟' })
    .getAttribute('value');
  await select.selectOption(old!);
  await expect(tray.getByRole('button', { name: '查看执行输入', exact: true })).toBeEnabled();
  await page.getByText('图片制作', { exact: true }).click();
  const imageSelect = tray.getByLabel('制作模型');
  await expect(imageSelect.locator('option')).toHaveCount(2);
  await imageSelect.selectOption({ index: 1 });
  await tray.getByRole('button', { name: '查看执行输入', exact: true }).click();
  await expect(tray.getByRole('button', { name: '生成新候选' })).toBeEnabled();
  await tray.getByRole('button', { name: '生成新候选' }).click();
  await expect(tray.getByText('历史候选 · 1', { exact: true })).toBeVisible({ timeout: 30000 });
  const after = await (await request.get('/api/canvases/' + canvas.id)).json();
  expect(after.canvas.data.nodes.find((n: any) => n.id === 'image').outputs).toHaveLength(1);
  expect(after.canvas.data.nodes.find((n: any) => n.id === 'video').text).toBe(
    'Keep this camera direction.',
  );
  await page.getByRole('button', { name: '✧ 助手', exact: true }).click();
  await page.getByRole('button', { name: '＋ 引用', exact: true }).click();
  const source = page.locator('.context-source-list article').filter({ hasText: '图片制作' });
  await source.getByText('1 个具体输出', { exact: true }).click();
  await source.locator('details').getByRole('checkbox').check();
  await page.getByRole('button', { name: '添加 1 项', exact: true }).click();
  await expect(page.locator('.reference-chips > article')).toHaveCount(1);
  await expect(page.locator('.reference-chips > article')).toContainText('图片制作');
  const draft = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem('studio:conversation-v2:' + id)!),
    canvas.id,
  );
  expect(draft.references[0].kind).toBe('output');
  expect(draft.references[0].outputKey).toBe(
    after.canvas.data.nodes.find((n: any) => n.id === 'image').outputs[0].key,
  );
});
test('INT-MEDIA local video player, extraction, direct editing and actual export use the same fixed source', async ({
  page,
  request,
}) => {
  const project = await (
    await request.post('/api/projects', {
      data: { title: '媒体生产 ' + Date.now(), mode: 'short', brief: '' },
    })
  ).json();
  const canvas = await (
    await request.post('/api/projects/' + project.id + '/canvases', {
      data: { version: 2, title: '媒体', nodes: [], edges: [] },
    })
  ).json();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#project=' + project.id);
  await page
    .locator('.node-shelf input[type=file]')
    .setInputFiles(path.resolve(process.env.STUDIO_TEST_MEDIA_ROOT!, 'synthetic.mp4'));
  await expect(page.locator('.import-progress')).toContainText('就绪');
  await page.locator('.import-progress').getByRole('button', { name: '收起' }).click();
  const card = page.locator('.node-card').filter({ hasText: 'synthetic.mp4' }).first();
  const video = card.locator('video');
  await expect(video).toHaveAttribute('controls', '');
  await video.evaluate((v: HTMLVideoElement) => v.load());
  await expect(card.getByRole('button', { name: '提取此帧', exact: true })).toBeEnabled();
  await card.getByRole('button', { name: '提取此帧', exact: true }).click();
  await expect
    .poll(
      async () => {
        const r = await (await request.get('/api/canvases/' + canvas.id)).json();
        return r.canvas.data.nodes.filter((n: any) => n.type === 'image').length;
      },
      { timeout: 30000 },
    )
    .toBe(1);
  await card.getByText('更多', { exact: true }).click();
  await card.getByRole('button', { name: '加入剪辑', exact: true }).click();
  await expect(page.getByLabel('交互时间线')).toBeVisible();
  const handle = page.getByLabel('裁剪片段 1 出点', { exact: true });
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 - 2, box!.y + box!.height / 2, { steps: 2 });
  await page.mouse.up();
  await expect(page.getByLabel('出点帧', { exact: true })).toHaveValue('119');
  await expect(page.getByLabel('交互时间线')).toContainText('119 帧');
  await page.getByLabel('画面片段 1', { exact: true }).click();
  await page.getByLabel('播放头帧', { exact: true }).fill('48');
  await page.getByLabel('播放头帧', { exact: true }).press('Tab');
  await page.getByRole('button', { name: '在播放头分割', exact: true }).click();
  await expect(page.locator('.timeline-clip')).toHaveCount(2);
  await page.getByRole('button', { name: '保存剪辑', exact: true }).click();
  await page.getByRole('button', { name: '导出 MP4', exact: true }).click();
  await expect(page.getByRole('link', { name: '下载 MP4', exact: true })).toBeVisible({
    timeout: 45000,
  });
  const final = await (await request.get('/api/canvases/' + canvas.id)).json();
  expect(final.edl.data.clips).toHaveLength(2);
  const result = final.assets.find((a: any) => a.data.category === 'export');
  expect(result.data.frameCount).toBe(119);
  expect(errors).toEqual([]);
  await page.screenshot({ path: '.artifacts/workbench-browser/edit-1440.png', fullPage: true });
});
test('AGENT-UI unified composer executes a bounded simulated production and archives without quality approvals', async ({
  page,
  request,
}) => {
  const { canvas } = await openWorkspace(page, request);
  await page.getByRole('button', { name: '✧ 助手', exact: true }).click();
  await page.getByLabel('助手模式').selectOption('production');
  await page.locator('.execution-scope summary').click();
  await page.getByLabel('允许修改', { exact: true }).selectOption('new');
  await page.getByLabel('媒体生成', { exact: true }).check();
  await page.getByLabel('视频请求', { exact: true }).fill('1');
  await page.getByLabel('视频秒数', { exact: true }).fill('5');
  await page
    .locator('.execution-scope label')
    .filter({ hasText: /H3 协议模拟.*video/ })
    .getByRole('checkbox')
    .check();
  await page.locator('.execution-scope summary').click();
  await page.getByLabel('助手消息').fill('创建剧本与一个镜头，生成一次模拟视频，选用并导出。');
  await page.getByRole('button', { name: '开始制作', exact: true }).click();
  await expect
    .poll(
      async () => {
        const c = await (await request.get('/api/canvases/' + canvas.id)).json();
        return c.assistant?.data.state;
      },
      { timeout: 90000 },
    )
    .toBe('completed');
  const r = await (await request.get('/api/canvases/' + canvas.id)).json();
  expect(r.jobs.filter((j: any) => j.kind === 'generation')).toHaveLength(1);
  expect(r.assets.some((a: any) => a.data.category === 'export')).toBe(true);
});
test('INT-LAYOUT 980/1440/1920 viewports and repeated assistant lifecycle retain reachable controls without rendering errors', async ({
  page,
  request,
}) => {
  await openWorkspace(page, request);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const width of [980, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByRole('button', { name: '✧ 助手', exact: true }).click();
    await expect(page.getByLabel('助手消息')).toBeVisible();
    const box = await page.getByLabel('画布创作助手').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: '.artifacts/workbench-browser/workbench-' + width + '.png' });
    await page.getByLabel('关闭助手', { exact: true }).click();
  }
  expect(errors).toEqual([]);
});
test('UPLOAD-UI assistant attachment and canvas file inputs use durable imports without manual asset IDs', async ({
  page,
  request,
}) => {
  const { canvas } = await openWorkspace(page, request);
  await page.locator('.node-shelf input[type=file]').setInputFiles({
    name: 'story.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('一个可见行动。'),
  });
  await expect(page.locator('.import-progress')).toContainText('就绪');
  await page.locator('.import-progress').getByRole('button', { name: '收起' }).click();
  await page.getByRole('button', { name: '✧ 助手', exact: true }).click();
  await page.locator('.floating-agent input[type=file]').setInputFiles({
    name: 'source.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('只供读取的原文。'),
  });
  await expect(page.locator('.reference-chips > article')).toHaveCount(1);
  const result = await (await request.get('/api/canvases/' + canvas.id)).json();
  expect(result.canvas.data.nodes).toHaveLength(4);
});
