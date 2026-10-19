import { test, expect, connectWallet, toast } from './support'

test('swaps ETH for tUSDC through the confirm modal', async ({ page, wallet }) => {
  await page.goto('/')
  await connectWallet(page)

  // default pair is ETH -> tUSDC; the seed's pool holds only 0.02 WETH of
  // liquidity, so stay well inside it (1 ETH would honestly get No liquidity)
  await page.locator('#swap-amount-in').fill('0.001')

  // quote arrives from the on-chain quoter: summary rows appear, Swap enables
  await expect(page.getByText('Minimum received')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Swap', exact: true })).toBeEnabled()

  await page.getByRole('button', { name: 'Swap', exact: true }).click()

  // review modal shows the summary before anything is sent on-chain
  const dialog = page.getByRole('dialog', { name: 'Confirm swap' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Slippage tolerance')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Confirm swap' })).toBeEnabled()

  await dialog.getByRole('button', { name: 'Confirm swap' }).click()

  // anvil mines instantly; the app reports the confirmed receipt
  await expect(toast(page, /Swapped [\d.]+ ETH for [\d.]+ tUSDC/)).toBeVisible()
  await expect(dialog).toBeHidden()
})
