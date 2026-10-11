import React, { useEffect } from 'react'
import { ThemeProvider as StyledComponentsThemeProvider, createGlobalStyle, css } from 'styled-components'
import { getQueryParam, checkSupportedTheme } from '../utils'
import { SUPPORTED_THEMES } from '../constants'
import { useDarkModeManager } from '../contexts/LocalStorage'

export * from './components'

const MEDIA_WIDTHS = {
  upToSmall: 600,
  upToMedium: 960,
  upToLarge: 1280
}

const mediaWidthTemplates = Object.keys(MEDIA_WIDTHS).reduce((accumulator, size) => {
  accumulator[size] = (...args) => css`
    @media (max-width: ${MEDIA_WIDTHS[size]}px) {
      ${css(...args)}
    }
  `
  return accumulator
}, {})

const white = '#FFFFFF'
const black = '#000000'

export default function ThemeProvider({ children }) {
  const [darkMode, toggleDarkMode] = useDarkModeManager()
  const themeURL = checkSupportedTheme(getQueryParam(window.location, 'theme'))
  const themeToRender = themeURL
    ? themeURL.toUpperCase() === SUPPORTED_THEMES.DARK
      ? true
      : themeURL.toUpperCase() === SUPPORTED_THEMES.LIGHT
      ? false
      : darkMode
    : darkMode
  useEffect(() => {
    toggleDarkMode(themeToRender)
  }, [toggleDarkMode, themeToRender])
  return <StyledComponentsThemeProvider theme={theme(themeToRender)}>{children}</StyledComponentsThemeProvider>
}

const theme = darkMode => ({
  white,
  black,
  textColor: darkMode ? white : '#131313',
  greyText: darkMode ? 'rgba(255,255,255,0.65)' : 'rgba(19,19,19,0.63)',

  backgroundColor: darkMode ? '#131313' : white,

  modalBackground: darkMode ? 'rgba(0,0,0,0.8)' : 'rgba(0,0,0,0.3)',
  inputBackground: darkMode ? '#1F1F1F' : '#F9F9F9',
  placeholderGray: darkMode ? 'rgba(255,255,255,0.38)' : 'rgba(19,19,19,0.35)',
  shadowColor: darkMode ? '#000' : '#2F80ED',

  surface1: darkMode ? '#131313' : white,
  surface2: darkMode ? '#1F1F1F' : '#F9F9F9',
  surface3: darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(19,19,19,0.08)',
  neutral1: darkMode ? white : '#131313',
  neutral2: darkMode ? 'rgba(255,255,255,0.65)' : 'rgba(19,19,19,0.63)',
  neutral3: darkMode ? 'rgba(255,255,255,0.38)' : 'rgba(19,19,19,0.35)',

  // grays
  concreteGray: darkMode ? '#1F1F1F' : '#F9F9F9',
  mercuryGray: darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(19,19,19,0.08)',
  silverGray: darkMode ? 'rgba(255,255,255,0.38)' : 'rgba(19,19,19,0.35)',
  chaliceGray: darkMode ? 'rgba(255,255,255,0.38)' : 'rgba(19,19,19,0.35)',
  doveGray: darkMode ? 'rgba(255,255,255,0.65)' : 'rgba(19,19,19,0.63)',
  mineshaftGray: darkMode ? '#E1E1E1' : '#2B2B2B',
  activeGray: darkMode ? '#1F1F1F' : '#F9F9F9',
  buttonOutlineGrey: darkMode ? '#FAFAFA' : '#F2F2F2',
  tokenRowHover: darkMode ? '#2A2A2A' : '#F0F0F0',

  charcoalBlack: darkMode ? '#F2F2F2' : '#404040',
  zumthorBlue: darkMode ? '#212529' : '#EBF4FF',
  malibuBlue: darkMode ? '#5CA2FF' : '#4981FF',
  royalBlue: '#4981FF',
  loadingBlue: '#e4f0ff',

  wisteriaPurple: '#9E62FF',
  salmonRed: '#FF5F52',
  pizazzOrange: '#FF8F05',
  warningYellow: '#FFBF17',
  swapexPink: '#FF37C7',
  accent: '#FF37C7',
  connectedGreen: '#0C8911',
  successVibrant: '#21C95E',

  metaMaskOrange: '#E8831D',

  textHover: darkMode ? '#FF37C7' : 'rgba(19,19,19,0.63)',
  buttonFaded: '#FF37C7',
  uniswapPink: '#FF37C7',

  mediaWidth: mediaWidthTemplates,
  flexColumnNoWrap: css`
    display: flex;
    flex-flow: column nowrap;
  `,
  flexRowNoWrap: css`
    display: flex;
    flex-flow: row nowrap;
  `
})

export const GlobalStyle = createGlobalStyle`
  html {
    font-family: 'Basel', -apple-system, system-ui, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 16px;
    font-variant: none;
    color: ${({ theme }) => theme.textColor};
    background-color: ${({ theme }) => theme.backgroundColor};
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    -webkit-tap-highlight-color: rgba(0, 0, 0, 0);
  }
  
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  body > div {
    height: 100%;
    overflow: auto;
    -webkit-overflow-scrolling: touch;
  }
`
