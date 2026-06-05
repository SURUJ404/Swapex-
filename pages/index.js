import { Geist } from "next/font/google";

const geist = Geist({
  subsets: ["latin"],
});

export default function Home() {
  return (
    <main
      className={`${geist.className} flex min-h-screen items-center justify-center bg-black overflow-hidden relative`}
    >
      {/* Background Glow */}
      <div className="absolute top-0 left-0 w-[500px] h-[500px] bg-pink-500 rounded-full blur-3xl opacity-30"></div>

      <div className="absolute bottom-0 right-0 w-[500px] h-[500px] bg-blue-500 rounded-full blur-3xl opacity-30"></div>

      {/* Content */}
      <div className="z-10 text-center">
        <h1 className="text-7xl font-extrabold tracking-[12px] text-black bg-gradient-to-r from-pink-400 to-blue-400 bg-clip-text text-transparent drop-shadow-2xl">
          SWAPEX
        </h1>

        <p className="mt-6 text-zinc-400 text-lg">
          Future of Digital Swapping
        </p>
      </div>
    </main>
  );
}
