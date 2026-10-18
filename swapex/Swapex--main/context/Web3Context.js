import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { Web3ReactProvider, useWeb3React, createWeb3ReactRoot } from '@web3-react/core'
import { InjectedConnector } from '@web3-react/injected-connector'
import { WalletLinkConnector } from '@web3-react/walletlink-connector'
import { ethers } from 'ethers'
import { REQUIRED_CHAIN_ID, CHAINS } from '../lib/config'

const injected = new InjectedConnector({
  supportedChainIds: Object.keys(CHAINS).map(Number),
})

const walletlink = new WalletLinkConnector({
  url: CHAINS[REQUIRED_CHAIN_ID]?.rpc || CHAINS[11155111].rpc,
  appName: 'SWAPEX',
})

const NetworkContextName = 'NETWORK'
const Web3ProviderNetwork = createWeb3ReactRoot(NetworkContextName)

function getLibrary(provider) {
  const library = new ethers.providers.Web3Provider(provider)
  library.pollingInterval = 12000
  return library
}

const Web3Context = createContext()

function Web3Manager({ children }) {
  const { active, error, account, library, chainId, activate, deactivate } = useWeb3React()
  const [balance, setBalance] = useState('0')
  const [ensName, setEnsName] = useState('')
  const [walletModalOpen, setWalletModalOpen] = useState(false)
  const wrongNetwork = Boolean(active && chainId && chainId !== REQUIRED_CHAIN_ID)

  const connectWallet = useCallback(async (connector) => {
    try {
      await activate(connector)
    } catch (e) {
      console.error('connectWallet error:', e)
    }
  }, [activate])

  /** Switch the wallet to any chain in CHAINS; adds the chain when the wallet does not know it. */
  const switchTo = useCallback(
    async (targetId) => {
      const target = CHAINS[targetId]
      const provider = library?.provider
      if (!provider?.request || !target) return false
      try {
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: target.hexId }],
        })
        return true
      } catch (e) {
        // 4902: chain not added to the wallet yet
        if (e?.code === 4902 || e?.data?.originalError?.code === 4902) {
          try {
            await provider.request({
              method: 'wallet_addEthereumChain',
              params: [
                {
                  chainId: target.hexId,
                  chainName: target.name,
                  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                  rpcUrls: target.rpc ? [target.rpc] : [],
                  blockExplorerUrls: target.explorer ? [target.explorer] : [],
                },
              ],
            })
            return true
          } catch (addErr) {
            console.error('switchTo add error:', addErr)
            return false
          }
        }
        console.error('switchTo error:', e)
        return false
      }
    },
    [library]
  )

  const switchNetwork = useCallback(() => switchTo(REQUIRED_CHAIN_ID), [switchTo])

  const disconnectWallet = useCallback(() => {
    try {
      deactivate()
    } catch (e) {
      console.error('disconnectWallet error:', e)
    }
  }, [deactivate])

  useEffect(() => {
    if (account && library) {
      let stale = false
      const fetchBalance = async () => {
        try {
          const bal = await library.getBalance(account)
          if (!stale) setBalance(ethers.utils.formatEther(bal))
        } catch (e) {
          console.error(e)
        }
      }
      fetchBalance()
      library.on('block', fetchBalance)
      return () => {
        stale = true
        library.removeListener('block', fetchBalance)
      }
    }
  }, [account, library])

  useEffect(() => {
    if (account && library) {
      let stale = false
      library.lookupAddress(account).then((name) => {
        if (!stale) setEnsName(name || '')
      }).catch(() => {})
      return () => { stale = true }
    }
  }, [account, library])

  return (
    <Web3Context.Provider
      value={{
        active,
        error,
        account,
        library,
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
      }}
    >
      {children}
    </Web3Context.Provider>
  )
}

function Provider({ children }) {
  return (
    <Web3ReactProvider getLibrary={getLibrary}>
      <Web3ProviderNetwork getLibrary={getLibrary}>
        <Web3Manager>{children}</Web3Manager>
      </Web3ProviderNetwork>
    </Web3ReactProvider>
  )
}

function useWeb3() {
  const context = useContext(Web3Context)
  if (!context) {
    throw new Error('useWeb3 must be used within Web3Context.Provider')
  }
  return context
}

export { Provider, useWeb3, injected, walletlink, getLibrary }
