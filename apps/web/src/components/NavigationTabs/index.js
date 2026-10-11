import React, { useCallback } from 'react'
import { withRouter, NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { transparentize, darken } from 'polished'

import { useWeb3React, useBodyKeyDown } from '../../hooks'
import { useAddressBalance } from '../../contexts/Balances'
import { isAddress } from '../../utils'
import {
  useBetaMessageManager,
  useSaiHolderMessageManager,
  useGeneralDaiMessageManager
} from '../../contexts/LocalStorage'
import { Link } from '../../theme/components'

const tabOrder = [
  {
    path: '/swap',
    textKey: 'swap',
    regex: /\/swap/
  },
  {
    path: '/send',
    textKey: 'send',
    regex: /\/send/
  },
  {
    path: '/add-liquidity',
    textKey: 'pool',
    regex: /\/add-liquidity|\/remove-liquidity|\/create-exchange.*/
  }
]

const BetaMessage = styled.div`
  ${({ theme }) => theme.flexRowNoWrap}
  cursor: pointer;
  flex: 1 0 auto;
  align-items: center;
  position: relative;
  padding: 0.5rem 1rem;
  padding-right: 2rem;
  margin-bottom: 1rem;
  border: 1px solid ${({ theme }) => transparentize(0.6, theme.wisteriaPurple)};
  background-color: ${({ theme }) => transparentize(0.9, theme.wisteriaPurple)};
  border-radius: 1rem;
  font-size: 0.75rem;
  line-height: 1rem;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: ${({ theme }) => theme.wisteriaPurple};

  &:after {
    content: '✕';
    top: 0.5rem;
    right: 1rem;
    position: absolute;
    color: ${({ theme }) => theme.wisteriaPurple};
  }
`

const DaiMessage = styled(BetaMessage)`
  ${({ theme }) => theme.flexColumnNoWrap}
  position: relative;
  word-wrap: wrap;
  overflow: visible;
  white-space: normal;
  padding: 1rem 1rem;
  padding-right: 2rem;
  line-height: 1.2rem;
  cursor: default;
  color: ${({ theme }) => theme.textColor};
  div {
    width: 100%;
  }
  &:after {
    content: '';
  }
`

const CloseIcon = styled.div`
  width: 10px !important;
  top: 0.5rem;
  right: 1rem;
  position: absolute;
  color: ${({ theme }) => theme.wisteriaPurple};
  :hover {
    cursor: pointer;
  }
`

const WarningHeader = styled.div`
  margin-bottom: 10px;
  font-weight: 500;
  color: ${({ theme }) => theme.uniswapPink};
`

const WarningFooter = styled.div`
  margin-top: 10px;
  font-size: 10px;
  text-decoration: italic;
  color: ${({ theme }) => theme.greyText};
`

const Tabs = styled.div`
  ${({ theme }) => theme.flexRowNoWrap}
  align-items: center;
  height: 2.5rem;
  background-color: ${({ theme }) => theme.surface2};
  border-radius: 16px;
  margin-bottom: 1rem;
  padding: 2px;
`

const activeClassName = 'ACTIVE'

const StyledNavLink = styled(NavLink).attrs({ activeClassName })`
  ${({ theme }) => theme.flexRowNoWrap}
  align-items: center;
  justify-content: center;
  height: calc(2.5rem - 4px);
  flex: 1 0 auto;
  border-radius: 14px;
  outline: none;
  cursor: pointer;
  text-decoration: none;
  color: ${({ theme }) => theme.neutral2};
  font-size: 1rem;
  font-weight: 485;
  transition: all 125ms ease;

  &.${activeClassName} {
    background-color: ${({ theme }) => theme.surface1};
    box-shadow: 0 1px 3px 0 rgba(0,0,0,0.12), 0 1px 2px 0 rgba(0,0,0,0.24);
    font-weight: 535;
    color: ${({ theme }) => theme.neutral1};
  }
  :hover, :focus { color: ${({ theme }) => theme.neutral1}; }
`

function NavigationTabs({ location: { pathname }, history }) {
  const { t } = useTranslation()

  const [showBetaMessage, dismissBetaMessage] = useBetaMessageManager()

  const [showGeneralDaiMessage, dismissGeneralDaiMessage] = useGeneralDaiMessageManager()

  const [showSaiHolderMessage, dismissSaiHolderMessage] = useSaiHolderMessageManager()

  const { account } = useWeb3React()

  const daiBalance = useAddressBalance(account, isAddress('0x89d24A6b4CcB1B6fAA2625fE562bDD9a23260359'))

  const daiPoolTokenBalance = useAddressBalance(account, isAddress('0x09cabEC1eAd1c0Ba254B09efb3EE13841712bE14'))

  const onLiquidityPage = pathname === '/pool' || pathname === '/add-liquidity' || pathname === '/remove-liquidity'

  const navigate = useCallback(
    direction => {
      const tabIndex = tabOrder.findIndex(({ regex }) => pathname.match(regex))
      history.push(tabOrder[(tabIndex + tabOrder.length + direction) % tabOrder.length].path)
    },
    [pathname, history]
  )
  const navigateRight = useCallback(() => {
    navigate(1)
  }, [navigate])
  const navigateLeft = useCallback(() => {
    navigate(-1)
  }, [navigate])

  useBodyKeyDown('ArrowRight', navigateRight)
  useBodyKeyDown('ArrowLeft', navigateLeft)

  const providerMessage =
    showSaiHolderMessage && daiPoolTokenBalance && !daiPoolTokenBalance.isZero() && onLiquidityPage
  const generalMessage = showGeneralDaiMessage && daiBalance && !daiBalance.isZero()

  return (
    <>
      <Tabs>
        {tabOrder.map(({ path, textKey, regex }) => (
          <StyledNavLink key={path} to={path} isActive={(_, { pathname }) => pathname.match(regex)}>
            {t(textKey)}
          </StyledNavLink>
        ))}
      </Tabs>
      {providerMessage && (
        <DaiMessage>
          <CloseIcon onClick={dismissSaiHolderMessage}>✕</CloseIcon>
          <WarningHeader>Missing your DAI?</WarningHeader>
          <div>
            Don’t worry, check the{' '}
            <Link href={'/remove-liquidity?poolTokenAddress=0x89d24A6b4CcB1B6fAA2625fE562bDD9a23260359'}>
              SAI liquidity pool.
            </Link>{' '}
            Your old DAI is now SAI. If you want to migrate,{' '}
            <Link href="/remove-liquidity?poolTokenAddress=0x89d24A6b4CcB1B6fAA2625fE562bDD9a23260359">
              remove your SAI liquidity,
            </Link>{' '}
            migrate using the <Link href="https://migrate.makerdao.com/">migration tool</Link> then add your migrated
            DAI to the{' '}
            <Link href="add-liquidity?token=0x6B175474E89094C44Da98b954EedeAC495271d0F">new DAI liquidity pool.</Link>
          </div>
          <WarningFooter>
            <Link href="https://blog.makerdao.com/looking-ahead-how-to-upgrade-to-multi-collateral-dai/">
              Read more
            </Link>{' '}
            about this change on the official Maker blog.
          </WarningFooter>
        </DaiMessage>
      )}
      {generalMessage && !providerMessage && (
        <DaiMessage>
          <CloseIcon onClick={dismissGeneralDaiMessage}>✕</CloseIcon>
          <WarningHeader>DAI has upgraded!</WarningHeader>
          <div>
            Your old DAI is now SAI. To upgrade use the{' '}
            <Link href="https://migrate.makerdao.com/">migration tool.</Link>
          </div>
        </DaiMessage>
      )}
      {showBetaMessage && (
        <BetaMessage onClick={dismissBetaMessage}>
          <span role="img" aria-label="warning">
            💀
          </span>{' '}
          {t('betaWarning')}
        </BetaMessage>
      )}
    </>
  )
}

export default withRouter(NavigationTabs)
