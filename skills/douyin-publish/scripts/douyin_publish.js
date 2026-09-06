// douyin_publish.js — ego lite (ego-browser) 自动发布视频到抖音
// 固化自 2026-09 实测流程：登录检查 → 上传 → 填标题/描述/话题 → 等内容检测 → 发布 → 核实
//
// 用法（参数走 JSON 文件，因为 ego-browser nodejs 不继承 shell 环境变量）：
//   cat > /tmp/douyin_params.json <<'EOF'
//   {
//     "video": "/path/to/video.mp4",
//     "title": "视频标题（≤30字）",
//     "desc": "描述文案",
//     "tags": ["标签1", "标签2"]
//   }
//   EOF
//   ego-browser nodejs < douyin_publish.js --params /tmp/douyin_params.json
//
// 命令行参数（process.argv 在该运行时可用）：
//   --params <file>   参数 JSON 文件（推荐）
//   --healthcheck     只检查登录态即退出（无副作用）
//   --dry-run         走完全部流程但不点发布（会真实注入文件到表单）
//
// 退出码：0 成功 | 1 失败 | 2 未登录/登录超时
// 首次登录时脚本会截图二维码到 /tmp/douyin_login_qr.png 并等待扫码最长 180s。

const fs = await import('fs')

// ---- 解析命令行参数 ----
const argv = process.argv.slice(2)
function argOf(name) {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}
const hasFlag = (name) => argv.includes(name)

const SPACE = 'douyin-publish'
const UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload'
const PARAMS_FILE = argOf('--params') || '/tmp/douyin_params.json'

// ---- 读参数 ----
let P = {}
try {
  P = JSON.parse(fs.readFileSync(PARAMS_FILE, 'utf-8'))
} catch (e) {
  cliLog('PARAMS_ERROR: cannot read ' + PARAMS_FILE + ' (' + e.message + ')')
  process.exit(1)
}

const video = (P.video || '').trim()
const title = (P.title || '').trim()
const desc = (P.desc || '').trim()
const tags = (P.tags || []).map(t => (t.startsWith('#') ? t : '#' + t)).join(' ')

// ---- 任务空间获取（用户可能中途接管过，逐级降级）----
async function acquireSpace(name) {
  try { return await useOrCreateTaskSpace(name) } catch (e) {
    cliLog('useOrCreateTaskSpace failed: ' + e.message)
  }
  const spaces = await listTaskSpaces()
  const mine = spaces.find(s => s.name === name)
  if (!mine) throw new Error('task space not found: ' + name)
  try { return await takeOverTaskSpace(mine.id) } catch (e) {
    cliLog('takeOverTaskSpace failed: ' + e.message)
  }
  return await claimTaskSpace(mine.id)
}

const task = await acquireSpace(SPACE)
cliLog('task space: #' + task.id)

// ---- 登录检查 ----
async function isLoggedIn() {
  const r = await cdp('Network.getCookies', { urls: ['https://creator.douyin.com'] })
  return r.cookies.some(c => c.name === 'sessionid' || c.name === 'sessionid_ss')
}

await gotoAndWait(UPLOAD_URL)
await waitForLoad()

if (!(await isLoggedIn())) {
  const shot = await cdp('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync('/tmp/douyin_login_qr.png', Buffer.from(shot.data, 'base64'))
  cliLog('NOT_LOGGED_IN — 请在 ego lite 窗口用抖音 App 扫码（二维码截图: /tmp/douyin_login_qr.png）')
  let ok = false
  for (let i = 0; i < 60; i++) {
    await wait(3)
    if (await isLoggedIn()) { ok = true; break }
  }
  if (!ok) { cliLog('LOGIN_TIMEOUT — 180s 内未检测到登录'); process.exit(2) }
  cliLog('login detected, continuing')
  await gotoAndWait(UPLOAD_URL)
  await waitForLoad()
} else {
  cliLog('login ok')
}

if (hasFlag('--healthcheck')) { cliLog('HEALTHCHECK_PASS'); process.exit(0) }

// ---- 参数校验 ----
if (!video) { cliLog('missing "video" in params'); process.exit(1) }
if (!fs.existsSync(video)) { cliLog('video not found: ' + video); process.exit(1) }
if (!title) { cliLog('missing "title" in params'); process.exit(1) }
if ([...title].length > 30) { cliLog('title too long (>30 chars): ' + title); process.exit(1) }
const descLine = [desc, tags].filter(Boolean).join(' ')
cliLog('video: ' + video)
cliLog('title: ' + title)
cliLog('desc : ' + descLine)

// ---- CDP 注入文件（页面 JS 无法给 input[type=file] 赋值，必须走 CDP）----
const doc = await cdp('DOM.getDocument', {})
const node = await cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
if (!node.nodeId) { cliLog('file input not found — 页面未加载完成'); process.exit(1) }
await cdp('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [video] })
cliLog('file injected')

// 等编辑器出现（上传开始、表单挂载）
let editorReady = false
for (let i = 0; i < 30; i++) {
  if (await js("!!document.querySelector('.zone-container.editor-kit-container')")) { editorReady = true; break }
  await wait(2)
}
if (!editorReady) { cliLog('EDITOR_NOT_READY — 上传后表单未出现'); process.exit(1) }

// ---- 填标题（React 受控 input：原生 setter + input 事件）----
const fillTitle = await js(`(() => {
  const el = [...document.querySelectorAll('input.semi-input')].find(i => (i.placeholder || '').includes('作品标题'))
    || document.querySelectorAll('input.semi-input')[0]
  if (!el) return 'no-title-input'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, ${JSON.stringify(title)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()`)
cliLog('fill title: ' + fillTitle)

// ---- 填描述+话题（contenteditable 富文本：execCommand insertText）----
const fillDesc = await js(`(() => {
  const el = document.querySelector('.zone-container.editor-kit-container')
  if (!el) return 'no-editor'
  el.focus()
  document.execCommand('insertText', false, ${JSON.stringify(descLine)})
  return 'ok'
})()`)
cliLog('fill desc: ' + fillDesc)
await wait(2)

// 回读校验
const check = await js(`(() => ({
  title: ([...document.querySelectorAll('input.semi-input')].find(i => (i.placeholder || '').includes('作品标题')) || {}).value || '',
  desc: (document.querySelector('.zone-container.editor-kit-container') || {}).innerText || ''
}))()`)
if (!check.title) { cliLog('TITLE_NOT_SET — 回读为空，中止'); process.exit(1) }
cliLog('verify title: ' + check.title)
cliLog('verify desc : ' + String(check.desc).slice(0, 80))

// ---- 等内容安全检测（"检测中"消失，最长 120s）----
let checkDone = false
for (let i = 0; i < 40; i++) {
  if (!(await js('document.body.innerText.includes("检测中")'))) { checkDone = true; break }
  await wait(3)
}
cliLog('content check ' + (checkDone ? 'done' : 'timeout (continuing)'))

const st = await js(`(() => ({
  publishBtn: !!([...document.querySelectorAll('button')].find(b => b.innerText.trim() === '发布' && !b.disabled)),
  err: [...document.querySelectorAll('[class*=error],[class*=Error]')].map(e => e.innerText.trim()).filter(Boolean).slice(0, 3)
}))()`)
cliLog('state: ' + JSON.stringify(st))
if (!st.publishBtn) { cliLog('PUBLISH_BUTTON_UNAVAILABLE — 请人工检查 ego lite 页面'); process.exit(1) }

if (hasFlag('--dry-run') || hasFlag('--dry_run') || P.dry_run === true) { cliLog('DRYRUN_OK — 全部前置就绪，未点击发布'); process.exit(0) }

// ---- 发布 ----
await js(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '发布' && !x.disabled); if (b) b.click(); return !!b })()`)
cliLog('publish clicked')

let published = false
for (let i = 0; i < 20; i++) {
  await wait(3)
  if (String(await js('location.href')).includes('content/manage')) { published = true; break }
}
if (!published) { cliLog('PUBLISH_UNCONFIRMED — 未跳转到作品管理页，请人工确认'); process.exit(1) }
await wait(2)
const confirm = await js('document.body.innerText.includes("发布成功")')
cliLog(confirm ? 'PUBLISH_SUCCESS — 视频已发布' : 'PUBLISH_REDIRECT_OK — 已到作品管理页，请人工确认')