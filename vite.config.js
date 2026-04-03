import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Vocal Peach',
        short_name: 'VocalPeach',
        description: 'Real-time vocal pitch monitor',
        theme_color: '#FF9B7B',
        background_color: '#FFF8F5',
        display: 'standalone',
        icons: [
          { src: '/peach-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/peach-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 3000,
  },
});
