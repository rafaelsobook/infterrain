import { defineConfig } from 'vite'
import { fileURLToPath } from 'url'
import { resolve, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.js'),
      name: 'InfTerrain',
      fileName: 'infterrain',
      formats: ['es'],
    },
    rollupOptions: {
      // Regex covers @babylonjs/core, @babylonjs/loaders, and any sub-paths
      external: [/^@babylonjs/],
    },
  },
})
