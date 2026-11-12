import common from "../../../lib/common/common.js";
import plugin from '../../../lib/plugins/plugin.js';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import fetch from 'node-fetch';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '..');
const pyapiDir = path.join(pluginRoot, 'pyapi');
const appScript = path.join(pyapiDir, 'app.py');
const pidFile = path.join(pyapiDir, 'app.pid');
const logFile = path.join(pyapiDir, 'run.log');
const CONFIG_FILE = path.join(pluginRoot, 'config', 'config.json');

const DEFAULT_CONFIG = {
    api_url: 'http://127.0.0.1:8000',
    public_api_url: 'http://127.0.0.1:8000',
    max_pdf_mb: 80,
    auto_start: true,
    auto_check: false,
    health_check_interval_ms: 60000,
    request_timeout_ms: 300000
};

function loadConfig() {
    try {
        if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
        const userConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        const config = { ...DEFAULT_CONFIG, ...userConfig };
        if (userConfig.api_url && !userConfig.public_api_url) {
            config.public_api_url = userConfig.api_url;
        }
        return config;
    } catch (error) {
        console.error('[jm] 加载配置文件失败，使用默认配置:', error);
        return { ...DEFAULT_CONFIG };
    }
}

let CONFIG = loadConfig();
let startPromise = null;
let healthTimer = null;

function saveConfig() {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(CONFIG, null, 4)}\n`, 'utf8');
}

function apiBase() {
    return String(CONFIG.api_url || DEFAULT_CONFIG.api_url).replace(/\/+$/, '');
}

function requestTimeoutMs() {
    const timeout = Number(CONFIG.request_timeout_ms);
    return Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_CONFIG.request_timeout_ms;
}

async function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function checkApiHealth(timeoutMs = 2000) {
    try {
        const healthResponse = await fetchWithTimeout(`${apiBase()}/health`, timeoutMs);
        if (healthResponse.ok) {
            let data = null;
            try {
                data = await healthResponse.json();
            } catch (_) {
                // 新版健康接口必须返回 JSON。
            }
            if (data?.ok === true) {
                return { ok: true, status: healthResponse.status, data, legacy: false };
            }
            return { ok: false, status: healthResponse.status, error: '健康接口未返回 ok=true' };
        }

        if (![404, 405].includes(healthResponse.status)) {
            await healthResponse.text().catch(() => '');
            return { ok: false, status: healthResponse.status, error: `HTTP ${healthResponse.status}` };
        }

        await healthResponse.text().catch(() => '');
        const legacyResponse = await fetchWithTimeout(`${apiBase()}/`, timeoutMs);
        if (legacyResponse.ok) {
            const body = (await legacyResponse.text()).trim();
            if (body === 'api running!') {
                return { ok: true, status: legacyResponse.status, legacy: true };
            }
            return { ok: false, status: legacyResponse.status, error: '旧版健康接口响应不匹配' };
        }
        return { ok: false, status: legacyResponse.status, error: `HTTP ${legacyResponse.status}` };
    } catch (error) {
        return { ok: false, error: error.name === 'AbortError' ? '健康检查超时' : error.message };
    }
}

function normalizePath(value) {
    const normalized = path.normalize(String(value)).replace(/\\/g, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function processInfo(pid) {
    if (process.platform === 'win32') {
        try {
            const commandLine = execFileSync('powershell.exe', [
                '-NoProfile', '-Command',
                `(Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}").CommandLine`
            ], { encoding: 'utf8', timeout: 3000 }).trim();
            return { commandLine, cwd: null };
        } catch (_) {
            return null;
        }
    }

    try {
        const procDir = `/proc/${Number(pid)}`;
        const commandLine = fs.readFileSync(path.join(procDir, 'cmdline'), 'utf8').replace(/\0/g, ' ').trim();
        let cwd = null;
        try {
            cwd = fs.realpathSync(path.join(procDir, 'cwd'));
        } catch (_) {
            // 有些系统会限制读取 cwd；绝对脚本路径仍可用于识别。
        }
        return { commandLine, cwd };
    } catch (_) {
        return null;
    }
}

function isPluginApiProcess(pid) {
    const info = processInfo(pid);
    if (!info?.commandLine) return false;

    const firstToken = info.commandLine.match(/^"([^"]+)"|^(\S+)/)?.slice(1).find(Boolean) || '';
    const executable = firstToken.replace(/\\/g, '/').split('/').pop();
    if (!/^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(executable)) return false;

    const commandLine = normalizePath(info.commandLine);
    const expectedScript = normalizePath(appScript);
    const expectedCwd = normalizePath(pyapiDir);
    const cwd = info.cwd ? normalizePath(info.cwd) : '';
    const hasAbsoluteScript = commandLine.includes(expectedScript);
    const hasRelativeScript = cwd === expectedCwd && /(?:^|\s|["'])app\.py(?:\s|$|["'])/i.test(info.commandLine);
    return hasAbsoluteScript || hasRelativeScript;
}

function pidsOnPort(port) {
    const pids = new Set();
    const commands = process.platform === 'win32'
        ? [['netstat.exe', ['-ano', '-p', 'tcp']]]
        : [['ss', ['-ltnp']], ['netstat', ['-ltnp']]];

    for (const [command, args] of commands) {
        try {
            const output = execFileSync(command, args, { encoding: 'utf8', timeout: 3000 });
            for (const line of output.split(/\r?\n/)) {
                const fields = line.trim().split(/\s+/);
                if (!fields.some(field => field.replace(/^\[/, '').replace(/\]$/, '').endsWith(`:${port}`))) continue;
                if (process.platform === 'win32' && !line.includes('LISTENING')) continue;
                for (const match of line.matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]));
                if (process.platform === 'win32') {
                    const last = fields.at(-1);
                    if (/^\d+$/.test(last || '')) pids.add(Number(last));
                }
            }
            if (pids.size || command === 'netstat.exe') break;
        } catch (_) {
            // 继续尝试下一个系统命令。
        }
    }
    return [...pids].filter(pid => Number.isInteger(pid) && pid > 0);
}

function pluginApiPids() {
    const pids = new Set();
    try {
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        if (Number.isInteger(pid) && pid > 0 && isPluginApiProcess(pid)) pids.add(pid);
    } catch (_) {
        // pid 文件缺失或过期时继续通过监听端口查找。
    }

    let port = 8000;
    try {
        port = Number(new URL(apiBase()).port || (new URL(apiBase()).protocol === 'https:' ? 443 : 80));
    } catch (_) {
        // 配置地址不合法时使用默认端口，仅用于定位本插件进程。
    }
    for (const pid of pidsOnPort(port)) {
        if (isPluginApiProcess(pid)) pids.add(pid);
    }
    return [...pids];
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function stopPluginApi() {
    const pids = pluginApiPids();
    if (!pids.length) return { stopped: 0 };

    for (const pid of pids) {
        try {
            process.kill(pid, 'SIGTERM');
        } catch (error) {
            if (error.code !== 'ESRCH') logger.warn(`[jm] 无法停止本插件 API 进程 PID=${pid}: ${error.message}`);
        }
    }

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && pids.some(pid => isPluginApiProcess(pid))) await sleep(200);
    for (const pid of pids) {
        if (!isPluginApiProcess(pid)) continue;
        try {
            process.kill(pid, 'SIGKILL');
        } catch (error) {
            if (error.code !== 'ESRCH') logger.warn(`[jm] 无法强制停止本插件 API 进程 PID=${pid}: ${error.message}`);
        }
    }

    try {
        const recordedPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        if (pids.includes(recordedPid)) fs.unlinkSync(pidFile);
    } catch (_) {
        // 进程退出时 Python 也会清理 pid 文件。
    }
    return { stopped: pids.length };
}

function pythonCommand() {
    const venvPython = process.platform === 'win32'
        ? path.join(pluginRoot, '.venv', 'Scripts', 'python.exe')
        : path.join(pluginRoot, '.venv', 'bin', 'python');
    if (fs.existsSync(venvPython)) return { command: venvPython, fallback: false };

    const fallback = 'python3';
    logger.warn(`[jm] 未找到插件虚拟环境解释器 ${venvPython}，回退使用 ${fallback}`);
    return { command: fallback, fallback: true };
}

async function startApiProcess() {
    if (!fs.existsSync(appScript)) throw new Error(`找不到后端脚本：${appScript}`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const { command, fallback } = pythonCommand();
    const stdout = fs.openSync(logFile, 'a');
    const stderr = fs.openSync(logFile, 'a');

    try {
        const child = spawn(command, [appScript], {
            cwd: pyapiDir,
            detached: process.platform !== 'win32',
            stdio: ['ignore', stdout, stderr],
            windowsHide: true
        });
        const pid = await new Promise((resolve, reject) => {
            child.once('spawn', () => resolve(child.pid));
            child.once('error', reject);
        });
        child.on('error', error => logger.error(`[jm] Python 后端进程异常: ${error.message}`));
        child.unref();
        fs.writeFileSync(pidFile, `${pid}\n`, 'utf8');
        logger.info(`[jm] Python 后端已启动 PID=${pid}${fallback ? '（系统 Python 回退）' : '（虚拟环境）'}，日志：${logFile}`);
        return pid;
    } finally {
        fs.closeSync(stdout);
        fs.closeSync(stderr);
    }
}

async function waitForApi(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let last = { ok: false, error: '服务尚未响应' };
    while (Date.now() < deadline) {
        last = await checkApiHealth(2000);
        if (last.ok) return last;
        await sleep(750);
    }
    return last;
}

async function ensureApiRunning() {
    if (startPromise) return startPromise;
    startPromise = (async () => {
        const health = await checkApiHealth();
        if (health.ok) return { ...health, started: false };

        const existingPids = pluginApiPids();
        if (existingPids.length) {
            const recovered = await waitForApi(30000);
            if (recovered.ok) return { ...recovered, started: false };
            throw new Error(`检测到本插件 API 进程仍在运行但健康检查未通过（${recovered.error || '超时'}），请使用 #jm重启api；日志：${logFile}`);
        }

        await startApiProcess();
        const ready = await waitForApi(30000);
        if (!ready.ok) throw new Error(`等待 API 健康检查超时（${ready.error || '无响应'}），请查看 ${logFile}`);
        return { ...ready, started: true };
    })().finally(() => {
        startPromise = null;
    });
    return startPromise;
}

async function restartApi() {
    if (startPromise) {
        try { await startPromise; } catch (_) { /* 重启流程继续执行 */ }
    }
    await stopPluginApi();
    startPromise = null;
    return ensureApiRunning();
}

async function checkTask(e = null) {
    const health = await checkApiHealth();
    if (health.ok) {
        const message = `API运行正常（HTTP ${health.status}${health.legacy ? '，兼容旧接口' : ''}）`;
        if (e) await e.reply(message);
        return true;
    }

    try {
        const result = await ensureApiRunning();
        const message = `API原先未响应，已${result.started ? '启动' : '确认恢复'}成功（HTTP ${result.status}）`;
        if (e) await e.reply(message);
        return true;
    } catch (error) {
        const message = `API未运行，自动启动失败：${error.message}\n可使用 #jm启动api 重试；日志：${logFile}`;
        if (e) await e.reply(message);
        else logger.error(`[jm] ${message}`);
        return false;
    }
}

function startHealthTimer() {
    if (healthTimer) return false;
    const interval = Number(CONFIG.health_check_interval_ms);
    const intervalMs = Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_CONFIG.health_check_interval_ms;
    healthTimer = setInterval(() => {
        checkTask().catch(error => logger.error(`[jm] 定时巡检失败: ${error.message}`));
    }, intervalMs);
    healthTimer.unref?.();
    return true;
}

const jm = /^#jm查(.*)$/;
const Apirun = /^#jm(启动|重启)api$/;
const Apitimerestart = /^#jm定时检查$/;
const Apirestart = /^#jm检查api$/;
const SetApiUrl = /^#jm设置api地址(.*)$/;

export class ejm extends plugin {
    constructor() {
        super({
            name: 'ejm',
            dsc: 'jmsearch',
            event: 'message',
            priority: 1,
            rule: [
                { reg: jm, fnc: 'Jm' },
                { reg: Apirun, fnc: 'apirun', permission: 'master' },
                { reg: Apitimerestart, fnc: 'apitimerestart', permission: 'master' },
                { reg: Apirestart, fnc: 'apirestart' },
                { reg: SetApiUrl, fnc: 'setApiUrl', permission: 'master' }
            ]
        });
    }

    async setApiUrl(e) {
        let url = e.msg.replace(/#jm设置api地址/g, '').trim();
        if (!url) {
            return e.reply(`当前配置：\n内部 API：${CONFIG.api_url}\n外部 API：${CONFIG.public_api_url}\n\n请发送：#jm设置api地址 http://IP:PORT`);
        }
        if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
        try {
            const parsed = new URL(url);
            if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('仅支持 http 或 https 地址');
            CONFIG.api_url = url.replace(/\/+$/, '');
            CONFIG.public_api_url = CONFIG.api_url;
            saveConfig();
            return e.reply(`API地址已热更新为：${CONFIG.api_url}`);
        } catch (error) {
            return e.reply(`API地址无效：${error.message}`);
        }
    }

    async Jm(e) {
        const rawJmId = e.msg.replace(/#jm查/g, '').trim();
        if (!/^\d+$/.test(rawJmId) || !Number.isSafeInteger(Number(rawJmId)) || Number(rawJmId) <= 0) {
            return e.reply('车号必须是正整数。用法：#jm查 <车号>');
        }
        const jmId = String(Number(rawJmId));

        await e.reply(`正在获取 车号 ${jmId}，请稍候`);
        const initialHealth = await checkApiHealth();
        if (!initialHealth.ok) {
            try {
                await ensureApiRunning();
            } catch (error) {
                return e.reply(`API未能启动：${error.message}\n请使用 #jm启动api 或 #jm安装依赖。`);
            }
        }

        let response;
        let result;
        try {
            const url = `${apiBase()}/album?jm=${encodeURIComponent(jmId)}`;
            response = await fetchWithTimeout(url, requestTimeoutMs());
        } catch (error) {
            if (error.name === 'AbortError') {
                return e.reply(`获取车号 ${jmId} 超时（${Math.round(requestTimeoutMs() / 1000)} 秒），下载可能仍在进行，请稍后重试。`);
            }
            logger.error(`[jm] 请求车号 ${jmId} 失败: ${error.message}`);
            try {
                await ensureApiRunning();
                return e.reply('连接 API 失败，已检查并尝试恢复服务，请稍后重试。');
            } catch (startError) {
                return e.reply(`连接 API 失败且自动启动未成功：${startError.message}\n请使用 #jm启动api 或 #jm安装依赖。`);
            }
        }

        try {
            result = await response.json();
        } catch (_) {
            return e.reply(`API返回了无法识别的数据（HTTP ${response.status}），请检查后端日志。`);
        }

        if (!response.ok || result?.ok !== true) {
            const errorText = result?.error || '后端未提供错误信息';
            if (response.status === 400) return e.reply(`车号参数无效：${errorText}`);
            if (response.status === 404) return e.reply(`未找到车号 ${jmId} 的资源：${errorText}`);
            if (response.status === 503) return e.reply(`车号 ${jmId} 获取失败，后端暂时不可用：${errorText}。请稍后重试。`);
            if (response.status === 500) return e.reply(`车号 ${jmId} 处理失败：${errorText}。请查看后端日志。`);
            return e.reply(`获取车号 ${jmId} 失败（HTTP ${response.status}）：${errorText}`);
        }

        const coverPath = result.cover_path;
        const pdfPath = result.pdf_path;
        if (!coverPath || !pdfPath || !fs.existsSync(coverPath) || !fs.existsSync(pdfPath)) {
            logger.error(`[jm] API 返回的文件不存在，车号=${jmId}，cover=${coverPath}，pdf=${pdfPath}`);
            return e.reply('后端返回成功，但本地封面或 PDF 文件不存在，请检查 pyapi/run.log。');
        }

        const forward = await common.makeForwardMsg(e, [
            `车号 ${jmId}，共 ${result.page_count} 页。`,
            [segment.image(pathToFileURL(path.resolve(coverPath)).href)]
        ], `album${jmId}`);
        try {
            await e.reply(forward);
        } catch (error) {
            logger.error(`[jm] 发送封面转发失败: ${error.message}`);
            return e.reply(`车号 ${jmId} 已获取，但发送封面失败：${error.message}`);
        }

        const maxPdfMb = Number(CONFIG.max_pdf_mb);
        const maxBytes = (Number.isFinite(maxPdfMb) && maxPdfMb > 0 ? maxPdfMb : DEFAULT_CONFIG.max_pdf_mb) * 1024 * 1024;
        const pdfSize = Number(result.pdf_size);
        if (!Number.isFinite(pdfSize) || pdfSize <= 0) {
            return e.reply(`车号 ${jmId} 的 PDF 体积信息无效，未发送文件。`);
        }
        if (Number.isFinite(pdfSize) && pdfSize > maxBytes) {
            const sizeMb = (pdfSize / 1024 / 1024).toFixed(2);
            const limitMb = (maxBytes / 1024 / 1024).toFixed(2);
            return e.reply(`车号 ${jmId} 的 PDF 为 ${sizeMb} MB，超过发送上限 ${limitMb} MB；封面已发送，PDF 未发送。`);
        }

        try {
            await e.reply(segment.file(pathToFileURL(path.resolve(pdfPath)).href, `${jmId}.pdf`));
        } catch (error) {
            logger.error(`[jm] 发送车号 ${jmId} PDF 失败: ${error.message}`);
            return e.reply(`车号 ${jmId} 的封面已发送，但 PDF 发送失败：${error.message}`);
        }
    }

    async apirun(e) {
        try {
            const restarting = e.msg.includes('重启');
            const result = restarting ? await restartApi() : await ensureApiRunning();
            await e.reply(`API${restarting ? '重启' : '启动'}成功（HTTP ${result.status}）。`);
        } catch (error) {
            await e.reply(`API${e.msg.includes('重启') ? '重启' : '启动'}失败：${error.message}\n请查看 ${logFile}。`);
        }
        return true;
    }

    async apitimerestart(e) {
        CONFIG.auto_check = true;
        try {
            saveConfig();
            const alreadyRunning = !startHealthTimer();
            return e.reply(alreadyRunning ? '定时巡检已在运行，不会重复创建。' : '已开启定时巡检，重启插件后会自动恢复。');
        } catch (error) {
            return e.reply(`保存巡检配置失败：${error.message}`);
        }
    }

    async apirestart(e) {
        return checkTask(e);
    }
}

if (CONFIG.auto_check === true) startHealthTimer();
if (CONFIG.auto_start !== false) {
    setTimeout(() => {
        ensureApiRunning()
            .then(result => logger.info(`[jm] 自动启动检查完成：API运行正常（HTTP ${result.status}）`))
            .catch(error => logger.error(`[jm] 自动启动 API 失败：${error.message}`));
    }, 0).unref?.();
}
