import { Html, Head, Main, NextScript } from "next/document";

// Apply the stored (or system) theme before first paint so the page never flashes dark
// for light-theme users. CSP allows 'unsafe-inline' for scripts (see next.config.mjs).
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('swapex:theme');if(t!=='light'&&t!=='dark'){t=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark'}document.documentElement.setAttribute('data-theme',t)}catch(e){document.documentElement.setAttribute('data-theme','dark')}})()`;

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </Head>
      <body className="antialiased">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
