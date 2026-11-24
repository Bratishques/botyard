import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Админка ходит в API с того же origin: cookie сессии SameSite=Strict и запрет не-JSON запросов
// защищают от CSRF только так, а CORS api не открывает. Поэтому API — под префиксом `/api` того же
// dev-сервера, прокси снимает префикс. Префикс нужен, чтобы пути SPA (`/destinations`) не путались с путями API.
const apiTarget = process.env.BOTYARD_API_URL ?? 'http://localhost:4000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.ADMIN_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api/': { target: apiTarget, rewrite: (path) => path.replace(/^\/api/, '') },
    },
  },
  // Внутренний инструмент операторов: один бандл (React, Router, Query, zod) в 0,5 МБ — нормально, дробить незачем
  build: { chunkSizeWarningLimit: 700 },
  preview: {
    proxy: {
      '/api/': { target: apiTarget, rewrite: (path) => path.replace(/^\/api/, '') },
    },
  },
})
