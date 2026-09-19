import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  server: {
    // Port dev-serwera i backendu, na który proxy'uje, da się podmienić przez
    // ALFA_WEB_PORT / ALFA_API_PORT — druga para (np. 4010 → 4012) pozwala
    // testować zmiany na KOPII bazy, nie ruszając instancji na 4000/4001.
    host: '0.0.0.0',
    port: Number(process.env.ALFA_WEB_PORT) || 4000,
    allowedHosts: ['ts150.korat-egret.ts.net'],
    proxy: {
      '/api': {
        target: `http://localhost:${Number(process.env.ALFA_API_PORT) || 4001}`,
        changeOrigin: true,
        // changeOrigin przepisuje Host na :4001 i gubi Origin, więc backend nie
        // wie, spod jakiego adresu przyszło żądanie — a składa z niego absolutne
        // linki (mail zlecenia). xfwd dokłada X-Forwarded-Host/-Proto z oryginału.
        xfwd: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Ręczne chunki tylko tam, gdzie automat sklejał paczki wielkości
        // aplikacji. Reszta (strony CRM-a, panel technika) dzieli się sama —
        // przez `React.lazy` w `src/App.tsx` i `src/technik/TechnikApp.tsx`.
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // Runtime Reacta ląduje w jednym pliku, wspólnym dla CRM-a
            // i panelu technika: ten chunk cache'uje się między wydaniami
            // i nie ma powodu, żeby przepisywał go każdy deploy stron.
            if (
              /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(
                id,
              )
            ) {
              return 'vendor-react'
            }
            // FullCalendar to ~300 kB, których dotyka wyłącznie kalendarz
            // (techniczny i handlowy). Osobny plik, żeby dwie strony
            // kalendarza nie duplikowały go ani nie wciągały do wspólnego.
            if (id.includes('@fullcalendar')) return 'vendor-fullcalendar'
            // Lucide: import nazwany jest tree-shakowany (jedna ikona = jeden
            // moduł) i bez tej linii Rollup robił z tego ~75 plików po 200 B,
            // z czego 25 wisiało na ścieżce krytycznej panelu. Na LTE liczy
            // się wtedy zestawianie połączeń, nie transfer — wszystkie ikony
            // faktycznie używane w kodzie idą w jeden, stabilnie cache'owany
            // plik (60 kB / 18 kB gzip).
            if (id.includes('lucide-react')) return 'vendor-lucide'
            // GridJS — tylko tabele CRM-a.
            if (id.includes('gridjs')) return 'vendor-gridjs'
            // Asystent (streaming AI) i podgląd dokumentów: ciężkie, wchodzą
            // na jednej-dwóch stronach.
            if (id.includes('docx-preview')) return 'vendor-docx'
            if (
              /[\\/]node_modules[\\/](ai|@ai-sdk|react-markdown|remark-|micromark|mdast-|unist-|hast-|unified|vfile|devlop|zod)/.test(
                id,
              )
            ) {
              return 'vendor-markdown'
            }
          }
          // `src/lib/api.ts` (10 000+ linii) jest importowany i przez CRM,
          // i przez panel technika, więc automat i tak wyrzuciłby go do
          // wspólnego chunka — z własną nazwą widać przynajmniej, ile waży.
          // Podział samego api.ts to osobne zadanie.
          if (/[\\/]src[\\/]lib[\\/]api\.ts$/.test(id)) return 'api'
          return undefined
        },
      },
    },
  },
})
