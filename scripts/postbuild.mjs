import { copyFileSync } from 'fs'

// Bundle both formats next to the main bundle:
// - icon.ico: Windows taskbar / title-bar small icon (native format)
// - icon.png: fallback for other platforms
copyFileSync('build/icon.ico', 'out/main/icon.ico')
copyFileSync('build/icon.png', 'out/main/icon.png')
console.log('[postbuild] copied icon.ico + icon.png -> out/main/')
