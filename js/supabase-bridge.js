/* ═══════════════════════════════════════════════════════════════
   supabase-bridge.js  v6  — security-hardened
   Changes since v5:
   • Fires window.__bridgeReady + 'bridge:ready' event so login
     can wait for the first cloud pull before checking credentials.
   ═══════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    const SUPABASE_URL =
        window.SUPABASE_URL || 'https://bfpyuaqktmqtknsexkkg.supabase.co';
    const SUPABASE_ANON_KEY =
        window.SUPABASE_ANON_KEY || 'PASTE_YOUR_FULL_ANON_KEY_HERE';

    const TABLE         = 'app_state';
    const STORAGE_KEY   = 'DarAlWafaaEnhanced';
    const SETTINGS_KEY  = 'DarAlWafaaSchoolSettings';
    const SESSION_KEY   = 'DarAlWafaaSession';
    const SDK_URL       = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
    const PUSH_DEBOUNCE = 1500;
    const RELOAD_FLAG   = '__bridge_reloaded';
    const REALTIME_ON   = window.SUPABASE_BRIDGE_REALTIME === true;

    let supabase        = null;
    let initialized     = false;
    let online          = navigator.onLine;
    let pushTimer       = null;
    let pushing         = false;
    let pendingPush     = { [STORAGE_KEY]: false, [SETTINGS_KEY]: false };
    let realtimeChannel = null;
    let lastCloudUpdate = 0;
    let lastPushTs      = 0;
    let suppressPush    = false;
    let applyingRemote  = false;

    const log  = (...a) => window.SUPABASE_BRIDGE_DEBUG && console.log('[Bridge]', ...a);
    const warn = (...a) => console.warn('[Bridge]', ...a);

    function showToast(msg, isError) {
        for (const id of ['toast', 'teacherToast', 'accountantToast']) {
            const el = document.getElementById(id);
            if (el) {
                el.textContent = msg;
                el.style.background = isError ? '#e74c3c' : '#27ae60';
                el.classList.add('show');
                clearTimeout(el._bridgeTimer);
                el._bridgeTimer = setTimeout(() => el.classList.remove('show'), 3500);
                return;
            }
        }
    }

    function safeParse(raw, fallback = null) {
        if (!raw) return fallback;
        try { return JSON.parse(raw); } catch { return fallback; }
    }

    // ── HOOKS ─────────────────────────────────────────────────────
    function installStorageHook() {
        if (localStorage.__bridgePatched) return;
        const orig = localStorage.setItem.bind(localStorage);
        localStorage.setItem = function (key, value) {
            orig(key, value);
            if (key === STORAGE_KEY || key === SETTINGS_KEY) schedulePush(key);
        };
        Object.defineProperty(localStorage, '__bridgePatched', {
            value: true, writable: false, enumerable: false, configurable: false
        });
    }

    function installFunctionHooks() {
        const wrap = (name) => {
            const orig = window[name];
            if (typeof orig !== 'function' || orig.__bridgeWrapped) return;
            const wrapped = function (...args) {
                const r = orig.apply(this, args);
                try {
                    if (name.startsWith('saveSettings')) schedulePush(SETTINGS_KEY);
                    else schedulePush(STORAGE_KEY);
                } catch {}
                return r;
            };
            wrapped.__bridgeWrapped = true;
            window[name] = wrapped;
        };
        ['saveData','saveToLocal','saveSettings','saveSettingsHandler'].forEach(wrap);
    }

    // ── SDK ───────────────────────────────────────────────────────
    function loadSdk() {
        return new Promise((resolve, reject) => {
            if (window.supabase?.createClient) return resolve(window.supabase);
            const existing = document.querySelector(`script[src="${SDK_URL}"]`);
            if (existing) {
                existing.addEventListener('load', () => resolve(window.supabase));
                existing.addEventListener('error', reject);
                return;
            }
            const s = document.createElement('script');
            s.src = SDK_URL; s.async = true;
            s.onload  = () => resolve(window.supabase);
            s.onerror = () => reject(new Error('Failed to load Supabase SDK'));
            document.head.appendChild(s);
        });
    }

    // ── CLOUD I/O ─────────────────────────────────────────────────
    async function cloudGet(key) {
        if (!supabase) return null;
        const { data, error } = await supabase
            .from(TABLE).select('value, updated_at').eq('key', key).maybeSingle();
        if (error) { warn('cloudGet', key, error.message); return null; }
        return data;
    }

    async function cloudPut(key, value) {
        const now = new Date().toISOString();
        lastPushTs = Date.now();
        const { error } = await supabase
            .from(TABLE)
            .upsert({ key, value, updated_at: now }, { onConflict: 'key' });
        if (error) throw error;
    }

    // ── MIRROR ────────────────────────────────────────────────────
    async function mirrorTable(tableName, rows) {
        if (!supabase) return;
        try {
            const { error: delErr } = await supabase
                .from(tableName).delete().neq('id', '__never__');
            if (delErr) { warn('mirror wipe', tableName, delErr.message); return; }
            if (!rows || !rows.length) return;
            const BATCH = 500;
            for (let i = 0; i < rows.length; i += BATCH) {
                const chunk = rows.slice(i, i + BATCH);
                const { error } = await supabase.from(tableName).insert(chunk);
                if (error) { warn('mirror insert', tableName, error.message); return; }
            }
        } catch (err) { warn('mirrorTable', tableName, err.message); }
    }

    async function mirrorAll(data) {
        if (!data) return;
        const map = [
            ['students',         (data.students || []).map(s => ({
                id: s.id, name: s.name, class: s.class, age: s.age ?? null,
                gender: s.gender || null, admission_date: s.admissionDate || null,
                status: s.status || 'Active', parent_name: s.parentName || null,
                parent_contact: s.parentContact || null, location: s.location || null,
                attendance: s.attendance ?? 0 }))],
            ['teachers',         (data.teachers || []).map(t => ({
                id: t.id, name: t.name, email: t.email || null,
                assigned_class: t.assignedClass || null, subject: t.subject || null,
                phone: t.phone || null, date_joined: t.dateJoined || null,
                username: t.username || null,
                // password not mirrored for security
                can_login: t.canLogin !== false }))],
            ['classes',          (data.classes || []).map(c => ({
                id: c.id, name: c.name, level: c.level || null,
                capacity: c.capacity ?? null, status: c.status || 'Active' }))],
            ['subjects',         (data.subjects || []).map(s => ({
                id: s.id, name: s.name, code: s.code || null,
                level: s.level || null, description: s.description || null }))],
            ['terms',            (data.terms || []).map(t => ({
                id: t.id, name: t.name }))],
            ['academic_years',   (data.academicYears || []).map(y => ({
                id: y.id, name: y.name }))],
            ['fee_categories',   (data.feeCategories || []).map(c => ({
                id: c.id, name: c.name }))],
            ['fee_structure',    (data.feeStructure || []).map(f => ({
                id: f.id, level_group: f.levelGroup || null,
                year_id: f.yearId || null, term_id: f.termId || null,
                category_id: f.categoryId || null, amount: f.amount ?? 0 }))],
            ['exams',            (data.exams || []).map(e => ({
                id: e.id, name: e.name, subject: e.subject || null,
                class: e.class || null, term_id: e.termId || null,
                date: e.date || null, max_score: e.maxScore ?? null,
                type: e.type || null, description: e.description || null }))],
            ['exam_grades',      (data.examGrades || []).map(g => ({
                id: g.id, exam_id: g.examId, student_id: g.studentId,
                score: g.score ?? null }))],
            ['attendance',       (data.attendance || []).map(a => ({
                id: a.id, date: a.date, student_id: a.studentId,
                student_name: a.studentName || null,
                class: a.class || null, status: a.status || null }))],
            ['staff_attendance', (data.staffAttendance || []).map(a => ({
                id: a.id, date: a.date, teacher_id: a.teacherId,
                teacher_name: a.teacherName || null,
                status: a.status || null, sign_out_time: a.signOutTime || null }))],
            ['payments',         (data.payments || []).map(p => ({
                id: p.id, student_name: p.studentName || null,
                amount: p.amount ?? 0, date: p.date || null,
                method: p.method || null, description: p.description || null,
                status: p.status || 'Pending',
                payment_class: p.paymentClass || null,
                year_id: p.yearId || null, term_id: p.termId || null,
                fee_category_id: p.feeCategoryId || null,
                reference: p.reference || null }))],
            ['budgets',          (data.budgets || []).map(b => ({
                id: b.id, category: b.category, allocated: b.allocated ?? 0 }))],
            ['expenses',         (data.expenses || []).map(e => ({
                id: e.id, student_name: e.studentName || null,
                class: e.class || null, category: e.category || null,
                description: e.description || null, amount: e.amount ?? 0,
                date: e.date || null, method: e.method || null }))],
            ['timetable',        (data.timetable || []).map(t => ({
                id: t.id, day: t.day, time: t.time, class: t.class || null,
                subject: t.subject || null, teacher: t.teacher || null,
                room: t.room || null }))],
            ['accountants',      (data.accountants || []).map(a => ({
                id: a.id, name: a.name, username: a.username || null,
                // password not mirrored for security
                email: a.email || null,
                phone: a.phone || null, can_login: a.canLogin !== false,
                date_joined: a.dateJoined || null }))],
            ['staff',            (data.staff || []).map(s => ({
                id: s.id, name: s.name, role: s.role || null,
                department: s.department || null,
                phone: s.phone || null, email: s.email || null }))]
        ];
        for (const [tableName, rows] of map) await mirrorTable(tableName, rows);
    }

    // ── PUSH QUEUE ────────────────────────────────────────────────
    async function pushKey(key) {
        if (!supabase || !online) return false;
        const parsed = safeParse(localStorage.getItem(key));
        if (parsed === null) return false;
        try { await cloudPut(key, parsed); return true; }
        catch (err) { warn('pushKey', key, err.message); return false; }
    }

    async function flushPushQueue() {
        if (pushing || !online || !supabase) return;
        pushing = true;
        try {
            const keys = Object.keys(pendingPush).filter(k => pendingPush[k]);
            for (const k of keys) {
                pendingPush[k] = false;
                const ok = await pushKey(k);
                if (!ok) pendingPush[k] = true;
            }
            const mainData = safeParse(localStorage.getItem(STORAGE_KEY));
            if (mainData) await mirrorAll(mainData);
        } finally { pushing = false; }
    }

    function schedulePush(key) {
        if (suppressPush || applyingRemote) return;
        pendingPush[key] = true;
        clearTimeout(pushTimer);
        pushTimer = setTimeout(flushPushQueue, PUSH_DEBOUNCE);
    }

    // ── REALTIME (OPT-IN, OFF BY DEFAULT) ─────────────────────────
    function startRealtime() {
        if (!REALTIME_ON) { log('Realtime disabled (default)'); return; }
        if (!supabase || realtimeChannel) return;
        try {
            realtimeChannel = supabase
                .channel('app_state_changes')
                .on('postgres_changes',
                    { event: '*', schema: 'public', table: TABLE },
                    (payload) => {
                        const row = payload.new || payload.old;
                        if (!row?.key) return;
                        const ts = Date.now();
                        if (Date.now() - lastPushTs < 10000) return;
                        if (ts <= lastCloudUpdate) return;
                        lastCloudUpdate = ts;

                        if (row.key === STORAGE_KEY && row.value) {
                            applyingRemote = true;
                            localStorage.setItem(STORAGE_KEY, JSON.stringify(row.value));
                            applyingRemote = false;
                            showToast('☁️ New data available — refresh to see it');
                        } else if (row.key === SETTINGS_KEY && row.value) {
                            applyingRemote = true;
                            localStorage.setItem(SETTINGS_KEY, JSON.stringify(row.value));
                            applyingRemote = false;
                            if (typeof window.applySettings === 'function') {
                                try { window.applySettings(); } catch {}
                            }
                        }
                    })
                .subscribe((status) => log('Realtime:', status));
        } catch (err) { warn('Realtime failed:', err.message); }
    }

    function installConnectivity() {
        window.addEventListener('online', () => {
            online = true;
            showToast('🌐 Back online — syncing…');
            flushPushQueue();
        });
        window.addEventListener('offline', () => {
            online = false;
            showToast('📴 Offline — changes will sync later', true);
        });
    }

    // ── INIT ──────────────────────────────────────────────────────
    async function init() {
        if (initialized) return;

        installStorageHook();
        installFunctionHooks();

        if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.startsWith('PASTE_')) {
            warn('No Supabase key — running offline');
            window.__bridgeReady = true;
            window.dispatchEvent(new CustomEvent('bridge:ready'));
            return;
        }

        try {
            const sdk = await loadSdk();
            supabase = sdk.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                auth: { persistSession: false, autoRefreshToken: false }
            });

            const [mainRow, settingsRow] = await Promise.all([
                cloudGet(STORAGE_KEY), cloudGet(SETTINGS_KEY)
            ]);

            let localChanged = false;
            suppressPush = true;
            if (mainRow?.value) {
                const incoming = JSON.stringify(mainRow.value);
                if (incoming !== localStorage.getItem(STORAGE_KEY)) {
                    localStorage.setItem(STORAGE_KEY, incoming);
                    localChanged = true;
                }
                lastCloudUpdate = new Date(mainRow.updated_at || 0).getTime();
            }
            if (settingsRow?.value) {
                const incoming = JSON.stringify(settingsRow.value);
                if (incoming !== localStorage.getItem(SETTINGS_KEY)) {
                    localStorage.setItem(SETTINGS_KEY, incoming);
                    localChanged = true;
                }
            }
            suppressPush = false;

            const hasSession = !!localStorage.getItem(SESSION_KEY);
            if (localChanged && !hasSession && !sessionStorage.getItem(RELOAD_FLAG)) {
                sessionStorage.setItem(RELOAD_FLAG, '1');
                log('Reloading once (logged out) to apply cloud data');
                location.reload();
                return;
            }

            if (!mainRow) {
                const localMain = localStorage.getItem(STORAGE_KEY);
                if (localMain) await pushKey(STORAGE_KEY);
            }
            if (!settingsRow) {
                const localSet = localStorage.getItem(SETTINGS_KEY);
                if (localSet) await pushKey(SETTINGS_KEY);
            }

            startRealtime();
            installConnectivity();

            const data = safeParse(localStorage.getItem(STORAGE_KEY));
            if (data) mirrorAll(data).catch(() => {});

            if (Object.values(pendingPush).some(Boolean)) {
                flushPushQueue();
            }

            initialized = true;
            log('Bridge v6 ready');
            window.__bridgeReady = true;
            window.dispatchEvent(new CustomEvent('bridge:ready'));
        } catch (err) {
            warn('Init failed:', err.message);
            window.__bridgeReady = true;
            window.dispatchEvent(new CustomEvent('bridge:ready'));
        }
    }

    // ── PUBLIC API ────────────────────────────────────────────────
    window.SupabaseBridge = {
        init,
        push: async () => {
            pendingPush[STORAGE_KEY]  = true;
            pendingPush[SETTINGS_KEY] = true;
            await flushPushQueue();
            showToast('☁️ Pushed to cloud');
        },
        pull: async () => {
            const [r1, r2] = await Promise.all([
                cloudGet(STORAGE_KEY), cloudGet(SETTINGS_KEY)
            ]);
            suppressPush = true;
            if (r1?.value) localStorage.setItem(STORAGE_KEY, JSON.stringify(r1.value));
            if (r2?.value) localStorage.setItem(SETTINGS_KEY, JSON.stringify(r2.value));
            suppressPush = false;
            showToast('☁️ Loaded from cloud');
        },
        forceSync: async () => {
            await window.SupabaseBridge.pull();
            await window.SupabaseBridge.push();
            showToast('🔄 Full sync complete');
        },
        mirror: async () => {
            const data = safeParse(localStorage.getItem(STORAGE_KEY));
            if (data) await mirrorAll(data);
            showToast('🪞 Mirrored all entities');
        },
        resetFlags: () => {
            sessionStorage.removeItem(RELOAD_FLAG);
            showToast('🔄 Reload flag cleared');
        },
        status: () => ({
            initialized, online, pushing,
            realtime: REALTIME_ON,
            hasSession: !!localStorage.getItem(SESSION_KEY),
            reloadFlag: sessionStorage.getItem(RELOAD_FLAG),
            lastCloudUpdate: new Date(lastCloudUpdate).toISOString(),
            lastPushTs: new Date(lastPushTs).toISOString()
        }),
        get client() { return supabase; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();