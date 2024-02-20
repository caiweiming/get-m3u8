## 关于
**[get-m3u8](https://getm3u8.com/)是一个免费、开源、美观的m3u8视频下载和播放工具。** 本项目的灵感来源于[m3u8-downloader](https://github.com/Momo707577045/m3u8-downloader)这个项目，也使用了这个项目的主要代码。

* **免费开源：**  本项目基于[`MIT协议`](https://github.com/caiweiming/get-m3u8?tab=MIT-1-ov-file#readme)，完全免费，并且开源。
* **简单易用：**  用户只需要输入或者粘贴`m3u8`链接，即可下载`m3u8`视频文件。
* **多种格式：**  可以保存为`TS`或者`MP4`格式。
* **边下边存：**  针对大文件下载，解决内存不足的问题。
* **范围下载：**  可以指定下载的起始和结束片段。
* **强行保存：**  无需等待视频完全下载，强行保存已下载的视频片段。
* **在线播放：**  无需下载，可以在线直接播放视频。
* **失败重试：**  任务下载失败，会自动重试3次，也可以手动重新下载某一个视频碎片。
* **界面美观：**  使用[`Ant Design`](https://github.com/ant-design/ant-design)设计语言，界面美观、操作灵活。

## 部署

本项目可以直接下载后用浏览器打开使用，也可以将本项目部署到自己的服务器上，这样就可以在手机上访问了。

## 使用
首次下载视频，点击【新建下载】按钮，在弹出的窗口有以下几个选项：

* **M3U8地址：** 必填，输入有效的`m3u8`链接。
* **保存标题：** 可选，如果`m3u8`地址中包含了`title`参数，则会自动以这个参数的值作为默认标题。
* **保存格式：** 默认保存为`TS`格式，如果下载后无法正常播放，可尝试保存为`MP4`格式。
* **边下边存：** 如果要下载的文件过大，会造成浏览器占用比较多的内存，这时可以考虑开启边下边存功能。

底部有以下三个按钮：

* **播放视频：** 可以无需下载视频，直接在线播放。
* **范围下载：** 如果想下载视频的某一段内容，可以使用该功能，点击后，输入起始片段和截止片段即可。
* **完整下载：** 完整的下载整个视频文件。

> **快捷下载：** 复制`m3u8`地址后，无需点击【新建下载】按钮，直接按`ctrl+v`，将地址粘贴到页面，即可快速添加下载任务。

## 贡献

如果你有好的意见或建议，欢迎提[issue](https://github.com/caiweiming/get-m3u8)或[pull request](https://github.com/caiweiming/get-m3u8/pulls)。

##  致谢

* **[m3u8-downloader](https://github.com/Momo707577045/m3u8-downloader)** 提供了大部分核心代码。
* **[Ant Design](https://github.com/ant-design/ant-design)** 提供了美观的界面。
* **[vue](https://cn.vuejs.org/)** 提供了前端框架。
* **[DPlayer](https://github.com/DIYgod/DPlayer)** 提供了视频播放功能。
* ...

## 联系

* **Email：** getm3u8@163.com
* **Github：** [https://github.com/caiweiming/get-m3u8](https://github.com/caiweiming/get-m3u8)

## 许可

本项目基于[`MIT协议`](https://github.com/caiweiming/get-m3u8?tab=MIT-1-ov-file#readme)开源，请自由地享受和参与开源。
