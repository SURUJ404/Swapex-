import { test, expect } from '@playwright/test';
import { ethers } from 'ethers';
import path from 'path';

// The signed-grant path, exercised end-to-end from a real browser:
//   1. the page signs a Swapex PermitSingle with eth_signTypedData_v4 (EIP-712 domain =
//      name/version/chainId/verifyingContract), and the signature is verified in Node first,
//   2. a real transaction lands it on-chain and the allowance appears,
//   3. the identical submission is rejected (nonce bitmap),
//   4. re-signing against the wrong chainId is rejected (domain separation),
//   5. a submitter who extends the signed sigDeadline is rejected (deadline is signed — D28).
// Prereqs: anvil on 127.0.0.1:8545 with a current deployment (addresses below must match
// constants/index.js; NEXT_PUBLIC_* env vars override them, same as the app).

const RPC = 'http://127.0.0.1:8545';
const CHAIN_ID = 31337;

const AT = process.env.NEXT_PUBLIC_ALLOWANCE_TRANSFER || '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
const ROUTER = process.env.NEXT_PUBLIC_ROUTER || '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
const SWA = process.env.NEXT_PUBLIC_SWA || '0x0165878A594ca255338adfa4d48449f69242Eb8F';

const provider = new ethers.providers.JsonRpcProvider(RPC);
const at = new ethers.Contract(
  AT,
  [
    'function permit(address,((address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline),bytes)',
    'function allowanceOf(address,address,address) view returns (uint160,uint48)',
    'function isNonceUsed(address,uint48) view returns (bool)',
    'error NonceAlreadyUsed(address,uint48)',
    'error InvalidSignature(address)',
  ],
  provider
);

const NONCE_USED_SEL = ethers.utils.id('NonceAlreadyUsed(address,uint48)').slice(0, 10);
const INVALID_SIG_SEL = ethers.utils.id('InvalidSignature(address)').slice(0, 10);

const DOMAIN = {
  name: 'Swapex AllowanceTransfer',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: AT,
};

// includes EIP712Domain the way MetaMask-shaped eth_signTypedData_v4 payloads do
const TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  PermitSingle: [
    { name: 'details', type: 'PermitDetails' },
    { name: 'spender', type: 'address' },
    { name: 'sigDeadline', type: 'uint256' },
  ],
  PermitDetails: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint160' },
    { name: 'expiration', type: 'uint48' },
    { name: 'nonce', type: 'uint48' },
  ],
};

const signTypes = (() => {
  const { EIP712Domain: _d, ...rest } = TYPES;
  return rest;
})();

test('PermitSingle signed in the browser: lands once; replay, wrong chain, and extended deadline all fail', async ({
  page,
}) => {
  try {
    await provider.getBlockNumber();
  } catch {
    throw new Error(`anvil not reachable at ${RPC} — start it and deploy the contracts first`);
  }

  // inject the ethers UMD bundle first, then the wallet shim (shim resolves ethers lazily anyway)
  await page.addInitScript({ path: path.join(__dirname, '..', 'node_modules', 'ethers', 'dist', 'ethers.umd.min.js') });
  await page.addInitScript({ path: path.join(__dirname, 'wallet-shim.js') });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const owner = await page.evaluate(() => window.__swapexE2E.address());
  expect(owner).toMatch(/^0x[0-9a-fA-F]{40}$/);

  // the chain persists between runs, so pick a nonce nobody has burned yet
  let nonce = 0;
  while (nonce < 128 && (await at.isNonceUsed(owner, nonce))) nonce++;
  expect(nonce).toBeLessThan(128);

  // anchor the deadline to max(chain, wall): anvil stamps new blocks with wall-clock time, so
  // after >1h of idle the latest block's timestamp + 3600 can already be in the past
  const now = Math.max(
    (await provider.getBlock('latest')).timestamp,
    Math.floor(Date.now() / 1000)
  );
  const message = {
    details: {
      token: SWA,
      amount: ethers.utils.parseEther('25').toString(),
      expiration: now + 3600,
      nonce,
    },
    spender: ROUTER,
    sigDeadline: now + 3600,
  };

  // 1. sign in the page, verify the same digest in Node (identical ethers build both sides)
  const sig = await page.evaluate(
    (payload) => window.__swapexE2E.signTypedData(payload),
    { domain: DOMAIN, types: TYPES, primaryType: 'PermitSingle', message }
  );
  expect(ethers.utils.verifyTypedData(DOMAIN, signTypes, message, sig).toLowerCase()).toBe(owner.toLowerCase());

  const calldata = at.interface.encodeFunctionData('permit', [owner, message, sig]);

  // 2. land it: a real transaction from the browser wallet
  const hash = await page.evaluate(
    ([to, data]) => window.__swapexE2E.send(to, data),
    [AT, calldata]
  );
  const receipt = await provider.waitForTransaction(hash);
  expect(receipt.status).toBe(1);
  const [granted, expiration] = await at.allowanceOf(owner, SWA, ROUTER);
  expect(granted.toString()).toBe(message.details.amount);
  expect(expiration).toBe(message.details.expiration);

  // 3. replay: identical bytes — the nonce bit is set, so it cannot land again
  const replay = await page.evaluate(([to, data]) => window.__swapexE2E.call(to, data), [AT, calldata]);
  expect(replay.ok, `replay unexpectedly succeeded: ${replay.message || ''}`).toBe(false);
  expect(replay.data, `revert payload missing: ${replay.message || ''}`).toMatch(
    new RegExp(`^${NONCE_USED_SEL}`, 'i')
  );
  const decoded = at.interface.decodeErrorResult('NonceAlreadyUsed', replay.data);
  expect(decoded[0].toLowerCase()).toBe(owner.toLowerCase());
  expect(decoded[1]).toBe(nonce);
  // a real submission of the same signed grant must not land either
  await expect(
    page.evaluate(([to, data]) => window.__swapexE2E.send(to, data), [AT, calldata])
  ).rejects.toThrow();

  // 4. wrong chainId in the domain changes the digest → not the owner's signature
  const wrongChainSig = await page.evaluate(
    (payload) => window.__swapexE2E.signTypedData(payload),
    {
      domain: { ...DOMAIN, chainId: 1 },
      types: TYPES,
      primaryType: 'PermitSingle',
      message,
    }
  );
  expect(ethers.utils.verifyTypedData(DOMAIN, signTypes, message, wrongChainSig).toLowerCase()).not.toBe(
    owner.toLowerCase()
  );
  const wrongChain = await page.evaluate(
    ([to, data]) => window.__swapexE2E.call(to, data),
    [AT, at.interface.encodeFunctionData('permit', [owner, message, wrongChainSig])]
  );
  expect(wrongChain.ok, `wrong-chain permit unexpectedly succeeded: ${wrongChain.message || ''}`).toBe(false);
  expect(wrongChain.data, `revert payload missing: ${wrongChain.message || ''}`).toMatch(
    new RegExp(`^${INVALID_SIG_SEL}`, 'i')
  );

  // 5. the deadline is signed (D28): submitting with a later sigDeadline changes the digest
  const extended = { ...message, sigDeadline: message.sigDeadline + 30 * 86400 };
  const extendedAttempt = await page.evaluate(
    ([to, data]) => window.__swapexE2E.call(to, data),
    [AT, at.interface.encodeFunctionData('permit', [owner, extended, sig])]
  );
  expect(extendedAttempt.ok, `extended deadline unexpectedly succeeded: ${extendedAttempt.message || ''}`).toBe(
    false
  );
  expect(extendedAttempt.data, `revert payload missing: ${extendedAttempt.message || ''}`).toMatch(
    new RegExp(`^${INVALID_SIG_SEL}`, 'i')
  );
});
