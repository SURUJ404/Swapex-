import { test, expect, connectWallet, toast } from './support'

test('adds a full-range position to the seeded WETH/tUSDC pool', async ({ page, wallet }) => {
  await page.goto('/add')
  await connectWallet(page)

  // defaults: ETH + tUSDC, 0.3% fee — the seed created this pool
  await expect(page.getByRole('heading', { name: 'New position' })).toBeVisible()
  await page.getByRole('button', { name: 'Full range' }).click()

  // deposit side A (ETH, no approval needed); side B is computed from the price.
  // With no amounts entered the form honestly shows a disabled "Enter an amount"
  // button, so fill before waiting for Add liquidity.
  await page.locator('div:has(> div > span:text-is("Deposit ETH")) input').fill('0.1')

  // tUSDC may need an approval round-trip first (the seed may have left an allowance)
  const add = page.getByRole('button', { name: 'Add liquidity', exact: true })
  const approve = page.getByRole('button', { name: 'Approve tUSDC' })
  await expect(add.or(approve)).toBeVisible({ timeout: 20_000 })
  if (await approve.isVisible().catch(() => false)) {
    await approve.click()
    await expect(approve).toBeHidden()
  }
  await expect(add).toBeEnabled()

  await add.click()
  await expect(toast(page, 'Position created')).toBeVisible()
})
