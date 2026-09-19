// M3U8 Downloader - Application Logic

// --- Elements ---
const heroSection = document.getElementById('hero-section');
const tasksSection = document.getElementById('tasks-section');
const taskListContainer = document.getElementById('task-list');
const aggregateDownloadSpeedElement = document.getElementById('aggregate-download-speed');
const aggregateActiveTasksElement = document.getElementById('aggregate-active-tasks');
const aggregateRequestSlotsElement = document.getElementById('aggregate-request-slots');
const modalOverlay = document.getElementById('modal-overlay');
const appLoader = document.getElementById('app-loader');
const newTaskModal = document.getElementById('new-task-modal');
const settingsModal = document.getElementById('settings-modal');
const detailsModal = document.getElementById('details-modal');
const downloadQualityModal = document.getElementById('download-quality-modal');
const downloadRangeModal = document.getElementById('download-range-modal');
const forceMergeModal = document.getElementById('force-merge-modal');
const confirmDeleteModal = document.getElementById('confirm-delete-modal');
const previewModal = document.getElementById('preview-modal');
const helpModal = document.getElementById('help-modal');
const appTooltip = document.getElementById('app-tooltip');
const modalPanels = Array.from(document.querySelectorAll('.modal-panel'));

// --- State ---
let currentTasks = [];
const selectedTaskIds = new Set();
let pendingTaskSelectionFocusId = null;
let currentTheme = localStorage.getItem('theme') || 'light';
let activeModalId = null;
let pendingModalId = null;
let isModalClosing = false;
let lastFocusedElementBeforeModal = null;
let activeTooltipTarget = null;
let activeCopiedTaskUrlId = null;
let copiedTaskUrlFeedbackTimeoutId = null;
let shouldSkipModalFallbackFocus = false;
let hasShownSegmentCacheWriteWarning = false;
let activeTaskId = null;
const runningTaskExecutions = new Set();
const runningTaskExecutionPromises = new Map();
let activeTaskDetailsId = null;
let pendingQualitySelectionId = '';
let pendingTaskDraft = null;
let activeRangeSelectionTaskId = null;
let pendingRangeTaskDraft = null;
let pendingRangeStart = '';
let pendingRangeEnd = '';
let activeForceMergeTaskId = null;
let pendingForceMergeMode = 'prefix';
let pendingDeleteConfirmation = null;
let activePreviewHls = null;
let activePreviewObjectUrl = '';
let activePreviewSubtitleCueTrack = null;
let activePreviewSubtitleCueHandler = null;
let activePreviewSubtitleVideoCueHandler = null;
let activePreviewSubtitleCues = [];
let activePreviewSubtitleCueTrackKey = '';
let activePreviewSubtitleCueCacheByTrackKey = new Map();
let activePreviewSubtitleLoading = false;
let pendingPreviewSubtitleBindingRetryId = 0;
let pendingPreviewSource = null;
let pendingPreviewQualityId = '';
let pendingPreviewSubtitleId = '';
let activePreviewRequestId = 0;
let isNewTaskCreateBusy = false;
let taskFilterStatus = 'all';
let taskListBatchControlElements = null;
const taskRequestControllers = new Map();
const taskStreamWriters = new Map();
const standaloneTaskRequestScopes = new Map();
const taskDownloadObjectUrls = new Map();
const downloadObjectUrlRecords = new Map();
const pendingRemovedTaskCleanups = new Set();
const downloadByteMemoryReservations = new WeakMap();
const aes128KeyCache = new Map();
let segmentCacheDbPromise = null;
let segmentCacheStatusElements = null;
let nextPendingTaskProbeId = 1;

function createAggregateDownloadSampler() {
    const activeSegmentStatuses = new Set(['downloading', 'retrying']);

    function isActiveMediaDownloadTask(task) {
        if (!task || ['paused', 'completed', 'finalizing'].includes(task.status)) return false;
        return task.status === 'downloading'
            || (Array.isArray(task.segments)
                && task.segments.some(segment => activeSegmentStatuses.has(segment?.status)));
    }

    function buildModel(activeTaskCount, aggregateSpeed, schedulerSnapshot = {}) {
        return {
            speedBytesPerSecond: Math.max(0, Math.round(aggregateSpeed)),
            activeTaskCount,
            inFlightRequests: Math.max(0, Number(schedulerSnapshot?.inFlight) || 0),
            targetRequestBudget: Math.max(1, Number(schedulerSnapshot?.targetBudget) || 8)
        };
    }

    function sample(tasks = [], schedulerSnapshot = {}) {
        const safeTasks = Array.isArray(tasks) ? tasks : [];
        const activeTasks = safeTasks
            .filter(task => isActiveMediaDownloadTask(task));
        const activeTaskCountModel = {
            count: activeTasks.length,
            speed: activeTasks.reduce((sum, task) => (
                sum + Math.max(0, Number(task?.downloadSpeedBytesPerSecond) || 0)
            ), 0)
        };
        return buildModel(activeTaskCountModel.count, activeTaskCountModel.speed, schedulerSnapshot);
    }

    return { sample };
}

function createDownloadRequestScheduler(options = {}) {
    const initialBudget = Math.max(1, Number(options.initialBudget) || 8);
    const ceiling = Math.max(initialBudget, Number(options.ceiling) || 16);
    const tasks = new Map();
    const sourceHealth = new Map();
    const taskOrder = [];
    let cursor = 0;
    let targetBudget = initialBudget;
    let inFlight = 0;
    let nextLeaseId = 1;
    let successfulCompletions = 0;
    let cooldownWakeTimer = null;
    let cooldownWakeAt = 0;
    const leases = new Map();

    function normalizeTaskId(taskId) {
        return String(taskId || '');
    }

    function createAbortError(message) {
        if (typeof DOMException === 'function') {
            return new DOMException(message, 'AbortError');
        }
        const error = new Error(message);
        error.name = 'AbortError';
        return error;
    }

    function getSourceState(sourceKey) {
        const normalizedSourceKey = String(sourceKey || 'global');
        if (!sourceHealth.has(normalizedSourceKey)) {
            sourceHealth.set(normalizedSourceKey, {
                targetBudget: initialBudget,
                inFlight: 0,
                cooldownUntil: 0,
                successCount: 0
            });
        }
        return sourceHealth.get(normalizedSourceKey);
    }

    function registerTask(taskId, limit = 4) {
        const normalizedTaskId = normalizeTaskId(taskId);
        if (!normalizedTaskId) return;
        const normalizedLimit = Math.min(8, Math.max(1, Number.parseInt(limit, 10) || 4));
        const existing = tasks.get(normalizedTaskId);
        if (existing) {
            existing.limit = normalizedLimit;
            existing.stopped = false;
            return;
        }
        tasks.set(normalizedTaskId, {
            limit: normalizedLimit,
            inFlight: 0,
            stopped: false,
            waiters: []
        });
        taskOrder.push(normalizedTaskId);
    }

    function removeFromOrder(taskId) {
        const index = taskOrder.indexOf(taskId);
        if (index < 0) return;
        taskOrder.splice(index, 1);
        if (taskOrder.length === 0) {
            cursor = 0;
        } else if (cursor >= taskOrder.length) {
            cursor %= taskOrder.length;
        }
    }

    function rejectWaiters(task, error) {
        while (task.waiters.length > 0) {
            task.waiters.shift().reject(error);
        }
    }

    function findNextTask() {
        if (taskOrder.length === 0) return null;
        const now = Date.now();
        for (let offset = 0; offset < taskOrder.length; offset += 1) {
            const index = (cursor + offset) % taskOrder.length;
            const taskId = taskOrder[index];
            const task = tasks.get(taskId);
            if (!task || task.stopped || task.waiters.length === 0 || task.inFlight >= task.limit) continue;
            let waiterIndex = -1;
            let source = null;
            for (let index = 0; index < task.waiters.length; index += 1) {
                const candidateSource = getSourceState(task.waiters[index].sourceKey);
                if (candidateSource.cooldownUntil <= now
                    && candidateSource.inFlight < candidateSource.targetBudget) {
                    waiterIndex = index;
                    source = candidateSource;
                    break;
                }
            }
            if (waiterIndex < 0) continue;
            cursor = (index + 1) % taskOrder.length;
            return { taskId, task, source, waiterIndex };
        }
        return null;
    }

    function scheduleCooldownWake() {
        const now = Date.now();
        let earliestWakeAt = Number.POSITIVE_INFINITY;
        tasks.forEach(task => {
            if (task.stopped) return;
            task.waiters.forEach(waiter => {
                const cooldownUntil = getSourceState(waiter.sourceKey).cooldownUntil;
                if (cooldownUntil > now) {
                    earliestWakeAt = Math.min(earliestWakeAt, cooldownUntil);
                }
            });
        });

        if (!Number.isFinite(earliestWakeAt)) {
            if (cooldownWakeTimer) clearTimeout(cooldownWakeTimer);
            cooldownWakeTimer = null;
            cooldownWakeAt = 0;
            return;
        }
        if (cooldownWakeTimer && cooldownWakeAt <= earliestWakeAt) return;
        if (cooldownWakeTimer) clearTimeout(cooldownWakeTimer);
        cooldownWakeAt = earliestWakeAt;
        cooldownWakeTimer = setTimeout(() => {
            cooldownWakeTimer = null;
            cooldownWakeAt = 0;
            pump();
        }, Math.max(0, earliestWakeAt - now));
    }

    function pump() {
        while (inFlight < targetBudget) {
            const next = findNextTask();
            if (!next) {
                scheduleCooldownWake();
                return;
            }
            const [waiter] = next.task.waiters.splice(next.waiterIndex, 1);
            const lease = {
                id: String(nextLeaseId++),
                taskId: next.taskId,
                sourceKey: waiter.sourceKey
            };
            next.task.inFlight += 1;
            next.source.inFlight += 1;
            inFlight += 1;
            leases.set(lease.id, lease);
            waiter.resolve(lease);
        }
    }

    function registerSourceSuccess(sourceKey) {
        const source = getSourceState(sourceKey);
        source.successCount += 1;
        successfulCompletions += 1;
        if (successfulCompletions >= 8 && targetBudget < ceiling) {
            targetBudget += 1;
            successfulCompletions = 0;
        }
        if (source.successCount >= 8 && source.targetBudget < ceiling) {
            source.targetBudget += 1;
            source.successCount = 0;
        }
    }

    function report(taskId, sourceKey, result = {}) {
        void taskId;
        const source = getSourceState(sourceKey);
        const status = Number(result.status);
        if (status === 429 || status === 503 || result.throttled === true) {
            const retryAfterMs = Math.max(0, Number(result.retryAfterMs) || 0);
            source.targetBudget = Math.max(1, Math.floor(source.targetBudget / 2));
            source.cooldownUntil = Math.max(source.cooldownUntil, Date.now() + retryAfterMs);
            source.successCount = 0;
            successfulCompletions = 0;
            pump();
            return;
        }
        if (result.ok === true) registerSourceSuccess(sourceKey);
        pump();
    }

    function acquire(taskId, sourceKey = 'global') {
        const normalizedTaskId = normalizeTaskId(taskId);
        const task = tasks.get(normalizedTaskId);
        if (!task || task.stopped) {
            return Promise.reject(createAbortError('Task is stopped'));
        }
        return new Promise((resolve, reject) => {
            task.waiters.push({ resolve, reject, sourceKey: String(sourceKey || 'global') });
            pump();
        });
    }

    function release(taskId, leaseId, result = {}) {
        const task = tasks.get(normalizeTaskId(taskId));
        const lease = leases.get(String(leaseId));
        if (!task || !lease || lease.taskId !== normalizeTaskId(taskId) || task.inFlight <= 0) return;
        leases.delete(String(leaseId));
        task.inFlight -= 1;
        inFlight = Math.max(0, inFlight - 1);
        const sourceKey = lease.sourceKey || result.sourceKey || 'global';
        const source = getSourceState(sourceKey);
        source.inFlight = Math.max(0, source.inFlight - 1);
        if (result.ok === true || result.status === 429 || result.status === 503) {
            report(taskId, sourceKey, result);
        }
        void leaseId;
        pump();
    }

    function stopTask(taskId) {
        const task = tasks.get(normalizeTaskId(taskId));
        if (!task) return;
        task.stopped = true;
        rejectWaiters(task, createAbortError('Task is stopped'));
        pump();
    }

    function startTask(taskId, limit = 4) {
        registerTask(taskId, limit);
        pump();
    }

    function unregisterTask(taskId) {
        const normalizedTaskId = normalizeTaskId(taskId);
        const task = tasks.get(normalizedTaskId);
        if (!task) return;
        stopTask(normalizedTaskId);
        tasks.delete(normalizedTaskId);
        removeFromOrder(normalizedTaskId);
        pump();
    }

    return {
        acquire,
        registerTask,
        release,
        report,
        startTask,
        stopTask,
        unregisterTask,
        snapshot() {
            return {
                targetBudget,
                ceiling,
                inFlight,
                tasks: Object.fromEntries([...tasks.entries()].map(([taskId, task]) => [taskId, {
                    limit: task.limit,
                    inFlight: task.inFlight,
                    stopped: task.stopped,
                    queued: task.waiters.length
                }]))
            };
        }
    };
}

const downloadRequestScheduler = createDownloadRequestScheduler();
globalThis.__downloadRequestScheduler = downloadRequestScheduler;
let fileSelectionQueue = Promise.resolve();
let finalExportQueue = Promise.resolve();
const pendingTaskFinalExports = new Map();
const aggregateDownloadSampler = createAggregateDownloadSampler();
let aggregateDownloadStatusIntervalId = null;
let hasShownBufferedMemoryWarning = false;
const AGGREGATE_DOWNLOAD_SAMPLE_INTERVAL_MS = 1000;

function enqueueFileSelection(operation) {
    const queuedOperation = fileSelectionQueue.catch(() => {}).then(operation);
    fileSelectionQueue = queuedOperation.catch(() => {});
    return queuedOperation;
}

function enqueueFinalExport(operation) {
    const queuedOperation = finalExportQueue.catch(() => {}).then(operation);
    finalExportQueue = queuedOperation.catch(() => {});
    return queuedOperation;
}

function enqueueTaskFinalExport(taskId, operation) {
    const normalizedTaskId = String(taskId || '');
    if (!normalizedTaskId) {
        return enqueueFinalExport(async () => ({
            cancelled: false,
            value: await operation()
        }));
    }

    let resolveCancellation;
    const record = {
        cancelled: false,
        started: false,
        operation,
        cancel() {
            if (record.cancelled) return;
            record.cancelled = true;
            record.operation = null;
            if (!record.started) {
                resolveCancellation({ cancelled: true, value: undefined });
            }
        }
    };
    const cancellationPromise = new Promise(resolve => {
        resolveCancellation = resolve;
    });
    const records = pendingTaskFinalExports.get(normalizedTaskId) ?? new Set();
    records.add(record);
    pendingTaskFinalExports.set(normalizedTaskId, records);

    const queuedOperation = enqueueFinalExport(async () => {
        const queuedTaskOperation = record.operation;
        record.operation = null;
        if (record.cancelled || typeof queuedTaskOperation !== 'function') {
            return { cancelled: true, value: undefined };
        }
        record.started = true;
        const value = await queuedTaskOperation();
        return { cancelled: record.cancelled, value };
    });

    return Promise.race([queuedOperation, cancellationPromise]).finally(() => {
        records.delete(record);
        if (records.size === 0) {
            pendingTaskFinalExports.delete(normalizedTaskId);
        }
    });
}

function cancelPendingTaskFinalExports(taskId) {
    const records = pendingTaskFinalExports.get(String(taskId || ''));
    if (!records) return;
    records.forEach(record => record.cancel());
}

function renderAggregateDownloadStatus(model, elements = null) {
    const targetElements = elements ?? {
        speed: aggregateDownloadSpeedElement,
        activeTasks: aggregateActiveTasksElement,
        requests: aggregateRequestSlotsElement,
        requestState: document.getElementById('aggregate-request-state')
    };
    if (!targetElements.speed || !targetElements.activeTasks || !targetElements.requests) {
        return false;
    }

    const speed = Math.max(0, Number(model?.speedBytesPerSecond) || 0);
    const activeTasks = Math.max(0, Number(model?.activeTaskCount) || 0);
    const inFlight = Math.max(0, Number(model?.inFlightRequests) || 0);
    const targetBudget = Math.max(1, Number(model?.targetRequestBudget) || 8);
    targetElements.speed.textContent = `${formatStorageBytes(speed)}/s`;
    targetElements.activeTasks.textContent = String(activeTasks);
    const isSaturated = inFlight >= targetBudget;
    targetElements.requests.textContent = `${inFlight} / ${targetBudget}`;
    targetElements.requests.classList?.toggle('is-saturated', isSaturated);
    if (targetElements.requestState) {
        targetElements.requestState.textContent = isSaturated ? '已满' : '可用';
        targetElements.requestState.classList?.toggle('is-saturated', isSaturated);
    }
    return true;
}

function ensureAggregateDownloadStatusUpdate() {
    if (aggregateDownloadStatusIntervalId !== null || typeof setInterval !== 'function') return;
    aggregateDownloadStatusIntervalId = -1;
    const intervalId = setInterval(() => {
        updateAggregateDownloadStatus();
    }, AGGREGATE_DOWNLOAD_SAMPLE_INTERVAL_MS);
    if (aggregateDownloadStatusIntervalId !== null) {
        aggregateDownloadStatusIntervalId = intervalId;
    }
}

function stopAggregateDownloadStatusUpdate() {
    if (aggregateDownloadStatusIntervalId === null) return;
    if (typeof clearInterval === 'function') {
        clearInterval(aggregateDownloadStatusIntervalId);
    }
    aggregateDownloadStatusIntervalId = null;
}

function updateAggregateDownloadStatus(now = Date.now()) {
    const scheduler = globalThis.__downloadRequestScheduler
        || (typeof downloadRequestScheduler !== 'undefined' ? downloadRequestScheduler : null);
    const schedulerSnapshot = scheduler?.snapshot?.() ?? {};
    const model = aggregateDownloadSampler.sample(currentTasks, schedulerSnapshot, now);
    renderAggregateDownloadStatus(model);
    if (model.activeTaskCount > 0 || model.inFlightRequests > 0) {
        if (typeof ensureAggregateDownloadStatusUpdate === 'function') {
            ensureAggregateDownloadStatusUpdate();
        }
    } else {
        stopAggregateDownloadStatusUpdate();
    }
    return model;
}

function parseRetryAfterMilliseconds(response) {
    const value = String(response?.headers?.get?.('Retry-After') || '').trim();
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const retryAt = Date.parse(value);
    return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
}

function getDownloadSourceKey(resourceUrl, fallbackUrl = '') {
    try {
        return new URL(resourceUrl || fallbackUrl || '', fallbackUrl || undefined).origin;
    } catch {
        return 'global';
    }
}

function beginStandaloneTaskRequestScope(task) {
    const taskId = String(task?.id || '');
    if (!taskId) return task;
    let scope = standaloneTaskRequestScopes.get(taskId);
    if (!scope) {
        scope = { count: 0, waiters: [] };
        standaloneTaskRequestScopes.set(taskId, scope);
    }
    scope.count += 1;
    downloadRequestScheduler.startTask(taskId, task?.concurrency);
    return {
        ...task,
        isScheduledDownloadRequest: true
    };
}

function endStandaloneTaskRequestScope(taskId) {
    const normalizedTaskId = String(taskId || '');
    const scope = standaloneTaskRequestScopes.get(normalizedTaskId);
    if (!scope) return;
    scope.count = Math.max(0, scope.count - 1);
    if (scope.count > 0) return;
    standaloneTaskRequestScopes.delete(normalizedTaskId);
    if (!runningTaskExecutions.has(normalizedTaskId)) {
        downloadRequestScheduler.unregisterTask(normalizedTaskId);
    }
    scope.waiters.splice(0).forEach(resolve => resolve());
}

function hasStandaloneTaskRequestScope(taskId) {
    return (standaloneTaskRequestScopes.get(String(taskId || ''))?.count || 0) > 0;
}

function waitForStandaloneTaskRequestScopes(taskId) {
    const scope = standaloneTaskRequestScopes.get(String(taskId || ''));
    if (!scope || scope.count === 0) return Promise.resolve();
    return new Promise(resolve => {
        scope.waiters.push(resolve);
    });
}

async function abortTaskStreamWriterForTask(taskId) {
    const normalizedTaskId = String(taskId || '');
    const writer = taskStreamWriters.get(normalizedTaskId);
    if (!writer) return;
    taskStreamWriters.delete(normalizedTaskId);
    if (typeof writer.abort === 'function') {
        try {
            await writer.abort();
        } catch {
            // Task deletion still proceeds after best-effort writer cleanup.
        }
    }
}

async function withDownloadRequestLease(task, resourceUrl, operation) {
    const taskId = String(task?.id || '');
    const sourceKey = getDownloadSourceKey(resourceUrl, task?.url);
    const scheduler = typeof downloadRequestScheduler !== 'undefined'
        ? downloadRequestScheduler
        : globalThis.__downloadRequestScheduler;
    const registeredTasks = scheduler?.snapshot?.().tasks || {};
    const executionStore = typeof runningTaskExecutions !== 'undefined'
        ? runningTaskExecutions
        : globalThis.__runningTaskExecutions;
    const isScheduledDownloadRequest = Boolean(
        task?.isScheduledDownloadRequest
        || executionStore?.has(taskId)
    );
    if (
        task?.isPreviewRequest
        || !scheduler
        || !taskId
        || !registeredTasks[taskId]
        || !isScheduledDownloadRequest
    ) {
        const result = await operation();
        return result?.value ?? result;
    }
    const lease = await scheduler.acquire(taskId, sourceKey);
    try {
        const result = await operation();
        const resultStatus = Number(result?.status);
        const retryAfterMs = typeof parseRetryAfterMilliseconds === 'function'
            ? parseRetryAfterMilliseconds(result?.value?.response || result?.response)
            : 0;
        scheduler.release(taskId, lease.id, {
            sourceKey,
            status: Number.isFinite(resultStatus) && resultStatus > 0 ? resultStatus : 200,
            ok: !Number.isFinite(resultStatus) || resultStatus >= 200 && resultStatus < 400,
            retryAfterMs
        });
        return result?.value ?? result;
    } catch (error) {
        scheduler.release(taskId, lease.id, {
            sourceKey,
            status: Number(error?.httpStatus) || 0,
            retryAfterMs: Number(error?.retryAfterMs) || 0,
            throttled: Number(error?.httpStatus) === 429 || Number(error?.httpStatus) === 503
        });
        throw error;
    }
}

const MODAL_CLOSE_DURATION_MS = 260;
const MIN_FORCE_MERGE_PREFIX_DURATION_SECONDS = 30;
const DOWNLOAD_OBJECT_URL_REVOKE_DELAY_MS = 1500;
const MEBIBYTE = 1024 * 1024;
const MIN_BUFFERED_MEMORY_BUDGET_BYTES = 64 * MEBIBYTE;
const DEFAULT_BUFFERED_MEMORY_BUDGET_BYTES = 256 * MEBIBYTE;
const FORCE_MERGE_TS_ANALYSIS_MAX_BYTES = 8 * 1024 * 1024;
const modalById = {
    'new-task': newTaskModal,
    'settings': settingsModal,
    'details': detailsModal,
    'download-quality': downloadQualityModal,
    'download-range': downloadRangeModal,
    'force-merge': forceMergeModal,
    'confirm-delete': confirmDeleteModal,
    'preview': previewModal,
    'help': helpModal
};

if (globalThis.streamSaver) {
    globalThis.streamSaver.mitm = 'vendor/streamsaver-mitm.html';
}

const DEFAULT_TASK_PARAMS_STORAGE_KEY = 'default-task-params';
const TASKS_STORAGE_KEY = 'm3u8-downloader-tasks';
const SEGMENT_CACHE_DB_NAME = 'm3u8-downloader-segment-cache';
const SEGMENT_CACHE_DB_VERSION = 1;
const SEGMENT_CACHE_STORE_NAME = 'segments';
const DEFAULT_TASK_PARAMS = {
    titleTemplate: 'video-{id}',
    format: 'ts',
    streamSave: false,
    segmentCache: true,
    concurrency: 4,
    downloadRangeMode: 'all'
};
const HLS_PLAYLIST_HEADER = '#EXTM3U';
const NON_HLS_SOURCE_ERROR = '地址不可识别或不是 m3u8 资源';
const SOURCE_ACCESS_RESTRICTED_ERROR = '源站限制，当前纯静态模式无法下载';
const UNSUPPORTED_M3U8_TYPE_ERROR = '当前 m3u8 类型不支持';
const MASTER_PLAYLIST_PRESELECTION_ERROR = 'master playlist 需要先选择清晰度后再创建任务';
const RECOVERY_CONTEXT_INCOMPLETE_ERROR = '恢复信息不完整，请重新下载未完成内容';
const UNSUPPORTED_SUBTITLE_FORMAT_ERROR = '当前字幕格式暂不支持。';
const BUFFERED_MEMORY_BUDGET_BYTES = resolveBufferedMemoryBudgetBytes();
const downloadMemoryGovernor = createDownloadMemoryGovernor({
    limitBytes: BUFFERED_MEMORY_BUDGET_BYTES,
    getRetainedBytes: () => getBufferedMemoryBudgetSnapshot().usedBytes
});
const QUICK_DOWNLOAD_PARAM_NAMES = new Set([
    'title',
    'format',
    'streamSave',
    'range',
    'concurrency',
    '_ignore'
]);

let defaultTaskParams = loadDefaultTaskParams();

// --- Functions ---

function hideAppLoader() {
    if (!appLoader || appLoader.classList.contains('is-hiding')) return;
    appLoader.classList.add('is-hiding');
    window.setTimeout(() => {
        if (typeof appLoader.remove === 'function') {
            appLoader.remove();
        }
    }, 260);
}

function getAppLoaderDebugDelayMs(search = globalThis.location?.search || '') {
    try {
        const params = new URLSearchParams(String(search || ''));
        const rawValue = params.get('loaderDelay');
        if (rawValue == null) return 0;
        const value = Number.parseInt(rawValue, 10);
        if (!Number.isFinite(value) || value <= 0) return 0;
        return Math.min(value, 5000);
    } catch {
        return 0;
    }
}

function hideAppLoaderAfterDebugDelay() {
    const delayMs = getAppLoaderDebugDelayMs();
    if (delayMs > 0) {
        window.setTimeout(hideAppLoader, delayMs);
        return;
    }
    hideAppLoader();
}

function parseQuickDownloadParams(search = globalThis.location?.search || '') {
    const rawSearch = String(search || '');
    const encodedParams = parseEncodedQuickDownloadParams(rawSearch);
    const unencodedParams = parseUnencodedQuickDownloadParams(rawSearch);
    const params = chooseQuickDownloadParams(encodedParams, unencodedParams, rawSearch);
    if (!params?.source) return null;

    const ignore = normalizeQuickDownloadIgnore(params.ignore);
    return {
        ...params,
        ignore,
        source: removeIgnoredSourceParams(params.source, ignore)
    };
}

function chooseQuickDownloadParams(encodedParams, unencodedParams, search) {
    if (!encodedParams?.source) return unencodedParams;
    if (!unencodedParams?.source) return encodedParams;
    return shouldUseUnencodedQuickDownloadSource(search) ? unencodedParams : encodedParams;
}

function parseEncodedQuickDownloadParams(search) {
    const query = trimSearchPrefix(search);
    if (!query) return null;

    const searchParams = new URLSearchParams(query);
    return buildQuickDownloadParamsFromEntries(Array.from(searchParams.entries()), { decode: false });
}

function parseUnencodedQuickDownloadParams(search) {
    const query = trimSearchPrefix(search);
    const sourceIndex = findQuickDownloadSourceValueIndex(query);
    if (sourceIndex < 0) return null;

    const beforeSource = query.slice(0, sourceIndex - 'source='.length);
    const sourceAndAfter = query.slice(sourceIndex);
    const sourceParts = sourceAndAfter.split('&');
    const entries = [];
    const sourceSegments = [sourceParts.shift() ?? ''];

    for (const part of sourceParts) {
        const key = decodeQuickDownloadComponent(part.split('=')[0] ?? '');
        if (QUICK_DOWNLOAD_PARAM_NAMES.has(key)) {
            entries.push(splitQuickDownloadParamPart(part));
        } else {
            sourceSegments.push(part);
        }
    }

    if (beforeSource) {
        for (const part of beforeSource.split('&')) {
            if (!part) continue;
            entries.push(splitQuickDownloadParamPart(part));
        }
    }

    entries.unshift(['source', sourceSegments.join('&')]);
    return buildQuickDownloadParamsFromEntries(entries, { decodeSource: false });
}

function shouldUseUnencodedQuickDownloadSource(search) {
    const query = trimSearchPrefix(search);
    const sourceIndex = findQuickDownloadSourceValueIndex(query);
    if (sourceIndex < 0) return false;

    const sourceAndAfter = query.slice(sourceIndex);
    const sourceParts = sourceAndAfter.split('&');
    const rawSource = sourceParts.shift() ?? '';
    const trimmedSource = rawSource.trim();
    const urlPrefixPattern = /^[a-z][a-z0-9+.-]*:\/\//i;
    if (!urlPrefixPattern.test(trimmedSource)) return false;
    if (rawSource.includes('+')) return true;

    return trimmedSource.includes('?')
        && sourceParts.some(part => {
            if (!part) return false;
            const key = decodeQuickDownloadComponent(part.split('=')[0] ?? '');
            return !QUICK_DOWNLOAD_PARAM_NAMES.has(key);
        });
}

function findQuickDownloadSourceValueIndex(query) {
    if (query.startsWith('source=')) return 'source='.length;
    const sourceParamIndex = query.indexOf('&source=');
    return sourceParamIndex < 0 ? -1 : sourceParamIndex + '&source='.length;
}

function buildQuickDownloadParamsFromEntries(entries, options = {}) {
    const parsed = {};
    const shouldDecode = options.decode !== false;
    const shouldDecodeSource = options.decodeSource !== false && shouldDecode;

    for (const [rawKey, rawValue] of entries) {
        const key = shouldDecode ? decodeQuickDownloadComponent(rawKey) : String(rawKey || '');
        const value = shouldDecode ? decodeQuickDownloadComponent(rawValue) : String(rawValue || '');
        if (key === 'source') {
            const sourceValue = shouldDecodeSource ? value : String(rawValue || '');
            const source = sourceValue.trim();
            if (decodeQuickDownloadComponent(source).trim()) parsed.source = source;
            continue;
        }
        if (key === 'title') {
            const title = value.trim();
            if (title) parsed.title = title;
            continue;
        }
        if (key === 'format') {
            const format = normalizeQuickDownloadFormat(value);
            if (format) parsed.format = format;
            continue;
        }
        if (key === 'streamSave') {
            const streamSave = normalizeQuickDownloadBoolean(value);
            if (streamSave !== null) parsed.streamSave = streamSave;
            continue;
        }
        if (key === 'range') {
            const range = normalizeQuickDownloadRange(value);
            if (range) parsed.range = range;
            continue;
        }
        if (key === 'concurrency') {
            const concurrency = normalizeQuickDownloadConcurrency(value);
            if (concurrency !== null) parsed.concurrency = concurrency;
            continue;
        }
        if (key === '_ignore') {
            parsed.ignore = value;
        }
    }

    return parsed.source ? parsed : null;
}

function splitQuickDownloadParamPart(part) {
    const equalsIndex = part.indexOf('=');
    if (equalsIndex < 0) return [part, ''];
    return [part.slice(0, equalsIndex), part.slice(equalsIndex + 1)];
}

function trimSearchPrefix(search) {
    return String(search || '').replace(/^\?/, '');
}

function decodeQuickDownloadComponent(value) {
    const text = String(value || '').replace(/\+/g, ' ');
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}

function normalizeQuickDownloadFormat(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['ts', 'mp4'].includes(normalized) ? normalized : null;
}

function normalizeQuickDownloadBoolean(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (['1', 'true', 'yes'].includes(normalized)) return true;
    if (['0', 'false', 'no'].includes(normalized)) return false;
    return null;
}

function normalizeQuickDownloadRange(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['all', 'custom'].includes(normalized) ? normalized : null;
}

function normalizeQuickDownloadConcurrency(value) {
    const text = String(value || '');
    if (!/^\d+$/.test(text)) return null;

    const normalized = Number.parseInt(text, 10);
    if (!Number.isInteger(normalized)) return null;
    if (normalized < 1 || normalized > 8) return null;
    return normalized;
}

function normalizeQuickDownloadIgnore(value) {
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function removeIgnoredSourceParams(source, ignoreNames) {
    if (!ignoreNames.length) return source;

    try {
        const sourceUrl = new URL(source);
        ignoreNames.forEach(name => sourceUrl.searchParams.delete(name));
        return sourceUrl.toString();
    } catch {
        return source;
    }
}

function init() {
    currentTasks = loadTasksFromStorage();
    applyTheme(currentTheme);
    applyDefaultTaskParamsToSettingsForm();
    resetNewTaskFormToDefaults();
    renderTasks();
    updateAggregateDownloadStatus();
    setupEventListeners();
    applyQuickDownloadFromLocation();
    scheduleNextQueuedTask();
    hydrateRestoredTasksFromSegmentCache().finally(() => {
        if (runningTaskExecutions.size === 0) {
            scheduleNextQueuedTask();
        }
    });
    cleanupOrphanedSegmentCacheOnStartup();
    hideAppLoaderAfterDebugDelay();
}

function applyQuickDownloadFromLocation() {
    const params = parseQuickDownloadParams(globalThis.location?.search || '');
    if (!params?.source) return false;
    if (activeModalId || pendingModalId) return false;

    shouldSkipModalFallbackFocus = true;
    openModal('new-task');
    return applyQuickDownloadParamsToNewTaskForm(params);
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const themeBtn = document.getElementById('theme-toggle-btn');
    if (themeBtn) {
        const icon = theme === 'light' ? 'sun' : 'moon';
        themeBtn.innerHTML = `<i data-lucide="${icon}"></i>`;
        if (window.lucide) lucide.createIcons();
    }
    currentTheme = theme;
    localStorage.setItem('theme', theme);
}

function toggleTheme() {
    applyTheme(currentTheme === 'light' ? 'dark' : 'light');
}

function goHomeFromLogo(event) {
    event?.preventDefault?.();
    clearLocationParamsForHome();
    selectedTaskIds.clear();
    taskFilterStatus = 'all';
    pendingTaskSelectionFocusId = null;
    if (activeModalId || pendingModalId || isModalClosing) {
        finalizeModalClose();
    }
    renderTasks();
    if (typeof window.scrollTo === 'function') {
        window.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
    }
}

function clearLocationParamsForHome() {
    const historyApi = globalThis.history || window.history;
    const locationApi = globalThis.location || window.location;
    if (!historyApi?.replaceState || !locationApi) return;
    const cleanPath = locationApi.pathname || './';
    historyApi.replaceState(null, '', cleanPath);
}

function getTaskFilterStatusGroup(status) {
    if (status === 'downloading') return 'downloading';
    if (status === 'paused') return 'paused';
    if (status === 'failed') return 'failed';
    if (status === 'completed') return 'completed';
    if (['recoverable', 'partial_completed', 'queued'].includes(status)) return 'recoverable';
    return status || '';
}

function getFilteredTasks() {
    return currentTasks.filter(task => {
        if (taskFilterStatus !== 'all' && getTaskFilterStatusGroup(task.status) !== taskFilterStatus) {
            return false;
        }
        return true;
    });
}

function setTaskFilterStatus(status) {
    const nextStatus = ['all', 'downloading', 'paused', 'failed', 'completed', 'recoverable'].includes(status)
        ? status
        : 'all';
    taskFilterStatus = nextStatus;
    selectedTaskIds.forEach(taskId => {
        if (!getFilteredTasks().some(task => String(task.id) === String(taskId))) {
            selectedTaskIds.delete(taskId);
        }
    });
    renderTasks();
}

function syncTaskFilterControls() {
    const statusControl = document.getElementById('task-filter-status');

    if (statusControl) statusControl.value = taskFilterStatus;
}

function renderTasks() {
    const tooltipSnapshot = getActiveTooltipSnapshot();
    const focusSnapshot = getActiveTaskListFocusSnapshot();
    if (!tooltipSnapshot && !shouldPreserveActiveDetailsTooltip()) {
        hideTooltip();
    }
    if (currentTasks.length === 0) {
        heroSection.classList.remove('hidden');
        tasksSection.classList.add('hidden');
        taskListContainer.innerHTML = '';
        syncTaskListSelectAllToggle();
        updateTaskListBatchControls();
        pendingTaskSelectionFocusId = null;
    } else {
        heroSection.classList.add('hidden');
        tasksSection.classList.remove('hidden');
        const filteredTasks = getFilteredTasks();
        taskListContainer.innerHTML = filteredTasks.length > 0
            ? filteredTasks.map(task => createTaskCardHTML(task)).join('')
            : '<div class="task-list-empty">没有符合筛选条件的任务</div>';
        syncTaskFilterControls();
        syncTaskListSelectAllToggle();
        updateTaskListBatchControls();
        restorePendingTaskSelectionFocus();
    }
    if (window.lucide) lucide.createIcons();
    renderSegmentCacheStatusBar();
    updateAggregateDownloadStatus();
    restoreActiveTooltipSnapshot(tooltipSnapshot);
    restoreActiveTaskListFocusSnapshot(focusSnapshot);
}

function isTaskSelected(id) {
    return selectedTaskIds.has(String(id));
}

function toggleTaskSelection(id) {
    const normalizedId = String(id);
    if (selectedTaskIds.has(normalizedId)) {
        selectedTaskIds.delete(normalizedId);
    } else {
        selectedTaskIds.add(normalizedId);
    }
    pendingTaskSelectionFocusId = getTaskSelectionControlId(normalizedId);
    renderTasks();
}

function selectAllTasks() {
    const filteredTasks = getFilteredTasks();
    filteredTasks.forEach(task => {
        selectedTaskIds.add(String(task.id));
    });
    pendingTaskSelectionFocusId = filteredTasks[0]
        ? getTaskSelectionControlId(filteredTasks[0].id)
        : null;
    renderTasks();
}

function areAllTasksSelected() {
    const filteredTasks = getFilteredTasks();
    return filteredTasks.length > 0
        && filteredTasks.every(task => selectedTaskIds.has(String(task.id)));
}

function clearAllTaskSelections() {
    const filteredTasks = getFilteredTasks();
    const filteredTaskIds = new Set(filteredTasks.map(task => String(task.id)));
    filteredTaskIds.forEach(taskId => selectedTaskIds.delete(taskId));
    pendingTaskSelectionFocusId = filteredTasks[0]
        ? getTaskSelectionControlId(filteredTasks[0].id)
        : null;
    renderTasks();
}

function setAllTaskSelections(checked) {
    if (checked) {
        selectAllTasks();
        return;
    }

    clearAllTaskSelections();
}

function syncTaskListSelectAllToggle() {
    const taskListSelectAllToggle = document.getElementById('task-list-select-all-toggle');
    if (!taskListSelectAllToggle) return;

    taskListSelectAllToggle.checked = areAllTasksSelected();
}

function getSelectedTasks() {
    const visibleTaskIds = new Set(getFilteredTasks().map(task => String(task.id)));
    return currentTasks.filter(task => (
        visibleTaskIds.has(String(task.id)) && selectedTaskIds.has(String(task.id))
    ));
}

function getSelectedTaskCount() {
    return getSelectedTasks().length;
}

function canBatchStartTask(task) {
    return ['queued', 'paused', 'failed', 'recoverable', 'partial_completed'].includes(task?.status);
}

function canBatchPauseTask(task) {
    return ['queued', 'downloading', 'detecting', 'resolving'].includes(task?.status);
}

function getTaskListBatchControlElements() {
    if (taskListBatchControlElements) {
        return taskListBatchControlElements;
    }

    taskListBatchControlElements = {
        selectedCount: document.getElementById('task-list-selected-count'),
        startButton: document.getElementById('task-list-batch-start-btn'),
        pauseButton: document.getElementById('task-list-batch-pause-btn'),
        deleteButton: document.getElementById('task-list-batch-delete-btn')
    };
    return taskListBatchControlElements;
}

function updateTaskListBatchControls() {
    const selectedTasks = getSelectedTasks();
    const selectedCount = selectedTasks.length;
    const shouldShowBatchControls = selectedCount > 0;
    const {
        selectedCount: selectedCountEl,
        startButton,
        pauseButton,
        deleteButton
    } = getTaskListBatchControlElements();

    if (selectedCountEl) {
        selectedCountEl.textContent = `已选 ${selectedCount} 项`;
    }

    if (startButton) {
        startButton.disabled = !selectedTasks.some(canBatchStartTask);
    }
    if (pauseButton) {
        pauseButton.disabled = !selectedTasks.some(canBatchPauseTask);
    }
    if (deleteButton) {
        deleteButton.disabled = !shouldShowBatchControls;
    }
}

function restorePendingTaskSelectionFocus() {
    if (!pendingTaskSelectionFocusId) return;

    const focusTarget = document.getElementById(pendingTaskSelectionFocusId);
    pendingTaskSelectionFocusId = null;
    if (isFocusableElement(focusTarget)) {
        focusTarget.focus();
    }
}

function getTaskSelectionControlId(id) {
    return `task-select-${String(id)}`;
}

function getTaskUrlButtonId(id) {
    return `task-url-${String(id)}`;
}

function getTaskDetailUrlButtonId(id) {
    return `task-detail-url-${String(id)}`;
}

function getTaskListTooltipKey(taskId, action) {
    return `task-tooltip-${String(taskId)}-${String(action)}`;
}

function getTaskListFocusKey(taskId, action) {
    return `task-focus-${String(taskId)}-${String(action)}`;
}

function batchStartSelectedTasks() {
    const selectedTaskIdSet = new Set(getSelectedTasks().map(task => String(task.id)));
    if (selectedTaskIdSet.size === 0) return;
    let shouldSchedule = false;

    selectedTaskIdSet.forEach(taskId => {
        const task = findTaskById(taskId);
        if (!task) return;
        if (task.status === 'queued') {
            shouldSchedule = true;
            return;
        }
        if (task.status === 'paused') {
            const resumedTask = resumeTask(taskId, { schedule: false });
            shouldSchedule = shouldSchedule || resumedTask?.status === 'queued';
            return;
        }
        if (['failed', 'recoverable', 'partial_completed'].includes(task.status)) {
            const restartedTask = restartTaskFromIncompleteSegments(taskId, { schedule: false });
            shouldSchedule = shouldSchedule || restartedTask?.status === 'queued';
        }
    });

    if (shouldSchedule) {
        scheduleNextQueuedTask();
    }
}

function showTaskStatusError(taskId) {
    const task = findTaskById(taskId);
    const errorInfo = getTaskDisplayErrorInfo(task);
    if (!errorInfo.message) return;
    showToast(formatRuntimeErrorDetail(errorInfo), { type: 'error', duration: 4200 });
}

function handleTaskStatusErrorPointerDown(event, taskId) {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    showTaskStatusError(taskId);
}

function handleTaskStatusErrorKeydown(event, taskId) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    showTaskStatusError(taskId);
}

function shouldPreserveActiveDetailsTooltip() {
    return activeModalId === 'details'
        && activeTooltipTarget instanceof HTMLElement
        && Boolean(activeTooltipTarget.closest('#details-modal'));
}

function isSegmentCacheAvailable() {
    return typeof indexedDB !== 'undefined' && typeof indexedDB.open === 'function';
}

function isSegmentCacheEnabled() {
    return defaultTaskParams.segmentCache !== false;
}

function getSegmentCacheKey(taskId, sequence) {
    return `${String(taskId)}::${String(sequence)}`;
}

function formatStorageBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let normalizedValue = value;
    let unitIndex = 0;
    while (normalizedValue >= 1024 && unitIndex < units.length - 1) {
        normalizedValue /= 1024;
        unitIndex += 1;
    }
    const isRoundedInteger = Math.abs(normalizedValue - Math.round(normalizedValue)) < 0.05;
    const fractionDigits = unitIndex === 0 || normalizedValue >= 10 || isRoundedInteger ? 0 : 1;
    return `${normalizedValue.toFixed(fractionDigits)} ${units[unitIndex]}`;
}

function resolveBufferedMemoryBudgetBytes(environment = {}) {
    const deviceMemory = Number(
        environment.deviceMemory
        ?? globalThis.navigator?.deviceMemory
    );
    const jsHeapSizeLimit = Number(
        environment.jsHeapSizeLimit
        ?? globalThis.performance?.memory?.jsHeapSizeLimit
    );
    const userAgent = String(environment.userAgent ?? globalThis.navigator?.userAgent ?? '');
    const isMobile = environment.isMobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);

    let budgetBytes = DEFAULT_BUFFERED_MEMORY_BUDGET_BYTES;
    if (Number.isFinite(deviceMemory) && deviceMemory > 0) {
        if (deviceMemory <= 2) budgetBytes = 96 * MEBIBYTE;
        else if (deviceMemory <= 4) budgetBytes = 128 * MEBIBYTE;
    }
    if (isMobile) {
        budgetBytes = Math.min(budgetBytes, 128 * MEBIBYTE);
    }
    if (Number.isFinite(jsHeapSizeLimit) && jsHeapSizeLimit > 0) {
        budgetBytes = Math.min(budgetBytes, Math.floor(jsHeapSizeLimit * 0.2));
    }

    return Math.max(MIN_BUFFERED_MEMORY_BUDGET_BYTES, Math.floor(budgetBytes));
}

function createDownloadMemoryGovernor(options = {}) {
    const limitBytes = Math.max(1, Math.floor(Number(options.limitBytes) || 1));
    const getRetainedBytes = typeof options.getRetainedBytes === 'function'
        ? options.getRetainedBytes
        : () => 0;
    const reservations = new Map();
    let reservedBytes = 0;
    let nextReservationId = 1;

    const normalizeBytes = value => Math.max(0, Math.ceil(Number(value) || 0));
    const getRetained = () => normalizeBytes(getRetainedBytes());

    function reserve(taskId, byteLength) {
        const requestedBytes = normalizeBytes(byteLength);
        if (getRetained() + reservedBytes + requestedBytes > limitBytes) {
            return null;
        }
        const reservation = {
            id: String(nextReservationId++),
            taskId: String(taskId || ''),
            byteLength: requestedBytes
        };
        reservations.set(reservation.id, reservation);
        reservedBytes += requestedBytes;
        return reservation;
    }

    function resize(reservation, byteLength) {
        const record = reservations.get(String(reservation?.id || ''));
        if (!record) return false;
        const nextByteLength = normalizeBytes(byteLength);
        const delta = nextByteLength - record.byteLength;
        if (delta > 0 && getRetained() + reservedBytes + delta > limitBytes) {
            return false;
        }
        record.byteLength = nextByteLength;
        reservedBytes = Math.max(0, reservedBytes + delta);
        return true;
    }

    function release(reservation) {
        const reservationId = String(reservation?.id || '');
        const record = reservations.get(reservationId);
        if (!record) return false;
        reservations.delete(reservationId);
        reservedBytes = Math.max(0, reservedBytes - record.byteLength);
        return true;
    }

    function snapshot() {
        const retainedBytes = getRetained();
        return {
            limitBytes,
            retainedBytes,
            reservedBytes,
            usedBytes: retainedBytes + reservedBytes,
            availableBytes: Math.max(0, limitBytes - retainedBytes - reservedBytes),
            reservationCount: reservations.size
        };
    }

    return { release, reserve, resize, snapshot };
}

async function readResponseBytesWithinMemoryBudget(response, options = {}) {
    const governor = options.governor;
    const estimatedBytes = Math.max(1, Number(options.estimatedBytes) || MEBIBYTE);
    const reservation = options.reservation || governor?.reserve(options.taskId, estimatedBytes);
    if (!reservation) {
        throw new Error('内存空间不足，已停止读取新的分片。');
    }

    try {
        const contentLength = Number(response?.headers?.get?.('content-length'));
        if (Number.isFinite(contentLength) && contentLength > 0
            && !governor.resize(reservation, contentLength)) {
            await response?.body?.cancel?.().catch?.(() => {});
            throw new Error('内存空间不足，当前分片超过可用额度。');
        }

        const reader = response?.body?.getReader?.();
        if (reader) {
            try {
                if (Number.isFinite(contentLength) && contentLength > 0) {
                    const readHeadroomBytes = Math.min(contentLength, MEBIBYTE);
                    if (!governor.resize(reservation, contentLength + readHeadroomBytes)) {
                        throw new Error('内存空间不足，无法安全读取当前分片。');
                    }
                    let bytes = new Uint8Array(contentLength);
                    let offset = 0;
                    while (true) {
                        const result = await reader.read();
                        if (result.done) break;
                        const chunk = result.value instanceof Uint8Array
                            ? result.value
                            : new Uint8Array(result.value || 0);
                        if (offset + chunk.byteLength > bytes.byteLength) {
                            throw new Error('分片响应长度超过服务器声明值。');
                        }
                        bytes.set(chunk, offset);
                        offset += chunk.byteLength;
                    }
                    if (offset !== bytes.byteLength) {
                        if (!governor.resize(reservation, bytes.byteLength + offset)) {
                            throw new Error('内存空间不足，无法整理当前分片。');
                        }
                        bytes = bytes.slice(0, offset);
                    }
                    governor.resize(reservation, bytes.byteLength);
                    return { bytes, reservation };
                }

                const chunks = [];
                let totalBytes = 0;
                while (true) {
                    const result = await reader.read();
                    if (result.done) break;
                    const chunk = result.value instanceof Uint8Array
                        ? result.value
                        : new Uint8Array(result.value || 0);
                    const nextTotalBytes = totalBytes + chunk.byteLength;
                    if (!governor.resize(reservation, Math.max(estimatedBytes, nextTotalBytes))) {
                        throw new Error('内存空间不足，当前分片超过可用额度。');
                    }
                    chunks.push(chunk);
                    totalBytes = nextTotalBytes;
                }
                if (chunks.length === 0) {
                    governor.resize(reservation, 0);
                    return { bytes: new Uint8Array(0), reservation };
                }
                if (chunks.length === 1) {
                    return { bytes: chunks[0], reservation };
                }
                if (!governor.resize(reservation, totalBytes * 2)) {
                    throw new Error('内存空间不足，无法整理当前分片。');
                }
                const bytes = new Uint8Array(totalBytes);
                let offset = 0;
                chunks.forEach(chunk => {
                    bytes.set(chunk, offset);
                    offset += chunk.byteLength;
                });
                governor.resize(reservation, totalBytes);
                return { bytes, reservation };
            } catch (error) {
                try {
                    await reader.cancel();
                } catch {
                    // Best-effort cancellation; the reservation is released below.
                }
                throw error;
            } finally {
                reader.releaseLock?.();
            }
        }

        if ((!Number.isFinite(contentLength) || contentLength <= 0) && !options.exactByteLength) {
            throw new Error('浏览器无法安全读取未知大小的分片，请改用边下边存。');
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!governor.resize(reservation, bytes.byteLength)) {
            throw new Error('内存空间不足，当前分片超过可用额度。');
        }
        return { bytes, reservation };
    } catch (error) {
        governor.release(reservation);
        throw error;
    }
}

function estimateSegmentMemoryBytes(task, segment) {
    const byteRangeLength = Number(segment?.byteRange?.length);
    if (Number.isSafeInteger(byteRangeLength) && byteRangeLength > 0) {
        return byteRangeLength;
    }
    const completedSizes = (Array.isArray(task?.segments) ? task.segments : [])
        .map(item => Math.max(0, Number(item?.byteLength) || Number(item?.bytes?.byteLength) || 0))
        .filter(Boolean);
    if (completedSizes.length > 0) {
        return Math.max(MEBIBYTE, Math.ceil(
            completedSizes.reduce((sum, value) => sum + value, 0) / completedSizes.length
        ));
    }
    return 8 * MEBIBYTE;
}

function shouldGuardTaskDownloadMemory(task) {
    const mode = typeof getTaskActualWriteMode === 'function'
        ? getTaskActualWriteMode(task)
        : task?.actualWriteMode;
    return !['file-system', 'stream-saver'].includes(mode);
}

function reserveTaskDownloadMemory(task, segment) {
    const governor = typeof downloadMemoryGovernor !== 'undefined'
        ? downloadMemoryGovernor
        : null;
    if (!governor || !shouldGuardTaskDownloadMemory(task)) return null;
    const reservation = governor.reserve(task?.id, estimateSegmentMemoryBytes(task, segment));
    if (!reservation) {
        throw new Error('内存空间不足，已暂停普通缓存任务。请删除任务或改用边下边存。');
    }
    return reservation;
}

function trackDownloadedBytesReservation(bytes, reservation) {
    if (bytes instanceof Uint8Array && reservation) {
        downloadByteMemoryReservations.set(bytes, reservation);
    }
    return bytes;
}

function releaseDownloadedBytesReservation(bytes) {
    if (!(bytes instanceof Uint8Array)) return false;
    const reservation = downloadByteMemoryReservations.get(bytes);
    if (!reservation) return false;
    downloadByteMemoryReservations.delete(bytes);
    return downloadMemoryGovernor.release(reservation);
}

function resizeDownloadedBytesReservation(bytes, byteLength) {
    if (!(bytes instanceof Uint8Array)) return true;
    const reservation = downloadByteMemoryReservations.get(bytes);
    if (!reservation) return true;
    return downloadMemoryGovernor.resize(reservation, byteLength);
}

function getTaskBufferedByteLength(task) {
    const seenBuffers = new Set();
    let byteLength = 0;
    const segments = Array.isArray(task?.segments) ? task.segments : [];
    segments.forEach(segment => {
        [segment?.bytes, segment?.initBytes].forEach(bytes => {
            if (!(bytes instanceof Uint8Array)) return;
            const buffer = bytes.buffer;
            if (!buffer || seenBuffers.has(buffer)) return;
            seenBuffers.add(buffer);
            byteLength += Number(buffer.byteLength) || 0;
        });
    });
    return byteLength;
}

function getBufferedMemoryBudgetSnapshot(tasks = currentTasks, limitBytes = BUFFERED_MEMORY_BUDGET_BYTES) {
    const taskList = Array.isArray(tasks) ? tasks : [];
    const usedBytes = taskList.reduce((sum, task) => sum + getTaskBufferedByteLength(task), 0);
    const normalizedLimitBytes = Math.max(1, Number(limitBytes) || BUFFERED_MEMORY_BUDGET_BYTES);
    return {
        usedBytes,
        limitBytes: normalizedLimitBytes,
        exceeded: usedBytes >= normalizedLimitBytes,
        utilization: usedBytes / normalizedLimitBytes
    };
}

function enforceBufferedMemoryBudget() {
    const snapshot = getBufferedMemoryBudgetSnapshot();
    if (!snapshot.exceeded) {
        if (snapshot.utilization < 0.75) {
            hasShownBufferedMemoryWarning = false;
        }
        return false;
    }

    const memoryTasks = currentTasks.filter(task => (
        task?.status === 'downloading'
        && ['memory', 'degraded'].includes(getTaskActualWriteMode(task))
    ));
    if (memoryTasks.length === 0) return false;

    memoryTasks.forEach(task => pauseTask(task.id));
    if (!hasShownBufferedMemoryWarning) {
        hasShownBufferedMemoryWarning = true;
        showToast(
            `内存缓存已达到 ${formatStorageBytes(snapshot.limitBytes)}，已暂停普通缓存任务。请删除任务或改用边下边存后继续。`,
            { type: 'error' }
        );
    }
    return true;
}

function handleDownloadMemoryPressure(taskId) {
    pauseTask(taskId);
    if (!hasShownBufferedMemoryWarning) {
        hasShownBufferedMemoryWarning = true;
        showToast(
            `下载内存已接近 ${formatStorageBytes(BUFFERED_MEMORY_BUDGET_BYTES)} 安全上限，已暂停当前普通缓存任务。请删除任务或改用边下边存后继续。`,
            { type: 'error' }
        );
    }
    return findTaskById(taskId);
}

function formatDownloadSpeed(bytesPerSecond, status) {
    const value = Number(bytesPerSecond);
    if (status !== 'downloading' || !Number.isFinite(value) || value <= 0) {
        return '--';
    }

    return `${formatStorageBytes(value)}/s`;
}

function formatEstimatedRemainingSeconds(seconds, status) {
    const value = Number(seconds);
    if (status !== 'downloading' || !Number.isFinite(value) || value <= 0) {
        return '--';
    }

    if (value < 60) {
        return `${Math.ceil(value)} 秒`;
    }
    return formatDurationFromSeconds(value);
}

function calculateTaskEstimatedRemainingSeconds(task) {
    const speed = Number(task?.downloadSpeedBytesPerSecond) || 0;
    const downloadedBytes = Number(task?.downloadedBytes) || 0;
    const knownTotalBytes = Number(task?.totalBytes) || 0;
    let totalBytes = knownTotalBytes;
    if (totalBytes <= downloadedBytes) {
        const segments = typeof getEffectiveTaskSegments === 'function'
            ? getEffectiveTaskSegments(task)
            : (Array.isArray(task?.segments) ? task.segments : []);
        const completedSegments = segments.filter(segment => hasCompletedSegment(segment));
        const completedCount = completedSegments.length;
        if (segments.length > 0 && completedCount > 0 && downloadedBytes > 0) {
            totalBytes = Math.round((downloadedBytes / completedCount) * segments.length);
        }
    }

    if (speed <= 0 || totalBytes <= downloadedBytes) {
        return 0;
    }

    return Math.ceil((totalBytes - downloadedBytes) / speed);
}

function openSegmentCacheDb() {
    if (!isSegmentCacheAvailable()) {
        return Promise.resolve(null);
    }
    if (segmentCacheDbPromise) {
        return segmentCacheDbPromise;
    }

    segmentCacheDbPromise = new Promise(resolve => {
        let request;
        try {
            request = indexedDB.open(SEGMENT_CACHE_DB_NAME, SEGMENT_CACHE_DB_VERSION);
        } catch {
            resolve(null);
            return;
        }

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(SEGMENT_CACHE_STORE_NAME)) {
                db.createObjectStore(SEGMENT_CACHE_STORE_NAME, { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
    });

    return segmentCacheDbPromise;
}

async function runSegmentCacheStoreOperation(mode, operation) {
    const db = await openSegmentCacheDb();
    if (!db) return null;

    return new Promise(resolve => {
        let request;
        try {
            const transaction = db.transaction(SEGMENT_CACHE_STORE_NAME, mode);
            const store = transaction.objectStore(SEGMENT_CACHE_STORE_NAME);
            request = operation(store);
        } catch {
            resolve(null);
            return;
        }

        if (!request) {
            resolve(null);
            return;
        }
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => resolve(null);
    });
}

async function getBrowserStorageEstimate() {
    if (
        typeof navigator === 'undefined'
        || !navigator.storage
        || typeof navigator.storage.estimate !== 'function'
    ) {
        return { usage: 0, quota: 0 };
    }

    try {
        const estimate = await navigator.storage.estimate();
        return {
            usage: Number(estimate?.usage) || 0,
            quota: Number(estimate?.quota) || 0
        };
    } catch {
        return { usage: 0, quota: 0 };
    }
}

async function getSegmentCacheRecords() {
    const db = await openSegmentCacheDb();
    if (!db) return null;

    return new Promise(resolve => {
        const records = [];
        let request;
        try {
            const transaction = db.transaction(SEGMENT_CACHE_STORE_NAME, 'readonly');
            const store = transaction.objectStore(SEGMENT_CACHE_STORE_NAME);
            request = store.openCursor();
        } catch {
            resolve(null);
            return;
        }

        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                resolve(records);
                return;
            }
            records.push(cursor.value);
            cursor.continue();
        };
        request.onerror = () => resolve(null);
    });
}

async function getSegmentCacheStats() {
    const available = isSegmentCacheAvailable();
    const [records, storageEstimate] = await Promise.all([
        available ? getSegmentCacheRecords() : Promise.resolve(null),
        getBrowserStorageEstimate()
    ]);
    const safeRecords = Array.isArray(records) ? records : [];
    const byteCount = safeRecords.reduce((sum, record) => (
        sum + (record?.bytes instanceof Uint8Array ? record.bytes.byteLength : 0)
    ), 0);
    const taskIds = new Set(safeRecords.map(record => String(record?.taskId || '')).filter(Boolean));

    return {
        available,
        recordCount: safeRecords.length,
        byteCount,
        taskCount: taskIds.size,
        storageUsage: storageEstimate.usage,
        storageQuota: storageEstimate.quota
    };
}

async function clearSegmentCache() {
    const db = await openSegmentCacheDb();
    if (!db) return false;

    return new Promise(resolve => {
        let request;
        try {
            const transaction = db.transaction(SEGMENT_CACHE_STORE_NAME, 'readwrite');
            const store = transaction.objectStore(SEGMENT_CACHE_STORE_NAME);
            request = store.clear();
        } catch {
            resolve(false);
            return;
        }

        request.onsuccess = () => resolve(true);
        request.onerror = () => resolve(false);
    });
}

function resetTasksAfterSegmentCacheClear() {
    if (!Array.isArray(currentTasks) || currentTasks.length === 0) return false;

    let changed = false;
    currentTasks = currentTasks.map(task => {
        if (task?.streamSave || !Array.isArray(task?.segments) || task.segments.length === 0) {
            return task;
        }

        let taskChanged = false;
        const nextSegments = task.segments.map(segment => {
            if (segment?.status !== 'success' || segment.streamSaved === true) {
                return segment;
            }

            taskChanged = true;
            return {
                ...segment,
                status: 'idle',
                bytes: null,
                byteLength: 0,
                cacheStored: false,
                streamSaved: false,
                attemptCount: 0,
                errorMessage: ''
            };
        });

        if (!taskChanged) {
            return task;
        }

        changed = true;
        const nextProgress = updateTaskProgressFromSegments({
            ...task,
            segments: nextSegments
        });
        const downloadedBytes = nextSegments.reduce((sum, segment) => (
            sum + (hasDownloadedSegmentBytes(segment) ? segment.bytes.byteLength : 0)
        ), 0);
        const nextStatus = task.status === 'completed'
            ? 'recoverable'
            : task.status;

        return {
            ...task,
            status: nextStatus,
            segments: nextSegments,
            progress: nextProgress,
            downloadedBytes,
            totalBytes: downloadedBytes,
            errorMessage: '本地缓存已清空，已下载分片需要重新下载。'
        };
    });

    if (changed) {
        saveTasksToStorage();
        renderTasks();
        syncActiveTaskDetails();
    }

    return changed;
}

async function cleanupOrphanedSegmentCache() {
    const activeTaskIds = new Set((Array.isArray(currentTasks) ? currentTasks : []).map(task => String(task.id)));
    const db = await openSegmentCacheDb();
    if (!db) return { removedCount: 0, available: false };

    return new Promise(resolve => {
        let removedCount = 0;
        let request;
        try {
            const transaction = db.transaction(SEGMENT_CACHE_STORE_NAME, 'readwrite');
            const store = transaction.objectStore(SEGMENT_CACHE_STORE_NAME);
            request = store.openCursor();
        } catch {
            resolve({ removedCount: 0, available: false });
            return;
        }

        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                resolve({ removedCount, available: true });
                return;
            }

            const taskId = String(cursor.value?.taskId || '');
            if (!taskId || !activeTaskIds.has(taskId)) {
                cursor.delete();
                removedCount += 1;
            }
            cursor.continue();
        };
        request.onerror = () => resolve({ removedCount, available: false });
    });
}

function getSegmentCacheStatusElements() {
    if (segmentCacheStatusElements) {
        return segmentCacheStatusElements;
    }

    segmentCacheStatusElements = {
        availabilityEl: document.getElementById('segment-cache-availability'),
        recordsEl: document.getElementById('segment-cache-records'),
        bytesEl: document.getElementById('segment-cache-bytes'),
        storageEl: document.getElementById('segment-cache-storage'),
        cleanBtn: document.getElementById('segment-cache-clean-orphans-btn'),
        clearBtn: document.getElementById('segment-cache-clear-btn')
    };
    return segmentCacheStatusElements;
}

function renderSegmentCacheStatsToStatusBar(stats) {
    const {
        availabilityEl,
        recordsEl,
        bytesEl,
        storageEl,
        cleanBtn,
        clearBtn
    } = getSegmentCacheStatusElements();

    if (availabilityEl) {
        availabilityEl.textContent = stats.available ? '可用' : '不可用';
    }
    if (recordsEl) {
        recordsEl.textContent = `${stats.recordCount} 个`;
    }
    if (bytesEl) {
        bytesEl.textContent = formatStorageBytes(stats.byteCount);
    }
    if (storageEl) {
        const usage = formatStorageBytes(stats.storageUsage);
        const quota = stats.storageQuota > 0 ? formatStorageBytes(stats.storageQuota) : '未知';
        storageEl.textContent = `${usage} / ${quota}`;
    }
    [cleanBtn, clearBtn].forEach(button => {
        if (!button) return;
        button.disabled = !stats.available;
    });
}

async function renderSegmentCacheStatusBar() {
    renderSegmentCacheStatsToStatusBar({
        available: isSegmentCacheAvailable(),
        recordCount: 0,
        byteCount: 0,
        storageUsage: 0,
        storageQuota: 0
    });
    const stats = await getSegmentCacheStats();
    renderSegmentCacheStatsToStatusBar(stats);
    return stats;
}

async function handleCleanupOrphanedSegmentCache() {
    const result = await cleanupOrphanedSegmentCache();
    await renderSegmentCacheStatusBar();
    if (!result.available) {
        showToast('本地缓存不可用，无法清理', { type: 'error' });
        return;
    }
    showToast(result.removedCount > 0 ? `已清理 ${result.removedCount} 个无效缓存` : '没有需要清理的无效缓存', { type: 'success' });
}

async function handleClearSegmentCache() {
    const confirmed = typeof confirmTaskDeletion === 'function'
        ? await confirmTaskDeletion([{
            title: '全部本地分片缓存',
            status: 'paused'
        }])
        : true;
    if (!confirmed) return;

    const cleared = await clearSegmentCache();
    const affectedTasks = cleared ? resetTasksAfterSegmentCacheClear() : false;
    await renderSegmentCacheStatusBar();
    showToast(cleared
        ? (affectedTasks ? '已清空缓存，相关任务需重新下载已清空分片' : '已清空本地分片缓存')
        : '本地缓存不可用，无法清空', {
        type: cleared ? 'success' : 'error'
    });
}

function putCachedSegmentBytes(taskId, sequence, bytes) {
    if (!isSegmentCacheEnabled()) {
        return Promise.resolve(false);
    }
    if (!(bytes instanceof Uint8Array)) {
        return Promise.resolve(false);
    }

    const normalizedTaskId = String(taskId || '');
    const normalizedSequence = Number(sequence);
    if (!normalizedTaskId || !Number.isFinite(normalizedSequence) || normalizedSequence <= 0) {
        return Promise.resolve(false);
    }

    return runSegmentCacheStoreOperation('readwrite', store => store.put({
        id: getSegmentCacheKey(normalizedTaskId, normalizedSequence),
        taskId: normalizedTaskId,
        sequence: normalizedSequence,
        bytes,
        byteLength: bytes.byteLength,
        updatedAt: Date.now()
    })).then(result => result != null).then(success => {
        if (!success && !hasShownSegmentCacheWriteWarning) {
            hasShownSegmentCacheWriteWarning = true;
            if (typeof showToast === 'function') {
                showToast('本地缓存空间不足，刷新后可能无法恢复已下载分片', { type: 'error', duration: 3600 });
            }
        }
        return success;
    });
}

function getCachedSegmentBytes(taskId, sequence) {
    const normalizedTaskId = String(taskId || '');
    const normalizedSequence = Number(sequence);
    if (!normalizedTaskId || !Number.isFinite(normalizedSequence) || normalizedSequence <= 0) {
        return Promise.resolve(null);
    }

    return runSegmentCacheStoreOperation('readonly', store => (
        store.get(getSegmentCacheKey(normalizedTaskId, normalizedSequence))
    )).then(record => (
        record?.bytes instanceof Uint8Array
            ? record.bytes
            : null
    ));
}

function getCachedSegmentMetadata(taskId, sequence) {
    if (!isSegmentCacheEnabled()) {
        return Promise.resolve({ exists: false, byteLength: 0 });
    }

    const normalizedTaskId = String(taskId || '');
    const normalizedSequence = Number(sequence);
    if (!normalizedTaskId || !Number.isFinite(normalizedSequence) || normalizedSequence <= 0) {
        return Promise.resolve({ exists: false, byteLength: 0 });
    }

    return runSegmentCacheStoreOperation('readonly', store => (
        typeof store.getKey === 'function'
            ? store.getKey(getSegmentCacheKey(normalizedTaskId, normalizedSequence))
            : store.get(getSegmentCacheKey(normalizedTaskId, normalizedSequence))
    )).then(result => ({
        exists: result != null,
        byteLength: Math.max(0, Number(result?.byteLength) || 0)
    }));
}

async function hydrateTaskSegmentsFromCache(task) {
    if (!isSegmentCacheEnabled()) {
        return task;
    }
    if (!task || task.streamSave || !Array.isArray(task.segments) || task.segments.length === 0) {
        return task;
    }

    let hadMissingCachedSuccessBytes = false;
    const restoredSegments = await Promise.all(task.segments.map(async (segment, index) => {
        if (segment?.status !== 'success'
            || segment.bytes instanceof Uint8Array
            || segment.streamSaved === true) {
            return segment;
        }

        const sequence = Number.isFinite(Number(segment?.sequence)) ? Number(segment.sequence) : index + 1;
        const cachedMetadata = await getCachedSegmentMetadata(task.id, sequence);
        if (cachedMetadata.exists) {
            return {
                ...segment,
                bytes: null,
                byteLength: Math.max(0, Number(segment?.byteLength) || cachedMetadata.byteLength),
                cacheStored: true,
                streamSaved: false,
                errorMessage: ''
            };
        }

        hadMissingCachedSuccessBytes = true;
        return {
            ...segment,
            status: 'idle',
            bytes: null,
            byteLength: 0,
            cacheStored: false,
            streamSaved: false,
            attemptCount: 0,
            errorMessage: ''
        };
    }));
    const downloadedBytes = restoredSegments.reduce((sum, segment) => (
        sum + (hasDownloadedSegmentBytes(segment)
            ? segment.bytes.byteLength
            : (segment?.cacheStored ? Math.max(0, Number(segment?.byteLength) || 0) : 0))
    ), 0);
    const progress = updateTaskProgressFromSegments({
        ...task,
        segments: restoredSegments
    });
    const normalizedProgress = task.status === 'completed' && progress < 100
        ? 100
        : progress;

    return {
        ...task,
        segments: restoredSegments,
        downloadedBytes,
        totalBytes: downloadedBytes,
        progress: normalizedProgress,
        errorMessage: hadMissingCachedSuccessBytes
            ? '恢复信息不完整，部分已完成分片缓存缺失，请重新下载未完成内容。'
            : task.errorMessage
    };
}

function deleteCachedSegment(taskId, sequence) {
    const normalizedTaskId = String(taskId || '');
    const normalizedSequence = Number(sequence);
    if (!normalizedTaskId || !Number.isFinite(normalizedSequence) || normalizedSequence <= 0) {
        return Promise.resolve(false);
    }

    return runSegmentCacheStoreOperation('readwrite', store => (
        store.delete(getSegmentCacheKey(normalizedTaskId, normalizedSequence))
    )).then(() => true);
}

async function deleteCachedSegmentsForTasks(taskIds) {
    const normalizedTaskIds = new Set(
        (Array.isArray(taskIds) ? taskIds : [taskIds])
            .map(taskId => String(taskId || ''))
            .filter(Boolean)
    );
    if (normalizedTaskIds.size === 0) return false;

    const db = await openSegmentCacheDb();
    if (!db) return false;

    return new Promise(resolve => {
        let request;
        try {
            const transaction = db.transaction(SEGMENT_CACHE_STORE_NAME, 'readwrite');
            const store = transaction.objectStore(SEGMENT_CACHE_STORE_NAME);
            request = store.openCursor();
        } catch {
            resolve(false);
            return;
        }

        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                resolve(true);
                return;
            }
            if (normalizedTaskIds.has(String(cursor.value?.taskId || ''))) {
                cursor.delete();
            }
            cursor.continue();
        };
        request.onerror = () => resolve(false);
    });
}

function deleteCachedSegmentsForTask(taskId) {
    return deleteCachedSegmentsForTasks([taskId]);
}

async function hydrateRestoredTasksFromSegmentCache() {
    if (!Array.isArray(currentTasks) || currentTasks.length === 0) return;
    const hydratedTasks = await Promise.all(currentTasks.map(task => hydrateTaskSegmentsFromCache(task)));
    currentTasks = hydratedTasks;
    if (typeof saveTasksToStorage === 'function') {
        saveTasksToStorage();
    }
    renderTasks();
}

async function cleanupOrphanedSegmentCacheOnStartup() {
    if (!isSegmentCacheAvailable()) return;
    await cleanupOrphanedSegmentCache();
}

function getPersistableSegmentSnapshot(segment, index) {
    const normalizeByteRange = (byteRange) => {
        if (!byteRange || typeof byteRange !== 'object') return null;
        const length = Number(byteRange.length);
        const offset = Number(byteRange.offset);
        if (!Number.isSafeInteger(length) || length <= 0) return null;
        if (!Number.isSafeInteger(offset) || offset < 0) return null;
        return { length, offset };
    };
    const normalizeInitSegment = (initSegment) => {
        if (!initSegment || typeof initSegment !== 'object') return null;
        const url = String(initSegment.url || '');
        if (!url) return null;
        return {
            url,
            byteRange: normalizeByteRange(initSegment.byteRange)
        };
    };

    return {
        sequence: Number.isFinite(Number(segment?.sequence)) ? Number(segment.sequence) : index + 1,
        mediaSequence: Number.isFinite(Number(segment?.mediaSequence)) ? Number(segment.mediaSequence) : 0,
        url: typeof segment?.url === 'string' ? segment.url : '',
        durationSeconds: Number(segment?.durationSeconds) || 0,
        container: String(segment?.container || 'transport-stream'),
        byteRange: normalizeByteRange(segment?.byteRange),
        initSegment: normalizeInitSegment(segment?.initSegment),
        encryption: segment?.encryption && typeof segment.encryption === 'object'
            ? {
                method: String(segment.encryption.method || ''),
                keyUri: String(segment.encryption.keyUri || ''),
                iv: segment.encryption.iv == null ? null : String(segment.encryption.iv),
                rawTag: String(segment.encryption.rawTag || '')
            }
            : null,
        status: typeof segment?.status === 'string' ? segment.status : 'idle',
        bytes: null,
        byteLength: Math.max(0, Number(segment?.byteLength) || Number(segment?.bytes?.byteLength) || 0),
        cacheStored: Boolean(segment?.cacheStored),
        streamSaved: Boolean(segment?.streamSaved),
        attemptCount: Number(segment?.attemptCount) || 0,
        errorMessage: typeof segment?.errorMessage === 'string' ? segment.errorMessage : ''
    };
}

function getPersistableTaskSnapshot(task) {
    return {
        id: String(task?.id || ''),
        title: String(task?.title || ''),
        url: String(task?.url || ''),
        format: task?.format === 'mp4' ? 'mp4' : 'ts',
        duration: String(task?.duration || '00:00:00'),
        streamSave: Boolean(task?.streamSave),
        actualWriteMode: normalizeActualWriteMode(task?.actualWriteMode),
        concurrency: normalizeConcurrency(task?.concurrency),
        downloadRangeMode: task?.downloadRangeMode === 'custom' ? 'custom' : 'all',
        status: typeof task?.status === 'string' ? task.status : 'queued',
        progress: normalizeTaskProgress(task?.progress),
        createdAt: Number(task?.createdAt) || 0,
        updatedAt: Number(task?.updatedAt) || 0,
        errorMessage: typeof task?.errorMessage === 'string' ? task.errorMessage : '',
        playlistType: typeof task?.playlistType === 'string' ? task.playlistType : '',
        playlistContainer: String(task?.playlistContainer || ''),
        segmentCount: Number(task?.segmentCount) || 0,
        requestedSegmentCount: Number(task?.requestedSegmentCount) || 0,
        segments: Array.isArray(task?.segments)
            ? task.segments.map((segment, index) => getPersistableSegmentSnapshot(segment, index))
            : [],
        qualities: Array.isArray(task?.qualities)
            ? task.qualities.map(quality => ({
                id: String(quality?.id || ''),
                url: String(quality?.url || ''),
                label: String(quality?.label || ''),
                name: String(quality?.name || ''),
                resolution: String(quality?.resolution || ''),
                bandwidth: String(quality?.bandwidth || ''),
                resolutionPixels: Number(quality?.resolutionPixels) || 0,
                bandwidthValue: Number(quality?.bandwidthValue) || 0,
                isRecommended: Boolean(quality?.isRecommended),
                rawTag: String(quality?.rawTag || '')
            }))
            : [],
        selectedQualityId: typeof task?.selectedQualityId === 'string' ? task.selectedQualityId : '',
        selectedQualityLabel: typeof task?.selectedQualityLabel === 'string' ? task.selectedQualityLabel : '',
        mediaRenditions: Array.isArray(task?.mediaRenditions)
            ? task.mediaRenditions.map(rendition => ({
                id: String(rendition?.id || ''),
                type: String(rendition?.type || ''),
                groupId: String(rendition?.groupId || ''),
                name: String(rendition?.name || ''),
                language: String(rendition?.language || ''),
                uri: String(rendition?.uri || ''),
                channels: String(rendition?.channels || ''),
                default: Boolean(rendition?.default),
                autoselect: Boolean(rendition?.autoselect),
                forced: Boolean(rendition?.forced),
                downloadable: Boolean(rendition?.downloadable),
                rawTag: String(rendition?.rawTag || '')
            }))
            : [],
        selectedAudioRenditionId: String(task?.selectedAudioRenditionId || ''),
        selectedSubtitleRenditionId: String(task?.selectedSubtitleRenditionId || ''),
        selectedOutputMode: String(task?.selectedOutputMode || ''),
        actualOutputMode: String(task?.actualOutputMode || ''),
        actualRangeStart: Number(task?.actualRangeStart) || 0,
        actualRangeEnd: Number(task?.actualRangeEnd) || 0,
        recoveryMode: typeof task?.recoveryMode === 'string' ? task.recoveryMode : '',
        recoveryTargetSequence: Number(task?.recoveryTargetSequence) || 0,
        downloadedBytes: Number(task?.downloadedBytes) || 0,
        totalBytes: Number(task?.totalBytes) || 0,
        downloadSpeedBytesPerSecond: Number(task?.downloadSpeedBytesPerSecond) || 0,
        estimatedRemainingSeconds: Number(task?.estimatedRemainingSeconds) || 0,
        outputFileName: typeof task?.outputFileName === 'string' ? task.outputFileName : '',
        lastForceMergeSummary: task?.lastForceMergeSummary && typeof task.lastForceMergeSummary === 'object'
            ? {
                mode: task.lastForceMergeSummary.mode === 'discrete' ? 'discrete' : 'prefix',
                segmentCount: Number(task.lastForceMergeSummary.segmentCount) || 0,
                outputFileName: String(task.lastForceMergeSummary.outputFileName || ''),
                rangeStart: Number(task.lastForceMergeSummary.rangeStart) || 0,
                rangeEnd: Number(task.lastForceMergeSummary.rangeEnd) || 0,
                createdAt: Number(task.lastForceMergeSummary.createdAt) || 0
            }
            : null
    };
}

function normalizeActualWriteMode(value) {
    if (value === 'file-system' || value === 'stream-saver' || value === 'degraded' || value === 'memory') {
        return value;
    }
    return '';
}

function getTaskActualWriteMode(task) {
    const normalizedMode = normalizeActualWriteMode(task?.actualWriteMode);
    if (normalizedMode) return normalizedMode;
    return task?.streamSave ? 'pending-stream' : 'memory';
}

function getTaskActualWriteModeLabel(task) {
    const mode = getTaskActualWriteMode(task);
    if (mode === 'file-system') return '边下边存';
    if (mode === 'stream-saver') return 'StreamSaver';
    if (mode === 'degraded') return '已降级';
    if (mode === 'memory') return '普通缓存';
    return '边下边存';
}

function getTaskActualWriteModeSummary(task) {
    const mode = getTaskActualWriteMode(task);
    if (mode === 'file-system') return '原生边下边存：分片会直接写入文件，强制合并不可用。';
    if (mode === 'stream-saver') return 'StreamSaver 边下边存：分片会通过兼容方案直接写入文件，强制合并不可用。';
    if (mode === 'degraded') return '已降级为普通缓存下载：当前浏览器不支持边下边存，完成后会按普通方式保存。';
    if (mode === 'memory') return '普通缓存下载：分片会先缓存到本地，完成后再保存。';
    return '边下边存：正在等待下载开始后确认实际写入方式。';
}

function mapRestoredTaskStatus(task) {
    if (['completed', 'await_variant_selection', 'await_range_selection', 'failed', 'partial_completed'].includes(task.status)) {
        return task.status;
    }
    if (['detecting', 'resolving', 'preparing', 'downloading', 'finalizing'].includes(task.status)) {
        return 'recoverable';
    }
    if (task.status === 'paused' || task.status === 'recoverable' || task.status === 'queued') {
        return task.status;
    }
    return 'queued';
}

function loadTasksFromStorage() {
    try {
        const rawValue = localStorage.getItem(TASKS_STORAGE_KEY);
        if (!rawValue) return [];
        const parsed = JSON.parse(rawValue);
        if (!Array.isArray(parsed)) return [];

        return parsed.map(rawTask => {
            const normalizedTask = getPersistableTaskSnapshot(rawTask);
            const hadVolatileSuccessBytes = normalizedTask.segments.some(segment => (
                segment.status === 'success' && !segment.streamSaved
            ));
            const restoredStatus = mapRestoredTaskStatus(normalizedTask);
            const restoredSegments = normalizedTask.segments.map(segment => {
                if (segment.status === 'downloading' || segment.status === 'retrying') {
                    return {
                        ...segment,
                        status: 'idle',
                        bytes: null
                    };
                }
                return {
                    ...segment,
                    bytes: null
                };
            });

            const hasRecoveryGapHint = !isSegmentCacheAvailable()
                && restoredStatus === 'recoverable'
                && hadVolatileSuccessBytes;
            const fallbackSegments = hasRecoveryGapHint
                ? restoredSegments.map(segment => (
                    segment.status === 'success' && !segment.streamSaved
                        ? {
                            ...segment,
                            status: 'idle',
                            attemptCount: 0
                        }
                        : segment
                ))
                : restoredSegments;
            return {
                ...normalizedTask,
                status: restoredStatus,
                segments: fallbackSegments,
                downloadedBytes: 0,
                totalBytes: 0,
                downloadSpeedBytesPerSecond: 0,
                estimatedRemainingSeconds: 0,
                progress: restoredStatus === 'completed'
                    ? 100
                    : updateTaskProgressFromSegments({
                        ...normalizedTask,
                        segments: fallbackSegments
                    }),
                errorMessage: hasRecoveryGapHint
                    ? '恢复信息不完整，已清除仅存在内存中的分片缓存，请重新下载未完成内容。'
                    : normalizedTask.errorMessage
            };
        });
    } catch {
        return [];
    }
}

function saveTasksToStorage() {
    try {
        localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(
            Array.isArray(currentTasks)
                ? currentTasks.map(task => getPersistableTaskSnapshot(task))
                : []
        ));
    } catch {
        // Ignore persistence failures in static-browser mode.
    }
}

function batchPauseSelectedTasks() {
    const selectedTaskIdSet = new Set(getSelectedTasks().map(task => String(task.id)));
    if (selectedTaskIdSet.size === 0) return;

    selectedTaskIdSet.forEach(taskId => {
        const task = findTaskById(taskId);
        if (!task || task.status !== 'queued') return;
        pauseTask(taskId);
    });

    selectedTaskIdSet.forEach(taskId => {
        const task = findTaskById(taskId);
        if (!task || !['downloading', 'detecting', 'resolving'].includes(task.status)) return;
        pauseTask(taskId);
    });
}

function restoreFocusAfterBatchDelete() {
    const fallbackFocusTarget = currentTasks.length > 0
        ? document.getElementById('task-list-select-all-toggle')
        : document.getElementById('hero-new-download-btn');

    if (isFocusableElement(fallbackFocusTarget)) {
        fallbackFocusTarget.focus();
        return;
    }

    const finalFallbackFocusTarget = document.getElementById('theme-toggle-btn');
    if (isFocusableElement(finalFallbackFocusTarget)) {
        finalFallbackFocusTarget.focus();
    }
}

function buildTaskDeletionConfirmationModel(tasks) {
    const taskList = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
    if (taskList.length === 0) return null;

    const downloadingCount = taskList.filter(task => (
        ['downloading', 'detecting', 'resolving', 'queued'].includes(task.status)
    )).length;
    const title = taskList.length === 1 ? '删除任务' : '批量删除任务';
    const message = taskList.length === 1
        ? `确认删除任务“${taskList[0].title || '未命名任务'}”？`
        : `确认删除选中的 ${taskList.length} 个任务？`;
    const hint = downloadingCount > 0
        ? `其中 ${downloadingCount} 个任务正在进行中，确认后会立即中止相关请求。`
        : '删除后不会保留任务记录，此操作不可撤销。';

    return {
        title,
        message,
        hint,
        tasks: taskList
    };
}

function renderDeleteConfirmationModal(model) {
    const titleEl = document.getElementById('confirm-delete-title');
    const messageEl = document.getElementById('confirm-delete-message');
    const hintEl = document.getElementById('confirm-delete-hint');
    if (titleEl) {
        titleEl.textContent = model?.title || '确认删除';
    }
    if (messageEl) {
        messageEl.textContent = model?.message || '确认删除所选任务？';
    }
    if (hintEl) {
        hintEl.textContent = model?.hint || '删除后不会保留任务记录。';
    }
}

function activateModalPanel(modalId) {
    activeModalId = modalId;
    pendingModalId = null;
    isModalClosing = false;
    document.body.classList.add('modal-open');
    modalOverlay.classList.remove('is-closing');
    modalOverlay.classList.add('is-open');
    modalOverlay.setAttribute('aria-hidden', 'false');

    modalPanels.forEach(panel => {
        const isActive = panel.dataset.modal === modalId;
        panel.classList.toggle('is-active', isActive);
        panel.setAttribute('aria-hidden', String(!isActive));
    });
}

function resolvePendingDeleteConfirmation(confirmed) {
    if (!pendingDeleteConfirmation) return;

    const resolver = pendingDeleteConfirmation.resolve;
    pendingDeleteConfirmation = null;
    resolver(Boolean(confirmed));
}

function confirmPendingTaskDeletion() {
    resolvePendingDeleteConfirmation(true);
    closeModal();
}

function cancelPendingTaskDeletion() {
    resolvePendingDeleteConfirmation(false);
}

function confirmTaskDeletion(tasks) {
    const model = buildTaskDeletionConfirmationModel(tasks);
    if (!model) return Promise.resolve(false);

    if (pendingDeleteConfirmation) {
        resolvePendingDeleteConfirmation(false);
    }

    const confirmationPromise = new Promise(resolve => {
        pendingDeleteConfirmation = {
            resolve,
            taskIds: model.tasks.map(task => String(task.id))
        };
    });

    renderDeleteConfirmationModal(model);
    if (isModalClosing) {
        finalizeModalClose();
    }
    pendingModalId = null;
    openModal('confirm-delete');
    if (activeModalId !== 'confirm-delete') {
        activateModalPanel('confirm-delete');
    }

    return confirmationPromise;
}

function trackRemovedTaskCleanup(cleanupPromise) {
    let trackedPromise;
    trackedPromise = Promise.resolve(cleanupPromise)
        .catch(() => {})
        .finally(() => {
            pendingRemovedTaskCleanups.delete(trackedPromise);
        });
    pendingRemovedTaskCleanups.add(trackedPromise);
    return trackedPromise;
}

async function removeTasksById(taskIds) {
    const selectedTaskIdSet = new Set((Array.isArray(taskIds) ? taskIds : [taskIds]).map(id => String(id)));
    if (selectedTaskIdSet.size === 0) return false;

    if (!currentTasks.some(task => selectedTaskIdSet.has(String(task.id)))) {
        return false;
    }

    selectedTaskIdSet.forEach(taskId => {
        if (typeof cancelPendingTaskFinalExports === 'function') {
            cancelPendingTaskFinalExports(taskId);
        }
        if (typeof revokeTaskDownloadObjectUrls === 'function') {
            revokeTaskDownloadObjectUrls(taskId);
        }
    });

    if (pendingTaskSelectionFocusId) {
        const focusedTaskId = pendingTaskSelectionFocusId.replace('task-select-', '');
        if (selectedTaskIdSet.has(focusedTaskId)) {
            pendingTaskSelectionFocusId = null;
        }
    }

    const settlementPromises = [];
    selectedTaskIdSet.forEach(taskId => {
        if (typeof abortTaskRequests === 'function') {
            abortTaskRequests(taskId);
        }
        const scheduler = globalThis.__downloadRequestScheduler
            || (typeof downloadRequestScheduler !== 'undefined' ? downloadRequestScheduler : null);
        scheduler?.stopTask(taskId);
        if (String(activeTaskId) === String(taskId)) {
            activeTaskId = null;
        }
        const executionPromises = typeof runningTaskExecutionPromises !== 'undefined'
            ? runningTaskExecutionPromises
            : globalThis.__runningTaskExecutionPromises;
        const executionPromise = executionPromises?.get(String(taskId));
        if (executionPromise) {
            settlementPromises.push(Promise.resolve(executionPromise));
        }
        if (typeof waitForStandaloneTaskRequestScopes === 'function') {
            settlementPromises.push(waitForStandaloneTaskRequestScopes(taskId));
        }
        if (typeof abortTaskStreamWriterForTask === 'function') {
            settlementPromises.push(abortTaskStreamWriterForTask(taskId));
        }
    });

    currentTasks = currentTasks.filter(task => !selectedTaskIdSet.has(String(task.id)));
    selectedTaskIdSet.forEach(id => {
        selectedTaskIds.delete(id);
    });
    if (typeof saveTasksToStorage === 'function') {
        saveTasksToStorage();
    }
    renderTasks();
    scheduleNextQueuedTask();

    const cleanupPromise = Promise.allSettled(settlementPromises).then(async () => {
        selectedTaskIdSet.forEach(taskId => {
            if (typeof clearTaskRequestControllers === 'function') {
                clearTaskRequestControllers(taskId);
            }
            const scheduler = globalThis.__downloadRequestScheduler
                || (typeof downloadRequestScheduler !== 'undefined' ? downloadRequestScheduler : null);
            scheduler?.unregisterTask(taskId);
            const executionStore = typeof runningTaskExecutions !== 'undefined'
                ? runningTaskExecutions
                : globalThis.__runningTaskExecutions;
            executionStore?.delete(String(taskId));
        });
        if (typeof deleteCachedSegmentsForTasks === 'function') {
            await deleteCachedSegmentsForTasks([...selectedTaskIdSet]);
        } else {
            await Promise.allSettled([...selectedTaskIdSet].map(id => deleteCachedSegmentsForTask(id)));
        }
        if (typeof renderSegmentCacheStatusBar === 'function') {
            renderSegmentCacheStatusBar();
        }
    });
    trackRemovedTaskCleanup(cleanupPromise);
    return true;
}

async function batchDeleteSelectedTasks() {
    const selectedTasks = getSelectedTasks();
    if (selectedTasks.length === 0) return;
    if (!await confirmTaskDeletion(selectedTasks)) return;

    const activeElement = document.activeElement;
    const shouldRestoreFocusAfterDelete = activeElement instanceof HTMLElement
        && activeElement.id === 'task-list-batch-delete-btn';

    if (await removeTasksById(selectedTasks.map(task => task.id)) && shouldRestoreFocusAfterDelete) {
        restoreFocusAfterBatchDelete();
    }
}

function getTaskActionIconName(icon) {
    if (icon === 'resume') return 'download';
    if (icon === 'save') return 'download';
    if (icon === 'pause') return 'pause';
    if (icon === 'play') return 'play-circle';
    if (icon === 'merge') return 'combine';
    return 'trash-2';
}

function createTaskActionIcon(icon) {
    const iconName = getTaskActionIconName(icon);
    return `<i data-lucide="${iconName}" aria-hidden="true"></i>`;
}

function createTaskUrlCopyIcon(icon = 'copy', iconClassName = 'task-row__url-icon') {
    return `<span class="${iconClassName}" aria-hidden="true"><i data-lucide="${icon}"></i></span>`;
}

function getTaskRawErrorMessage(task) {
    const taskError = String(task?.errorMessage || '').trim();
    if (taskError) return taskError;

    const failedSegment = Array.isArray(task?.segments)
        ? task.segments.find(segment => String(segment?.errorMessage || '').trim())
        : null;
    return String(failedSegment?.errorMessage || '').trim();
}

function getTaskDisplayErrorMessage(task) {
    return getTaskDisplayErrorInfo(task).message;
}

function getTaskDisplayErrorInfo(task) {
    const rawMessage = getTaskRawErrorMessage(task);
    return getRuntimeErrorInfo(rawMessage, '下载失败');
}

function getTaskStatusIcon(status) {
    if (status === 'queued') return 'filter';
    if (status === 'detecting' || status === 'resolving' || status === 'preparing') return 'search';
    if (status === 'await_variant_selection' || status === 'await_range_selection') return 'sliders-horizontal';
    if (status === 'paused') return 'pause';
    if (status === 'finalizing') return 'package';
    if (status === 'completed') return 'check';
    if (status === 'partial_completed') return 'file-check';
    if (status === 'failed') return 'alert-circle';
    if (status === 'recoverable') return 'refresh-cw';
    return 'circle';
}

function createTaskStatusIcon(status) {
    const icon = getTaskStatusIcon(status);
    return `<i class="task-row__status-icon" data-lucide="${icon}" aria-hidden="true"></i>`;
}

function createTaskStatusTextNode(text) {
    return document.createTextNode(String(text ?? ''));
}

function createTaskStatusContent(task, statusLabel) {
    const safeLabel = escapeHTML(statusLabel);
    if (task?.status === 'downloading' || task?.status === 'finalizing') {
        const speedLabel = formatDownloadSpeed(task?.downloadSpeedBytesPerSecond, task?.status);
        const displayLabel = speedLabel && speedLabel !== '--' ? speedLabel : statusLabel;
        return `<i class="task-row__status-spinner" aria-hidden="true"></i>${escapeHTML(displayLabel)}`;
    }

    const errorInfo = getTaskDisplayErrorInfo(task);
    if (!errorInfo.message || !['failed', 'partial_completed', 'recoverable'].includes(task?.status)) {
        return `${createTaskStatusIcon(task?.status)}${safeLabel}`;
    }

    const taskIdArgument = escapeHTML(JSON.stringify(String(task.id)));
    const errorTooltip = escapeHTML(formatRuntimeErrorDetail(errorInfo));
    const accessibleLabel = escapeHTML(`查看错误：${errorInfo.title}，${errorInfo.message}`);
    return `${createTaskStatusIcon(task?.status)}${safeLabel}<button type="button" class="task-row__status-error-btn" aria-label="${accessibleLabel}" data-tooltip="${errorTooltip}" onpointerdown='handleTaskStatusErrorPointerDown(event, ${taskIdArgument})' onkeydown='handleTaskStatusErrorKeydown(event, ${taskIdArgument})'><i data-lucide="alert-circle" aria-hidden="true"></i></button>`;
}

function getTaskDisplayStatusLabel(task) {
    if (task?.status === 'finalizing') {
        const message = String(task?.finalizingMessage || '').trim();
        if (message) return message;
    }
    return getTaskStatusLabel(task?.status);
}

function getTaskRangeSummaryLabel(task) {
    if (task?.downloadRangeMode !== 'custom') return '';

    const start = Number(task?.actualRangeStart) || 0;
    const end = Number(task?.actualRangeEnd) || 0;
    if (start <= 0 || end < start) return '';

    const total = Number(task?.segmentCount) || 0;
    if (total > 0) {
        return `范围 ${start}-${end} / ${total} 片`;
    }
    return `范围 ${start}-${end}`;
}

function hasCompletedTaskExportData(task) {
    return getCompletedTaskExportParts(task).length > 0;
}

function createTaskCardHTML(task) {
    const rawTitle = task.title || '未命名任务';
    const progress = normalizeTaskProgress(task.progress);
    const format = escapeHTML(task.format || DEFAULT_TASK_PARAMS.format);
    const duration = escapeHTML(task.duration || '00:00:00');
    const status = escapeHTML(task.status || 'downloading');
    const statusLabel = escapeHTML(getTaskDisplayStatusLabel(task));
    const title = escapeHTML(rawTitle);
    const url = escapeHTML(task.url || '');
    const taskIdArgument = escapeHTML(JSON.stringify(String(task.id)));
    const taskSelectionControlId = escapeHTML(getTaskSelectionControlId(task.id));
    const taskUrlButtonId = escapeHTML(getTaskUrlButtonId(task.id));
    const primaryActionLabel = getTaskPrimaryActionLabel(task.status);
    const primaryActionIcon = ['paused', 'failed', 'recoverable', 'partial_completed'].includes(task.status)
        ? createTaskActionIcon('resume')
        : task.status === 'await_range_selection'
            ? createTaskActionIcon('play')
            : createTaskActionIcon('pause');
    const isSelected = isTaskSelected(task.id);
    const selectedAttr = isSelected ? ' checked' : '';
    const rowClassName = isSelected ? 'task-row is-selected' : 'task-row';
    const selectionLabel = escapeHTML(`选择任务 ${rawTitle}`);
    const primaryActionAccessibleLabel = escapeHTML(`${primaryActionLabel}任务 ${rawTitle}`);
    const playActionAccessibleLabel = escapeHTML(`播放任务 ${rawTitle}`);
    const hasCompletedExportData = task.status === 'completed' && hasCompletedTaskExportData(task);
    const saveActionKind = hasCompletedExportData ? 'save' : 'redownload';
    const saveActionClassName = hasCompletedExportData ? 'task-save-btn' : 'task-redownload-btn';
    const saveActionLabel = hasCompletedExportData ? '重新保存' : '重新下载';
    const saveActionAccessibleLabel = escapeHTML(`${saveActionLabel}任务 ${rawTitle}`);
    const mergeActionAccessibleLabel = escapeHTML(`强制合并任务 ${rawTitle}`);
    const deleteActionAccessibleLabel = escapeHTML(`删除任务 ${rawTitle}`);
    const primaryActionTooltip = escapeHTML(primaryActionLabel);
    const playActionTooltip = '播放';
    const saveActionTooltip = saveActionLabel;
    const mergeDisabledReason = getTaskForceMergeDisabledReason(task);
    const mergeActionTooltip = mergeDisabledReason || '强制合并';
    const deleteActionTooltip = '删除';
    const primaryActionTooltipKey = escapeHTML(getTaskListTooltipKey(task.id, 'primary'));
    const playActionTooltipKey = escapeHTML(getTaskListTooltipKey(task.id, 'play'));
    const saveActionTooltipKey = escapeHTML(getTaskListTooltipKey(task.id, 'save'));
    const mergeActionTooltipKey = escapeHTML(getTaskListTooltipKey(task.id, 'merge'));
    const deleteActionTooltipKey = escapeHTML(getTaskListTooltipKey(task.id, 'delete'));
    const urlActionFocusKey = escapeHTML(getTaskListFocusKey(task.id, 'url'));
    const progressActionFocusKey = escapeHTML(getTaskListFocusKey(task.id, 'progress'));
    const primaryActionFocusKey = escapeHTML(getTaskListFocusKey(task.id, 'primary'));
    const playActionFocusKey = escapeHTML(getTaskListFocusKey(task.id, 'play'));
    const saveActionFocusKey = escapeHTML(getTaskListFocusKey(task.id, 'save'));
    const mergeActionFocusKey = escapeHTML(getTaskListFocusKey(task.id, 'merge'));
    const deleteActionFocusKey = escapeHTML(getTaskListFocusKey(task.id, 'delete'));
    const canForceMerge = canTaskRequestForceMerge(task);
    const hasForceMergeContent = countForceMergeAvailableSegments(task) > 0;
    const shouldShowForceMergeAction = !task.streamSave
        && hasForceMergeContent
        && (canForceMerge || Boolean(mergeDisabledReason));
    const statusContent = createTaskStatusContent(task, statusLabel);
    const writeMode = getTaskActualWriteMode(task);
    const writeModeLabel = getTaskActualWriteModeLabel(task);
    const writeModeSummary = getTaskActualWriteModeSummary(task);
    const streamSaveModeTag = task.streamSave || writeMode === 'degraded'
        ? `<span class="task-row__mode-tag" data-write-mode="${escapeHTML(writeMode)}" title="${escapeHTML(writeModeSummary)}">${escapeHTML(writeModeLabel)}</span>`
        : '';
    const rangeSummaryLabel = getTaskRangeSummaryLabel(task);
    const rangeSummaryTag = rangeSummaryLabel
        ? `<span class="task-row__range">${escapeHTML(rangeSummaryLabel)}</span>`
        : '';
    const progressClassName = task.status === 'downloading' || task.status === 'finalizing'
        ? 'task-row__progress is-active-download'
        : 'task-row__progress';
    const primaryActionHTML = primaryActionLabel
        ? `<button type="button" class="task-action-btn task-toggle-btn" aria-label="${primaryActionAccessibleLabel}" data-tooltip="${primaryActionTooltip}" data-tooltip-key="${primaryActionTooltipKey}" data-focus-key="${primaryActionFocusKey}" onpointerdown='handleTaskRowPrimaryActionPointerDown(event, ${taskIdArgument})' onkeydown='handleTaskRowPrimaryActionKeydown(event, ${taskIdArgument})'>${primaryActionIcon}</button>`
        : '';
    const forceMergeActionHTML = shouldShowForceMergeAction
        ? `<button type="button" class="task-action-btn task-merge-btn${canForceMerge ? '' : ' is-disabled'}" aria-label="${canForceMerge ? mergeActionAccessibleLabel : escapeHTML(`${mergeActionTooltip}任务 ${rawTitle}`)}" data-tooltip="${escapeHTML(mergeActionTooltip)}" data-tooltip-key="${mergeActionTooltipKey}" data-focus-key="${mergeActionFocusKey}" ${canForceMerge ? '' : 'aria-disabled="true" '}onpointerdown='handleTaskRowActionPointerDown(event, ${taskIdArgument}, "merge")' onkeydown='handleTaskRowActionKeydown(event, ${taskIdArgument}, "merge")'>${createTaskActionIcon('merge')}</button>`
        : '';
    const saveActionHTML = task.status === 'completed'
        ? `<button type="button" class="task-action-btn ${saveActionClassName}" aria-label="${saveActionAccessibleLabel}" data-tooltip="${saveActionTooltip}" data-tooltip-key="${saveActionTooltipKey}" data-focus-key="${saveActionFocusKey}" onpointerdown='handleTaskRowActionPointerDown(event, ${taskIdArgument}, "${saveActionKind}")' onkeydown='handleTaskRowActionKeydown(event, ${taskIdArgument}, "${saveActionKind}")'>${createTaskActionIcon('save')}</button>`
        : '';
    const progressAccessibleLabel = escapeHTML(`查看任务 ${rawTitle} 的视频碎片详情`);

    return `
        <article class="${rowClassName}" data-task-id="${task.id}">
            <div class="task-row__select">
                <input
                    type="checkbox"
                    id="${taskSelectionControlId}"
                    class="task-row__checkbox"
                    aria-label="${selectionLabel}"
                    onclick='toggleTaskSelection(${taskIdArgument})'${selectedAttr}
                >
            </div>
            <div class="task-row__content">
                <div class="task-row__heading">
                    <span class="task-row__format">${format}</span>
                    <span class="task-row__duration">${duration}</span>
                    <h3 class="task-row__title">${title}</h3>
                    <div class="task-row__meta">
                        ${streamSaveModeTag}
                        ${rangeSummaryTag}
                        <span class="task-row__status" data-status="${status}">${statusContent}</span>
                    </div>
                </div>
                <button
                    type="button"
                    id="${taskUrlButtonId}"
                    class="task-row__url"
                    title="${url}"
                    aria-label="${escapeHTML(`复制任务链接：${task.url || ''}`)}"
                    data-focus-key="${urlActionFocusKey}"
                    onpointerdown='handleTaskUrlPointerDown(event, ${taskIdArgument})'
                    onkeydown='handleTaskUrlKeydown(event, ${taskIdArgument})'
                >${createTaskUrlCopyIcon()}<span class="task-row__url-text">${url}</span></button>
                <div
                    class="${progressClassName}"
                    role="button"
                    tabindex="0"
                    aria-label="${progressAccessibleLabel}"
                    data-focus-key="${progressActionFocusKey}"
                    onpointerdown='openTaskFragmentDetails(${taskIdArgument})'
                    onkeydown='handleTaskProgressKeydown(event, ${taskIdArgument})'
                >
                    <div class="task-row__progress-track" aria-hidden="true">
                        <div class="task-row__progress-bar" style="width: ${progress}%;"></div>
                    </div>
                    <span class="task-row__progress-text">${progress}%</span>
                </div>
            </div>
            <div class="task-row__actions">
                ${primaryActionHTML}
                ${forceMergeActionHTML}
                ${saveActionHTML}
                <button type="button" class="task-action-btn task-play-btn" aria-label="${playActionAccessibleLabel}" data-tooltip="${playActionTooltip}" data-tooltip-key="${playActionTooltipKey}" data-focus-key="${playActionFocusKey}" onpointerdown='handleTaskRowActionPointerDown(event, ${taskIdArgument}, "play")' onkeydown='handleTaskRowActionKeydown(event, ${taskIdArgument}, "play")'>${createTaskActionIcon('play')}</button>
                <button type="button" class="task-action-btn task-delete-btn" aria-label="${deleteActionAccessibleLabel}" data-tooltip="${deleteActionTooltip}" data-tooltip-key="${deleteActionTooltipKey}" data-focus-key="${deleteActionFocusKey}" onpointerdown='handleTaskRowActionPointerDown(event, ${taskIdArgument}, "delete")' onkeydown='handleTaskRowActionKeydown(event, ${taskIdArgument}, "delete")'>${createTaskActionIcon('delete')}</button>
            </div>
        </article>
    `;
}

function getTaskStatusLabel(status) {
    if (status === 'queued') return '排队中';
    if (status === 'detecting') return '识别中';
    if (status === 'resolving') return '解析中';
    if (status === 'await_variant_selection') return '待选清晰度';
    if (status === 'await_range_selection') return '待确认范围';
    if (status === 'preparing') return '准备中';
    if (status === 'paused') return '已暂停';
    if (status === 'completed') return '已完成';
    if (status === 'partial_completed') return '部分完成';
    if (status === 'recoverable') return '可继续';
    if (status === 'finalizing') return '导出中';
    if (status === 'failed') return '下载失败';
    return '下载中';
}

function getTaskPrimaryActionLabel(status) {
    if (status === 'await_range_selection') return '确认范围';
    if (['paused', 'failed', 'recoverable', 'partial_completed'].includes(status)) return '继续';
    if (status === 'paused') return '继续';
    if (status === 'completed') return '';
    return '暂停';
}

function normalizeTaskProgress(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return 0;
    return Math.min(100, Math.max(0, Math.round(numericValue)));
}

function hasDownloadedSegmentBytes(segment) {
    return segment?.status === 'success' && segment.bytes instanceof Uint8Array;
}

function hasCompletedSegment(segment) {
    return segment?.status === 'success'
        && (
            segment.bytes instanceof Uint8Array
            || segment.streamSaved === true
            || segment.cacheStored === true
        );
}

function hasSegmentRuntimeMetadata(segment) {
    if (!segment || typeof segment.url !== 'string' || !segment.url.trim()) {
        return false;
    }

    if (!Number.isFinite(Number(segment.mediaSequence))) {
        return false;
    }

    if (!Number.isFinite(Number(segment.durationSeconds))) {
        return false;
    }

    if (segment.encryption == null) {
        return Object.prototype.hasOwnProperty.call(segment, 'encryption');
    }

    return typeof segment.encryption === 'object'
        && typeof segment.encryption.method === 'string'
        && (
            String(segment.encryption.method).toUpperCase() === 'NONE'
            || typeof segment.encryption.keyUri === 'string'
        );
}

function getTaskFragmentItems(task) {
    if (!Array.isArray(task?.segments) || task.segments.length === 0) {
        return [];
    }

    return task.segments.map((segment, index) => ({
        sequence: Number.isFinite(Number(segment?.sequence)) ? Number(segment.sequence) : index + 1,
        status: segment?.status || 'idle',
        bytes: segment?.bytes ?? null,
        attemptCount: Number(segment?.attemptCount) || 0,
        errorMessage: typeof segment?.errorMessage === 'string' ? segment.errorMessage : '',
        url: segment?.url || ''
    }));
}

function getTaskFragmentSummary(task) {
    const sourceSegments = Array.isArray(task?.segments) ? task.segments : [];
    const runtimeSegments = getEffectiveTaskSegments(task);
    const fragments = getTaskFragmentItems({
        ...task,
        segments: runtimeSegments
    });
    void sourceSegments;
    const total = fragments.length;
    const downloaded = runtimeSegments.filter(segment => hasCompletedSegment(segment)).length;
    const errors = fragments.filter(fragment => fragment.status === 'failed').length;
    const progress = updateTaskProgressFromSegments({ segments: runtimeSegments });

    return { total, downloaded, errors, progress, fragments };
}

function getTaskFragmentStatusLabel(status) {
    if (status === 'success') return '下载成功';
    if (status === 'failed') return '下载失败';
    if (status === 'retrying') return '重试中';
    if (status === 'downloading') return '下载中';
    return '未下载';
}

function getTaskPlaylistTypeLabel(task) {
    if (task?.playlistType === 'media') return 'Media Playlist';
    if (task?.playlistType === 'master') return 'Master Playlist';
    if (Array.isArray(task?.qualities) && task.qualities.length > 0) return 'Master Playlist';
    return '待识别';
}

function getTaskEncryptionSummary(task) {
    const segments = Array.isArray(task?.segments) ? task.segments : [];
    const encryptedSegment = segments.find(segment => segment?.encryption?.method);
    return encryptedSegment?.encryption?.method ? String(encryptedSegment.encryption.method) : '无加密';
}

function getTaskRangeContextLabel(task) {
    if (task?.downloadRangeMode === 'custom') {
        const start = Number(task?.actualRangeStart) || 0;
        const end = Number(task?.actualRangeEnd) || 0;
        if (start > 0 && end >= start) {
            return `${start}-${end}`;
        }
        return '待确认';
    }

    const total = Number(task?.requestedSegmentCount || task?.segmentCount) || 0;
    return total > 0 ? `全部 ${total} 片` : '全部';
}

function getTaskRecoveryContextLabel(task) {
    if (task?.recoveryMode === 'incomplete') return '恢复全部未完成分片';
    if (task?.recoveryMode === 'single') {
        const sequence = Number(task?.recoveryTargetSequence) || 0;
        return sequence > 0 ? `恢复第 ${sequence} 片` : '恢复单个分片';
    }
    if (task?.status === 'recoverable') return '可继续恢复';
    return '无恢复请求';
}

function renderTaskRequestContext(task, summary) {
    const safeTask = task ?? {};
    const errorInfo = getTaskDisplayErrorInfo(safeTask);
    const contextItems = [
        ['播放列表', getTaskPlaylistTypeLabel(safeTask)],
        ['已选清晰度', safeTask.selectedQualityLabel || '未选择'],
        ['实际范围', getTaskRangeContextLabel(safeTask)],
        ['任务分片', `${Number(summary?.total) || 0} / 原始 ${Number(safeTask.segmentCount) || Number(summary?.total) || 0}`],
        ['写入模式', getTaskActualWriteModeLabel(safeTask)],
        ['加密方式', getTaskEncryptionSummary(safeTask)],
        ['恢复状态', getTaskRecoveryContextLabel(safeTask)],
        ['错误类型', errorInfo.message ? errorInfo.title : '无'],
        ['错误原因', errorInfo.message || '无'],
        ['建议处理', errorInfo.message ? errorInfo.suggestion : '无']
    ];

    return `
        <dl class="task-fragment-detail__context" aria-label="诊断信息">
            ${contextItems.map(([label, value]) => `
                <div class="task-fragment-detail__context-item">
                    <dt>${escapeHTML(label)}</dt>
                    <dd>${escapeHTML(value)}</dd>
                </div>
            `).join('')}
        </dl>
    `;
}

function canTaskForceMerge(task) {
    if (task?.streamSave) return false;
    return ['paused', 'failed', 'recoverable', 'partial_completed'].includes(task?.status);
}

function canTaskRequestForceMerge(task) {
    if (task?.streamSave) return false;
    return canTaskForceMerge(task) || ['downloading', 'detecting', 'resolving', 'queued'].includes(task?.status);
}

function getTaskForceMergeDisabledReason(task) {
    if (task?.streamSave) {
        return '边下边存模式无法强制合并';
    }
    return '';
}

function countForceMergeAvailableSegments(task) {
    const segments = getEffectiveTaskSegments(task);
    return segments.filter(segment => hasCompletedSegment(segment)).length;
}

function summarizeForceMergeSegments(task, mode = 'prefix') {
    const normalizedMode = mode === 'discrete' ? 'discrete' : 'prefix';
    const { exportableSegments, missingSuccessfulBytes } = collectForceMergeSegments(task, normalizedMode);
    const durationSeconds = exportableSegments.reduce((total, segment) => {
        const segmentDuration = Number(segment?.durationSeconds);
        return total + (Number.isFinite(segmentDuration) && segmentDuration > 0 ? segmentDuration : 0);
    }, 0);

    return {
        exportableSegments,
        missingSuccessfulBytes,
        count: exportableSegments.length,
        durationSeconds
    };
}

function isForceMergeExportTooShort(summary, mode) {
    if (mode === 'discrete') {
        return false;
    }

    const durationSeconds = Number(summary?.durationSeconds) || 0;
    return durationSeconds > 0 && durationSeconds < MIN_FORCE_MERGE_PREFIX_DURATION_SECONDS;
}

function getTaskDetailPrimaryActionLabel(status) {
    if (status === 'await_range_selection') return '确认范围';
    if (['paused', 'failed', 'recoverable', 'partial_completed'].includes(status)) return '继续';
    if (['queued', 'detecting', 'resolving', 'downloading'].includes(status)) return '暂停';
    return '';
}

function renderTaskFragmentDetails(task) {
    const safeTask = task ?? {};
    const sourceSegments = Array.isArray(safeTask?.segments) ? safeTask.segments : [];
    const runtimeSegments = getEffectiveTaskSegments(safeTask);
    const title = escapeHTML(safeTask.title || '未命名任务');
    const taskUrl = String(safeTask.url || '');
    const safeTaskUrl = escapeHTML(taskUrl);
    const taskIdArgument = escapeHTML(JSON.stringify(String(safeTask.id ?? '')));
    const taskDetailUrlButtonId = escapeHTML(getTaskDetailUrlButtonId(safeTask.id ?? ''));
    const blockedMergeTooltip = getTaskForceMergeDisabledReason(safeTask) || '先暂停再强制合并';
    const blockedMergeAccessibleLabel = escapeHTML(`${blockedMergeTooltip}任务 ${safeTask.title || '未命名任务'}`);
    const summary = getTaskFragmentSummary({
        ...safeTask,
        segments: runtimeSegments
    });
    const titleBadges = [
        `<span class="task-fragment-detail__title-badge">${escapeHTML((safeTask.format || DEFAULT_TASK_PARAMS.format).toUpperCase())}</span>`,
        safeTask.downloadRangeMode === 'custom' && safeTask.actualRangeStart > 0 && safeTask.actualRangeEnd > 0
            ? `<span class="task-fragment-detail__title-badge">范围 ${escapeHTML(safeTask.actualRangeStart)}-${escapeHTML(safeTask.actualRangeEnd)}</span>`
            : '',
        safeTask.streamSave || getTaskActualWriteMode(safeTask) === 'degraded'
            ? `<span class="task-fragment-detail__title-badge" data-write-mode="${escapeHTML(getTaskActualWriteMode(safeTask))}">${escapeHTML(getTaskActualWriteModeLabel(safeTask))}</span>`
            : ''
    ].filter(Boolean).join('');
    const qualitySummary = safeTask.selectedQualityLabel
        ? `<p class="task-fragment-detail__quality">已选清晰度：${escapeHTML(safeTask.selectedQualityLabel)}</p>`
        : '';
    const streamSaveSummary = safeTask.streamSave || getTaskActualWriteMode(safeTask) === 'degraded'
        ? `<p class="task-fragment-detail__quality">${escapeHTML(getTaskActualWriteModeSummary(safeTask))}</p>`
        : '';
    const rangeSummary = safeTask.status === 'await_range_selection'
        ? `<p class="task-fragment-detail__quality">尚未确认下载范围 · 共 ${Number(safeTask.segmentCount) || 0} 片</p>`
        : '';
    const forceMergeSummary = safeTask.lastForceMergeSummary
        ? `<p class="task-fragment-detail__quality">最近强制合并：${escapeHTML(getForceMergeModeLabel(safeTask.lastForceMergeSummary.mode))} · ${escapeHTML(safeTask.lastForceMergeSummary.segmentCount || 0)} 片</p>`
        : '';
    const rawTitle = safeTask.title || '未命名任务';
    const detailPrimaryActionLabel = getTaskDetailPrimaryActionLabel(safeTask.status);
    const detailPrimaryActionIcon = detailPrimaryActionLabel === '暂停'
        ? 'pause'
        : detailPrimaryActionLabel === '确认范围'
            ? 'play'
            : 'resume';
    const detailPrimaryActionAccessibleLabel = escapeHTML(`${detailPrimaryActionLabel}任务 ${rawTitle}`);
    const detailPrimaryAction = detailPrimaryActionLabel
        ? `<button type="button" class="task-fragment-detail__icon-btn" data-detail-primary-action="true" data-current-icon="${escapeHTML(detailPrimaryActionIcon)}" aria-label="${detailPrimaryActionAccessibleLabel}" data-tooltip="${escapeHTML(detailPrimaryActionLabel)}" onpointerdown='handleTaskDetailPrimaryActionPointerDown(event, ${taskIdArgument})' onkeydown='handleTaskDetailPrimaryActionKeydown(event, ${taskIdArgument})'>${createTaskActionIcon(detailPrimaryActionIcon)}</button>`
        : '';
    const playAction = `<button type="button" class="task-fragment-detail__icon-btn" aria-label="${escapeHTML(`播放任务 ${rawTitle}`)}" data-tooltip="播放" onpointerdown='handleTaskDetailPlayPointerDown(event, ${taskIdArgument})' onkeydown='handleTaskDetailPlayKeydown(event, ${taskIdArgument})'>${createTaskActionIcon('play')}</button>`;
    const hasCompletedExportData = safeTask.status === 'completed' && hasCompletedTaskExportData(safeTask);
    const saveAction = safeTask.status === 'completed'
        ? hasCompletedExportData
            ? `<button type="button" class="task-fragment-detail__icon-btn task-fragment-detail__save-btn" aria-label="${escapeHTML(`重新保存任务 ${rawTitle}`)}" data-tooltip="重新保存" onpointerdown='handleTaskDetailSavePointerDown(event, ${taskIdArgument})' onkeydown='handleTaskDetailSaveKeydown(event, ${taskIdArgument})'>${createTaskActionIcon('save')}</button>`
            : `<button type="button" class="task-fragment-detail__icon-btn task-fragment-detail__redownload-btn" aria-label="${escapeHTML(`重新下载任务 ${rawTitle}`)}" data-tooltip="重新下载" onpointerdown='handleTaskDetailRedownloadPointerDown(event, ${taskIdArgument})' onkeydown='handleTaskDetailRedownloadKeydown(event, ${taskIdArgument})'>${createTaskActionIcon('save')}</button>`
        : '';
    const canForceMerge = canTaskRequestForceMerge(safeTask);
    const shouldShowForceMergeAction = canForceMerge || Boolean(getTaskForceMergeDisabledReason(safeTask));
    const forceMergeAction = shouldShowForceMergeAction
        ? canForceMerge
            ? `<button type="button" class="task-fragment-detail__icon-btn task-fragment-detail__merge-btn" aria-label="${escapeHTML(`强制合并任务 ${rawTitle}`)}" data-tooltip="强制合并" onpointerdown='handleTaskDetailMergePointerDown(event, ${taskIdArgument})' onkeydown='handleTaskDetailMergeKeydown(event, ${taskIdArgument})'>${createTaskActionIcon('merge')}</button>`
            : `<button type="button" class="task-fragment-detail__icon-btn task-fragment-detail__merge-btn is-disabled" aria-disabled="true" aria-label="${blockedMergeAccessibleLabel}" data-tooltip="${escapeHTML(blockedMergeTooltip)}" onpointerdown='handleTaskDetailBlockedMergePointerDown(event, ${taskIdArgument})' onkeydown='handleTaskDetailBlockedMergeKeydown(event, ${taskIdArgument})'>${createTaskActionIcon('merge')}</button>`
        : '';
    const detailActions = detailPrimaryAction || playAction || saveAction || forceMergeAction
        ? `<div class="task-fragment-detail__legend-actions">${detailPrimaryAction}${playAction}${saveAction}${forceMergeAction}</div>`
        : '';
    void sourceSegments;

    const fragmentGrid = summary.fragments.map(fragment => {
        const statusLabel = getTaskFragmentStatusLabel(fragment.status);
        const tooltip = escapeHTML(`第 ${fragment.sequence} 片 · ${statusLabel}`);
        return `
            <button
                type="button"
                class="task-fragment-cell is-${escapeHTML(fragment.status)}"
                data-fragment-sequence="${escapeHTML(fragment.sequence)}"
                data-tooltip="${tooltip}"
                onclick='handleTaskFragmentClick(${taskIdArgument}, ${fragment.sequence}, ${JSON.stringify(fragment.status)})'
                aria-label="${tooltip}"
            ></button>
        `;
    }).join('');

    return `
        <div class="task-fragment-detail">
            <div class="task-fragment-detail__header">
                <h3 class="task-fragment-detail__title">${titleBadges}<span class="task-fragment-detail__title-text">${title}</span></h3>
                <button
                    type="button"
                    id="${taskDetailUrlButtonId}"
                    class="task-fragment-detail__meta task-fragment-detail__url"
                    title="${safeTaskUrl}"
                    aria-label="${escapeHTML(`复制任务链接：${taskUrl}`)}"
                    onclick='copyTaskUrl(${taskIdArgument})'
                    onkeydown='handleTaskUrlKeydown(event, ${taskIdArgument})'
                >${createTaskUrlCopyIcon('copy', 'task-fragment-detail__url-icon')}<span class="task-fragment-detail__url-text">${safeTaskUrl}</span></button>
                ${qualitySummary}
                ${streamSaveSummary}
                ${rangeSummary}
                ${forceMergeSummary}
            </div>
            <dl class="task-fragment-detail__summary">
                <div class="task-fragment-detail__metric">
                    <dt>碎片总量</dt>
                    <dd data-fragment-metric="total">${summary.total}</dd>
                </div>
                <div class="task-fragment-detail__metric">
                    <dt>已下载碎片</dt>
                    <dd data-fragment-metric="downloaded">${summary.downloaded}</dd>
                </div>
                <div class="task-fragment-detail__metric">
                    <dt>错误数量</dt>
                    <dd data-fragment-metric="errors">${summary.errors}</dd>
                </div>
                <div class="task-fragment-detail__metric">
                    <dt>总进度</dt>
                    <dd data-fragment-metric="progress">${summary.progress}%</dd>
                </div>
                <div class="task-fragment-detail__metric">
                    <dt>时长</dt>
                    <dd data-fragment-metric="duration">${escapeHTML(safeTask.duration || '00:00:00')}</dd>
                </div>
                <div class="task-fragment-detail__metric">
                    <dt>当前速度</dt>
                    <dd data-fragment-metric="speed">${escapeHTML(formatDownloadSpeed(safeTask.downloadSpeedBytesPerSecond, safeTask.status))}</dd>
                </div>
                <div class="task-fragment-detail__metric">
                    <dt>已下载大小</dt>
                    <dd data-fragment-metric="downloadedBytes">${escapeHTML(formatStorageBytes(safeTask.downloadedBytes))}</dd>
                </div>
                <div class="task-fragment-detail__metric">
                    <dt>预计剩余</dt>
                    <dd data-fragment-metric="eta">${escapeHTML(formatEstimatedRemainingSeconds(safeTask.estimatedRemainingSeconds, safeTask.status))}</dd>
                </div>
            </dl>
            <details class="task-fragment-detail__diagnostics">
                <summary class="task-fragment-detail__diagnostics-summary">诊断信息</summary>
                <div class="task-fragment-detail__diagnostics-body">
                    ${renderTaskRequestContext(safeTask, summary)}
                </div>
            </details>
            <div class="task-fragment-detail__legend-bar">
                <div class="task-fragment-detail__legend" aria-label="碎片状态图例">
                    <span class="task-fragment-detail__legend-item"><i class="task-fragment-detail__legend-swatch is-idle" aria-hidden="true"></i>未下载</span>
                    <span class="task-fragment-detail__legend-item"><i class="task-fragment-detail__legend-swatch is-downloading" aria-hidden="true"></i>下载中</span>
                    <span class="task-fragment-detail__legend-item"><i class="task-fragment-detail__legend-swatch is-failed" aria-hidden="true"></i>下载失败（点击可重试）</span>
                    <span class="task-fragment-detail__legend-item"><i class="task-fragment-detail__legend-swatch is-success" aria-hidden="true"></i>下载成功</span>
                </div>
                ${detailActions}
            </div>
            <div class="task-fragment-grid-scroll">
                <div class="task-fragment-grid">
                    ${fragmentGrid}
                </div>
            </div>
        </div>
    `;
}

async function handleTaskFragmentClick(taskId, sequence, status) {
    if (status === 'failed') {
        await retryTaskSegment(taskId, sequence);
        return;
    }

    showToast(`碎片 ${sequence}，状态：${getTaskFragmentStatusLabel(status)}`, { type: 'info' });
}

function handleTaskProgressKeydown(event, id) {
    if (!event || (event.key !== 'Enter' && event.key !== ' ')) return;

    event.preventDefault();
    openTaskFragmentDetails(id);
}

function handleTaskUrlPointerDown(event, id) {
    if (event?.pointerType === 'mouse' && event.button !== 0) return;

    event?.preventDefault?.();
    copyTaskUrl(id);
}

function handleTaskDetailPrimaryActionPointerDown(event, id) {
    if (event?.pointerType === 'mouse' && event.button !== 0) return;

    event?.preventDefault?.();
    toggleTaskPausedState(id);
}

function handleTaskDetailPrimaryActionKeydown(event, id) {
    if (!event || (event.key !== 'Enter' && event.key !== ' ')) return;

    event.preventDefault();
    toggleTaskPausedState(id);
}

function handleTaskDetailPlayPointerDown(event, id) {
    if (event?.pointerType === 'mouse' && event.button !== 0) return;

    event?.preventDefault?.();
    playTask(id);
}

function handleTaskDetailPlayKeydown(event, id) {
    if (!event || (event.key !== 'Enter' && event.key !== ' ')) return;

    event.preventDefault();
    playTask(id);
}

function handleTaskDetailSavePointerDown(event, id) {
    if (event?.pointerType === 'mouse' && event.button !== 0) return;

    event?.preventDefault?.();
    reSaveCompletedTask(id);
}

function handleTaskDetailSaveKeydown(event, id) {
    if (!event || (event.key !== 'Enter' && event.key !== ' ')) return;

    event.preventDefault();
    reSaveCompletedTask(id);
}

function handleTaskDetailRedownloadPointerDown(event, id) {
    if (event?.pointerType === 'mouse' && event.button !== 0) return;

    event?.preventDefault?.();
    redownloadCompletedTask(id);
}

function handleTaskDetailRedownloadKeydown(event, id) {
    if (!event || (event.key !== 'Enter' && event.key !== ' ')) return;

    event.preventDefault();
    redownloadCompletedTask(id);
}

function handleTaskDetailMergePointerDown(event, id) {
    if (event?.pointerType === 'mouse' && event.button !== 0) return;

    event?.preventDefault?.();
    openForceMergeModal(id);
}

function handleTaskDetailMergeKeydown(event, id) {
    if (!event || (event.key !== 'Enter' && event.key !== ' ')) return;

    event.preventDefault();
    openForceMergeModal(id);
}

function showBlockedForceMergeMessage() {
    const taskId = arguments[0];
    const task = taskId == null ? null : findTaskById(taskId);
    showToast(getTaskForceMergeDisabledReason(task) || '先暂停再强制合并', { type: 'info' });
}

function handleTaskDetailBlockedMergePointerDown(event) {
    if (event?.pointerType === 'mouse' && event.button !== 0) return;

    event?.preventDefault?.();
    showBlockedForceMergeMessage(arguments[1]);
}

function handleTaskDetailBlockedMergeKeydown(event) {
    if (!event || (event.key !== 'Enter' && event.key !== ' ')) return;

    event.preventDefault();
    showBlockedForceMergeMessage(id);
}

function handleTaskRowPrimaryActionPointerDown(event, id) {
    if (event?.pointerType === 'mouse' && event.button !== 0) return;

    event?.preventDefault?.();
    toggleTaskPausedState(id);
}

function handleTaskRowPrimaryActionKeydown(event, id) {
    if (!event || (event.key !== 'Enter' && event.key !== ' ')) return;

    event.preventDefault();
    toggleTaskPausedState(id);
}

function handleTaskRowActionPointerDown(event, id, action) {
    if (event?.pointerType === 'mouse' && event.button !== 0) return;

    event?.preventDefault?.();
    return runTaskRowAction(id, action);
}

function handleTaskRowActionKeydown(event, id, action) {
    if (!event || (event.key !== 'Enter' && event.key !== ' ')) return;

    event.preventDefault();
    return runTaskRowAction(id, action);
}

function runTaskRowAction(id, action) {
    if (action === 'play') {
        playTask(id);
        return;
    }
    if (action === 'merge') {
        const task = findTaskById(id);
        const disabledReason = getTaskForceMergeDisabledReason(task);
        if (disabledReason) {
            showToast(disabledReason, { type: 'info' });
            return;
        }
        openForceMergeModal(id);
        return;
    }
    if (action === 'save') {
        return reSaveCompletedTask(id);
    }
    if (action === 'redownload') {
        redownloadCompletedTask(id);
        return;
    }
    if (action === 'delete') {
        deleteTask(id);
    }
}

function getTaskDetailPrimaryActionIcon(status) {
    const actionLabel = getTaskDetailPrimaryActionLabel(status);
    if (actionLabel === '暂停') return 'pause';
    if (actionLabel === '确认范围') return 'play';
    if (actionLabel === '继续') return 'resume';
    return '';
}

function syncTaskFragmentDetailActions(task, detailContent) {
    const primaryAction = detailContent.querySelector('[data-detail-primary-action]');
    if (!(primaryAction instanceof HTMLElement)) return false;
    const mergeAction = detailContent.querySelector('.task-fragment-detail__merge-btn');

    const actionLabel = getTaskDetailPrimaryActionLabel(task?.status);
    const actionIcon = getTaskDetailPrimaryActionIcon(task?.status);
    if (!actionLabel || !actionIcon) {
        primaryAction.remove();
        return true;
    }

    const rawTitle = String(task?.title || '未命名任务');
    primaryAction.setAttribute('aria-label', `${actionLabel}任务 ${rawTitle}`);
    primaryAction.setAttribute('data-tooltip', actionLabel);

    if (primaryAction.getAttribute('data-current-icon') !== actionIcon) {
        primaryAction.setAttribute('data-current-icon', actionIcon);
        primaryAction.innerHTML = createTaskActionIcon(actionIcon);
        if (window.lucide) lucide.createIcons();
    }

    if (activeTooltipTarget === primaryAction) {
        appTooltip.textContent = actionLabel;
        updateTooltipPosition(primaryAction);
    }

    if (mergeAction instanceof HTMLElement) {
        const rawTitle = String(task?.title || '未命名任务');
        const taskIdArgument = JSON.stringify(String(task?.id ?? ''));
        const mergeEnabled = canTaskRequestForceMerge(task);
        const disabledReason = getTaskForceMergeDisabledReason(task);
        const tooltip = mergeEnabled ? '强制合并' : (disabledReason || '强制合并');

        mergeAction.setAttribute('data-tooltip', tooltip);
        mergeAction.setAttribute('aria-label', mergeEnabled ? `强制合并任务 ${rawTitle}` : `${tooltip}任务 ${rawTitle}`);
        mergeAction.classList.toggle('is-disabled', !mergeEnabled);

        if (mergeEnabled) {
            mergeAction.removeAttribute('aria-disabled');
            mergeAction.setAttribute('onpointerdown', `handleTaskDetailMergePointerDown(event, ${taskIdArgument})`);
            mergeAction.setAttribute('onkeydown', `handleTaskDetailMergeKeydown(event, ${taskIdArgument})`);
        } else {
            mergeAction.setAttribute('aria-disabled', 'true');
            mergeAction.setAttribute('onpointerdown', `handleTaskDetailBlockedMergePointerDown(event, ${taskIdArgument})`);
            mergeAction.setAttribute('onkeydown', `handleTaskDetailBlockedMergeKeydown(event, ${taskIdArgument})`);
        }

        if (activeTooltipTarget === mergeAction) {
            appTooltip.textContent = tooltip;
            updateTooltipPosition(mergeAction);
        }
    }

    return true;
}

function updateTaskFragmentDetailsLive(task, detailContent) {
    if (!(detailContent instanceof HTMLElement)) return false;

    const safeTask = task ?? {};
    const runtimeSegments = getEffectiveTaskSegments(safeTask);
    const summary = getTaskFragmentSummary({
        ...safeTask,
        segments: runtimeSegments
    });
    const fragmentCells = detailContent.querySelectorAll('.task-fragment-cell[data-fragment-sequence]');
    if (fragmentCells.length !== summary.fragments.length) {
        return false;
    }

    const metricValues = {
        total: String(summary.total),
        downloaded: String(summary.downloaded),
        errors: String(summary.errors),
        progress: `${summary.progress}%`,
        duration: safeTask.duration || '00:00:00',
        speed: formatDownloadSpeed(safeTask.downloadSpeedBytesPerSecond, safeTask.status),
        downloadedBytes: formatStorageBytes(safeTask.downloadedBytes),
        eta: formatEstimatedRemainingSeconds(safeTask.estimatedRemainingSeconds, safeTask.status)
    };
    Object.entries(metricValues).forEach(([metricName, value]) => {
        const metricEl = detailContent.querySelector(`[data-fragment-metric="${metricName}"]`);
        if (metricEl) {
            metricEl.textContent = value;
        }
    });
    if (!syncTaskFragmentDetailActions(safeTask, detailContent)) {
        return false;
    }

    const taskIdArgument = JSON.stringify(String(safeTask.id ?? ''));
    const fragmentsBySequence = new Map(summary.fragments.map(fragment => [
        String(fragment.sequence),
        fragment
    ]));

    fragmentCells.forEach(cell => {
        const sequence = cell.getAttribute('data-fragment-sequence') || '';
        const fragment = fragmentsBySequence.get(sequence);
        if (!fragment) return;

        const status = String(fragment.status || 'idle');
        const statusLabel = getTaskFragmentStatusLabel(status);
        const tooltip = `第 ${fragment.sequence} 片 · ${statusLabel}`;
        cell.className = `task-fragment-cell is-${status}`;
        cell.setAttribute('data-tooltip', tooltip);
        cell.setAttribute('aria-label', tooltip);
        cell.setAttribute(
            'onclick',
            `handleTaskFragmentClick(${taskIdArgument}, ${fragment.sequence}, ${JSON.stringify(status)})`
        );
    });

    return true;
}

function syncActiveTaskDetails() {
    if (activeModalId !== 'details' || !activeTaskDetailsId) return;

    const task = findTaskById(activeTaskDetailsId);
    const detailContent = document.getElementById('detail-content');
    if (!detailContent || !task) return;

    if (updateTaskFragmentDetailsLive(task, detailContent)) {
        return;
    }

    const fragmentGridScroll = detailContent.querySelector('.task-fragment-grid-scroll');
    const fragmentGridScrollTop = fragmentGridScroll instanceof HTMLElement
        ? fragmentGridScroll.scrollTop
        : 0;

    detailContent.innerHTML = renderTaskFragmentDetails(task);
    const nextFragmentGridScroll = detailContent.querySelector('.task-fragment-grid-scroll');
    if (nextFragmentGridScroll instanceof HTMLElement) {
        nextFragmentGridScroll.scrollTop = fragmentGridScrollTop;
    }
    if (window.lucide) lucide.createIcons();
}

function openTaskFragmentDetails(id) {
    const task = currentTasks.find(item => String(item.id) === String(id));
    const detailContent = document.getElementById('detail-content');
    if (!detailContent || !task) return;

    hideTooltip();
    activeTaskDetailsId = String(id);
    detailContent.innerHTML = renderTaskFragmentDetails(task);
    if (window.lucide) lucide.createIcons();
    detailContent.scrollTop = 0;
    openModal('details');
}

function findTooltipTarget(node) {
    if (!(node instanceof Element)) return null;
    return node.closest('[data-tooltip]');
}

function showTooltip(target) {
    if (!appTooltip || !(target instanceof HTMLElement)) return;

    const tooltipText = target.getAttribute('data-tooltip')?.trim();
    if (!tooltipText) {
        hideTooltip();
        return;
    }

    activeTooltipTarget = target;
    appTooltip.textContent = tooltipText;
    appTooltip.classList.add('is-visible');
    appTooltip.setAttribute('aria-hidden', 'false');
    updateTooltipPosition(target);
}

function updateTooltipPosition(target = activeTooltipTarget) {
    if (!appTooltip || !(target instanceof HTMLElement)) return;
    if (!appTooltip.classList.contains('is-visible')) return;

    const targetRect = target.getBoundingClientRect();
    const tooltipRect = appTooltip.getBoundingClientRect();
    const horizontalPadding = 12;
    const verticalOffset = 10;
    const scrollX = window.scrollX ?? 0;
    const scrollY = window.scrollY ?? 0;
    const viewportWidth = window.innerWidth ?? document.documentElement.clientWidth ?? 0;
    const minTop = scrollY + horizontalPadding;

    let left = targetRect.left + scrollX + (targetRect.width / 2) - (tooltipRect.width / 2);
    const minLeft = scrollX + horizontalPadding;
    const maxLeft = scrollX + viewportWidth - tooltipRect.width - horizontalPadding;

    left = Math.max(minLeft, Math.min(left, maxLeft));

    const aboveTop = targetRect.top + scrollY - tooltipRect.height - verticalOffset;
    const top = aboveTop < minTop
        ? targetRect.bottom + scrollY + verticalOffset
        : aboveTop;
    appTooltip.style.left = `${Math.round(left)}px`;
    appTooltip.style.top = `${Math.round(top)}px`;
}

function hideTooltip() {
    activeTooltipTarget = null;
    if (!appTooltip) return;

    appTooltip.classList.remove('is-visible');
    appTooltip.setAttribute('aria-hidden', 'true');
}

function getActiveTooltipSnapshot() {
    if (!appTooltip?.classList?.contains('is-visible')) return null;
    if (!(activeTooltipTarget instanceof HTMLElement)) return null;

    const tooltipKey = activeTooltipTarget.getAttribute('data-tooltip-key');
    if (!tooltipKey) return null;

    return {
        key: tooltipKey,
        text: activeTooltipTarget.getAttribute('data-tooltip')?.trim() || ''
    };
}

function restoreActiveTooltipSnapshot(tooltipSnapshot) {
    if (!tooltipSnapshot?.key) return;

    const escapedKey = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(tooltipSnapshot.key)
        : String(tooltipSnapshot.key).replaceAll('"', '\\"');
    const nextTarget = document.querySelector(`[data-tooltip-key="${escapedKey}"]`);
    if (!(nextTarget instanceof HTMLElement)) {
        hideTooltip();
        return;
    }

    showTooltip(nextTarget);
}

function getActiveTaskListFocusSnapshot() {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return null;
    if (!taskListContainer.contains(activeElement)) return null;

    const focusKey = activeElement.getAttribute('data-focus-key');
    return focusKey ? { key: focusKey } : null;
}

function restoreActiveTaskListFocusSnapshot(focusSnapshot) {
    if (!focusSnapshot?.key) return;

    const escapedKey = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(focusSnapshot.key)
        : String(focusSnapshot.key).replaceAll('"', '\\"');
    const nextTarget = document.querySelector(`[data-focus-key="${escapedKey}"]`);
    if (isFocusableElement(nextTarget)) {
        nextTarget.focus();
    }
}

function handleTooltipMouseOver(event) {
    const target = findTooltipTarget(event.target);
    if (!target) return;

    showTooltip(target);
}

function handleTooltipMouseOut(event) {
    const target = findTooltipTarget(event.target);
    if (!target) return;

    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Element && target.contains(relatedTarget)) {
        return;
    }

    hideTooltip();
}

function handleTooltipFocusIn(event) {
    const target = findTooltipTarget(event.target);
    if (!target) return;

    showTooltip(target);
}

function handleTooltipFocusOut(event) {
    const target = findTooltipTarget(event.target);
    if (!target) return;

    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Element && target.contains(relatedTarget)) {
        return;
    }

    hideTooltip();
}

function handleViewportChangeForTooltip() {
    if (!activeTooltipTarget) return;
    updateTooltipPosition(activeTooltipTarget);
}

function escapeHTML(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function formatQualityResolution(resolution) {
    if (!resolution || typeof resolution !== 'string') return '';
    return resolution.trim();
}

function formatQualityBandwidth(bandwidth) {
    const numericValue = Number(bandwidth);
    if (!Number.isFinite(numericValue) || numericValue <= 0) return '';
    return `${Math.round(numericValue / 1000)} kbps`;
}

function getQualityResolutionPixels(resolution) {
    const normalizedResolution = formatQualityResolution(resolution);
    const match = normalizedResolution.match(/^(\d+)\s*x\s*(\d+)$/i);
    if (!match) return 0;
    return Number(match[1]) * Number(match[2]);
}

function getSortedDownloadQualities(qualities) {
    if (!Array.isArray(qualities)) return [];
    return qualities
        .map((quality, index) => ({ quality, index }))
        .sort((left, right) => {
            const leftPixels = getQualityResolutionPixels(left.quality?.resolution) || Number(left.quality?.resolutionPixels) || 0;
            const rightPixels = getQualityResolutionPixels(right.quality?.resolution) || Number(right.quality?.resolutionPixels) || 0;
            if (rightPixels !== leftPixels) {
                if (rightPixels === 0) return -1;
                if (leftPixels === 0) return 1;
                return rightPixels - leftPixels;
            }

            const leftBandwidth = Number(left.quality?.bandwidthValue) || 0;
            const rightBandwidth = Number(right.quality?.bandwidthValue) || 0;
            if (rightBandwidth !== leftBandwidth) return rightBandwidth - leftBandwidth;

            return left.index - right.index;
        })
        .map(item => item.quality);
}

function getRecommendedQualityId(qualities) {
    if (!Array.isArray(qualities) || qualities.length === 0) return '';
    const ranked = [...qualities].sort((left, right) => {
        const leftPixels = Number(left?.resolutionPixels) || 0;
        const rightPixels = Number(right?.resolutionPixels) || 0;
        if (rightPixels !== leftPixels) return rightPixels - leftPixels;

        const leftBandwidth = Number(left?.bandwidthValue) || 0;
        const rightBandwidth = Number(right?.bandwidthValue) || 0;
        if (rightBandwidth !== leftBandwidth) return rightBandwidth - leftBandwidth;

        return 0;
    });
    return ranked[0]?.id || '';
}

function getPreviewRecommendedQualityId(qualities) {
    if (!Array.isArray(qualities) || qualities.length === 0) return '';
    const ranked = qualities
        .map((quality, index) => ({ quality, index }))
        .sort((left, right) => {
            const scorePreviewCompatibility = quality => {
                const codecs = String(quality?.codecs || quality?.rawTag || '').toLowerCase();
                let score = 0;
                if (/(^|,)avc1\./.test(codecs) || codecs.includes('avc1.')) score += 60;
                if (codecs.includes('mp4a.')) score += 40;
                if (codecs.includes('hvc1.') || codecs.includes('hev1.')) score -= 30;
                if (codecs.includes('dvh1.') || codecs.includes('dvhe.')) score -= 80;
                if (codecs.includes('ec-3') || codecs.includes('ac-3')) score -= 20;
                return score;
            };

            const leftScore = scorePreviewCompatibility(left.quality);
            const rightScore = scorePreviewCompatibility(right.quality);
            if (rightScore !== leftScore) return rightScore - leftScore;

            const leftPixels = Number(left.quality?.resolutionPixels) || 0;
            const rightPixels = Number(right.quality?.resolutionPixels) || 0;
            if (rightPixels !== leftPixels) return rightPixels - leftPixels;

            const leftBandwidth = Number(left.quality?.bandwidthValue) || 0;
            const rightBandwidth = Number(right.quality?.bandwidthValue) || 0;
            if (rightBandwidth !== leftBandwidth) return rightBandwidth - leftBandwidth;

            return left.index - right.index;
        });

    return ranked[0]?.quality?.id || '';
}

function getQualityDisplayLabel(quality, index) {
    const readableName = String(quality?.name || '').trim();
    if (readableName) {
        if (/^\d+$/.test(readableName)) {
            return `${readableName}P`;
        }
        return readableName;
    }

    const resolutionLabel = formatQualityResolution(quality?.resolution);
    const match = resolutionLabel.match(/^\d+\s*x\s*(\d+)$/i);
    const height = Number(match?.[1] ?? 0);
    if (height > 0) {
        const qualitySuffix = 'P';
        return `${height}${qualitySuffix}`;
    }
    return `清晰度 ${index + 1}`;
}

function getPreviewVideoElement() {
    return document.getElementById('preview-video');
}

function getPreviewSubtitleOverlayElement() {
    return document.getElementById('preview-subtitle-overlay');
}

function syncPreviewOptionsRailVisibility() {
    const previewLayout = document.querySelector('.preview-content-layout');
    const optionsRail = document.querySelector('.preview-options-rail');
    const qualityPanel = document.getElementById('preview-quality-panel');
    const subtitlePanel = document.getElementById('preview-subtitle-panel');
    const qualityList = document.getElementById('preview-quality-list');
    const subtitleList = document.getElementById('preview-subtitle-list');
    if (!previewLayout || !optionsRail || !qualityPanel || !subtitlePanel || !qualityList || !subtitleList) return;

    const hasAvailableOptions = Boolean(String(qualityList.innerHTML || '').trim())
        || Boolean(String(subtitleList.innerHTML || '').trim());
    optionsRail.classList.toggle('hidden', !hasAvailableOptions);
    previewLayout.classList.toggle('is-player-only', !hasAvailableOptions);
}

function syncPreviewOptionsRailHeight() {
    const previewLayout = document.querySelector('.preview-content-layout');
    const playerShell = document.querySelector('.preview-player-shell');
    const optionsRail = document.querySelector('.preview-options-rail');
    if (!previewLayout || !playerShell || !optionsRail) return;

    syncPreviewOptionsRailVisibility();
    if (optionsRail.classList.contains('hidden')) {
        optionsRail.style.removeProperty('--preview-options-rail-height');
        return;
    }

    if (window.matchMedia?.('(max-width: 720px)').matches) {
        optionsRail.style.removeProperty('--preview-options-rail-height');
        return;
    }

    const playerHeight = playerShell.getBoundingClientRect().height;
    if (playerHeight > 0) {
        optionsRail.style.setProperty('--preview-options-rail-height', `${Math.round(playerHeight)}px`);
    }
}

function setPreviewStatus(message, options = {}) {
    const statusEl = document.getElementById('preview-status');
    if (!statusEl) return;

    const text = String(message || '').trim();
    statusEl.textContent = text;
    statusEl.classList.toggle('hidden', !text || options.hidden === true);
}

function setPreviewSubtitleOverlayText(text) {
    const overlay = getPreviewSubtitleOverlayElement();
    if (!overlay) return;

    const value = String(text || '').trim();
    overlay.textContent = value;
    overlay.classList.toggle('hidden', !value);
}

function setPreviewSubtitleLoading(isLoading) {
    activePreviewSubtitleLoading = Boolean(isLoading);
    if (activePreviewSubtitleLoading) {
        setPreviewSubtitleOverlayText('字幕加载中...');
    }
}

function normalizePreviewSubtitleCueText(text) {
    return String(text || '')
        .replace(/\s*\n+\s*/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function getPreviewCueTextForCurrentTime(cues, currentTime) {
    const time = Number(currentTime);
    if (!Number.isFinite(time) || !Array.isArray(cues) || cues.length === 0) return '';

    return cues
        .filter(cue => {
            const startTime = Number(cue?.startTime);
            const endTime = Number(cue?.endTime);
            return Number.isFinite(startTime)
                && Number.isFinite(endTime)
                && time >= startTime
                && time < endTime;
        })
        .map(cue => normalizePreviewSubtitleCueText(cue?.text))
        .filter(Boolean)
        .join('\n');
}

function updatePreviewSubtitleOverlayFromHlsCues(options = {}) {
    if (!pendingPreviewSubtitleId) return false;
    if (activePreviewSubtitleCueTrack && options.allowNativeFallback !== true) return false;

    const video = getPreviewVideoElement();
    const text = getPreviewCueTextForCurrentTime(activePreviewSubtitleCues, video?.currentTime || 0);
    if (!text && activePreviewSubtitleLoading) {
        setPreviewSubtitleOverlayText('字幕加载中...');
        return true;
    }
    setPreviewSubtitleOverlayText(text);
    return Boolean(text);
}

function setPreviewSubtitleCues(cues) {
    if (!Array.isArray(cues) || cues.length === 0) {
        updatePreviewSubtitleOverlayFromHlsCues();
        return;
    }

    const cueKey = cue => [
        Number(cue?.startTime) || 0,
        Number(cue?.endTime) || 0,
        String(cue?.text || '')
    ].join('|');
    const knownCueKeys = new Set(activePreviewSubtitleCues.map(cueKey));
    cues.forEach(cue => {
        const key = cueKey(cue);
        if (knownCueKeys.has(key)) return;
        knownCueKeys.add(key);
        activePreviewSubtitleCues.push(cue);
    });
    activePreviewSubtitleCues.sort((left, right) => (
        (Number(left?.startTime) || 0) - (Number(right?.startTime) || 0)
    ));
    if (activePreviewSubtitleCueTrackKey) {
        activePreviewSubtitleCueCacheByTrackKey.set(activePreviewSubtitleCueTrackKey, [...activePreviewSubtitleCues]);
    }
    setPreviewSubtitleLoading(false);
    updatePreviewSubtitleOverlayFromHlsCues();
}

function getPreviewHlsCueTrackKey(trackIndex = activePreviewHls?.subtitleTrack) {
    const index = Number(trackIndex);
    return Number.isInteger(index) && index >= 0 ? `subtitles${index}` : '';
}

function setPreviewSubtitleCueTrackKey(trackKey = '') {
    const normalizedTrackKey = String(trackKey || '').trim();
    if (activePreviewSubtitleCueTrackKey === normalizedTrackKey) return;

    activePreviewSubtitleCueTrackKey = normalizedTrackKey;
    activePreviewSubtitleCues = normalizedTrackKey
        ? [...(activePreviewSubtitleCueCacheByTrackKey.get(normalizedTrackKey) || [])]
        : [];
    if (!normalizedTrackKey) {
        setPreviewSubtitleLoading(false);
        setPreviewSubtitleOverlayText('');
        return;
    }
    if (activePreviewSubtitleCues.length > 0) {
        setPreviewSubtitleLoading(false);
        updatePreviewSubtitleOverlayFromHlsCues();
        return;
    }
    setPreviewSubtitleLoading(true);
}

function clearPreviewSubtitleCueBinding(options = {}) {
    if (pendingPreviewSubtitleBindingRetryId) {
        const clearTimer = window.clearTimeout || globalThis.clearTimeout;
        if (typeof clearTimer === 'function') {
            clearTimer(pendingPreviewSubtitleBindingRetryId);
        }
        pendingPreviewSubtitleBindingRetryId = 0;
    }
    if (
        activePreviewSubtitleCueTrack
        && activePreviewSubtitleCueHandler
        && typeof activePreviewSubtitleCueTrack.removeEventListener === 'function'
    ) {
        activePreviewSubtitleCueTrack.removeEventListener('cuechange', activePreviewSubtitleCueHandler);
    }
    const video = getPreviewVideoElement();
    if (
        video
        && activePreviewSubtitleVideoCueHandler
        && typeof video.removeEventListener === 'function'
    ) {
        ['timeupdate', 'seeking', 'seeked'].forEach(eventName => {
            video.removeEventListener(eventName, activePreviewSubtitleVideoCueHandler);
        });
    }
    activePreviewSubtitleCueTrack = null;
    activePreviewSubtitleCueHandler = null;
    activePreviewSubtitleVideoCueHandler = null;
    if (options.clearCues !== false) {
        activePreviewSubtitleCues = [];
        activePreviewSubtitleCueTrackKey = '';
        activePreviewSubtitleCueCacheByTrackKey = new Map();
        activePreviewSubtitleLoading = false;
    }
    setPreviewSubtitleOverlayText('');
}

function bindPreviewSubtitleOverlayToTrack(track) {
    clearPreviewSubtitleCueBinding({ clearCues: false });
    if (!track) return;

    const updateOverlay = () => {
        const cues = track.activeCues || [];
        const text = Array.from(cues)
            .map(cue => normalizePreviewSubtitleCueText(cue?.text))
            .filter(Boolean)
            .join('\n');
        if (text || !updatePreviewSubtitleOverlayFromHlsCues({ allowNativeFallback: true })) {
            setPreviewSubtitleOverlayText(text);
        }
    };

    activePreviewSubtitleCueTrack = track;
    activePreviewSubtitleCueHandler = updateOverlay;
    activePreviewSubtitleVideoCueHandler = updateOverlay;

    if (typeof track.addEventListener === 'function') {
        track.addEventListener('cuechange', updateOverlay);
    }

    if (typeof track.addEventListener === 'function' && track.mode !== 'disabled') {
        const onLoad = () => {
            updateOverlay();
        };
        track.addEventListener('load', onLoad);
    }

    const video = getPreviewVideoElement();
    if (video && typeof video.addEventListener === 'function') {
        ['timeupdate', 'seeking', 'seeked'].forEach(eventName => {
            video.addEventListener(eventName, updateOverlay);
        });
    }

    updateOverlay();
}

function disablePreviewNativeSubtitleTracks() {
    const video = getPreviewVideoElement();
    const tracks = video?.textTracks;
    if (!tracks || typeof tracks.length !== 'number') return;

    for (let index = 0; index < tracks.length; index += 1) {
        tracks[index].mode = 'disabled';
    }
}

function getSelectedPreviewNativeSubtitleTrack() {
    const video = getPreviewVideoElement();
    const tracks = video?.textTracks;
    if (!tracks || typeof tracks.length !== 'number') return null;

    const selectedId = String(pendingPreviewSubtitleId || '').trim();
    const subtitleOptions = pendingPreviewSource
        ? getPreviewSubtitleOptions(pendingPreviewSource, pendingPreviewQualityId)
        : [];
    const selectedSubtitle = subtitleOptions.find(rendition => String(rendition?.id) === selectedId);
    if (!selectedSubtitle) {
        disablePreviewNativeSubtitleTracks();
        return null;
    }

    const selectedName = String(selectedSubtitle.name || selectedSubtitle.label || '').trim().toLowerCase();
    const selectedLanguage = String(selectedSubtitle.language || '').trim().toLowerCase();

    let selectedTrack = null;
    let bestMatchScore = 0;

    for (let index = 0; index < tracks.length; index += 1) {
        const track = tracks[index];
        const trackLabel = String(track?.label || '').trim().toLowerCase();
        const trackLanguage = String(track?.language || '').trim().toLowerCase();

        let matchScore = 0;

        // Exact language match
        if (selectedLanguage && trackLanguage === selectedLanguage) {
            matchScore = 100;
        }
        // Language prefix match (e.g., "zh" matches "zh-CN")
        else if (selectedLanguage && trackLanguage && trackLanguage.startsWith(selectedLanguage + '-')) {
            matchScore = 90;
        }
        else if (selectedLanguage && trackLanguage && selectedLanguage.startsWith(trackLanguage + '-')) {
            matchScore = 90;
        }
        // Label match
        else if (selectedName && trackLabel && trackLabel.includes(selectedName)) {
            matchScore = 80;
        }
        else if (selectedName && trackLabel && selectedName.includes(trackLabel)) {
            matchScore = 80;
        }
        // Index match as last resort
        else if (index === Number(selectedId) && !isNaN(Number(selectedId))) {
            matchScore = 50;
        }

        if (matchScore > bestMatchScore) {
            bestMatchScore = matchScore;
            selectedTrack = track;
        }

        track.mode = 'disabled'; // Will be set to 'showing' for selected track below
    }

    if (selectedTrack) {
        selectedTrack.mode = 'showing';
    }

    return selectedTrack;
}

function bindPreviewSubtitleOverlayToSelectedTrack() {
    const selectedTrack = getSelectedPreviewNativeSubtitleTrack();
    if (selectedTrack) {
        bindPreviewSubtitleOverlayToTrack(selectedTrack);
        return true;
    }

    if (activePreviewHls && pendingPreviewSubtitleId) {
        const video = getPreviewVideoElement();

        if (video?.textTracks && video.textTracks.length > 0) {
            const trackIndex = getPreviewSubtitleTrackIndex(pendingPreviewSubtitleId);
            if (trackIndex >= 0 && video.textTracks[trackIndex]) {
                const track = video.textTracks[trackIndex];
                track.mode = 'showing';
                bindPreviewSubtitleOverlayToTrack(track);
                return true;
            }

            for (let i = 0; i < video.textTracks.length; i++) {
                const track = video.textTracks[i];
                if (track.kind === 'subtitles' || track.kind === 'captions') {
                    track.mode = 'showing';
                    bindPreviewSubtitleOverlayToTrack(track);
                    return true;
                }
            }
        }
    }

    return false;
}

function bindPreviewSubtitleOverlayToHlsCues() {
    const video = getPreviewVideoElement();
    if (!video || typeof video.addEventListener !== 'function') return false;

    if (activePreviewSubtitleVideoCueHandler && !activePreviewSubtitleCueTrack) {
        ['timeupdate', 'seeking', 'seeked'].forEach(eventName => {
            video.removeEventListener(eventName, activePreviewSubtitleVideoCueHandler);
        });
    }

    const updateOverlay = () => {
        updatePreviewSubtitleOverlayFromHlsCues();
    };
    activePreviewSubtitleVideoCueHandler = updateOverlay;
    ['timeupdate', 'seeking', 'seeked'].forEach(eventName => {
        video.addEventListener(eventName, updateOverlay);
    });
    updateOverlay();
    return true;
}

function schedulePreviewSubtitleOverlayBindingRetry(attempt = 0) {
    if (!pendingPreviewSubtitleId) return;
    if (pendingPreviewSubtitleBindingRetryId) {
        const clearTimer = window.clearTimeout || globalThis.clearTimeout;
        if (typeof clearTimer === 'function') {
            clearTimer(pendingPreviewSubtitleBindingRetryId);
        }
    }
    const setTimer = window.setTimeout || globalThis.setTimeout;
    if (typeof setTimer !== 'function') return;

    const delay = Math.min(200 + (attempt * 200), 1000);

    pendingPreviewSubtitleBindingRetryId = setTimer(() => {
        pendingPreviewSubtitleBindingRetryId = 0;
        if (bindPreviewSubtitleOverlayToSelectedTrack() || attempt >= 10) {
            return;
        }
        schedulePreviewSubtitleOverlayBindingRetry(attempt + 1);
    }, delay);
}

function destroyPreviewPlayback() {
    clearPreviewSubtitleCueBinding();
    if (activePreviewHls && typeof activePreviewHls.destroy === 'function') {
        activePreviewHls.destroy();
    }
    activePreviewHls = null;
    if (activePreviewObjectUrl) {
        URL.revokeObjectURL(activePreviewObjectUrl);
        activePreviewObjectUrl = '';
    }

    const video = getPreviewVideoElement();
    if (video) {
        try {
            video.pause();
        } catch {
            // Ignore browser-specific pause failures while closing preview.
        }
        if (typeof video.removeAttribute === 'function') {
            video.removeAttribute('src');
        } else {
            video.src = '';
        }
        if (typeof video.load === 'function') {
            video.load();
        }
    }
}

function isPreviewOverlayActive() {
    return Boolean(previewModal?.classList?.contains('is-preview-overlay'));
}

function closePreviewOverlay() {
    if (!isPreviewOverlayActive()) return;

    activePreviewRequestId += 1;
    destroyPreviewPlayback();
    pendingPreviewSource = null;
    pendingPreviewQualityId = '';
    pendingPreviewSubtitleId = '';
    previewModal.classList.remove('is-preview-overlay', 'is-active');
    previewModal.setAttribute('aria-hidden', 'true');
}

function shouldShowPreviewAsOverlay() {
    return activeModalId === 'details' || activeModalId === 'new-task';
}

function playPreviewVideo(video = getPreviewVideoElement()) {
    if (!video || typeof video.play !== 'function') return;

    const playResult = video.play();
    if (playResult && typeof playResult.catch === 'function') {
        playResult.catch(() => {
            setPreviewStatus('已准备好预览，请点击播放器开始播放。');
        });
    }
}

function canPreviewNativeHls(video) {
    const nativeSupport = String(video?.canPlayType?.('application/vnd.apple.mpegurl') || '');
    if (!nativeSupport) return false;

    return isPreviewAppleWebKitNativeHls() || nativeSupport === 'probably';
}

function isPreviewAppleWebKitNativeHls() {
    const userAgent = String(globalThis.navigator?.userAgent || '');
    if (/(Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS)/i.test(userAgent)) return false;
    return /Safari/i.test(userAgent)
        || (/AppleWebKit/i.test(userAgent) && /(iPhone|iPad|iPod)/i.test(userAgent));
}

function rewritePreviewPlaylistResourceUrls(playlistText, playlistUrl) {
    const keyUriPattern = new RegExp('URI=(["\\\']?)([^"\\\',\\s]+)\\1', 'i');
    const lines = String(playlistText || '')
        .replaceAll('\r\n', '\n')
        .replaceAll('\r', '\n')
        .split('\n');
    return lines.map(line => {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) {
            if (trimmedLine.toUpperCase().startsWith('#EXT-X-KEY:')) {
                return line.replace(keyUriPattern, (match, quote, rawUri) => {
                    const resolvedUri = resolvePlaylistResourceUrl(rawUri, playlistUrl);
                    return `URI=${quote || '"'}${resolvedUri}${quote || '"'}`;
                });
            }
            return line;
        }
        return resolvePlaylistResourceUrl(trimmedLine, playlistUrl);
    }).join('\n');
}

function rewritePreviewMediaRenditionTag(rendition, playlistUrl) {
    const rawTag = String(rendition?.rawTag || '').trim();
    if (!rawTag) return '';

    const uri = String(rendition?.uri || '').trim();
    if (!uri) return rawTag;

    const resolvedUri = resolvePlaylistResourceUrl(uri, playlistUrl);
    const uriPattern = new RegExp('URI=(["\\\']?)([^"\\\',\\s]+)\\1', 'i');
    if (uriPattern.test(rawTag)) {
        return rawTag.replace(uriPattern, (match, quote) => `URI=${quote || '"'}${resolvedUri}${quote || '"'}`);
    }

    return `${rawTag},URI="${resolvedUri}"`;
}

function buildPreviewMasterPlaylist(quality, mediaRenditions, playlistUrl) {
    const selectedQualityUrl = String(quality?.url || '').trim();
    if (!selectedQualityUrl) return '';

    const matched = getMatchingMediaRenditions(quality, mediaRenditions);
    const renditionLines = [...matched.audio, ...matched.subtitles]
        .map(rendition => rewritePreviewMediaRenditionTag(rendition, playlistUrl))
        .filter(Boolean);
    const streamTag = String(quality?.rawTag || '').trim()
        || `#EXT-X-STREAM-INF:BANDWIDTH=${Number(quality?.bandwidthValue) || 1}`;
    const variantUrl = resolvePlaylistResourceUrl(selectedQualityUrl, playlistUrl);

    return [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        ...renditionLines,
        streamTag,
        variantUrl
    ].join('\n');
}

function getPreviewPlaybackRequest(model, qualityId = '') {
    const previewUrl = String(model?.url || '').trim();
    const qualities = Array.isArray(model?.qualities) ? model.qualities : [];
    if (qualities.length === 0) {
        return { url: previewUrl };
    }

    const selectedQualityId = qualityId || getPreviewRecommendedQualityId(qualities);
    const selectedQuality = qualities.find(quality => String(quality?.id) === String(selectedQualityId))
        || qualities[0];
    const mediaRenditions = Array.isArray(model?.mediaRenditions) ? model.mediaRenditions : [];
    const playlistText = buildPreviewMasterPlaylist(selectedQuality, mediaRenditions, previewUrl);

    return {
        url: selectedQuality?.url || previewUrl,
        playlistUrl: previewUrl,
        playlistText,
        qualityId: selectedQuality?.id || ''
    };
}

function getPreviewSubtitleOptions(model, qualityId = '') {
    const qualities = Array.isArray(model?.qualities) ? model.qualities : [];
    const selectedQualityId = qualityId || pendingPreviewQualityId || getPreviewRecommendedQualityId(qualities);
    const selectedQuality = qualities.find(quality => String(quality?.id) === String(selectedQualityId))
        || qualities[0];
    const mediaRenditions = Array.isArray(model?.mediaRenditions) ? model.mediaRenditions : [];
    return getMatchingMediaRenditions(selectedQuality, mediaRenditions).subtitles.map(rendition => ({
        ...rendition,
        label: String(rendition?.name || rendition?.language || '字幕').trim() || '字幕'
    }));
}

function getPreviewSelectedSubtitleInfo(subtitleId = pendingPreviewSubtitleId) {
    const selectedId = String(subtitleId || '').trim();
    if (!selectedId || !pendingPreviewSource) {
        return {
            selectedId,
            selectedSubtitle: null,
            subtitleOptions: [],
            optionIndex: -1
        };
    }

    const subtitleOptions = getPreviewSubtitleOptions(pendingPreviewSource, pendingPreviewQualityId);
    const optionIndex = subtitleOptions.findIndex(rendition => String(rendition?.id) === selectedId);
    return {
        selectedId,
        selectedSubtitle: optionIndex >= 0 ? subtitleOptions[optionIndex] : null,
        subtitleOptions,
        optionIndex
    };
}

function getPreviewHlsSubtitleOption(subtitleId) {
    const { selectedSubtitle, optionIndex } = getPreviewSelectedSubtitleInfo(subtitleId);
    if (!selectedSubtitle || optionIndex < 0) return null;

    return {
        id: optionIndex,
        lang: String(selectedSubtitle.language || '').trim() || undefined,
        name: String(selectedSubtitle.name || selectedSubtitle.label || '').trim() || undefined,
        groupId: String(selectedSubtitle.groupId || '').trim() || undefined,
        default: Boolean(selectedSubtitle.default),
        forced: Boolean(selectedSubtitle.forced)
    };
}

function getPreviewSubtitleTrackIndex(subtitleId) {
    if (!activePreviewHls || !Array.isArray(activePreviewHls.subtitleTracks)) return -1;
    const { selectedSubtitle, optionIndex } = getPreviewSelectedSubtitleInfo(subtitleId);
    if (!selectedSubtitle) return -1;

    const selectedName = String(selectedSubtitle.name || selectedSubtitle.label || '').trim().toLowerCase();
    const selectedLanguage = String(selectedSubtitle.language || '').trim().toLowerCase();
    const selectedUri = String(selectedSubtitle.uri || '').trim();

    const matchedIndex = activePreviewHls.subtitleTracks.findIndex(track => {
        const trackName = String(track?.name || track?.label || '').trim().toLowerCase();
        const trackLanguage = String(track?.lang || track?.language || '').trim().toLowerCase();
        const trackUrl = String(track?.url || track?.uri || '').trim();
        return (
            (selectedUri && trackUrl && trackUrl === selectedUri)
            || (selectedLanguage && trackLanguage && trackLanguage === selectedLanguage)
            || (selectedName && trackName && trackName === selectedName)
        );
    });
    if (matchedIndex >= 0) return matchedIndex;

    const idMatchedIndex = activePreviewHls.subtitleTracks.findIndex(track => Number(track?.id) === optionIndex);
    if (idMatchedIndex >= 0) return idMatchedIndex;

    return optionIndex >= 0 && activePreviewHls.subtitleTracks[optionIndex] ? optionIndex : -1;
}

function applyPreviewNativeSubtitleSelection(subtitleId) {
    if (!getPreviewVideoElement()?.textTracks) {
        bindPreviewSubtitleOverlayToHlsCues();
        return;
    }

    const selectedId = String(subtitleId || '').trim();
    if (!selectedId) {
        disablePreviewNativeSubtitleTracks();
        clearPreviewSubtitleCueBinding();
        return;
    }

    if (isPreviewAppleWebKitNativeHls()) {
        getSelectedPreviewNativeSubtitleTrack();
        clearPreviewSubtitleCueBinding();
        return;
    }

    if (bindPreviewSubtitleOverlayToSelectedTrack()) {
        if (pendingPreviewSubtitleBindingRetryId) {
            const clearTimer = window.clearTimeout || globalThis.clearTimeout;
            if (typeof clearTimer === 'function') {
                clearTimer(pendingPreviewSubtitleBindingRetryId);
            }
            pendingPreviewSubtitleBindingRetryId = 0;
        }
    } else {
        bindPreviewSubtitleOverlayToHlsCues();
        if (!updatePreviewSubtitleOverlayFromHlsCues()) {
            setPreviewSubtitleOverlayText('');
            schedulePreviewSubtitleOverlayBindingRetry();
        }
    }
}

function applyPreviewSubtitleSelection(subtitleId = pendingPreviewSubtitleId) {
    const selectedId = String(subtitleId || '').trim();
    const previousSelectedId = pendingPreviewSubtitleId;
    pendingPreviewSubtitleId = selectedId;
    if (!selectedId || selectedId !== previousSelectedId) {
        activePreviewSubtitleCues = [];
    }

    if (activePreviewHls && Array.isArray(activePreviewHls.subtitleTracks)) {
        if ('subtitleDisplay' in activePreviewHls) {
            activePreviewHls.subtitleDisplay = Boolean(selectedId);
        }
        if (typeof activePreviewHls.setSubtitleOption === 'function') {
            const option = selectedId ? getPreviewHlsSubtitleOption(selectedId) : { id: -1 };
            const selectedTrack = activePreviewHls.setSubtitleOption(option || undefined);
            if (selectedId && activePreviewHls.subtitleTracks.length > 0) {
                const trackIndex = getPreviewSubtitleTrackIndex(selectedId);
                if (trackIndex >= 0 && activePreviewHls.subtitleTrack !== trackIndex) {
                    activePreviewHls.subtitleTrack = trackIndex;
                }
                setPreviewSubtitleCueTrackKey(getPreviewHlsCueTrackKey(trackIndex));
            } else if (!selectedId && activePreviewHls.subtitleTrack !== -1) {
                activePreviewHls.subtitleTrack = -1;
                setPreviewSubtitleCueTrackKey('');
            }
        } else {
            const trackIndex = selectedId ? getPreviewSubtitleTrackIndex(selectedId) : -1;
            activePreviewHls.subtitleTrack = trackIndex;
            setPreviewSubtitleCueTrackKey(getPreviewHlsCueTrackKey(trackIndex));
        }
    }
    applyPreviewNativeSubtitleSelection(selectedId);
}

async function preparePreviewPlaybackUrl(previewSource) {
    const source = typeof previewSource === 'object' && previewSource !== null
        ? previewSource
        : { url: previewSource };
    const url = String(source.url || '').trim();
    if (!url) return '';

    const inlinePlaylistText = String(source.playlistText || '');
    if (inlinePlaylistText && isLikelyM3U8Content(inlinePlaylistText)) {
        const playlistUrl = String(source.playlistUrl || url).trim() || url;
        const rewrittenPlaylistText = rewritePreviewPlaylistResourceUrls(inlinePlaylistText, playlistUrl);
        const blob = new Blob([rewrittenPlaylistText], { type: 'application/vnd.apple.mpegurl' });
        activePreviewObjectUrl = URL.createObjectURL(blob);
        return activePreviewObjectUrl;
    }

    const pageProtocol = String(window?.location?.protocol || globalThis.location?.protocol || '');
    if (pageProtocol !== 'https:') {
        return url;
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch {
        return url;
    }

    if (parsedUrl.protocol !== 'https:') {
        return url;
    }

    const response = await fetch(url);
    const playlistText = await response.text();
    if (!response.ok || !isLikelyM3U8Content(playlistText)) {
        return url;
    }

    const playlistUrl = response.url || url;
    const rewrittenPlaylistText = rewritePreviewPlaylistResourceUrls(playlistText, playlistUrl);
    if (rewrittenPlaylistText === playlistText) {
        return url;
    }

    const blob = new Blob([rewrittenPlaylistText], { type: 'application/vnd.apple.mpegurl' });
    activePreviewObjectUrl = URL.createObjectURL(blob);
    return activePreviewObjectUrl;
}

function getPreviewNativePlaybackUrl(previewSource) {
    const source = typeof previewSource === 'object' && previewSource !== null
        ? previewSource
        : { url: previewSource };
    const url = String(source.url || '').trim();
    if (isPreviewAppleWebKitNativeHls()) {
        return String(source.playlistUrl || source.masterUrl || url).trim();
    }
    return url || String(source.playlistUrl || source.masterUrl || '').trim();
}

async function startPreviewPlayback(previewSource) {
    const video = getPreviewVideoElement();
    const source = typeof previewSource === 'object' && previewSource !== null
        ? previewSource
        : { url: previewSource };
    const url = String(source.url || '').trim();
    if (!video || !url) return false;

    destroyPreviewPlayback();
    setPreviewStatus('正在加载预览...');
    let playbackUrl = url;
    const useNativeHls = canPreviewNativeHls(video);
    if (useNativeHls) {
        playbackUrl = getPreviewNativePlaybackUrl(source) || url;
    } else {
        try {
            playbackUrl = await preparePreviewPlaybackUrl(source);
        } catch {
            playbackUrl = url;
        }
    }

    if (useNativeHls) {
        video.src = playbackUrl;

        const onLoadedMetadata = () => {
            setTimeout(() => {
                applyPreviewSubtitleSelection(pendingPreviewSubtitleId);
            }, 500);
        };

        const onAddTrack = () => {
            setTimeout(() => {
                applyPreviewSubtitleSelection(pendingPreviewSubtitleId);
            }, 100);
        };

        video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });

        if (video.textTracks) {
            video.textTracks.addEventListener('addtrack', onAddTrack);
        }

        setPreviewStatus('', { hidden: true });
        playPreviewVideo(video);
        return true;
    }

    if (window.Hls && Hls.isSupported()) {
        const hls = new Hls({
            enableCEA708Captions: true,
            renderTextTracksNatively: false
        });
        activePreviewHls = hls;
        hls.loadSource(playbackUrl);
        hls.attachMedia(video);
        if (Hls.Events?.ERROR) {
            hls.on(Hls.Events.ERROR, (_event, data) => {
                if (data?.fatal) {
                    setPreviewStatus('预览播放失败，请检查源站访问限制或编码兼容性。');
                }
            });
        }
        if (Hls.Events?.MANIFEST_PARSED) {
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                applyPreviewSubtitleSelection(pendingPreviewSubtitleId);
                playPreviewVideo(video);
            });
        } else {
            applyPreviewSubtitleSelection(pendingPreviewSubtitleId);
            playPreviewVideo(video);
        }
        if (Hls.Events?.SUBTITLE_TRACKS_UPDATED) {
            hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
                applyPreviewSubtitleSelection(pendingPreviewSubtitleId);
            });
        }
        [
            Hls.Events?.SUBTITLE_TRACK_SWITCH,
            Hls.Events?.SUBTITLE_TRACK_LOADED,
            Hls.Events?.SUBTITLE_TRACK_UPDATED,
            Hls.Events?.SUBTITLE_FRAG_PROCESSED
        ].filter(Boolean).forEach(eventName => {
            hls.on(eventName, () => {
                if (!pendingPreviewSubtitleId) return;
                bindPreviewSubtitleOverlayToSelectedTrack();
            });
        });

        if (Hls.Events?.CUES_PARSED) {
            hls.on(Hls.Events.CUES_PARSED, (event, data) => {
                if (!pendingPreviewSubtitleId) return;
                const cueTrackKey = String(data?.track || '').trim();
                const activeCueTrackKey = activePreviewSubtitleCueTrackKey || getPreviewHlsCueTrackKey();
                if (cueTrackKey && activeCueTrackKey && cueTrackKey !== activeCueTrackKey) return;
                setPreviewSubtitleCues(data?.cues || []);

                setTimeout(() => {
                    if (!bindPreviewSubtitleOverlayToSelectedTrack()) {
                        bindPreviewSubtitleOverlayToHlsCues();
                    }
                }, 100);
            });
        }
        setPreviewStatus('', { hidden: true });
        return true;
    }

    setPreviewStatus('当前浏览器不支持 m3u8 预览。');
    return false;
}

function renderPreviewQualityOptions(model) {
    const qualityPanel = document.getElementById('preview-quality-panel');
    const qualityList = document.getElementById('preview-quality-list');
    if (!qualityPanel || !qualityList) return;

    const qualities = Array.isArray(model?.qualities) ? model.qualities : [];
    const hasQualities = qualities.length > 0;
    qualityPanel.classList.toggle('hidden', !hasQualities);

    if (!hasQualities) {
        qualityList.innerHTML = '';
        syncPreviewOptionsRailVisibility();
        return;
    }

    const selectedQualityId = pendingPreviewQualityId || getPreviewRecommendedQualityId(qualities);
    qualityList.innerHTML = qualities.map((quality, index) => {
        const qualityId = String(quality.id);
        const isChecked = qualityId === String(selectedQualityId);
        const metaParts = [
            formatQualityResolution(quality.resolution),
            typeof quality.bandwidth === 'string' && quality.bandwidth
                ? quality.bandwidth
                : formatQualityBandwidth(quality.bandwidthValue)
        ].filter(Boolean);
        const optionLabel = quality.label || getQualityDisplayLabel(quality, index);

        return `
            <label class="download-quality-option${isChecked ? ' is-selected' : ''}" for="preview-quality-${escapeHTML(qualityId)}">
                <input
                    type="radio"
                    id="preview-quality-${escapeHTML(qualityId)}"
                    name="preview-quality-option"
                    value="${escapeHTML(qualityId)}"
                    ${isChecked ? 'checked' : ''}
                    onchange='selectPreviewQualityOption(${escapeHTML(JSON.stringify(qualityId))})'
                >
                <span class="form-choice-indicator" aria-hidden="true"></span>
                <span class="download-quality-option__content">
                    <span class="download-quality-option__title">${escapeHTML(optionLabel)}</span>
                    ${metaParts.length > 0
            ? `<span class="download-quality-option__meta">${escapeHTML(metaParts.join(' / '))}</span>`
            : ''}
                </span>
                ${quality.isRecommended ? '<span class="download-quality-option__badge">推荐</span>' : ''}
            </label>
        `;
    }).join('');
    syncPreviewOptionsRailVisibility();
    syncPreviewOptionsRailHeight();
}

function activatePreviewOptionTab(option = 'quality') {
    const requested = String(option || 'quality');
    const tabs = Array.from(document.querySelectorAll('[data-preview-option-tab]'));
    const panels = Array.from(document.querySelectorAll('.preview-option-panel[data-preview-option-panel]'));
    const targetTab = tabs.find(tab => tab.dataset.previewOptionTab === requested && !tab.classList.contains('hidden'))
        || tabs.find(tab => tab.dataset.previewOptionTab === 'quality')
        || tabs[0];
    const activeOption = targetTab?.dataset.previewOptionTab || 'quality';

    tabs.forEach(tab => {
        const isActive = tab === targetTab;
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    panels.forEach(panel => {
        panel.classList.toggle('hidden', panel.dataset.previewOptionPanel !== activeOption);
    });
    syncPreviewOptionsRailHeight();
}

function renderPreviewSubtitleOptions(model) {
    const tabBar = document.getElementById('preview-option-tabs');
    const subtitlePanel = document.getElementById('preview-subtitle-panel');
    const subtitleList = document.getElementById('preview-subtitle-list');
    if (!subtitlePanel || !subtitleList) return;

    const subtitleOptions = getPreviewSubtitleOptions(model, pendingPreviewQualityId);
    const hasSubtitles = subtitleOptions.length > 0;
    if (tabBar) {
        tabBar.classList.toggle('hidden', !hasSubtitles);
    }

    if (!hasSubtitles) {
        subtitleList.innerHTML = '';
        pendingPreviewSubtitleId = '';
        applyPreviewSubtitleSelection('');
        activatePreviewOptionTab('quality');
        syncPreviewOptionsRailVisibility();
        return;
    }

    if (!subtitleOptions.some(rendition => String(rendition.id) === String(pendingPreviewSubtitleId))) {
        pendingPreviewSubtitleId = '';
    }

    const options = [
        {
            id: '',
            label: '关闭字幕',
            meta: '预览时不显示字幕'
        },
        ...subtitleOptions.map(rendition => ({
            id: String(rendition.id),
            label: rendition.label,
            meta: getRenditionOptionMeta(rendition, '字幕')
        }))
    ];

    subtitleList.innerHTML = options.map(option => {
        const optionId = option.id ? `preview-subtitle-${option.id}` : 'preview-subtitle-none';
        const isChecked = String(option.id) === String(pendingPreviewSubtitleId);
        return `
            <label class="download-quality-option${isChecked ? ' is-selected' : ''}" for="${escapeHTML(optionId)}">
                <input
                    type="radio"
                    id="${escapeHTML(optionId)}"
                    name="preview-subtitle-option"
                    value="${escapeHTML(option.id)}"
                    ${isChecked ? 'checked' : ''}
                    onchange='selectPreviewSubtitleOption(${escapeHTML(JSON.stringify(option.id))})'
                >
                <span class="form-choice-indicator" aria-hidden="true"></span>
                <span class="download-quality-option__content">
                    <span class="download-quality-option__title">${escapeHTML(option.label)}</span>
                    <span class="download-quality-option__meta">${escapeHTML(option.meta)}</span>
                </span>
            </label>
        `;
    }).join('');
    const activeTab = document.querySelector('[data-preview-option-tab].is-active')?.dataset?.previewOptionTab || 'quality';
    activatePreviewOptionTab(activeTab === 'subtitle' ? 'subtitle' : 'quality');
    syncPreviewOptionsRailVisibility();
    syncPreviewOptionsRailHeight();
}

function selectPreviewQualityOption(qualityId) {
    if (!pendingPreviewSource || !Array.isArray(pendingPreviewSource.qualities)) return;

    pendingPreviewQualityId = String(qualityId);
    pendingPreviewSubtitleId = '';
    renderPreviewQualityOptions(pendingPreviewSource);
    renderPreviewSubtitleOptions(pendingPreviewSource);

    const playbackRequest = getPreviewPlaybackRequest(pendingPreviewSource, pendingPreviewQualityId);
    if (playbackRequest.url) {
        startPreviewPlayback(playbackRequest);
    }
}

function selectPreviewSubtitleOption(subtitleId) {
    pendingPreviewSubtitleId = String(subtitleId || '');
    if (pendingPreviewSource) {
        renderPreviewSubtitleOptions(pendingPreviewSource);
    }
    applyPreviewSubtitleSelection(pendingPreviewSubtitleId);
}

function openPreviewModal(model) {
    const titleEl = document.getElementById('preview-title');
    const title = String(model?.title || '视频预览').trim() || '视频预览';
    const previewUrl = String(model?.url || '').trim();
    const qualities = Array.isArray(model?.qualities) ? model.qualities : [];
    const mediaRenditions = Array.isArray(model?.mediaRenditions) ? model.mediaRenditions : [];

    if (titleEl) {
        titleEl.textContent = title;
    }

    pendingPreviewSource = {
        title,
        url: previewUrl,
        qualities: qualities.map(quality => ({ ...quality })),
        mediaRenditions: mediaRenditions.map(rendition => ({ ...rendition }))
    };
    pendingPreviewQualityId = getPreviewRecommendedQualityId(qualities);
    pendingPreviewSubtitleId = '';

    renderPreviewQualityOptions(pendingPreviewSource);
    renderPreviewSubtitleOptions(pendingPreviewSource);
    const shouldOverlayPreview = shouldShowPreviewAsOverlay();
    if (shouldOverlayPreview) {
        previewModal.classList.add('is-active', 'is-preview-overlay');
        previewModal.setAttribute('aria-hidden', 'false');
        if (window.lucide) lucide.createIcons();
    } else {
        openModal('preview');
        if (activeModalId !== 'preview') {
            activateModalPanel('preview');
        }
    }
    window.setTimeout(syncPreviewOptionsRailHeight, 0);

    if (qualities.length > 0) {
        const playbackRequest = getPreviewPlaybackRequest(pendingPreviewSource, pendingPreviewQualityId);
        if (playbackRequest.url) {
            startPreviewPlayback(playbackRequest);
        }
        return;
    }

    startPreviewPlayback(previewUrl);
}

function showPreviewLoading(title) {
    const titleEl = document.getElementById('preview-title');
    if (titleEl) {
        titleEl.textContent = String(title || '视频预览').trim() || '视频预览';
    }

    pendingPreviewSource = null;
    pendingPreviewQualityId = '';
    pendingPreviewSubtitleId = '';
    renderPreviewQualityOptions({ qualities: [] });
    renderPreviewSubtitleOptions({ qualities: [], mediaRenditions: [] });
    destroyPreviewPlayback();
    setPreviewStatus('正在解析预览地址...');
    const shouldOverlayPreview = shouldShowPreviewAsOverlay();
    if (shouldOverlayPreview) {
        previewModal.classList.add('is-active', 'is-preview-overlay');
        previewModal.setAttribute('aria-hidden', 'false');
        if (window.lucide) lucide.createIcons();
    } else {
        openModal('preview');
        if (activeModalId !== 'preview') {
            activateModalPanel('preview');
        }
    }
    window.setTimeout(syncPreviewOptionsRailHeight, 0);
}

function getResolvedTaskPreviewModel(task) {
    if (!task) return null;

    const title = task.title || '视频预览';
    const taskUrl = String(task.url || '').trim();
    const qualities = Array.isArray(task.qualities)
        ? task.qualities.filter(quality => String(quality?.url || '').trim())
        : [];

    if (qualities.length > 0) {
        return {
            title,
            url: taskUrl,
            qualities,
            mediaRenditions: Array.isArray(task.mediaRenditions)
                ? task.mediaRenditions.map(rendition => ({ ...rendition }))
                : []
        };
    }

    if (String(task.playlistType || '').toLowerCase() === 'media' && taskUrl) {
        return {
            title,
            url: taskUrl,
            qualities: []
        };
    }

    return null;
}

async function previewTaskSource(task, options = {}) {
    const requestId = options.requestId || activePreviewRequestId;
    const detected = await detectHlsSource({
        ...task,
        isPreviewRequest: true
    });
    if (requestId !== activePreviewRequestId) return;

    const parsed = parseM3U8Playlist(detected.playlistText, detected.playlistUrl);
    if (requestId !== activePreviewRequestId) return;

    if (parsed.type === 'master') {
        if (!Array.isArray(parsed.qualities) || parsed.qualities.length === 0) {
            throw new Error('当前链接没有可用清晰度');
        }
        openPreviewModal({
            title: task.title || '视频预览',
            url: detected.playlistUrl,
            qualities: parsed.qualities,
            mediaRenditions: parsed.mediaRenditions
        });
        return;
    }

    if (parsed.type !== 'media') {
        throw new Error(NON_HLS_SOURCE_ERROR);
    }

    if (!isPlaylistEncryptionSupported(parsed.encryption)) {
        throw new Error(UNSUPPORTED_M3U8_TYPE_ERROR);
    }

    openPreviewModal({
        title: task.title || '视频预览',
        url: detected.playlistUrl,
        qualities: []
    });
}

function requestTaskPreview(task) {
    if (!task) return;

    const requestId = activePreviewRequestId + 1;
    activePreviewRequestId = requestId;
    const resolvedPreviewModel = getResolvedTaskPreviewModel(task);
    if (resolvedPreviewModel) {
        openPreviewModal(resolvedPreviewModel);
        return Promise.resolve();
    }

    showPreviewLoading(task.title || '视频预览');

    return previewTaskSource(task, { requestId }).catch(error => {
        if (requestId !== activePreviewRequestId) return;
        const message = getUserFacingErrorMessage(error, '预览失败');
        setPreviewStatus(message || '预览失败');
        showToast(message || '预览失败', { type: isUserAbortError(error) ? 'info' : 'error' });
    });
}

function buildPendingTaskTitle(url, title, overrides = {}) {
    const taskParams = {
        ...defaultTaskParams,
        ...overrides
    };
    const draftTaskId = `draft-${Date.now()}`;
    return title || applyTitleTemplate(url, taskParams.titleTemplate, draftTaskId);
}

async function resolveNewTaskSource(taskDraft) {
    const probeTask = {
        id: `pending-task-probe-${nextPendingTaskProbeId++}`,
        title: buildPendingTaskTitle(taskDraft.url, taskDraft.title, taskDraft),
        url: taskDraft.url,
        format: taskDraft.format,
        duration: '00:00:00',
        streamSave: taskDraft.streamSave,
        concurrency: taskDraft.concurrency,
        downloadRangeMode: taskDraft.downloadRangeMode,
        status: 'detecting',
        progress: 0,
        createdAt: 0,
        updatedAt: 0,
        errorMessage: '',
        playlistType: '',
        segmentCount: 0,
        requestedSegmentCount: 0,
        segments: [],
        qualities: [],
        selectedQualityId: '',
        selectedQualityLabel: '',
        actualRangeStart: 0,
        actualRangeEnd: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        downloadSpeedBytesPerSecond: 0,
        estimatedRemainingSeconds: 0,
        outputFileName: ''
    };
    const scopedProbeTask = beginStandaloneTaskRequestScope(probeTask);
    try {
        const detected = await detectHlsSource(scopedProbeTask);
        const parsed = parseM3U8Playlist(detected.playlistText, detected.playlistUrl);
        return {
            playlistUrl: detected.playlistUrl,
            parsed
        };
    } finally {
        endStandaloneTaskRequestScope(probeTask.id);
    }
}

function resetPendingTaskDraft() {
    pendingTaskDraft = null;
    pendingQualitySelectionId = '';
}

function buildTaskFromResolvedDraft(taskDraft, resolvedSource, range = null) {
    const taskParams = {
        ...defaultTaskParams,
        ...taskDraft
    };
    const taskId = Date.now().toString();
    const now = Date.now();
    const parsed = resolvedSource?.parsed ?? {};
    const segments = Array.isArray(parsed.segments) ? parsed.segments : [];
    const confirmedRange = range
        && Number(range.start) > 0
        && Number(range.end) >= Number(range.start)
        && Number(range.end) <= segments.length;
    const actualRangeStart = confirmedRange ? Number(range.start) : (segments.length > 0 ? 1 : 0);
    const actualRangeEnd = confirmedRange ? Number(range.end) : segments.length;
    const requestedSegmentCount = confirmedRange
        ? (actualRangeEnd - actualRangeStart + 1)
        : segments.length;
    const title = taskDraft.title || applyTitleTemplate(taskDraft.url, taskParams.titleTemplate, taskId);
    return {
        id: taskId,
        title,
        url: taskDraft.url,
        format: taskParams.format,
        duration: parsed.duration || '00:00:00',
        streamSave: taskParams.streamSave,
        concurrency: taskParams.concurrency,
        downloadRangeMode: taskParams.downloadRangeMode,
        status: 'queued',
        progress: 0,
        createdAt: now,
        updatedAt: now,
        errorMessage: '',
        playlistType: parsed.type === 'media' ? 'media' : '',
        playlistContainer: String(parsed.container || taskDraft.playlistContainer || ''),
        segmentCount: segments.length,
        requestedSegmentCount,
        segments: segments.map(segment => ({ ...segment })),
        qualities: Array.isArray(taskDraft.qualities) ? taskDraft.qualities.map(quality => ({ ...quality })) : [],
        selectedQualityId: taskDraft.selectedQualityId || '',
        selectedQualityLabel: taskDraft.selectedQualityLabel || '',
        mediaRenditions: Array.isArray(taskDraft.mediaRenditions)
            ? taskDraft.mediaRenditions.map(rendition => ({ ...rendition }))
            : (Array.isArray(parsed.mediaRenditions) ? parsed.mediaRenditions.map(rendition => ({ ...rendition })) : []),
        selectedAudioRenditionId: taskDraft.selectedAudioRenditionId || '',
        selectedSubtitleRenditionId: taskDraft.selectedSubtitleRenditionId || '',
        selectedOutputMode: taskDraft.selectedOutputMode || '',
        actualOutputMode: taskDraft.actualOutputMode || '',
        actualRangeStart,
        actualRangeEnd,
        recoveryMode: '',
        recoveryTargetSequence: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        downloadSpeedBytesPerSecond: 0,
        estimatedRemainingSeconds: 0,
        outputFileName: ''
    };
}

function enqueueResolvedTaskDraft(taskDraft, resolvedSource, range = null) {
    const newTask = buildTaskFromResolvedDraft(taskDraft, resolvedSource, range);
    currentTasks.unshift(newTask);
    selectedTaskIds.delete(newTask.id);
    if (typeof saveTasksToStorage === 'function') {
        saveTasksToStorage();
    }
    renderTasks();
    scheduleNextQueuedTask();
    return newTask;
}

function resetPendingRangeTaskDraft() {
    pendingRangeTaskDraft = null;
}

function openPendingTaskRangeModal(taskDraft, resolvedSource) {
    const draftTitle = buildPendingTaskTitle(taskDraft.url, taskDraft.title, taskDraft);
    pendingRangeTaskDraft = {
        taskDraft: {
            ...taskDraft,
            title: draftTitle
        },
        resolvedSource
    };
    activeRangeSelectionTaskId = 'pending-task-draft';
    pendingRangeStart = '1';
    pendingRangeEnd = String(Array.isArray(resolvedSource?.parsed?.segments)
        ? resolvedSource.parsed.segments.length
        : '');
    renderDownloadRangeModalContent(getPendingRangeTaskModalModel());
    openModal('download-range');
}

function getPendingRangeTaskModalModel() {
    if (!pendingRangeTaskDraft) {
        return null;
    }

    const parsed = pendingRangeTaskDraft.resolvedSource?.parsed ?? {};
    return {
        id: 'pending-task-draft',
        title: pendingRangeTaskDraft.taskDraft.title || '确认下载范围',
        downloadRangeMode: pendingRangeTaskDraft.taskDraft.downloadRangeMode,
        actualRangeStart: 0,
        actualRangeEnd: 0,
        segments: Array.isArray(parsed.segments) ? parsed.segments : []
    };
}

function openPendingTaskQualityModal(taskDraft, qualities) {
    const draftTitle = buildPendingTaskTitle(taskDraft.url, taskDraft.title, taskDraft);
    pendingTaskDraft = {
        ...taskDraft,
        title: draftTitle,
        qualities: qualities.map(quality => ({ ...quality })),
        mediaRenditions: Array.isArray(taskDraft.mediaRenditions)
            ? taskDraft.mediaRenditions.map(rendition => ({ ...rendition }))
            : [],
        selectedQualityId: getRecommendedQualityId(qualities)
    };
    openDownloadQualityModal('');
}

function getPendingTaskQualityModalModel() {
    if (!pendingTaskDraft) {
        return null;
    }

    return {
        id: '',
        title: pendingTaskDraft.title,
        qualities: pendingTaskDraft.qualities,
        mediaRenditions: pendingTaskDraft.mediaRenditions,
        selectedQualityId: pendingQualitySelectionId
            || pendingTaskDraft.selectedQualityId
            || getRecommendedQualityId(pendingTaskDraft.qualities),
        selectedAudioRenditionId: pendingTaskDraft.selectedAudioRenditionId || '',
        selectedSubtitleRenditionId: pendingTaskDraft.selectedSubtitleRenditionId || ''
    };
}

function syncNewTaskCreateBusyUI() {
    const previewBtn = document.getElementById('preview-new-download-btn');
    const confirmBtn = document.getElementById('confirm-new-download-btn');
    const confirmSpinner = document.getElementById('confirm-new-download-spinner');
    const confirmLabel = document.getElementById('confirm-new-download-label');

    if (previewBtn) {
        previewBtn.disabled = isNewTaskCreateBusy;
    }

    if (confirmBtn) {
        confirmBtn.disabled = isNewTaskCreateBusy;
    }

    if (confirmSpinner) {
        confirmSpinner.classList.toggle('hidden', !isNewTaskCreateBusy);
    }

    if (confirmLabel) {
        confirmLabel.textContent = isNewTaskCreateBusy ? '解析中...' : '开始下载';
    }
}

function setNewTaskCreateBusy(nextBusy) {
    isNewTaskCreateBusy = Boolean(nextBusy);
    syncNewTaskCreateBusyUI();
}

async function handleNewTaskCreate() {
    if (isNewTaskCreateBusy) {
        return;
    }

    const taskDraft = getValidatedNewTaskDraft();
    if (!taskDraft) {
        return;
    }

    setNewTaskCreateBusy(true);

    try {
        const resolvedSource = await resolveNewTaskSource(taskDraft);
        const parsed = resolvedSource?.parsed;

        if (parsed?.type === 'master') {
            setNewTaskCreateBusy(false);
            if (!Array.isArray(parsed.qualities) || parsed.qualities.length === 0) {
                showToast('当前链接没有可用清晰度', { type: 'info' });
                return;
            }

            openPendingTaskQualityModal({
                ...taskDraft,
                mediaRenditions: Array.isArray(parsed.mediaRenditions)
                    ? parsed.mediaRenditions.map(rendition => ({ ...rendition }))
                    : []
            }, parsed.qualities);
            return;
        }

        if (parsed?.type === 'media' && taskDraft.downloadRangeMode === 'custom') {
            setNewTaskCreateBusy(false);
            openPendingTaskRangeModal(taskDraft, resolvedSource);
            return;
        }

        if (parsed?.type === 'media') {
            enqueueResolvedTaskDraft(taskDraft, resolvedSource);
        } else {
            addNewTask(taskDraft.url, taskDraft.title, taskDraft);
        }
        closeModal();
        resetNewTaskFormToDefaults();
    } catch (error) {
        setNewTaskCreateBusy(false);
        showRuntimeErrorToast(error, '链接解析失败');
    }
}

function getTaskActualRange(task) {
    const totalSegments = Array.isArray(task?.segments) ? task.segments.length : 0;
    const start = Number(task?.actualRangeStart) || 0;
    const end = Number(task?.actualRangeEnd) || 0;

    if (task?.downloadRangeMode === 'custom') {
        if (start > 0 && end >= start && end <= totalSegments) {
            return { start, end };
        }

        return { start: 0, end: 0 };
    }

    if (start > 0 && end >= start && end <= totalSegments) {
        return { start, end };
    }

    if (totalSegments > 0) {
        return { start: 1, end: totalSegments };
    }

    return { start: 0, end: 0 };
}

function getEffectiveTaskSegments(task) {
    const segments = Array.isArray(task?.segments) ? task.segments : [];
    if (segments.length === 0) {
        return [];
    }

    if (task?.downloadRangeMode !== 'custom') {
        return segments;
    }

    const { start, end } = getTaskActualRange(task);
    if (start <= 0 || end <= 0) {
        return segments;
    }

    return segments.filter(segment => {
        const sequence = Number(segment?.sequence);
        return sequence >= start && sequence <= end;
    });
}

function isTaskSegmentWithinActualRange(task, segment) {
    if (task?.downloadRangeMode !== 'custom') {
        return true;
    }

    const segments = Array.isArray(task?.segments) ? task.segments : [];
    if (segments.length === 0) {
        return false;
    }

    const start = Number(task?.actualRangeStart) || 0;
    const end = Number(task?.actualRangeEnd) || 0;
    if (start <= 0 || end <= 0 || end < start) {
        return false;
    }

    const sequence = Number(segment?.sequence);
    return Number.isFinite(sequence) && sequence >= start && sequence <= end;
}

function getPendingRangePreviewCount(totalSegments, startValue, endValue) {
    const start = Number.parseInt(startValue, 10);
    const end = Number.parseInt(endValue, 10);
    if (!Number.isInteger(start) || !Number.isInteger(end) || totalSegments <= 0) {
        return 0;
    }
    if (start < 1 || end < start || end > totalSegments) {
        return 0;
    }
    return end - start + 1;
}

function getRangeValidationMessage(totalSegments, startValue, endValue) {
    const start = Number.parseInt(startValue, 10);
    const end = Number.parseInt(endValue, 10);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
        return '请输入有效的起始片号和结束片号。';
    }
    if (start < 1) {
        return '起始片号必须大于或等于 1。';
    }
    if (end > totalSegments) {
        return `结束片号不能大于总片数 ${totalSegments}。`;
    }
    if (end < start) {
        return '结束片号不能小于起始片号。';
    }
    return '';
}

function renderDownloadRangeModalContent(task) {
    const taskTitleEl = document.getElementById('download-range-task-title');
    const totalCountEl = document.getElementById('download-range-total-count');
    const startInput = document.getElementById('download-range-start-input');
    const endInput = document.getElementById('download-range-end-input');
    const previewCountEl = document.getElementById('download-range-preview-count');
    const errorEl = document.getElementById('download-range-error');
    const confirmBtn = document.getElementById('confirm-download-range-btn');

    if (!taskTitleEl || !totalCountEl || !startInput || !endInput || !previewCountEl || !errorEl || !confirmBtn) return;

    const totalSegments = Array.isArray(task?.segments) ? task.segments.length : 0;
    taskTitleEl.textContent = task?.title || '确认下载范围';
    totalCountEl.textContent = String(totalSegments);

    if (!pendingRangeStart) {
        pendingRangeStart = task?.actualRangeStart > 0 ? String(task.actualRangeStart) : '1';
    }
    if (!pendingRangeEnd) {
        pendingRangeEnd = task?.actualRangeEnd > 0 ? String(task.actualRangeEnd) : String(totalSegments || '');
    }

    startInput.value = pendingRangeStart;
    endInput.value = pendingRangeEnd;

    const previewCount = getPendingRangePreviewCount(totalSegments, pendingRangeStart, pendingRangeEnd);
    previewCountEl.textContent = previewCount > 0 ? String(previewCount) : '--';

    const validationMessage = getRangeValidationMessage(totalSegments, pendingRangeStart, pendingRangeEnd);
    errorEl.textContent = validationMessage;
    errorEl.classList.toggle('hidden', !validationMessage);
    startInput.closest('.form-item')?.classList.toggle('has-error', Boolean(validationMessage));
    endInput.closest('.form-item')?.classList.toggle('has-error', Boolean(validationMessage));
    confirmBtn.disabled = Boolean(validationMessage) || previewCount <= 0;
}

function updatePendingTaskRangeInputs() {
    const startInput = document.getElementById('download-range-start-input');
    const endInput = document.getElementById('download-range-end-input');
    if (!startInput || !endInput) return;

    pendingRangeStart = startInput.value.trim();
    pendingRangeEnd = endInput.value.trim();
    renderDownloadRangeModalContent(getActiveRangeSelectionModel());
}

function getActiveRangeSelectionModel() {
    return pendingRangeTaskDraft
        ? getPendingRangeTaskModalModel()
        : findTaskById(activeRangeSelectionTaskId);
}

function openDownloadRangeModal(taskId) {
    const task = findTaskById(taskId);
    if (!task) return;

    resetPendingRangeTaskDraft();
    activeRangeSelectionTaskId = String(task.id);
    pendingRangeStart = task.actualRangeStart > 0 ? String(task.actualRangeStart) : '1';
    pendingRangeEnd = task.actualRangeEnd > 0
        ? String(task.actualRangeEnd)
        : String(Array.isArray(task.segments) ? task.segments.length : '');
    renderDownloadRangeModalContent(task);
    openModal('download-range');
}

function confirmTaskRangeSelection() {
    const task = getActiveRangeSelectionModel();
    if (!task) return;

    const totalSegments = Array.isArray(task.segments) ? task.segments.length : 0;
    const resolveValidationMessage = typeof getRangeValidationMessage === 'function'
        ? getRangeValidationMessage
        : (resolvedTotalSegments, startValue, endValue) => {
            const start = Number.parseInt(startValue, 10);
            const end = Number.parseInt(endValue, 10);
            if (!Number.isInteger(start) || !Number.isInteger(end)) {
                return '请输入有效的起始片号和结束片号。';
            }
            if (start < 1) {
                return '起始片号必须大于或等于 1。';
            }
            if (end > resolvedTotalSegments) {
                return `结束片号不能大于总片数 ${resolvedTotalSegments}。`;
            }
            if (end < start) {
                return '结束片号不能小于起始片号。';
            }
            return '';
        };
    const validationMessage = resolveValidationMessage(totalSegments, pendingRangeStart, pendingRangeEnd);
    if (validationMessage) {
        renderDownloadRangeModalContent(task);
        return;
    }

    const start = Number.parseInt(pendingRangeStart, 10);
    const end = Number.parseInt(pendingRangeEnd, 10);

    if (pendingRangeTaskDraft) {
        enqueueResolvedTaskDraft(
            pendingRangeTaskDraft.taskDraft,
            pendingRangeTaskDraft.resolvedSource,
            { start, end }
        );
        closeModal();
        activeRangeSelectionTaskId = null;
        resetPendingRangeTaskDraft();
        pendingRangeStart = '';
        pendingRangeEnd = '';
        resetNewTaskFormToDefaults();
        return;
    }

    updateTask(task.id, currentTask => ({
        ...currentTask,
        status: 'queued',
        actualRangeStart: start,
        actualRangeEnd: end,
        errorMessage: ''
    }));

    closeModal();
    activeRangeSelectionTaskId = null;
    pendingRangeStart = '';
    pendingRangeEnd = '';
    scheduleNextQueuedTask();
}

function getForceMergeModeLabel(mode) {
    if (mode === 'discrete') return '离散硬拼';
    return '连续合并';
}

function getForceMergeExportLabel(mode) {
    if (mode === 'discrete') return '本次可导出';
    return '连续可导出';
}

function renderForceMergeModalContent(task) {
    const taskTitleEl = document.getElementById('force-merge-task-title');
    const taskMetaEl = document.getElementById('force-merge-task-meta');
    const warningEl = document.getElementById('force-merge-warning');
    const confirmBtn = document.getElementById('confirm-force-merge-btn');
    const prefixInput = document.getElementById('force-merge-mode-prefix');
    const discreteInput = document.getElementById('force-merge-mode-discrete');
    const discreteOption = discreteInput?.closest('.force-merge-option');

    if (!taskTitleEl || !taskMetaEl || !warningEl || !confirmBtn || !prefixInput || !discreteInput) return;

    const availableCount = countForceMergeAvailableSegments(task);
    const effectiveCount = getEffectiveTaskSegments(task).length;
    const isFmp4 = isFmp4Task(task);
    const isMp4 = task?.format === 'mp4';
    const blocksDiscreteMode = normalizeForceMergeModeForTask(task, 'discrete') !== 'discrete';

    if (blocksDiscreteMode && pendingForceMergeMode === 'discrete') {
        pendingForceMergeMode = 'prefix';
    }

    const selectedMode = normalizeForceMergeModeForTask(task, pendingForceMergeMode);
    const summary = summarizeForceMergeSegments(task, selectedMode);
    const durationLabel = summary.durationSeconds > 0
        ? formatDurationFromSeconds(summary.durationSeconds)
        : '未知';
    const exportLabel = getForceMergeExportLabel(selectedMode);
    const isTooShort = isForceMergeExportTooShort(summary, selectedMode);
    let warningText = '';

    if (isFmp4) {
        warningText = 'fMP4 仅支持连续前缀强制合并。';
    } else if (isMp4) {
        warningText = '离散硬拼仅支持 TS。';
    } else if (isTooShort) {
        warningText = `连续内容过短，建议继续下载到至少 ${formatDurationFromSeconds(MIN_FORCE_MERGE_PREFIX_DURATION_SECONDS)} 后再合并。`;
    } else if (selectedMode === 'discrete') {
        warningText = '离散硬拼会跳过缺失碎片，不保证文件可播放，仅用于抢救可用数据。';
    } else {
        warningText = '只导出连续成功的片段；若片段过少或起点不含关键帧，仍可能无法播放。';
    }

    taskTitleEl.textContent = task?.title || '选择合并方式';
    taskMetaEl.innerHTML = `当前范围 <strong class="force-merge-summary__number">${escapeHTML(effectiveCount)}</strong> 个碎片，已下载 <strong class="force-merge-summary__number">${escapeHTML(availableCount)}</strong> 个；${escapeHTML(exportLabel)} <strong class="force-merge-summary__number">${escapeHTML(summary.count)}</strong> 个，约 <strong class="force-merge-summary__number">${escapeHTML(durationLabel)}</strong>。`;
    prefixInput.checked = pendingForceMergeMode !== 'discrete';
    discreteInput.checked = pendingForceMergeMode === 'discrete';
    discreteInput.disabled = blocksDiscreteMode;
    discreteOption?.classList.toggle('is-disabled', blocksDiscreteMode);
    warningEl.textContent = warningText;
    warningEl.classList.toggle('hidden', !warningText);
    warningEl.classList.toggle('is-warning', isTooShort);
    confirmBtn.disabled = !canTaskForceMerge(task) || summary.count <= 0 || isTooShort;
}

function updatePendingForceMergeMode() {
    const discreteInput = document.getElementById('force-merge-mode-discrete');
    const selectedMode = discreteInput?.checked ? 'discrete' : 'prefix';
    pendingForceMergeMode = selectedMode === 'discrete' ? 'discrete' : 'prefix';
    renderForceMergeModalContent(findTaskById(activeForceMergeTaskId));
}

function openForceMergeModal(taskId) {
    const task = findTaskById(taskId);
    if (!task || !canTaskRequestForceMerge(task)) return;

    const shouldAutoPause = ['downloading', 'detecting', 'resolving', 'queued'].includes(task.status);
    const mergeTask = shouldAutoPause ? pauseTask(taskId) : task;
    if (!mergeTask || !canTaskForceMerge(mergeTask)) return;

    if (shouldAutoPause) {
        showToast('已暂停任务，可选择强制合并范围', { type: 'info' });
    }

    activeForceMergeTaskId = String(mergeTask.id);
    pendingForceMergeMode = 'prefix';
    renderForceMergeModalContent(mergeTask);
    openModal('force-merge');
}

async function confirmForceMergeSelection() {
    const taskId = activeForceMergeTaskId;
    const task = findTaskById(taskId);
    if (!task) return;

    const mode = normalizeForceMergeModeForTask(task, pendingForceMergeMode);
    await forceMergeTask(taskId, mode);
    closeModal();
    activeForceMergeTaskId = null;
    pendingForceMergeMode = 'prefix';
}

function getMatchingMediaRenditions(quality, mediaRenditions) {
    const renditions = Array.isArray(mediaRenditions) ? mediaRenditions : [];
    const audioGroupId = String(quality?.audioGroupId || '').trim();
    const subtitleGroupId = String(quality?.subtitleGroupId || '').trim();

    return {
        audio: audioGroupId
            ? renditions.filter(rendition => (
                String(rendition?.type || '').toUpperCase() === 'AUDIO'
                && String(rendition?.groupId || '') === audioGroupId
                && Boolean(rendition?.downloadable)
            ))
            : [],
        subtitles: subtitleGroupId
            ? renditions.filter(rendition => (
                String(rendition?.type || '').toUpperCase() === 'SUBTITLES'
                && String(rendition?.groupId || '') === subtitleGroupId
                && Boolean(rendition?.downloadable)
            ))
            : []
    };
}

function getDefaultAudioRenditionId(renditions) {
    const candidates = Array.isArray(renditions) ? renditions : [];
    if (candidates.length === 0) return '';

    const isAudioDescription = rendition => {
        const values = [
            rendition?.name,
            rendition?.language,
            rendition?.rawTag
        ].map(value => String(value || '').toLowerCase());
        return values.some(value => (
            value.includes('audio description')
            || value.includes('descriptive')
            || value.includes('public.accessibility.describes-video')
        ));
    };

    const preferred = candidates.find(rendition => rendition?.default && !isAudioDescription(rendition))
        || candidates.find(rendition => !isAudioDescription(rendition))
        || candidates.find(rendition => rendition?.default)
        || candidates[0];
    return String(preferred?.id || '');
}

function getRenditionOptionMeta(rendition, fallback) {
    return [
        rendition?.language,
        rendition?.channels,
        rendition?.forced ? '强制字幕' : ''
    ].map(value => String(value || '').trim()).filter(Boolean).join(' / ') || fallback;
}

function getSelectedDownloadQuality(taskDraftOrTask, selectedQuality) {
    if (selectedQuality) return selectedQuality;
    const qualities = Array.isArray(taskDraftOrTask?.qualities) ? taskDraftOrTask.qualities : [];
    const selectedQualityId = pendingQualitySelectionId
        || taskDraftOrTask?.selectedQualityId
        || getRecommendedQualityId(qualities);
    return qualities.find(quality => String(quality.id) === String(selectedQualityId)) || qualities[0] || null;
}

function getDownloadOptionTabElements(option) {
    const key = String(option || '');
    return {
        tab: document.querySelector(`[data-download-option-tab="${key}"]`),
        panel: document.querySelector(`.download-option-panel[data-download-option-panel="${key}"]`)
    };
}

function activateDownloadOptionTab(option) {
    const requested = String(option || 'quality');
    const target = getDownloadOptionTabElements(requested);
    const activeOption = target.tab && !target.tab.classList.contains('hidden') ? requested : 'quality';

    document.querySelectorAll('[data-download-option-tab]').forEach(tab => {
        const isActive = tab.dataset.downloadOptionTab === activeOption;
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
    });

    document.querySelectorAll('.download-option-panel').forEach(panel => {
        panel.classList.toggle('hidden', panel.dataset.downloadOptionPanel !== activeOption);
    });
}

function setDownloadOptionTabAvailability(option, isAvailable) {
    const key = String(option || '');
    if (key === 'quality') return;

    const { tab, panel } = getDownloadOptionTabElements(key);
    const shouldShow = Boolean(isAvailable);
    if (tab) {
        tab.classList.toggle('hidden', !shouldShow);
        tab.setAttribute('aria-hidden', String(!shouldShow));
    }
    if (panel) {
        panel.classList.toggle('is-unavailable', !shouldShow);
    }

    if (!shouldShow && tab?.classList.contains('is-active')) {
        activateDownloadOptionTab('quality');
    }
}

function updateDownloadOptionTabsVisibility() {
    const tabs = document.getElementById('download-option-tabs');
    if (!tabs) return;

    const hasSecondaryTabs = Array.from(tabs.querySelectorAll('.download-option-tab'))
        .some(tab => (
            tab.dataset.downloadOptionTab !== 'quality'
            && !tab.classList.contains('hidden')
        ));
    tabs.classList.toggle('hidden', !hasSecondaryTabs);
    if (!hasSecondaryTabs) {
        activateDownloadOptionTab('quality');
    }
}

function bindDownloadOptionTabs() {
    document.querySelectorAll('[data-download-option-tab]').forEach(tab => {
        tab.addEventListener('click', () => {
            if (tab.classList.contains('hidden')) return;
            activateDownloadOptionTab(tab.dataset.downloadOptionTab || 'quality');
        });
    });
}

function bindPreviewOptionTabs() {
    document.querySelectorAll('[data-preview-option-tab]').forEach(tab => {
        const activateTab = () => {
            if (tab.classList.contains('hidden')) return;
            activatePreviewOptionTab(tab.dataset.previewOptionTab || 'quality');
        };
        tab.addEventListener('click', activateTab);
        tab.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            activateTab();
        });
    });
}

function renderDownloadRenditionOptions(taskDraftOrTask, selectedQuality) {
    const audioSection = document.getElementById('download-audio-rendition-section');
    const audioList = document.getElementById('download-audio-rendition-list');
    const subtitleSection = document.getElementById('download-subtitle-rendition-section');
    const subtitleList = document.getElementById('download-subtitle-rendition-list');
    const outputHint = document.getElementById('download-rendition-output-hint');

    if (!audioSection || !audioList || !subtitleSection || !subtitleList || !outputHint) return;

    const quality = getSelectedDownloadQuality(taskDraftOrTask, selectedQuality);
    const matched = getMatchingMediaRenditions(quality, taskDraftOrTask?.mediaRenditions);
    const audioRenditions = matched.audio;
    const subtitleRenditions = matched.subtitles;

    audioSection.classList.toggle('hidden', audioRenditions.length === 0);
    subtitleSection.classList.toggle('hidden', subtitleRenditions.length === 0);
    setDownloadOptionTabAvailability('audio', audioRenditions.length > 0);
    setDownloadOptionTabAvailability('subtitle', subtitleRenditions.length > 0);
    updateDownloadOptionTabsVisibility();

    let selectedAudioId = String(taskDraftOrTask?.selectedAudioRenditionId || '');
    if (!audioRenditions.some(rendition => String(rendition.id) === selectedAudioId)) {
        selectedAudioId = getDefaultAudioRenditionId(audioRenditions);
    }

    let selectedSubtitleId = String(taskDraftOrTask?.selectedSubtitleRenditionId || '');
    if (!subtitleRenditions.some(rendition => String(rendition.id) === selectedSubtitleId)) {
        selectedSubtitleId = '';
    }

    if (pendingTaskDraft) {
        pendingTaskDraft.selectedAudioRenditionId = selectedAudioId;
        pendingTaskDraft.selectedSubtitleRenditionId = selectedSubtitleId;
    }

    audioList.innerHTML = [
        `
            <label class="download-quality-option${selectedAudioId ? '' : ' is-selected'}" for="download-audio-rendition-none">
                <input
                    type="radio"
                    id="download-audio-rendition-none"
                    name="download-audio-rendition-option"
                    value=""
                    ${selectedAudioId ? '' : 'checked'}
                    onchange='selectDownloadAudioRenditionOption("")'
                >
                <span class="form-choice-indicator" aria-hidden="true"></span>
                <span class="download-quality-option__content">
                    <span class="download-quality-option__title">不下载外部音轨</span>
                    <span class="download-quality-option__meta">仅保存所选视频分辨率，可能得到无声视频</span>
                </span>
            </label>
        `,
        ...audioRenditions.map(rendition => {
            const renditionId = String(rendition.id || '');
            const isChecked = renditionId === selectedAudioId;
            return `
                <label class="download-quality-option${isChecked ? ' is-selected' : ''}" for="download-audio-rendition-${escapeHTML(renditionId)}">
                    <input
                        type="radio"
                        id="download-audio-rendition-${escapeHTML(renditionId)}"
                        name="download-audio-rendition-option"
                        value="${escapeHTML(renditionId)}"
                        ${isChecked ? 'checked' : ''}
                        onchange='selectDownloadAudioRenditionOption(${escapeHTML(JSON.stringify(renditionId))})'
                    >
                    <span class="form-choice-indicator" aria-hidden="true"></span>
                    <span class="download-quality-option__content">
                        <span class="download-quality-option__title">${escapeHTML(rendition.name || rendition.language || '音轨')}</span>
                        <span class="download-quality-option__meta">${escapeHTML(getRenditionOptionMeta(rendition, '音轨'))}</span>
                    </span>
                    ${rendition.default && isChecked ? '<span class="download-quality-option__badge">默认</span>' : ''}
                </label>
            `;
        })
    ].join('');

    subtitleList.innerHTML = [
        `
            <label class="download-quality-option${selectedSubtitleId ? '' : ' is-selected'}" for="download-subtitle-rendition-none">
                <input
                    type="radio"
                    id="download-subtitle-rendition-none"
                    name="download-subtitle-rendition-option"
                    value=""
                    ${selectedSubtitleId ? '' : 'checked'}
                    onchange='selectDownloadSubtitleRenditionOption("")'
                >
                <span class="form-choice-indicator" aria-hidden="true"></span>
                <span class="download-quality-option__content">
                    <span class="download-quality-option__title">不下载字幕</span>
                    <span class="download-quality-option__meta">仅保存视频和已选音轨</span>
                </span>
            </label>
        `,
        ...subtitleRenditions.map(rendition => {
            const renditionId = String(rendition.id || '');
            const isChecked = renditionId === selectedSubtitleId;
            return `
                <label class="download-quality-option${isChecked ? ' is-selected' : ''}" for="download-subtitle-rendition-${escapeHTML(renditionId)}">
                    <input
                        type="radio"
                        id="download-subtitle-rendition-${escapeHTML(renditionId)}"
                        name="download-subtitle-rendition-option"
                        value="${escapeHTML(renditionId)}"
                        ${isChecked ? 'checked' : ''}
                        onchange='selectDownloadSubtitleRenditionOption(${escapeHTML(JSON.stringify(renditionId))})'
                    >
                    <span class="form-choice-indicator" aria-hidden="true"></span>
                    <span class="download-quality-option__content">
                        <span class="download-quality-option__title">${escapeHTML(rendition.name || rendition.language || '字幕')}</span>
                        <span class="download-quality-option__meta">${escapeHTML(getRenditionOptionMeta(rendition, '字幕'))}</span>
                    </span>
                    ${rendition.default ? '<span class="download-quality-option__badge">默认</span>' : ''}
                </label>
            `;
        })
    ].join('');

    outputHint.classList.toggle('hidden', !selectedAudioId && !selectedSubtitleId);
}

function renderDownloadQualityModalContent(task) {
    const taskTitleEl = document.getElementById('download-quality-task-title');
    const qualityListEl = document.getElementById('download-quality-list');
    const qualityEmptyEl = document.getElementById('download-quality-empty');
    const confirmBtn = document.getElementById('confirm-download-quality-btn');

    if (!taskTitleEl || !qualityListEl || !qualityEmptyEl || !confirmBtn) return;

    const qualities = Array.isArray(task?.qualities) ? task.qualities : [];
    taskTitleEl.textContent = '分辨率选择';
    const hasQualities = qualities.length > 0;
    qualityEmptyEl.classList.toggle('hidden', hasQualities);
    qualityListEl.classList.toggle('hidden', !hasQualities);

    if (!hasQualities) {
        qualityListEl.innerHTML = '';
        renderDownloadRenditionOptions(task, null);
        confirmBtn.disabled = true;
        return;
    }

    const selectedQualityId = pendingQualitySelectionId || task?.selectedQualityId || getRecommendedQualityId(qualities);
    const selectedQuality = qualities.find(quality => String(quality.id) === String(selectedQualityId)) || qualities[0];
    confirmBtn.disabled = !selectedQualityId;

    const displayQualities = getSortedDownloadQualities(qualities);
    qualityListEl.innerHTML = displayQualities.map((quality, index) => {
        const qualityId = String(quality.id);
        const isChecked = qualityId === String(selectedQualityId);
        const resolutionLabel = formatQualityResolution(quality.resolution);
        const bandwidthLabel = typeof quality.bandwidth === 'string' && quality.bandwidth
            ? quality.bandwidth
            : formatQualityBandwidth(quality.bandwidthValue);
        const metaParts = [resolutionLabel, bandwidthLabel].filter(Boolean);
        const optionLabel = quality.label || getQualityDisplayLabel(quality, index);

        return `
            <label class="download-quality-option${isChecked ? ' is-selected' : ''}" for="download-quality-${escapeHTML(qualityId)}">
                <input
                    type="radio"
                    id="download-quality-${escapeHTML(qualityId)}"
                    name="download-quality-option"
                    value="${escapeHTML(qualityId)}"
                    ${isChecked ? 'checked' : ''}
                    onchange='selectDownloadQualityOption(${escapeHTML(JSON.stringify(String(task.id)))}, ${escapeHTML(JSON.stringify(qualityId))})'
                >
                <span class="form-choice-indicator" aria-hidden="true"></span>
                <span class="download-quality-option__content">
                    <span class="download-quality-option__title">${escapeHTML(optionLabel)}</span>
                    ${metaParts.length > 0
            ? `<span class="download-quality-option__meta">${escapeHTML(metaParts.join(' / '))}</span>`
            : ''}
                </span>
                ${quality.isRecommended ? '<span class="download-quality-option__badge">推荐</span>' : ''}
            </label>
        `;
    }).join('');
    renderDownloadRenditionOptions(task, selectedQuality);
}

function selectDownloadQualityOption(taskId, qualityId) {
    pendingQualitySelectionId = String(qualityId);
    void taskId;

    const modalModel = getPendingTaskQualityModalModel();
    if (!modalModel) return;

    renderDownloadQualityModalContent(modalModel);
}

function selectDownloadAudioRenditionOption(renditionId) {
    if (!pendingTaskDraft) return;
    pendingTaskDraft.selectedAudioRenditionId = String(renditionId || '');
    renderDownloadQualityModalContent(getPendingTaskQualityModalModel());
}

function selectDownloadSubtitleRenditionOption(renditionId) {
    if (!pendingTaskDraft) return;
    pendingTaskDraft.selectedSubtitleRenditionId = String(renditionId || '');
    renderDownloadQualityModalContent(getPendingTaskQualityModalModel());
}

function openDownloadQualityModal(taskId) {
    void taskId;

    const modalModel = getPendingTaskQualityModalModel();
    if (!modalModel) return;

    pendingQualitySelectionId = modalModel.selectedQualityId;
    renderDownloadQualityModalContent(modalModel);
    activateDownloadOptionTab('quality');
    openModal('download-quality');
}

function confirmTaskQualitySelection() {
    const draftTask = pendingTaskDraft;
    if (!draftTask) return;

    const selectedQuality = Array.isArray(draftTask.qualities)
        ? draftTask.qualities.find(quality => String(quality.id) === String(pendingQualitySelectionId))
        : null;
    if (!selectedQuality) return;

    const taskDraft = {
        ...draftTask,
        url: selectedQuality.url,
        selectedQualityId: selectedQuality.id,
        selectedQualityLabel: selectedQuality.label,
        mediaRenditions: Array.isArray(draftTask.mediaRenditions)
            ? draftTask.mediaRenditions.map(rendition => ({ ...rendition }))
            : [],
        selectedAudioRenditionId: draftTask.selectedAudioRenditionId || '',
        selectedSubtitleRenditionId: draftTask.selectedSubtitleRenditionId || '',
        selectedOutputMode: draftTask.selectedAudioRenditionId || draftTask.selectedSubtitleRenditionId
            ? 'separate-renditions'
            : 'single-video',
        actualOutputMode: ''
    };

    setNewTaskCreateBusy(true);
    resolveNewTaskSource(taskDraft)
        .then(resolvedSource => {
            setNewTaskCreateBusy(false);
            const parsed = resolvedSource?.parsed;
            if (parsed?.type !== 'media') {
                showToast('当前清晰度没有可用媒体分片', { type: 'error' });
                return;
            }

            if (taskDraft.downloadRangeMode === 'custom') {
                resetPendingTaskDraft();
                pendingQualitySelectionId = '';
                openPendingTaskRangeModal(taskDraft, resolvedSource);
                return;
            }

            enqueueResolvedTaskDraft(taskDraft, resolvedSource);
            closeModal();
            resetPendingTaskDraft();
            pendingQualitySelectionId = '';
            resetNewTaskFormToDefaults();
        })
        .catch(error => {
            setNewTaskCreateBusy(false);
            showRuntimeErrorToast(error, '清晰度解析失败');
        });
}

function hasActiveBlockingTask() {
    return Array.isArray(currentTasks) && currentTasks.some(task => (
        ['detecting', 'resolving', 'preparing', 'downloading', 'finalizing'].includes(task?.status)
    ));
}

function handleBeforeUnload(event) {
    if (!hasActiveBlockingTask()) return;

    event.preventDefault();
    event.returnValue = '';
}

function setupEventListeners() {
    document.addEventListener('paste', handleGlobalPaste);
    document.addEventListener('mouseover', handleTooltipMouseOver);
    document.addEventListener('mouseout', handleTooltipMouseOut);
    document.addEventListener('focusin', handleTooltipFocusIn);
    document.addEventListener('focusout', handleTooltipFocusOut);
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('scroll', handleViewportChangeForTooltip, true);
        window.addEventListener('resize', handleViewportChangeForTooltip);
        window.addEventListener('resize', syncPreviewOptionsRailHeight);
        window.addEventListener('beforeunload', handleBeforeUnload);
    }

    // Theme Toggle
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    if (themeToggleBtn) themeToggleBtn.addEventListener('click', toggleTheme);

    const siteLogoLink = document.getElementById('site-logo-link');
    if (siteLogoLink) siteLogoLink.addEventListener('click', goHomeFromLogo);

    // Buttons
    const heroNewBtn = document.getElementById('hero-new-download-btn');
    if (heroNewBtn) heroNewBtn.addEventListener('click', () => openModal('new-task'));

    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) settingsBtn.addEventListener('click', () => openModal('settings'));

    const helpBtn = document.getElementById('help-btn');
    if (helpBtn) helpBtn.addEventListener('click', () => openModal('help'));

    const taskListNewBtn = document.getElementById('task-list-new-download-btn');
    if (taskListNewBtn) {
        taskListNewBtn.addEventListener('click', () => openModal('new-task'));
    }

    const taskListSelectAllToggle = document.getElementById('task-list-select-all-toggle');
    if (taskListSelectAllToggle) {
        taskListSelectAllToggle.addEventListener('change', event => {
            setAllTaskSelections(Boolean(event.target?.checked));
        });
    }

    const taskListBatchStartBtn = document.getElementById('task-list-batch-start-btn');
    if (taskListBatchStartBtn) {
        taskListBatchStartBtn.addEventListener('click', batchStartSelectedTasks);
    }

    const taskListBatchPauseBtn = document.getElementById('task-list-batch-pause-btn');
    if (taskListBatchPauseBtn) {
        taskListBatchPauseBtn.addEventListener('click', batchPauseSelectedTasks);
    }

    const taskListBatchDeleteBtn = document.getElementById('task-list-batch-delete-btn');
    if (taskListBatchDeleteBtn) {
        taskListBatchDeleteBtn.addEventListener('click', batchDeleteSelectedTasks);
    }

    const confirmDownloadQualityBtn = document.getElementById('confirm-download-quality-btn');
    if (confirmDownloadQualityBtn) {
        confirmDownloadQualityBtn.addEventListener('click', confirmTaskQualitySelection);
    }
    bindDownloadOptionTabs();
    bindPreviewOptionTabs();

    const confirmDownloadRangeBtn = document.getElementById('confirm-download-range-btn');
    if (confirmDownloadRangeBtn) {
        confirmDownloadRangeBtn.addEventListener('click', confirmTaskRangeSelection);
    }

    const confirmForceMergeBtn = document.getElementById('confirm-force-merge-btn');
    if (confirmForceMergeBtn) {
        confirmForceMergeBtn.addEventListener('click', confirmForceMergeSelection);
    }
    const confirmDeleteBtn = document.getElementById('confirm-delete-btn');
    if (confirmDeleteBtn) {
        confirmDeleteBtn.addEventListener('click', confirmPendingTaskDeletion);
    }

    const cleanOrphanCacheBtn = document.getElementById('segment-cache-clean-orphans-btn');
    if (cleanOrphanCacheBtn) {
        cleanOrphanCacheBtn.addEventListener('click', handleCleanupOrphanedSegmentCache);
    }

    const clearSegmentCacheBtn = document.getElementById('segment-cache-clear-btn');
    if (clearSegmentCacheBtn) {
        clearSegmentCacheBtn.addEventListener('click', handleClearSegmentCache);
    }

    const taskFilterStatusControl = document.getElementById('task-filter-status');
    if (taskFilterStatusControl) {
        taskFilterStatusControl.addEventListener('change', event => {
            setTaskFilterStatus(event.target?.value || 'all');
        });
    }

    const downloadRangeStartInput = document.getElementById('download-range-start-input');
    const downloadRangeEndInput = document.getElementById('download-range-end-input');
    [downloadRangeStartInput, downloadRangeEndInput].forEach(control => {
        if (!control) return;
        control.addEventListener('input', updatePendingTaskRangeInputs);
    });

    document.querySelectorAll('input[name="force-merge-mode"]').forEach(control => {
        control.addEventListener('change', updatePendingForceMergeMode);
    });

    // Close Modals
    document.querySelectorAll('.close-modal-btn').forEach(btn => {
        btn.addEventListener('pointerdown', handleModalClosePointerDown);
        btn.addEventListener('click', closeModal);
    });

    // Overlay click to close
    modalOverlay.addEventListener('click', (e) => {
        if (e.target !== modalOverlay) return;
        if (activeModalId === 'new-task') return;
        if (activeModalId === 'details') return;
        if (activeModalId === 'download-range') return;
        closeModal();
    });

    document.addEventListener('keydown', handleModalKeydown);

    modalPanels.forEach(panel => {
        panel.addEventListener('click', (e) => e.stopPropagation());
    });

    const newUrlInput = document.getElementById('new-url');
    if (newUrlInput) {
        newUrlInput.addEventListener('input', () => {
            if (newUrlInput.value.trim()) {
                clearNewUrlError();
            }
        });
    }

    const previewNewBtn = document.getElementById('preview-new-download-btn');
    if (previewNewBtn) {
        previewNewBtn.addEventListener('click', handleNewTaskPreview);
    }

    document.querySelectorAll('input[name="new-range-mode"]').forEach(control => {
        control.addEventListener('change', syncNewTaskRangeModeUI);
    });

    // New Task Confirm
    const confirmNewBtn = document.getElementById('confirm-new-download-btn');
    if (confirmNewBtn) {
        confirmNewBtn.addEventListener('click', handleNewTaskCreate);
    }

    // Settings Save
    const saveSettingsBtn = document.getElementById('save-settings-btn');
    if (saveSettingsBtn) {
        saveSettingsBtn.addEventListener('click', () => {
            defaultTaskParams = getSettingsFormValues();
            saveDefaultTaskParams(defaultTaskParams);
            applyDefaultTaskParamsToSettingsForm();
            if (!activeModalId) {
                resetNewTaskFormToDefaults();
            }
            closeModal();
            showToast('设置已保存', { type: 'success' });
        });
    }
}

function handleNewTaskPreview() {
    if (isNewTaskCreateBusy) {
        return;
    }

    const taskDraft = getValidatedNewTaskDraft();
    if (!taskDraft) {
        return;
    }

    const previewTask = {
        id: 'pending-preview',
        title: buildPendingTaskTitle(taskDraft.url, taskDraft.title, taskDraft),
        url: taskDraft.url,
        status: 'detecting'
    };

    requestTaskPreview(previewTask);
}

function prepareModalBeforeOpen(modalId) {
    if (modalId === 'new-task') {
        resetNewTaskFormToDefaults();
    }

    if (modalId === 'settings') {
        applyDefaultTaskParamsToSettingsForm();
    }

    if (modalId === 'download-range' && activeRangeSelectionTaskId) {
        renderDownloadRangeModalContent(getActiveRangeSelectionModel());
    }

    if (modalId === 'force-merge' && activeForceMergeTaskId) {
        renderForceMergeModalContent(findTaskById(activeForceMergeTaskId));
    }
}

function openModal(modalId) {
    if (isModalClosing && !activeModalId) {
        finalizeModalClose();
    }

    const modalEl = modalById[modalId];
    if (!modalEl) return;
    if (!activeModalId && pendingModalId === modalId) {
        pendingModalId = null;
    }
    if (pendingModalId === modalId) return;

    if (activeModalId === modalId && !isModalClosing) return;

    if (isModalClosing) {
        pendingModalId = modalId;
        return;
    }

    if (activeModalId && activeModalId !== modalId) {
        pendingModalId = modalId;
        closeModal();
        return;
    }

    if (document.activeElement instanceof HTMLElement && !modalOverlay.contains(document.activeElement)) {
        lastFocusedElementBeforeModal = document.activeElement;
    }

    prepareModalBeforeOpen(modalId);

    activeModalId = modalId;
    pendingModalId = null;
    document.body.classList.add('modal-open');
    modalOverlay.classList.remove('is-closing');
    modalOverlay.classList.add('is-open');
    modalOverlay.setAttribute('aria-hidden', 'false');

    modalPanels.forEach(panel => {
        const isActive = panel.dataset.modal === modalId;
        panel.classList.toggle('is-active', isActive);
        panel.setAttribute('aria-hidden', String(!isActive));
    });
}

function closeModal() {
    if (!activeModalId || isModalClosing) return;

    hideTooltip();
    if (activeModalId === 'details') {
        activeTaskDetailsId = null;
    }
    if (activeModalId === 'preview') {
        activePreviewRequestId += 1;
        destroyPreviewPlayback();
        pendingPreviewSource = null;
        pendingPreviewQualityId = '';
    }
    if (isPreviewOverlayActive()) {
        closePreviewOverlay();
    }
    if (activeModalId === 'confirm-delete') {
        cancelPendingTaskDeletion();
    }
    restoreFocusBeforeModalHide();
    isModalClosing = true;
    modalOverlay.classList.remove('is-open');
    modalOverlay.classList.add('is-closing');

    window.setTimeout(() => {
        finalizeModalClose();
    }, MODAL_CLOSE_DURATION_MS);
}

function handleModalClosePointerDown(event) {
    if (event?.pointerType === 'mouse' && event.button !== 0) return;

    event?.preventDefault?.();
    event?.stopPropagation?.();

    if (event?.currentTarget?.closest?.('#preview-modal') && isPreviewOverlayActive()) {
        closePreviewOverlay();
        return;
    }

    closeModal();
}

function finalizeModalClose() {
    hideTooltip();
    modalOverlay.classList.remove('is-closing');
    modalOverlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');

    modalPanels.forEach(panel => {
        panel.classList.remove('is-active');
        panel.setAttribute('aria-hidden', 'true');
    });

    const nextModalId = pendingModalId;
    activeModalId = null;
    pendingModalId = null;
    isModalClosing = false;
    shouldSkipModalFallbackFocus = false;
    lastFocusedElementBeforeModal = null;

    if (!nextModalId) {
        resetNewTaskFormToDefaults();
        activeTaskDetailsId = null;
        pendingQualitySelectionId = '';
        resetPendingTaskDraft();
        activeRangeSelectionTaskId = null;
        resetPendingRangeTaskDraft();
        pendingRangeStart = '';
        pendingRangeEnd = '';
        activeForceMergeTaskId = null;
        pendingForceMergeMode = 'prefix';
        pendingDeleteConfirmation = null;
        pendingPreviewSource = null;
        pendingPreviewQualityId = '';
        activePreviewRequestId += 1;
    }

    if (nextModalId) {
        openModal(nextModalId);
    }
}

function handleModalKeydown(event) {
    if (event.key === 'Escape') {
        closeModal();
    }
}

function restoreFocusBeforeModalHide() {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return;
    if (!modalOverlay.contains(document.activeElement)) return;

    if (isFocusableElement(lastFocusedElementBeforeModal)) {
        lastFocusedElementBeforeModal.focus();
        return;
    }

    if (shouldSkipModalFallbackFocus) return;

    const fallbackFocusTarget = document.getElementById('theme-toggle-btn');
    if (isFocusableElement(fallbackFocusTarget)) {
        fallbackFocusTarget.focus();
    }
}

function isFocusableElement(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (!element.isConnected) return false;
    if (element.matches(':disabled')) return false;
    if (element.getAttribute('aria-hidden') === 'true') return false;
    return element.offsetParent !== null;
}

function handleGlobalPaste(event) {
    if (isEditableTarget(event.target)) return;
    if (activeModalId && activeModalId !== 'new-task') return;

    const pastedText = event.clipboardData?.getData('text/plain')?.trim();
    if (!isSupportedPasteUrl(pastedText)) return;

    event.preventDefault();
    shouldSkipModalFallbackFocus = true;
    openModal('new-task');
    populateNewTaskUrl(pastedText);
}

function isEditableTarget(target) {
    if (!(target instanceof Element)) return false;
    if (target.closest('[contenteditable="true"]')) return true;
    return Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}

function isSupportedPasteUrl(text) {
    if (!text || text.startsWith('blob:')) return false;

    try {
        const url = new URL(text);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

function populateNewTaskUrl(url) {
    const urlInput = document.getElementById('new-url');
    if (!urlInput) return;

    urlInput.value = url;
    urlInput.focus();
    const caretPosition = urlInput.value.length;
    urlInput.setSelectionRange(caretPosition, caretPosition);
}

function applyQuickDownloadParamsToNewTaskForm(params) {
    if (!params?.source) return false;

    populateNewTaskUrl(params.source);
    if (typeof params.title === 'string') {
        document.getElementById('new-title').value = params.title;
    }
    if (params.format) {
        setSelectedNewTaskFormat(params.format);
    }
    if (typeof params.streamSave === 'boolean') {
        document.getElementById('new-stream-save').checked = params.streamSave;
    }
    if (params.range) {
        setSelectedNewTaskRangeMode(params.range);
        syncNewTaskRangeModeUI();
    }
    if (typeof params.concurrency === 'number') {
        document.getElementById('new-concurrency').value = String(params.concurrency);
    }

    clearNewUrlError();
    return true;
}

function addNewTask(url, title, overrides = {}) {
    const taskParams = {
        ...defaultTaskParams,
        ...overrides
    };
    const taskId = Date.now().toString();
    const now = Date.now();
    const newTask = {
        id: taskId,
        title: title || applyTitleTemplate(url, taskParams.titleTemplate, taskId),
        url,
        format: taskParams.format,
        duration: '00:00:00',
        streamSave: taskParams.streamSave,
        concurrency: taskParams.concurrency,
        downloadRangeMode: taskParams.downloadRangeMode,
        status: 'queued',
        progress: 0,
        createdAt: now,
        updatedAt: now,
        errorMessage: '',
        playlistType: '',
        segmentCount: 0,
        requestedSegmentCount: 0,
        segments: [],
        qualities: [],
        selectedQualityId: '',
        selectedQualityLabel: '',
        actualRangeStart: 0,
        actualRangeEnd: 0,
        recoveryMode: '',
        recoveryTargetSequence: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        downloadSpeedBytesPerSecond: 0,
        estimatedRemainingSeconds: 0,
        outputFileName: ''
    };
    currentTasks.unshift(newTask);
    selectedTaskIds.delete(taskId);
    if (typeof saveTasksToStorage === 'function') {
        saveTasksToStorage();
    }
    renderTasks();
    scheduleNextQueuedTask();
}

function findTaskById(taskId) {
    return currentTasks.find(task => String(task.id) === String(taskId)) ?? null;
}

function syncTaskRowLive(task) {
    if (!taskListContainer || !task) return false;
    if (typeof taskListContainer.querySelector !== 'function') return false;

    const taskId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(String(task.id))
        : String(task.id).replace(/["\\]/g, '\\$&');
    const taskRow = taskListContainer.querySelector(`.task-row[data-task-id="${taskId}"]`);
    if (!taskRow) return false;

    const progress = normalizeTaskProgress(task.progress);
    const progressNode = taskRow.querySelector('.task-row__progress');
    const progressBar = taskRow.querySelector('.task-row__progress-bar');
    const progressText = taskRow.querySelector('.task-row__progress-text');
    const statusNode = taskRow.querySelector('.task-row__status');
    const writeModeNode = taskRow.querySelector('.task-row__mode-tag');

    if (progressBar) {
        progressBar.style.width = `${progress}%`;
    }
    if (progressText) {
        progressText.textContent = `${progress}%`;
    }
    if (progressNode) {
        progressNode.classList.toggle('is-active-download', task.status === 'downloading' || task.status === 'finalizing');
    }
    if (statusNode) {
        const status = task.status || 'downloading';
        const statusLabel = getTaskDisplayStatusLabel(task);
        statusNode.dataset.status = status;
        if (status === 'downloading' || status === 'finalizing') {
            const speedLabel = formatDownloadSpeed(task.downloadSpeedBytesPerSecond, status);
            const displayLabel = speedLabel && speedLabel !== '--' ? speedLabel : statusLabel;
            const spinnerNode = statusNode.querySelector('.task-row__status-spinner');
            if (spinnerNode) {
                let statusTextNode = Array.from(statusNode.childNodes).find(node => node.nodeType === Node.TEXT_NODE);
                if (!statusTextNode) {
                    statusTextNode = createTaskStatusTextNode('');
                    statusNode.appendChild(statusTextNode);
                }
                statusTextNode.textContent = displayLabel;
            } else {
                statusNode.innerHTML = createTaskStatusContent(task, statusLabel);
            }
        } else {
            statusNode.innerHTML = createTaskStatusContent(task, statusLabel);
            if (window.lucide) lucide.createIcons();
        }
    }
    if (writeModeNode) {
        writeModeNode.dataset.writeMode = getTaskActualWriteMode(task);
        writeModeNode.textContent = getTaskActualWriteModeLabel(task);
        writeModeNode.title = getTaskActualWriteModeSummary(task);
    }
    return true;
}

function updateTask(taskId, updater, options = {}) {
    let updatedTask = null;
    let didUpdate = false;
    currentTasks = currentTasks.map(task => {
        if (String(task.id) !== String(taskId)) return task;

        updatedTask = task;
        const nextTask = updater({ ...task });
        if (nextTask == null) {
            return task;
        }

        didUpdate = true;
        updatedTask = {
            ...nextTask,
            updatedAt: Date.now()
        };
        return updatedTask;
    });

    if (didUpdate) {
        if (options.render === 'live') {
            syncTaskRowLive(updatedTask);
        } else {
            renderTasks();
        }
        if (typeof saveTasksToStorage === 'function') {
            saveTasksToStorage();
        }
        if (typeof syncActiveTaskDetails === 'function') {
            syncActiveTaskDetails();
        }
        if (typeof updateAggregateDownloadStatus === 'function') {
            updateAggregateDownloadStatus();
        }
    }

    return updatedTask;
}

function setTaskStatus(taskId, status) {
    return updateTask(taskId, task => ({
        ...task,
        status
    }));
}

function failTask(taskId, message) {
    return updateTask(taskId, task => ({
        ...task,
        status: 'failed',
        downloadSpeedBytesPerSecond: 0,
        estimatedRemainingSeconds: 0,
        finalizingMessage: '',
        errorMessage: message
    }));
}

function releaseTaskBufferedBytes(task) {
    if (!task || !Array.isArray(task.segments)) return task;
    return {
        ...task,
        segments: task.segments.map(segment => ({
            ...segment,
            bytes: null,
            initBytes: null,
            cacheStored: false,
            streamSaved: segment?.status === 'success' ? true : Boolean(segment?.streamSaved)
        }))
    };
}

function completeTask(taskId, outputFileName) {
    const completedTask = updateTask(taskId, task => releaseTaskBufferedBytes({
        ...task,
        status: 'completed',
        progress: 100,
        recoveryMode: '',
        recoveryTargetSequence: 0,
        downloadSpeedBytesPerSecond: 0,
        estimatedRemainingSeconds: 0,
        outputFileName,
        finalizingMessage: '',
        errorMessage: ''
    }));

    if (completedTask) {
        deleteCachedSegmentsForTask(taskId).then(() => {
            renderSegmentCacheStatusBar();
        });
    }

    return completedTask;
}

function isLikelyM3U8Content(text) {
    const playlistHeader = '#EXTM3U';
    const normalizedText = String(text || '').trim();
    return normalizedText.startsWith(playlistHeader);
}

function parseM3U8AttributeList(rawValue) {
    const attributes = {};
    const value = String(rawValue || '');
    let current = '';
    let isQuoted = false;

    const commitAttribute = (attributeText) => {
        const normalizedAttribute = String(attributeText || '').trim();
        if (!normalizedAttribute) return;

        const separatorIndex = normalizedAttribute.indexOf('=');
        if (separatorIndex < 0) return;

        const key = normalizedAttribute.slice(0, separatorIndex).trim().toUpperCase();
        let attributeValue = normalizedAttribute.slice(separatorIndex + 1).trim();
        if (attributeValue.startsWith('"') && attributeValue.endsWith('"')) {
            attributeValue = attributeValue.slice(1, -1);
        }
        attributes[key] = attributeValue;
    };

    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (character === '"') {
            isQuoted = !isQuoted;
            current += character;
            continue;
        }

        if (character === ',' && !isQuoted) {
            commitAttribute(current);
            current = '';
            continue;
        }

        current += character;
    }

    commitAttribute(current);
    return attributes;
}

function parseHlsKeyTag(line, playlistUrl) {
    const rawTag = String(line || '').trim();
    const attributeText = rawTag.includes(':') ? rawTag.slice(rawTag.indexOf(':') + 1) : '';
    const attributes = parseM3U8AttributeList(attributeText);
    const method = String(attributes.METHOD || '').trim().toUpperCase();

    if (!method || method === 'NONE') {
        return {
            method: 'NONE',
            keyUri: '',
            iv: '',
            rawTag
        };
    }

    const rawUri = String(attributes.URI || '').trim();
    return {
        method,
        keyUri: rawUri ? resolvePlaylistResourceUrl(rawUri, playlistUrl) : '',
        iv: String(attributes.IV || '').trim(),
        rawTag
    };
}

function parseHlsByteRange(value) {
    const rawValue = String(value || '').trim();
    if (!rawValue || !/^(?:0|[1-9]\d*)(?:@(?:0|[1-9]\d*))?$/.test(rawValue)) {
        throw new Error('字节范围信息不完整，无法解析该 fMP4 播放列表。');
    }
    const [lengthText, offsetText = ''] = rawValue.split('@');
    const length = Number(lengthText);
    const offset = offsetText === '' ? null : Number(offsetText);
    if (!Number.isSafeInteger(length) || length <= 0) {
        throw new Error('字节范围信息不完整，无法解析该 fMP4 播放列表。');
    }
    if (offset !== null && (!Number.isSafeInteger(offset) || offset < 0)) {
        throw new Error('字节范围信息不完整，无法解析该 fMP4 播放列表。');
    }
    return { length, offset };
}

function resolveImplicitByteRange(byteRange, resourceUrl, previousRangeEnds) {
    if (!byteRange) return null;
    if (byteRange.offset !== null && Number.isFinite(Number(byteRange.offset))) {
        return {
            length: Number(byteRange.length),
            offset: Number(byteRange.offset)
        };
    }

    const previousEnd = previousRangeEnds.get(resourceUrl);
    if (!Number.isFinite(previousEnd)) {
        throw new Error('字节范围信息不完整，无法解析该 fMP4 播放列表。');
    }
    return {
        length: Number(byteRange.length),
        offset: previousEnd
    };
}

function rememberByteRangeEnd(byteRange, resourceUrl, previousRangeEnds) {
    if (!byteRange || !resourceUrl) return;
    previousRangeEnds.set(resourceUrl, Number(byteRange.offset) + Number(byteRange.length));
}

function parseHlsMapTag(line, playlistUrl) {
    const rawTag = String(line || '').trim();
    const attributeText = rawTag.includes(':') ? rawTag.slice(rawTag.indexOf(':') + 1) : '';
    const attributes = parseM3U8AttributeList(attributeText);
    const rawUri = String(attributes.URI || '').trim();
    if (!rawUri) {
        throw new Error('fMP4 初始化片段缺失，无法导出。');
    }
    return {
        url: resolvePlaylistResourceUrl(rawUri, playlistUrl),
        byteRange: Object.prototype.hasOwnProperty.call(attributes, 'BYTERANGE')
            ? parseHlsByteRange(attributes.BYTERANGE)
            : null,
        rawTag
    };
}

function parseHlsMediaRendition(line, playlistUrl, index) {
    const rawTag = String(line || '').trim();
    const attributeText = rawTag.includes(':') ? rawTag.slice(rawTag.indexOf(':') + 1) : '';
    const attributes = parseM3U8AttributeList(attributeText);
    const type = String(attributes.TYPE || '').trim().toUpperCase();
    const rawUri = String(attributes.URI || '').trim();
    const uri = rawUri ? resolvePlaylistResourceUrl(rawUri, playlistUrl) : '';
    const groupId = String(attributes['GROUP-ID'] || '').trim();
    const name = String(attributes.NAME || '').trim();

    return {
        id: `rendition-${index + 1}`,
        type,
        groupId,
        name,
        language: String(attributes.LANGUAGE || '').trim(),
        uri,
        channels: String(attributes.CHANNELS || '').trim(),
        default: String(attributes.DEFAULT || '').trim().toUpperCase() === 'YES',
        autoselect: String(attributes.AUTOSELECT || '').trim().toUpperCase() === 'YES',
        forced: String(attributes.FORCED || '').trim().toUpperCase() === 'YES',
        downloadable: Boolean(uri) && (type === 'AUDIO' || type === 'SUBTITLES'),
        rawTag
    };
}

function resolvePlaylistResourceUrl(resourceUrl, playlistUrl) {
    const resolvedUrl = new URL(resourceUrl, playlistUrl);
    const resolvedPlaylistUrl = new URL(playlistUrl);
    if (
        resolvedPlaylistUrl.protocol === 'https:'
        && resolvedUrl.protocol === 'http:'
        && resolvedUrl.hostname === resolvedPlaylistUrl.hostname
    ) {
        resolvedUrl.protocol = 'https:';
    }
    return resolvedUrl.toString();
}

function isPlaylistEncryptionSupported(encryption) {
    if (!Array.isArray(encryption) || encryption.length === 0) {
        return true;
    }

    return encryption.every(keyInfo => {
        const method = String(keyInfo?.method || '').toUpperCase();
        if (method === 'NONE') return true;
        return method === 'AES-128' && Boolean(keyInfo?.keyUri);
    });
}

function formatDurationFromSeconds(durationSeconds) {
    const totalSeconds = Math.max(0, Math.round(Number(durationSeconds) || 0));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds]
        .map(value => String(value).padStart(2, '0'))
        .join(':');
}

function parseM3U8Playlist(playlistText, playlistUrl) {
    const resolveDurationFormatter = typeof formatDurationFromSeconds === 'function'
        ? formatDurationFromSeconds
        : (durationSeconds) => {
            const totalSeconds = Math.max(0, Math.round(Number(durationSeconds) || 0));
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            return [hours, minutes, seconds]
                .map(value => String(value).padStart(2, '0'))
                .join(':');
        };
    const resolveQualityResolution = typeof formatQualityResolution === 'function'
        ? formatQualityResolution
        : (resolution) => {
            if (!resolution || typeof resolution !== 'string') return '';
            return resolution.trim();
        };
    const resolveQualityBandwidth = typeof formatQualityBandwidth === 'function'
        ? formatQualityBandwidth
        : (bandwidth) => {
            const numericValue = Number(bandwidth);
            if (!Number.isFinite(numericValue) || numericValue <= 0) return '';
            return `${Math.round(numericValue / 1000)} kbps`;
        };
    const resolveQualityPixels = typeof getQualityResolutionPixels === 'function'
        ? getQualityResolutionPixels
        : (resolution) => {
            const normalizedResolution = resolveQualityResolution(resolution);
            const match = normalizedResolution.match(/^(\d+)\s*x\s*(\d+)$/i);
            if (!match) return 0;
            return Number(match[1]) * Number(match[2]);
        };
    const resolveRecommendedQualityId = typeof getRecommendedQualityId === 'function'
        ? getRecommendedQualityId
        : (qualities) => {
            if (!Array.isArray(qualities) || qualities.length === 0) return '';
            const ranked = [...qualities].sort((left, right) => {
                const leftPixels = Number(left?.resolutionPixels) || 0;
                const rightPixels = Number(right?.resolutionPixels) || 0;
                if (rightPixels !== leftPixels) return rightPixels - leftPixels;

                const leftBandwidth = Number(left?.bandwidthValue) || 0;
                const rightBandwidth = Number(right?.bandwidthValue) || 0;
                if (rightBandwidth !== leftBandwidth) return rightBandwidth - leftBandwidth;

                return 0;
            });
            return ranked[0]?.id || '';
        };
    const resolveQualityLabel = (quality, index) => {
        const readableName = String(quality?.name || '').trim();
        if (readableName) {
            if (/^\d+$/.test(readableName)) {
                return `${readableName}P`;
            }
            return readableName;
        }

        const resolutionLabel = resolveQualityResolution(quality?.resolution);
        const match = resolutionLabel.match(/^\d+\s*x\s*(\d+)$/i);
        const height = Number(match?.[1] ?? 0);
        if (height > 0) {
            return `${height}P`;
        }
        return `清晰度 ${index + 1}`;
    };
    const playlistHeader = '#EXTM3U';
    const lines = String(playlistText || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    const hasPlaylistHeader = lines[0] === playlistHeader;

    const qualities = [];
    const segments = [];
    const mediaRenditions = [];
    const encryption = [];
    let activeEncryption = null;
    let activeInitSegment = null;
    let pendingByteRange = null;
    let playlistContainer = 'transport-stream';
    let unsupportedErrorMessage = '';
    let mediaSequenceBase = 0;
    let pendingSegmentDurationSeconds = 0;
    let totalDurationSeconds = 0;
    const previousRangeEnds = new Map();

    if (!hasPlaylistHeader) {
        return {
            type: 'unknown',
            qualities,
            segments,
            mediaRenditions,
            encryption,
            container: 'unsupported'
        };
    }

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];

        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
            const sequenceValue = Number(line.slice(line.indexOf(':') + 1).trim());
            mediaSequenceBase = Number.isFinite(sequenceValue) && sequenceValue >= 0
                ? sequenceValue
                : 0;
            continue;
        }

        if (line.startsWith('#EXT-X-MEDIA:')) {
            mediaRenditions.push(parseHlsMediaRendition(line, playlistUrl, mediaRenditions.length));
            continue;
        }

        if (line.startsWith('#EXT-X-MAP:')) {
            try {
                activeInitSegment = parseHlsMapTag(line, playlistUrl);
                if (activeInitSegment.byteRange) {
                    activeInitSegment.byteRange = resolveImplicitByteRange(
                        activeInitSegment.byteRange,
                        activeInitSegment.url,
                        previousRangeEnds
                    );
                }
                playlistContainer = 'fmp4';
            } catch (error) {
                unsupportedErrorMessage = String(error?.message || UNSUPPORTED_M3U8_TYPE_ERROR);
            }
            continue;
        }

        if (line.startsWith('#EXT-X-BYTERANGE:')) {
            try {
                pendingByteRange = parseHlsByteRange(line.slice(line.indexOf(':') + 1));
            } catch (error) {
                unsupportedErrorMessage = String(error?.message || '字节范围信息不完整，无法解析该 fMP4 播放列表。');
            }
            continue;
        }

        if (line.startsWith('#EXT-X-STREAM-INF')) {
            const nextLine = lines[index + 1] ?? '';
            if (nextLine && !nextLine.startsWith('#')) {
                const attributes = parseM3U8AttributeList(line.slice(line.indexOf(':') + 1));
                const resolution = resolveQualityResolution(attributes.RESOLUTION || '');
                const bandwidthValue = Number(attributes.BANDWIDTH || 0);
                const name = String(attributes.NAME || '').trim();
                const audioGroupId = String(attributes.AUDIO || '').trim();
                const subtitleGroupId = String(attributes.SUBTITLES || '').trim();
                const closedCaptionsGroupId = String(attributes['CLOSED-CAPTIONS'] || '').trim();
                const codecs = String(attributes.CODECS || '').trim();
                qualities.push({
                    id: `quality-${qualities.length + 1}`,
                    url: resolvePlaylistResourceUrl(nextLine, playlistUrl),
                    label: resolveQualityLabel({
                        name,
                        resolution,
                        bandwidthValue
                    }, qualities.length),
                    name,
                    resolution,
                    bandwidth: resolveQualityBandwidth(bandwidthValue),
                    resolutionPixels: resolveQualityPixels(resolution),
                    bandwidthValue,
                    isRecommended: false,
                    audioGroupId,
                    subtitleGroupId,
                    closedCaptionsGroupId,
                    codecs,
                    rawTag: line
                });
            }
            continue;
        }

        if (line.startsWith('#EXT-X-KEY')) {
            const parsedKey = parseHlsKeyTag(line, playlistUrl);
            encryption.push(parsedKey);
            activeEncryption = parsedKey.method === 'NONE' ? null : parsedKey;
            continue;
        }

        if (line.startsWith('#EXTINF')) {
            const durationText = line.slice(line.indexOf(':') + 1).split(',')[0].trim();
            const durationValue = Number.parseFloat(durationText);
            pendingSegmentDurationSeconds = Number.isFinite(durationValue) && durationValue > 0
                ? durationValue
                : 0;
            continue;
        }

        if (line.startsWith('#')) {
            continue;
        }

        const resolvedSegmentUrl = resolvePlaylistResourceUrl(line, playlistUrl);
        let resolvedByteRange = null;
        try {
            if (pendingByteRange) {
                resolvedByteRange = resolveImplicitByteRange(pendingByteRange, resolvedSegmentUrl, previousRangeEnds);
                rememberByteRangeEnd(resolvedByteRange, resolvedSegmentUrl, previousRangeEnds);
            }
        } catch (error) {
            unsupportedErrorMessage = String(error?.message || '字节范围信息不完整，无法解析该 fMP4 播放列表。');
        }

        const lowerSegmentUrl = resolvedSegmentUrl.toLowerCase();
        const segmentContainer = playlistContainer === 'transport-stream'
            && (lowerSegmentUrl.includes('.vtt') || lowerSegmentUrl.includes('.webvtt'))
            ? 'subtitle'
            : playlistContainer;
        if (segmentContainer === 'subtitle') {
            playlistContainer = 'subtitle';
        }

        totalDurationSeconds += pendingSegmentDurationSeconds;
        segments.push({
            sequence: segments.length + 1,
            mediaSequence: mediaSequenceBase + segments.length,
            url: resolvedSegmentUrl,
            durationSeconds: pendingSegmentDurationSeconds,
            container: segmentContainer,
            byteRange: resolvedByteRange,
            initSegment: activeInitSegment,
            encryption: activeEncryption ? { ...activeEncryption } : null,
            status: 'idle',
            streamSaved: false,
            bytes: null,
            attemptCount: 0,
            errorMessage: ''
        });
        pendingByteRange = null;
        pendingSegmentDurationSeconds = 0;
    }

    if (unsupportedErrorMessage) {
        return {
            type: 'unsupported',
            qualities: [],
            segments: [],
            mediaRenditions,
            encryption,
            container: 'unsupported',
            errorMessage: unsupportedErrorMessage
        };
    }

    if (qualities.length > 0) {
        const recommendedQualityId = resolveRecommendedQualityId(qualities);
        return {
            type: 'master',
            qualities: qualities.map(quality => ({
                ...quality,
                isRecommended: quality.id === recommendedQualityId
            })),
            segments: [],
            mediaRenditions,
            encryption
        };
    }

    return {
        type: 'media',
        qualities: [],
        segments,
        durationSeconds: totalDurationSeconds,
        duration: resolveDurationFormatter(totalDurationSeconds),
        mediaRenditions,
        container: playlistContainer,
        encryption
    };
}

async function detectHlsSource(task) {
    let result;
    const runWithLease = typeof withDownloadRequestLease === 'function'
        ? withDownloadRequestLease
        : async (runtimeTask, resourceUrl, operation) => {
            void runtimeTask;
            void resourceUrl;
            const operationResult = await operation();
            return operationResult?.value ?? operationResult;
        };
    try {
        result = await runWithLease(task, task.url, async () => {
            const response = await fetch(task.url);
            const playlistText = await response.text();
            return {
                value: { response, playlistText },
                status: response.status
            };
        });
    } catch (error) {
        const errorName = String(error?.name || '');
        if (errorName === 'AbortError') {
            throw error;
        }
        throw new Error(SOURCE_ACCESS_RESTRICTED_ERROR);
    }
    const response = result.response;
    const playlistText = result.playlistText;
    if (response.status === 401 || response.status === 403) {
        throw new Error(SOURCE_ACCESS_RESTRICTED_ERROR);
    }
    if (!response.ok || !isLikelyM3U8Content(playlistText)) {
        throw new Error(NON_HLS_SOURCE_ERROR);
    }
    return {
        playlistText,
        playlistUrl: response.url || task.url
    };
}

function mergeResolvedMediaSegments(existingSegments, parsedSegments) {
    const normalizedExistingSegments = Array.isArray(existingSegments) ? existingSegments : [];
    const normalizedParsedSegments = Array.isArray(parsedSegments) ? parsedSegments : [];

    const existingBySequence = new Map();
    const existingByUrl = new Map();

    normalizedExistingSegments.forEach((segment, index) => {
        const normalizedSequence = Number.isFinite(Number(segment?.sequence))
            ? Number(segment.sequence)
            : index + 1;
        const normalizedUrl = typeof segment?.url === 'string' ? segment.url : '';
        const normalizedSegment = {
            ...segment,
            sequence: normalizedSequence,
            url: normalizedUrl
        };

        existingBySequence.set(normalizedSequence, normalizedSegment);
        if (normalizedUrl) {
            existingByUrl.set(normalizedUrl, normalizedSegment);
        }
    });

    return normalizedParsedSegments.map((segment, index) => {
        const normalizedSequence = Number.isFinite(Number(segment?.sequence))
            ? Number(segment.sequence)
            : index + 1;
        const normalizedUrl = typeof segment?.url === 'string' ? segment.url : '';
        const existingSegment = existingBySequence.get(normalizedSequence) || existingByUrl.get(normalizedUrl);

        if (!existingSegment) {
            return segment;
        }

        if (existingSegment.status !== 'success') {
            return {
                ...segment,
                status: existingSegment.status || segment.status,
                bytes: existingSegment.bytes ?? segment.bytes ?? null,
                attemptCount: Number(existingSegment.attemptCount) || 0,
                errorMessage: typeof existingSegment.errorMessage === 'string'
                    ? existingSegment.errorMessage
                    : (segment.errorMessage || '')
            };
        }

        return {
            ...segment,
            status: 'success',
            bytes: existingSegment.bytes ?? null,
            byteLength: Math.max(0, Number(existingSegment.byteLength) || Number(existingSegment.bytes?.byteLength) || 0),
            cacheStored: Boolean(existingSegment.cacheStored),
            streamSaved: Boolean(existingSegment.streamSaved),
            attemptCount: Number(existingSegment.attemptCount) || 0,
            errorMessage: ''
        };
    });
}

function normalizeRuntimeErrorMessage(error, fallbackMessage = '') {
    return getRuntimeErrorInfo(error, fallbackMessage).message;
}

function getRuntimeErrorInfo(error, fallbackMessage = '') {
    const rawMessage = getRuntimeErrorRawMessage(error);
    if (!rawMessage && !fallbackMessage) {
        return createRuntimeErrorInfo('unknown', '操作失败', '', '请稍后重试，或检查链接、网络和浏览器兼容性。');
    }
    if (isUserAbortError(error)) {
        return createRuntimeErrorInfo('user_cancelled', '已取消', '已取消文件保存', '如需继续，请重新选择保存位置。');
    }
    if (isNetworkRequestError(error)) {
        return createRuntimeErrorInfo(
            'source_access',
            '源站限制',
            SOURCE_ACCESS_RESTRICTED_ERROR,
            '请确认该链接在当前浏览器能直接访问；若源站需要 Cookie、Referer 或禁止跨域，纯静态模式无法绕过。'
        );
    }
    if (rawMessage === SOURCE_ACCESS_RESTRICTED_ERROR || /HTTP\s+(401|403)\b/i.test(rawMessage)) {
        return createRuntimeErrorInfo(
            'source_access',
            '源站限制',
            SOURCE_ACCESS_RESTRICTED_ERROR,
            '请确认该链接在当前浏览器能直接访问；若源站需要 Cookie、Referer 或禁止跨域，纯静态模式无法绕过。'
        );
    }
    if (/mixed content|insecure resource|https.*http/i.test(rawMessage)) {
        return createRuntimeErrorInfo(
            'mixed_content',
            'HTTP 分片被浏览器拦截',
            '源播放列表包含 HTTP 分片，HTTPS 页面无法直接请求这些不安全资源。',
            '请使用 HTTPS 分片地址；若源站同域支持 HTTPS，系统会自动尝试升级为 HTTPS。'
        );
    }
    if (rawMessage === NON_HLS_SOURCE_ERROR) {
        return createRuntimeErrorInfo(
            'non_hls',
            '地址不可识别',
            NON_HLS_SOURCE_ERROR,
            '请确认粘贴的是 HLS 播放列表地址，而不是网页地址或普通视频文件地址。'
        );
    }
    if (rawMessage === UNSUPPORTED_M3U8_TYPE_ERROR) {
        return createRuntimeErrorInfo(
            'unsupported_hls',
            '当前 m3u8 类型不支持',
            UNSUPPORTED_M3U8_TYPE_ERROR,
            '当前仅支持普通 HLS 与 AES-128，加密方式或媒体结构不兼容时建议更换源地址。'
        );
    }
    if (rawMessage === MASTER_PLAYLIST_PRESELECTION_ERROR || /master playlist/i.test(rawMessage)) {
        return createRuntimeErrorInfo(
            'quality_selection',
            '需要选择清晰度',
            '当前链接包含多个清晰度，需要先选择后再创建任务。',
            '请选择一个清晰度后继续下载。'
        );
    }
    if (rawMessage === RECOVERY_CONTEXT_INCOMPLETE_ERROR || /恢复信息不完整|重新下载未完成内容/.test(rawMessage)) {
        return createRuntimeErrorInfo(
            'recovery',
            '恢复信息不完整',
            RECOVERY_CONTEXT_INCOMPLETE_ERROR,
            '请点击继续重新下载未完成分片；如果缓存已清空，已完成但缺少数据的分片也需要重新获取。'
        );
    }
    if (/密钥下载失败/i.test(rawMessage)) {
        return createRuntimeErrorInfo(
            'decrypt',
            '密钥下载失败',
            rawMessage,
            '请确认密钥地址可以访问；如果源站限制密钥请求，当前纯静态模式无法解密。'
        );
    }
    if (/AES-128|解密|decrypt/i.test(rawMessage)) {
        return createRuntimeErrorInfo(
            'decrypt',
            '分片解密失败',
            rawMessage,
            '请确认浏览器支持 AES-128 解密，并检查密钥地址、IV 或源文件是否完整。'
        );
    }
    if (/源站不支持 Range 请求/i.test(rawMessage)) {
        return createRuntimeErrorInfo(
            'range_unsupported',
            '源站不支持 Range 请求',
            '该 fMP4 播放列表需要按字节范围下载，但源站没有按浏览器请求返回局部内容。',
            '请更换支持 Range 请求的源，或使用普通 TS 格式的 m3u8。'
        );
    }
    if (/fMP4 初始化片段缺失/i.test(rawMessage)) {
        return createRuntimeErrorInfo(
            'fmp4_init_missing',
            'fMP4 初始化片段缺失',
            '当前 fMP4 输出缺少初始化片段，无法生成可播放 MP4。',
            '请重新下载该任务，或检查源播放列表中的 #EXT-X-MAP。'
        );
    }
    if (/字幕格式暂不支持/i.test(rawMessage)) {
        return createRuntimeErrorInfo(
            'subtitle_unsupported',
            '字幕格式暂不支持',
            '当前字幕不是可直接合并保存的 WebVTT 字幕。',
            '可先保存视频和音轨，字幕文件需要换用 WebVTT 来源。'
        );
    }
    if (/分片下载失败|segment/i.test(rawMessage) || /^HTTP\s+\d{3}\b/i.test(rawMessage)) {
        return createRuntimeErrorInfo(
            'segment',
            '分片下载失败',
            rawMessage,
            '可稍后继续下载或点击失败分片重试；若多次失败，通常是源站临时不可用或限制访问。'
        );
    }
    if (/MP4 不兼容|mux|transmux/i.test(rawMessage)) {
        return createRuntimeErrorInfo(
            'export',
            '导出失败',
            rawMessage,
            '当前内容可能不适合导出为 MP4，建议改用 TS 保存。'
        );
    }
    if (/本地缓存|IndexedDB|缓存|quota|storage/i.test(rawMessage)) {
        return createRuntimeErrorInfo(
            'storage',
            '本地缓存异常',
            rawMessage,
            '请检查浏览器存储空间，或在缓存管理中清理无效缓存后重试。'
        );
    }
    if (/showSaveFilePicker|createWritable|保存|写入|write/i.test(rawMessage)) {
        return createRuntimeErrorInfo(
            'save',
            '保存失败',
            rawMessage || fallbackMessage || '保存失败',
            '请重新选择保存位置，或改用普通缓存下载后再保存。'
        );
    }
    return createRuntimeErrorInfo(
        'unknown',
        fallbackMessage || '操作失败',
        rawMessage || fallbackMessage,
        '请稍后重试，或检查链接、网络和浏览器兼容性。'
    );
}

function getRuntimeErrorRawMessage(error) {
    if (error instanceof Error) return String(error.message || '').trim();
    return String(error ?? '').trim();
}

function createRuntimeErrorInfo(category, title, message, suggestion) {
    return {
        category,
        title: String(title || '操作失败'),
        message: String(message || ''),
        suggestion: String(suggestion || '')
    };
}

function formatRuntimeErrorDetail(errorInfo) {
    const title = String(errorInfo?.title || '').trim();
    const message = String(errorInfo?.message || '').trim();
    const suggestion = String(errorInfo?.suggestion || '').trim();
    const parts = [];
    if (title && message && title !== message) {
        parts.push(`${title}：${message}`);
    } else if (message) {
        parts.push(message);
    } else if (title) {
        parts.push(title);
    }
    if (suggestion) {
        parts.push(`建议：${suggestion}`);
    }
    return parts.join(' ');
}

function isUserAbortError(error) {
    const name = error instanceof Error ? String(error.name || '') : '';
    const rawMessage = error instanceof Error ? error.message : String(error ?? '');
    return name === 'AbortError'
        || /user aborted/i.test(rawMessage)
        || /abort(?:ed)? a request/i.test(rawMessage)
        || /The operation was aborted/i.test(rawMessage);
}

function isNetworkRequestError(error) {
    const name = error instanceof Error ? String(error.name || '') : '';
    const rawMessage = error instanceof Error ? error.message : String(error ?? '');
    return name === 'TypeError' && /failed to fetch|networkerror|load failed|fetch failed/i.test(rawMessage);
}

function getUserFacingErrorMessage(error, fallbackMessage = '') {
    return normalizeRuntimeErrorMessage(error, fallbackMessage);
}

function showRuntimeErrorToast(error, fallbackMessage = '') {
    const message = getUserFacingErrorMessage(error, fallbackMessage);
    showToast(message || fallbackMessage || '操作失败', {
        type: isUserAbortError(error) ? 'info' : 'error'
    });
    return message;
}

async function downloadMediaPlaylistTask(task) {
    setTaskStatus(task.id, 'detecting');
    const detected = await detectHlsSource(task);

    setTaskStatus(task.id, 'resolving');
    const parsed = parseM3U8Playlist(detected.playlistText, detected.playlistUrl);

    if (parsed.type === 'master') {
        if (!Array.isArray(parsed.qualities) || parsed.qualities.length === 0) {
            throw new Error('当前 master playlist 没有可用清晰度');
        }
        throw new Error(MASTER_PLAYLIST_PRESELECTION_ERROR);
    }

    if (parsed.type !== 'media' || !isPlaylistEncryptionSupported(parsed.encryption)) {
        throw new Error(UNSUPPORTED_M3U8_TYPE_ERROR);
    }

    const mergedSegments = mergeResolvedMediaSegments(task.segments, parsed.segments);
    const resolvedRangeTask = {
        ...task,
        segments: mergedSegments
    };
    const preservedCustomRange = getTaskActualRange(resolvedRangeTask);
    const hasConfirmedCustomRange = task.downloadRangeMode === 'custom'
        && preservedCustomRange.start > 0
        && preservedCustomRange.end >= preservedCustomRange.start;

    if (task.downloadRangeMode === 'custom' && !hasConfirmedCustomRange) {
        const nextTask = updateTask(task.id, currentTask => ({
            ...currentTask,
            status: 'await_range_selection',
            playlistType: 'media',
            playlistContainer: String(parsed.container || currentTask.playlistContainer || ''),
            segmentCount: parsed.segments.length,
            requestedSegmentCount: parsed.segments.length,
            duration: parsed.duration || currentTask.duration || '00:00:00',
            segments: mergedSegments,
            mediaRenditions: Array.isArray(parsed.mediaRenditions) && parsed.mediaRenditions.length > 0
                ? parsed.mediaRenditions.map(rendition => ({ ...rendition }))
                : (Array.isArray(currentTask.mediaRenditions) ? currentTask.mediaRenditions : []),
            actualRangeStart: 0,
            actualRangeEnd: 0,
            errorMessage: ''
        }));
        if (typeof openDownloadRangeModal === 'function') {
            openDownloadRangeModal(task.id);
        }
        return nextTask;
    }

    return updateTask(task.id, currentTask => ({
        ...currentTask,
        status: hasConfirmedCustomRange ? 'queued' : currentTask.status,
        playlistType: 'media',
        playlistContainer: String(parsed.container || currentTask.playlistContainer || ''),
        segmentCount: parsed.segments.length,
        requestedSegmentCount: hasConfirmedCustomRange
            ? (preservedCustomRange.end - preservedCustomRange.start + 1)
            : parsed.segments.length,
        duration: parsed.duration || currentTask.duration || '00:00:00',
        segments: mergedSegments,
        mediaRenditions: Array.isArray(parsed.mediaRenditions) && parsed.mediaRenditions.length > 0
            ? parsed.mediaRenditions.map(rendition => ({ ...rendition }))
            : (Array.isArray(currentTask.mediaRenditions) ? currentTask.mediaRenditions : []),
        actualRangeStart: hasConfirmedCustomRange ? preservedCustomRange.start : 1,
        actualRangeEnd: hasConfirmedCustomRange ? preservedCustomRange.end : parsed.segments.length,
        errorMessage: ''
    }));
}

function updateTaskProgressFromSegments(task) {
    const segments = typeof getEffectiveTaskSegments === 'function'
        ? getEffectiveTaskSegments(task)
        : (() => {
            const allSegments = Array.isArray(task?.segments) ? task.segments : [];
            if (task?.downloadRangeMode !== 'custom') {
                return allSegments;
            }
            const start = Number(task?.actualRangeStart) || 0;
            const end = Number(task?.actualRangeEnd) || 0;
            if (start <= 0 || end <= 0 || end < start) {
                return allSegments;
            }
            return allSegments.filter(segment => {
                const sequence = Number(segment?.sequence);
                return Number.isFinite(sequence) && sequence >= start && sequence <= end;
            });
        })();
    const totalSegments = segments.length;
    if (totalSegments === 0) {
        return 0;
    }

    const successfulSegments = segments.filter(segment => hasCompletedSegment(segment)).length;
    return Math.round((successfulSegments / totalSegments) * 100);
}

function getTaskRequestControllerMap(taskId) {
    const normalizedTaskId = String(taskId);
    if (!taskRequestControllers.has(normalizedTaskId)) {
        taskRequestControllers.set(normalizedTaskId, new Map());
    }
    return taskRequestControllers.get(normalizedTaskId);
}

function clearTaskRequestControllers(taskId) {
    taskRequestControllers.delete(String(taskId));
}

function abortTaskRequests(taskId) {
    const controllerMap = taskRequestControllers.get(String(taskId));
    if (!controllerMap) return;

    controllerMap.forEach(controller => {
        if (controller && typeof controller.abort === 'function') {
            controller.abort();
        }
    });
    controllerMap.clear();
}

function canUseFileSystemStreamSave() {
    return typeof globalThis.showSaveFilePicker === 'function';
}

function canUseStreamSaverStreamSave() {
    return typeof globalThis.streamSaver?.createWriteStream === 'function';
}

async function createTaskStreamWriter(task) {
    if (!task?.streamSave || isFmp4Task(task)) {
        return null;
    }

    const taskId = String(task.id || '');
    if (taskId && taskStreamWriters.has(taskId)) {
        return taskStreamWriters.get(taskId);
    }

    const outputFileName = buildTaskOutputFileName(task);
    if (!canUseFileSystemStreamSave()) {
        if (!canUseStreamSaverStreamSave()) {
            return null;
        }

        const stream = globalThis.streamSaver.createWriteStream(outputFileName, {
            size: undefined
        });
        const writer = typeof stream?.getWriter === 'function' ? stream.getWriter() : null;
        if (!writer || typeof writer.write !== 'function' || typeof writer.close !== 'function') {
            return null;
        }

        const streamWriterModel = {
            mode: 'stream-saver',
            outputFileName,
            async write(bytes) {
                await writer.write(bytes);
            },
            async close() {
                await writer.close();
            },
            async abort() {
                if (typeof writer.abort === 'function') {
                    await writer.abort();
                    return;
                }
                await writer.close();
            }
        };
        if (taskId) {
            taskStreamWriters.set(taskId, streamWriterModel);
        }
        return streamWriterModel;
    }

    const fileHandle = await globalThis.showSaveFilePicker({
        suggestedName: outputFileName,
        types: [
            {
                description: 'MPEG-TS 视频',
                accept: {
                    'video/mp2t': ['.ts']
                }
            }
        ]
    });
    const writable = await fileHandle.createWritable();

    const streamWriterModel = {
        mode: 'file-system',
        outputFileName,
        async write(bytes) {
            await writable.write(bytes);
        },
        async close() {
            await writable.close();
        },
        async abort() {
            if (typeof writable.abort === 'function') {
                await writable.abort();
                return;
            }
            await writable.close();
        }
    };
    if (taskId) {
        taskStreamWriters.set(taskId, streamWriterModel);
    }
    return streamWriterModel;
}

async function downloadFmp4Part(task, part) {
    const controller = arguments[2] ?? null;
    const url = resolveTaskDownloadResourceUrl(task, part?.url);
    if (!url) {
        throw new Error('分片下载失败：缺少下载地址');
    }

    const byteRange = part?.byteRange && typeof part.byteRange === 'object'
        ? {
            length: Number(part.byteRange.length),
            offset: Number(part.byteRange.offset)
        }
        : null;
    const headers = {};
    if (byteRange) {
        if (
            !Number.isSafeInteger(byteRange.length)
            || byteRange.length <= 0
            || !Number.isSafeInteger(byteRange.offset)
            || byteRange.offset < 0
        ) {
            throw new Error('分片下载失败：字节范围信息无效');
        }
        headers.Range = `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`;
    }

    const runWithLease = typeof withDownloadRequestLease === 'function'
        ? withDownloadRequestLease
        : async (runtimeTask, resourceUrl, operation) => {
            void runtimeTask;
            void resourceUrl;
            return operation();
        };
    let reservation = null;
    try {
        const result = await runWithLease(task, url, async () => {
            reservation = typeof reserveTaskDownloadMemory === 'function'
                ? reserveTaskDownloadMemory(task, part)
                : null;
            const response = await fetch(url, {
                ...(controller ? { signal: controller.signal } : {}),
                ...(Object.keys(headers).length > 0 ? { headers } : {})
            });
            if (!response.ok) {
                const error = new Error('分片下载失败：HTTP ' + response.status);
                error.httpStatus = response.status;
                error.retryAfterMs = typeof parseRetryAfterMilliseconds === 'function'
                    ? parseRetryAfterMilliseconds(response)
                    : 0;
                throw error;
            }
            if (headers.Range && response.status !== 206) {
                throw new Error('源站不支持 Range 请求，无法下载字节范围 HLS。');
            }
            if (!reservation) {
                return { bytes: new Uint8Array(await response.arrayBuffer()), reservation: null };
            }
            return readResponseBytesWithinMemoryBudget(response, {
                governor: downloadMemoryGovernor,
                reservation,
                taskId: task?.id,
                estimatedBytes: reservation.byteLength,
                exactByteLength: byteRange?.length || 0
            });
        });
        return typeof trackDownloadedBytesReservation === 'function'
            ? trackDownloadedBytesReservation(result.bytes, result.reservation)
            : result.bytes;
    } catch (error) {
        if (reservation) downloadMemoryGovernor.release(reservation);
        throw error;
    }
}

async function downloadSegment(task, segment) {
    const controller = arguments[2] ?? null;
    const segmentUrl = resolveTaskDownloadResourceUrl(task, segment?.url);
    const runWithLease = typeof withDownloadRequestLease === 'function'
        ? withDownloadRequestLease
        : async (runtimeTask, resourceUrl, operation) => {
            void runtimeTask;
            void resourceUrl;
            return operation();
        };
    if (segment?.container === 'fmp4') {
        return downloadFmp4Part(task, segment, controller);
    }

    let reservation = null;
    let bytes;
    try {
        const result = await runWithLease(task, segmentUrl, async () => {
            reservation = typeof reserveTaskDownloadMemory === 'function'
                ? reserveTaskDownloadMemory(task, segment)
                : null;
            const response = await fetch(segmentUrl, controller ? { signal: controller.signal } : undefined);
            if (!response.ok) {
                const error = new Error('分片下载失败：HTTP ' + response.status);
                error.httpStatus = response.status;
                error.retryAfterMs = typeof parseRetryAfterMilliseconds === 'function'
                    ? parseRetryAfterMilliseconds(response)
                    : 0;
                throw error;
            }
            if (!reservation) {
                return { bytes: new Uint8Array(await response.arrayBuffer()), reservation: null };
            }
            return readResponseBytesWithinMemoryBudget(response, {
                governor: downloadMemoryGovernor,
                reservation,
                taskId: task?.id,
                estimatedBytes: reservation.byteLength
            });
        });
        bytes = result.bytes;
    } catch (error) {
        if (reservation) downloadMemoryGovernor.release(reservation);
        throw error;
    }

    const encryption = segment?.encryption && typeof segment.encryption === 'object'
        ? {
            ...segment.encryption,
            keyUri: resolveTaskDownloadResourceUrl(task, segment.encryption.keyUri)
        }
        : null;
    if (!encryption || String(encryption.method || '').toUpperCase() === 'NONE') {
        return typeof trackDownloadedBytesReservation === 'function'
            ? trackDownloadedBytesReservation(bytes, reservation)
            : bytes;
    }
    try {
        if (reservation && !downloadMemoryGovernor.resize(reservation, bytes.byteLength * 2)) {
            throw new Error('内存空间不足，无法安全解密当前分片。');
        }
        const decryptedBytes = await decryptAes128Segment(
            bytes,
            encryption,
            segment.mediaSequence ?? segment.sequence,
            controller?.signal,
            task
        );
        if (reservation) downloadMemoryGovernor.resize(reservation, decryptedBytes.byteLength);
        return typeof trackDownloadedBytesReservation === 'function'
            ? trackDownloadedBytesReservation(decryptedBytes, reservation)
            : decryptedBytes;
    } catch (error) {
        if (reservation) downloadMemoryGovernor.release(reservation);
        throw error;
    }
}

function resolveTaskDownloadResourceUrl(task, resourceUrl) {
    const normalizedResourceUrl = String(resourceUrl || '').trim();
    if (!normalizedResourceUrl) {
        return '';
    }

    if (!normalizedResourceUrl.toLowerCase().startsWith('http://')) {
        return normalizedResourceUrl;
    }

    const taskUrl = String(task?.url || '').trim();
    if (!taskUrl) {
        return normalizedResourceUrl;
    }

    try {
        return resolvePlaylistResourceUrl(normalizedResourceUrl, taskUrl);
    } catch {
        return normalizedResourceUrl;
    }
}

function normalizeAes128Iv(iv, sequence) {
    const bytes = new Uint8Array(16);
    const rawIv = String(iv || '').trim();

    if (rawIv) {
        const hexValue = rawIv.replace(/^0x/i, '').padStart(32, '0').slice(-32);
        for (let index = 0; index < 16; index += 1) {
            bytes[index] = Number.parseInt(hexValue.slice(index * 2, index * 2 + 2), 16) || 0;
        }
        return bytes;
    }

    let normalizedSequence = Number(sequence);
    if (!Number.isFinite(normalizedSequence) || normalizedSequence < 0) {
        normalizedSequence = 0;
    }

    let remaining = Math.floor(normalizedSequence);
    for (let index = 15; index >= 0 && remaining > 0; index -= 1) {
        bytes[index] = remaining & 0xff;
        remaining = Math.floor(remaining / 256);
    }
    return bytes;
}

async function fetchAes128Key(keyUri, signal) {
    const task = arguments[2] ?? null;
    const normalizedKeyUri = String(keyUri || '').trim();
    if (!normalizedKeyUri) {
        throw new Error(UNSUPPORTED_M3U8_TYPE_ERROR);
    }

    if (aes128KeyCache.has(normalizedKeyUri)) {
        return aes128KeyCache.get(normalizedKeyUri);
    }

    const runWithLease = typeof withDownloadRequestLease === 'function'
        ? withDownloadRequestLease
        : async (runtimeTask, resourceUrl, operation) => {
            void runtimeTask;
            void resourceUrl;
            return operation();
        };
    const keyBytes = await runWithLease(task, normalizedKeyUri, async () => {
        const response = await fetch(normalizedKeyUri, signal ? { signal } : undefined);
        if (response.status === 401 || response.status === 403) {
            throw new Error(SOURCE_ACCESS_RESTRICTED_ERROR);
        }
        if (!response.ok) {
            const error = new Error(`密钥下载失败：HTTP ${response.status}`);
            error.httpStatus = response.status;
            error.retryAfterMs = parseRetryAfterMilliseconds(response);
            throw error;
        }
        return new Uint8Array(await response.arrayBuffer());
    });
    if (keyBytes.byteLength !== 16) {
        throw new Error(UNSUPPORTED_M3U8_TYPE_ERROR);
    }

    aes128KeyCache.set(normalizedKeyUri, keyBytes);
    return keyBytes;
}

async function decryptAes128Segment(encryptedBytes, encryption, sequence) {
    const signal = arguments[3] ?? null;
    const task = arguments[4] ?? null;
    if (String(encryption?.method || '').toUpperCase() !== 'AES-128') {
        throw new Error(UNSUPPORTED_M3U8_TYPE_ERROR);
    }

    const cryptoApi = globalThis.crypto?.subtle;
    if (!cryptoApi?.importKey || !cryptoApi?.decrypt) {
        throw new Error('当前浏览器不支持 AES-128 解密');
    }

    const keyBytes = await fetchAes128Key(encryption.keyUri, signal, task);
    const cryptoKey = await cryptoApi.importKey(
        'raw',
        keyBytes,
        { name: 'AES-CBC' },
        false,
        ['decrypt']
    );
    const decryptedBuffer = await cryptoApi.decrypt(
        {
            name: 'AES-CBC',
            iv: normalizeAes128Iv(encryption.iv, sequence)
        },
        cryptoKey,
        encryptedBytes
    );

    return new Uint8Array(decryptedBuffer);
}

async function downloadTaskSegments(task) {
    const MAX_SEGMENT_ATTEMPTS = 3;
    const taskId = task.id;
    const requestControllerStore = typeof taskRequestControllers !== 'undefined'
        ? taskRequestControllers
        : (globalThis.__taskRequestControllers = globalThis.__taskRequestControllers || new Map());
    const getRequestControllerMap = typeof getTaskRequestControllerMap === 'function'
        ? getTaskRequestControllerMap
        : (runtimeTaskId) => {
            const normalizedTaskId = String(runtimeTaskId);
            if (!requestControllerStore.has(normalizedTaskId)) {
                requestControllerStore.set(normalizedTaskId, new Map());
            }
            return requestControllerStore.get(normalizedTaskId);
        };
    const clearRequestControllers = typeof clearTaskRequestControllers === 'function'
        ? clearTaskRequestControllers
        : (runtimeTaskId) => {
            requestControllerStore.delete(String(runtimeTaskId));
        };
    const getSegmentEligibility = typeof isTaskSegmentWithinActualRange === 'function'
        ? isTaskSegmentWithinActualRange
        : (currentTask, segment) => {
            if (currentTask?.downloadRangeMode !== 'custom') {
                return true;
            }
            const allSegments = Array.isArray(currentTask?.segments) ? currentTask.segments : [];
            if (allSegments.length === 0) {
                return false;
            }
            const start = Number(currentTask?.actualRangeStart) || 0;
            const end = Number(currentTask?.actualRangeEnd) || 0;
            if (start <= 0 || end <= 0 || end < start) {
                return false;
            }
            const sequence = Number(segment?.sequence);
            return Number.isFinite(sequence) && sequence >= start && sequence <= end;
        };
    const getRecoverySegmentEligibility = typeof isTaskSegmentEligibleForCurrentRun === 'function'
        ? isTaskSegmentEligibleForCurrentRun
        : (currentTask, segment) => {
            if (!getSegmentEligibility(currentTask, segment)) {
                return false;
            }

            if (currentTask?.recoveryMode !== 'single') {
                return true;
            }

            const targetSequence = Number(currentTask?.recoveryTargetSequence);
            const segmentSequence = Number(segment?.sequence);
            return Number.isFinite(targetSequence)
                && targetSequence > 0
                && Number.isFinite(segmentSequence)
                && segmentSequence === targetSequence;
        };
    const effectiveSegments = typeof getEffectiveTaskSegments === 'function'
        ? getEffectiveTaskSegments(task)
        : (() => {
            const allSegments = Array.isArray(task?.segments) ? task.segments : [];
            if (task?.downloadRangeMode !== 'custom') {
                return allSegments;
            }
            const start = Number(task?.actualRangeStart) || 0;
            const end = Number(task?.actualRangeEnd) || 0;
            if (start <= 0 || end <= 0 || end < start) {
                return [];
            }
            return allSegments.filter(segment => {
                const sequence = Number(segment?.sequence);
                return Number.isFinite(sequence) && sequence >= start && sequence <= end;
            });
        })();
    const activeRecoverySegments = effectiveSegments.filter(segment => (
        getRecoverySegmentEligibility(task, segment) && !hasCompletedSegment(segment)
    ));
    const totalSegments = effectiveSegments.length;
    if (totalSegments === 0 || activeRecoverySegments.length === 0) {
        return findTaskById(taskId);
    }

    const preservedDownloadedBytes = effectiveSegments.reduce((sum, segment) => (
        sum + (hasDownloadedSegmentBytes(segment) ? segment.bytes.byteLength : 0)
    ), 0);
    const preservedProgress = updateTaskProgressFromSegments({
        ...task,
        segments: Array.isArray(task?.segments) ? task.segments : []
    });

    updateTask(taskId, currentTask => ({
        ...currentTask,
        status: 'downloading',
        totalBytes: preservedDownloadedBytes,
        downloadedBytes: preservedDownloadedBytes,
        downloadSpeedBytesPerSecond: 0,
        estimatedRemainingSeconds: 0,
        progress: preservedProgress,
        segments: currentTask.segments.map(segment => ({
            ...segment,
            status: getRecoverySegmentEligibility(currentTask, segment)
                ? (hasCompletedSegment(segment) ? 'success' : 'idle')
                : segment.status,
            bytes: getRecoverySegmentEligibility(currentTask, segment)
                ? (hasDownloadedSegmentBytes(segment) ? segment.bytes : null)
                : segment.bytes ?? null,
            streamSaved: getRecoverySegmentEligibility(currentTask, segment)
                ? Boolean(segment.streamSaved && hasCompletedSegment(segment))
                : Boolean(segment.streamSaved),
            attemptCount: getRecoverySegmentEligibility(currentTask, segment)
                ? (segment.status === 'success' ? (Number(segment.attemptCount) || 0) : (Number(segment.attemptCount) || 0))
                : (Number(segment.attemptCount) || 0),
            errorMessage: getRecoverySegmentEligibility(currentTask, segment)
                ? (hasDownloadedSegmentBytes(segment) ? '' : '')
                : (segment.errorMessage || '')
        }))
    }));

    const normalizedConcurrency = normalizeConcurrency(task.concurrency);
    let nextSegmentIndex = 0;
    let hasFailure = false;
    const canUseTaskStreamSave = canTaskUseStreamSave(task);
    const isFmp4StreamSaveDowngrade = Boolean(task.streamSave && isFmp4Task(task) && !canUseTaskStreamSave);
    const hasSelectedExternalRenditions = Boolean(task.selectedAudioRenditionId || task.selectedSubtitleRenditionId);
    const runFileSelection = typeof enqueueFileSelection === 'function'
        ? enqueueFileSelection
        : operation => operation();
    const streamWriter = canUseTaskStreamSave
        ? await runFileSelection(() => {
            const latestTaskForFileSelection = findTaskById(taskId);
            if (!latestTaskForFileSelection || latestTaskForFileSelection.status === 'paused') {
                return null;
            }
            return createTaskStreamWriter(latestTaskForFileSelection);
        })
        : null;
    const actualWriteMode = streamWriter?.mode === 'file-system'
        ? 'file-system'
        : streamWriter?.mode === 'stream-saver'
            ? 'stream-saver'
            : task.streamSave && !isFmp4StreamSaveDowngrade
                ? 'degraded'
                : 'memory';
    updateTask(taskId, currentTask => ({
        ...currentTask,
        actualWriteMode
    }), { render: 'live' });
    if (actualWriteMode === 'degraded' && !task.streamSaveDegradationNotified) {
        showToast('当前浏览器不支持边下边存，已改为普通缓存下载', { type: 'info' });
        task.streamSaveDegradationNotified = true;
    }
    if (isFmp4StreamSaveDowngrade && !task.streamSaveFmp4DowngradeNotified) {
        showToast(
            hasSelectedExternalRenditions
                ? '已选择外部音轨或字幕，本次将分别缓存后保存；直接打开视频可能无声。'
                : 'fMP4 将先缓存后保存，暂不使用边下边存。',
            { type: 'info' }
        );
        task.streamSaveFmp4DowngradeNotified = true;
        task.streamSaveExternalRenditionsNotified = true;
    }
    const pendingStreamWrites = new Map();
    const streamedSegmentIndexes = new Set();
    const fmp4InitByteCache = new Map();
    let nextStreamWriteIndex = 0;
    let streamWriteChain = Promise.resolve();
    let streamWriterSettled = false;
    let lastSpeedSampleAt = Date.now();

    while (
        nextStreamWriteIndex < task.segments.length
        && (
            !getSegmentEligibility(task, task.segments[nextStreamWriteIndex])
            || !getRecoverySegmentEligibility(task, task.segments[nextStreamWriteIndex])
            || hasCompletedSegment(task.segments[nextStreamWriteIndex])
        )
    ) {
        nextStreamWriteIndex += 1;
    }

    function advanceStreamWriteCursor(currentTask) {
        while (
            nextStreamWriteIndex < currentTask.segments.length
            && (
                !getSegmentEligibility(currentTask, currentTask.segments[nextStreamWriteIndex])
                || !getRecoverySegmentEligibility(currentTask, currentTask.segments[nextStreamWriteIndex])
                || streamedSegmentIndexes.has(nextStreamWriteIndex)
            )
        ) {
            nextStreamWriteIndex += 1;
        }
    }

    async function flushOrderedStreamWrites() {
        if (!streamWriter) return;

        let latestTask = findTaskById(taskId) || task;
        advanceStreamWriteCursor(latestTask);
        while (pendingStreamWrites.has(nextStreamWriteIndex)) {
            const bytes = pendingStreamWrites.get(nextStreamWriteIndex);
            pendingStreamWrites.delete(nextStreamWriteIndex);
            await streamWriter.write(bytes);
            streamedSegmentIndexes.add(nextStreamWriteIndex);
            latestTask = findTaskById(taskId) || latestTask;
            advanceStreamWriteCursor(latestTask);
        }
    }

    function queueStreamWrite(segmentIndex, bytes) {
        if (!streamWriter) return Promise.resolve();

        pendingStreamWrites.set(segmentIndex, bytes);
        streamWriteChain = streamWriteChain.then(() => flushOrderedStreamWrites());
        return streamWriteChain;
    }

    async function fetchInitBytesForSegment(currentTask, segment, controller) {
        return getCachedFmp4InitBytes(
            currentTask,
            segment,
            controller,
            fmp4InitByteCache
        );
    }

    async function abortStreamWriter() {
        if (!streamWriter || streamWriterSettled) return;
        streamWriterSettled = true;
        try {
            if (typeof streamWriter.abort === 'function') {
                await streamWriter.abort();
            }
        } catch {
            // Ignore cleanup failures; task state still prevents trusting partial stream writes.
        }
        taskStreamWriters.delete(String(taskId));
    }

    function discardVolatileStreamSavedSegments() {
        if (!streamWriter) return findTaskById(taskId);

        return updateTask(taskId, currentTask => {
            const nextSegments = Array.isArray(currentTask.segments)
                ? currentTask.segments.map(segment => (
                    segment.streamSaved
                        ? {
                            ...segment,
                            status: 'idle',
                            bytes: null,
                            streamSaved: false,
                            errorMessage: ''
                        }
                        : segment
                ))
                : currentTask.segments;
            const downloadedBytes = Array.isArray(nextSegments)
                ? nextSegments.reduce((sum, segment) => (
                    sum + (hasDownloadedSegmentBytes(segment) ? segment.bytes.byteLength : 0)
                ), 0)
                : currentTask.downloadedBytes;

            return {
                ...currentTask,
                segments: nextSegments,
                downloadedBytes,
                totalBytes: downloadedBytes,
                progress: updateTaskProgressFromSegments({
                    ...currentTask,
                    segments: nextSegments
                })
            };
        }, { render: 'live' });
    }

    async function processNextSegment() {
        const activeTask = findTaskById(taskId);
        if (!activeTask || hasFailure || activeTask.status === 'paused') {
            return;
        }

        const currentIndex = nextSegmentIndex;
        nextSegmentIndex += 1;
        if (currentIndex >= activeTask.segments.length) {
            return;
        }

        const activeSegment = activeTask.segments[currentIndex];
        if (
            !activeSegment
            || !getSegmentEligibility(activeTask, activeSegment)
            || !getRecoverySegmentEligibility(activeTask, activeSegment)
            || hasCompletedSegment(activeSegment)
        ) {
            return processNextSegment();
        }

        for (let attemptIndex = Number(activeSegment.attemptCount) || 0; attemptIndex < MAX_SEGMENT_ATTEMPTS; attemptIndex += 1) {
            let attemptBytes = null;
            let attemptInitBytes = null;
            updateTask(taskId, currentTask => ({
                ...currentTask,
                segments: currentTask.segments.map((segment, segmentIndex) => (
                    segmentIndex === currentIndex
                        ? {
                            ...segment,
                            status: attemptIndex > 0 ? 'retrying' : 'downloading',
                            attemptCount: attemptIndex + 1,
                            errorMessage: ''
                        }
                        : segment
                ))
            }), { render: 'live' });

            try {
                const latestTask = findTaskById(taskId);
                const latestSegment = latestTask?.segments?.[currentIndex];
                const requestControllers = getRequestControllerMap(taskId);
                const controller = typeof AbortController === 'function' ? new AbortController() : null;
                requestControllers.set(currentIndex + 1, controller);
                let initBytes = null;
                const sourceSegment = latestSegment ?? activeSegment;
                initBytes = await fetchInitBytesForSegment(latestTask ?? activeTask, sourceSegment, controller);
                attemptInitBytes = initBytes;
                const bytes = await downloadSegment(latestTask ?? activeTask, latestSegment ?? activeSegment, controller);
                attemptBytes = bytes;
                const downloadedAt = Date.now();
                requestControllers.delete(currentIndex + 1);
                await queueStreamWrite(currentIndex, bytes);
                let cacheStored = false;
                if (!streamWriter) {
                    const hasCacheWriteHeadroom = typeof resizeDownloadedBytesReservation !== 'function'
                        || resizeDownloadedBytesReservation(bytes, bytes.byteLength * 2);
                    if (hasCacheWriteHeadroom) {
                        cacheStored = await putCachedSegmentBytes(
                            taskId,
                            activeSegment.sequence ?? (currentIndex + 1),
                            bytes
                        );
                        if (typeof resizeDownloadedBytesReservation === 'function') {
                            resizeDownloadedBytesReservation(bytes, bytes.byteLength);
                        }
                    }
                }

                updateTask(taskId, currentTask => {
                    const nextSegments = currentTask.segments.map((segment, segmentIndex) => (
                        segmentIndex === currentIndex
                            ? {
                                ...segment,
                                status: 'success',
                                bytes: streamWriter || cacheStored ? null : bytes,
                                byteLength: Number(bytes?.byteLength) || 0,
                                cacheStored,
                                initBytes: cacheStored
                                    ? null
                                    : (initBytes instanceof Uint8Array ? initBytes : segment.initBytes),
                                streamSaved: Boolean(streamWriter),
                                attemptCount: Number(segment.attemptCount) || 0,
                                errorMessage: ''
                            }
                            : segment
                    ));
                    const bytesDelta = Number(bytes?.byteLength) || 0;
                    const downloadedBytes = Math.max(0, Number(currentTask.downloadedBytes) || 0) + bytesDelta;
                    const elapsedSeconds = Math.max(0.001, (downloadedAt - lastSpeedSampleAt) / 1000);
                    lastSpeedSampleAt = downloadedAt;
                    const instantSpeed = bytesDelta / elapsedSeconds;
                    const previousSpeed = Number(currentTask.downloadSpeedBytesPerSecond) || 0;
                    const downloadSpeedBytesPerSecond = Math.max(0, Math.round(
                        previousSpeed > 0
                            ? (previousSpeed * 0.65 + instantSpeed * 0.35)
                            : instantSpeed
                    ));
                    const totalBytes = Math.max(Number(currentTask.totalBytes) || 0, downloadedBytes);
                    const estimatedRemainingSeconds = calculateTaskEstimatedRemainingSeconds({
                        ...currentTask,
                        downloadedBytes,
                        totalBytes,
                        segments: nextSegments,
                        downloadSpeedBytesPerSecond
                    });

                    return {
                        ...currentTask,
                        status: currentTask.status === 'failed' ? 'failed' : currentTask.status,
                        segments: nextSegments,
                        downloadedBytes,
                        totalBytes,
                        downloadSpeedBytesPerSecond,
                        estimatedRemainingSeconds,
                        progress: updateTaskProgressFromSegments({ segments: nextSegments }),
                        errorMessage: currentTask.status === 'failed'
                            ? currentTask.errorMessage
                            : ''
                    };
                }, { render: 'live' });
                if (typeof releaseDownloadedBytesReservation === 'function') {
                    releaseDownloadedBytesReservation(bytes);
                    releaseDownloadedBytesReservation(initBytes);
                }
                attemptBytes = null;
                attemptInitBytes = null;
                if (!streamWriter && enforceBufferedMemoryBudget()) {
                    return;
                }
                break;
            } catch (error) {
                if (typeof releaseDownloadedBytesReservation === 'function') {
                    releaseDownloadedBytesReservation(attemptBytes);
                    releaseDownloadedBytesReservation(attemptInitBytes);
                }
                attemptBytes = null;
                attemptInitBytes = null;
                const requestControllers = getRequestControllerMap(taskId);
                requestControllers.delete(currentIndex + 1);

                if (/内存空间不足|无法安全读取未知大小/.test(String(error?.message || ''))
                    && typeof handleDownloadMemoryPressure === 'function') {
                    await abortStreamWriter();
                    handleDownloadMemoryPressure(taskId);
                    return;
                }

                if (error?.name === 'AbortError') {
                    await abortStreamWriter();
                    updateTask(taskId, currentTask => ({
                        ...currentTask,
                        segments: currentTask.segments.map((segment, segmentIndex) => (
                            segmentIndex === currentIndex
                                ? {
                                    ...segment,
                                    status: 'idle',
                                    bytes: null,
                                    errorMessage: ''
                                }
                                : segment
                        ))
                    }), { render: 'live' });
                    discardVolatileStreamSavedSegments();
                    return;
                }

            const failureMessage = typeof normalizeRuntimeErrorMessage === 'function'
                ? normalizeRuntimeErrorMessage(error, '分片下载失败')
                : (error instanceof Error ? error.message : String(error));
            const isLastAttempt = attemptIndex + 1 >= MAX_SEGMENT_ATTEMPTS;
            if (!isLastAttempt) {
                updateTask(taskId, currentTask => ({
                    ...currentTask,
                        segments: currentTask.segments.map((segment, segmentIndex) => (
                            segmentIndex === currentIndex
                                ? {
                                    ...segment,
                                    status: 'idle',
                                    bytes: null,
                                    errorMessage: ''
                                }
                                : segment
                        ))
                    }), { render: 'live' });
                    continue;
                }

                hasFailure = true;
                await abortStreamWriter();

                updateTask(taskId, currentTask => {
                    const nextSegments = currentTask.segments.map((segment, segmentIndex) => (
                        segmentIndex === currentIndex
                            ? {
                                ...segment,
                            status: 'failed',
                            bytes: null,
                            attemptCount: Number(segment.attemptCount) || MAX_SEGMENT_ATTEMPTS,
                            errorMessage: failureMessage
                        }
                        : segment
                ));
                    const downloadedBytes = nextSegments.reduce((sum, segment) => (
                        sum + (hasDownloadedSegmentBytes(segment) ? segment.bytes.byteLength : 0)
                    ), 0);

                    return {
                        ...currentTask,
                        status: 'failed',
                        segments: nextSegments,
                        downloadedBytes,
                        totalBytes: downloadedBytes,
                        downloadSpeedBytesPerSecond: 0,
                        estimatedRemainingSeconds: 0,
                        progress: updateTaskProgressFromSegments({ segments: nextSegments }),
                        errorMessage: failureMessage
                    };
                });
                discardVolatileStreamSavedSegments();
                return;
            }
        }

        if (nextSegmentIndex < activeTask.segments.length && !hasFailure) {
            return processNextSegment();
        }
    }

    const workers = Array.from(
        { length: Math.min(normalizedConcurrency, activeRecoverySegments.length) },
        () => processNextSegment()
    );

    await Promise.all(workers);
    await streamWriteChain;
    clearRequestControllers(taskId);
    const finalTask = findTaskById(taskId);
    if (streamWriter && finalTask?.status && !['downloading', 'paused'].includes(finalTask.status)) {
        await abortStreamWriter();
        return discardVolatileStreamSavedSegments();
    }
    if (finalTask?.status === 'downloading') {
        const finalSegments = typeof getEffectiveTaskSegments === 'function'
            ? getEffectiveTaskSegments(finalTask)
            : effectiveSegments;
        const hasRemainingIncompleteSegments = finalSegments.some(segment => !hasCompletedSegment(segment));
        if (hasRemainingIncompleteSegments) {
            return updateTask(taskId, currentTask => ({
                ...currentTask,
                status: finalSegments.some(segment => segment.status === 'failed')
                    ? 'failed'
                    : currentTask.recoveryMode === 'single'
                        ? 'queued'
                        : currentTask.status,
                recoveryMode: '',
                recoveryTargetSequence: 0
            }));
        }

        updateTask(taskId, currentTask => ({
            ...currentTask,
            recoveryMode: '',
            recoveryTargetSequence: 0
        }));
    }
    const latestTask = findTaskById(taskId);
    if (streamWriter && latestTask?.status === 'downloading') {
        streamWriterSettled = true;
        await streamWriter.close();
        taskStreamWriters.delete(String(taskId));
        return completeTask(taskId, streamWriter.outputFileName);
    }
    return latestTask;
}

function getTaskOutputBaseName(task) {
    const baseName = String(task?.title || task?.id || 'video').trim() || 'video';
    return baseName;
}

function isFmp4Task(task) {
    if (task?.playlistContainer === 'fmp4') {
        return true;
    }

    return Array.isArray(task?.segments)
        && task.segments.some(segment => segment?.container === 'fmp4');
}

function normalizeForceMergeModeForTask(task, mode) {
    if (isFmp4Task(task)) {
        return 'prefix';
    }
    if (task?.format === 'mp4') {
        return 'prefix';
    }
    return mode === 'discrete' ? 'discrete' : 'prefix';
}

function canTaskUseStreamSave(task) {
    if (isFmp4Task(task)) {
        return false;
    }
    return Boolean(task?.streamSave);
}

function getTaskOutputExtension(task) {
    const extension = isFmp4Task(task) || task?.format === 'mp4' ? 'mp4' : 'ts';
    return extension;
}

function buildTaskOutputFileName(task) {
    return `${getTaskOutputBaseName(task)}.${getTaskOutputExtension(task)}`;
}

function buildForceMergeOutputFileName(task, mode) {
    const suffix = mode === 'discrete' ? 'discrete' : 'prefix';
    return `${getTaskOutputBaseName(task)}.partial-${suffix}-${Date.now()}.${getTaskOutputExtension(task)}`;
}

function collectForceMergeSegments(task, mode) {
    const segments = getEffectiveTaskSegments(task)
        .slice()
        .sort((left, right) => left.sequence - right.sequence);
    const exportableSegments = [];
    let missingSuccessfulBytes = false;

    if (mode === 'discrete') {
        segments.forEach(segment => {
            if (segment.status === 'success' && segment.bytes instanceof Uint8Array) {
                exportableSegments.push(segment);
                return;
            }
            if (segment.status === 'success') {
                missingSuccessfulBytes = true;
            }
        });
        return { exportableSegments, missingSuccessfulBytes };
    }

    for (const segment of segments) {
        if (segment.status === 'success' && segment.bytes instanceof Uint8Array) {
            exportableSegments.push(segment);
            continue;
        }

        if (segment.status === 'success') {
            missingSuccessfulBytes = true;
        }
        break;
    }

    return { exportableSegments, missingSuccessfulBytes };
}

function analyzeTsExportParts(parts) {
    const result = {
        checked: false,
        packetCount: 0,
        syncPackets: 0,
        patCount: 0,
        pmtCount: 0,
        videoPid: null,
        hasKeyframe: false
    };
    const bytes = [];
    let copiedBytes = 0;

    for (const part of parts) {
        if (!(part instanceof Uint8Array)) continue;
        const copyLength = Math.min(part.byteLength, FORCE_MERGE_TS_ANALYSIS_MAX_BYTES - copiedBytes);
        for (let index = 0; index < copyLength; index += 1) {
            bytes.push(part[index]);
        }
        copiedBytes += copyLength;
        if (copiedBytes >= FORCE_MERGE_TS_ANALYSIS_MAX_BYTES) break;
    }

    if (bytes.length < 188) {
        return result;
    }

    result.checked = true;
    const pmtPids = new Set();

    for (let offset = 0; offset + 188 <= bytes.length; offset += 188) {
        result.packetCount += 1;
        if (bytes[offset] !== 0x47) continue;

        result.syncPackets += 1;
        const payloadUnitStart = Boolean(bytes[offset + 1] & 0x40);
        const pid = ((bytes[offset + 1] & 0x1f) << 8) | bytes[offset + 2];
        const adaptationFieldControl = (bytes[offset + 3] >> 4) & 0x03;
        let payloadOffset = offset + 4;

        if (adaptationFieldControl === 2 || adaptationFieldControl === 3) {
            payloadOffset += 1 + (bytes[payloadOffset] || 0);
        }
        if ((adaptationFieldControl !== 1 && adaptationFieldControl !== 3) || payloadOffset >= offset + 188) {
            continue;
        }

        if (pid === 0) {
            result.patCount += 1;
            let tableOffset = payloadOffset;
            if (payloadUnitStart) {
                tableOffset += 1 + (bytes[tableOffset] || 0);
            }
            if (tableOffset + 12 < offset + 188 && bytes[tableOffset] === 0x00) {
                const sectionLength = ((bytes[tableOffset + 1] & 0x0f) << 8) | bytes[tableOffset + 2];
                const sectionEnd = Math.min(tableOffset + 3 + sectionLength - 4, offset + 188);
                for (let programOffset = tableOffset + 8; programOffset + 4 <= sectionEnd; programOffset += 4) {
                    const programNumber = (bytes[programOffset] << 8) | bytes[programOffset + 1];
                    const programMapPid = ((bytes[programOffset + 2] & 0x1f) << 8) | bytes[programOffset + 3];
                    if (programNumber !== 0) {
                        pmtPids.add(programMapPid);
                    }
                }
            }
        }

        if (pmtPids.has(pid)) {
            result.pmtCount += 1;
            let tableOffset = payloadOffset;
            if (payloadUnitStart) {
                tableOffset += 1 + (bytes[tableOffset] || 0);
            }
            if (tableOffset + 12 < offset + 188 && bytes[tableOffset] === 0x02) {
                const sectionLength = ((bytes[tableOffset + 1] & 0x0f) << 8) | bytes[tableOffset + 2];
                const programInfoLength = ((bytes[tableOffset + 10] & 0x0f) << 8) | bytes[tableOffset + 11];
                const sectionEnd = Math.min(tableOffset + 3 + sectionLength - 4, offset + 188);
                let streamOffset = tableOffset + 12 + programInfoLength;
                while (streamOffset + 5 <= sectionEnd) {
                    const streamType = bytes[streamOffset];
                    const elementaryPid = ((bytes[streamOffset + 1] & 0x1f) << 8) | bytes[streamOffset + 2];
                    const descriptorLength = ((bytes[streamOffset + 3] & 0x0f) << 8) | bytes[streamOffset + 4];
                    if (streamType === 0x1b || streamType === 0x24) {
                        result.videoPid = elementaryPid;
                    }
                    streamOffset += 5 + descriptorLength;
                }
            }
        }

        if (result.videoPid !== null && pid === result.videoPid) {
            for (let index = payloadOffset; index + 5 < offset + 188; index += 1) {
                let nalOffset = 0;
                if (bytes[index] === 0x00 && bytes[index + 1] === 0x00 && bytes[index + 2] === 0x01) {
                    nalOffset = index + 3;
                } else if (bytes[index] === 0x00 && bytes[index + 1] === 0x00 && bytes[index + 2] === 0x00 && bytes[index + 3] === 0x01) {
                    nalOffset = index + 4;
                }
                if (!nalOffset) continue;

                const h264NalType = bytes[nalOffset] & 0x1f;
                const h265NalType = (bytes[nalOffset] >> 1) & 0x3f;
                if (h264NalType === 5 || (h265NalType >= 16 && h265NalType <= 21)) {
                    result.hasKeyframe = true;
                    return result;
                }
            }
        }
    }

    return result;
}

function validateForceMergeExportStructure(task, mode, exportableSegments) {
    if (mode === 'discrete' || task?.format === 'mp4') {
        return { ok: true, reason: '', analysis: null };
    }

    const parts = exportableSegments.map(segment => segment.bytes).filter(part => part instanceof Uint8Array);
    const byteLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
    if (byteLength < 188) {
        return { ok: true, reason: '', analysis: null };
    }

    const analysis = analyzeTsExportParts(parts);
    if (!analysis.checked) {
        return { ok: true, reason: '', analysis };
    }

    const syncRatio = analysis.packetCount > 0 ? analysis.syncPackets / analysis.packetCount : 0;
    if (syncRatio < 0.9 || analysis.patCount <= 0 || analysis.pmtCount <= 0 || analysis.videoPid === null) {
        return {
            ok: false,
            reason: '连续片段暂不具备可播放结构，建议继续下载更多连续碎片后再合并。',
            analysis
        };
    }

    return { ok: true, reason: '', analysis };
}

function buildForceMergeExportParts(task, exportableSegments) {
    const mediaParts = exportableSegments
        .map(segment => segment?.bytes)
        .filter(part => part instanceof Uint8Array);

    if (!isFmp4Task(task)) {
        return mediaParts;
    }

    const initBytes = getFmp4InitBytes(task);
    if (!(initBytes instanceof Uint8Array)) {
        throw new Error('fMP4 初始化片段缺失，无法导出。');
    }

    return [initBytes, ...mediaParts];
}

function settleDownloadObjectUrl(objectUrl) {
    const record = downloadObjectUrlRecords.get(String(objectUrl || ''));
    if (!record || record.settled) return false;
    record.settled = true;
    if (record.timeoutId != null) {
        clearTimeout(record.timeoutId);
    }
    downloadObjectUrlRecords.delete(record.objectUrl);
    const taskUrls = taskDownloadObjectUrls.get(record.taskId);
    taskUrls?.delete(record.objectUrl);
    if (taskUrls?.size === 0) {
        taskDownloadObjectUrls.delete(record.taskId);
    }
    URL.revokeObjectURL(record.objectUrl);
    record.resolve();
    return true;
}

function revokeTaskDownloadObjectUrls(taskId) {
    const normalizedTaskId = String(taskId || '');
    const objectUrls = taskDownloadObjectUrls.get(normalizedTaskId);
    if (!objectUrls) return false;
    [...objectUrls].forEach(objectUrl => settleDownloadObjectUrl(objectUrl));
    return true;
}

async function triggerBrowserDownload(parts, outputFileName, mimeType, taskId = '') {
    const blob = new Blob(parts, { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const normalizedTaskId = String(taskId || '');
    let resolveObjectUrl;
    const objectUrlPromise = new Promise(resolve => {
        resolveObjectUrl = resolve;
    });
    const record = {
        objectUrl,
        taskId: normalizedTaskId,
        timeoutId: null,
        settled: false,
        resolve: resolveObjectUrl
    };
    const taskUrls = taskDownloadObjectUrls.get(normalizedTaskId) ?? new Set();
    taskUrls.add(objectUrl);
    taskDownloadObjectUrls.set(normalizedTaskId, taskUrls);
    downloadObjectUrlRecords.set(objectUrl, record);

    anchor.href = objectUrl;
    anchor.download = outputFileName;
    try {
        document.body.appendChild(anchor);
        anchor.click();
    } catch (error) {
        settleDownloadObjectUrl(objectUrl);
        throw error;
    } finally {
        if (anchor.parentNode) {
            document.body.removeChild(anchor);
        }
    }
    record.timeoutId = setTimeout(() => {
        settleDownloadObjectUrl(objectUrl);
    }, DOWNLOAD_OBJECT_URL_REVOKE_DELAY_MS);
    await objectUrlPromise;
}

function triggerTsDownload(parts, outputFileName, taskId = '') {
    return triggerBrowserDownload(parts, outputFileName, 'video/mp2t', taskId);
}

function transmuxTsPartsToMp4(parts) {
    const Transmuxer = globalThis.muxjs?.mp4?.Transmuxer;
    if (typeof Transmuxer !== 'function') {
        throw new Error('MP4 不兼容，建议改用 TS');
    }

    const mp4Parts = [];
    const transmuxer = new Transmuxer();
    transmuxer.on('data', segment => {
        if (segment?.initSegment instanceof Uint8Array) {
            mp4Parts.push(segment.initSegment);
        }
        if (segment?.data instanceof Uint8Array) {
            mp4Parts.push(segment.data);
        }
    });

    parts.forEach(part => {
        if (part instanceof Uint8Array) {
            transmuxer.push(part);
        }
    });
    transmuxer.flush();
    if (typeof transmuxer.dispose === 'function') {
        transmuxer.dispose();
    }

    if (mp4Parts.length === 0) {
        throw new Error('MP4 不兼容，建议改用 TS');
    }
    return mp4Parts;
}

async function transmuxTsBlobPartsToMp4(parts, taskId = '') {
    const Transmuxer = globalThis.muxjs?.mp4?.Transmuxer;
    if (typeof Transmuxer !== 'function') {
        throw new Error('MP4 不兼容，建议改用 TS');
    }

    const mp4Parts = [];
    let hasInitSegment = false;
    const transmuxer = new Transmuxer();
    transmuxer.on('data', segment => {
        if (!hasInitSegment && segment?.initSegment instanceof Uint8Array) {
            mp4Parts.push(new Blob([segment.initSegment]));
            hasInitSegment = true;
        }
        if (segment?.data instanceof Uint8Array) {
            mp4Parts.push(new Blob([segment.data]));
        }
    });

    try {
        for (const part of Array.isArray(parts) ? parts : []) {
            const partSize = part instanceof Blob
                ? part.size
                : (part instanceof Uint8Array ? part.byteLength : 0);
            const reservation = typeof downloadMemoryGovernor !== 'undefined'
                ? downloadMemoryGovernor.reserve(taskId, Math.max(MEBIBYTE, partSize * 2))
                : null;
            if (typeof downloadMemoryGovernor !== 'undefined' && !reservation) {
                throw new Error('内存空间不足，无法安全转换 MP4，请改用 TS 或边下边存。');
            }
            try {
                const bytes = part instanceof Blob
                    ? new Uint8Array(await part.arrayBuffer())
                    : part;
                if (!(bytes instanceof Uint8Array)) continue;
                transmuxer.push(bytes);
                transmuxer.flush();
            } finally {
                if (reservation) downloadMemoryGovernor.release(reservation);
            }
        }
    } finally {
        if (typeof transmuxer.dispose === 'function') {
            transmuxer.dispose();
        }
    }
    if (mp4Parts.length === 0) {
        throw new Error('MP4 不兼容，建议改用 TS');
    }
    return mp4Parts;
}

async function triggerMp4Download(parts, outputFileName, taskId = '') {
    const partList = Array.isArray(parts) ? parts : [];
    const mp4Parts = partList.some(part => part instanceof Blob)
        ? await transmuxTsBlobPartsToMp4(partList, taskId)
        : transmuxTsPartsToMp4(partList);
    return triggerBrowserDownload(mp4Parts, outputFileName, 'video/mp4', taskId);
}

function triggerTaskDownload(task, parts, outputFileName) {
    if (isFmp4Task(task)) {
        return triggerBrowserDownload(parts, outputFileName, 'video/mp4', task?.id);
    }

    if (task?.format === 'mp4') {
        return triggerMp4Download(parts, outputFileName, task?.id);
    }

    return triggerTsDownload(parts, outputFileName, task?.id);
}

async function triggerSeparateRenditionDownloads(task, outputs) {
    const outputList = Array.isArray(outputs) ? outputs : [];
    for (const output of outputList) {
        if (!Array.isArray(output?.parts) || !output.fileName || !output.mimeType) continue;
        await triggerBrowserDownload(output.parts, output.fileName, output.mimeType, task?.id);
    }
}

async function getTaskExportParts(task) {
    const segments = typeof getEffectiveTaskSegments === 'function'
        ? getEffectiveTaskSegments(task)
        : (Array.isArray(task?.segments) ? task.segments : []);
    const orderedSegments = segments
        .slice()
        .sort((left, right) => Number(left?.sequence) - Number(right?.sequence));
    if (orderedSegments.length === 0) return [];

    const parts = [];
    if (isFmp4Task(task)) {
        let initBytes = getFmp4InitBytes(task);
        if (!(initBytes instanceof Uint8Array)) {
            const firstSegment = orderedSegments[0];
            initBytes = await getCachedFmp4InitBytes(task, firstSegment, null, new Map());
        }
        if (!(initBytes instanceof Uint8Array)) {
            throw new Error('fMP4 初始化片段缺失，无法导出。');
        }
        parts.push(new Blob([initBytes]));
        if (typeof releaseDownloadedBytesReservation === 'function') {
            releaseDownloadedBytesReservation(initBytes);
        }
    }

    for (const segment of orderedSegments) {
        let bytes = segment?.bytes instanceof Uint8Array ? segment.bytes : null;
        let reservation = null;
        if (!bytes && segment?.cacheStored) {
            if (typeof downloadMemoryGovernor !== 'undefined') {
                const expectedBytes = Math.max(MEBIBYTE, Number(segment?.byteLength) || 0);
                reservation = downloadMemoryGovernor.reserve(task?.id, expectedBytes * 2);
                if (!reservation) {
                    throw new Error('内存空间不足，无法安全读取本地分片缓存。');
                }
            }
            try {
                bytes = await getCachedSegmentBytes(task?.id, segment.sequence);
            } catch (error) {
                if (reservation) downloadMemoryGovernor.release(reservation);
                throw error;
            }
        }
        if (!(bytes instanceof Uint8Array)) {
            if (reservation) downloadMemoryGovernor.release(reservation);
            throw new Error('本地分片缓存不完整，请重新下载缺失内容。');
        }
        parts.push(new Blob([bytes]));
        if (reservation) downloadMemoryGovernor.release(reservation);
    }
    return parts;
}

function getCompletedTaskExportParts(task) {
    const segments = typeof getEffectiveTaskSegments === 'function'
        ? getEffectiveTaskSegments(task)
        : (Array.isArray(task?.segments) ? task.segments : []);
    const orderedSegments = segments
        .slice()
        .sort((left, right) => Number(left?.sequence) - Number(right?.sequence));

    if (orderedSegments.length === 0 || orderedSegments.some(segment => !hasDownloadedSegmentBytes(segment))) {
        return [];
    }

    return orderedSegments.map(segment => segment.bytes);
}

function getFmp4InitBytes(task) {
    const segments = typeof getEffectiveTaskSegments === 'function'
        ? getEffectiveTaskSegments(task)
        : (Array.isArray(task?.segments) ? task.segments : []);
    const firstSegment = segments[0];
    return firstSegment?.initBytes instanceof Uint8Array
        ? firstSegment.initBytes
        : null;
}

async function getCachedFmp4InitBytes(task, segment, controller, cache) {
    if (segment?.container !== 'fmp4' || !segment.initSegment) {
        return null;
    }

    const initCache = cache instanceof Map ? cache : new Map();
    const initCacheKey = JSON.stringify(segment.initSegment);
    if (initCache.has(initCacheKey)) {
        return initCache.get(initCacheKey);
    }

    const initBytesPromise = downloadFmp4Part(task, segment.initSegment, controller);
    initCache.set(initCacheKey, initBytesPromise);
    try {
        const initBytes = await initBytesPromise;
        initCache.set(initCacheKey, initBytes);
        return initBytes;
    } catch (error) {
        initCache.delete(initCacheKey);
        throw error;
    }
}

function getFmp4CompletedTaskExportParts(task) {
    const initBytes = getFmp4InitBytes(task);
    if (!(initBytes instanceof Uint8Array)) {
        throw new Error('fMP4 初始化片段缺失，无法导出。');
    }

    const segments = typeof getEffectiveTaskSegments === 'function'
        ? getEffectiveTaskSegments(task)
        : (Array.isArray(task?.segments) ? task.segments : []);
    const orderedSegments = segments
        .slice()
        .sort((left, right) => Number(left?.sequence) - Number(right?.sequence));
    if (
        orderedSegments.length === 0
        || orderedSegments.some(segment => segment?.status !== 'success' || !(segment.bytes instanceof Uint8Array))
    ) {
        throw new Error('fMP4 媒体片段缺失，无法导出。');
    }
    const mediaParts = orderedSegments.map(segment => segment.bytes);

    return [initBytes, ...mediaParts];
}

function mergeWebVttSegments(textParts) {
    const parts = Array.isArray(textParts) ? textParts : [];
    let timestampMap = '';
    const cues = [];
    let previousCue = '';

    parts.forEach(part => {
        const normalized = String(part || '')
            .replaceAll('\r\n', '\n')
            .replaceAll('\r', '\n')
            .trim();
        if (!normalized) return;

        const withoutHeader = normalized
            .replace(/^WEBVTT[^\n]*(\n+)?/i, '')
            .trim();
        if (!withoutHeader) return;

        const bodyLines = [];
        withoutHeader.split('\n').forEach(line => {
            const trimmedLine = line.trim();
            if (/^X-TIMESTAMP-MAP\s*=/i.test(trimmedLine)) {
                if (!timestampMap) {
                    timestampMap = trimmedLine;
                }
                return;
            }
            bodyLines.push(line);
        });

        bodyLines.join('\n')
            .split(/\n{2,}/)
            .map(block => block.trim())
            .filter(Boolean)
            .forEach(block => {
                if (block === previousCue) return;
                cues.push(block);
                previousCue = block;
            });
    });

    const headerLines = ['WEBVTT'];
    if (timestampMap) {
        headerLines.push(timestampMap);
    }

    return `${headerLines.join('\n')}\n\n${cues.join('\n\n')}\n`;
}

async function resolveMediaPlaylistFromUrl(url, task = null) {
    const normalizedUrl = String(url || '').trim();
    if (!normalizedUrl) {
        throw new Error(UNSUPPORTED_M3U8_TYPE_ERROR);
    }

    const result = await withDownloadRequestLease(task, normalizedUrl, async () => {
        const response = await fetch(normalizedUrl);
        const playlistText = await response.text();
        return {
            value: { response, playlistText },
            status: response.status
        };
    });
    const response = result.response;
    const playlistText = result.playlistText;
    if (!response.ok || !isLikelyM3U8Content(playlistText)) {
        throw new Error(UNSUPPORTED_M3U8_TYPE_ERROR);
    }

    return parseM3U8Playlist(playlistText, response.url || normalizedUrl);
}

async function downloadStandaloneMediaPlaylistParts(url, task) {
    const parsed = await resolveMediaPlaylistFromUrl(url, task);
    if (parsed.type !== 'media' || parsed.container !== 'fmp4' || !isPlaylistEncryptionSupported(parsed.encryption)) {
        throw new Error(UNSUPPORTED_M3U8_TYPE_ERROR);
    }

    const standaloneTask = {
        ...task,
        url,
        playlistType: 'media',
        playlistContainer: 'fmp4',
        downloadRangeMode: 'all',
        actualRangeStart: 1,
        actualRangeEnd: parsed.segments.length,
        segments: parsed.segments.map(segment => ({
            ...segment,
            status: 'idle',
            bytes: null,
            initBytes: null,
            streamSaved: false
        }))
    };
    const initBytesCache = new Map();
    const downloadedSegments = [];

    for (const segment of standaloneTask.segments) {
        const initBytes = await getCachedFmp4InitBytes(standaloneTask, segment, null, initBytesCache);
        const bytes = await downloadSegment(standaloneTask, segment, null);
        downloadedSegments.push({
            ...segment,
            status: 'success',
            bytes,
            initBytes: initBytes instanceof Uint8Array ? initBytes : null
        });
    }

    return getFmp4CompletedTaskExportParts({
        ...standaloneTask,
        segments: downloadedSegments
    });
}

async function downloadSelectedMediaRenditions(task, options = {}) {
    const outputs = [];
    const onBeforeDownload = typeof options?.onBeforeDownload === 'function'
        ? options.onBeforeDownload
        : null;
    const renditions = Array.isArray(task?.mediaRenditions) ? task.mediaRenditions : [];
    const selectedAudio = renditions.find(rendition => (
        String(rendition?.id || '') === String(task?.selectedAudioRenditionId || '')
    ));
    const selectedSubtitle = renditions.find(rendition => (
        String(rendition?.id || '') === String(task?.selectedSubtitleRenditionId || '')
    ));

    if (selectedAudio?.uri) {
        onBeforeDownload?.('audio');
        outputs.push({
            kind: 'audio',
            parts: await downloadStandaloneMediaPlaylistParts(selectedAudio.uri, task),
            fileName: `${getTaskOutputBaseName(task)}.audio.m4a`,
            mimeType: 'audio/mp4'
        });
    }

    if (selectedSubtitle?.uri) {
        onBeforeDownload?.('subtitle');
        const subtitlePlaylist = await resolveMediaPlaylistFromUrl(selectedSubtitle.uri, task);
        if (
            subtitlePlaylist.type !== 'media'
            || subtitlePlaylist.container !== 'subtitle'
            || !Array.isArray(subtitlePlaylist.segments)
        ) {
            throw new Error(UNSUPPORTED_SUBTITLE_FORMAT_ERROR);
        }

        const subtitleTexts = [];
        for (const segment of subtitlePlaylist.segments) {
            const subtitleText = await withDownloadRequestLease(task, segment.url, async () => {
                const response = await fetch(segment.url);
                if (!response.ok) {
                    const error = new Error('字幕下载失败：HTTP ' + response.status);
                    error.httpStatus = response.status;
                    error.retryAfterMs = parseRetryAfterMilliseconds(response);
                    throw error;
                }
                return response.text();
            });
            subtitleTexts.push(subtitleText);
        }

        outputs.push({
            kind: 'subtitle',
            parts: [mergeWebVttSegments(subtitleTexts)],
            fileName: `${getTaskOutputBaseName(task)}.subtitles.vtt`,
            mimeType: 'text/vtt'
        });
    }

    return outputs;
}

async function reSaveCompletedTask(taskId) {
    const task = findTaskById(taskId);
    if (!task || task.status !== 'completed') return task;

    try {
        const orderedParts = isFmp4Task(task)
            ? getFmp4CompletedTaskExportParts(task)
            : getCompletedTaskExportParts(task);
        if (orderedParts.length === 0) {
            showToast('当前任务缺少可保存数据，请重新下载', { type: 'error' });
            return task;
        }

        const runTaskFinalExport = typeof enqueueTaskFinalExport === 'function'
            ? enqueueTaskFinalExport
            : async (runtimeTaskId, operation) => {
                void runtimeTaskId;
                const runFinalExport = typeof enqueueFinalExport === 'function'
                    ? enqueueFinalExport
                    : queuedOperation => queuedOperation();
                return { cancelled: false, value: await runFinalExport(operation) };
            };
        const exportResult = await runTaskFinalExport(taskId, () => (
            triggerTaskDownload(task, orderedParts, task.outputFileName || buildTaskOutputFileName(task))
        ));
        if (exportResult?.cancelled) {
            return findTaskById(taskId);
        }
    } catch (error) {
        showRuntimeErrorToast(error, 'MP4 不兼容，建议改用 TS');
        return task;
    }
    showToast('已重新触发保存', { type: 'success' });
    return task;
}

function redownloadCompletedTask(taskId) {
    if (findTaskById(taskId)?.status === 'completed'
        && typeof cancelPendingTaskFinalExports === 'function') {
        cancelPendingTaskFinalExports(taskId);
    }
    const updatedTask = updateTask(taskId, task => {
        if (task.status !== 'completed') {
            return task;
        }

        return {
            ...task,
            status: 'queued',
            progress: 0,
            downloadedBytes: 0,
            totalBytes: 0,
            downloadSpeedBytesPerSecond: 0,
            estimatedRemainingSeconds: 0,
            outputFileName: '',
            errorMessage: '',
            recoveryMode: '',
            recoveryTargetSequence: 0,
            segments: Array.isArray(task.segments)
                ? task.segments.map(segment => ({
                    ...segment,
                    status: 'idle',
                    bytes: null,
                    initBytes: null,
                    byteLength: 0,
                    cacheStored: false,
                    streamSaved: false,
                    attemptCount: 0,
                    errorMessage: ''
                }))
                : task.segments
        };
    });

    if (updatedTask?.status === 'queued') {
        showToast('已加入重新下载队列', { type: 'info' });
        scheduleNextQueuedTask();
    }

    return updatedTask;
}

async function exportTaskAsTs(task) {
    const segments = typeof getEffectiveTaskSegments === 'function'
        ? getEffectiveTaskSegments(task)
        : (() => {
            const allSegments = Array.isArray(task?.segments) ? task.segments : [];
            if (task?.downloadRangeMode !== 'custom') {
                return allSegments;
            }
            const start = Number(task?.actualRangeStart) || 0;
            const end = Number(task?.actualRangeEnd) || 0;
            if (start <= 0 || end <= 0 || end < start) {
                return [];
            }
            return allSegments.filter(segment => {
                const sequence = Number(segment?.sequence);
                return Number.isFinite(sequence) && sequence >= start && sequence <= end;
            });
        })();
    const hasCachedSegments = segments.some(segment => segment?.cacheStored === true);
    const orderedParts = hasCachedSegments
        ? await getTaskExportParts(task)
        : (isFmp4Task(task)
            ? getFmp4CompletedTaskExportParts(task)
            : segments
                .filter(segment => segment.status === 'success' && segment.bytes instanceof Uint8Array)
                .sort((left, right) => left.sequence - right.sequence)
                .map(segment => segment.bytes));

    const outputFileName = buildTaskOutputFileName(task);
    try {
        await triggerTaskDownload(task, orderedParts, outputFileName);
    } catch (error) {
        showRuntimeErrorToast(error, 'MP4 不兼容，建议改用 TS');
        throw error;
    }

    if (task.selectedAudioRenditionId || task.selectedSubtitleRenditionId) {
        const getFinalizingMessage = (kind) => {
            if (kind === 'audio') return '保存音轨中';
            if (kind === 'subtitle') return '保存字幕中';
            if (task.selectedAudioRenditionId) return '保存音轨中';
            if (task.selectedSubtitleRenditionId) return '保存字幕中';
            return '正在保存外部音轨/字幕…';
        };
        const setFinalizingMessage = (kind) => {
            const finalizingMessage = getFinalizingMessage(kind);
            updateTask(task.id, currentTask => {
                if (currentTask?.status === 'finalizing' && currentTask?.finalizingMessage === finalizingMessage) {
                    return null;
                }
                return {
                    ...currentTask,
                    status: 'finalizing',
                    progress: 100,
                    downloadSpeedBytesPerSecond: 0,
                    estimatedRemainingSeconds: 0,
                    outputFileName,
                    finalizingMessage,
                    errorMessage: '正在保存外部音轨/字幕…'
                };
            }, { render: 'live' });
        };

        updateTask(task.id, currentTask => ({
            ...currentTask,
            status: 'finalizing',
            progress: 100,
            downloadSpeedBytesPerSecond: 0,
            estimatedRemainingSeconds: 0,
            outputFileName,
            finalizingMessage: getFinalizingMessage(),
            errorMessage: '正在保存外部音轨/字幕…'
        }));

        try {
            const extraOutputs = await downloadSelectedMediaRenditions(task, {
                onBeforeDownload: setFinalizingMessage
            });
            await triggerSeparateRenditionDownloads(task, extraOutputs);
            completeTask(task.id, outputFileName);
            showToast('当前 fMP4 音视频合成暂不支持，已分别保存；直接打开视频可能无声，需要手动加载音轨或合并后播放。', { type: 'info' });
        } catch (error) {
            const detail = getUserFacingErrorMessage(error, '音轨或字幕分别保存失败');
            updateTask(task.id, currentTask => ({
                ...currentTask,
                status: 'partial_completed',
                progress: 100,
                downloadSpeedBytesPerSecond: 0,
                estimatedRemainingSeconds: 0,
                outputFileName,
                finalizingMessage: '',
                errorMessage: `视频已保存，但音轨或字幕分别保存失败。${detail ? ` ${detail}` : ''}`
            }));
            showToast(`视频已保存，但音轨或字幕分别保存失败。${detail ? ` ${detail}` : ''}`, { type: 'error' });
        }
        return;
    }

    completeTask(task.id, outputFileName);
}

async function forceMergeTask(taskId, mode) {
    const task = findTaskById(taskId);
    if (!task || !canTaskForceMerge(task)) {
        return task;
    }
    const requestedMode = mode === 'discrete' ? 'discrete' : 'prefix';
    const normalizedMode = typeof normalizeForceMergeModeForTask === 'function'
        ? normalizeForceMergeModeForTask(task, requestedMode)
        : (isFmp4Task(task) || task.format === 'mp4' ? 'prefix' : requestedMode);

    if (requestedMode === 'discrete' && normalizedMode !== 'discrete') {
        if (isFmp4Task(task)) {
            showToast('fMP4 仅支持连续前缀强制合并。', { type: 'info' });
        } else if (task.format === 'mp4') {
            showToast('离散硬拼仅支持 TS', { type: 'error' });
        }
    }

    if (task.format === 'mp4' && normalizedMode === 'discrete') {
        showToast('离散硬拼仅支持 TS', { type: 'error' });
        return task;
    }

    if (typeof cancelPendingTaskFinalExports === 'function') {
        cancelPendingTaskFinalExports(taskId);
    }

    const executionStore = typeof runningTaskExecutions !== 'undefined'
        ? runningTaskExecutions
        : globalThis.__runningTaskExecutions;
    const executionPromises = typeof runningTaskExecutionPromises !== 'undefined'
        ? runningTaskExecutionPromises
        : globalThis.__runningTaskExecutionPromises;
    const executionPromise = executionPromises?.get(String(taskId));
    const hasPendingTaskWork = Boolean(
        executionPromise
        || executionStore?.has(String(taskId))
        || String(activeTaskId) === String(taskId)
        || (typeof hasStandaloneTaskRequestScope === 'function'
            && hasStandaloneTaskRequestScope(taskId))
    );
    if (hasPendingTaskWork) {
        abortTaskRequests(taskId);
        const scheduler = globalThis.__downloadRequestScheduler
            || (typeof downloadRequestScheduler !== 'undefined' ? downloadRequestScheduler : null);
        scheduler?.stopTask(taskId);
        if (executionPromise) {
            await executionPromise.catch(() => {});
        }
        if (typeof waitForStandaloneTaskRequestScopes === 'function') {
            await waitForStandaloneTaskRequestScopes(taskId);
        }
        clearTaskRequestControllers(taskId);
    }

    const latestTask = findTaskById(taskId);
    if (!latestTask) return null;
    const {
        exportableSegments,
        missingSuccessfulBytes,
        durationSeconds
    } = summarizeForceMergeSegments(latestTask, normalizedMode);
    if (exportableSegments.length === 0) {
        showToast('当前没有可导出内容', { type: 'error' });
        scheduleNextQueuedTask();
        return findTaskById(taskId);
    }

    if (isForceMergeExportTooShort({ durationSeconds }, normalizedMode)) {
        showToast(`连续内容过短，建议继续下载到至少 ${formatDurationFromSeconds(MIN_FORCE_MERGE_PREFIX_DURATION_SECONDS)} 后再合并`, { type: 'error' });
        scheduleNextQueuedTask();
        return findTaskById(taskId);
    }

    const structureValidation = validateForceMergeExportStructure(latestTask, normalizedMode, exportableSegments);

    const outputFileName = buildForceMergeOutputFileName(latestTask, normalizedMode);
    try {
        const runTaskFinalExport = typeof enqueueTaskFinalExport === 'function'
            ? enqueueTaskFinalExport
            : async (runtimeTaskId, operation) => {
                void runtimeTaskId;
                const runFinalExport = typeof enqueueFinalExport === 'function'
                    ? enqueueFinalExport
                    : queuedOperation => queuedOperation();
                return { cancelled: false, value: await runFinalExport(operation) };
            };
        const exportResult = await runTaskFinalExport(taskId, () => (
            triggerTaskDownload(latestTask, buildForceMergeExportParts(latestTask, exportableSegments), outputFileName)
        ));
        if (exportResult?.cancelled) {
            scheduleNextQueuedTask();
            return findTaskById(taskId);
        }
    } catch (error) {
        showRuntimeErrorToast(error, 'MP4 不兼容，建议改用 TS');
        scheduleNextQueuedTask();
        return findTaskById(taskId);
    }

    const actualRange = getTaskActualRange(latestTask);
    const updatedTask = updateTask(taskId, currentTask => ({
        ...currentTask,
        lastForceMergeSummary: {
            mode: normalizedMode,
            segmentCount: exportableSegments.length,
            durationSeconds,
            structureWarning: !structureValidation.ok,
            outputFileName,
            rangeStart: actualRange.start,
            rangeEnd: actualRange.end,
            createdAt: Date.now()
        }
    }));

    if (missingSuccessfulBytes) {
        showToast('部分已成功分片缓存缺失，本次仅导出仍可用的内容', { type: 'info' });
    } else {
        showToast('强制合并已开始导出', { type: 'success' });
    }

    scheduleNextQueuedTask();
    return updatedTask;
}

function scheduleNextQueuedTask() {
    const executionStore = typeof runningTaskExecutions !== 'undefined'
        ? runningTaskExecutions
        : (globalThis.__runningTaskExecutions = globalThis.__runningTaskExecutions || new Set());
    const scheduler = globalThis.__downloadRequestScheduler
        || (typeof downloadRequestScheduler !== 'undefined' ? downloadRequestScheduler : null);
    if (!scheduler) {
        if (activeTaskId) return;
        const fallbackTask = currentTasks.find(task => task.status === 'queued');
        if (fallbackTask) {
            activeTaskId = String(fallbackTask.id);
            Promise.resolve().then(() => startTaskExecution(fallbackTask.id));
        }
        return;
    }
    currentTasks
        .filter(task => (
            task.status === 'queued'
            && !executionStore.has(String(task.id))
            && !runningTaskExecutionPromises.has(String(task.id))
        ))
        .forEach(task => {
            scheduler.startTask(task.id, task.concurrency);
            const taskId = String(task.id);
            const executionPromise = Promise.resolve()
                .then(() => startTaskExecution(task.id))
                .finally(() => {
                    runningTaskExecutionPromises.delete(taskId);
                    scheduleNextQueuedTask();
                });
            runningTaskExecutionPromises.set(taskId, executionPromise);
        });
}

function isTaskReadyForSegmentResume(task) {
    if (!task || task.playlistType !== 'media') {
        return false;
    }

    if (taskHasUpgradeableInsecurePlaylistResource(task)) {
        return false;
    }

    const segments = getEffectiveTaskSegments(task);
    if (segments.length === 0) {
        return false;
    }

    const hasConfirmedRange = task.downloadRangeMode !== 'custom'
        || (Number(task.actualRangeStart) > 0
            && Number(task.actualRangeEnd) >= Number(task.actualRangeStart));
    if (!hasConfirmedRange) {
        return false;
    }

    return segments.every(segment => (
        hasSegmentRuntimeMetadata(segment)
        && (hasDownloadedSegmentBytes(segment) || (typeof segment.url === 'string' && segment.url.trim()))
    ));
}

function taskHasUpgradeableInsecurePlaylistResource(task) {
    let taskUrl;
    try {
        taskUrl = new URL(task?.url || '');
    } catch {
        return false;
    }

    if (taskUrl.protocol !== 'https:') {
        return false;
    }

    const hasUpgradeableUrl = (url) => {
        try {
            const parsedUrl = new URL(url, taskUrl);
            return parsedUrl.protocol === 'http:' && parsedUrl.hostname === taskUrl.hostname;
        } catch {
            return false;
        }
    };

    const segments = Array.isArray(task?.segments) ? task.segments : [];
    return segments.some(segment => (
        hasUpgradeableUrl(segment?.url)
        || hasUpgradeableUrl(segment?.encryption?.keyUri)
    ));
}

function isTaskMissingRecoveryContext(task) {
    if (!task || task.playlistType !== 'media') return false;
    if (!['queued', 'recoverable', 'failed', 'partial_completed'].includes(task.status)) return false;

    const segments = getEffectiveTaskSegments(task);
    if (segments.length === 0) return true;

    const hasConfirmedRange = task.downloadRangeMode !== 'custom'
        || (Number(task.actualRangeStart) > 0
            && Number(task.actualRangeEnd) >= Number(task.actualRangeStart));
    if (!hasConfirmedRange) return true;

    return !segments.every(segment => hasSegmentRuntimeMetadata(segment));
}

async function startTaskExecution(taskId) {
    const normalizedTaskId = String(taskId);
    const executionStore = typeof runningTaskExecutions !== 'undefined'
        ? runningTaskExecutions
        : (globalThis.__runningTaskExecutions = globalThis.__runningTaskExecutions || new Set());
    const scheduler = globalThis.__downloadRequestScheduler
        || (typeof downloadRequestScheduler !== 'undefined' ? downloadRequestScheduler : null);
    if (executionStore.has(normalizedTaskId)) {
        return null;
    }
    executionStore.add(normalizedTaskId);
    const initialTaskForBudget = findTaskById(taskId);
    scheduler?.startTask(taskId, initialTaskForBudget?.concurrency);

    try {
        const initialTask = findTaskById(taskId);
        if (!initialTask || !['queued', 'detecting', 'resolving', 'downloading'].includes(initialTask.status)) {
            return initialTask;
        }

        let task = initialTask;
        if (isTaskMissingRecoveryContext(initialTask)) {
            return failTask(taskId, RECOVERY_CONTEXT_INCOMPLETE_ERROR);
        }
        if (!isTaskReadyForSegmentResume(initialTask)) {
            task = await downloadMediaPlaylistTask(initialTask);
        }
        const resolvedTask = findTaskById(taskId);
        if (resolvedTask?.status === 'failed'
            || resolvedTask?.status === 'paused'
            || resolvedTask?.status === 'await_range_selection') {
            return resolvedTask;
        }
        if (!resolvedTask) {
            return null;
        }

        task = await downloadTaskSegments(resolvedTask ?? task);
        const finalTask = findTaskById(taskId);
        if (!finalTask) {
            return null;
        }
        if (finalTask?.status === 'failed' || finalTask?.status === 'paused') {
            return finalTask;
        }

        const resolvedSegments = typeof getEffectiveTaskSegments === 'function'
            ? getEffectiveTaskSegments(finalTask ?? task)
            : (Array.isArray(finalTask?.segments) ? finalTask.segments : []);
        const hasRemainingIncompleteSegments = resolvedSegments.some(segment => !hasCompletedSegment(segment));
        if (hasRemainingIncompleteSegments) {
            return updateTask(taskId, currentTask => ({
                ...currentTask,
                status: resolvedSegments.some(segment => segment.status === 'failed') ? 'failed' : currentTask.status,
                recoveryMode: '',
                recoveryTargetSequence: 0
            }));
        }

        const hasStreamSavedSegments = resolvedSegments.some(segment => segment.streamSaved === true);
        if (!hasStreamSavedSegments) {
            const runTaskFinalExport = typeof enqueueTaskFinalExport === 'function'
                ? enqueueTaskFinalExport
                : async (runtimeTaskId, operation) => {
                    void runtimeTaskId;
                    const runFinalExport = typeof enqueueFinalExport === 'function'
                        ? enqueueFinalExport
                        : queuedOperation => queuedOperation();
                    return { cancelled: false, value: await runFinalExport(operation) };
                };
            const exportResult = await runTaskFinalExport(taskId, () => exportTaskAsTs(finalTask ?? task));
            if (exportResult?.cancelled) {
                return findTaskById(taskId);
            }
        }
        return findTaskById(taskId);
    } catch (error) {
        if (isUserAbortError(error)) {
            updateTask(taskId, currentTask => ({
                ...currentTask,
                status: 'paused',
                errorMessage: '',
                segments: Array.isArray(currentTask.segments)
                    ? currentTask.segments.map(segment => (
                        segment.status === 'downloading' || segment.status === 'retrying'
                            ? {
                                ...segment,
                                status: 'idle',
                                errorMessage: ''
                            }
                            : segment
                    ))
                    : currentTask.segments
            }));
            showToast(getUserFacingErrorMessage(error, '已取消文件保存'), { type: 'info' });
            return findTaskById(taskId);
        }
        const message = getUserFacingErrorMessage(error, '下载失败');
        failTask(taskId, message);
        return findTaskById(taskId);
    } finally {
        const latestTask = findTaskById(taskId);
        const shouldKeepActiveLock = ['queued', 'detecting', 'resolving', 'downloading'].includes(latestTask?.status);
        const hasStandaloneRequests = typeof hasStandaloneTaskRequestScope === 'function'
            && hasStandaloneTaskRequestScope(taskId);
        if (!shouldKeepActiveLock && !hasStandaloneRequests) {
            scheduler?.unregisterTask(taskId);
        }
        if (!scheduler && String(activeTaskId) === normalizedTaskId && !shouldKeepActiveLock) {
            activeTaskId = null;
        }
        executionStore.delete(normalizedTaskId);
        scheduleNextQueuedTask();
    }
}

function pauseTask(taskId) {
    const requestControllerStore = typeof taskRequestControllers !== 'undefined'
        ? taskRequestControllers
        : (globalThis.__taskRequestControllers = globalThis.__taskRequestControllers || new Map());
    const abortRequests = typeof abortTaskRequests === 'function'
        ? abortTaskRequests
        : (runtimeTaskId) => {
            const controllerMap = requestControllerStore.get(String(runtimeTaskId));
            if (!controllerMap) return;

            controllerMap.forEach(controller => {
                if (controller && typeof controller.abort === 'function') {
                    controller.abort();
                }
            });
            controllerMap.clear();
        };

    const taskBeforePause = findTaskById(taskId);
    if (['downloading', 'detecting', 'resolving', 'queued'].includes(taskBeforePause?.status)
        && typeof cancelPendingTaskFinalExports === 'function') {
        cancelPendingTaskFinalExports(taskId);
    }

    const pausedTask = updateTask(taskId, task => {
        if (!['downloading', 'detecting', 'resolving', 'queued'].includes(task.status)) {
            return task;
        }

        const shouldKeepStreamWriterOpen = Boolean(task.streamSave && taskStreamWriters.has(String(taskId)));
        if (!shouldKeepStreamWriterOpen) {
            abortRequests(taskId);
        }

        return {
            ...task,
            status: 'paused',
            downloadSpeedBytesPerSecond: 0,
            estimatedRemainingSeconds: 0,
            segments: Array.isArray(task.segments)
                ? task.segments.map(segment => (
                    segment.status === 'downloading' && !shouldKeepStreamWriterOpen
                        ? {
                            ...segment,
                            status: 'idle',
                            errorMessage: ''
                        }
                        : segment
                ))
                : task.segments
        };
    });

    const scheduler = globalThis.__downloadRequestScheduler
        || (typeof downloadRequestScheduler !== 'undefined' ? downloadRequestScheduler : null);
    scheduler?.stopTask(taskId);
    if (String(activeTaskId) === String(taskId)) {
        activeTaskId = null;
    }
    scheduleNextQueuedTask();

    return pausedTask;
}

function resumeTask(taskId, options = {}) {
    const resumedTask = updateTask(taskId, task => {
        if (task.status !== 'paused') {
            return task;
        }

        return {
            ...task,
            status: 'queued',
            downloadSpeedBytesPerSecond: 0,
            estimatedRemainingSeconds: 0
        };
    });

    if (options.schedule !== false && resumedTask?.status === 'queued') {
        scheduleNextQueuedTask();
    }

    return resumedTask;
}

function restartTaskFromIncompleteSegments(taskId, options = {}) {
    const hasStandaloneRetry = typeof hasStandaloneTaskRequestScope === 'function'
        && hasStandaloneTaskRequestScope(taskId);
    if (hasStandaloneRetry) {
        abortTaskRequests(taskId);
        const scheduler = globalThis.__downloadRequestScheduler
            || (typeof downloadRequestScheduler !== 'undefined' ? downloadRequestScheduler : null);
        scheduler?.stopTask(taskId);
    }
    const getSegmentEligibility = typeof isTaskSegmentWithinActualRange === 'function'
        ? isTaskSegmentWithinActualRange
        : (task, segment) => {
            if (task?.downloadRangeMode !== 'custom') {
                return true;
            }
            const allSegments = Array.isArray(task?.segments) ? task.segments : [];
            if (allSegments.length === 0) {
                return false;
            }
            const start = Number(task?.actualRangeStart) || 0;
            const end = Number(task?.actualRangeEnd) || 0;
            if (start <= 0 || end <= 0 || end < start) {
                return false;
            }
            const sequence = Number(segment?.sequence);
            return Number.isFinite(sequence) && sequence >= start && sequence <= end;
        };
    const resumedTask = updateTask(taskId, task => {
        if (!['failed', 'recoverable', 'partial_completed'].includes(task.status)) {
            return task;
        }

        return {
            ...task,
            status: 'queued',
            errorMessage: '',
            recoveryMode: 'incomplete',
            recoveryTargetSequence: 0,
            downloadSpeedBytesPerSecond: 0,
            estimatedRemainingSeconds: 0,
            segments: Array.isArray(task.segments)
                ? task.segments.map(segment => {
                    if (!getSegmentEligibility(task, segment)) {
                        return segment;
                    }

                    return hasDownloadedSegmentBytes(segment)
                        ? {
                            ...segment,
                            errorMessage: ''
                        }
                        : {
                            ...segment,
                            status: 'idle',
                            bytes: null,
                            attemptCount: 0,
                            errorMessage: ''
                        };
                })
                : task.segments
        };
    });

    if (options.schedule !== false && resumedTask?.status === 'queued') {
        if (hasStandaloneRetry && typeof waitForStandaloneTaskRequestScopes === 'function') {
            waitForStandaloneTaskRequestScopes(taskId).then(() => {
                if (findTaskById(taskId)?.status === 'queued') {
                    scheduleNextQueuedTask();
                }
            });
        } else {
            scheduleNextQueuedTask();
        }
    }

    return resumedTask;
}

async function retryTaskSegment(taskId, sequence) {
    const numericSequence = Number(sequence);
    if (!Number.isFinite(numericSequence) || numericSequence <= 0) {
        return null;
    }

    const getSegmentEligibility = typeof isTaskSegmentWithinActualRange === 'function'
        ? isTaskSegmentWithinActualRange
        : (task, segment) => {
            if (task?.downloadRangeMode !== 'custom') {
                return true;
            }
            const allSegments = Array.isArray(task?.segments) ? task.segments : [];
            if (allSegments.length === 0) {
                return false;
            }
            const start = Number(task?.actualRangeStart) || 0;
            const end = Number(task?.actualRangeEnd) || 0;
            if (start <= 0 || end <= 0 || end < start) {
                return false;
            }
            const resolvedSequence = Number(segment?.sequence);
            return Number.isFinite(resolvedSequence) && resolvedSequence >= start && resolvedSequence <= end;
        };
    let retryContext = null;
    const retryingTask = updateTask(taskId, task => {
        const targetSegment = Array.isArray(task.segments)
            ? task.segments.find(segment => Number(segment?.sequence) === numericSequence)
            : null;
        if (!targetSegment || targetSegment.status !== 'failed' || !getSegmentEligibility(task, targetSegment)) {
            return task;
        }
        if (!targetSegment.url) {
            retryContext = { errorMessage: '该碎片缺少下载地址，无法重试。' };
            return task;
        }

        retryContext = {
            taskSnapshot: task,
            segmentSnapshot: targetSegment,
            sequence: numericSequence
        };

        return {
            ...task,
            errorMessage: '',
            segments: task.segments.map(segment => (
                Number(segment?.sequence) === numericSequence
                    ? {
                        ...segment,
                        status: 'retrying',
                        bytes: null,
                        attemptCount: (Number(segment.attemptCount) || 0) + 1,
                        errorMessage: ''
                    }
                    : segment
            ))
        };
    });

    if (!retryContext) {
        return retryingTask;
    }

    if (retryContext.errorMessage) {
        if (typeof showToast === 'function') {
            showToast(retryContext.errorMessage, { type: 'error' });
        }
        return retryingTask;
    }

    const requestControllers = getTaskRequestControllerMap(taskId);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    requestControllers.set(numericSequence, controller);
    const scopedTask = typeof beginStandaloneTaskRequestScope === 'function'
        ? beginStandaloneTaskRequestScope(retryContext.taskSnapshot)
        : retryContext.taskSnapshot;

    try {
        const initBytes = retryContext.segmentSnapshot?.container === 'fmp4'
            ? await getCachedFmp4InitBytes(
                scopedTask,
                retryContext.segmentSnapshot,
                controller,
                new Map()
            )
            : null;
        const bytes = await downloadSegment(scopedTask, retryContext.segmentSnapshot, controller);
        const cacheStored = typeof putCachedSegmentBytes === 'function'
            ? await putCachedSegmentBytes(taskId, numericSequence, bytes)
            : false;
        requestControllers.delete(numericSequence);
        const latestTaskBeforeCommit = findTaskById(taskId);
        if (latestTaskBeforeCommit?.status === 'queued'
            && latestTaskBeforeCommit?.recoveryMode === 'incomplete') {
            return latestTaskBeforeCommit;
        }
        const updatedTask = updateTask(taskId, task => {
            const nextSegments = Array.isArray(task.segments)
                ? task.segments.map(segment => (
                    Number(segment?.sequence) === numericSequence
                        ? {
                            ...segment,
                            status: 'success',
                            bytes: cacheStored ? null : bytes,
                            byteLength: Number(bytes?.byteLength) || 0,
                            cacheStored,
                            initBytes: cacheStored
                                ? null
                                : (initBytes instanceof Uint8Array ? initBytes : segment.initBytes),
                            errorMessage: ''
                        }
                        : segment
                ))
                : task.segments;
            const downloadedBytes = Array.isArray(nextSegments)
                ? nextSegments.reduce((sum, segment) => (
                    sum + (segment.bytes instanceof Uint8Array
                        ? segment.bytes.byteLength
                        : (segment.cacheStored ? Math.max(0, Number(segment.byteLength) || 0) : 0))
                ), 0)
                : task.downloadedBytes;

            return {
                ...task,
                segments: nextSegments,
                downloadedBytes,
                totalBytes: downloadedBytes,
                progress: updateTaskProgressFromSegments({
                    ...task,
                    segments: nextSegments
                }),
                errorMessage: ''
            };
        });

        if (typeof releaseDownloadedBytesReservation === 'function') {
            releaseDownloadedBytesReservation(bytes);
            releaseDownloadedBytesReservation(initBytes);
        }

        if (typeof showToast === 'function') {
            showToast(`已重试第 ${numericSequence} 片`, { type: 'info' });
        }
        return updatedTask;
    } catch (error) {
        requestControllers.delete(numericSequence);
        const latestTaskBeforeFailure = findTaskById(taskId);
        if (latestTaskBeforeFailure?.status === 'queued'
            && latestTaskBeforeFailure?.recoveryMode === 'incomplete') {
            return latestTaskBeforeFailure;
        }
        const failureMessage = typeof normalizeRuntimeErrorMessage === 'function'
            ? normalizeRuntimeErrorMessage(error, '分片下载失败')
            : (error instanceof Error ? error.message : String(error));
        const updatedTask = updateTask(taskId, task => ({
            ...task,
            status: task.status === 'completed' ? task.status : 'failed',
            segments: Array.isArray(task.segments)
                ? task.segments.map(segment => (
                    Number(segment?.sequence) === numericSequence
                        ? {
                            ...segment,
                            status: 'failed',
                            bytes: null,
                            errorMessage: failureMessage
                        }
                        : segment
            ))
                : task.segments,
            errorMessage: failureMessage
        }));

        if (typeof showToast === 'function') {
            showToast(`第 ${numericSequence} 片重试失败`, { type: 'error' });
        }
        return updatedTask;
    } finally {
        if (typeof endStandaloneTaskRequestScope === 'function') {
            endStandaloneTaskRequestScope(taskId);
        }
    }
}

function loadDefaultTaskParams() {
    try {
        const rawValue = localStorage.getItem(DEFAULT_TASK_PARAMS_STORAGE_KEY);
        if (!rawValue) return { ...DEFAULT_TASK_PARAMS };
        const parsed = JSON.parse(rawValue);
        return {
            titleTemplate: typeof parsed.titleTemplate === 'string' && parsed.titleTemplate.trim()
                ? parsed.titleTemplate
                : DEFAULT_TASK_PARAMS.titleTemplate,
            format: parsed.format === 'mp4' ? 'mp4' : DEFAULT_TASK_PARAMS.format,
            streamSave: typeof parsed.streamSave === 'boolean'
                ? parsed.streamSave
                : DEFAULT_TASK_PARAMS.streamSave,
            segmentCache: typeof parsed.segmentCache === 'boolean'
                ? parsed.segmentCache
                : DEFAULT_TASK_PARAMS.segmentCache,
            concurrency: normalizeConcurrency(parsed.concurrency),
            downloadRangeMode: parsed.downloadRangeMode === 'custom' ? 'custom' : DEFAULT_TASK_PARAMS.downloadRangeMode
        };
    } catch {
        return { ...DEFAULT_TASK_PARAMS };
    }
}

function saveDefaultTaskParams(params) {
    localStorage.setItem(DEFAULT_TASK_PARAMS_STORAGE_KEY, JSON.stringify({
        ...params,
        concurrency: normalizeConcurrency(params.concurrency)
    }));
}

function getRequiredElement(id) {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing required element: ${id}`);
    }
    return element;
}

function getSettingsFormElements() {
    return {
        titleTemplate: getRequiredElement('setting-title-tpl'),
        format: getRequiredElement('setting-format'),
        streamSave: getRequiredElement('setting-stream-save'),
        segmentCache: getRequiredElement('setting-segment-cache'),
        concurrency: getRequiredElement('setting-concurrency')
    };
}

function getNewTaskFormElements() {
    return {
        url: getRequiredElement('new-url'),
        title: getRequiredElement('new-title'),
        streamSave: getRequiredElement('new-stream-save'),
        concurrency: getRequiredElement('new-concurrency')
    };
}

function applyDefaultTaskParamsToSettingsForm() {
    const form = getSettingsFormElements();
    form.titleTemplate.value = defaultTaskParams.titleTemplate;
    form.format.value = defaultTaskParams.format;
    form.streamSave.checked = defaultTaskParams.streamSave;
    form.segmentCache.checked = defaultTaskParams.segmentCache !== false;
    form.concurrency.value = String(defaultTaskParams.concurrency);
}

function applyDefaultTaskParamsToNewTaskForm() {
    const form = getNewTaskFormElements();
    setSelectedNewTaskFormat(defaultTaskParams.format);
    form.streamSave.checked = defaultTaskParams.streamSave;
    form.concurrency.value = String(defaultTaskParams.concurrency);
    setSelectedNewTaskRangeMode(defaultTaskParams.downloadRangeMode);
    syncNewTaskRangeModeUI();
}

function resetNewTaskFormToDefaults() {
    const form = getNewTaskFormElements();
    form.url.value = '';
    form.title.value = '';
    clearNewUrlError();
    applyDefaultTaskParamsToNewTaskForm();
    setNewTaskCreateBusy(false);
}

function getSettingsFormValues() {
    const form = getSettingsFormElements();
    return {
        titleTemplate: form.titleTemplate.value.trim() || DEFAULT_TASK_PARAMS.titleTemplate,
        format: form.format.value,
        streamSave: form.streamSave.checked,
        segmentCache: form.segmentCache.checked,
        concurrency: normalizeConcurrency(form.concurrency.value),
        downloadRangeMode: defaultTaskParams.downloadRangeMode
    };
}

function getNewTaskFormValues() {
    const form = getNewTaskFormElements();
    return {
        url: form.url.value.trim(),
        title: form.title.value.trim(),
        format: getSelectedNewTaskFormat(),
        streamSave: form.streamSave.checked,
        concurrency: normalizeConcurrency(form.concurrency.value),
        downloadRangeMode: getSelectedNewTaskRangeMode()
    };
}

function getValidatedNewTaskDraft() {
    const taskDraft = getNewTaskFormValues();
    if (!taskDraft.url) {
        showNewUrlError();
        return null;
    }

    clearNewUrlError();
    return taskDraft;
}

function normalizeConcurrency(value) {
    const numericValue = Number.parseInt(value, 10);
    if (Number.isNaN(numericValue)) return DEFAULT_TASK_PARAMS.concurrency;
    return Math.min(8, Math.max(1, numericValue));
}

function getSelectedNewTaskRangeMode() {
    return document.getElementById('new-range-mode-custom')?.checked ? 'custom' : 'all';
}

function getSelectedNewTaskFormat() {
    const selectedControl = document.querySelector('input[name="new-format"]:checked');
    return selectedControl?.value === 'mp4' ? 'mp4' : 'ts';
}

function setSelectedNewTaskFormat(format) {
    const normalizedFormat = format === 'mp4' ? 'mp4' : 'ts';
    document.querySelectorAll('input[name="new-format"]').forEach(control => {
        control.checked = control.value === normalizedFormat;
    });
}

function setSelectedNewTaskRangeMode(mode) {
    const normalizedMode = mode === 'custom' ? 'custom' : 'all';
    const allControl = document.getElementById('new-range-mode-all');
    const customControl = document.getElementById('new-range-mode-custom');
    if (!allControl || !customControl) return;

    allControl.checked = normalizedMode === 'all';
    customControl.checked = normalizedMode === 'custom';
}

function syncNewTaskRangeModeUI() {
    return getSelectedNewTaskRangeMode();
}

function applyTitleTemplate(url, template, taskId) {
    const urlName = url.split('/').pop() || 'video';
    return template
        .replaceAll('{id}', taskId)
        .replaceAll('{name}', urlName);
}

function showNewUrlError() {
    const urlField = document.getElementById('new-url')?.closest('.form-item');
    const errorNode = document.getElementById('new-url-error');
    if (!urlField || !errorNode) return;

    urlField.classList.add('has-error');
    errorNode.classList.remove('hidden');
}

function clearNewUrlError() {
    const urlField = document.getElementById('new-url')?.closest('.form-item');
    const errorNode = document.getElementById('new-url-error');
    if (!urlField || !errorNode) return;

    urlField.classList.remove('has-error');
    errorNode.classList.add('hidden');
}

async function deleteTask(id) {
    const task = findTaskById(id);
    if (!task) return false;
    if (!await confirmTaskDeletion([task])) return false;
    return removeTasksById([id]);
}

function toggleTaskPausedState(id) {
    const task = findTaskById(id);
    if (!task || task.status === 'completed') return;

    if (task.status === 'await_range_selection') {
        openDownloadRangeModal(id);
        return;
    }

    if (task.status === 'paused') {
        resumeTask(id);
        return;
    }

    if (['failed', 'recoverable', 'partial_completed'].includes(task.status)) {
        restartTaskFromIncompleteSegments(id);
        return;
    }

    pauseTask(id);
}

function playTask(id) {
    const task = currentTasks.find(item => item.id === id);
    if (!task) return;

    return requestTaskPreview(task);
}

function copyTaskUrl(id) {
    const task = currentTasks.find(item => String(item.id) === String(id));
    const taskUrl = String(task?.url ?? '').trim();
    if (!taskUrl) return;

    if (globalThis.navigator?.clipboard?.writeText) {
        globalThis.navigator.clipboard.writeText(taskUrl).catch(() => {});
    }

    showTaskUrlCopiedFeedback(id);
    showToast('链接已复制', { type: 'success' });
}

function handleTaskUrlKeydown(event, id) {
    if (!event || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    copyTaskUrl(id);
}

function showTaskUrlCopiedFeedback(id) {
    const normalizedId = String(id);
    if (activeCopiedTaskUrlId && activeCopiedTaskUrlId !== normalizedId) {
        resetTaskUrlCopiedFeedback(activeCopiedTaskUrlId);
    }

    activeCopiedTaskUrlId = normalizedId;
    getTaskUrlCopyFeedbackTargets(normalizedId).forEach(taskUrlButton => {
        taskUrlButton.classList.add('is-copied');
        const iconContainer = taskUrlButton.querySelector('.task-row__url-icon, .task-fragment-detail__url-icon');
        if (iconContainer instanceof HTMLElement) {
            iconContainer.innerHTML = '<i data-lucide="check" aria-hidden="true"></i>';
            if (window.lucide) lucide.createIcons();
        }
    });

    if (copiedTaskUrlFeedbackTimeoutId) {
        clearTimeout(copiedTaskUrlFeedbackTimeoutId);
    }
    copiedTaskUrlFeedbackTimeoutId = setTimeout(() => {
        resetTaskUrlCopiedFeedback(normalizedId);
    }, 1200);
}

function resetTaskUrlCopiedFeedback(id) {
    const normalizedId = String(id);
    getTaskUrlCopyFeedbackTargets(normalizedId).forEach(taskUrlButton => {
        taskUrlButton.classList.remove('is-copied');
        const iconContainer = taskUrlButton.querySelector('.task-row__url-icon, .task-fragment-detail__url-icon');
        if (iconContainer instanceof HTMLElement) {
            iconContainer.innerHTML = '<i data-lucide="copy" aria-hidden="true"></i>';
            if (window.lucide) lucide.createIcons();
        }
    });

    if (activeCopiedTaskUrlId === normalizedId) {
        activeCopiedTaskUrlId = null;
    }
    copiedTaskUrlFeedbackTimeoutId = null;
}

function getTaskUrlCopyFeedbackTargets(id) {
    return [
        document.getElementById(getTaskUrlButtonId(id)),
        document.getElementById(getTaskDetailUrlButtonId(id))
    ].filter(target => target instanceof HTMLElement);
}

function showToast(message, options = {}) {
    const { type = 'info', duration = 2200 } = options;
    const toast = document.createElement('div');
    toast.className = `app-toast is-${type}`;
    // Surface shadows are standardized in CSS with box-shadow: var(--shadow-surface).
    toast.textContent = message;
    document.body.appendChild(toast);

    window.requestAnimationFrame(() => {
        toast.classList.add('is-visible');
    });

    setTimeout(() => {
        toast.classList.remove('is-visible');
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 260);
    }, duration);
}

// Start App
document.addEventListener('DOMContentLoaded', init);
if (typeof window.addEventListener === 'function') {
    window.addEventListener('load', hideAppLoaderAfterDebugDelay);
}
