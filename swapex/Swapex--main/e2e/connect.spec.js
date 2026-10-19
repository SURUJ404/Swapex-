import { test, expect, connectWallet } from './support'

test('connects through the wallet modal via the injected provider', async ({ page, wallet }) => {
  await page.goto('/')

  // disconnected: NetworkGuard offers Connect Wallet inside the swap widget too
  await expect(page.getByRole('heading', { name: 'Swap' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect Wallet' }).last()).toBeVisible()

  await connectWallet(page)

  // header now shows the anvil dev account; the widget's own action reappears
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Enter an amount' })).toBeVisible()
})
