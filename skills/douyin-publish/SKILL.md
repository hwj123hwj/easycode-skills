---
name: douyin-publish
description: 通过 ego lite 浏览器（ego-browser）自动发布视频到抖音：上传文件、填标题/描述/话题、等待内容检测、点击发布并核实结果。当用户要发抖音/上传抖音视频/用 egolite 操作抖音时使用。前置：ego lite 已运行；未登录时脚本会截图二维码并引导扫码。
---

# douyin-publish（ego lite 通道）

## 目标

用 ego lite 自带的 `ego-browser` 运行时，一条命令完成"视频上传抖音 + 填发布信息 + 发布 + 核实"，替代依赖 uv/patchright/Chromium 的旧 douyin-upload 技能。

## 何时用

用户要求"发抖音 / 上传抖音视频 / 发布到抖音"，且机器装有 ego lite（`/Applications/ego lite.app`，CLI 在 `~/.local/bin/ego-browser`）。

## 关键约束（实测结论，勿绕过）

- `ego-browser nodejs` **只接受 stdin 脚本或单个源文件**，不收额外 CLI 参数
- **不继承 shell 环境变量**（process.env 只有运行时内置项）
- 页面 JS 无法给 `input[type=file]` 赋值，必须走 CDP `DOM.setFileInputFiles`
- 因此参数统一走 **JSON 文件**，wrapper 用 sed 注入脚本后经 stdin 执行

## 工作流

### 0. 健康检查（无副作用，先跑这个）

```bash
~/.easycode-user/skills/douyin-publish/scripts/douyin_publish.sh --healthcheck
```

输出 `HEALTHCHECK_PASS` 即登录态可用；`NOT_LOGGED_IN` 时脚本截图二维码到 /tmp/douyin_login_qr.png 并等 180s，提示用户扫码。

### 1. 发布

```bash
cat > /tmp/douyin_params.json <<'EOF'
{
  "video": "/path/to/视频.mp4",
  "title": "标题（≤30字）",
  "desc": "描述文案",
  "tags": ["标签1", "标签2"]
}
EOF
~/.easycode-user/skills/douyin-publish/scripts/douyin_publish.sh --params /tmp/douyin_params.json
```

成功标志：`PUBLISH_SUCCESS`（页面出现"发布成功"）或 `PUBLISH_REDIRECT_OK`（已跳转作品管理页）。之后可到 ego lite 的作品管理页人工核实。

### 2. 演练（不点发布，但会真实注入文件到表单）

```bash
~/.easycode-user/skills/douyin-publish/scripts/douyin_publish.sh --params /tmp/douyin_params.json --dry-run
```

输出 `DRYRUN_OK` 表示发布按钮可用、内容检测通过。

### 3. 发布前与用户确认发布信息

标题/描述/标签先给用户看一眼再执行；用户已给全参数时可直接发。

## 参数（JSON 文件字段）

| 字段 | 必填 | 说明 |
|---|---|---|
| video | 发布时必填 | 视频绝对路径 |
| title | 发布时必填 | ≤30 字，超长脚本拒绝 |
| desc | 可选 | 描述文案 |
| tags | 可选 | 字符串数组，自动加 `#` |

退出码：0 成功；1 失败；2 未登录/扫码超时。

## 实现要点（改脚本前必读）

- **标题是 React 受控 input**：用 `HTMLInputElement.prototype.value` 原生 setter + 派发 `input` 事件，直接赋值不生效
- **描述是 contenteditable 富文本**：focus 后 `document.execCommand('insertText')`
- **发布按钮精确匹配文本 `发布` 且 `!disabled`**：页面有"发布暂存离开"等相似按钮，勿模糊匹配
- **必须等"检测中"消失再点发布**（平台内容安全检测，实测几秒~几十秒）
- **任务空间所有权**：用户可能中途在 ego lite 接管过空间，脚本按 useOrCreateTaskSpace → takeOverTaskSpace → claimTaskSpace 降级获取
- **成功核实双重**：跳转 content/manage + 出现"发布成功"
- wrapper 里 sed 的匹配锚点是 JS 源码中的 `const PARAMS_FILE = ` 与 `const argv = process.argv.slice(2)` 两行，改 JS 时别动这两行写法

## 故障排查

- `ego-browser: command not found` → 运行 ego lite 一次；或看 ego lite 内置技能 ego-browser 的 references/install.md
- 卡 NOT_LOGGED_IN → 确认 ego lite 窗口显示抖音登录页；扫码后手机若要短信验证按提示完成
- `file input not found` → 上传页未加载完，重跑
- `PUBLISH_UNCONFIRMED` → 去 ego lite 看页面，可能弹人工验证
- 首次登录等扫码可能跑 3 分钟，建议 run_in_background
