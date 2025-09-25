import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs-extra'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function titleFromName(name: string): string {
  const base = name.replace(/\.md$/i, '')
  return base
    .replace(/[_-]+/g, ' ')
    .replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase())
}

type ManifestNode = {
  name: string
  title: string
  type: 'file' | 'dir'
  routePath: string // relative route path without leading slash; for files, without .md
  children?: ManifestNode[]
  hasReadme?: boolean
}

function buildManifest(srcDir: string, currentRel: string = ''): ManifestNode {
  const fullPath = path.join(srcDir, currentRel)
  const stats = fs.statSync(fullPath)

  if (stats.isDirectory()) {
    const entries = fs.readdirSync(fullPath)
    const children: ManifestNode[] = []
    let hasReadme = false
    for (const entry of entries) {
      const rel = path.join(currentRel, entry)
      const abs = path.join(srcDir, rel)
      const st = fs.statSync(abs)
      if (st.isDirectory()) {
        children.push(buildManifest(srcDir, rel))
      } else if (entry.toLowerCase() === 'readme.md') {
        hasReadme = true
      } else if (entry.toLowerCase().endsWith('.md')) {
        const name = entry
        children.push({
          name,
          title: titleFromName(name),
          type: 'file',
          routePath: path.posix.join(currentRel.split(path.sep).join('/'), name.replace(/\.md$/i, '')),
        })
      }
    }
    const dirName = currentRel === '' ? '' : path.basename(currentRel)
    return {
      name: dirName || 'manual',
      title: dirName ? titleFromName(dirName) : 'Manual',
      type: 'dir',
      routePath: currentRel.split(path.sep).join('/'),
      hasReadme,
      children: children.sort((a, b) => a.title.localeCompare(b.title)),
    }
  } else {
    const name = path.basename(currentRel)
    return {
      name,
      title: titleFromName(name),
      type: 'file',
      routePath: currentRel.replace(/\\/g, '/').replace(/\.md$/i, ''),
    }
  }
}

function copyManualAndGenerateManifest() {
  const src = path.resolve(__dirname, '..', 'knowledge-base', 'manual')
  const publicDir = path.resolve(__dirname, 'public')
  const dest = path.join(publicDir, 'manual')
  const manifestPath = path.join(publicDir, 'manual-manifest.json')

  if (!fs.pathExistsSync(src)) {
    console.warn(`[manual] source not found at ${src}`)
    return
  }
  fs.ensureDirSync(publicDir)
  fs.removeSync(dest)
  fs.copySync(src, dest)
  const manifest = buildManifest(src)
  fs.writeJSONSync(manifestPath, manifest, { spaces: 2 })
  console.log('[manual] Copied manual to public and generated manifest')
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'manual-copy-plugin',
      apply: 'serve',
      configureServer() {
        copyManualAndGenerateManifest()
      },
    },
    {
      name: 'manual-copy-plugin-build',
      apply: 'build',
      buildStart() {
        copyManualAndGenerateManifest()
      },
    },
  ],
})
