import { test, expect, connectWallet, toast } from './support'

test('places and cancels a limit order', async ({ page, wallet, requireIndexer }) => {
  await page.goto('/limit')
  await connectWallet(page)

  // defaults are WETH -> tUSDC; the seed's only pool is fee 3000, which the form
  // discovers by probing the factory (500 and 10000 have no pool)
  await page.locator('#limit-amount-in').fill('0.001')
  await page.locator('#limit-price').fill('1000')

  // 0.001 WETH at 1000 tUSDC -> receive 1 tUSDC
  await expect(page.getByText('at your limit price')).toBeVisible()

  // the maker has never approved the limit contract: approve first (exact amount)
  const approve = page.getByRole('button', { name: 'Approve WETH' })
  await expect(approve).toBeEnabled()
  await approve.click()
  await expect(toast(page, /Approved 0.001 WETH for limit orders/)).toBeVisible()

  // sign the EIP-712 order (anvil signs for the unlocked account) and POST it
  await expect(page.getByRole('button', { name: 'Place order' })).toBeEnabled()
  await page.getByRole('button', { name: 'Place order' }).click()
  await expect(toast(page, /Order placed: 0.001 WETH at 1000 tUSDC/)).toBeVisible()

  // it lands in My orders as open
  const row = page.getByTestId('order-row')
  await expect(row).toBeVisible()
  await expect(row.getByText('Sell 0.001 WETH')).toBeVisible()
  await expect(row.getByText('open', { exact: true })).toBeVisible()

  // cancel on-chain; the table flips to cancelled once the indexer sees OrderCancelled
  await row.getByRole('button', { name: 'Cancel' }).click()
  await expect(toast(page, 'Limit order cancelled')).toBeVisible()
  await expect(row.getByText('cancelled', { exact: true })).toBeVisible({ timeout: 15000 })
  await expect(row.getByRole('button', { name: 'Cancel' })).toHaveCount(0)
})
