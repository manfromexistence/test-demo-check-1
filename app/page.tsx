'use client';

import { useEffect, useRef } from 'react';

export default function HomePage() {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const focusIframe = () => {
      if (iframeRef.current) {
        iframeRef.current.focus();
        iframeRef.current.contentWindow?.focus();
      }
    };
    focusIframe();
    window.addEventListener('click', focusIframe);
    window.addEventListener('keydown', (e) => {
      if (iframeRef.current && document.activeElement !== iframeRef.current) {
        iframeRef.current.focus();
        iframeRef.current.contentWindow?.focus();
      }
    });
    return () => {
      window.removeEventListener('click', focusIframe);
    };
  }, []);

  return (
    <main className="relative w-screen h-screen overflow-hidden bg-black select-none">
      <iframe
        ref={iframeRef}
        src="/index.html?v=20261101"
        title="Slop New York — Physics & Destruction"
        className="w-full h-full border-0 block"
        allow="autoplay; fullscreen; gamepad; xr-spatial-tracking"
      />
    </main>
  );
}
