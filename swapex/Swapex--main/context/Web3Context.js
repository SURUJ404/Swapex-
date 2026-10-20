import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAccount, useConnect, useDisconnect, useSwitchChain, usePublicClient, useWalletClient } from 'wagmi'
import { formatEther } from 'viem'
import { wagmiConfig } from '../lib/wagmi'
import { REQUIRED_CHAIN_ID, CHAINS } from '../lib/config'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
})

const Web3Context = createContext()

function Web3Manager({ children }) {
  const { address, isConnected, chainId } = useAccount()
  const { connectors, connect, error: connectError } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()

  const [balance, setBalance] = useState('0')
  const [ensName, setEnsName] = useState('')
  const [walletModalOpen, setWalletModalOpen] = useState(false)

  const active = Boolean(isConnected && address)
  const wrongNetwork = Boolean(active && chainId && chainId !== REQUIRED_CHAIN_ID)

  /** Connect by wallet id from WALLETS (the connect modal's list). */
  const connectWallet = useCallback(
    async (walletId) => {
      const connector = connectors.find((c) => c.id === walletId)
      if (!connector) return
      try {
        connect({ connector })
      } catch (e) {
        console.error('connectWallet error:', e)
      }
    },
    [connectors, connect]
  )

  /** Switch the wallet to any chain in CHAINS; wagmi adds chains the wallet does not know. */
  const switchTo = useCallback(
    async (targetId) => {
      if (!CHAINS[targetId]) return false
      try {
        await switchChain({ chainId: targetId })
        return true
      } catch (e) {
        console.error('switchTo error:', e)
        return false
      }
    },
    [switchChain]
  )

  const switchNetwork = useCallback(() => switchTo(REQUIRED_CHAIN_ID), [switchTo])

  const disconnectWallet = useCallback(() => {
    try {
      disconnect()
    } catch (e) {
      console.error('disconnectWallet error:', e)
    }
  }, [disconnect])

  useEffect(() => {
    if (address && publicClient && !wrongNetwork) {
      let stale = false
      const fetchBalance = async () => {
        try {
          const bal = await publicClient.getBalance({ address })
          if (!stale) setBalance(formatEther(bal))
        } catch (e) {
          console.error(e)
        }
      }
      fetchBalance()
      const unwatch = publicClient.watchBlockNumber({ onBlockNumber: fetchBalance })
      return () => {
        stale = true
        unwatch()
      }
    }
    let staleReset = false
    Promise.resolve()
      .then(() => {
        if (!staleReset) setBalance('0')
      })
      .catch(() => {})
    return () => {
      staleReset = true
    }
  }, [address, publicClient, wrongNetwork])

  useEffect(() => {
    if (address && publicClient) {
      let stale = false
      publicClient
        .getEnsName({ address })
        .then((name) => {
          if (!stale) setEnsName(name || '')
        })
        .catch(() => {})
      return () => {
        stale = true
      }
    }
    let staleReset = false
    Promise.resolve()
      .then(() => {
        if (!staleReset) setEnsName('')
      })
      .catch(() => {})
    return () => {
      staleReset = true
    }
  }, [address, publicClient])

  // `clients` replaces ethers' `library`: a viem public client for reads and the
  // wallet client for writes. Both are null until the user connects.
  const clients = useMemo(
    () => ({
      public: isConnected ? publicClient : null,
      wallet: isConnected ? walletClient : null,
      account: address || null,
    }),
    [isConnected, publicClient, walletClient, address]
  )

  return (
    <Web3Context.Provider
      value={{
        active,
        error: connectError || null,
        account: address || null,
        chainId,
        balance,
        ensName,
        connectWallet,
        wrongNetwork,
        switchNetwork,
        switchTo,
        walletModalOpen,
        setWalletModalOpen,
        disconnectWallet,
        clients,
      }}
    >
      {children}
    </Web3Context.Provider>
  )
}

function Provider({ children }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Web3Manager>{children}</Web3Manager>
      </QueryClientProvider>
    </WagmiProvider>
  )
}

function useWeb3() {
  const context = useContext(Web3Context)
  if (!context) {
    throw new Error('useWeb3 must be used within Web3Context.Provider')
  }
  return context
}

export { Provider, useWeb3 }
