#!/usr/bin/env node
/**
 * 备用推送：当 `git push` 连不上 github.com:443（但 api.github.com 正常）时，
 * 用 GitHub 的 Git Data API 把本地 HEAD 原样写到远端 main。
 *
 * 做法是复刻本地提交对象的每一部分（tree / parent / author / committer / message），
 * 所以远端算出来的 commit sha 和本地完全一致；推完两边历史不分叉，网络恢复后
 * `git push` 依然干净可用。
 *
 * 用法：
 *   npm run push:api             # 推送 HEAD 到 origin/main
 *   npm run push:api -- --dry-run  # 只演练，不创建/更新任何远端引用
 *
 * 失败时退出码：1 环境问题、2 内容校验不过（绝不强行改远端）、3 远端有本地没有的提交。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const DRY = process.argv.includes('--dry-run')

function resolveGit() {
  const candidates = [process.env.GIT_EXECUTABLE, 'git', 'C:\\Users\\jz\\tools\\mingit\\cmd\\git.exe']
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      execFileSync(candidate, ['--version'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] })
      return candidate
    } catch {
      // 换下一个候选
    }
  }
  throw new Error('找不到可用的 git 可执行文件，可以用 GIT_EXECUTABLE 指定')
}

const GIT = resolveGit()
const git = (args, input) =>
  execFileSync(GIT, args, { cwd: ROOT, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 })

function readToken() {
  if (process.env.GITHUB_TOKEN?.trim()) return process.env.GITHUB_TOKEN.trim()
  const out = git(['credential', 'fill'], 'protocol=https\nhost=github.com\n\n')
  const password = out.match(/^password=(.+)$/m)?.[1]
  if (!password) throw new Error('拿不到 GitHub 凭据（git credential 里没有，也没有 GITHUB_TOKEN）')
  return password.trim()
}

function repoSlug() {
  const url = git(['remote', 'get-url', 'origin']).trim()
  const match = url.match(/github\.com[:/]+([^/]+)\/([^/.]+?)(?:\.git)?$/)
  if (!match) throw new Error(`origin 不是 GitHub 仓库：${url}`)
  return { owner: match[1], repo: match[2] }
}

function parseIdent(line) {
  const match = line.match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/)
  if (!match) throw new Error(`解析不了身份行：${line}`)
  return { name: match[1], email: match[2], seconds: Number(match[3]), tz: match[4] }
}

function identToApi({ name, email, seconds, tz }) {
  const sign = tz.startsWith('-') ? -1 : 1
  const offsetMinutes = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)))
  const iso = new Date((seconds + offsetMinutes * 60) * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
  return { name, email, date: iso + tz.slice(0, 3) + ':' + tz.slice(3) }
}

// 本地提交对象的 sha1（用来和 API 返回的 sha 对账）
function commitSha(raw) {
  return createHash('sha1').update(`commit ${Buffer.byteLength(raw, 'utf8')}\0${raw}`, 'utf8').digest('hex')
}

const token = readToken()
const { owner, repo } = repoSlug()
const REPO = `/repos/${owner}/${repo}`

async function call(method, apiPath, body) {
  const res = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'llm-api-monitor-push',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(`${method} ${apiPath} → ${res.status}: ${json?.message ?? text.slice(0, 200)}`)
  return json
}

async function main() {
  const raw = git(['cat-file', 'commit', 'HEAD'])
  const splitAt = raw.indexOf('\n\n')
  const headers = raw.slice(0, splitAt).split('\n')
  const message = raw.slice(splitAt + 2)
  const tree = headers.find((l) => l.startsWith('tree ')).slice(5).trim()
  const parentLine = headers.find((l) => l.startsWith('parent '))
  if (!parentLine) throw new Error('HEAD 是根提交（没有父提交），这个脚本不支持首次推送')
  const parent = parentLine.slice(7).trim()
  const author = parseIdent(headers.find((l) => l.startsWith('author ')).slice(7))
  const committer = parseIdent(headers.find((l) => l.startsWith('committer ')).slice(10))
  const localSha = commitSha(raw)
  const localShort = localSha.slice(0, 7)

  // 只上传真正改动过的文件，其余文件在远端已经有对应 blob
  const parentTree = git(['cat-file', 'commit', parent])
    .split('\n')
    .find((l) => l.startsWith('tree '))
    .slice(5)
    .trim()
  const changed = git(['diff', '--name-only', parent, 'HEAD'])
    .split(/\r?\n/)
    .filter(Boolean)

  console.log(`仓库 ${owner}/${repo}`)
  console.log(`本地 HEAD ${localShort}（${changed.length} 个文件改动）`)
  for (const file of changed) console.log(`  · ${file}`)
  if (DRY) {
    console.log('--dry-run：只演练，不写远端')
    return
  }

  const entries = []
  for (const file of changed) {
    const content = readFileSync(path.join(ROOT, ...file.split('/')))
    const mode = git(['ls-tree', 'HEAD', '--', file]).slice(0, 6).trim() || '100644'
    const blob = await call('POST', `${REPO}/git/blobs`, {
      content: content.toString('base64'),
      encoding: 'base64',
    })
    entries.push({ path: file, mode, type: 'blob', sha: blob.sha })
  }

  const newTree = await call('POST', `${REPO}/git/trees`, { base_tree: parentTree, tree: entries })
  if (newTree.sha !== tree) {
    console.error(`✗ tree 对不上（远端 ${newTree.sha.slice(0, 7)} / 本地 ${tree.slice(0, 7)}），放弃`)
    process.exit(2)
  }

  const remoteMain = (await call('GET', `${REPO}/git/ref/heads/main`)).object.sha
  if (remoteMain === localSha) {
    console.log('✓ 远端 main 已经指向这个提交，无需推送')
    return
  }
  if (remoteMain !== parent) {
    console.error(
      `✗ 远端 main 是 ${remoteMain.slice(0, 7)}，不是本地 HEAD 的父提交 ${parent.slice(0, 7)}；` +
        '远端有本地没有的提交，请先 git pull 再试（这个脚本只做 fast-forward）',
    )
    process.exit(3)
  }

  const newCommit = await call('POST', `${REPO}/git/commits`, {
    message,
    tree: newTree.sha,
    parents: [parent],
    author: identToApi(author),
    committer: identToApi(committer),
  })
  if (newCommit.sha !== localSha) {
    console.error(`✗ 远端提交 ${newCommit.sha.slice(0, 7)} 与本地 ${localShort} 不一致，放弃更新引用`)
    process.exit(2)
  }

  await call('PATCH', `${REPO}/git/refs/heads/main`, { sha: newCommit.sha, force: false })
  console.log(`✓ 已通过 API 推送 main → ${localShort}（sha 与本地一致，未分叉）`)
  console.log(`  https://github.com/${owner}/${repo}/commit/${localSha}`)
}

main().catch((error) => {
  console.error(`✗ ${error.message}`)
  process.exit(1)
})
