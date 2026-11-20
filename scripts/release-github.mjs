#!/usr/bin/env node
/**
 * 把 release/ 里的 Windows 安装包发到 GitHub Releases。
 *
 * 用法：
 *   npm run release              # 用 package.json 里的版本
 *   npm run release -- 1.3.7     # 补发历史版本（需要 release/ 里已有对应安装包）
 *
 * 凭据来源（按顺序）：
 *   1. 环境变量 GITHUB_TOKEN
 *   2. git 的 credential helper（和 git push 用同一份凭据，通常已存在 Windows 凭据管理器里）
 *
 * 行为可重复执行：同名 Release 已存在就更新正文，同名安装包已存在就先删再传。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, openAsBlob, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function resolveGit() {
  const candidates = [process.env.GIT_EXECUTABLE, 'git', 'C:\\Users\\jz\\tools\\mingit\\cmd\\git.exe']
  for (const c of candidates) {
    if (!c) continue
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' })
      return c
    } catch {
      /* try next */
    }
  }
  throw new Error('找不到 git 可执行文件')
}

const git = resolveGit()

function gitOut(args, opts = {}) {
  return execFileSync(git, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: opts.quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim()
  const out = execFileSync(git, ['credential', 'fill'], {
    cwd: repoRoot,
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const match = out.match(/^password=(.+)$/m)
  if (!match) {
    throw new Error('取不到 GitHub 凭据：先 git push 一次把凭据存进 credential manager，或者设置 GITHUB_TOKEN')
  }
  return match[1].trim()
}

function repoSlug() {
  const remote = gitOut(['remote', 'get-url', 'origin'])
  const match = remote.match(/github\.com[:/]+([^/]+)\/([^/.]+?)(?:\.git)?$/)
  if (!match) throw new Error(`识别不了 GitHub 仓库地址：${remote}`)
  return { owner: match[1], repo: match[2] }
}

function readVersion() {
  const arg = process.argv.slice(2).find((a) => /^\d+\.\d+\.\d+/.test(a))
  if (arg) return arg.replace(/^v/, '')
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  return pkg.version
}

/** 该版本对应的提交：优先用本地 tag，其次用 "vX.Y.Z: ..." 的提交信息，最后用 HEAD */
function resolveCommit(tag, version) {
  try {
    return gitOut(['rev-list', '-n', '1', tag], { quiet: true })
  } catch {
    /* 没有本地 tag，继续找提交信息 */
  }
  try {
    const found = gitOut(['log', '--all', '--grep', `^v${version}:`, '--format=%H', '-1'], { quiet: true })
    if (found) return found.split(/\r?\n/)[0].trim()
  } catch {
    /* ignore */
  }
  return gitOut(['rev-parse', 'HEAD'])
}

/** 从 README 更新日志里取该版本的条目，拼成 Release 正文 */
function releaseBody(version) {
  const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8')
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 从 "### vX.Y.Z" 起，到下一个 "### v..." / 下一个 "## ..." / 文件末尾为止（要跨多个条目行）
  const match = readme.match(new RegExp(`^### v${escaped}[^\\n]*\\n([\\s\\S]*?)(?=^### |^## |(?![\\s\\S]))`, 'm'))
  const bullets = match && match[1].trim() ? match[1].trim() : '- 见仓库 README 更新日志'
  return `## v${version}\n\n### 变更\n${bullets}\n`
}

class GitHub {
  constructor(token, owner, repo) {
    this.token = token
    this.owner = owner
    this.repo = repo
  }

  async call(method, apiPath, body, headers = {}) {
    const url = apiPath.startsWith('http') ? apiPath : `https://api.github.com${apiPath}`
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'llm-api-monitor-release',
        ...headers,
      },
      body,
    })
    const text = await res.text()
    let json
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!res.ok) {
      const message = json?.message ?? text.slice(0, 300)
      const err = new Error(`${method} ${apiPath} → ${res.status}: ${message}`)
      err.status = res.status
      throw err
    }
    return json
  }

  listReleases() {
    return this.call('GET', `/repos/${this.owner}/${this.repo}/releases?per_page=100`)
  }

  async ensureRelease(tag, name, body, targetCommitish) {
    const releases = await this.listReleases()
    const existing = releases.find((r) => r.tag_name === tag)
    if (existing) {
      return this.call('PATCH', `/repos/${this.owner}/${this.repo}/releases/${existing.id}`, JSON.stringify({ name, body }), {
        'Content-Type': 'application/json',
      })
    }
    return this.call(
      'POST',
      `/repos/${this.owner}/${this.repo}/releases`,
      JSON.stringify({
        tag_name: tag,
        target_commitish: targetCommitish,
        name,
        body,
        draft: false,
        prerelease: tag.includes('-'),
      }),
      { 'Content-Type': 'application/json' }
    )
  }

  async uploadAsset(release, filePath) {
    const name = path.basename(filePath)
    const size = statSync(filePath).size
    const existing = (release.assets ?? []).find((a) => a.name === name)
    if (existing && existing.size === size && existing.state === 'uploaded') {
      console.log(`[release] 安装包已存在且大小一致，跳过上传：${name}`)
      return existing
    }
    if (existing) {
      await this.call('DELETE', `/repos/${this.owner}/${this.repo}/releases/assets/${existing.id}`)
    }
    const blob = await openAsBlob(filePath)
    const uploaded = await this.call(
      'POST',
      `https://uploads.github.com/repos/${this.owner}/${this.repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      blob,
      { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) }
    )
    return uploaded
  }
}

async function main() {
  const version = readVersion()
  const tag = `v${version}`
  const filePath = path.join(repoRoot, 'release', `LLM-API-Monitor-Setup-${version}.exe`)
  if (!existsSync(filePath)) {
    throw new Error(`安装包不存在：${filePath}\n先跑 npm run dist`)
  }
  const { owner, repo } = repoSlug()
  const api = new GitHub(readToken(), owner, repo)
  const body = releaseBody(version)
  const head = resolveCommit(tag, version)
  console.log(`[release] ${owner}/${repo} ${tag} ← ${path.basename(filePath)} (${(statSync(filePath).size / 1048576).toFixed(1)} MB, commit ${head.slice(0, 7)})`)
  const release = await api.ensureRelease(tag, `${tag} 正式版`, body, head)
  const asset = await api.uploadAsset(release, filePath)
  console.log(`[release] OK  ${release.html_url}`)
  console.log(`[release] asset ${asset.name} (${(asset.size / 1048576).toFixed(1)} MB)`)
  console.log(`[release] download ${asset.browser_download_url}`)
}

main().catch((err) => {
  console.error(`[release] 失败：${err.message}`)
  process.exit(1)
})
