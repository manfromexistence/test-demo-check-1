import type {Metadata} from 'next';
import './globals.css'; // Global styles

export const metadata: Metadata = {
  title: 'Slop New York — Physics & Destruction',
  description: 'Interactive 3D New York City simulation in Walk, Cycle, Car, and Plane/Helicopter modes with full physics-based collisions, destructible street props, trees, buildings, pedestrian knockback, and realistic spatial Web Audio effects.',
  openGraph: {
    title: 'Slop New York — Physics & Destruction',
    description: 'Interactive 3D New York City simulation in Walk, Cycle, Car, and Plane/Helicopter modes with full physics-based collisions, destructible street props, trees, buildings, pedestrian knockback, and realistic spatial Web Audio effects.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Slop New York — Physics & Destruction',
    description: 'Interactive 3D New York City simulation in Walk, Cycle, Car, and Plane/Helicopter modes with full physics-based collisions, destructible street props, trees, buildings, pedestrian knockback, and realistic spatial Web Audio effects.',
  },
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className="w-full h-full overflow-hidden bg-black">
      <body suppressHydrationWarning className="w-full h-full m-0 p-0 overflow-hidden bg-black">{children}</body>
    </html>
  );
}
