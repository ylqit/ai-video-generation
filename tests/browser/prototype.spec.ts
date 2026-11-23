import { test, expect } from '@playwright/test';
test('BASE-001 prototype selection → references → candidate → edit → export', async ({ page }) => {
  await page.goto('/design/workbench-interaction/index.html');
  await page.getByRole('checkbox').nth(0).check();
  await page.getByRole('checkbox').nth(1).check();
  await page.getByRole('checkbox').nth(2).check();
  await page.getByRole('button', { name: '加入助手', exact: true }).click();
  await expect(page.locator('#refs .chip')).toHaveCount(3);
  await page.getByRole('checkbox').nth(0).uncheck();
  await expect(page.locator('#refs .chip')).toHaveCount(3);
  await page.getByRole('button', { name: '准备候选' }).click();
  await page.getByRole('button', { name: '加入剪辑' }).click();
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await expect(page.locator('#export')).toContainText('240 帧');
});
