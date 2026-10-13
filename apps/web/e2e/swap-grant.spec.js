import { test, expect } from '@playwright/test';
import { ethers } from 'ethers';
import path from 'path';

// The signed-grant path driven through the REAL UI (crypto G.1):
//   1. connect the injected wallet, pick SWA -> SWB on /swap, enter 1 SWA, press "Approve SWA"
//   2. the layer-1 ERC-20 approve lands, then the in-page EIP-712 summary panel appears while
//      the wallet prompt is open (the shim delays eth_signTypedData_v4 so the panel is
//      observable) — amount, spender, signed deadline, chain and contract all visible
//   3. the signed PermitSingle is submitted and lands on-chain; the widget flips to "Swap"
//   4. the swap completes and the toast + on-chain balance prove the whole UI path
// Prereqs: anvil :8545 + current deployment; addresses match constants/index.js.

const RPC = 'http://127.0.0.1:8545';

const AT = process.env.NEXT_PUBLIC_ALLOWANCE_TRANSFER || '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
const ROUTER = process.env.NEXT_PUBLIC_ROUTER || '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
const SWA = process.env.NEXT_PUBLIC_SWA || '0x0165878A594ca255338adfa4d48449f69242Eb8F';
const SWB = process.env.NEXT_PUBLIC_SWB || '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853';

const provider = new ethers.providers.JsonRpcProvider(RPC);
const at = new ethers.Contract(
  AT,
  [
    'function allowanceOf(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration)',
    'function setAllowance(address token,address spender,uint160 amount,uint48 expiration)',
  ],
  provider
);
const swb = new ethers.Contract(
  SWB,
  ['function balanceOf(address) view returns (uint256)'],
  provider
);

// The anvil chain is long-lived and earlier smoke/test runs may have left a live grant for
// the shim's account. The widget skips the whole Approve step when one is still spendable,
// so zero it out first (expired = counts as zero in useAllowance) — the signed grant below
// then overwrites the slot with a fresh one.
async function clearLiveGrant(owner) {
  // uint160 decodes to BigNumber but uint48 (expiration) is a plain number in ethers v5
  const [amount, expiration] = await at.allowanceOf(owner, SWA, ROUTER);
  if (amount.gt(0) && Number(expiration) > Math.floor(Date.now() / 1000)) {
    const wallet = new ethers.Wallet(
      process.env.PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      provider
    );
    // zero amount already forces the Approve step (allowance counts as 0); the contract
    // requires a future expiration, so give it a short one
    const block = await provider.getBlock('latest');
    const expiry = Math.max(block.timestamp, Math.floor(Date.now() / 1000)) + 300;
    await (await at.connect(wallet).setAllowance(SWA, ROUTER, 0, expiry)).wait();
  }
}

test('approve via signed EIP-712 grant: summary panel, permit lands, swap succeeds', async ({ page }) => {
  try {
    await provider.getBlockNumber();
  } catch {
    throw new Error(`anvil not reachable at ${RPC} — start it and deploy the contracts first`);
  }

  await page.addInitScript({ path: path.join(__dirname, '..', 'node_modules', 'ethers', 'dist', 'ethers.umd.min.js') });
  await page.addInitScript({ path: path.join(__dirname, 'wallet-shim.js') });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const owner = await page.evaluate(() => window.__swapexE2E.address());
  await clearLiveGrant(owner);

  // ---- connect the injected wallet through the real modal (the header button; NetworkGuard
  // renders its own Connect Wallet inside the widget, so scope to <header>)
  await page.locator('header').getByRole('button', { name: 'Connect Wallet' }).click();
  await page.getByRole('button', { name: 'MetaMask' }).click();
  await expect(page.getByText(`${owner.slice(0, 6)}...${owner.slice(-4)}`)).toBeVisible();

  // ---- pick SWA as the pay token (native ETH needs no grant)
  await page.locator('button').filter({ hasText: 'ETH' }).first().click();
  await page.locator('[data-reach-dialog-content]').getByRole('button', { name: /SWA/ }).click();
  await page.locator('input[inputmode="decimal"]').first().fill('1');
  const approveButton = page.getByRole('button', { name: 'Approve SWA' });
  await expect(approveButton).toBeVisible({ timeout: 15_000 });

  const swbBefore = await swb.balanceOf(owner);

  // ---- approve: layer-1 tx, then the EIP-712 summary appears while the shim "prompts"
  await approveButton.click();
  const summary = page.getByTestId('signing-summary');
  await expect(summary).toBeVisible({ timeout: 20_000 });
  await expect(summary).toContainText('Review this signature');
  await expect(summary).toContainText('1 SWA');
  await expect(summary).toContainText('31337');
  await expect(summary).toContainText(ROUTER.slice(0, 6)); // spender, short + checksummed
  await expect(summary).toContainText(AT.slice(0, 6)); // verifying contract
  await expect(summary).toContainText(/signed deadline/i);

  // ---- the prompt resolves, the signed PermitSingle lands, the widget flips to Swap
  await expect(summary).toBeHidden({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Swap', exact: true })).toBeVisible({ timeout: 30_000 });

  // on-chain proof that the signed grant is live and bounded
  const [amount, expiration] = await at.allowanceOf(owner, SWA, ROUTER);
  expect(amount.toString()).toBe(ethers.utils.parseEther('1').toString());
  expect(Number(expiration)).toBeGreaterThan(Math.floor(Date.now() / 1000));

  // ---- complete the swap and prove funds moved
  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  await expect(page.getByText(/Swapped 1 SWA/)).toBeVisible({ timeout: 30_000 });

  const swbAfter = await swb.balanceOf(owner);
  expect(swbAfter.gt(swbBefore)).toBe(true);
});
