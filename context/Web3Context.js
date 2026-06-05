import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { Web3ReactProvider, useWeb3React, createWeb3ReactRoot } from '@web3-react/core'
import { InjectedConnector } from '@web3-react/injected-connector'
import { WalletConnectConnector } from '@web3-react/walletconnect-connector'
import { WalletLinkConnector } from '@web3-react/walletlink-connector'
import { ethers } from 'ethers'

const injected = new InjectedConnector({ supportedChainIds: [1, 3, 4, 5, 42] })

const walletconnect = new WalletConnectConnector({
  rpc: { 1: 'https://mainnet.infura.io/v3/' },
  qrcode: true,
})

const walletlink = new WalletLinkConnector({
  url: 'https://mainnet.infura.io/v3/',
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

  const connectWallet = useCallback(async (connector) => {
    try {
      await activate(connector)
    } catch (e) {
      console.error('connectWallet error:', e)
    }
  }, [activate])

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

export { Provider, useWeb3, injected, walletconnect, walletlink, getLibrary }
