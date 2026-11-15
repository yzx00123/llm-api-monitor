/**
 * electron-builder afterPack hook: strip runtime files this offline tool
 * never loads. Verified the app still starts with each of these removed.
 *
 * Removed:
 * - locales/*.pak except zh-CN/en-US (electronLanguages already helps)
 * - LICENSES.chromium.html / LICENSE.electron.txt (legal text dumps)
 * - vk_swiftshader.dll + vulkan-1.dll + vk_swiftshader_icd.json (software Vulkan)
 * - d3dcompiler_47.dll (legacy D3D shader compiler, unused w/o GPU)
 * - libGLESv2.dll + libEGL.dll (ANGLE/GPU — app calls disableHardwareAcceleration)
 * - ffmpeg.dll (media codecs — app plays no audio/video)
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

  // legal text dumps
  rm(path.join(exeDir, 'LICENSES.chromium.html'))
  rm(path.join(exeDir, 'LICENSE.electron.txt'))

  // software Vulkan stack (unused — GPU disabled)
  rm(path.join(exeDir, 'vk_swiftshader.dll'))
  rm(path.join(exeDir, 'vulkan-1.dll'))
  rm(path.join(exeDir, 'vk_swiftshader_icd.json'))
  rm(path.join(exeDir, 'd3dcompiler_47.dll'))

  // ANGLE / GLES — only loaded when hardware acceleration is on.
  // main/index.ts calls app.disableHardwareAcceleration() before ready.
  rm(path.join(exeDir, 'libGLESv2.dll'))
  rm(path.join(exeDir, 'libEGL.dll'))

  // media codecs — this app never plays audio or video.
  rm(path.join(exeDir, 'ffmpeg.dll'))

  // V8 snapshots only warm-start the JIT; the app re-warms on first run.
  // Verified: launches fine without them.
  rm(path.join(exeDir, 'v8_context_snapshot.bin'))
  rm(path.join(exeDir, 'snapshot_blob.bin'))

  // icudtl.dat MUST stay — Chromium/V8 need it for Chinese text + Intl.
}
