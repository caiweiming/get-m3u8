(function (global) {
    'use strict';

    let fallbackIdSequence = 0;

    function createTaskId(cryptoLike) {
        const cryptoSource = cryptoLike || global.crypto;
        if (cryptoSource && typeof cryptoSource.randomUUID === 'function') {
            return cryptoSource.randomUUID();
        }

        fallbackIdSequence += 1;
        return `task-${Date.now().toString(36)}-${fallbackIdSequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
    }

    function normalizeSourceUrl(source) {
        const value = String(source || '').trim();
        if (!value) return '';

        try {
            return new URL(value).toString();
        } catch (_) {
            return value;
        }
    }

    function normalizeValue(value) {
        if (Array.isArray(value)) {
            return value.map(normalizeValue).sort(compareValues);
        }

        if (value && typeof value === 'object') {
            return Object.keys(value).sort().reduce((normalized, key) => {
                normalized[key] = normalizeValue(value[key]);
                return normalized;
            }, {});
        }

        return value == null ? '' : value;
    }

    function compareValues(left, right) {
        return JSON.stringify(left).localeCompare(JSON.stringify(right));
    }

    function createTaskFingerprint(task) {
        const value = task || {};
        const renditions = value.renditions || value.selectedRenditions || {
            audio: value.selectedAudioRenditionIds || value.selectedAudioRenditionId || '',
            subtitles: value.selectedSubtitleRenditionIds || value.selectedSubtitleRenditionId || ''
        };
        const range = value.range || {
            mode: value.rangeMode || value.downloadRangeMode || '',
            start: value.rangeStart ?? value.actualRangeStart ?? '',
            end: value.rangeEnd ?? value.actualRangeEnd ?? ''
        };

        return JSON.stringify({
            source: normalizeSourceUrl(value.source || value.url || value.sourceUrl),
            quality: normalizeValue(value.quality || value.qualityId || value.selectedQualityId || ''),
            range: normalizeValue(range),
            format: normalizeValue(value.format || ''),
            renditions: normalizeValue(renditions),
            saveMode: normalizeValue(value.saveMode == null ? Boolean(value.streamSave) : value.saveMode)
        });
    }

    function isRunnableQueueCandidate(task, runningTaskIds) {
        if (!task || !task.id || runningTaskIds.has(String(task.id))) return false;
        const status = String(task.status || 'queued');
        return status === 'queued';
    }

    function queueOrderFor(task) {
        const value = Number(task.queueOrder);
        return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
    }

    function createdAtFor(task) {
        const value = Number(task.createdAt);
        return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
    }

    function compareQueueCandidates(left, right) {
        return queueOrderFor(left) - queueOrderFor(right)
            || createdAtFor(left) - createdAtFor(right)
            || String(left.id).localeCompare(String(right.id));
    }

    function selectRunnableTaskIds(tasks, options) {
        const settings = options || {};
        const runningTaskIds = new Set(Array.from(settings.runningTaskIds || [], String));
        const runningCount = runningTaskIds.size;
        const taskLimit = settings.parallelEnabled === true ? 3 : 1;
        const availableSlots = Math.max(0, taskLimit - runningCount);

        return (Array.isArray(tasks) ? tasks : [])
            .filter(task => isRunnableQueueCandidate(task, runningTaskIds))
            .sort(compareQueueCandidates)
            .slice(0, availableSlots)
            .map(task => String(task.id));
    }

    const DATABASE_NAME = 'm3u8-downloader-segment-cache';
    const DATABASE_VERSION = 2;
    const LEGACY_TASKS_KEY = 'm3u8-downloader-tasks';
    const STORES = Object.freeze({ tasks: 'tasks', intents: 'task-intents', metadata: 'coordination-metadata' });
    const databaseConnections = new WeakMap();

    function openDatabase(indexedDBSource) {
        const source = indexedDBSource || global.indexedDB;
        if (!source || typeof source.open !== 'function') {
            return Promise.reject(new Error('IndexedDB is unavailable'));
        }
        if (databaseConnections.has(source)) return databaseConnections.get(source);

        const pending = new Promise((resolve, reject) => {
            const request = source.open(DATABASE_NAME, DATABASE_VERSION);
            let failed = false;
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('segments')) db.createObjectStore('segments', { keyPath: 'id' });
                if (!db.objectStoreNames.contains(STORES.tasks)) db.createObjectStore(STORES.tasks, { keyPath: 'id' });
                if (!db.objectStoreNames.contains(STORES.intents)) db.createObjectStore(STORES.intents, { keyPath: 'sequence', autoIncrement: true });
                if (!db.objectStoreNames.contains(STORES.metadata)) db.createObjectStore(STORES.metadata, { keyPath: 'key' });
            };
            request.onsuccess = () => {
                const db = request.result;
                if (failed) {
                    db.close();
                    return;
                }
                db.onversionchange = () => {
                    db.close();
                    databaseConnections.delete(source);
                };
                resolve(db);
            };
            request.onerror = () => reject(request.error || new Error('Unable to open task database'));
            request.onblocked = () => {
                failed = true;
                reject(new Error('Task database upgrade is blocked by another page'));
            };
        });
        databaseConnections.set(source, pending);
        pending.catch(() => {
            if (databaseConnections.get(source) === pending) databaseConnections.delete(source);
        });
        return pending;
    }

    function createIndexedDBTransactionAdapter(indexedDBSource) {
        const requestResult = request => new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Task database request failed'));
        });
        return {
            async transaction(names, mode, operation) {
                const db = await openDatabase(indexedDBSource);
                return new Promise((resolve, reject) => {
                    const transaction = db.transaction(names, mode);
                    let result;
                    let operationError;
                    transaction.oncomplete = () => resolve(result);
                    transaction.onabort = () => reject(operationError || transaction.error || new Error('Task database transaction aborted'));
                    transaction.onerror = () => { /* The abort event reports the failed transaction. */ };
                    // Operations only await requests belonging to this transaction. External awaits
                    // would allow IndexedDB to auto-commit before the next dependent request.
                    const tx = {
                        get: (name, key) => requestResult(transaction.objectStore(name).get(key)),
                        getAll: name => requestResult(transaction.objectStore(name).getAll()),
                        put: (name, record) => requestResult(transaction.objectStore(name).put(record)),
                        delete: (name, key) => requestResult(transaction.objectStore(name).delete(key))
                    };
                    Promise.resolve().then(() => operation(tx)).then(value => {
                        result = value;
                    }).catch(error => {
                        operationError = error;
                        try { transaction.abort(); } catch (_) { reject(error); }
                    });
                });
            }
        };
    }

    function createTaskRepository(options) {
        const settings = options || {};
        const adapter = settings.transactionAdapter || createIndexedDBTransactionAdapter(settings.indexedDB || global.indexedDB);
        const storage = settings.localStorage;
        const now = settings.now || Date.now;
        const normalizeTask = settings.normalizeTask || (task => ({ ...task }));
        const success = (value, extra) => ({ ok: true, stale: false, value, ...extra });
        const rejected = (reason, value, stale = false) => ({ ok: false, stale, value: value == null ? null : value, reason });
        const emptyCoordinator = () => ({ ownerPageId: null, executionEpoch: 0, expiresAt: 0 });
        const readCoordinator = async tx => (await tx.get(STORES.metadata, 'coordinator')) || emptyCoordinator();
        const writeCoordinator = (tx, value) => tx.put(STORES.metadata, { key: 'coordinator', ...value });
        const readTaskRevision = async tx => Number((await tx.get(STORES.metadata, 'task-revision'))?.value) || 0;
        const advanceTaskRevision = async tx => {
            const value = await readTaskRevision(tx) + 1;
            await tx.put(STORES.metadata, { key: 'task-revision', value });
            return value;
        };
        const hasAuthority = (coordinator, epoch) => Boolean(coordinator.ownerPageId)
            && coordinator.executionEpoch === epoch && coordinator.expiresAt > now();
        const unfinished = task => task.status !== 'completed';
        const fingerprintFor = task => createTaskFingerprint(task);
        const unresolved = task => task.playlistType !== 'media'
            || ['await_variant_selection', 'await_range_selection'].includes(task.status);
        const findDuplicate = (tasks, task) => tasks.find(existing => existing.id !== task.id
            && !existing.deleting && unfinished(existing) && unfinished(task)
            && ((unresolved(existing) || unresolved(task)) && existing.creationFingerprintInputs && task.creationFingerprintInputs
                ? createTaskFingerprint(existing.creationFingerprintInputs) === createTaskFingerprint(task.creationFingerprintInputs)
                : fingerprintFor(existing) === fingerprintFor(task)));
        const fenced = (names, epoch, operation) => adapter.transaction(
            Array.from(new Set([STORES.metadata, ...names])), 'readwrite', async tx => {
                const coordinator = await readCoordinator(tx);
                if (!hasAuthority(coordinator, epoch)) return rejected('stale-epoch', coordinator, true);
                return operation(tx);
            }
        );

        async function initialize() {
            const legacyValue = storage ? storage.getItem(LEGACY_TASKS_KEY) : null;
            const result = await adapter.transaction([STORES.tasks, STORES.metadata], 'readwrite', async tx => {
                const previous = await tx.get(STORES.metadata, 'migration');
                if (previous && previous.completed) return { migrated: false, marker: previous, taskRevision: await readTaskRevision(tx) };
                const legacyTasks = legacyValue ? JSON.parse(legacyValue) : [];
                if (!Array.isArray(legacyTasks)) throw new TypeError('Legacy tasks must be an array');
                const existing = await tx.getAll(STORES.tasks);
                const queueMetadata = await tx.get(STORES.metadata, 'queue-sequence');
                let queueSequence = Math.max(Number(queueMetadata?.value) || 0,
                    ...existing.map(task => Number(task.queueOrder) || 0));
                const normalized = legacyTasks.map(task => normalizeTask(task)).filter(task => task && typeof task === 'object');
                queueSequence = Math.max(queueSequence, ...normalized.map(task => Number(task.queueOrder) || 0));
                for (const task of existing) {
                    if (!(Number(task.queueOrder) > 0) || !(Number(task.version) >= 1)) {
                        task.queueOrder = Number(task.queueOrder) > 0 ? Number(task.queueOrder) : ++queueSequence;
                        task.version = Math.max(1, Number(task.version) || 1);
                        await tx.put(STORES.tasks, task);
                    }
                }
                for (const rawTask of normalized) {
                    const task = { ...rawTask, id: String(rawTask.id || createTaskId()) };
                    if (existing.some(record => record.id === task.id) || findDuplicate(existing, task)) continue;
                    task.queueOrder = Number(task.queueOrder) > 0 ? Number(task.queueOrder) : ++queueSequence;
                    task.version = Math.max(1, Number(task.version) || 1);
                    task.createdAt = Number(task.createdAt) || now();
                    task.fingerprint = fingerprintFor(task);
                    await tx.put(STORES.tasks, task);
                    existing.push(task);
                }
                await tx.put(STORES.metadata, { key: 'queue-sequence', value: queueSequence });
                if (!await tx.get(STORES.metadata, 'settings')) {
                    await tx.put(STORES.metadata, { key: 'settings', parallelTaskDownloads: false });
                }
                const marker = { key: 'migration', completed: true, completedAt: now() };
                await tx.put(STORES.metadata, marker);
                return { migrated: true, marker, taskRevision: await advanceTaskRevision(tx) };
            });
            // A changed legacy value belongs to a still-open old page. Keep it so
            // runtime conflict detection can suspend execution rather than hide it.
            if (result.migrated && legacyValue !== null && storage.getItem(LEGACY_TASKS_KEY) === legacyValue) {
                storage.removeItem(LEGACY_TASKS_KEY);
            }
            return success(result.marker, { taskRevision: result.taskRevision });
        }

        async function readSnapshot() {
            return adapter.transaction([STORES.tasks, STORES.metadata], 'readonly', async tx => ({
                tasks: (await tx.getAll(STORES.tasks)).sort(compareQueueCandidates),
                taskRevision: await readTaskRevision(tx),
                settings: (await tx.get(STORES.metadata, 'settings')) || { parallelTaskDownloads: false },
                coordinator: await readCoordinator(tx),
                migration: (await tx.get(STORES.metadata, 'migration')) || null
            }));
        }

        async function setSettings(input, executionEpoch) {
            return fenced([], executionEpoch, async tx => {
                const current = (await tx.get(STORES.metadata, 'settings')) || { key: 'settings', parallelTaskDownloads: false };
                const updated = { ...current, key: 'settings', parallelTaskDownloads: input?.parallelTaskDownloads === true };
                await tx.put(STORES.metadata, updated);
                return success(updated, { taskRevision: await readTaskRevision(tx) });
            });
        }

        async function putTask(input, executionEpoch) {
            return fenced([STORES.tasks], executionEpoch, async tx => {
                const normalized = normalizeTask(input);
                if (!normalized || typeof normalized !== 'object') return rejected('invalid-task');
                const task = { ...normalized, id: String(normalized.id || input.id || createTaskId()) };
                const existing = await tx.get(STORES.tasks, task.id);
                if (existing?.deleting) return rejected('task-deleting', existing);
                const expectedVersion = input.expectedVersion ?? input.version;
                if (expectedVersion != null && (!existing || expectedVersion !== existing.version)) {
                    return rejected('version-conflict', existing);
                }
                if (!existing) {
                    const duplicate = findDuplicate(await tx.getAll(STORES.tasks), task);
                    if (duplicate) return success(duplicate, { duplicate: true, taskRevision: await readTaskRevision(tx) });
                    const queue = await tx.get(STORES.metadata, 'queue-sequence');
                    task.queueOrder = (Number(queue?.value) || 0) + 1;
                    await tx.put(STORES.metadata, { key: 'queue-sequence', value: task.queueOrder });
                } else {
                    task.queueOrder = existing.queueOrder;
                }
                task.version = (Number(existing?.version) || 0) + 1;
                task.createdAt = existing?.createdAt || Number(task.createdAt) || now();
                task.updatedAt = now();
                task.fingerprint = fingerprintFor(task);
                task.contentFingerprint = task.fingerprint;
                await tx.put(STORES.tasks, task);
                return success(task, { taskRevision: await advanceTaskRevision(tx) });
            });
        }

        async function appendIntent(intent) {
            return adapter.transaction([STORES.intents, STORES.metadata], 'readwrite', async tx => {
                const previous = await tx.get(STORES.metadata, 'intent-version');
                const record = {
                    ...intent,
                    id: String(intent.id || createTaskId()),
                    version: (Number(previous?.value) || 0) + 1,
                    status: 'pending',
                    createdAt: now(),
                    claimedEpoch: null
                };
                delete record.sequence;
                record.sequence = await tx.put(STORES.intents, record);
                await tx.put(STORES.metadata, { key: 'intent-version', value: record.version });
                return success(record);
            });
        }

        async function claimIntents(executionEpoch) {
            return fenced([STORES.intents], executionEpoch, async tx => {
                const records = (await tx.getAll(STORES.intents)).sort((left, right) => left.sequence - right.sequence);
                const claimed = [];
                for (const record of records) {
                    if (['completed', 'failed'].includes(record.status) || (record.status === 'claimed' && record.claimedEpoch === executionEpoch)) continue;
                    const intent = { ...record, status: 'claimed', claimedEpoch: executionEpoch };
                    await tx.put(STORES.intents, intent);
                    claimed.push(intent);
                }
                return success(claimed);
            });
        }

        async function readIntent(id) {
            return adapter.transaction([STORES.intents], 'readonly', async tx => (
                (await tx.getAll(STORES.intents)).find(record => record.id === id || record.sequence === id) || null
            ));
        }

        async function completeIntent(id, executionEpoch, result) {
            return fenced([STORES.intents], executionEpoch, async tx => {
                const intent = (await tx.getAll(STORES.intents)).find(record => record.id === id || record.sequence === id);
                if (!intent) return rejected('intent-not-found');
                if (['completed', 'failed'].includes(intent.status)) return success(intent);
                if (intent.status !== 'claimed' || intent.claimedEpoch !== executionEpoch) return rejected('intent-not-claimed', intent);
                const completed = { ...intent, status: result?.ok === false ? 'failed' : 'completed',
                    result: result ?? { ok: true }, completedAt: now() };
                // Handles and user input are only needed while an intent is pending.
                delete completed.payload;
                await tx.put(STORES.intents, completed);
                return success(completed);
            });
        }

        async function markTaskDeleting(taskId, executionEpoch) {
            return fenced([STORES.tasks], executionEpoch, async tx => {
                const task = await tx.get(STORES.tasks, String(taskId));
                if (!task) return rejected('task-not-found');
                if (task.deleting) return success(task, { taskRevision: await readTaskRevision(tx) });
                const marked = { ...task, deleting: true, status: 'deleting', version: task.version + 1, updatedAt: now() };
                await tx.put(STORES.tasks, marked);
                return success(marked, { taskRevision: await advanceTaskRevision(tx) });
            });
        }

        async function deleteTask(taskId, executionEpoch) {
            return fenced([STORES.tasks], executionEpoch, async tx => {
                const task = await tx.get(STORES.tasks, String(taskId));
                if (!task) return success(null, { taskRevision: await readTaskRevision(tx) });
                if (!task.deleting) return rejected('task-not-deleting', task);
                await tx.delete(STORES.tasks, task.id);
                return success(task, { taskRevision: await advanceTaskRevision(tx) });
            });
        }

        async function acquireLease(pageId, ttlMs) {
            return adapter.transaction([STORES.metadata], 'readwrite', async tx => {
                if (!pageId || !Number.isFinite(Number(ttlMs)) || !(Number(ttlMs) > 0)) return rejected('invalid-lease');
                const previous = await readCoordinator(tx);
                const active = previous.ownerPageId && previous.expiresAt > now();
                if (active && previous.ownerPageId !== pageId) return rejected('lease-owned', previous);
                const lease = {
                    ownerPageId: pageId,
                    executionEpoch: active ? previous.executionEpoch : previous.executionEpoch + 1,
                    expiresAt: now() + Number(ttlMs)
                };
                await writeCoordinator(tx, lease);
                return success(lease, { executionEpoch: lease.executionEpoch });
            });
        }

        async function renewLease(pageId, executionEpoch, ttlMs) {
            return fenced([], executionEpoch, async tx => {
                const lease = await readCoordinator(tx);
                if (lease.ownerPageId !== pageId) return rejected('lease-owned', lease);
                if (!Number.isFinite(Number(ttlMs)) || !(Number(ttlMs) > 0)) return rejected('invalid-lease', lease);
                const renewed = { ...lease, expiresAt: now() + Number(ttlMs) };
                await writeCoordinator(tx, renewed);
                return success(renewed, { executionEpoch });
            });
        }

        async function releaseLease(pageId, executionEpoch) {
            return fenced([], executionEpoch, async tx => {
                const lease = await readCoordinator(tx);
                if (lease.ownerPageId !== pageId) return rejected('lease-owned', lease);
                const released = { ...lease, ownerPageId: null, expiresAt: 0 };
                await writeCoordinator(tx, released);
                return success(released, { executionEpoch });
            });
        }

        return Object.freeze({ initialize, readSnapshot, readIntent, putTask, setSettings, appendIntent, claimIntents, completeIntent,
            markTaskDeleting, deleteTask, acquireLease, renewLease, releaseLease });
    }

    function createCoordinatorRuntime(options) {
        const settings = options || {};
        const repository = settings.repository;
        const pageId = settings.pageId || createTaskId();
        const browserNavigator = settings.navigator === undefined ? global.navigator : settings.navigator;
        const locks = browserNavigator?.locks;
        const usesWebLocks = Boolean(locks && typeof locks.request === 'function');
        const Channel = settings.BroadcastChannel === undefined ? global.BroadcastChannel : settings.BroadcastChannel;
        const eventTarget = settings.eventTarget || global;
        const now = settings.now || Date.now;
        const schedule = settings.setTimeout || global.setTimeout.bind(global);
        const cancel = settings.clearTimeout || global.clearTimeout.bind(global);
        const ttlMs = Number(settings.takeoverMs) > 0 && Number.isFinite(Number(settings.takeoverMs))
            ? Number(settings.takeoverMs) : 3000;
        const pollMs = Math.min(1000, ttlMs / 3);
        let storage;
        try { storage = settings.localStorage === undefined ? global.localStorage : settings.localStorage; } catch (_) { /* Storage may be disabled. */ }

        let active = false;
        let available = false;
        let unsafeLegacyWriter = false;
        let migrated = false;
        let generation = 0;
        let starting = null;
        let stopping = null;
        let lease = null;
        let ownershipToken = null;
        let observed = { ownerPageId: null, executionEpoch: 0, expiresAt: 0 };
        let lastRole = '';
        let channel = null;
        let heartbeatTimer = null;
        let expiryTimer = null;
        let releaseWebLock = null;
        let refreshing = null;
        let refreshAgain = false;
        let draining = null;
        const intentChains = new Map();
        const intentControls = new Map();

        const current = run => active && generation === run;
        const rejected = (reason, stale = false) => ({ ok: false, stale, value: null, reason });

        function callObserver(callback, value) {
            try { callback?.(value); } catch (error) { global.console?.error('Task coordination observer failed', error); }
        }

        function reportRole() {
            const role = {
                isCoordinator: Boolean(active && available && lease && lease.expiresAt > now()),
                executionEpoch: lease?.executionEpoch ?? observed.executionEpoch,
                coordinationAvailable: available && !unsafeLegacyWriter,
                unsafeLegacyWriter,
                ownerPageId: observed.ownerPageId
            };
            const serialized = JSON.stringify(role);
            if (serialized !== lastRole) {
                lastRole = serialized;
                callObserver(settings.onRoleChange, role);
            }
        }

        function broadcast() {
            try { channel?.postMessage({ type: 'changed' }); } catch (_) { /* Polling recovers missing notifications. */ }
        }

        function relinquish() {
            const previous = lease;
            lease = null;
            ownershipToken = null;
            if (expiryTimer !== null) cancel(expiryTimer);
            expiryTimer = null;
            if (releaseWebLock) releaseWebLock();
            releaseWebLock = null;
            reportRole();
            return previous;
        }

        function disable() {
            available = false;
            const previous = relinquish();
            if (heartbeatTimer !== null) cancel(heartbeatTimer);
            heartbeatTimer = null;
            if (previous) {
                Promise.resolve(repository.releaseLease(pageId, previous.executionEpoch))
                    .then(broadcast, () => {});
            }
        }

        function suspendLegacyWriter() {
            if (unsafeLegacyWriter) return;
            unsafeLegacyWriter = true;
            disable();
            callObserver(settings.onUnsafeLegacyWriter, { key: LEGACY_TASKS_KEY });
            broadcast();
        }

        function checkLegacyWriter() {
            if (migrated && storage && storage.getItem(LEGACY_TASKS_KEY) !== null) suspendLegacyWriter();
            return unsafeLegacyWriter;
        }

        function hasAuthority() {
            if (lease && (lease.expiresAt <= now() || !ownershipToken || (usesWebLocks && !releaseWebLock))) relinquish();
            return Boolean(active && available && !unsafeLegacyWriter && lease);
        }

        function acceptLease(value, run) {
            lease = value;
            observed = value;
            if (expiryTimer !== null) cancel(expiryTimer);
            expiryTimer = schedule(() => {
                expiryTimer = null;
                if (current(run)) hasAuthority();
            }, Math.max(0, value.expiresAt - now()));
            reportRole();
        }

        async function obtainWebLock(run) {
            if (!usesWebLocks || releaseWebLock) return true;
            let decide;
            const decision = new Promise(resolve => { decide = resolve; });
            try {
                const request = locks.request('m3u8-downloader-coordinator', { mode: 'exclusive', ifAvailable: true }, lock => {
                    if (!lock || !current(run) || !available) {
                        decide(false);
                        return;
                    }
                    const held = new Promise(resolve => { releaseWebLock = resolve; });
                    decide(true);
                    return held;
                });
                Promise.resolve(request).catch(() => {
                    decide(false);
                    if (current(run)) disable();
                });
            } catch (_) {
                decide(false);
                if (current(run)) disable();
            }
            return decision;
        }

        function inspectMutation(result, run) {
            if (current(run) && result?.stale) {
                if (result.value?.executionEpoch != null) observed = result.value;
                relinquish();
            }
            return result;
        }

        // User callbacks may run downloads for a long time. Keep this queue independent
        // of heartbeat/reload work, and bind every claimed batch to its original epoch.
        function drainIntents(run) {
            if (draining || !hasAuthority() || typeof settings.onIntent !== 'function') return;
            const epoch = lease.executionEpoch;
            const stillOwner = () => current(run) && hasAuthority() && lease.executionEpoch === epoch;
            const pending = (async () => {
                while (stillOwner()) {
                    const claimed = inspectMutation(await repository.claimIntents(epoch), run);
                    if (!claimed.ok || !stillOwner() || !claimed.value.length) return;
                    for (const intent of claimed.value) {
                        if (!stillOwner()) return;
                        const key = `${run}:${epoch}:${intent.taskId || 'global-cache'}`;
                        const control = intentControls.get(key) || { version: 0 };
                        if (intent.type === 'pause' || intent.type === 'delete') control.version += 1;
                        intentControls.set(key, control);
                        const controlVersion = control.version;
                        const previous = intentChains.get(key) || Promise.resolve();
                        const operation = previous.then(async () => {
                            if (!stillOwner()) return;
                            // Each task is ordered independently. The claim loop and
                            // other task chains keep progressing during long I/O.
                            const result = await settings.onIntent(intent, {
                                executionEpoch: epoch,
                                isCancelled: () => control.version !== controlVersion
                            });
                            if (!stillOwner()) return;
                            const completed = inspectMutation(await repository.completeIntent(intent.id, epoch, result), run);
                            if (completed.ok) notifyChanged();
                        }).catch(error => {
                            // Unexpected failures stay claimed for epoch recovery.
                            global.console?.error('Task coordination intent failed', error);
                        }).finally(() => {
                            if (intentChains.get(key) === operation) {
                                intentChains.delete(key);
                                intentControls.delete(key);
                            }
                        });
                        intentChains.set(key, operation);
                    }
                }
            })().catch(() => { if (current(run)) disable(); }).finally(() => {
                if (draining === pending) draining = null;
            });
            draining = pending;
        }

        async function refresh(run) {
            const snapshot = await repository.readSnapshot();
            if (!current(run) || !available) return;
            observed = snapshot.coordinator;
            migrated = Boolean(snapshot.migration?.completed);
            if (checkLegacyWriter()) return;
            if (lease && (observed.ownerPageId !== pageId || observed.executionEpoch !== lease.executionEpoch
                || observed.expiresAt <= now())) relinquish();

            let ownershipChanged = false;
            if (hasAuthority()) {
                const renewingOwnership = ownershipToken;
                const renewed = await repository.renewLease(pageId, lease.executionEpoch, ttlMs);
                // A committed renewal can resolve after expiry has revoked this holding
                // period. Its result cannot recreate authority or restore a released lock.
                if (!current(run) || !available || ownershipToken !== renewingOwnership
                    || (usesWebLocks && !releaseWebLock)) return;
                if (renewed.ok) acceptLease(renewed.value, run);
                else {
                    if (renewed.value?.executionEpoch != null) observed = renewed.value;
                    relinquish();
                }
            } else if (!observed.ownerPageId || observed.expiresAt <= now() || observed.ownerPageId === pageId) {
                if (await obtainWebLock(run)) {
                    if (!current(run) || !available) return;
                    const acquired = await repository.acquireLease(pageId, ttlMs);
                    if (!current(run) || !available) {
                        if (acquired.ok) await repository.releaseLease(pageId, acquired.executionEpoch);
                        return;
                    }
                    if (acquired.ok) {
                        ownershipToken = {};
                        acceptLease(acquired.value, run);
                        ownershipChanged = true;
                    } else {
                        if (acquired.value?.executionEpoch != null) observed = acquired.value;
                        relinquish();
                    }
                }
            }
            if (!current(run) || !available) return;
            reportRole();
            callObserver(settings.onSnapshot, { ...snapshot, coordinator: { ...observed } });
            if (ownershipChanged) broadcast();
            drainIntents(run);
        }

        function requestRefresh() {
            if (!active || !available) return Promise.resolve();
            refreshAgain = true;
            if (refreshing) return refreshing;
            const run = generation;
            const pending = (async () => {
                while (current(run) && available && refreshAgain) {
                    refreshAgain = false;
                    await refresh(run);
                }
            })().catch(() => { if (current(run)) disable(); }).finally(() => {
                if (refreshing === pending) refreshing = null;
            });
            refreshing = pending;
            return pending;
        }

        function heartbeat(run) {
            heartbeatTimer = schedule(() => {
                heartbeatTimer = null;
                if (!current(run) || !available) return;
                heartbeat(run);
                void requestRefresh();
            }, pollMs);
        }

        function onStorage(event) {
            if (migrated && event.key === LEGACY_TASKS_KEY && event.newValue !== null
                && (!event.storageArea || !storage || event.storageArea === storage)) {
                // Storage events may be delivered after migration removed their value.
                // Only a key that still exists represents a writer after the boundary.
                try { checkLegacyWriter(); } catch (_) { disable(); }
            }
        }

        function onPageHide() { void stop(); }

        function start() {
            if (stopping) {
                const requestedGeneration = generation;
                eventTarget.addEventListener?.('pagehide', onPageHide);
                return stopping.then(() => {
                    if (requestedGeneration === generation) return start();
                });
            }
            if (active) return starting || Promise.resolve();
            if (unsafeLegacyWriter) return Promise.resolve();
            active = true;
            available = false;
            const run = ++generation;
            eventTarget.addEventListener?.('storage', onStorage);
            eventTarget.addEventListener?.('pagehide', onPageHide);
            if (typeof Channel === 'function') {
                try {
                    channel = new Channel('m3u8-downloader-coordination');
                    channel.onmessage = () => { void requestRefresh(); };
                } catch (_) { channel = null; }
            }
            starting = (async () => {
                try {
                    await repository.initialize();
                    if (!current(run)) return;
                    available = true;
                    await requestRefresh();
                    if (current(run) && available) heartbeat(run);
                } catch (_) { if (current(run)) disable(); }
            })();
            return starting;
        }

        function stop() {
            // Even a repeated stop must invalidate starts queued behind earlier cleanup.
            generation += 1;
            eventTarget.removeEventListener?.('pagehide', onPageHide);
            if (stopping) return stopping;
            if (!active) return Promise.resolve();
            let finish;
            stopping = new Promise(resolve => { finish = resolve; });
            const pendingStop = stopping;
            const pendingWork = [starting, refreshing];
            active = false;
            const previous = relinquish();
            if (heartbeatTimer !== null) cancel(heartbeatTimer);
            heartbeatTimer = null;
            eventTarget.removeEventListener?.('storage', onStorage);
            starting = null;
            refreshing = null;
            draining = null;
            refreshAgain = false;
            void (async () => {
                if (previous) {
                    try { await repository.releaseLease(pageId, previous.executionEpoch); } catch (_) { /* Lease expiry remains the crash fallback. */ }
                }
                // A pending acquisition cleans up its own lease when it observes the
                // stopped generation. Finish that cleanup before permitting restart.
                await Promise.allSettled(pendingWork);
                broadcast();
                channel?.close();
                channel = null;
            })().finally(() => {
                if (stopping === pendingStop) stopping = null;
                finish();
            });
            return pendingStop;
        }

        function notifyChanged() {
            broadcast();
            void requestRefresh();
        }

        async function acknowledgeLegacyWriter() {
            if (!unsafeLegacyWriter) return { ok: true };
            // Closing an old page cannot remove its last snapshot. The user must
            // acknowledge that closure before we discard only this obsolete key.
            await stop();
            try {
                storage?.removeItem(LEGACY_TASKS_KEY);
                unsafeLegacyWriter = false;
                await start();
                return { ok: available && !unsafeLegacyWriter };
            } catch (_) {
                unsafeLegacyWriter = true;
                disable();
                return rejected('coordination-unavailable');
            }
        }

        async function submitIntent(type, taskId, payload, expectedVersion) {
            if (!active || !available || unsafeLegacyWriter) return rejected('coordination-unavailable');
            const run = generation;
            try {
                const result = await repository.appendIntent({ type, taskId, payload, expectedVersion, pageId });
                if (current(run) && result.ok) notifyChanged();
                return result;
            } catch (error) {
                if (error?.name === 'DataCloneError') return rejected('handle-not-cloneable');
                if (current(run)) disable();
                return rejected('coordination-unavailable');
            }
        }

        async function mutate(operation) {
            if (!hasAuthority()) return rejected('stale-epoch', true);
            const run = generation;
            const epoch = lease.executionEpoch;
            try {
                const result = inspectMutation(await operation(epoch), run);
                if (current(run) && result.ok) notifyChanged();
                return result;
            } catch (_) {
                if (current(run)) disable();
                return rejected('coordination-unavailable');
            }
        }

        return Object.freeze({
            start, stop, submitIntent, notifyChanged, acknowledgeLegacyWriter,
            persistTask: task => mutate(epoch => repository.putTask(task, epoch)),
            removeTask: taskId => mutate(epoch => repository.deleteTask(taskId, epoch)),
            isCoordinator: hasAuthority,
            getExecutionEpoch: () => lease?.executionEpoch ?? observed.executionEpoch
        });
    }

    const api = Object.freeze({
        createTaskId,
        createTaskFingerprint,
        selectRunnableTaskIds,
        openDatabase,
        createTaskRepository,
        createCoordinatorRuntime
    });

    Object.defineProperty(global, 'M3U8TaskCoordination', {
        configurable: false,
        enumerable: true,
        value: api,
        writable: false
    });
}(globalThis));
