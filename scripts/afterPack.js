/**
 * electron-builder afterPack hook: strip runtime files a Chinese-only
 * offline tool never loads. Saves ~55 MB in win-unpacked / ~20 MB in NSIS.
 *
 * Removed:
 * - locales/*.pak except zh-CN/en-US (electronLanguages should already
 *   handle this; belt-and-suspenders)
 * - LICENSES.chromium.html (legal text dump, 8.7 MB)
 * - vk_swiftshader.dll + vulkan-1.dll (software Vulkan; app disables GPU)
 * - d3dcompiler_47.dll (legacy D3D shader compiler, unused w/o GPU)
 */
const fs = require('fs')
const path = require('path')

exports.default = async function afterPack (context) {
  const exeDir = path.join(context.appOutDir)
  const keepLocales = new Set(['zh-CN.pak', 'en-US.pak'])

  const rm = (p) => {
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true })
        console.log(`[afterPack] removed ${path.relative(exeDir, p)}`)
      }
    } catch (err) {
      console.warn(`[afterPack] skip ${p}: ${err.message}`)
    }
  }

  // locales
  const localesDir = path.join(exeDir, 'locales')
  if (fs.existsSync(localesDir)) {
    for (const f of fs.readdirSync(localesDir)) {
      if (!keepLocales.has(f)) rm(path.join(localesDir, f))
    }
  }

  // large unused runtime files
  rm(path.join(exeDir, 'LICENSES.chromium.html'))
  rm(path.join(exeDir, 'vk_swiftshader.dll'))
  rm(path.join(exeDir, 'vulkan-1.dll'))
  rm(path.join(exeDir, 'd3dcompiler_47.dll'))
}
