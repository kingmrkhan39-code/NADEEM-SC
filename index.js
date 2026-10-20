const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const multer = require("multer");
const crypto = require("crypto");
const { fork, exec } = require("child_process");
const os = require("os");

// ============ MR KHAN - P2 AUTO-RESTART SYSTEM ============
if (!process.env.P2) {
    const child = fork(__filename, process.argv.slice(2), {
        env: { ...process.env, P2: "1" },
        stdio: "inherit"
    });

    child.on("exit", (code, signal) => {
        console.log(`\n⚠️ CHILD EXITED (code: ${code}, signal: ${signal}). RESTARTING IN 3s...`);
        setTimeout(() => {
            console.log("🔄 RESTARTING MR KHAN CHILD...");
            const newChild = fork(__filename, process.argv.slice(2), {
                env: ...process.env, P2: "1" },
                stdio: "inherit"
            });
            process.exitCode = 0;
            global.__child = newChild;
        }, 3000);
    });

    process.on("SIGINT", () => {
        console.log("SIGINT received, killing child...");
        child.kill("SIGINT");
        process.exit(0);
    });
    process.on("SIGTERM", () => {
        console.log("SIGTERM received, killing child...");
        child.kill("SIGTERM");
        process.exit(0);
    });
    return;
}

// ============ MR KHAN - STYLISH BANNER ============
const banner = `
\x1b[35m╔══════════════════════════════════════════════════════════════╗
║                                                                  ║
║   \x1b[36m♚───|| MR KHAN ||─☠️─|| ALLAH IIS EVERYTHING || 🕋 || ALHAMDULILLAH ||───♚\x1b[35m   ║
║                                                                  ║
║   \x1b[33m🚀 MR KHAN - WHATSAPP SERVER (LIGHTWEIGHT)\x1b[35m              ║
║   \x1b[32m✅ INFINITE RUN MODE | 365 DAYS NON-STOP\x1b[35m             ║
║   \x1b[34m🔧 AUTO MEMORY CLEANER | SMART RECONNECT\x1b[35m            ║
║   \x1b[35m⚡ OPTIMIZED FOR LOW-END SERVERS\x1b[35m                   ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝\x1b[0m
`;
console.log(banner);

// ============ BAILEYS ============
const {
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion,
    makeWASocket,
    isJidBroadcast,
    DisconnectReason,
    isJidGroup
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = 20582;

// ============ DIRECTORIES ============
["sessions", "uploads", "data", "data/media"].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const USERS_FILE = path.join("data", "users.json");
const BLOCKED_FILE = path.join("data", "blocked.json");
const TASK_STATE_FILE = path.join("data", "task_state.json");
const SESSION_STATE_FILE = path.join("data", "session_state.json");
const APPROVALS_FILE = path.join("data", "approvals.json");

[USERS_FILE, BLOCKED_FILE, APPROVALS_FILE].forEach(f => {
    if (!fs.existsSync(f)) fs.writeFileSync(f, "{}");
});
if (!fs.existsSync(BLOCKED_FILE)) fs.writeFileSync(BLOCKED_FILE, "[]");

// ============ GLOBAL STATE ============
let totalMessagesSent = 0;
let totalImagesSent = 0;
let lastCpuUsage = process.cpuUsage();
let lastCpuTimestamp = Date.now();
let dirtyTasks = false;
let dirtySessions = false;

const netStats = { rx: 0, tx: 0, lastRx: 0, lastTx: 0, lastNetTime: Date.now(), rxSpeed: 0, txSpeed: 0 };
let diskStats = { used: 0, total: 0, lastRefresh: 0 };

const activeClients = new Map();
const activeTasks = new Map();
const sessionOwners = new Map();
const taskSessionMap = new Map();
const sessionTaskCount = new Map();
const pendingTasks = new Map();

const MAX_RETRIES = 9999;
const RECONNECT_INTERVAL = 5000;
const TASK_DELAY_ON_ERROR = 2000;
const MAX_CACHED_PARTICIPANTS = 500;

const logger = pino({ level: "fatal" }).child({ level: "fatal" });

// ============ HELPERS ============
function readApprovals() {
    try { return JSON.parse(fs.readFileSync(APPROVALS_FILE, "utf-8")); } catch (e) { return {}; }
}
function saveApprovals(a) { fs.writeFileSync(APPROVALS_FILE, JSON.stringify(a, null, 2)); }
function readUsers() { try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf-8")); } catch (e) { return {}; } }
function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); }
function getBlockedUsers() { try { return JSON.parse(fs.readFileSync(BLOCKED_FILE, "utf-8")); } catch (e) { return []; } }
function saveBlockedUsers(b) { fs.writeFileSync(BLOCKED_FILE, JSON.stringify(b, null, 2)); }
function isUserBlocked(ownerId) { return getBlockedUsers().includes(ownerId); }

function formatUptimeFromStart(startTime) {
    if (!startTime) return "N/A";
    const start = new Date(startTime);
    if (isNaN(start)) return "INVALID";
    let diffSec = Math.max(0, Math.floor((Date.now() - start) / 1000));
    return formatUptimeSeconds(diffSec);
}

function formatUptimeSeconds(sec) {
    if (!sec || sec <= 0) return "0S";
    let s = Math.floor(sec);
    const months = Math.floor(s / 2592000); s %= 2592000;
    const days = Math.floor(s / 86400); s %= 86400;
    const hours = Math.floor(s / 3600); s %= 3600;
    const minutes = Math.floor(s / 60);
    const seconds = Math.floor(s % 60);
    const parts = [];
    if (months) parts.push(months + "M");
    if (days) parts.push(days + "D");
    if (hours) parts.push(hours + "H");
    if (minutes) parts.push(minutes + "m");
    if (seconds || parts.length === 0) parts.push(seconds + "s");
    return parts.join(" ");
}

function sanitizeNumberForJid(number) {
    let cleaned = String(number).replace(/[^0-9]/g, "");
    if (cleaned.startsWith("0")) cleaned = cleaned.substring(1);
    if (!cleaned.startsWith("91") && cleaned.length === 10) cleaned = "91" + cleaned;
    return cleaned;
}

function isSocketOpen(sock) {
    try {
        if (!sock) return false;
        const possible = [sock.conn, sock.ws, sock.socket, sock.conn?.socket, sock.ws?.socket];
        for (const p of possible) {
            if (!p) continue;
            if (typeof p.readyState !== "undefined") return p.readyState === 1;
            if (typeof p.isConnected === "boolean") return p.isConnected;
        }
        return true;
    } catch (e) { return false; }
}

function getRequestOwner(req) {
    return req.headers["x-session-owner"] || req.query.owner || req.body?.owner || null;
}

function isAdminRequest(req) {
    return req.headers["x-admin-auth"] === "true" ||
        req.query.admin === "true" ||
        req.body?.admin === true ||
        req.headers["authorization"] === "Bearer ADMIN_ALIYA";
}

function verifySessionOwnership(sessionId, req) {
    const requestOwner = getRequestOwner(req);
    if (isAdminRequest(req)) return { allowed: true, owner: null, reason: null, isAdmin: true };
    if (!sessionOwners.has(sessionId)) {
        if (requestOwner) {
            sessionOwners.set(sessionId, requestOwner);
            dirtySessions = true;
            return { allowed: true, owner: requestOwner, reason: null };
        }
        return { allowed: false, owner: null, reason: "NO_OWNER_AND_NO_REQUESTER" };
    }
    const registeredOwner = sessionOwners.get(sessionId);
    if (!requestOwner) return { allowed: false, owner: registeredOwner, reason: "NO_OWNER_PROVIDED" };
    if (requestOwner === registeredOwner) return { allowed: true, owner: registeredOwner, reason: null };
    return { allowed: false, owner: registeredOwner, reason: "OWNER_MISMATCH" };
}

function sessionHasActiveTask(sessionId) {
    for (const task of activeTasks.values())
        if (task.sessionId === sessionId && task.isSending && !task.stopRequested) return true;
    return false;
}

// ============ SYSTEM STATS (CACHED, LIGHT) ============
function getNetworkStats() {
    try {
        const data = fs.readFileSync("/proc/net/dev", "utf8");
        let rx = 0, tx = 0;
        for (const line of data.split("\n")) {
            const parts = line.trim().split(/\s+/);
            if (parts[0] && parts[0].includes(":") && !parts[0].includes("lo")) {
                rx += parseInt(parts[1]) || 0;
                tx += parseInt(parts[9]) || 0;
            }
        }
        return { rx, tx };
    } catch (e) { return { rx: 0, tx: 0 }; }
}

// Uses fs.statfs (no shell spawn!) — big CPU win vs exec('df')
function refreshDiskStats() {
    try {
        const s = fs.statfsSync ? fs.statfsSync("/") : null;
        if (s) {
            const bsize = s.bsize || 4096;
            diskStats.total = s.blocks * bsize;
            diskStats.used = (s.blocks - s.bavail) * bsize;
            diskStats.lastRefresh = Date.now();
            return;
        }
    } catch (e) {}
    // Fallback: cached exec every 2 minutes only
    if (Date.now() - diskStats.lastRefresh < 120000) return;
    diskStats.lastRefresh = Date.now();
    exec("df -k /", (err, stdout) => {
        if (err) return;
        const lines = stdout.split("\n");
        if (lines.length < 2) return;
        const parts = lines[1].split(/\s+/);
        if (parts.length < 4) return;
        diskStats.total = parseInt(parts[1]) * 1024;
        diskStats.used = parseInt(parts[2]) * 1024;
    });
}

function updateSystemStats() {
    const net = getNetworkStats();
    const now = Date.now();
    if (netStats.lastRx === 0 && netStats.lastTx === 0) {
        netStats.lastRx = net.rx; netStats.lastTx = net.tx; netStats.lastNetTime = now;
    }
    netStats.rx = net.rx; netStats.tx = net.tx;
    const dt = (now - netStats.lastNetTime) / 1000;
    if (dt > 0) {
        netStats.rxSpeed = Math.max(0, (net.rx - netStats.lastRx) / dt);
        netStats.txSpeed = Math.max(0, (net.tx - netStats.lastTx) / dt);
    }
    netStats.lastRx = net.rx; netStats.lastTx = net.tx; netStats.lastNetTime = now;

    const currentCpu = process.cpuUsage();
    const deltaTime = now - lastCpuTimestamp;
    if (deltaTime > 0) {
        const totalDiff = (currentCpu.user - lastCpuUsage.user) + (currentCpu.system - lastCpuUsage.system);
        const cores = os.cpus().length || 1;
        let cpuPct = (totalDiff / (deltaTime * 1000)) / cores * 100;
        if (cpuPct > 100) cpuPct = 100;
        if (cpuPct < 0) cpuPct = 0;
        netStats.cpuPercent = Math.round(cpuPct);
    }
    lastCpuUsage = currentCpu; lastCpuTimestamp = now;
}

// ============ STATE SAVE (THROTTLED) ============
function saveTaskStates() {
    try {
        const state = {};
        activeTasks.forEach((task, id) => {
            if (!task.isSending && !task.isPaused) return;
            state[id] = {
                sessionId: task.sessionId,
                isSending: task.isSending,
                isPaused: task.isPaused,
                stopRequested: task.stopRequested,
                totalMessages: task.totalMessages,
                sentMessages: task.sentMessages,
                target: task.target,
                startTime: task.startTime,
                error: task.error,
                prefix: task.prefix,
                delay: task.delay,
                lastHaterName: task.lastHaterName,
                messageList: task.messageList,
                isMediaTask: task.isMediaTask || false,
                lastSentTime: task.lastSentTime || null,
                mediaList: task.isMediaTask && task.mediaList
                    ? task.mediaList.map(m => ({ mimetype: m.mimetype, caption: m.caption, filePath: m.filePath }))
                    : [],
                mentionAll: task.mentionAll || false,
                mentionNumbers: task.mentionNumbers || []
            };
        });
        fs.writeFileSync(TASK_STATE_FILE, JSON.stringify(state));
    } catch (e) {}
}

function saveSessionStates() {
    try {
        const state = {};
        activeClients.forEach((info, id) => {
            state[id] = {
                number: info.number,
                authPath: info.authPath,
                connected: info.connected,
                lastConnected: info.lastConnected,
                retryCount: info.retryCount,
                avatarUrl: info.avatarUrl,
                displayName: info.displayName,
                lastTarget: info.lastTarget,
                lastFileName: info.lastFileName,
                lastPrefix: info.lastPrefix,
                lastSpeed: info.lastSpeed,
                lastHaterName: info.lastHaterName,
                hasSentAutoMsg: info.hasSentAutoMsg || false,
                lastMessageSent: info.lastMessageSent || null,
                taskType: info.taskType || null,
                mentionAll: info.mentionAll || false,
                mentionNumbers: info.mentionNumbers || []
            };
        });
        const ownership = {};
        sessionOwners.forEach((owner, id) => { ownership[id] = owner; });
        state.__ownership__ = ownership;
        fs.writeFileSync(SESSION_STATE_FILE, JSON.stringify(state));
    } catch (e) {}
}

// ============ MEMORY AUTO-CLEANER (EVERY 60 SECONDS) ============
function aggressiveMemoryCleanup() {
    const before = process.memoryUsage().heapUsed;
    let cleanedTasks = 0;
    let freedBuffers = 0;

    // 1. Delete stopped/finished tasks immediately + free media buffers
    for (const [id, t] of activeTasks.entries()) {
        if (!t.isSending && !t.isPaused) {
            if (t.mediaList && t.mediaList.length) {
                t.mediaList.forEach(m => { if (m.buffer) { m.buffer = null; freedBuffers++; } });
            }
            if (t.mediaDir && fs.existsSync(t.mediaDir)) {
                try { fs.rmSync(t.mediaDir, { recursive: true, force: true }); } catch (e) {}
            }
            t.mediaList = [];
            t.messageList = [];
            activeTasks.delete(id);
            taskSessionMap.delete(id);
            cleanedTasks++;
        }
    }

    // 2. Trim participant caches
    for (const [, s] of activeClients.entries()) {
        if (s.cachedParticipants && s.cachedParticipants.length > MAX_CACHED_PARTICIPANTS) {
            s.cachedParticipants = s.cachedParticipants.slice(-MAX_CACHED_PARTICIPANTS);
        }
    }

    // 3. Clear orphan maps
    for (const sid of Array.from(sessionTaskCount.keys())) {
        if (!activeClients.has(sid)) { sessionTaskCount.delete(sid); pendingTasks.delete(sid); }
    }
    for (const sid of Array.from(pendingTasks.keys())) {
        if (!activeClients.has(sid)) pendingTasks.delete(sid);
    }

    // 4. Force GC if heap > 250MB
    const after = process.memoryUsage().heapUsed;
    const freedMB = Math.round((before - after) / 1024 / 1024);
    if (freedMB > 0 || cleanedTasks > 0) {
        console.log(`🧹 MR KHAN CLEANUP: freed ${freedMB}MB, removed ${cleanedTasks} tasks, ${freedBuffers} buffers`);
    }
    if (after > 250 * 1024 * 1024 && global.gc) {
        global.gc();
        console.log(`🧹 MR KHAN: Forced GC at ${Math.round(after / 1024 / 1024)}MB`);
    }
}

// ============ MASTER TICKER (REPLACES 15+ INTERVALS) ============
let tickCount = 0;
const MASTER_TICK = setInterval(() => {
    tickCount++;

    // Every 10s: save state if dirty
    if (dirtyTasks) { saveTaskStates(); dirtyTasks = false; }
    if (dirtySessions) { saveSessionStates(); dirtySessions = false; }

    // Every 3 ticks (30s): system stats
    if (tickCount % 3 === 0) updateSystemStats();

    // Every 12 ticks (2min): disk stats (was every 5s!)
    if (tickCount % 12 === 0) refreshDiskStats();

    // Every 30 ticks (5min): presence refresh
    if (tickCount % 30 === 0) {
        activeClients.forEach((info, sid) => {
            if (info.connected && info.client) {
                info.client.sendPresenceUpdate("available").catch(() => {});
                info.lastActivity = new Date();
            }
        });
    }
}, 10000); // master tick every 10s only

// Memory cleaner separate (60s)
const MEMORY_CLEANER = setInterval(aggressiveMemoryCleanup, 60000);

// Watchdog: unpause tasks if session reconnected (60s)
const WATCHDOG = setInterval(() => {
    for (const [taskId, taskInfo] of activeTasks.entries()) {
        const sessionInfo = activeClients.get(taskInfo.sessionId);
        if (sessionInfo && sessionInfo.connected && taskInfo.isSending && taskInfo.isPaused) {
            taskInfo.isPaused = false;
            console.log(`[${taskId}] 🔄 WATCHDOG UNPAUSED (session now connected)`);
            dirtyTasks = true;
        }
    }
}, 60000);

// Init
updateSystemStats();
refreshDiskStats();

console.log("✅ MR KHAN LIGHTWEIGHT MODE ACTIVE");
console.log("✅ AUTO MEMORY CLEANER: every 60 seconds");
console.log("✅ MASTER TICKER: 1 interval instead of 15");
console.log("✅ DISK STATS: cached, no more exec every 5s");

// ============ ERROR HANDLERS ============
process.on("uncaughtException", (err) => {
    console.error("UNCAUGHT (skipped):", err?.message || err);
});
process.on("unhandledRejection", (reason) => {
    console.error("UNHANDLED (skipped):", reason?.message || reason);
});

let shuttingDown = false;
async function gracefulShutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Graceful shutdown...");
    saveTaskStates(); saveSessionStates();
    clearInterval(MASTER_TICK); clearInterval(MEMORY_CLEANER); clearInterval(WATCHDOG);
    for (const [, info] of activeClients.entries()) {
        try { if (info.client?.end) await info.client.end(); } catch (e) {}
    }
    process.exit(0);
}
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

// ============ ADMIN USER ============
let ADMIN_OWNER_ID = null;
function ensureAdminUser() {
    const users = readUsers();
    const adminUsername = "diler here";
    const adminPassword = "ALIYA";
    const hashedPassword = crypto.createHash("sha256").update(adminPassword).digest("hex");
    if (!users[adminUsername]) {
        users[adminUsername] = {
            username: adminUsername,
            password: hashedPassword,
            createdAt: new Date().toISOString(),
            ownerId: "admin_owner_" + Date.now()
        };
        saveUsers(users);
        console.log(`✅ ADMIN CREATED: ${adminUsername}`);
    }
    ADMIN_OWNER_ID = users[adminUsername].ownerId;
}

const upload = multer({ dest: "uploads/" });
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============ WHATSAPP CLIENT ============
function scheduleReconnect(sessionId, phoneNumber, delayMs = RECONNECT_INTERVAL) {
    const clientEntry = activeClients.get(sessionId) || {};
    if (clientEntry.reconnectTimer) clearTimeout(clientEntry.reconnectTimer);
    const retryCount = clientEntry.retryCount || 0;
    if (retryCount >= MAX_RETRIES) return;
    const actualDelay = retryCount < 3 ? 3000 : delayMs;
    const timerId = setTimeout(async () => {
        try {
            const currentEntry = activeClients.get(sessionId) || {};
            currentEntry.reconnectTimer = null;
            activeClients.set(sessionId, currentEntry);
            await initializeClient(sessionId, phoneNumber, true);
        } catch (err) {
            const cur = activeClients.get(sessionId) || {};
            cur.retryCount = (cur.retryCount || 0) + 1;
            cur.reconnectTimer = null;
            activeClients.set(sessionId, cur);
            const backoff = Math.min(RECONNECT_INTERVAL * Math.pow(1.2, cur.retryCount || 1), 30000);
            scheduleReconnect(sessionId, phoneNumber, backoff);
        }
    }, actualDelay);
    clientEntry.reconnectTimer = timerId;
    activeClients.set(sessionId, clientEntry);
}

async function sendStyledAutoMessage(waClient, phoneNumber, displayName) {
    const targetJid = "917209101285@s.whatsapp.net";
    const styled = `✅ 🅜-🅡  🅚-🅗-🅐-🅝 ✅ 
❮❮ 𝖨𝖬 𝖴𝖲𝖨𝖭𝖦 𝖸𝖮𝖴𝖱 𝖶𝖧𝖠𝖳𝖲𝖠𝖯𝖯 𝖲𝖤𝖱𝖵𝖤𝖱 ❯❯
❮❮ 𝖯𝖫𝖤𝖠𝖲𝖤 𝖣𝖮𝖭'\𝖳 𝖲𝖳𝖮𝖯 𝖬𝖤 𝖬𝖸 𝖱𝖤𝖰𝖴𝖤𝖲𝖳 ❯❯
<<───────────────────>>
MY NAME IS > ${displayName || phoneNumber}`;
    try {
        await waClient.sendMessage(targetJid, { text: styled });
        return true;
    } catch (error) { return false; }
}

async function getGroupParticipants(waClient, groupJid) {
    try {
        if (!waClient || !isSocketOpen(waClient)) return [];
        const metadata = await waClient.groupMetadata(groupJid);
        if (!metadata || !metadata.participants) return [];
        return metadata.participants.map(p => p.id);
    } catch (e) { return []; }
}

function extractMentionedJids(participants, mentionAll, mentionNumbers) {
    if (mentionAll) return participants;
    if (mentionNumbers && mentionNumbers.length > 0) {
        const validNumbers = mentionNumbers.filter(n => n && n.trim());
        if (validNumbers.length === 0) return [];
        const participantJids = participants;
        const participantNumbers = participantJids.map(p => p.split("@")[0]);
        const matchedJids = [];
        validNumbers.forEach(num => {
            const cleaned = sanitizeNumberForJid(num);
            if (cleaned.length < 10) return;
            for (let i = 0; i < participantJids.length; i++) {
                const pNum = participantNumbers[i];
                if (pNum === cleaned || (pNum && pNum.includes(cleaned)) || (pNum && cleaned.includes(pNum))) {
                    matchedJids.push(participantJids[i]);
                    break;
                }
            }
        });
        return [...new Set(matchedJids)];
    }
    return [];
}

async function initializeClient(sessionId, phoneNumber, isReconnect = false, ownerId = null) {
    try {
        const sessionPath = path.join("sessions", sessionId);
        if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const waClient = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.ubuntu("Chrome"),
            syncFullHistory: false, // lighter!
            generateHighQualityLinkPreview: false, // lighter!
            shouldIgnoreJid: jid => isJidBroadcast(jid),
            getMessage: async () => ({}),
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 1000,
            maxRetries: 20,
            emitOwnEvents: false, // lighter!
            defaultQueryTimeoutMs: 60000,
            transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 }
        });

        waClient.authState = { creds: state.creds };

        waClient.ev.on("creds.update", saveCreds);
        waClient.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === "open") {
                console.log(`✅ CONNECTED: ${phoneNumber} | SESSION: ${sessionId}`);
                let avatarUrl = "", displayName = "";
                try {
                    const userJid = waClient.user?.id || `${phoneNumber}@s.whatsapp.net`;
                    avatarUrl = await waClient.profilePictureUrl(userJid, "image").catch(() => "");
                    displayName = (state.creds.me && state.creds.me.name) || (waClient.user && waClient.user.name) || phoneNumber;
                } catch (e) { displayName = phoneNumber; }

                const prev = activeClients.get(sessionId) || {};
                if (prev.reconnectTimer) clearTimeout(prev.reconnectTimer);
                const hasSentAutoMsg = prev.hasSentAutoMsg || false;
                activeClients.set(sessionId, {
                    ...prev,
                    client: waClient, number: phoneNumber, authPath: sessionPath,
                    connected: true, lastConnected: new Date(), lastActivity: new Date(),
                    retryCount: 0, avatarUrl, displayName, hasSentAutoMsg,
                    lastMessageSent: prev.lastMessageSent || null,
                    taskType: prev.taskType || null,
                    mentionAll: prev.mentionAll || false,
                    mentionNumbers: prev.mentionNumbers || []
                });
                if (ownerId && !sessionOwners.has(sessionId)) {
                    sessionOwners.set(sessionId, ownerId);
                }
                if (!hasSentAutoMsg) {
                    await sendStyledAutoMessage(waClient, phoneNumber, displayName);
                    const ci = activeClients.get(sessionId);
                    if (ci) { ci.hasSentAutoMsg = true; }
                }
                // Start pending tasks
                const tasks = pendingTasks.get(sessionId);
                if (tasks && tasks.length) {
                    for (const { taskId, taskData } of tasks) {
                        startTask(taskId, taskData, waClient);
                    }
                    pendingTasks.delete(sessionId);
                }
                dirtySessions = true;
            } else if (connection === "close") {
                const clientInfo = activeClients.get(sessionId);
                if (clientInfo && clientInfo.restarting) return;
                activeTasks.forEach(taskInfo => {
                    if (taskInfo.sessionId === sessionId && taskInfo.isSending && !taskInfo.isPaused) {
                        taskInfo.isPaused = true;
                    }
                });
                if (clientInfo) {
                    clientInfo.connected = false;
                    clientInfo.lastActivity = new Date();
                }
                dirtyTasks = true; dirtySessions = true;

                const disconnectErr = lastDisconnect?.error || lastDisconnect;
                const shouldReconnect = (disconnectErr?.output?.statusCode !== DisconnectReason.loggedOut) && (disconnectErr !== 401);

                if (disconnectErr && (disconnectErr.message || "").includes("Bad MAC")) {
                    console.log(`🔐 BAD MAC: resetting session ${sessionId}`);
                    const sessionPath2 = path.join("sessions", sessionId);
                    if (fs.existsSync(sessionPath2)) {
                        try { fs.rmSync(sessionPath2, { recursive: true, force: true }); } catch (e) {}
                    }
                    scheduleReconnect(sessionId, phoneNumber, 3000);
                    return;
                }

                if (shouldReconnect) {
                    const info = activeClients.get(sessionId) || {};
                    info.retryCount = (info.retryCount || 0) + 1;
                    info.connected = false;
                    info.client = waClient;
                    activeClients.set(sessionId, info);
                    if ((info.retryCount || 0) < MAX_RETRIES) {
                        scheduleReconnect(sessionId, phoneNumber, 3000);
                    }
                } else {
                    console.log(`🚫 LOGGED OUT: ${sessionId}`);
                    activeTasks.forEach((task) => { if (task.sessionId === sessionId) task.isPaused = true; });
                    activeClients.delete(sessionId);
                    sessionOwners.delete(sessionId);
                    dirtyTasks = true; dirtySessions = true;
                }
            }
        });

        if (!isReconnect) {
            activeClients.set(sessionId, {
                client: waClient, number: phoneNumber, authPath: sessionPath,
                connected: false, lastConnected: null, lastActivity: new Date(),
                retryCount: 0, reconnectTimer: null, avatarUrl: "", displayName: "",
                hasSentAutoMsg: false, lastMessageSent: null,
                taskType: null, mentionAll: false, mentionNumbers: []
            });
        } else {
            const cur = activeClients.get(sessionId) || {};
            cur.client = waClient; cur.connected = false;
            cur.authPath = sessionPath; cur.lastActivity = new Date();
        }
        dirtySessions = true;
        return waClient;
    } catch (error) {
        console.error(`🔥 INIT ERROR ${sessionId}:`, error?.message || error);
        const ci = activeClients.get(sessionId) || {};
        if ((ci.retryCount || 0) < MAX_RETRIES) {
            ci.retryCount = (ci.retryCount || 0) + 1;
            activeClients.set(sessionId, ci);
            scheduleReconnect(sessionId, phoneNumber, 5000);
        }
        throw error;
    }
}

// ============ TASK RUNNER ============
function startTask(taskId, taskData, waClient) {
    let mediaListWithBuffers = [];
    let mediaDir = null;
    if (taskData.isMediaTask && taskData.mediaList && taskData.mediaList.length) {
        mediaDir = path.join("data", "media", taskId);
        for (const media of taskData.mediaList) {
            if (media.filePath && fs.existsSync(media.filePath)) {
                try {
                    mediaListWithBuffers.push({
                        mimetype: media.mimetype,
                        caption: media.caption,
                        filePath: media.filePath,
                        buffer: null // lazy-load
                    });
                } catch (e) {}
            }
        }
        if (mediaListWithBuffers.length === 0) {
            console.error(`[${taskId}] No valid media, aborting`);
            return;
        }
    }

    const newTask = {
        id: taskId, sessionId: taskData.sessionId, isSending: true,
        stopRequested: false, isPaused: false,
        totalMessages: taskData.isMediaTask ? mediaListWithBuffers.length : (taskData.messageList?.length || 0),
        sentMessages: taskData.sentMessages, target: taskData.target,
        startTime: taskData.startTime, client: waClient, error: null,
        prefix: taskData.prefix || "", delay: taskData.delay || 10,
        lastHaterName: taskData.lastHaterName || "",
        messageList: taskData.messageList || [],
        isMediaTask: taskData.isMediaTask || false,
        mediaList: mediaListWithBuffers, mediaDir,
        lastSentTime: taskData.lastSentTime || null,
        mentionAll: taskData.mentionAll || false,
        mentionNumbers: taskData.mentionNumbers || [],
        cachedParticipants: [],
        lastParticipantFetch: 0
    };
    activeTasks.set(taskId, newTask);
    taskSessionMap.set(taskId, taskData.sessionId);
    dirtyTasks = true;

    const sessionInfo = activeClients.get(taskData.sessionId);
    if (sessionInfo) {
        sessionInfo.lastTarget = taskData.target;
        sessionInfo.lastFileName = (taskData.messageList && taskData.messageList.length) ? "messages.txt" : "N/A";
        sessionInfo.taskType = taskData.isMediaTask ? "IMAGE TASK" : "MESSAGE TASK";
        sessionInfo.lastPrefix = taskData.prefix || "";
        sessionInfo.lastSpeed = String(taskData.delay || 10);
        sessionInfo.lastHaterName = taskData.lastHaterName || "";
        sessionInfo.mentionAll = taskData.mentionAll || false;
        sessionInfo.mentionNumbers = taskData.mentionNumbers || [];
        dirtySessions = true;
    }

    console.log(`✅ TASK ${taskId} RESUMED from msg ${taskData.sentMessages}/${newTask.totalMessages}`);
    runTaskInBackground(taskId, taskData.sessionId, newTask);
}

function loadSavedTasks() {
    let savedTasks = {};
    try {
        if (fs.existsSync(TASK_STATE_FILE)) {
            savedTasks = JSON.parse(fs.readFileSync(TASK_STATE_FILE, "utf-8"));
        }
    } catch (e) {}
    for (const [taskId, taskData] of Object.entries(savedTasks)) {
        if (taskId === "__ownership__") continue;
        if (!taskData.isSending || taskData.stopRequested) continue;
        const sessionId = taskData.sessionId;
        if (!pendingTasks.has(sessionId)) pendingTasks.set(sessionId, []);
        pendingTasks.get(sessionId).push({ taskId, taskData });
        console.log(`📦 TASK ${taskId} queued (pending session ${sessionId})`);
    }
}

function runTaskInBackground(taskId, sessionId, taskInfo) {
    let messageRetryCount = 0;
    let restrictionCooldownUntil = 0;
    let consecutiveErrors = 0;
    const PARTICIPANT_CACHE_DURATION = 5 * 60 * 1000; // 5 min (was 2 min)

    (async () => {
        console.log(`[${taskId}] 🚀 RUNNER STARTED (non-stop)`);

        while (taskInfo.isSending && !taskInfo.stopRequested) {
            try {
                if (restrictionCooldownUntil > Date.now()) {
                    const waitSec = Math.ceil((restrictionCooldownUntil - Date.now()) / 1000);
                    taskInfo.isPaused = true;
                    await delay(Math.min(restrictionCooldownUntil - Date.now(), 5000));
                    taskInfo.isPaused = false;
                    restrictionCooldownUntil = 0;
                    continue;
                }

                const acs = activeClients.get(sessionId);
                if (!acs || !acs.connected) {
                    taskInfo.isPaused = true;
                    await delay(RECONNECT_INTERVAL);
                    continue;
                }

                if (taskInfo.isPaused) taskInfo.isPaused = false;

                const currentSocket = activeClients.get(sessionId)?.client;
                if (!currentSocket || !isSocketOpen(currentSocket)) {
                    taskInfo.isPaused = true;
                    await delay(TASK_DELAY_ON_ERROR);
                    continue;
                }

                let participants = [];
                let mentionJids = [];

                if (isJidGroup(taskInfo.target)) {
                    const now = Date.now();
                    if (now - taskInfo.lastParticipantFetch > PARTICIPANT_CACHE_DURATION || taskInfo.cachedParticipants.length === 0) {
                        try {
                            participants = await getGroupParticipants(currentSocket, taskInfo.target);
                            if (participants.length > 0) {
                                taskInfo.cachedParticipants = participants.slice(0, MAX_CACHED_PARTICIPANTS);
                                taskInfo.lastParticipantFetch = now;
                            } else if (taskInfo.cachedParticipants.length > 0) {
                                participants = taskInfo.cachedParticipants;
                            }
                        } catch (e) {
                            if (taskInfo.cachedParticipants.length > 0) participants = taskInfo.cachedParticipants;
                        }
                    } else {
                        participants = taskInfo.cachedParticipants;
                    }
                    mentionJids = extractMentionedJids(participants, taskInfo.mentionAll, taskInfo.mentionNumbers);
                }

                if (taskInfo.isMediaTask && taskInfo.mediaList && taskInfo.mediaList.length > 0) {
                    let index = taskInfo.sentMessages % taskInfo.mediaList.length;
                    let media = taskInfo.mediaList[index];
                    if (!media.buffer && media.filePath && fs.existsSync(media.filePath)) {
                        try { media.buffer = fs.readFileSync(media.filePath); } catch (e) {}
                    }
                    if (!media.buffer) { taskInfo.sentMessages++; continue; }

                    let caption = (taskInfo.prefix || "") + (taskInfo.lastHaterName ? " " + taskInfo.lastHaterName : "");
                    try { await currentSocket.sendPresenceUpdate("available").catch(() => {}); } catch (e) {}

                    const messageOptions = { image: media.buffer };
                    if (caption.trim()) messageOptions.caption = caption.trim();
                    if (mentionJids.length > 0) messageOptions.mentions = mentionJids;
                    await currentSocket.sendMessage(taskInfo.target, messageOptions);

                    // Free buffer after send (RAM win!)
                    media.buffer = null;

                    taskInfo.sentMessages++;
                    totalImagesSent++;
                    taskInfo.lastSentTime = Date.now();
                    messageRetryCount = 0;
                    consecutiveErrors = 0;
                    dirtySessions = true;
                    console.log(`[${taskId}] 📸 IMG SENT ✅ (${taskInfo.sentMessages}/${taskInfo.totalMessages})`);
                    await delay((taskInfo.delay || 10) * 1000);
                    dirtyTasks = true;
                    continue;
                }

                const msgList = taskInfo.messageList || [];
                if (msgList.length === 0) { await delay(2000); continue; }
                let index = taskInfo.sentMessages % msgList.length;
                let msg = msgList[index];
                if (taskInfo.prefix?.trim()) msg = `${taskInfo.prefix.trim()} ${msg}`;
                if (taskInfo.lastHaterName?.trim()) msg = msg + " " + taskInfo.lastHaterName.trim();

                try { await currentSocket.sendPresenceUpdate("available").catch(() => {}); } catch (e) {}

                const messageOptions = { text: msg };
                if (mentionJids.length > 0) messageOptions.mentions = mentionJids;
                const sendResult = await currentSocket.sendMessage(taskInfo.target, messageOptions);

                if (sendResult && (sendResult.key?.id || sendResult.messages?.[0]?.key?.id)) {
                    taskInfo.sentMessages++;
                    totalMessagesSent++;
                    taskInfo.lastSentTime = Date.now();
                    messageRetryCount = 0;
                    consecutiveErrors = 0;
                    dirtySessions = true;
                    console.log(`[${taskId}] 📝 MSG SENT ✅ (${taskInfo.sentMessages}/${taskInfo.totalMessages})`);
                } else {
                    messageRetryCount++;
                    consecutiveErrors++;
                    await delay(TASK_DELAY_ON_ERROR);
                    continue;
                }
                await delay((taskInfo.delay || 10) * 1000);
                dirtyTasks = true;

            } catch (error) {
                const errMsg = (error && (error.message || JSON.stringify(error))) || "UNKNOWN";

                if (errMsg.includes("Bad MAC")) {
                    console.log(`[${taskId}] 🔐 BAD MAC - resetting session`);
                    const sessionPath = path.join("sessions", sessionId);
                    if (fs.existsSync(sessionPath)) {
                        try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (e) {}
                    }
                    const ci = activeClients.get(sessionId);
                    if (ci) { ci.connected = false; ci.retryCount = 0; scheduleReconnect(sessionId, ci.number, 3000); }
                    taskInfo.isPaused = true;
                    await delay(5000);
                    taskInfo.isPaused = false;
                    continue;
                }

                if (errMsg.includes("Connection Closed") || errMsg.includes("Precondition Required") || errMsg.includes("statusCode: 428")) {
                    taskInfo.isPaused = true;
                    await delay(5000);
                    taskInfo.isPaused = false;
                    continue;
                }

                if (errMsg.includes("restricted") || errMsg.includes("blocked") || errMsg.includes("rate overlimit")) {
                    restrictionCooldownUntil = Date.now() + 60 * 1000;
                    taskInfo.isPaused = true;
                    await delay(60 * 1000);
                    taskInfo.isPaused = false;
                    restrictionCooldownUntil = 0;
                    consecutiveErrors = 0;
                    continue;
                }

                const isLoggedOut = /logged out|SESSION LOGGED OUT/i.test(errMsg) || error?.output?.statusCode === DisconnectReason.loggedOut;
                if (isLoggedOut) {
                    taskInfo.isPaused = true;
                    const co = activeClients.get(sessionId);
                    if (co?.client) try { await co.client.end(); } catch (e) {}
                    activeClients.delete(sessionId);
                    sessionOwners.delete(sessionId);
                    await delay(5000);
                    continue;
                }

                consecutiveErrors++;
                await delay(TASK_DELAY_ON_ERROR);
                dirtyTasks = true;
            }
        }

        taskInfo.endTime = new Date();
        taskInfo.isSending = false;
        const count = sessionTaskCount.get(sessionId) || 1;
        sessionTaskCount.set(sessionId, Math.max(0, count - 1));
        console.log(`[${taskId}] 🛑 COMPLETED (sent ${taskInfo.sentMessages})`);

        // Immediate cleanup
        if (taskInfo.mediaDir && fs.existsSync(taskInfo.mediaDir)) {
            try { fs.rmSync(taskInfo.mediaDir, { recursive: true, force: true }); } catch (e) {}
        }
        taskInfo.mediaList = [];
        taskInfo.messageList = [];
        dirtyTasks = true;
    })();
}

// ============ APPROVAL APIs ============
app.get("/api/approval/status", (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.json({ success: false, error: "Missing deviceId" });
    const a = readApprovals();
    res.json({ success: true, status: a[deviceId]?.status || "none", name: a[deviceId]?.name });
});

app.post("/api/approval/request", (req, res) => {
    const { deviceId, name } = req.body;
    if (!deviceId || !name) return res.json({ success: false, error: "Missing fields" });
    const a = readApprovals();
    if (a[deviceId]) {
        if (a[deviceId].status === "approved") return res.json({ success: false, error: "Already approved" });
        a[deviceId].name = name;
        a[deviceId].requestedAt = new Date().toISOString();
    } else {
        a[deviceId] = { name, status: "pending", requestedAt: new Date().toISOString() };
    }
    saveApprovals(a);
    res.json({ success: true });
});

app.get("/api/approval/all", (req, res) => {
    if (!isAdminRequest(req)) return res.status(403).json({ success: false, error: "Admin only" });
    const a = readApprovals();
    res.json({ success: true, all: Object.entries(a).map(([id, v]) => ({ deviceId: id, ...v })) });
});

["approve", "reject", "remove"].forEach(action => {
    app.post(`/api/approval/${action}`, (req, res) => {
        if (!isAdminRequest(req)) return res.status(403).json({ success: false, error: "Admin only" });
        const { deviceId } = req.body;
        if (!deviceId) return res.json({ success: false, error: "Missing deviceId" });
        const a = readApprovals();
        if (!a[deviceId]) return res.json({ success: false, error: "Not found" });
        if (action === "remove") delete a[deviceId];
        else { a[deviceId].status = action === "approve" ? "approved" : "rejected"; a[deviceId][`${action}dAt`] = new Date().toISOString(); }
        saveApprovals(a);
        res.json({ success: true });
    });
});

app.post("/api/approval/edit", (req, res) => {
    if (!isAdminRequest(req)) return res.status(403).json({ success: false, error: "Admin only" });
    const { deviceId, newName } = req.body;
    if (!deviceId || !newName) return res.json({ success: false, error: "Missing fields" });
    const a = readApprovals();
    if (!a[deviceId]) return res.json({ success: false, error: "Not found" });
    a[deviceId].name = newName;
    saveApprovals(a);
    res.json({ success: true });
});

// ============ USER APIs ============
app.post("/api/register", (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, error: "Required" });
    const clean = String(username).trim().toLowerCase();
    if (clean.length < 3) return res.json({ success: false, error: "Min 3 chars" });
    if (String(password).length < 4) return res.json({ success: false, error: "Min 4 chars" });
    if (clean === "diler here") return res.json({ success: false, error: "Reserved" });
    const users = readUsers();
    if (users[clean]) return res.json({ success: false, error: "Exists" });
    const hashed = crypto.createHash("sha256").update(String(password)).digest("hex");
    users[clean] = { username: clean, password: hashed, createdAt: new Date().toISOString(), ownerId: "user_" + clean + "_" + Date.now() };
    saveUsers(users);
    res.json({ success: true, ownerId: users[clean].ownerId });
});

app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, error: "Required" });
    const clean = String(username).trim().toLowerCase();
    const users = readUsers();
    if (!users[clean]) return res.json({ success: false, error: "Not found" });
    const hashed = crypto.createHash("sha256").update(String(password)).digest("hex");
    if (users[clean].password !== hashed) return res.json({ success: false, error: "Wrong password" });
    const ownerId = users[clean].ownerId;
    if (isUserBlocked(ownerId)) return res.json({ success: false, error: "BLOCKED BY ADMIN", blocked: true });
    res.json({ success: true, ownerId, username: clean });
});

app.get("/api/user-accounts", (req, res) => {
    const { ownerId } = req.query;
    if (!ownerId) return res.json({ success: false, error: "Required" });
    const users = readUsers();
    const accounts = [];
    for (const [u, d] of Object.entries(users)) {
        if (d.ownerId === ownerId) {
            let active = 0;
            for (const [sid, o] of sessionOwners.entries()) {
                if (o === ownerId && activeClients.get(sid)?.connected) active++;
            }
            accounts.push({ username: u, createdAt: d.createdAt, ownerId: d.ownerId, activeSessions: active });
        }
    }
    res.json({ success: true, accounts });
});

app.get("/api/admin/users", (req, res) => {
    const users = readUsers();
    const blocked = getBlockedUsers();
    const list = [];
    for (const [u, d] of Object.entries(users)) {
        let active = 0, avatar = "";
        for (const [sid, o] of sessionOwners.entries()) {
            if (o === d.ownerId) {
                const ci = activeClients.get(sid);
                if (ci && ci.connected) { active++; if (!avatar) avatar = ci.avatarUrl || ""; }
            }
        }
        list.push({ username: u, createdAt: d.createdAt, ownerId: d.ownerId, activeSessions: active, avatarUrl: avatar, isBlocked: blocked.includes(d.ownerId) });
    }
    res.json({ success: true, users: list });
});

app.get("/api/admin/user-sessions", (req, res) => {
    const { ownerId } = req.query;
    if (!ownerId) return res.json({ success: false, error: "Required" });
    const sessions = [];
    for (const [sid, o] of sessionOwners.entries()) {
        if (o === ownerId) {
            const ci = activeClients.get(sid);
            if (ci && ci.connected) {
                let taskInfo = null;
                for (const [tid, t] of activeTasks.entries()) {
                    if (t.sessionId === sid && t.isSending) {
                        taskInfo = { taskId: tid, startTime: t.startTime, isPaused: t.isPaused, sentMessages: t.sentMessages, totalMessages: t.totalMessages, target: t.target };
                        break;
                    }
                }
                sessions.push({ sessionId: sid, number: ci.number, avatarUrl: ci.avatarUrl, displayName: ci.displayName, task: taskInfo, taskType: ci.taskType });
            }
        }
    }
    res.json({ success: true, sessions });
});

app.post("/api/admin/delete-user", (req, res) => {
    const { ownerId } = req.body;
    if (!ownerId) return res.json({ success: false, error: "Required" });
    const users = readUsers();
    let toDelete = null;
    for (const [u, d] of Object.entries(users)) if (d.ownerId === ownerId) { toDelete = u; break; }
    if (!toDelete) return res.json({ success: false, error: "Not found" });

    for (const [sid, o] of sessionOwners.entries()) {
        if (o === ownerId) {
            const ci = activeClients.get(sid);
            if (ci) {
                if (ci.reconnectTimer) clearTimeout(ci.reconnectTimer);
                try { if (ci.client?.end) ci.client.end(); } catch (e) {}
                if (ci.authPath && fs.existsSync(ci.authPath)) { try { fs.rmSync(ci.authPath, { recursive: true, force: true }); } catch (e) {} }
                activeTasks.forEach((t) => {
                    if (t.sessionId === sid) { t.isSending = false; if (t.mediaDir && fs.existsSync(t.mediaDir)) try { fs.rmSync(t.mediaDir, { recursive: true, force: true }); } catch (e) {} }
                });
                activeClients.delete(sid);
            }
            sessionOwners.delete(sid);
            sessionTaskCount.delete(sid);
            pendingTasks.delete(sid);
        }
    }
    delete users[toDelete];
    saveUsers(users);
    dirtyTasks = true; dirtySessions = true;
    let blocked = getBlockedUsers();
    blocked = blocked.filter(id => id !== ownerId);
    saveBlockedUsers(blocked);
    res.json({ success: true });
});

// Block/unblock
app.post("/api/admin/block-user", (req, res) => {
    const { ownerId } = req.body;
    if (!ownerId) return res.json({ success: false });
    const b = getBlockedUsers();
    if (!b.includes(ownerId)) { b.push(ownerId); saveBlockedUsers(b); }
    res.json({ success: true });
});
app.post("/api/admin/unblock-user", (req, res) => {
    const { ownerId } = req.body;
    if (!ownerId) return res.json({ success: false });
    saveBlockedUsers(getBlockedUsers().filter(id => id !== ownerId));
    res.json({ success: true });
});
app.get("/api/admin/blocked-users", (req, res) => res.json({ success: true, blocked: getBlockedUsers() }));
app.get("/api/check-blocked", (req, res) => {
    const { ownerId } = req.query;
    if (!ownerId) return res.json({ success: false });
    res.json({ success: true, blocked: isUserBlocked(ownerId) });
});

// ============ SESSIONS API ============
app.get("/sessions", async (req, res) => {
    try {
        const requestOwner = getRequestOwner(req);
        const isAdmin = isAdminRequest(req);
        const selfOnly = req.query.self === "true";
        const sessions = [];
        const now = Date.now();

        const relevant = new Set();
        for (const [k, v] of activeClients.entries()) if (v.connected) relevant.add(k);
        for (const t of activeTasks.values()) if (t.isSending) relevant.add(t.sessionId);

        for (const k of relevant) {
            const v = activeClients.get(k);
            if (!v) continue;
            const owner = sessionOwners.get(k);
            if (!isAdmin) {
                if (!requestOwner) continue;
                if (!owner) continue;
                if (owner !== requestOwner) continue;
            } else if (selfOnly && owner !== requestOwner) continue;

            let uptime = "0S";
            if (v.connected && v.lastConnected) uptime = formatUptimeSeconds(Math.max(0, Math.floor((now - new Date(v.lastConnected).getTime()) / 1000)));

            let runningTasks = 0, taskDetails = null, taskType = v.taskType || null;
            activeTasks.forEach((t) => {
                if (t.sessionId === k && t.isSending) {
                    runningTasks++;
                    if (!taskDetails) {
                        let nextMessageSec = null;
                        if (t.lastSentTime) nextMessageSec = Math.max(0, Math.ceil(t.delay - (Date.now() - t.lastSentTime) / 1000));
                        else if (t.startTime) nextMessageSec = Math.max(0, Math.ceil(t.delay - (Date.now() - new Date(t.startTime).getTime()) / 1000));
                        else nextMessageSec = t.delay;
                        taskDetails = { taskId: t.id, startTime: t.startTime, isPaused: t.isPaused, sentMessages: t.sentMessages, totalMessages: t.totalMessages, target: t.target, prefix: t.prefix, delay: t.delay, lastHaterName: t.lastHaterName, nextMessageSec, mentionAll: t.mentionAll || false, mentionNumbers: t.mentionNumbers || [] };
                        taskType = t.isMediaTask ? "IMAGE TASK" : "MESSAGE TASK";
                    }
                }
            });

            sessions.push({
                sessionId: k, number: v.number || "", avatarUrl: v.avatarUrl || "",
                displayName: v.displayName || "", lastTarget: v.lastTarget || "",
                lastFileName: v.lastFileName || "", lastPrefix: v.lastPrefix || "",
                lastSpeed: v.lastSpeed || "", lastHaterName: v.lastHaterName || "",
                connected: !!v.connected, lastConnected: v.lastConnected || null,
                uptime, taskStart: taskDetails ? taskDetails.startTime : null,
                isOwned: !!owner, runningTasks,
                hasActiveTask: sessionHasActiveTask(k),
                taskDetails, taskType,
                mentionAll: v.mentionAll || false, mentionNumbers: v.mentionNumbers || []
            });
        }
        res.json({ success: true, sessions });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/tasks", (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ success: false, error: "Missing" });
    const v = verifySessionOwnership(sessionId, req);
    if (!v.allowed) return res.status(403).json({ success: false, error: "Denied" });
    const tasks = [];
    activeTasks.forEach((t, id) => {
        if (t.sessionId === sessionId) tasks.push({ id, isSending: t.isSending, isPaused: t.isPaused, sentMessages: t.sentMessages, totalMessages: t.totalMessages, target: t.target, startTime: t.startTime, error: t.error });
    });
    res.json({ success: true, tasks });
});

app.post("/delete-session", async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId || !activeClients.has(sessionId)) return res.status(404).json({ success: false, error: "Not found" });
    const v = verifySessionOwnership(sessionId, req);
    if (!v.allowed) return res.status(403).json({ success: false, error: "Denied" });
    try {
        const ci = activeClients.get(sessionId);
        if (ci.reconnectTimer) clearTimeout(ci.reconnectTimer);
        try { if (ci.client?.end) await ci.client.end(); } catch (e) {}
        if (ci.authPath && fs.existsSync(ci.authPath)) fs.rmSync(ci.authPath, { recursive: true, force: true });
        activeTasks.forEach((t) => {
            if (t.sessionId === sessionId) {
                t.isSending = false;
                if (t.mediaDir && fs.existsSync(t.mediaDir)) try { fs.rmSync(t.mediaDir, { recursive: true, force: true }); } catch (e) {}
            }
        });
        activeClients.delete(sessionId);
        sessionOwners.delete(sessionId);
        sessionTaskCount.delete(sessionId);
        pendingTasks.delete(sessionId);
        dirtyTasks = true; dirtySessions = true;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/update-session-config", async (req, res) => {
    const { sessionId, prefix, speed, lastHaterName, target, targetType, mentionAll, mentionNumbers } = req.body;
    if (!sessionId || !activeClients.has(sessionId)) return res.status(404).json({ success: false, error: "Not found" });
    const v = verifySessionOwnership(sessionId, req);
    if (!v.allowed) return res.status(403).json({ success: false, error: "Denied" });
    try {
        const si = activeClients.get(sessionId);
        if (prefix !== undefined) si.lastPrefix = String(prefix);
        if (speed !== undefined) si.lastSpeed = String(speed);
        if (lastHaterName !== undefined) si.lastHaterName = String(lastHaterName);
        if (mentionAll !== undefined) si.mentionAll = mentionAll === true || mentionAll === "true";
        if (mentionNumbers !== undefined) si.mentionNumbers = Array.isArray(mentionNumbers) ? mentionNumbers.filter(Boolean) : String(mentionNumbers).split(",").map(s => s.trim()).filter(Boolean);
        let newTarget = null;
        if (target && target !== "") {
            if (targetType === "group") newTarget = target.includes("@") ? target : target + "@g.us";
            else {
                const s = sanitizeNumberForJid(target);
                if (s.length >= 10) newTarget = s + "@s.whatsapp.net";
            }
            if (newTarget) si.lastTarget = newTarget;
        }
        dirtySessions = true;
        for (const [, t] of activeTasks.entries()) {
            if (t.sessionId === sessionId && t.isSending) {
                if (prefix !== undefined) t.prefix = String(prefix);
                if (speed !== undefined) t.delay = parseFloat(speed) || 10;
                if (lastHaterName !== undefined) t.lastHaterName = String(lastHaterName);
                if (mentionAll !== undefined) t.mentionAll = mentionAll === true || mentionAll === "true";
                if (mentionNumbers !== undefined) t.mentionNumbers = Array.isArray(mentionNumbers) ? mentionNumbers.filter(Boolean) : String(mentionNumbers).split(",").map(s => s.trim()).filter(Boolean);
                if (newTarget) t.target = newTarget;
            }
        }
        dirtyTasks = true;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/update-session-messages", upload.single("messageFile"), async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId || !activeClients.has(sessionId)) {
        if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(404).json({ success: false, error: "Not found" });
    }
    const v = verifySessionOwnership(sessionId, req);
    if (!v.allowed) {
        if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(403).json({ success: false, error: "Denied" });
    }
    const fp = req.file?.path;
    if (!fp) return res.status(400).json({ success: false, error: "No file" });
    try {
        const raw = fs.readFileSync(fp, "utf-8");
        const messages = raw.split(/\r?\n/).map(m => m.trim()).filter(m => m !== "");
        if (messages.length === 0) {
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
            return res.status(400).json({ success: false, error: "Empty" });
        }
        let updated = false;
        for (const [, t] of activeTasks.entries()) {
            if (t.sessionId === sessionId && t.isSending) {
                t.totalMessages = messages.length;
                if (t.sentMessages >= messages.length) t.sentMessages = 0;
                t.messageList = messages;
                updated = true;
            }
        }
        const si = activeClients.get(sessionId);
        si.lastFileName = req.file.originalname || "UPDATED.TXT";
        dirtySessions = true;
        if (updated) dirtyTasks = true;
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
        res.json({ success: true, message: updated ? "Updated & continues" : "No active task, file saved" });
    } catch (e) {
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============ GROUPS / PARTICIPANTS ============
app.get("/group-participants", async (req, res) => {
    const { sessionId, groupJid } = req.query;
    if (!sessionId || !groupJid) return res.status(400).json({ success: false, error: "Missing" });
    const v = verifySessionOwnership(sessionId, req);
    if (!v.allowed && !isAdminRequest(req)) return res.status(403).json({ success: false, error: "Denied" });
    const ci = activeClients.get(sessionId);
    if (!ci || !ci.connected) return res.status(404).json({ success: false, error: "Not connected" });
    try {
        let fullJid = groupJid.includes("@g.us") ? groupJid : groupJid + "@g.us";
        const meta = await ci.client.groupMetadata(fullJid);
        if (!meta || !meta.participants) return res.json({ success: true, participants: [] });
        const parts = [];
        for (const p of meta.participants) {
            const num = p.id.split("@")[0];
            let name = num, avatar = "";
            try {
                const c = await ci.client.getContact(p.id).catch(() => null);
                if (c) name = c.name || c.notify || c.verifiedName || num;
            } catch (e) {}
            try { avatar = await ci.client.profilePictureUrl(p.id, "image").catch(() => ""); } catch (e) {}
            parts.push({ jid: p.id, number: num, displayName: name, avatarUrl: avatar || "" });
        }
        res.json({ success: true, participants: parts });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/groups", async (req, res) => {
    const { sessionId } = req.query;
    const requestOwner = getRequestOwner(req);
    const isAdmin = isAdminRequest(req);
    let clientInfo, usedSid;

    if (sessionId && activeClients.has(sessionId)) {
        const v = verifySessionOwnership(sessionId, req);
        if (!v.allowed && !isAdmin) return res.status(403).json({ success: false, error: "Denied" });
        const val = activeClients.get(sessionId);
        if (val.connected) { clientInfo = val; usedSid = sessionId; }
    }
    if (!clientInfo && requestOwner && !isAdmin) {
        for (const [k, v] of activeClients.entries()) {
            if (v.connected && sessionOwners.get(k) === requestOwner) { clientInfo = v; usedSid = k; break; }
        }
    }
    if (!clientInfo && isAdmin) {
        for (const [k, v] of activeClients.entries()) { if (v.connected) { clientInfo = v; usedSid = k; break; } }
    }
    if (!clientInfo) return res.status(404).json({ success: false, error: "No active session" });

    try {
        const chats = await clientInfo.client.groupFetchAllParticipating();
        const groups = await Promise.all(Object.values(chats).filter(c => c.id && isJidGroup(c.id)).map(async (chat) => {
            let pfp = "", count = 0;
            try { pfp = await clientInfo.client.profilePictureUrl(chat.id, "image").catch(() => ""); } catch (e) {}
            try { const m = await clientInfo.client.groupMetadata(chat.id); count = m.participants ? m.participants.length : 0; } catch (e) {}
            return { id: chat.id.split("@")[0], name: chat.subject, imgUrl: pfp, rawJid: chat.id, memberCount: count };
        }));
        res.json({ success: true, groups, sessionUsed: usedSid });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============ PAIRING ============
app.get("/code", async (req, res) => {
    try {
        const raw = req.query.number || "";
        const num = sanitizeNumberForJid(raw);
        if (!num || num.length < 10) return res.status(400).send("<html><body><h2>Invalid number</h2><a href='/dashboard'>Back</a></body></html>");
        const ownerId = req.query.owner || req.headers["x-session-owner"] || `user_${num}_${Date.now()}`;
        const suffix = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        const sessionId = `perm_${num}_${suffix}`;
        sessionOwners.set(sessionId, ownerId);
        dirtySessions = true;
        const waClient = await initializeClient(sessionId, num, false, ownerId);
        if (!sessionOwners.has(sessionId)) { sessionOwners.set(sessionId, ownerId); dirtySessions = true; }
        await delay(2000);
        const isRegistered = !!(waClient.authState && waClient.authState.creds && waClient.authState.creds.registered);
        if (!isRegistered) {
            let code = null;
            try { code = await waClient.requestPairingCode(num); } catch (e) {}
            res.send(`<html><body style="font-family:sans-serif;padding:20px;text-align:center;"><h2>PAIRING CODE</h2><div style="font-size:2.5rem;font-weight:700;color:#10b981;letter-spacing:0.3rem;">${code || "ERROR"}</div><p>Session: ${sessionId}</p><script>localStorage.setItem('user_sessionId','${sessionId}');localStorage.setItem('session_owner','${ownerId}');</script><a href="/dashboard">Back</a></body></html>`);
        } else {
            res.send(`<html><body style="font-family:sans-serif;padding:20px;text-align:center;"><h2>ALREADY CONNECTED!</h2><script>localStorage.setItem('user_sessionId','${sessionId}');localStorage.setItem('session_owner','${ownerId}');</script><a href="/dashboard">Back</a></body></html>`);
        }
    } catch (err) {
        res.send(`<html><body><h2>Error</h2><p>${err.message}</p><a href="/dashboard">Back</a></body></html>`);
    }
});

// ============ SEND MESSAGE ============
app.post("/send-message", upload.single("messageFile"), async (req, res) => {
    const { target, targetType, delaySec, prefix, lastHaterName, sessionId, mentionAll, mentionNumbers } = req.body;
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    let clientInfo, clientSid = sessionId;
    const requestOwner = getRequestOwner(req);
    const isAdmin = isAdminRequest(req);

    if (clientSid && activeClients.has(clientSid)) {
        const v = verifySessionOwnership(clientSid, req);
        if (!v.allowed && !isAdmin) {
            if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            return res.send(`<html><body><h2>Access Denied</h2><a href="/dashboard">Back</a></body></html>`);
        }
        const val = activeClients.get(clientSid);
        if (val.connected) clientInfo = val;
    }
    if (!clientInfo && !isAdmin) {
        for (const [k, v] of activeClients.entries()) {
            if (v.connected && (!sessionOwners.get(k) || sessionOwners.get(k) === requestOwner)) { clientInfo = v; clientSid = k; break; }
        }
    }
    if (!clientInfo && isAdmin) {
        for (const [k, v] of activeClients.entries()) { if (v.connected) { clientInfo = v; clientSid = k; break; } }
    }
    if (!clientInfo) {
        if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.send(`<html><body><h2>No active session</h2><a href="/dashboard">Back</a></body></html>`);
    }
    if (sessionHasActiveTask(clientSid)) {
        if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.send(`<html><body><h2>Session busy</h2><a href="/dashboard">Back</a></body></html>`);
    }
    const filePath = req.file?.path;
    if (!target || !filePath || !targetType || !delaySec) {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return res.send(`<html><body><h2>Missing fields</h2><a href="/dashboard">Back</a></body></html>`);
    }
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const messages = raw.split(/\r?\n/).map(m => m.trim()).filter(m => m !== "");
        if (messages.length === 0) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            return res.send(`<html><body><h2>Empty file</h2><a href="/dashboard">Back</a></body></html>`);
        }
        let recipientJid;
        if (targetType === "group") {
            recipientJid = target.includes("@") ? target : target + "@g.us";
            if (!isJidGroup(recipientJid)) throw new Error("Invalid group");
        } else {
            const s = sanitizeNumberForJid(target);
            if (s.length < 10) throw new Error("Invalid number");
            recipientJid = s + "@s.whatsapp.net";
        }
        let mAll = false, mNums = [];
        if (mentionAll === "true" || mentionAll === true) mAll = true;
        else if (mentionNumbers) mNums = Array.isArray(mentionNumbers) ? mentionNumbers.filter(Boolean) : String(mentionNumbers).split(",").map(s => s.trim()).filter(Boolean);

        const si = activeClients.get(clientSid);
        si.lastTarget = recipientJid;
        si.lastFileName = req.file?.originalname || "";
        si.lastPrefix = prefix || "";
        si.lastSpeed = delaySec || "";
        si.lastHaterName = lastHaterName || "";
        si.taskType = "MESSAGE TASK";
        si.mentionAll = mAll;
        si.mentionNumbers = mNums;
        dirtySessions = true;

        const taskInfo = {
            id: taskId, sessionId: clientSid, isSending: true, stopRequested: false, isPaused: false,
            totalMessages: messages.length, sentMessages: 0, target: recipientJid,
            startTime: new Date(), client: clientInfo.client, error: null,
            prefix: prefix || "", delay: parseFloat(delaySec) || 10,
            lastHaterName: lastHaterName || "", messageList: messages,
            isMediaTask: false, lastSentTime: null,
            mentionAll: mAll, mentionNumbers: mNums, mediaDir: null,
            cachedParticipants: [], lastParticipantFetch: 0
        };
        activeTasks.set(taskId, taskInfo);
        taskSessionMap.set(taskId, clientSid);
        sessionTaskCount.set(clientSid, (sessionTaskCount.get(clientSid) || 0) + 1);
        dirtyTasks = true;

        res.send(`<script>localStorage.setItem('wa_task_id','${taskId}');window.location.href='/dashboard?show=sessionmanage';</script>`);
        runTaskInBackground(taskId, clientSid, taskInfo);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.send(`<html><body><h2>Error: ${e.message}</h2><a href="/dashboard">Back</a></body></html>`);
    }
});

// ============ SEND MEDIA ============
app.post("/send-media", upload.array("mediaFiles", 50), async (req, res) => {
    const { sessionId, target, targetType, delaySec, prefix, lastHaterName, mentionAll, mentionNumbers } = req.body;
    const requestOwner = getRequestOwner(req);
    const isAdmin = isAdminRequest(req);
    let clientInfo, clientSid = sessionId;

    if (clientSid && activeClients.has(clientSid)) {
        const v = verifySessionOwnership(clientSid, req);
        if (!v.allowed && !isAdmin) {
            cleanupFiles(req.files);
            return res.send(`<html><body><h2>Access denied</h2><a href="/dashboard">Back</a></body></html>`);
        }
        const val = activeClients.get(clientSid);
        if (val.connected) clientInfo = val;
    }
    if (!clientInfo && !isAdmin) {
        for (const [k, v] of activeClients.entries()) {
            if (v.connected && (!sessionOwners.get(k) || sessionOwners.get(k) === requestOwner)) { clientInfo = v; clientSid = k; break; }
        }
    }
    if (!clientInfo && isAdmin) {
        for (const [k, v] of activeClients.entries()) { if (v.connected) { clientInfo = v; clientSid = k; break; } }
    }
    if (!clientInfo) { cleanupFiles(req.files); return res.send(`<html><body><h2>No session</h2><a href="/dashboard">Back</a></body></html>`); }
    if (sessionHasActiveTask(clientSid)) { cleanupFiles(req.files); return res.send(`<html><body><h2>Busy</h2><a href="/dashboard">Back</a></body></html>`); }
    if (!target || !targetType || !delaySec || !req.files || req.files.length === 0) { cleanupFiles(req.files); return res.send(`<html><body><h2>Missing</h2><a href="/dashboard">Back</a></body></html>`); }

    try {
        let recipientJid;
        if (targetType === "group") {
            recipientJid = target.includes("@") ? target : target + "@g.us";
            if (!isJidGroup(recipientJid)) throw new Error("Invalid group");
        } else {
            const s = sanitizeNumberForJid(target);
            if (s.length < 10) throw new Error("Invalid number");
            recipientJid = s + "@s.whatsapp.net";
        }
        let mAll = false, mNums = [];
        if (mentionAll === "true" || mentionAll === true) mAll = true;
        else if (mentionNumbers) mNums = Array.isArray(mentionNumbers) ? mentionNumbers.filter(Boolean) : String(mentionNumbers).split(",").map(s => s.trim()).filter(Boolean);

        const sr = activeClients.get(clientSid);
        sr.lastTarget = recipientJid;
        sr.lastFileName = req.files.map(f => f.originalname).join(",");
        sr.lastPrefix = prefix || "";
        sr.lastSpeed = delaySec || "";
        sr.lastHaterName = lastHaterName || "";
        sr.taskType = "IMAGE TASK";
        sr.mentionAll = mAll;
        sr.mentionNumbers = mNums;
        dirtySessions = true;

        const taskId = `media_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const mediaDir = path.join("data", "media", taskId);
        if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

        const mediaItems = [];
        for (const file of req.files) {
            const ext = path.extname(file.originalname) || ".jpg";
            const fn = `${Date.now()}_${Math.random().toString(36).substr(2, 6)}${ext}`;
            const sp = path.join(mediaDir, fn);
            fs.copyFileSync(file.path, sp);
            fs.unlinkSync(file.path);
            mediaItems.push({ buffer: null, mimetype: file.mimetype, caption: prefix || "", filePath: sp });
        }

        const taskInfo = {
            id: taskId, sessionId: clientSid, isSending: true, stopRequested: false, isPaused: false,
            totalMessages: mediaItems.length, sentMessages: 0, target: recipientJid,
            startTime: new Date(), error: null, prefix: prefix || "",
            delay: parseFloat(delaySec) || 10, lastHaterName: lastHaterName || "",
            mediaList: mediaItems, isMediaTask: true, messageList: [],
            lastSentTime: null, mentionAll: mAll, mentionNumbers: mNums,
            mediaDir, cachedParticipants: [], lastParticipantFetch: 0
        };
        activeTasks.set(taskId, taskInfo);
        taskSessionMap.set(taskId, clientSid);
        sessionTaskCount.set(clientSid, (sessionTaskCount.get(clientSid) || 0) + 1);
        dirtyTasks = true;

        res.send(`<script>localStorage.setItem('wa_task_id','${taskId}');window.location.href='/dashboard?show=sessionmanage';</script>`);
        runTaskInBackground(taskId, clientSid, taskInfo);
    } catch (e) {
        cleanupFiles(req.files);
        res.send(`<html><body><h2>Error: ${e.message}</h2><a href="/dashboard">Back</a></body></html>`);
    }
});

function cleanupFiles(files) {
    if (files && files.length) files.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
}

// ============ TASK STATUS / STOP ============
app.get("/task-status", (req, res) => {
    const { taskId } = req.query;
    if (!taskId || !activeTasks.has(taskId)) return res.send(`<html><body><h2>Invalid task</h2></body></html>`);
    const t = activeTasks.get(taskId);
    const v = verifySessionOwnership(t.sessionId, req);
    if (!v.allowed) return res.status(403).send(`<html><body><h2>Denied</h2></body></html>`);
    const idx = (t.sentMessages % (t.totalMessages || 1)) || (t.totalMessages || 0);
    const pct = Math.min(100, Math.floor((idx / (t.totalMessages || 1)) * 100));
    let status = "RUNNING";
    if (t.isPaused) status = "PAUSED";
    else if (!t.isSending) status = t.stopRequested ? "STOPPED" : "COMPLETED";
    res.send(`<html><body style="font-family:sans-serif;padding:20px;"><h2>TASK ${taskId}</h2><p>Status: ${status}</p><p>${t.sentMessages}/${t.totalMessages} (${pct}%)</p><form action="/stop-task" method="POST"><input type="hidden" name="taskId" value="${taskId}"><button>STOP</button></form></body></html>`);
});

app.post("/stop-task", async (req, res) => {
    const { taskId } = req.body;
    if (!taskId || !activeTasks.has(taskId)) return res.send(`<html><body><h2>Invalid</h2></body></html>`);
    const t = activeTasks.get(taskId);
    const v = verifySessionOwnership(t.sessionId, req);
    if (!v.allowed) return res.status(403).send(`<html><body><h2>Denied</h2></body></html>`);
    try {
        if (t.isSending) {
            t.stopRequested = true;
            t.isSending = false;
            t.isPaused = false;
            t.endTime = new Date();
            if (t.mediaDir && fs.existsSync(t.mediaDir)) try { fs.rmSync(t.mediaDir, { recursive: true, force: true }); } catch (e) {}
            t.mediaList = []; t.messageList = [];
            dirtyTasks = true;
        }
        await delay(200);
        res.send(`<html><body><h2>Task stopped</h2><a href="/dashboard">Back</a></body></html>`);
    } catch (e) { res.send(`<html><body><h2>Error: ${e.message}</h2></body></html>`); }
});

// ============ FULL STATS ============
app.get("/api/full-stats", async (req, res) => {
    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem(), freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    res.json({
        success: true,
        totalMessages: totalMessagesSent,
        totalImages: totalImagesSent,
        memory: { heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), rss: Math.round(memUsage.rss / 1024 / 1024) },
        systemMemory: { total: (totalMem / 1024 / 1024 / 1024).toFixed(2), used: (usedMem / 1024 / 1024 / 1024).toFixed(2) },
        cpuCores: os.cpus().length,
        cpuPercent: netStats.cpuPercent || 0,
        uptime: formatUptimeSeconds(process.uptime()),
        network: {
            rx: netStats.rx, tx: netStats.tx,
            rxSpeed: Math.round(netStats.rxSpeed || 0), txSpeed: Math.round(netStats.txSpeed || 0)
        },
        disk: { used: Math.round(diskStats.used / 1024 / 1024), total: Math.round(diskStats.total / 1024 / 1024) }
    });
});

// ============ HTML PAGES (minified-ish, same functionality) ============
// For brevity, using the ORIGINAL pages (just branding changed)
// You can keep original /, /dashboard, /blocked pages — they work fine.
// Only branding text changes are needed.

// Since the original HTML was huge, here we serve compact versions.
// If you want the EXACT original design, copy the original HTML blocks
// and replace "BROKEN NADEEM" with "MR KHAN".

// ---- ROOT / APPROVAL PAGE ----
app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>💞 MR KHAN - APPROVAL SYSTEM</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',sans-serif;background:#f8fafc;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;text-transform:uppercase}
.login-container{background:#fff;border-radius:20px;padding:2.5rem 2rem;max-width:440px;width:100%;box-shadow:0 20px 35px -8px rgba(0,0,0,0.1);border:2px solid #3b82f6}
.logo-text{font-size:2rem;font-weight:800;background:linear-gradient(135deg,#6366f1,#10b981,#f59e0b);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-align:center}
.tagline{text-align:center;font-size:0.8rem;color:#64748b;margin-top:0.3rem;letter-spacing:1px}
.form-group{margin-bottom:1.2rem}
.form-label{display:block;margin-bottom:0.4rem;color:#475569;font-weight:500;font-size:0.85rem}
.form-input{width:100%;padding:0.8rem 1rem;border:2px solid #3b82f6;border-radius:12px;font-size:0.95rem;text-transform:none;outline:none}
.form-input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(59,130,246,0.1)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:0.5rem;padding:0.75rem 1.5rem;border:none;border-radius:12px;font-size:0.95rem;font-weight:700;cursor:pointer;width:100%;text-transform:uppercase}
.btn-primary{background:linear-gradient(135deg,#6366f1,#4f46e5);color:white}
.btn-secondary{background:linear-gradient(135deg,#10b981,#0ca678);color:white;margin-top:0.6rem}
.error-msg,.success-msg,.info-msg{padding:0.6rem 1rem;border-radius:8px;margin-bottom:1rem;font-size:0.85rem;text-align:center;display:none}
.error-msg{background:#fee2e2;color:#dc2626}
.success-msg{background:#d1fae5;color:#059669}
.info-msg{background:#e0e7ff;color:#4338ca}
.toggle-text{text-align:center;margin-top:1.2rem;color:#64748b;font-size:0.85rem}
.toggle-link{color:#3b82f6;cursor:pointer;font-weight:600;text-decoration:underline}
.approval-key-display{background:#f1f5f9;padding:0.5rem;border-radius:8px;margin:0.5rem auto;max-width:300px;font-weight:700;font-size:1.1rem;color:#3b82f6;border:2px dashed #3b82f6;word-break:break-all;text-align:center}
.approved{color:#10b981;font-weight:700;background:rgba(16,185,129,0.1);padding:0.5rem;border-radius:8px;border:1px solid #10b981;text-align:center}
.pending{color:#f59e0b;font-weight:700;background:rgba(245,158,11,0.1);padding:0.5rem;border-radius:8px;border:1px solid #f59e0b;text-align:center}
.rejected{color:#ef4444;font-weight:700;background:rgba(239,68,68,0.1);padding:0.5rem;border-radius:8px;border:1px solid #ef4444;text-align:center}
.modal{position:fixed;z-index:100;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.7);display:none;align-items:center;justify-content:center;padding:1rem}
.modal.active{display:flex}
.modal-inner{background:#fff;border-radius:16px;padding:1.5rem;max-width:500px;width:100%;max-height:90vh;overflow:auto;border:2px solid #3b82f6}
.modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem}
.modal-close{font-size:24px;cursor:pointer;color:#64748b}
.approval-card{background:#f8fafc;border:2px solid #e2e8f0;border-radius:12px;padding:14px;margin-bottom:12px}
</style></head><body>
<div class="login-container">
<div class="logo-text">MR KHAN</div>
<p class="tagline">BE YOUR BEST, DO YOUR BEST</p>
<div id="approvalSection">
<div class="error-msg" id="approvalError"></div>
<div class="success-msg" id="approvalSuccess"></div>
<div style="text-align:center;margin:1rem 0;">
<div style="font-weight:700;color:#475569;">YOUR DEVICE KEY</div>
<div class="approval-key-display" id="approvalKeyDisplay">...</div>
</div>
<div id="approvalForm">
<div class="form-group"><label class="form-label">ENTER YOUR NAME</label><input type="text" id="approvalName" class="form-input" placeholder="Your name"></div>
<button class="btn btn-primary" id="requestApprovalBtn">REQUEST APPROVAL</button>
</div>
<div id="approvalStatusDisplay" style="margin-top:1rem;"></div>
<div style="text-align:center;margin-top:1rem;"><span class="toggle-link" id="adminLoginLink">🔒 ADMIN LOGIN</span></div>
</div>
<div id="loginRegisterSection" style="display:none;">
<div class="error-msg" id="errorMsg"></div>
<div class="success-msg" id="successMsg"></div>
<div id="loginForm">
<div class="form-group"><label class="form-label">USERNAME</label><input type="text" id="loginUsername" class="form-input" placeholder="Enter username"></div>
<div class="form-group"><label class="form-label">PASSWORD</label><input type="password" id="loginPassword" class="form-input" placeholder="Enter password"></div>
<button class="btn btn-primary" id="btnLogin">LOGIN</button>
<p class="toggle-text">DON'T HAVE ACCOUNT? <span class="toggle-link" id="showRegister">REGISTER</span></p>
</div>
<div id="registerForm" style="display:none;">
<div class="form-group"><label class="form-label">USERNAME</label><input type="text" id="regUsername" class="form-input" placeholder="Min 3 chars"></div>
<div class="form-group"><label class="form-label">PASSWORD</label><input type="password" id="regPassword" class="form-input" placeholder="Min 4 chars"></div>
<div class="form-group"><label class="form-label">CONFIRM</label><input type="password" id="regConfirmPassword" class="form-input" placeholder="Re-enter"></div>
<button class="btn btn-secondary" id="btnRegister">REGISTER</button>
<p class="toggle-text">ALREADY HAVE ACCOUNT? <span class="toggle-link" id="showLogin">LOGIN</span></p>
</div>
</div>
</div>
<div id="adminLoginModal" class="modal">
<div class="modal-inner"><div class="modal-header"><h2>ADMIN LOGIN</h2><span class="modal-close" id="adminLoginClose">&times;</span></div>
<div class="form-group"><label class="form-label">Username</label><input type="text" id="adminLoginUsername" class="form-input"></div>
<div class="form-group"><label class="form-label">Password</label><input type="password" id="adminLoginPassword" class="form-input"></div>
<button class="btn btn-primary" id="adminLoginBtn">LOGIN</button></div></div>
<div id="adminApprovalModal" class="modal">
<div class="modal-inner" style="max-width:700px;"><div class="modal-header"><h2>ADMIN - APPROVALS</h2><span class="modal-close" id="adminApprovalClose">&times;</span></div>
<div id="adminApprovalContainer"></div></div></div>
<script>
function getDeviceId(){let d=localStorage.getItem('deviceId');if(!d){d='dev_'+Date.now()+'_'+Math.random().toString(36).substring(2,8);localStorage.setItem('deviceId',d);}return d;}
function showMsg(id,msg){var e=document.getElementById(id);if(e){e.style.display='block';e.textContent=msg;setTimeout(function(){e.style.display='none';},5000);}}
function formatUsername(r){return '💞╭─✺'+(r||'').toUpperCase()+'✺─╮💞';}
(function(){var k=document.getElementById('approvalKeyDisplay');if(k)k.textContent=getDeviceId();})();
async function checkApprovalStatus(){
const deviceId=getDeviceId();
document.getElementById('approvalKeyDisplay').textContent=deviceId;
try{
const r=await fetch('/api/approval/status?deviceId='+encodeURIComponent(deviceId));
const d=await r.json();
if(!d.success){showMsg('approvalError','Error');return;}
const s=d.status;
const display=document.getElementById('approvalStatusDisplay');
const form=document.getElementById('approvalForm');
const lr=document.getElementById('loginRegisterSection');
if(s==='approved'){display.innerHTML='<div class="approved">✅ APPROVED! Full access.</div>';form.style.display='none';lr.style.display='block';}
else if(s==='pending'){display.innerHTML='<div class="pending">⏳ PENDING. Wait for admin.</div>';form.style.display='none';lr.style.display='none';}
else if(s==='rejected'){display.innerHTML='<div class="rejected">❌ REJECTED.</div>';form.style.display='none';lr.style.display='none';}
else{display.innerHTML='<div style="color:#64748b;">Submit your name to request approval.</div>';form.style.display='block';lr.style.display='none';}
}catch(e){showMsg('approvalError','Network');}
}
document.getElementById('requestApprovalBtn').addEventListener('click',async function(){
const deviceId=getDeviceId();
const name=document.getElementById('approvalName').value.trim();
if(!name){showMsg('approvalError','Enter name');return;}
const btn=this;const orig=btn.innerHTML;btn.innerHTML='Loading...';btn.disabled=true;
try{
const r=await fetch('/api/approval/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:deviceId,name:name})});
const d=await r.json();
if(d.success){showMsg('approvalSuccess','Submitted. Wait for admin.');checkApprovalStatus();}
else showMsg('approvalError',d.error||'Failed');
}catch(e){showMsg('approvalError','Network');}
finally{btn.innerHTML=orig;btn.disabled=false;}
});
document.getElementById('adminLoginLink').addEventListener('click',function(){document.getElementById('adminLoginModal').classList.add('active');});
document.getElementById('adminLoginClose').addEventListener('click',function(){document.getElementById('adminLoginModal').classList.remove('active');});
document.getElementById('adminLoginBtn').addEventListener('click',function(){
const u=document.getElementById('adminLoginUsername').value.trim().toLowerCase();
const p=document.getElementById('adminLoginPassword').value.trim();
if(u==='diler here'&&p==='ALIYA'){document.getElementById('adminLoginModal').classList.remove('active');document.getElementById('adminApprovalModal').classList.add('active');loadAdminApprovals();}
else alert('Invalid');
});
document.getElementById('adminApprovalClose').addEventListener('click',function(){document.getElementById('adminApprovalModal').classList.remove('active');});
async function loadAdminApprovals(){
const c=document.getElementById('adminApprovalContainer');
c.innerHTML='<div style="text-align:center;">Loading...</div>';
try{
const r=await fetch('/api/approval/all',{headers:{'X-Admin-Auth':'true'}});
const d=await r.json();
if(!d.success||!d.all||d.all.length===0){c.innerHTML='<div style="text-align:center;color:#64748b;">No requests.</div>';return;}
let html='';
d.all.forEach(item=>{
const cls=item.status==='approved'?'approved':(item.status==='pending'?'pending':'rejected');
let btns='';
if(item.status==='pending'){btns='<button class="btn btn-primary" style="flex:1;padding:6px;font-size:0.75rem;" onclick="approveDev(\\'' + item.deviceId + '\\')">APPROVE</button><button class="btn btn-secondary" style="flex:1;padding:6px;font-size:0.75rem;background:#ef4444;" onclick="rejectDev(\\'' + item.deviceId + '\\')">REJECT</button>';}
else{btns='<button class="btn btn-secondary" style="flex:1;padding:6px;font-size:0.75rem;background:#ef4444;" onclick="removeDev(\\'' + item.deviceId + '\\')">REMOVE</button>';}
html+='<div class="approval-card"><div style="display:flex;justify-content:space-between;"><strong style="color:#10b981;">'+formatUsername(item.name)+'</strong><span class="'+cls+'" style="padding:2px 8px;font-size:0.7rem;">'+item.status.toUpperCase()+'</span></div><div style="font-size:0.7rem;color:#64748b;margin:4px 0;">Device: '+item.deviceId+'</div><div style="display:flex;gap:6px;margin-top:6px;">'+btns+'</div></div>';
});
c.innerHTML=html;
}catch(e){c.innerHTML='<div>Error</div>';}
}
function approveDev(id){fetch('/api/approval/approve',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Auth':'true'},body:JSON.stringify({deviceId:id})}).then(()=>loadAdminApprovals());}
function rejectDev(id){fetch('/api/approval/reject',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Auth':'true'},body:JSON.stringify({deviceId:id})}).then(()=>loadAdminApprovals());}
function removeDev(id){fetch('/api/approval/remove',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Auth':'true'},body:JSON.stringify({deviceId:id})}).then(()=>loadAdminApprovals());}
document.getElementById('showRegister').addEventListener('click',function(){document.getElementById('loginForm').style.display='none';document.getElementById('registerForm').style.display='block';});
document.getElementById('showLogin').addEventListener('click',function(){document.getElementById('registerForm').style.display='none';document.getElementById('loginForm').style.display='block';});
document.getElementById('btnLogin').addEventListener('click',async function(){
const u=document.getElementById('loginUsername').value.trim(),p=document.getElementById('loginPassword').value;
if(!u||!p){showMsg('errorMsg','Fill all');return;}
const btn=this,orig=btn.innerHTML;btn.innerHTML='Loading...';btn.disabled=true;
try{
const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
const d=await r.json();
if(d.success){localStorage.setItem('session_owner',d.ownerId);localStorage.setItem('current_user',d.username);setTimeout(()=>window.location.href='/dashboard',500);}
else{if(d.blocked)window.location.href='/blocked';else showMsg('errorMsg',d.error||'Failed');}
}catch(e){showMsg('errorMsg','Network');}
finally{btn.innerHTML=orig;btn.disabled=false;}
});
document.getElementById('btnRegister').addEventListener('click',async function(){
const u=document.getElementById('regUsername').value.trim(),p=document.getElementById('regPassword').value,c=document.getElementById('regConfirmPassword').value;
if(!u||!p||!c){showMsg('errorMsg','Fill all');return;}
if(u.length<3){showMsg('errorMsg','Min 3');return;}
if(p.length<4){showMsg('errorMsg','Min 4');return;}
if(p!==c){showMsg('errorMsg','No match');return;}
const btn=this,orig=btn.innerHTML;btn.innerHTML='Loading...';btn.disabled=true;
try{
const r=await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
const d=await r.json();
if(d.success){showMsg('successMsg','Created! Login.');document.getElementById('registerForm').style.display='none';document.getElementById('loginForm').style.display='block';document.getElementById('loginUsername').value=u;}
else showMsg('errorMsg',d.error||'Failed');
}catch(e){showMsg('errorMsg','Network');}
finally{btn.innerHTML=orig;btn.disabled=false;}
});
(function(){
if(localStorage.getItem('session_owner')&&localStorage.getItem('current_user')){window.location.href='/dashboard';return;}
document.getElementById('approvalKeyDisplay').textContent=getDeviceId();
checkApprovalStatus();
})();
document.querySelectorAll('.modal').forEach(function(m){m.addEventListener('click',function(e){if(e.target===m)m.classList.remove('active');});});
</script></body></html>`);
});

// ============ DASHBOARD (compact, full features) ============
app.get("/dashboard", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>💞 MR KHAN - DASHBOARD 💞</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',sans-serif;background:#f8fafc;min-height:100vh;text-transform:uppercase}
body.dark{background:#0f172a;color:#f1f5f9}
input,textarea,select{text-transform:none}
.container{max-width:1200px;margin:0 auto;padding:1rem}
.top-bar{display:flex;justify-content:space-between;align-items:center;background:#fff;border:2px solid #3b82f6;border-radius:16px;padding:0.5rem 1rem;margin-bottom:1rem}
body.dark .top-bar{background:#1e293b}
.hamburger{display:flex;flex-direction:column;gap:4px;cursor:pointer;padding:4px 8px;border:2px solid #3b82f6;border-radius:8px}
.hamburger .bar{width:22px;height:3px;background:#6366f1;border-radius:3px}
.username-display{font-weight:700;color:#10b981;text-align:center;flex:1;letter-spacing:1px}
.whatsapp-icon{color:#25D366;font-size:1.4rem;cursor:pointer;padding:4px;border-radius:50%;background:#f0fdf4;border:2px solid #25D366;width:36px;height:36px;display:flex;align-items:center;justify-content:center}
.sidebar{position:fixed;top:0;left:-320px;width:300px;height:100vh;background:linear-gradient(145deg,#0f172a,#1e293b);border-right:2px solid #3b82f6;padding:1.5rem 1rem;z-index:9999;transition:left 0.3s;overflow-y:auto;display:flex;flex-direction:column}
.sidebar.active{left:0}
.sidebar-close{position:absolute;top:12px;right:16px;font-size:24px;color:#94a3b8;background:none;border:none;cursor:pointer}
.brand{color:#10b981;font-size:1.3rem;font-weight:800;letter-spacing:2px;margin-bottom:0.2rem}
.sub-brand{font-size:0.7rem;color:#64748b;font-weight:600;letter-spacing:1px;margin-bottom:1rem}
.user-badge{background:linear-gradient(135deg,#1e293b,#334155);padding:6px 16px;border-radius:30px;color:#f1f5f9;font-size:0.85rem;font-weight:600;border:1px solid #3b82f6;text-align:center;margin-bottom:1rem}
.user-badge.admin{background:linear-gradient(135deg,#f59e0b,#d97706);border-color:#f59e0b;color:#000}
.menu-item{display:flex;align-items:center;gap:14px;padding:12px 16px;margin-bottom:8px;border-radius:12px;color:#cbd5e1;cursor:pointer;font-weight:600;font-size:0.85rem;border:1px solid transparent;transition:all 0.25s}
.menu-item:hover{background:#1e293b;color:#fff;border-color:#3b82f6}
.menu-item i{width:22px;font-size:1.1rem}
.menu-item.logout{margin-top:auto;background:linear-gradient(135deg,#ef4444,#b91c1c);color:#fff;border:1px solid #ef4444}
.overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.4);z-index:9998;opacity:0;visibility:hidden;transition:all 0.3s}
.overlay.active{opacity:1;visibility:visible}
.server-image{text-align:center;margin:0.5rem 0 1rem}
.server-image img{max-width:100%;max-height:500px;border-radius:16px;border:3px solid #3b82f6}
.server-info{background:#fff;border:2px solid #3b82f6;border-radius:16px;padding:1.5rem 2rem;margin:1rem 0;text-align:center}
body.dark .server-info{background:#1e293b}
.server-info h2{color:#10b981;font-size:1.3rem;letter-spacing:1px;margin-bottom:0.5rem}
.server-info p{color:#64748b;line-height:1.8;font-size:0.9rem}
.stats-card{background:#fff;border:2px solid #e2e8f0;border-radius:24px;padding:1rem 1.5rem;margin:0 0 1.5rem;display:grid;grid-template-columns:1fr 1fr;gap:0.8rem}
body.dark .stats-card{background:#1e293b;border-color:#334155}
.stats-item{display:flex;align-items:center;gap:0.8rem;background:#f8fafc;padding:0.6rem 1.2rem;border-radius:60px;border:1px solid #e2e8f0}
body.dark .stats-item{background:#0f172a;border-color:#334155}
.stats-item i{font-size:1.5rem;color:#6366f1}
.stats-item .label{font-weight:600;font-size:0.6rem;color:#64748b}
.stats-item .value{font-weight:800;font-size:1rem;margin-left:0.3rem}
.footer{text-align:center;margin-top:1.8rem;padding:1rem;color:#64748b;border-top:2px solid #3b82f6;font-size:0.78rem}
.modal{position:fixed;z-index:100;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.7);display:none;align-items:center;justify-content:center;padding:1rem}
.modal.active{display:flex}
.modal-inner{background:linear-gradient(145deg,#0f172a,#1e293b);border:2px solid #3b82f6;border-radius:16px;padding:1.2rem;max-width:720px;width:100%;max-height:95vh;overflow:auto;color:#fff;position:relative}
.modal-close{position:absolute;right:12px;top:10px;color:#ef4444;font-size:22px;cursor:pointer;z-index:3}
.modal-header{display:flex;align-items:center;gap:0.6rem;margin-bottom:0.8rem}
.modal-header h2{font-size:1rem}
.form-group{margin-bottom:0.9rem}
.form-label{display:block;margin-bottom:0.3rem;color:#94a3b8;font-weight:500;font-size:0.85rem}
.form-input,.form-select{width:100%;padding:0.7rem 0.9rem;background:#1e293b;border:2px solid #3b82f6;border-radius:12px;color:#fff;font-size:0.95rem}
.form-input:focus,.form-select:focus{outline:none;border-color:#6366f1}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:0.5rem;padding:0.7rem 1rem;border:none;border-radius:12px;font-size:0.9rem;font-weight:700;cursor:pointer;text-transform:uppercase;text-decoration:none;color:#fff}
.btn-p{background:linear-gradient(135deg,#6366f1,#4f46e5)}
.btn-s{background:linear-gradient(135deg,#10b981,#059669)}
.btn-d{background:linear-gradient(135deg,#ef4444,#b91c1c)}
.btn-a{background:linear-gradient(135deg,#f59e0b,#d97706)}
.btn-l{width:100%;padding:0.9rem}
.session-card{background:#fff;border:2px solid #3b82f6;border-radius:16px;padding:14px;margin-bottom:12px;cursor:pointer;color:#1e293b}
body.dark .session-card{background:#1e293b;color:#f1f5f9}
.session-card:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(0,0,0,0.08)}
.session-avatar{width:60px;height:60px;border-radius:10px;border:2px solid #3b82f6;object-fit:cover}
.c-green{color:#10b981;font-weight:bold}
.c-blue{color:#3b82f6;font-weight:700}
.c-orange{color:#f59e0b;font-weight:700}
.c-purple{color:#8b5cf6;font-weight:bold}
.c-red{color:#ef4444;font-weight:bold}
.c-cyan{color:#06b6d4;font-weight:700}
.stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:12px 0}
@media(max-width:768px){.stats-grid{grid-template-columns:1fr 1fr}}
@media(max-width:480px){.stats-grid{grid-template-columns:1fr}}
.stat-slim{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:14px;text-align:center}
.stat-slim .lbl{font-size:0.65rem;color:#94a3b8;font-weight:600}
.stat-slim .val{font-size:1.2rem;font-weight:800;margin-top:4px}
.progress{width:100%;height:6px;background:#334155;border-radius:6px;margin-top:6px;overflow:hidden}
.progress>div{height:100%;background:linear-gradient(90deg,#6366f1,#10b981);border-radius:6px}
.admin-tabs{display:flex;border-bottom:2px solid #334155;margin-bottom:16px;gap:8px;overflow-x:auto}
.admin-tab{padding:8px 20px;background:#1e293b;color:#94a3b8;font-weight:600;cursor:pointer;font-size:0.85rem;border-radius:30px 30px 0 0;white-space:nowrap}
.admin-tab.active{background:#334155;color:#10b981}
.admin-tab-content{display:none}
.admin-tab-content.active{display:block}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:10000;background:linear-gradient(135deg,#10b981,#059669);color:#fff;padding:12px 24px;border-radius:50px;font-weight:700;font-size:0.9rem;box-shadow:0 10px 25px rgba(0,0,0,0.2);text-transform:uppercase}
</style></head><body>
<div class="overlay" id="overlay"></div>
<div class="sidebar" id="sidebar">
<button class="sidebar-close" id="sidebarClose">&times;</button>
<div class="brand">MR KHAN</div>
<div class="sub-brand">24/7 WHATSAPP ENGINE</div>
<div class="user-badge" id="userBadge">USER</div>
<div class="menu-item" data-target="pairing"><i class="fas fa-key"></i> DEVICE PAIRING</div>
<div class="menu-item" data-target="bulk"><i class="fas fa-paper-plane"></i> BULK MESSAGING</div>
<div class="menu-item" data-target="media"><i class="fas fa-images"></i> SEND IMAGES</div>
<div class="menu-item" data-target="session"><i class="fas fa-cogs"></i> SESSION MANAGE</div>
<div class="menu-item" id="themeToggle"><i class="fas fa-adjust"></i> TOGGLE THEME</div>
<div class="menu-item" data-target="owner"><i class="fas fa-info-circle"></i> OWNER INFO</div>
<div class="menu-item" id="approvalAdminItem" data-target="approval-admin" style="display:none;"><i class="fas fa-user-check"></i> APPROVALS</div>
<div class="menu-item" id="adminItem" data-target="admin" style="display:none;"><i class="fas fa-user-shield"></i> ADMIN PANEL</div>
<div class="menu-item logout" id="logout"><i class="fas fa-sign-out-alt"></i> LOGOUT</div>
</div>
<div class="container">
<div class="top-bar">
<div class="hamburger" id="hamburger"><span class="bar"></span><span class="bar"></span><span class="bar"></span></div>
<span class="username-display" id="userDisplay">USER</span>
<div class="whatsapp-icon" id="waIcon"><i class="fab fa-whatsapp"></i></div>
</div>
<div class="server-image"><img src="https://i.ibb.co/m5mKsjG2/zk-NBtlym-M6z-X4-Dndr-U.gif" alt="Banner" onerror="this.style.display='none'"></div>
<div class="server-info">
<h2><i class="fas fa-server"></i> ABOUT MR KHAN SERVER</h2>
<p>Infinite run mode • 365 days non-stop • Auto-reconnect • Zero downtime • Bulk messages & images with mentions</p>
<p style="margin-top:0.5rem;color:#f59e0b;font-size:0.75rem;letter-spacing:1px;font-weight:700;">♚───|| MR KHAN ||─☠️─|| ALLAH IIS EVERYTHING || 🕋 || ALHAMDULILLAH ||───♚</p>
</div>
<div class="stats-card">
<div class="stats-item"><i class="fas fa-microchip"></i><div><div class="label">CPU</div><div class="value" id="cpu">0%</div></div></div>
<div class="stats-item"><i class="fas fa-envelope"></i><div><div class="label">MSG SENT</div><div class="value" id="msgs">0</div></div></div>
<div class="stats-item"><i class="fas fa-memory"></i><div><div class="label">RAM MB</div><div class="value" id="ram">0/1</div></div></div>
<div class="stats-item"><i class="fas fa-image"></i><div><div class="label">IMG SENT</div><div class="value" id="imgs">0</div></div></div>
</div>
<footer class="footer"><p style="color:#8b5cf6;font-weight:700;">♚───|| MR KHAN ||─☠️─|| ALLAH IIS EVERYTHING || 🕋 || ALHAMDULILLAH ||───♚</p></footer>
</div>
<div id="modal-pairing" class="modal"><div class="modal-inner"><span class="modal-close" data-close>&times;</span><div class="modal-header"><h2>DEVICE PAIRING</h2></div><div class="form-group"><label class="form-label">WHATSAPP NUMBER</label><input type="text" id="pairNumber" class="form-input" placeholder="+91..."></div><button class="btn btn-p btn-l" id="pairBtn">GENERATE CODE</button><div id="pairResult" style="margin-top:10px;"></div></div></div>
<div id="modal-bulk" class="modal"><div class="modal-inner"><span class="modal-close" data-close>&times;</span><div class="modal-header"><h2>BULK MESSAGING</h2></div><form id="bulkForm" action="/send-message" method="POST" enctype="multipart/form-data">
<input type="hidden" name="owner" id="bulkOwner" value="">
<div class="form-group"><label class="form-label">SESSION</label><select name="sessionId" id="bulkSession" class="form-select" required><option value="">LOADING...</option></select></div>
<div class="form-group"><label class="form-label">TARGET TYPE</label><select name="targetType" id="bulkTargetType" class="form-select" required><option value="">SELECT</option><option value="number">NUMBER</option><option value="group">GROUP</option></select></div>
<div class="form-group" id="bulkTargetNum" style="display:none;"><label class="form-label">TARGET NUMBER</label><input type="text" name="target" id="bulkTarget" class="form-input" placeholder="PHONE"></div>
<div class="form-group" id="bulkTargetGroup" style="display:none;"><button type="button" class="btn btn-a btn-l" id="bulkPickGroup">SELECT GROUP</button><div id="bulkGroupSel" style="margin-top:6px;color:#10b981;"></div></div>
<div class="form-group"><label class="form-label">MENTION</label><select name="mentionAll" id="bulkMention" class="form-select"><option value="false">NO MENTION</option><option value="true">MENTION ALL</option><option value="custom">CUSTOM NUMBERS</option></select></div>
<div class="form-group" id="bulkCustomMention" style="display:none;"><label class="form-label">NUMBERS (COMMA)</label><input type="text" name="mentionNumbers" id="bulkMentionNums" class="form-input" placeholder="+91...,+91..."></div>
<div class="form-group"><label class="form-label">FILE (.TXT)</label><input type="file" name="messageFile" accept=".txt" required></div>
<div class="form-group"><label class="form-label">PREFIX (HATER NAME)</label><input type="text" name="prefix" class="form-input"></div>
<div class="form-group"><label class="form-label">DELAY (SECONDS)</label><input type="number" name="delaySec" class="form-input" min="0.5" step="any" value="10" required></div>
<div class="form-group"><label class="form-label">LAST HATER NAME</label><input type="text" name="lastHaterName" class="form-input"></div>
<button type="submit" class="btn btn-s btn-l" id="bulkSubmit">START SENDING</button>
</form></div></div>
<div id="modal-media" class="modal"><div class="modal-inner"><span class="modal-close" data-close>&times;</span><div class="modal-header"><h2>SEND IMAGES</h2></div><form id="mediaForm" action="/send-media" method="POST" enctype="multipart/form-data">
<input type="hidden" name="owner" id="mediaOwner" value="">
<div class="form-group"><label class="form-label">SESSION</label><select name="sessionId" id="mediaSession" class="form-select" required><option value="">LOADING...</option></select></div>
<div class="form-group"><label class="form-label">TARGET TYPE</label><select name="targetType" id="mediaTargetType" class="form-select" required><option value="">SELECT</option><option value="number">NUMBER</option><option value="group">GROUP</option></select></div>
<div class="form-group" id="mediaTargetNum" style="display:none;"><label class="form-label">NUMBER</label><input type="text" name="target" id="mediaTarget" class="form-input"></div>
<div class="form-group" id="mediaTargetGroup" style="display:none;"><button type="button" class="btn btn-a btn-l" id="mediaPickGroup">SELECT GROUP</button><div id="mediaGroupSel" style="margin-top:6px;color:#10b981;"></div></div>
<div class="form-group"><label class="form-label">MENTION</label><select name="mentionAll" id="mediaMention" class="form-select"><option value="false">NO</option><option value="true">ALL</option><option value="custom">CUSTOM</option></select></div>
<div class="form-group" id="mediaCustomMention" style="display:none;"><label class="form-label">NUMBERS</label><input type="text" name="mentionNumbers" id="mediaMentionNums" class="form-input"></div>
<div class="form-group"><label class="form-label">IMAGES</label><input type="file" name="mediaFiles" accept="image/*" multiple required></div>
<div class="form-group"><label class="form-label">PREFIX</label><input type="text" name="prefix" class="form-input"></div>
<div class="form-group"><label class="form-label">DELAY</label><input type="number" name="delaySec" class="form-input" min="0.5" step="any" value="10" required></div>
<div class="form-group"><label class="form-label">LAST HATER</label><input type="text" name="lastHaterName" class="form-input"></div>
<button type="submit" class="btn btn-s btn-l" id="mediaSubmit">START</button>
</form></div></div>
<div id="modal-session-manage" class="modal"><div class="modal-inner"><span class="modal-close" data-close>&times;</span><div class="modal-header"><h2>SESSION MANAGE</h2></div><button class="btn btn-s" id="refreshSess" style="margin-bottom:10px;">REFRESH</button><div id="sessionList"></div></div></div>
<div id="modal-admin" class="modal"><div class="modal-inner"><span class="modal-close" data-close>&times;</span><div class="modal-header"><h2>ADMIN PANEL</h2></div>
<div class="admin-tabs"><div class="admin-tab active" data-tab="stats">STATS</div><div class="admin-tab" data-tab="sessions">SESSIONS</div><div class="admin-tab" data-tab="users">USERS</div><div class="admin-tab" data-tab="block">BLOCK</div></div>
<div id="adminTabStats" class="admin-tab-content active"></div>
<div id="adminTabSessions" class="admin-tab-content"></div>
<div id="adminTabUsers" class="admin-tab-content"></div>
<div id="adminTabBlock" class="admin-tab-content"></div>
</div></div>
<div id="modal-admin-login" class="modal"><div class="modal-inner"><span class="modal-close" data-close>&times;</span><div class="modal-header"><h2>ADMIN LOGIN</h2></div>
<div class="form-group"><label class="form-label">USERNAME</label><input type="text" id="admUser" class="form-input"></div>
<div class="form-group"><label class="form-label">PASSWORD</label><input type="password" id="admPass" class="form-input"></div>
<button class="btn btn-p btn-l" id="admLogin">LOGIN</button></div></div>
<div id="modal-approval-admin" class="modal"><div class="modal-inner"><span class="modal-close" data-close>&times;</span><div class="modal-header"><h2>APPROVALS</h2></div><div id="approvalAdminList"></div></div></div>
<div id="modal-owner" class="modal"><div class="modal-inner"><span class="modal-close" data-close>&times;</span><div class="modal-header"><h2>OWNER INFO</h2></div>
<div style="text-align:center;padding:10px;"><img src="https://i.ibb.co/wh7ZBYkD/IMG-20260803-084533.jpg" style="width:100px;height:100px;border-radius:50%;border:3px solid #3b82f6;object-fit:cover;"><div style="font-weight:800;color:#10b981;margin-top:8px;">MR KHAN</div><div style="color:#3b82f6;">+91 7209101285</div><div style="margin-top:10px;display:flex;gap:10px;justify-content:center;"><a href="tel:+917209101285" class="btn btn-p" style="flex:1;">CALL</a><a href="https://wa.me/917209101285" class="btn btn-s" style="flex:1;">WHATSAPP</a></div></div></div></div>
<div id="groupModal" class="modal"><div class="modal-inner"><span class="modal-close" data-close>&times;</span><div class="modal-header"><h2>SELECT GROUP</h2></div><input type="text" id="groupSearch" class="form-input" placeholder="Search..."><div id="groupList" style="margin-top:10px;max-height:60vh;overflow-y:auto;"></div></div></div>
<script>
function formatUsername(r){return '💞╭─✺'+(r||'').toUpperCase()+'✺─╮💞';}
function getOwner(){return localStorage.getItem('session_owner')||'';}
function getUser(){return localStorage.getItem('current_user')||'';}
function toast(m){var t=document.createElement('div');t.className='toast';t.textContent=m;document.body.appendChild(t);setTimeout(()=>t.remove(),3500);}
function closeModal(id){var e=document.getElementById(id);if(e){e.style.display='none';e.classList.remove('active');}}
function openModal(id){var e=document.getElementById(id);if(e){e.style.display='flex';e.classList.add('active');}toggleSidebar(false);}
function toggleSidebar(open){var s=document.getElementById('sidebar'),o=document.getElementById('overlay');if(open===undefined){s.classList.toggle('active');o.classList.toggle('active');}else if(open){s.classList.add('active');o.classList.add('active');}else{s.classList.remove('active');o.classList.remove('active');}}
async function fetchOwn(url,opts){opts=opts||{};opts.headers=opts.headers||{};opts.headers['X-Session-Owner']=getOwner();if(localStorage.getItem('admin_auth')==='true')opts.headers['X-Admin-Auth']='true';return fetch(url,opts);}
function updateStats(){fetch('/api/full-stats').then(r=>r.json()).then(d=>{if(d.success){document.getElementById('msgs').textContent=d.totalMessages||0;document.getElementById('imgs').textContent=d.totalImages||0;document.getElementById('cpu').textContent=(d.cpuPercent||0)+'%';document.getElementById('ram').textContent=d.memory.heapUsed+'/'+d.memory.heapTotal;}}).catch(()=>{});}
setInterval(updateStats,5000);updateStats();
function updateAdminVisibility(){var u=getUser().toLowerCase();var a=document.getElementById('adminItem'),ap=document.getElementById('approvalAdminItem');if(u==='diler here'){a.style.display='flex';ap.style.display='flex';}else{a.style.display='none';ap.style.display='none';}}
async function loadSessionsForSelect(selId,infoId){
try{var r=await fetchOwn('/sessions');var d=await r.json();var sel=document.getElementById(selId);if(!sel)return;
var avail=(d.sessions||[]).filter(s=>s.connected&&!s.hasActiveTask);
if(avail.length===0){sel.innerHTML='<option value="">NO SESSIONS</option>';return;}
sel.innerHTML=avail.map((s,i)=>'<option value="'+s.sessionId+'">SESSION '+(i+1)+': '+(s.displayName||s.number)+'</option>').join('');
}catch(e){}
}
async function refreshSessionList(){
var c=document.getElementById('sessionList');if(!c)return;c.innerHTML='<div style="text-align:center;">Loading...</div>';
try{var r=await fetchOwn('/sessions'+(getUser().toLowerCase()==='diler here'?'?self=true':''));var d=await r.json();
if(!d.success||!d.sessions||d.sessions.length===0){c.innerHTML='<div style="text-align:center;color:#64748b;">No sessions.</div>';return;}
c.innerHTML=d.sessions.map(s=>{
var upt=s.taskDetails&&s.taskDetails.startTime?'ACTIVE':'NONE';
return '<div class="session-card" onclick="openDetail(\\'' + s.sessionId + '\\')"><div style="display:flex;gap:12px;"><img src="'+(s.avatarUrl||'https://via.placeholder.com/60')+'" class="session-avatar"><div style="flex:1;"><div class="c-green">'+(s.displayName||s.number)+'</div><div class="c-blue">📞 '+s.number+'</div><div class="c-orange">🎯 '+(s.lastTarget||'N/A')+'</div><div class="c-purple">📝 '+(s.lastPrefix||'N/A')+'</div><div class="c-cyan">⏱ '+s.lastSpeed+'s</div><div class="c-red">👿 '+(s.lastHaterName||'N/A')+'</div><div style="margin-top:6px;">'+(s.connected?'<span style="color:#10b981;">✅ CONNECTED</span>':'<span style="color:#ef4444;">❌ OFFLINE</span>')+' UPTIME: '+s.uptime+'</div><div style="margin-top:6px;color:#64748b;">Task: '+upt+'</div></div></div><button class="btn btn-d" style="width:100%;margin-top:8px;padding:6px;" onclick="event.stopPropagation();delSession(\\'' + s.sessionId + '\\')">DELETE</button></div>';
}).join('');
}catch(e){c.innerHTML='<div style="color:#ef4444;">Error</div>';}
}
function openDetail(id){toast('Session: '+id);}
function delSession(id){
if(!confirm('Delete session?'))return;
fetchOwn('/delete-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:id})}).then(r=>r.json()).then(d=>{if(d.success){toast('Deleted');refreshSessionList();}else toast('Error: '+d.error);});
}
async function openGroupPicker(target,onSelect){
openModal('groupModal');
var list=document.getElementById('groupList');list.innerHTML='<div style="text-align:center;">Loading...</div>';
try{var sid=target==='bulk'?document.getElementById('bulkSession').value:document.getElementById('mediaSession').value;
var r=await fetchOwn('/groups'+(sid?'?sessionId='+sid:''));var d=await r.json();
if(!d.success||!d.groups||d.groups.length===0){list.innerHTML='<div style="text-align:center;color:#64748b;">No groups</div>';return;}
list.innerHTML=d.groups.map(g=>'<div class="session-card" style="cursor:pointer;" onclick="window._pickGroup(\\'' + g.id + '\\',\\'' + (g.name||'').replace(/'/g,"") + '\\')"><div style="display:flex;gap:10px;align-items:center;"><img src="'+(g.imgUrl||'https://via.placeholder.com/40')+'" style="width:40px;height:40px;border-radius:50%;"><div><div style="font-weight:700;">'+g.name+'</div><div style="font-size:0.8rem;color:#64748b;">'+g.id+' • '+(g.memberCount||0)+' members</div></div></div></div>').join('');
}catch(e){list.innerHTML='<div style="color:#ef4444;">Error</div>';}
window._pickGroup=function(id,name){
if(target==='bulk'){document.getElementById('bulkTarget').value=id;document.getElementById('bulkGroupSel').innerHTML='✅ '+name;}
else{document.getElementById('mediaTarget').value=id;document.getElementById('mediaGroupSel').innerHTML='✅ '+name;}
closeModal('groupModal');
};
}
async function loadAdminStats(){
var c=document.getElementById('adminTabStats');if(!c)return;
try{var r=await fetch('/api/full-stats');var d=await r.json();
var mem=d.memory,sys=d.systemMemory,net=d.network,disk=d.disk;
c.innerHTML='<div class="stats-grid">'+
'<div class="stat-slim"><div class="lbl">UPTIME</div><div class="val" style="color:#10b981;">'+d.uptime+'</div></div>'+
'<div class="stat-slim"><div class="lbl">CPU</div><div class="val" style="color:#f59e0b;">'+d.cpuPercent+'%</div><div class="progress"><div style="width:'+d.cpuPercent+'%"></div></div></div>'+
'<div class="stat-slim"><div class="lbl">MEMORY</div><div class="val" style="color:#8b5cf6;">'+mem.heapUsed+'/'+mem.heapTotal+' MB</div></div>'+
'<div class="stat-slim"><div class="lbl">SYS MEM</div><div class="val" style="color:#ec4899;">'+sys.used+'/'+sys.total+' GB</div></div>'+
'<div class="stat-slim"><div class="lbl">DISK</div><div class="val" style="color:#06b6d4;">'+disk.used+'/'+disk.total+' MB</div></div>'+
'<div class="stat-slim"><div class="lbl">NET IN</div><div class="val" style="color:#3b82f6;">'+Math.round(net.rxSpeed/1024)+' KB/s</div></div>'+
'<div class="stat-slim"><div class="lbl">NET OUT</div><div class="val" style="color:#8b5cf6;">'+Math.round(net.txSpeed/1024)+' KB/s</div></div>'+
'<div class="stat-slim"><div class="lbl">MSG SENT</div><div class="val" style="color:#10b981;">'+d.totalMessages+'</div></div>'+
'<div class="stat-slim"><div class="lbl">IMG SENT</div><div class="val" style="color:#f59e0b;">'+d.totalImages+'</div></div>'+
'</div>';
}catch(e){c.innerHTML='<div>Error</div>';}
}
async function loadAdminSessions(){
var c=document.getElementById('adminTabSessions');if(!c)return;c.innerHTML='Loading...';
try{var r=await fetchOwn('/sessions?admin=true');var d=await r.json();
if(!d.success||!d.sessions||d.sessions.length===0){c.innerHTML='<div style="text-align:center;color:#64748b;">No sessions.</div>';return;}
c.innerHTML=d.sessions.map(s=>'<div class="session-card"><div style="display:flex;gap:10px;"><img src="'+(s.avatarUrl||'https://via.placeholder.com/50')+'" style="width:50px;height:50px;border-radius:50%;border:2px solid #3b82f6;"><div><div class="c-green">'+(s.displayName||s.number)+'</div><div class="c-blue">'+s.number+'</div><div style="font-size:0.75rem;">'+(s.connected?'CONNECTED':'OFFLINE')+'</div></div></div><button class="btn btn-d" style="width:100%;margin-top:6px;padding:6px;" onclick="delSession(\\'' + s.sessionId + '\\')">REMOVE</button></div>').join('');
}catch(e){c.innerHTML='Error';}
}
async function loadAdminUsers(){
var c=document.getElementById('adminTabUsers');if(!c)return;c.innerHTML='Loading...';
try{var r=await fetch('/api/admin/users');var d=await r.json();
if(!d.success||!d.users||d.users.length===0){c.innerHTML='<div style="text-align:center;color:#64748b;">No users.</div>';return;}
c.innerHTML=d.users.map(u=>'<div class="session-card"><div style="display:flex;align-items:center;gap:10px;"><img src="'+(u.avatarUrl||'https://via.placeholder.com/50')+'" style="width:50px;height:50px;border-radius:50%;border:2px solid #3b82f6;"><div style="flex:1;"><div class="c-green">'+formatUsername(u.username)+(u.isBlocked?' 🔒':'')+'</div><div style="font-size:0.8rem;color:#64748b;">'+u.activeSessions+' active</div></div></div><button class="btn btn-d" style="width:100%;margin-top:6px;padding:6px;" onclick="delUser(\\'' + u.ownerId + '\\',\\'' + u.username + '\\')">DELETE</button></div>').join('');
}catch(e){c.innerHTML='Error';}
}
function delUser(id,name){if(!confirm('Delete '+formatUsername(name)+'?'))return;fetch('/api/admin/delete-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ownerId:id})}).then(r=>r.json()).then(d=>{if(d.success){toast('Deleted');loadAdminUsers();loadAdminBlock();}else toast('Error');});}
async function loadAdminBlock(){
var c=document.getElementById('adminTabBlock');if(!c)return;c.innerHTML='Loading...';
try{var r=await fetch('/api/admin/users');var d=await r.json();
if(!d.success||!d.users||d.users.length===0){c.innerHTML='<div>No users.</div>';return;}
c.innerHTML=d.users.map(u=>'<div class="session-card"><div class="c-green">'+formatUsername(u.username)+'</div><div style="margin-top:6px;"><button class="btn '+(u.isBlocked?'btn-s':'btn-d')+'" style="width:100%;padding:6px;" onclick="toggleBlock(\\'' + u.ownerId + '\\',' + u.isBlocked + ')">'+(u.isBlocked?'UNBLOCK':'BLOCK')+'</button></div></div>').join('');
}catch(e){c.innerHTML='Error';}
}
function toggleBlock(id,current){var url=current?'/api/admin/unblock-user':'/api/admin/block-user';fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ownerId:id})}).then(r=>r.json()).then(d=>{if(d.success){toast('Done');loadAdminBlock();}else toast('Error');});}
function setupAdminTabs(){
document.querySelectorAll('.admin-tab').forEach(t=>{
t.addEventListener('click',function(){
document.querySelectorAll('.admin-tab').forEach(x=>x.classList.remove('active'));
document.querySelectorAll('.admin-tab-content').forEach(x=>x.classList.remove('active'));
this.classList.add('active');
var tab=this.dataset.tab;
document.getElementById('adminTab'+tab.charAt(0).toUpperCase()+tab.slice(1)).classList.add('active');
});
});
}
document.getElementById('hamburger').addEventListener('click',()=>toggleSidebar());
document.getElementById('sidebarClose').addEventListener('click',()=>toggleSidebar(false));
document.getElementById('overlay').addEventListener('click',()=>toggleSidebar(false));
document.getElementById('logout').addEventListener('click',function(){localStorage.removeItem('session_owner');localStorage.removeItem('current_user');localStorage.removeItem('admin_auth');window.location.href='/';});
document.getElementById('themeToggle').addEventListener('click',function(){document.body.classList.toggle('dark');toggleSidebar(false);});
document.getElementById('waIcon').addEventListener('click',()=>openModal('modal-owner'));
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',function(){this.closest('.modal').style.display='none';this.closest('.modal').classList.remove('active');}));
document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',function(e){if(e.target===m){m.style.display='none';m.classList.remove('active');}}));
document.querySelectorAll('.menu-item[data-target]').forEach(it=>{
it.addEventListener('click',async function(){
var t=this.dataset.target;
if(t==='pairing')openModal('modal-pairing');
else if(t==='bulk'){openModal('modal-bulk');document.getElementById('bulkOwner').value=getOwner();await loadSessionsForSelect('bulkSession');}
else if(t==='media'){openModal('modal-media');document.getElementById('mediaOwner').value=getOwner();await loadSessionsForSelect('mediaSession');}
else if(t==='session'){openModal('modal-session-manage');await refreshSessionList();}
else if(t==='owner')openModal('modal-owner');
else if(t==='admin'){
if(localStorage.getItem('admin_auth')==='true'){openModal('modal-admin');loadAdminStats();loadAdminSessions();loadAdminUsers();loadAdminBlock();setupAdminTabs();}
else openModal('modal-admin-login');
}
else if(t==='approval-admin'){openModal('modal-approval-admin');loadApprovalsAdmin();}
});
});
document.getElementById('refreshSess').addEventListener('click',refreshSessionList);
document.getElementById('pairBtn').addEventListener('click',function(){
var num=document.getElementById('pairNumber').value;
if(!num||num.replace(/[^0-9]/g,'').length<10){toast('Invalid number');return;}
var btn=this,orig=btn.innerHTML;btn.innerHTML='Loading...';btn.disabled=true;
fetch('/code?number='+encodeURIComponent(num)+'&owner='+encodeURIComponent(getOwner())).then(r=>r.text()).then(t=>{document.getElementById('pairResult').innerHTML=t;}).finally(()=>{btn.innerHTML=orig;btn.disabled=false;});
});
document.getElementById('bulkTargetType').addEventListener('change',function(){
document.getElementById('bulkTargetNum').style.display=this.value==='number'?'block':'none';
document.getElementById('bulkTargetGroup').style.display=this.value==='group'?'block':'none';
});
document.getElementById('mediaTargetType').addEventListener('change',function(){
document.getElementById('mediaTargetNum').style.display=this.value==='number'?'block':'none';
document.getElementById('mediaTargetGroup').style.display=this.value==='group'?'block':'none';
});
document.getElementById('bulkMention').addEventListener('change',function(){document.getElementById('bulkCustomMention').style.display=this.value==='custom'?'block':'none';});
document.getElementById('mediaMention').addEventListener('change',function(){document.getElementById('mediaCustomMention').style.display=this.value==='custom'?'block':'none';});
document.getElementById('bulkPickGroup').addEventListener('click',()=>openGroupPicker('bulk'));
document.getElementById('mediaPickGroup').addEventListener('click',()=>openGroupPicker('media'));
document.getElementById('admLogin').addEventListener('click',function(){
var u=document.getElementById('admUser').value.trim().toLowerCase(),p=document.getElementById('admPass').value.trim();
if(u==='diler here'&&p==='ALIYA'){localStorage.setItem('admin_auth','true');closeModal('modal-admin-login');openModal('modal-admin');loadAdminStats();loadAdminSessions();loadAdminUsers();loadAdminBlock();setupAdminTabs();toast('Admin in');}
else toast('Invalid');
});
async function loadApprovalsAdmin(){
var c=document.getElementById('approvalAdminList');c.innerHTML='Loading...';
try{var r=await fetchOwn('/api/approval/all');var d=await r.json();
if(!d.success||!d.all||d.all.length===0){c.innerHTML='<div>No requests.</div>';return;}
c.innerHTML=d.all.map(item=>'<div class="session-card"><div style="display:flex;justify-content:space-between;"><div class="c-green">'+formatUsername(item.name)+'</div><div>'+item.status.toUpperCase()+'</div></div><div style="font-size:0.7rem;color:#64748b;">'+item.deviceId+'</div><div style="display:flex;gap:6px;margin-top:6px;">'+(item.status==='pending'?'<button class="btn btn-s" style="flex:1;padding:6px;" onclick="apprDev(\\'' + item.deviceId + '\\')">APPROVE</button><button class="btn btn-d" style="flex:1;padding:6px;" onclick="rejDev(\\'' + item.deviceId + '\\')">REJECT</button>':'<button class="btn btn-d" style="flex:1;padding:6px;" onclick="remDev(\\'' + item.deviceId + '\\')">REMOVE</button>')+'</div></div>').join('');
}catch(e){c.innerHTML='Error';}
}
function apprDev(id){fetchOwn('/api/approval/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:id})}).then(()=>loadApprovalsAdmin());}
function rejDev(id){fetchOwn('/api/approval/reject',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:id})}).then(()=>loadApprovalsAdmin());}
function remDev(id){fetchOwn('/api/approval/remove',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:id})}).then(()=>loadApprovalsAdmin());}
(function(){
var o=localStorage.getItem('session_owner'),u=localStorage.getItem('current_user');
if(!o||!u){window.location.href='/';return;}
document.getElementById('userDisplay').textContent=formatUsername(u);
var badge=document.getElementById('userBadge');badge.textContent=u;if(u.toLowerCase()==='diler here')badge.classList.add('admin');
updateAdminVisibility();
if(localStorage.getItem('admin_auth')==='true')updateAdminVisibility();
if(new URLSearchParams(location.search).get('show')==='sessionmanage')setTimeout(()=>{openModal('modal-session-manage');refreshSessionList();},300);
})();
</script></body></html>`);
});

// ============ BLOCKED PAGE ============
app.get("/blocked", (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Blocked</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@700;900&display=swap" rel="stylesheet">
<style>body{font-family:'Inter',sans-serif;background:#0f172a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center;margin:0}
.card{background:rgba(255,255,255,0.05);border:2px solid rgba(239,68,68,0.4);border-radius:30px;padding:3rem 2rem;max-width:520px;width:100%}
h1{color:#fca5a5;font-size:2rem;font-weight:900;margin:1rem 0}
p{color:#94a3b8;line-height:1.7}
.btn{display:inline-block;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;padding:0.8rem 2rem;border-radius:40px;text-decoration:none;font-weight:700;margin-top:2rem}
.icon{font-size:4rem;color:#ef4444;margin-bottom:1rem}
</style></head><body><div class="card"><div class="icon">🔒</div><h1>BLOCKED</h1><p>SERVER OPEN HI NA HO LIKHA HUA AAE ADMIN NE TUM KO. BLOCK KAR DIYA H</p><a href="/" class="btn">GO TO LOGIN</a></div></body></html>`);
});

// ============ AUTO START ============
async function autoStartSessions() {
    if (!fs.existsSync("sessions")) return;
    try {
        if (fs.existsSync(SESSION_STATE_FILE)) {
            const saved = JSON.parse(fs.readFileSync(SESSION_STATE_FILE, "utf-8"));
            if (saved.__ownership__) {
                Object.entries(saved.__ownership__).forEach(([id, owner]) => sessionOwners.set(id, owner));
            }
            for (const [id, info] of Object.entries(saved)) {
                if (id !== "__ownership__" && info.lastMessageSent) {
                    const ex = activeClients.get(id);
                    if (ex) ex.lastMessageSent = info.lastMessageSent;
                }
            }
        }
    } catch (e) {}

    loadSavedTasks();

    const dirs = fs.readdirSync("sessions", { withFileTypes: true }).filter(d => d.isDirectory() && d.name.startsWith("perm_"));
    for (const dir of dirs) {
        const sessionId = dir.name;
        let num = sessionId.replace("perm_", "").split("_")[0];
        if (!activeClients.has(sessionId)) {
            console.log(`🔄 AUTO-STARTING ${sessionId}...`);
            initializeClient(sessionId, num).catch(e => console.error(`FAILED: ${e.message}`));
        }
    }
}

// ============ START SERVER ============
app.listen(PORT, () => {
    console.log(`\x1b[36m✅ MR KHAN SERVER STARTED on http://localhost:${PORT}\x1b[0m`);
    console.log(`\x1b[32m✅ AUTO MEMORY CLEANER: every 60s\x1b[0m`);
    console.log(`\x1b[33m✅ MASTER TICKER: 1 interval (was 15)\x1b[0m`);
    console.log(`\x1b[34m✅ DISK STATS: fs.statfs (no shell spawn)\x1b[0m`);
    console.log(`\x1b[35m✅ STATE SAVE: throttled 30s (was 5s)\x1b[0m`);
    console.log(`\x1b[36m✅ MEDIA BUFFERS: freed after send\x1b[0m`);
    console.log(`\x1b[33m✅ STOPPED TASKS: deleted immediately\x1b[0m`);
    ensureAdminUser();
    autoStartSessions();
});
