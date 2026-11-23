import { test, expect } from '@playwright/test';

test('CTX-CROSS fixed references from another canvas, paged long text and response-time edits preserve the new draft', async ({
  page,
  request,
}) => {
  const project = await (
    await request.post('/api/projects', {
      data: { title: '跨画布 ' + Date.now(), mode: 'short', brief: '' },
    })
  ).json();
  const other = await (
    await request.post('/api/projects/' + project.id + '/canvases', {
      data: {
        version: 2,
        title: '另一画布',
        nodes: [
          {
            id: 'source',
            type: 'note',
            title: '长原文',
            text: 'x'.repeat(31000) + '可见行动' + 'y'.repeat(6000),
            x: 0,
            y: 0,
          },
        ],
        edges: [],
      },
    })
  ).json();
  const current = await (
    await request.post('/api/projects/' + project.id + '/canvases', {
      data: { version: 2, title: '当前画布', nodes: [], edges: [] },
    })
  ).json();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#project=' + project.id);
  await page.getByLabel('当前画布', { exact: true }).selectOption(current.id);
  await page.getByRole('button', { name: '✧ 助手', exact: true }).click();
  await page.getByRole('button', { name: '＋ 引用', exact: true }).click();
  await page.getByLabel('引用画布').selectOption(other.id);
  await page.getByRole('checkbox', { name: /长原文/ }).check();
  await page.getByRole('button', { name: '添加 1 项', exact: true }).click();
  const chip = page.locator('.reference-chips > article');
  await expect(chip).toContainText('长原文');
  await chip.getByRole('button', { name: /@长原文/ }).click();
  for (let i = 0; i < 5; i++) {
    await page.getByRole('button', { name: '下一段正文', exact: true }).click();
    await expect(chip).toContainText(`${(i + 1) * 6000}–`);
  }
  const area = page.getByLabel('引用正文选区');
  await area.evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(1000, 1004);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(chip).toContainText('已固定字符 31000–31004：可见行动');
  await chip.getByRole('button', { name: /@长原文/ }).click();
  await page.getByLabel('助手消息').fill('讨论这段可见行动。');
  let release!: () => void;
  const pending = new Promise<void>((r) => {
    release = r;
  });
  let received = false;
  await page.route('**/api/canvases/*/conversation', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const result = await route.fetch();
    received = true;
    await pending;
    await route.fulfill({ response: result });
  });
  await page.getByRole('button', { name: '发送讨论', exact: true }).click();
  await expect.poll(() => received).toBe(true);
  await page.getByLabel('助手消息').fill('新草稿不能被上一条响应清除。');
  release();
  await expect(page.getByRole('button', { name: '发送讨论', exact: true })).toBeEnabled();
  await expect(page.getByLabel('助手消息')).toHaveValue('新草稿不能被上一条响应清除。');
  await expect(page.locator('.chat-message.assistant')).toContainText(
    'Studio 已读取固定原文（隔离模拟）',
  );
  const messages = await (
    await request.get('/api/canvases/' + current.id + '/conversation')
  ).json();
  const user = messages.messages.find((m: any) => m.data.role === 'user');
  expect(user.data.references[0].reference.canvas.id).toBe(other.id);
  expect(user.data.references[0].text).toBe('可见行动');
  expect(
    (await (await request.get('/api/canvases/' + current.id)).json()).canvas.data.nodes,
  ).toHaveLength(0);
});

test('INT-SCALE thousand-node canvas renders only the viewport and finds an offscreen node without loading unrelated media', async ({
  page,
  request,
}) => {
  const project = await (
    await request.post('/api/projects', {
      data: { title: '千节点 ' + Date.now(), mode: 'short', brief: '' },
    })
  ).json();
  await request.post('/api/projects/' + project.id + '/canvases', {
    data: {
      version: 2,
      title: '规模测试',
      nodes: Array.from({ length: 1000 }, (_, i) => ({
        id: 'n' + i,
        type: 'note',
        title: '规模节点 ' + String(i).padStart(4, '0'),
        text: '内容 ' + i,
        x: (i % 20) * 350 + 50,
        y: Math.floor(i / 20) * 300 + 90,
      })),
      edges: [],
    },
  });
  const media: string[] = [],
    errors: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/file')) media.push(r.url());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#project=' + project.id);
  await expect(page.locator('.node-card').first()).toBeVisible();
  expect(await page.locator('.node-card').count()).toBeLessThan(50);
  await page.getByLabel('搜索画布节点').fill('规模节点 0999');
  await page
    .locator('.canvas-search-results')
    .getByRole('button', { name: '规模节点 0999', exact: true })
    .click();
  await expect(page.locator('.node-card').filter({ hasText: '规模节点 0999' })).toBeVisible();
  expect(await page.locator('.node-card').count()).toBeLessThan(50);
  expect(media).toEqual([]);
  expect(errors).toEqual([]);
});
