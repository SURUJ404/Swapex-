import { useState, useEffect } from 'react'
import { ethers } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { ERC20_ABI } from '../constants'

export default function useTokenBalance(tokenAddress) {
  const { account, library } = useWeb3()
  const [balance, setBalance] = useState('0')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchBalance() {
      if (!account || !library) {
        setBalance('0')
        setLoading(false)
        return
      }
      try {
        setLoading(true)
        if (tokenAddress === 'NATIVE') {
          const bal = await library.getBalance(account)
          setBalance(ethers.utils.formatEther(bal))
        } else {
          const contract = new ethers.Contract(tokenAddress, ERC20_ABI, library)
          const decimals = await contract.decimals()
          const bal = await contract.balanceOf(account)
          setBalance(ethers.utils.formatUnits(bal, decimals))
        }
      } catch (e) {
        console.error('useTokenBalance error:', e)
        setBalance('0')
      } finally {
        setLoading(false)
      }
    }
    fetchBalance()
  }, [tokenAddress, account, library])

  return { balance, loading }
}
