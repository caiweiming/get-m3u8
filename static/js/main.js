Vue.createApp({
    data() {
        return {
            currTask: {}, // 正在处理的任务
            tasks: [], // 任务队列
            rangeDownload: { // 特定范围下载
                isShowRange: false, // 是否显示范围下载
                startSegment: 1, // 起始片段
                endSegment: '', // 截止片段
            },
            paste: true, // 是否监听粘贴内容
            isCheckedAll: false, // 是否全选
            urlError: false, // 地址错误
            url: '', // 在线链接
            title: '', // 视频标题
            segment: {}, // 视频片段
            isSupperStreamWrite: window.streamSaver && !window.streamSaver.useBlobFallback, // 当前浏览器是否支持流式下载
            type: 'TS', // 保存格式
            stream: false, //  是否视频流下载
            dp: null, // DPlayer
            loadingIndex: null,
            messageList: {}, // 消息列表
            modalList: {
                'modal-add': {},
                'modal-setting': {},
                'modal-segment': {},
                'modal-range': {},
                'modal-player': {},
                'modal-help': {},
            },
        }
    },
    created() {
        // 监听粘贴事件
        document.addEventListener('paste', this.onPaste);
        this.getUrl();
    },
    beforeDestroy() {
        // 移除监听
        document.removeEventListener('paste', this.onPaste);
    },
    computed: {
        // 获取进度百分比
        getProgress() {
            return (item) => {
                if (item.rangeDownload && item.rangeDownload.targetSegment) {
                    return (item.finishNum / item.rangeDownload.targetSegment * 100).toFixed(2);
                } else {
                    return 0.00;
                }
            };
        },
        isChecked() {
            return this.tasks.some(item => item.checked);
        },
        isAllChecked() {
            this.isCheckedAll = this.tasks.every(item => item.checked);
            return this.isCheckedAll;
        }
    },
    methods: {
        // 全选/反选
        checkAll() {
            this.isCheckedAll = !this.isCheckedAll;
            this.tasks.forEach(item => {
                item['checked'] = this.isCheckedAll;
            });
        },
        // 获取地址栏参数
        getUrl() {
            let { href } = location
            if (href.indexOf('?source=') > -1 || href.indexOf('&source=') > -1) {
                this.url = href.split('source=')[1];
                if (this.url) {
                    this.rangeDownload.isShowRange = false;
                    this.rangeDownload.startSegment = 1;
                    this.rangeDownload.endSegment = '';
                    this.getTitle();
                    this.create(false);
                }
            }
        },
        // 新建下载窗口
        add() {
            this.url = '';
            this.title = '';
            this.rangeDownload.isShowRange = false;
            this.rangeDownload.startSegment = 1;
            this.rangeDownload.endSegment = '';
            this.showModal('modal-add');
            // 自动获取焦点
            this.$nextTick(() => {
                this.$refs.url.focus();
            });
        },
        // 设置下载范围
        setRange() {
            // 判断是否正在下载索引
            if (this.loadingIndex !== null) {
                return;
            }

            if (!this.url) {
                this.error('请输入m3u8地址');
                return;
            }
            this.create(true);
        },
        // 开始范围下载
        getRange() {
            this.closeModal('modal-range');
            this.create();
        },
        // 获取地址栏标题
        getTitle() {
            if (!this.url) {
                return;
            }
            try {
                let targetUrl = new URL(this.url);
                this.title = targetUrl.searchParams.get('title') || this.formatTime(new Date(), 'YYYY_MM_DD hh_mm_ss');
            } catch (e) {
                this.title = '';
            }
        },
        // 创建下载任务
        create(onlyGetRange) {
            this.url = this.url.trim();
            this.urlError = false;
            if (!this.url) {
                this.error('请输入m3u8地址');
                this.urlError = true;
                return;
            }

            // 判断是否正在下载索引
            if (this.loadingIndex !== null) {
                return;
            }

            // 链接对象
            let targetUrl;
            try {
                targetUrl = new URL(this.url);
            } catch (e) {
                this.error('M3U8链接格式错误，请重新输入');
                return;
            }

            // 判断targetUrl中是否包含_ignore参数
            if (targetUrl.searchParams.has('_ignore')) {
                let ignores = targetUrl.searchParams.get('_ignore');
                ignores = ignores.split(',');
                // 将匹配到的ignore参数从url中去除掉
                targetUrl.searchParams.delete('_ignore');
                // 循环ignores中的每个参数，并且从url中去掉
                ignores.forEach((ignore) => {
                    targetUrl.searchParams.delete(ignore);
                })
                this.url = targetUrl.href;
            }

            // 开始时间
            this.beginTime = new Date();

            // 获取m3u8文件
            let loading = this.loading('正在下载 m3u8 文件，请稍后...');
            this.loadingIndex = loading;
            this.ajax({
                url: this.url,
                success: (m3u8Str) => {
                    this.loading(false, loading);

                    if (m3u8Str.substring(0, 7).toUpperCase() !== '#EXTM3U') {
                        this.error('无效的 m3u8 链接');
                        return;
                    }

                    if (!this.rangeDownload.isShowRange) {
                        this.closeModal('modal-add');
                    }

                    // 创建新任务
                    const task = {
                        id: 't_' + this.randomNum(),
                        url: this.url, // M3U8链接
                        title: this.title, // 保存标题
                        type: this.type, // 保存格式:TS,MP4
                        stream: this.stream, // 是否文件流下载
                        checked: false, // 是否选中
                        status: 'ready', // 状态: ready-准备就绪,pause-暂停,downloading-下载中,done-完成,wait-等待中
                        finishList: [], // 下载完成项目
                        tsUrlList: [], // ts URL数组
                        requests: [], // ts请求数组
                        mediaFileList: [], // 下载的媒体数组
                        downloadIndex: 0, // 当前下载片段
                        downloading: false, // 是否下载中
                        durationSecond: 0, // 视频持续时长
                        beginTime: this.beginTime, // 开始下载的时间
                        errorNum: 0, // 错误数
                        finishNum: 0, // 已下载数
                        retryNum: 3, // 重试次数
                        retryCountdown: 0, // 重试倒计时,秒
                        streamWriter: this.stream ? window.streamSaver.createWriteStream(`${this.title}.${this.type === 'MP4' ? 'mp4' : 'ts'}`).getWriter() : null, // 文件流写入器
                        streamDownloadIndex: 0, // 文件流写入器，正准备写入第几个视频片段
                        rangeDownload: { // 特定范围下载
                            isShowRange: this.rangeDownload.isShowRange, // 是否显示范围下载
                            startSegment: this.rangeDownload.startSegment, // 起始片段
                            endSegment: this.rangeDownload.endSegment, // 截止片段
                            targetSegment: 1, // 待下载片段
                        },
                        aesConf: { // AES 视频解密配置
                            method: '', // 加密算法
                            uri: '', // key 所在文件路径
                            iv: '', // 偏移值
                            key: '', // 秘钥
                            decryption: null, // 解码器对象
                            stringToBuffer: function (str) {
                                return new TextEncoder().encode(str)
                            },
                        },
                    }

                    // 提取 ts 视频片段地址和计算时长
                    m3u8Str.split('\n').forEach((str) => {
                        if (/^[^#]/.test(str)) {
                            task.tsUrlList.push(this.applyURL(str, task.url))
                            task.finishList.push({
                                title: str,
                                status: ''
                            });
                        }
                    });

                    // 仅获取视频片段数
                    if (true === onlyGetRange) {
                        this.rangeDownload.isShowRange = true;
                        this.rangeDownload.endSegment = task.tsUrlList.length;
                        this.rangeDownload.targetSegment = task.tsUrlList.length;
                        this.showModal('modal-range');
                        return;
                    } else {
                        let startSegment = Math.max(task.rangeDownload.startSegment || 1, 1); // 最小为 1
                        let endSegment = Math.max(task.rangeDownload.endSegment || task.tsUrlList.length, 1);
                        startSegment = Math.min(startSegment, task.tsUrlList.length); // 最大为 this.tsUrlList.length
                        endSegment = Math.min(endSegment, task.tsUrlList.length);
                        task.rangeDownload.startSegment = Math.min(startSegment, endSegment);
                        task.rangeDownload.endSegment = Math.max(startSegment, endSegment);
                        task.rangeDownload.targetSegment = task.rangeDownload.endSegment - task.rangeDownload.startSegment + 1;
                        task.downloadIndex = task.rangeDownload.startSegment - 1;
                    }

                    // 获取需要下载的 MP4 视频长度
                    let infoIndex = 0
                    m3u8Str.split('\n').forEach(item => {
                        if (item.toUpperCase().indexOf('#EXTINF:') > -1) { // 计算视频总时长，设置 mp4 信息时使用
                            infoIndex++
                            if (task.rangeDownload.startSegment <= infoIndex && infoIndex <= task.rangeDownload.endSegment) {
                                task.durationSecond += parseFloat(item.split('#EXTINF:')[1])
                            }
                        }
                    });

                    // 检测视频 AES 加密
                    if (m3u8Str.indexOf('#EXT-X-KEY') > -1) {
                        task.aesConf.method = (m3u8Str.match(/(.*METHOD=([^,\s]+))/) || ['', '', ''])[2];
                        task.aesConf.uri = (m3u8Str.match(/(.*URI="([^"]+))"/) || ['', '', ''])[2];
                        task.aesConf.iv = (m3u8Str.match(/(.*IV=([^,\s]+))/) || ['', '', ''])[2];
                        task.aesConf.iv = task.aesConf.iv ? task.aesConf.stringToBuffer(task.aesConf.iv) : '';
                        task.aesConf.uri = this.applyURL(task.aesConf.uri, task.url);

                        this.getAES(task);
                    } else if (task.tsUrlList.length > 0) {
                        // 加入任务列表
                        this.addTask(task);
                        // 如果视频没加密，则直接下载片段，否则先下载秘钥
                        this.downloadTS();
                    } else {
                        this.error('资源为空，请查看链接是否有效');
                        this.closeModal('modal-add');
                    }
                },
                fail: () => {
                    this.loading(false, loading);
                    this.error('m3u8链接不正确，请查看链接是否有效，或重试!');
                    this.closeModal('modal-add');
                }
            })
        },
        // 加入任务
        addTask(task) {
            this.tasks.unshift(task);

            if (this.currTask && this.currTask.status === 'downloading') {
                console.log('当前任务正在下载，跳过')
                return;
            }

            this.currTask = this.tasks[0];
        },
        // 显示片段窗口
        showSegment(item) {
            this.segment = item;
            this.showModal('modal-segment');
        },
        // 打开窗口
        showModal(id) {
            this.paste = false;
            this.modalList[id] = {
                show: true,
                showing: true,
                closing: false
            }
            setTimeout(() => {
                this.modalList[id].showing = false;
            }, 500);
        },
        // 关闭窗口
        closeModal(id) {
            if (id !== 'modal-player' && id !== 'modal-range') {
                this.paste = true;
            }
            this.modalList[id].closing = true;
            setTimeout(() => {
                this.modalList[id].show = false;
                this.modalList[id].closing = false;
            }, 500);
        },
        // 显示全局提示
        message(msg, type, duration = 3000) {
            type = type || 'info';
            msg = msg || '';

            let key = 'm-' + this.randomNum();
            this.messageList[key] = {type: type, content: msg, appear: true, leave: false};
            setTimeout(() => {
                if (this.messageList[key]) {
                    this.messageList[key].appear = false;
                }
            }, 500);
            if (duration) {
                setTimeout(() => {
                    if (this.messageList[key]) {
                        this.messageList[key].leave = true;
                    }
                }, duration);
                setTimeout(() => {
                    delete this.messageList[key];
                }, duration + 500);
            }
            if (type === 'loading') {
                return key;
            }
        },
        success(msg) {
            this.message(msg, 'success', 2000);
        },
        error(msg) {
            this.message(msg, 'error');
        },
        info(msg) {
            this.message(msg, 'info');
        },
        warning(msg) {
            this.message(msg, 'warning');
        },
        loading(msg, key) {
            if (false === msg) {
                this.messageList[key].leave = true;
                setTimeout(() => {
                    delete this.messageList[key];
                    this.loadingIndex = null;
                }, 500);
            } else {
                return this.message(msg, 'loading', 0);
            }
        },
        randomNum: function () {
            return Math.floor(Math.random() * (999999 - 2)) + 1;
        },
        // ajax 请求
        ajax(options) {
            options = options || {};
            let xhr = new XMLHttpRequest();
            if (options.type === 'file') {
                xhr.responseType = 'arraybuffer';
            }

            // 添加一个用于存储xhr对象的属性
            options.xhr = xhr;

            xhr.onreadystatechange = function () {
                if (xhr.readyState === 4) {
                    let status = xhr.status;
                    if (status >= 200 && status < 300) {
                        options.success && options.success(xhr.response);
                    } else {
                        options.fail && options.fail(status);
                    }
                }
            };

            xhr.open("GET", options.url, true);
            xhr.send(null);
            return xhr;
        },
        // 拷贝剪切板
        copyToClipboard(content) {
            if (!document.queryCommandSupported('copy')) {
                return false
            }

            let $input = document.createElement('textarea')
            $input.style.opacity = '0'
            $input.value = content
            document.body.appendChild($input)
            $input.select()

            const result = document.execCommand('copy')
            document.body.removeChild($input)
            $input = null

            this.success('复制成功');
            return result;
        },
        // 合成URL
        applyURL(targetURL, baseURL) {
            baseURL = baseURL || location.href
            if (targetURL.indexOf('http') === 0) {
                // 当前页面使用 https 协议时，强制使 ts 资源也使用 https 协议获取
                if (location.href.indexOf('https') === 0) {
                    return targetURL.replace('http://', 'https://')
                }
                return targetURL
            } else if (targetURL[0] === '/') {
                let domain = baseURL.split('/')
                return domain[0] + '//' + domain[2] + targetURL
            } else {
                let domain = baseURL.split('/')
                domain.pop()
                return domain.join('/') + '/' + targetURL
            }
        },
        // 获取AES配置
        getAES(task) {
            // alert('视频被 AES 加密，点击确认，进行视频解码')
            let loading = this.loading('正在获取视频解密信息...');
            this.ajax({
                type: 'file',
                url: task.aesConf.uri,
                success: (key) => {
                    // this.aesConf.key = this.aesConf.stringToBuffer(key)
                    task.aesConf.key = key;
                    task.aesConf.decryption = new AESDecryptor();
                    task.aesConf.decryption.constructor();
                    task.aesConf.decryption.expandKey(task.aesConf.key);
                    // 加入任务列表
                    this.addTask(task);
                    this.downloadTS();
                    this.loading(false, loading);
                },
                fail: () => {
                    this.loading(false, loading);
                    this.error('视频解密失败')
                }
            })
        },
        // 下载分片
        downloadTS() {
            // 设置为下载中
            this.currTask.status = 'downloading';

            let download = () => {
                // 使用另一个变量来保持下载前的暂停状态，避免回调后没修改
                let isPause = this.currTask.status === 'pause';
                let index = this.currTask.downloadIndex;
                if (index >= this.currTask.rangeDownload.endSegment) {
                    return
                }
                if (isPause) {
                    return;
                }
                this.currTask.downloadIndex++
                if (this.currTask.finishList[index] && this.currTask.finishList[index].status === '') {
                    this.currTask.finishList[index].status = 'is-downloading'
                    let request = this.ajax({
                        url: this.currTask.tsUrlList[index],
                        type: 'file',
                        success: (file) => {
                            this.dealTS(file, index, () => this.currTask.downloadIndex < this.currTask.rangeDownload.endSegment && !isPause && download())
                        },
                        fail: () => {
                            this.currTask.errorNum++;
                            this.currTask.finishList[index].status = 'is-error';
                            if (this.currTask.downloadIndex < this.currTask.rangeDownload.endSegment) {
                                !isPause && download()
                            } else if (this.currTask.finishNum + this.currTask.errorNum === this.currTask.rangeDownload.targetSegment) {
                                this.togglePause(this.currTask, true)
                            }
                        }
                    });
                    this.currTask.requests.push(request);
                } else if (this.currTask.downloadIndex < this.currTask.rangeDownload.endSegment) { // 跳过已经成功的片段
                    !isPause && download()
                }
            }

            // 建立多少个 ajax 线程
            for (let i = 0; i < Math.min(6, this.currTask.rangeDownload.targetSegment - this.currTask.finishNum); i++) {
                download()
            }
        },
        // 处理 ts 片段，AES 解密、mp4 转码
        dealTS(file, index, callback) {
            const data = this.currTask.aesConf.uri ? this.aesDecrypt(file, index) : file;
            // mp4 转码
            this.conversionMp4(data, index, (afterData) => {
                // 判断文件是否需要解密
                this.currTask.mediaFileList[index - this.currTask.rangeDownload.startSegment + 1] = afterData;
                this.currTask.finishList[index].status = 'is-success';
                this.currTask.finishNum++;
                if (this.currTask.streamWriter) {
                    for (let index = this.currTask.streamDownloadIndex; index < this.currTask.mediaFileList.length; index++) {
                        if (this.currTask.mediaFileList[index]) {
                            this.currTask.streamWriter.write(new Uint8Array(this.currTask.mediaFileList[index]));
                            this.currTask.mediaFileList[index] = null;
                            this.currTask.streamDownloadIndex = index + 1;
                        } else {
                            break;
                        }
                    }
                    if (this.currTask.streamDownloadIndex >= this.currTask.rangeDownload.targetSegment) {
                        this.currTask.status = 'done';
                        this.currTask.requests = [];
                        this.currTask.streamWriter.close();
                        this.nextTask();
                    }
                } else if (this.currTask.finishNum === this.currTask.rangeDownload.targetSegment) {
                    this.currTask.status = 'done';
                    this.currTask.requests = [];
                    this.nextTask();
                    this.downloadFile(this.currTask.mediaFileList, this.currTask.title);
                } else if (this.currTask.finishNum + this.currTask.errorNum === this.currTask.rangeDownload.targetSegment) {
                    this.togglePause(this.currTask, true);
                }
                callback && callback()
            })
        },
        // ts 片段的 AES 解码
        aesDecrypt(data, index) {
            let iv = this.currTask.aesConf.iv || new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, index]);
            return this.currTask.aesConf.decryption.decrypt(data, 0, iv.buffer || iv, true);
        },
        // 转码为 mp4
        conversionMp4(data, index, callback) {
            if (this.currTask.type === 'MP4') {
                let transMuxer = new muxjs.Transmuxer({
                    keepOriginalTimestamps: true,
                    duration: parseInt(this.currTask.durationSecond),
                });
                transMuxer.on('data', segment => {
                    if (index === this.currTask.rangeDownload.startSegment - 1) {
                        let data = new Uint8Array(segment.initSegment.byteLength + segment.data.byteLength);
                        data.set(segment.initSegment, 0);
                        data.set(segment.data, segment.initSegment.byteLength);
                        callback(data.buffer)
                    } else {
                        callback(segment.data)
                    }
                })
                transMuxer.push(new Uint8Array(data));
                transMuxer.flush();
            } else {
                callback(data)
            }
        },
        // 格式化时间
        formatTime(date, formatStr) {
            const formatType = {
                Y: date.getFullYear(),
                M: date.getMonth() + 1,
                D: date.getDate(),
                h: date.getHours(),
                m: date.getMinutes(),
                s: date.getSeconds(),
            }
            return formatStr.replace(
                /Y+|M+|D+|h+|m+|s+/g,
                target => (new Array(target.length).join('0') + formatType[target[0]]).substr(-target.length)
            )
        },
        // 下载整合后的TS文件
        downloadFile(fileDataList, fileName) {
            this.success('视频整合中，请留意浏览器下载!');
            let fileBlob = null
            let a = document.createElement('a')
            if (this.currTask.type === 'MP4') {
                fileBlob = new Blob(fileDataList, {type: 'video/mp4'}) // 创建一个Blob对象，并设置文件的 MIME 类型
                a.download = fileName + '.mp4'
            } else {
                fileBlob = new Blob(fileDataList, {type: 'video/MP2T'}) // 创建一个Blob对象，并设置文件的 MIME 类型
                a.download = fileName + '.ts'
            }
            a.href = URL.createObjectURL(fileBlob)
            a.style.display = 'none'
            document.body.appendChild(a)
            a.click()
            a.remove();
        },
        // 暂停与恢复
        togglePause(task, retry = false) {
            if (this.currTask.id === task.id) {
                // 当前任务
                this.currTask.status = this.currTask.status === 'pause' ? 'downloading' : 'pause';
                if (this.currTask.status === 'pause') {
                    this.abortRequest(this.currTask, () => {
                        if (retry === true && this.currTask.retryNum) {
                            this.currTask.retryNum--;
                            this.currTask.retryCountdown = 3;

                            let countdown = setInterval(() => {
                                this.currTask.retryCountdown--;
                                if (this.currTask.retryCountdown === 0) {
                                    clearInterval(countdown);
                                    this.currTask.status = 'downloading';
                                    this.retryAll(true);
                                }
                            }, 1000);
                        } else {
                            this.nextTask();
                        }
                    });
                } else {
                    this.retryAll(true);
                }
            } else {
                // 切换任务
                if (task.status === 'pause') {
                    if (this.currTask.status === 'downloading') {
                        // 有其他任务正在下载,设置当前任务进入等待
                        task.status = 'ready';
                    } else {
                        // 执行当前任务
                        this.currTask = task;
                        this.currTask.status = 'downloading';
                        this.retryAll(true);
                    }
                }
            }
        },
        // 重新下载某个片段
        retry(index) {
            if (this.currTask.finishList[index].status === 'is-error') {
                if (this.currTask.id && this.currTask.id !== this.segment.id && this.currTask.status === 'downloading') {
                    this.error('当前有其他任务正在执行，无法重试');
                    return;
                }

                this.currTask = this.segment;
                this.currTask.finishList[index].status = 'is-downloading';
                this.ajax({
                    url: this.currTask.tsUrlList[index],
                    type: 'file',
                    success: (file) => {
                        this.currTask.errorNum--;
                        this.dealTS(file, index);
                    },
                    fail: () => {
                        this.currTask.finishList[index].status = 'is-error'
                    }
                })
            }
        },
        // 重新下载所有错误片段
        retryAll(forceRestart) {
            if (!this.currTask.finishList.length || this.currTask.status === 'pause') {
                return
            }

            let firstErrorIndex = this.currTask.downloadIndex // 没有错误项目，则每次都递增
            this.currTask.finishList.forEach((item, index) => { // 重置所有错误片段状态
                if (item.status === 'is-error') {
                    item.status = ''
                    firstErrorIndex = Math.min(firstErrorIndex, index)
                }
            })
            this.currTask.errorNum = 0;
            // 已经全部下载进程都跑完了，则重新启动下载进程
            if (this.currTask.downloadIndex >= this.currTask.rangeDownload.endSegment || forceRestart) {
                this.currTask.downloadIndex = firstErrorIndex;
                this.downloadTS();
            } else { // 否则只是将下载索引，改为最近一个错误的项目，从那里开始遍历
                this.currTask.downloadIndex = firstErrorIndex
            }
        },
        // 强制下载现有片段
        forceDownload() {
            if (this.currTask.mediaFileList.length) {
                this.downloadFile(this.currTask.mediaFileList, this.currTask.title);
            } else {
                this.error('当前无已下载片段');
            }
        },
        // 删除任务
        deleteTask(index) {
            if (index >= 0) {
                let task = this.tasks[index];
                this.abortRequest(task, () => {
                    this.tasks.splice(index, 1);
                    if (this.currTask && this.currTask.id === task.id) {
                        this.currTask.streamWriter && this.currTask.streamWriter.close();
                        this.nextTask();
                    }
                });
            } else {
                let taskIds = [];
                this.tasks = this.tasks.filter(task => {
                    if (task.checked) {
                        this.abortRequest(task);
                        taskIds.push(task.id);
                    } else {
                        return true;
                    }
                });

                if (this.currTask && taskIds.includes(this.currTask.id)) {
                    this.currTask.streamWriter && this.currTask.streamWriter.close();
                    this.nextTask();
                }
            }
        },
        // 终止请求
        abortRequest(task, callback) {
            if (task.requests && task.requests.length) {
                task.status = 'pause';
                for (let i = task.requests.length - 1; i >= 0; i--) {
                    if (task.requests[i].readyState !== 4) {
                        task.requests[i].abort();
                    }
                    task.requests.splice(i, 1);
                }
            }
            callback && callback();
        },
        // 开启下一个可执行任务
        nextTask() {
            for (let i = this.tasks.length - 1; i >= 0; i--) {
                if (this.tasks[i].status === 'ready') {
                    this.currTask = this.tasks[i];
                    this.currTask.status = 'downloading';
                    this.retryAll(true);
                    break;
                }
            }
        },
        // 监听页面粘贴事件
        onPaste(event) {
            if (this.paste) {
                // 处理粘贴的内容
                this.url = event.clipboardData.getData('text');
                this.rangeDownload.isShowRange = false;
                this.rangeDownload.startSegment = 1;
                this.rangeDownload.endSegment = '';
                this.getTitle();
                this.create(false);
            }
        },
        // 批量开启下载
        start() {
            for (let i = this.tasks.length - 1; i >= 0; i--) {
                if (this.tasks[i].checked) {
                    if (this.currTask && this.currTask.status === 'downloading' && this.currTask.id !== this.tasks[i].id) {
                        this.tasks[i].status = 'ready';
                    } else {
                        this.currTask = this.tasks[i];
                        this.currTask.status = 'downloading';
                        this.retryAll(true);
                    }
                }
            }
        },
        // 批量暂停下载
        pause() {
            let taskIds = [];
            this.tasks.forEach(task => {
                if (task.checked) {
                    this.abortRequest(task);
                    task.status = 'pause';
                    taskIds.push(task.id);
                }
            });
            if (this.currTask && taskIds.includes(this.currTask.id)) {
                this.nextTask();
            }
        },
        // 播放视频
        play(url) {
            if (!url) {
                this.error('请输入m3u8地址');
                return;
            }
            this.showModal('modal-player');
            this.dp = new DPlayer({
                container: document.getElementById('player'),
                autoplay: true,
                airplay: false,
                video: {
                    url: url,
                    type: 'hls',
                },
            });

        },
        // 关闭播放
        closePlayer() {
            this.closeModal('modal-player');
            this.dp.destroy();
            this.dp = null;
        },
        // 格式化时长
        formatDuration(duration) {
            duration = parseInt(duration);
            const hours = Math.floor(duration / 3600);
            const minutes = Math.floor((duration % 3600) / 60);
            const seconds = duration % 60;
            return `${hours.toString().padStart(2, '0')}`
                + ':' + `${minutes.toString().padStart(2, '0')}`
                + ':' + `${seconds.toString().padStart(2, '0')}`;
        },
    }
}).mount('#app');