import { defineConfig } from 'vite'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'

// The demo lab: `npm run demo`, then open http://localhost:5199
//
// It serves the module's own SOURCE (../src), not dist, so a change shows up
// on reload with no build step. createOpenWorld loads its ground textures,
// tree glbs and the billboard tree by relative path ('./textures/grass.jpg',
// './models/trees/tree_1.glb', ...) - those belong to the host game, not this
// package, so the demo borrows a host's public/ folder for them. Point
// INFTERRAIN_ASSETS at one; the default is the vessel client's on this machine.
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const assets = process.env.INFTERRAIN_ASSETS ?? resolve(root, '../../../webgames/gl/client/public')

if (!existsSync(assets)) {
  console.warn(`[infterrain demo] no assets folder at ${assets} - set INFTERRAIN_ASSETS to a host game's public/ folder, or the ground will render untextured`)
}

export default defineConfig({
  root: here,
  publicDir: existsSync(assets) ? assets : false,
  // served as plain ESM - the Havok wasm is found relative to its own module
  // URL, which prebundling would move
  optimizeDeps: { exclude: ['@babylonjs/havok', '@babylonjs/core', '@babylonjs/loaders'] },
  server: {
    // no live reload: an edit to src/ mid-run would restart the lab under a
    // scripted walk test. Files are still watched, so a reload by hand picks
    // changes up
    hmr: false,
    port: 5199,
    strictPort: true,
    fs: { allow: [root, assets] },
  },
})
