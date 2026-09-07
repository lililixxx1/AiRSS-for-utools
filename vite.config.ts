import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// base './' 保证 dist 内相对路径在 uTools file:// 加载下可用
export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    target: 'es2020',
    chunkSizeWarningLimit: 600
  }
})
