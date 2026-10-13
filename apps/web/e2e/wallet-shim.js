// Injected by e2e/permit-typed-data.spec.js (after the ethers UMD bundle) via addInitScript.
//
// A minimal EIP-1193 provider backed by anvil's well-known public dev account #0, so the test
// can sign EIP-712 typed data and submit transactions from a real browser context without a
// browser-extension wallet. TEST ONLY: the private key below is anvil's default, published in
// its own documentation; it is never used by Swapex itself.
(() => {
  const RPC = 'http://127.0.0.1:8545';
  const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

  // Lazy: the shim may evaluate before the ethers bundle script, so resolve on first use.
  let walletRef = null;
  const getWallet = () => {
    if (!walletRef) {
      walletRef = new ethers.Wallet(DEV_KEY, new ethers.providers.JsonRpcProvider(RPC));
    }
    return walletRef;
  };

  const rpc = (method, params = []) =>
    fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (j.error) {
          const e = new Error(j.error.message || 'rpc error');
          e.code = j.error.code;
          e.data = j.error.data;
          throw e;
        }
        return j.result;
      });

  const listeners = {};

  const ethereum = {
    isMetaMask: true,
    chainId: '0x7a69',
    request: async ({ method, params = [] }) => {
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [getWallet().address];
        case 'eth_chainId':
          return '0x7a69';
        case 'net_version':
          return '31337';
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain':
          return null;
        case 'eth_signTypedData_v4': {
          // hold the "prompt" open briefly so swap-grant.spec.js can observe the in-page
          // signing summary while the wallet would be asking for confirmation
          await new Promise((r) => setTimeout(r, 1500));
          const payload = JSON.parse(params[1]);
          const { EIP712Domain: _eip712Domain, ...types } = payload.types;
          return getWallet()._signTypedData(payload.domain, types, payload.message);
        }
        case 'eth_sendTransaction': {
          const [tx] = params;
          const w = getWallet();
          const res = await w.sendTransaction({
            from: w.address,
            to: tx.to,
            data: tx.data,
            value: tx.value ? ethers.BigNumber.from(tx.value) : 0,
          });
          await res.wait(); // throws on a reverted receipt
          return res.hash;
        }
        default:
          return rpc(method, params);
      }
    },
    // legacy surface some connectors still probe
    enable: async () => [getWallet().address],
    sendAsync: (payload, callback) => {
      ethereum
        .request({ method: payload.method, params: payload.params || [] })
        .then((result) => callback(null, { id: payload.id, jsonrpc: '2.0', result }))
        .catch((err) => callback(err, { id: payload.id, jsonrpc: '2.0', error: err }));
    },
    on: (event, cb) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    },
    removeListener: (event, cb) => {
      listeners[event] = (listeners[event] || []).filter((l) => l !== cb);
    },
  };

  Object.defineProperty(window, 'ethereum', { value: ethereum, configurable: true });

  window.__swapexE2E = {
    address: () => getWallet().address,
    signTypedData: (payload) =>
      ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [getWallet().address, JSON.stringify(payload)],
      }),
    send: (to, data) =>
      ethereum.request({
        method: 'eth_sendTransaction',
        params: [{ from: getWallet().address, to, data }],
      }),
    // simulate without sending; { ok: false, data } carries the revert payload (selector + args)
    call: async (to, data) => {
      try {
        const out = await rpc('eth_call', [{ from: getWallet().address, to, data }, 'latest']);
        return { ok: true, data: out };
      } catch (e) {
        const d = e.data;
        return {
          ok: false,
          data: typeof d === 'string' ? d : (d && (d.data || d.result)) || null,
          message: e.message,
        };
      }
    },
  };
})();
