import { copyFileSync, existsSync, mkdirSync } from 'fs'

// Bundle both icon formats next to the main bundle:
// - icon.ico: Windows taskbar / title-bar small icon + tray icon (native format)
// - icon.png: fallback for other platforms
//
// 这一步以前只在 `npm run build` 里跑，而 `npm run dist` 走的是
// `electron-vite build && electron-builder`，跳过 postbuild 后 out/main 里就没有图标了：
// 托盘是个空白块、任务栏图标也丢了。现在 dist 也走 npm run build，这里再补一层防御。
const targets = [
  ['build/icon.ico', 'out/main/icon.ico'],
  ['build/icon.png', 'out/main/icon.png']
]

for (const [from, to] of targets) {
  if (!existsSync(from)) {
    throw new Error(`[postbuild] 缺少源文件 ${from}`)
  }
  mkdirSync('out/main', { recursive: true })
  copyFileSync(from, to)
}
console.log('[postbuild] copied icon.ico + icon.png -> out/main/')
