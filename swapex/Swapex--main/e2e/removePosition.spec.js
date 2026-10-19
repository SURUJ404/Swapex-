import { test, expect, connectWallet, toast } from './support'

test('removes liquidity from an owned position', async ({ page, wallet }) => {
  await page.goto('/portfolio')
  await connectWallet(page)

  // the seed created positions for the anvil dev account; open the first one
  const link = page.locator('a[href^="/pool/"]').first()
  await expect(link).toBeVisible({ timeout: 20_000 })
  await link.click()

  await expect(page.getByRole('heading', { name: /\w+ \/ \w+/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remove liquidity' })).toBeEnabled()

  // default percent is already 100 (Max); remove everything
  await page.getByRole('button', { name: 'Max' }).click()
  await page.getByRole('button', { name: 'Remove liquidity' }).click()

  await expect(toast(page, 'Liquidity removed')).toBeVisible()
})
