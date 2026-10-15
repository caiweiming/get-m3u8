# M3U8下载

[M3U8下载](https://getm3u8.com/) 是一个运行在浏览器中的 HLS（m3u8）下载与预览工具。无需安装客户端，也不需要后端服务；解析、下载、合并和保存均在本地浏览器内完成。

## 功能

- 解析媒体播放列表与多清晰度播放列表，可选择分辨率。
- 支持在线预览播放，以及可用的外部音轨和 WebVTT 字幕选择。
- 支持 AES-128 加密分片解密。
- 默认稳定下载仅支持普通 MPEG-TS 分片的 HLS 和 TS 输出，保留连续前缀强制合并。
- 支持全部下载或按真实分片序号指定下载范围。
- 页面内任务按 FIFO 顺序执行，同一时刻最多运行一个任务；单任务分片并发为 1 至 8，默认 4。
- 任务行显示当前任务速度、进度和队列位置。
- 任务只保存在当前页面内存；新开或复制标签页显示空任务列表，刷新或关闭页面会丢失未完成任务。
- 存在未完成任务时，刷新或关闭页面会触发浏览器原生确认。
- 普通下载不设置内存硬上限；超过设备自适应阈值只提示一次并继续下载，大文件建议使用实验性的边下边存。
- 支持通过 URL 参数预填下载任务，或直接粘贴 m3u8 地址创建任务。
- 深色与浅色主题、保存标题模板和默认下载参数均可在设置中调整。

## 预览

### 首页

![首页](preview/1.png)

### 新建下载任务

![新建下载任务](preview/2.png)

### 下载任务

![下载任务](preview/3.png)

### 视频预览

![视频预览](preview/4.png)

### 分片详情

![分片详情](preview/5.png)

## 部署

本项目是静态站点，可部署到 GitHub Pages、Cloudflare Pages、Netlify、Vercel 或任意静态文件服务器。

建议通过 HTTPS 访问。稳定下载路径不依赖 StreamSaver 或 Service Worker；实验模式的高级写入能力依赖浏览器支持和安全上下文。

## 使用

1. 点击“新建下载”，或将 m3u8 地址直接粘贴到页面。
2. 填写保存标题、下载范围与分片并发数，稳定模式使用普通缓存并输出 TS。
3. 若播放列表提供多种清晰度，选择所需清晰度后确认下载。
4. 在任务列表中查看单任务速度、进度、队列位置和分片状态；可暂停、继续、重试、连续前缀强制合并或删除任务。

### 快捷下载链接

可通过地址栏参数预填并创建下载任务。建议对 `source` 值进行 URL 编码：

```text
https://getm3u8.com/?source=https%3A%2F%2Fexample.com%2Fvideo.m3u8&title=demo&format=ts
```

支持的参数：

| 参数 | 说明 |
| --- | --- |
| `source` | m3u8 地址，必填。 |
| `title` | 预填保存标题。 |
| `format` | 稳定模式固定为 `ts`；`mp4` 仅在设置中开启实验功能时生效。 |
| `streamSave` | `1` 或 `true` 请求边下边存，仅在实验模式生效；稳定模式使用普通缓存。 |
| `experimental` | 旧链接兼容参数；不会单独开启实验能力，也不会绕过设置中关闭的总开关。 |
| `range` | `all` 或 `custom`；选择 `custom` 后再确认片段范围。 |
| `concurrency` | 分片并发数，范围为 `1` 至 `8`。 |
| `_ignore` | 从 `source` 内部移除指定查询参数，多个名称用逗号分隔。 |

例如，以下链接会从源地址中移除 `token` 和 `expires`：

```text
https://getm3u8.com/?source=https%3A%2F%2Fexample.com%2Fvideo.m3u8%3Ftoken%3Dabc%26expires%3D123&_ignore=token,expires
```

## 实验能力

在页面“设置”中开启“启用实验功能（非稳定）”后，开放 MP4、fMP4/CMAF（含 Byte Range）、外部音轨/字幕下载和边下边存。这些能力不承诺稳定。开关默认关闭并保存到 localStorage；存储不可用时仅在当前页面生效。

旧链接中的 `experimental=1` 或 `experimental=true` 仅保留解析兼容性，不能单独开启实验能力或绕过关闭的设置。快捷链接不会修改该开关。

稳定模式忽略 `format=mp4`、`streamSave=1` 或 `streamSave=true`，继续使用 TS 普通缓存。实验模式的外部音轨和字幕分别保存为 `.audio.m4a`、`.subtitles.vtt`，不自动合并到视频；只有外部音轨的来源，单独视频文件可能无声。

跨标签共享任务、多任务并行、页面聚合请求池和离散强制合并不再支持，实验模式也不恢复这些能力。新版启动后会静默尝试删除旧版 IndexedDB 分片数据，不迁移旧任务和下载进度。

## 使用限制

- 这是纯浏览器工具，目标播放列表、密钥、分片和字幕资源必须允许浏览器跨域访问（CORS）。
- DRM 保护内容、需要平台登录或依赖特定请求头/Cookie 的资源通常无法下载。
- 稳定模式不下载 fMP4/Byte Range 或外部轨道；预览仍可使用播放器支持的媒体结构和外部音轨、字幕。
- 实验 MP4 导出依赖浏览器内的 TS 转封装能力；遇到不兼容的编码或媒体结构时，请尝试保存为 TS。
- 普通下载的分片保存在当前页面内存；刷新、前进后退导致页面重载或关闭页面都会丢失未完成任务。
- 请仅下载你拥有访问和保存权限的内容，并遵守内容服务方的条款及适用法律。

## 贡献与反馈

欢迎通过 [Issues](https://github.com/caiweiming/get-m3u8/issues) 提交问题或建议，也可以发起 [Pull Request](https://github.com/caiweiming/get-m3u8/pulls)。

- 邮箱：support@getm3u8.com
- GitHub：https://github.com/caiweiming/get-m3u8

## 许可证

本项目的业务代码采用 [MIT License](LICENSE) 开源。

## 第三方组件与许可证

为提供浏览器兼容性，仓库随附以下第三方运行时组件；其版权及许可证归各自权利人所有，不受本项目 MIT 许可证替代。

| 组件 | 本地文件 | 版本 | 许可证 |
| --- | --- | --- | --- |
| hls.js | `vendor/hls.min.js` | 1.6.16 | Apache-2.0 |
| mux.js | `vendor/mux.min.js` | 6.3.0 | Apache-2.0 |
| StreamSaver | `vendor/streamsaver.js`、`vendor/streamsaver-mitm.html`、`vendor/sw.js` | 2.0.5 | MIT |
| Lucide | `vendor/lucide.min.js` | 0.321.0 | ISC |

相关许可声明可在对应分发文件的文件头或其上游项目中查阅。

StreamSaver 的 vendor 文件保留供实验边下边存使用；稳定路径不加载它，也不初始化其 Service Worker 流程。mux.js 仅用于实验输出。
