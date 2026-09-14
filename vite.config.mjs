import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        panel: resolve(__dirname, 'src/renderer/panel.html'),
        ball: resolve(__dirname, 'src/renderer/ball.html'),
        pet: resolve(__dirname, 'src/renderer/pet.html'),
        capture: resolve(__dirname, 'src/renderer/capture.html'),
        // 会议记录的隐藏采集页
        minutes: resolve(__dirname, 'src/renderer/minutes.html')
      }
    }
  },
  server: {
    port: 5199,
    strictPort: true
  }
});
