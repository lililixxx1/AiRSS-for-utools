import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import pkg from './package.json'

// base './' 保证 dist 内相对路径在 uTools file:// 加载下可用
export default defineConfig({
  base: './',
  plugins: [vue()],
  define: {
    // 版本号单一真源 = package.json：关于区展示与发布打包都从这里取，改版本只动一处
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    chunkSizeWarningLimit: 600
  }
})
