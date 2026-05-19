# DS 视频下载器

一款 Chrome MV3 浏览器扩展，支持下载 HLS/DASH 流媒体视频及直链媒体文件。

> [English version](README.md)

## 工作原理

扩展自动检测页面中的媒体资源，将下载请求发送至本地 Node.js 助手服务。针对 HLS（`.m3u8`）和 DASH（`.mpd`）流，助手调用 `ffmpeg` 完成下载与封装；直链文件（`.mp4`、`.webm` 等）则通过 Chrome 内置下载 API 处理。

## 环境要求

| 组件 | 要求 |
|-----------|-------------|
| 浏览器 | Chrome 或基于 Chromium 的浏览器（Edge、Brave、Arc） |
| 运行时 | [Node.js](https://nodejs.org/) 20 及以上版本 |
| FFmpeg | [ffmpeg](https://ffmpeg.org/download.html) 已安装并加入 PATH 环境变量 |

## 安装指南

### 1. 加载扩展

1. 打开 `chrome://extensions/`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本项目所在目录
5. 工具栏将出现 DS 扩展图标

### 2. 启动助手

```powershell
npm run helper
```

助手控制台地址：[http://127.0.0.1:8765](http://127.0.0.1:8765)。可在此查看下载进度、ffmpeg 运行状态及修改下载目录。

### 助手管理

```powershell
npm run helper:status    # 查看助手运行状态
npm run helper:stop      # 停止助手
npm run helper:restart   # 重启助手
```

## 使用方法

1. 浏览包含视频内容的网页
2. 点击工具栏中的 DS 视频下载器图标
3. 弹窗列出所有检测到的媒体 — 点击文件开始下载
4. HLS 流媒体可选择画质变体（1080p、720p 等）
5. 在助手控制台或弹窗中实时监控下载进度

## 配置

通过助手控制台或手动创建 `helper/helper-settings.json` 来设置下载目录：

```json
{
  "downloadDir": "C:\\你的路径\\下载目录"
}
```

默认保存至项目目录下的 `helper/downloads/`。

## 支持格式

- 直链媒体：`.mp4`、`.webm`、`.mkv`、`.avi`、`.mov`、`.mp3`、`.m4a`、`.flac` 等
- HLS 流：`.m3u8` 播放列表，支持画质变体选择
- DASH 流：`.mpd` 清单文件
- 自动检测 `<video>`、`<audio>`、`<source>`、`<a>` 元素中的媒体资源
- 携带 Cookie/Header 转发，支持需登录的流媒体

## 不支持

- DRM 保护流（Widevine、FairPlay、PlayReady）
- 需付费账号才能访问的付费内容
- Cloudflare 或反爬虫拦截页面
- YouTube 等通过私有 API 提供媒体服务的网站

## 安全说明

助手默认绑定 `127.0.0.1` —— 仅限本机访问。**切勿**将其暴露至公网。本地访问无需认证。所有下载操作仅在本地执行，不向任何第三方传输数据。

## 参与贡献

欢迎提交 Bug 报告与 Pull Request。提交前请通过测试套件验证：

```powershell
npm test
```

## 许可证

MIT — 详见 [LICENSE](LICENSE)
