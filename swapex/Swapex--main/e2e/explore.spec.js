import { test, expect } from './support'

test('explore shows the seeded tokens and pools from the indexer', async ({ page, requireIndexer }) => {
  await page.goto('/explore')
  await page.waitForLoadState('networkidle') // data fetch starts after hydration

  // tokens render first, pools second (pages/explore.js)
  const tokens = page.getByRole('table').first()
  const pools = page.getByRole('table').nth(1)

  // token table: the three seeded test tokens; cells carry symbol + name,
  // so match from the start of the cell text instead of exact equality
  // exact: the nav searchbox is named "Search tokens and pools" and would
  // otherwise substring-collide with "Search tokens"
  await expect(page.getByRole('searchbox', { name: 'Search tokens', exact: true })).toBeVisible()
  await expect(tokens.getByRole('cell', { name: /^tUSDC\b/ })).toBeVisible()
  await expect(tokens.getByRole('cell', { name: /^tDAI\b/ })).toBeVisible()
  await expect(tokens.getByRole('cell', { name: /^tWBTC\b/ })).toBeVisible()

  // pool table: the seeded WETH pair; token0/token1 order is address-sorted,
  // so accept either rendering of the pair
  await expect(page.getByRole('searchbox', { name: 'Search pools', exact: true })).toBeVisible()
  await expect(pools.getByRole('cell', { name: /WETH \/ tUSDC|tUSDC \/ WETH/ })).toBeVisible()

  // search narrows to one pool row
  await page.getByRole('searchbox', { name: 'Search pools', exact: true }).fill('tDAI')
  await expect(pools.getByRole('cell', { name: /tDAI \/ tUSDC|tUSDC \/ tDAI/ })).toBeVisible()
  await expect(pools.getByRole('cell', { name: /WETH \/ tUSDC|tUSDC \/ WETH/ })).toHaveCount(0)
})
