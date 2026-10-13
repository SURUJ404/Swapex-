import '@/styles/globals.css'
import { Provider as Web3Provider } from '../context/Web3Context'
import { ToastProvider } from '../components/Toast'
import { SigningProvider } from '../context/SigningContext'
import SigningSummary from '../components/SigningSummary'
import Layout from '../components/Layout'

export default function App({ Component, pageProps }) {
  return (
    <Web3Provider>
      <ToastProvider>
        <SigningProvider>
          <Layout>
            <Component {...pageProps} />
          </Layout>
          <SigningSummary />
        </SigningProvider>
      </ToastProvider>
    </Web3Provider>
  )
}
