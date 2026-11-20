//@ts-check
// Packs the already built frontend (packages/frontend/html-dist) together
// with the WebXDC runtime into dist/deltachat.xdc
import { build } from 'esbuild'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises'
import { dirname, join, relative } from 'path'
import { fileURLToPath } from 'url'
import { crc32, deflateRawSync } from 'zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(root, '../..')
const app = join(root, 'dist/app')
const xdc = join(root, 'dist/deltachat.xdc')

await rm(join(root, 'dist'), { recursive: true, force: true })

// help pages and bundled xdc apps are not reachable without a real core
const skip = ['/help', '/xdcs', '/main.html']
await cp(join(repo, 'packages/frontend/html-dist'), app, {
  recursive: true,
  filter: src => !src.endsWith('.map') && !skip.some(s => src.endsWith(s)),
})

await build({
  entryPoints: [join(root, 'src/runtime.ts')],
  outfile: join(app, 'runtime.js'),
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
})

const html = await readFile(
  join(repo, 'packages/frontend/static/main.html'),
  'utf-8'
)
const runtimeTag = '<script src="./runtime.js" type="module"></script>'
if (!html.includes(runtimeTag))
  throw new Error('main.html changed, update bin/build.js')
await writeFile(
  join(app, 'index.html'),
  html.replace(
    runtimeTag,
    `<script src="./webxdc.js"></script>\n    ${runtimeTag}`
  )
)

await mkdir(join(app, 'locales'))
for (const f of await readdir(join(repo, '_locales'))) {
  if (f.endsWith('.json'))
    await cp(join(repo, '_locales', f), join(app, 'locales', f))
}

await writeFile(join(app, 'manifest.toml'), 'name = "Delta Chat"\n')
await cp(join(repo, 'images/deltachat.png'), join(app, 'icon.png'))

await writeFile(xdc, await zip(app))
console.log('built', relative(process.cwd(), xdc))

/**
 * Minimal zip writer (deflate, no zip64), enough for an .xdc.
 * @param {string} dir
 */
async function zip(dir) {
  const files = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter(e => e.isFile())
    .map(e => join(e.parentPath, e.name))
  const local = []
  const central = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(relative(dir, file).split('\\').join('/'))
    const data = await readFile(file)
    const packed = deflateRawSync(data)
    const crc = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4) // version needed
    header.writeUInt16LE(0x0800, 6) // utf-8 names
    header.writeUInt16LE(8, 8) // deflate
    header.writeUInt32LE(0x00210000, 10) // dos time/date: 1980-01-01
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(packed.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(name.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    header.copy(entry, 6, 4, 30) // shared fields
    entry.writeUInt32LE(offset, 42)
    local.push(header, name, packed)
    central.push(entry, name)
    offset += header.length + name.length + packed.length
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}
