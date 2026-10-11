import '@/styles/globals.css'
import { Provider as Web3Provider } from '../context/Web3Context'
import { ToastProvider } from '../components/Toast'
import Layout from '../components/Layout'

export default function App({ Component, pageProps }) {
  return (
    <Web3Provider>
      <ToastProvider>
        <Layout>
          <Component {...pageProps} />
        </Layout>
      </ToastProvider>
    </Web3Provider>
  )
}
