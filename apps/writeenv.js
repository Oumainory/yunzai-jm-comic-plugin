import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import plugin from '../../../lib/plugins/plugin.js';
import { buildRequirementInstallReply } from './jm-utils.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '..');
const pyapiDir = path.join(pluginRoot, 'pyapi');
const envPath = path.join(pyapiDir, '.env');
const requirementsPath = path.join(pyapiDir, 'requirements.txt');
const resourcePath = path.join(pluginRoot, 'resources');

const Writeenv = /^#jm路径写入$/;
const Requirement = /^#jm安装依赖$/;

export class ejmEnv extends plugin {
    constructor() {
        super({
            name: 'ejmEnv',
            dsc: 'jmenv',
            event: 'message',
            priority: 1,
            rule: [
                { reg: Writeenv, fnc: 'write', permission: 'master' },
                { reg: Requirement, fnc: 'requirement', permission: 'master' }
            ]
        });
    }

    async write(e) {
        const values = {
            JM_BASE_DIR: resourcePath,
            JM_LOG_DIR: resourcePath,
            FLASK_HOST: '127.0.0.1',
            FLASK_PORT: '8000'
        };
        try {
            for (const [key, value] of Object.entries(values)) {
                updateEnvVariable(key, value, envPath);
            }
            return e.reply(`环境变量已写入：\nJM_BASE_DIR=${resourcePath}\nJM_LOG_DIR=${resourcePath}\nFLASK_HOST=127.0.0.1\nFLASK_PORT=8000`);
        } catch (error) {
            return e.reply(`写入环境变量失败：${error.message}`);
        }
    }

    async requirement(e) {
        const python = process.platform === 'win32'
            ? path.join(pluginRoot, '.venv', 'Scripts', 'python.exe')
            : path.join(pluginRoot, '.venv', 'bin', 'python');
        const pip = process.platform === 'win32'
            ? path.join(pluginRoot, '.venv', 'Scripts', 'pip.exe')
            : path.join(pluginRoot, '.venv', 'bin', 'pip');
        const venvCommand = process.platform === 'win32' ? 'python' : 'python3';

        try {
            if (!fs.existsSync(python)) {
                await e.reply('未找到插件虚拟环境，正在创建 .venv 并安装依赖，请稍候。');
                await execFileAsync(venvCommand, ['-m', 'venv', '.venv'], {
                    cwd: pluginRoot,
                    timeout: 10 * 60 * 1000,
                    maxBuffer: 4 * 1024 * 1024
                });
            }

            const installCommand = fs.existsSync(pip) ? pip : python;
            const installArgs = fs.existsSync(pip)
                ? ['install', '-r', requirementsPath]
                : ['-m', 'pip', 'install', '-r', requirementsPath];
            const result = await execFileAsync(installCommand, installArgs, {
                cwd: pluginRoot,
                timeout: 30 * 60 * 1000,
                maxBuffer: 8 * 1024 * 1024
            });
            const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
            logger.info(`[jm] 虚拟环境依赖安装完成${output ? `：\n${output}` : ''}`);
            return e.reply(buildRequirementInstallReply({ success: true, ...result }));
        } catch (error) {
            const output = [error.stdout, error.stderr, error.message, error.stack].filter(Boolean).join('\n').trim();
            logger.error(`[jm] 虚拟环境依赖安装失败：${output}`);
            return e.reply(buildRequirementInstallReply({ success: false, code: error.code }));
        }
    }
}

function updateEnvVariable(key, newValue, filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    const hadTrailingNewline = /(?:\r\n|\n)$/.test(content);
    const lines = content ? content.split(/\r?\n/) : [];
    if (hadTrailingNewline) lines.pop();

    const keyPattern = new RegExp(`^\\s*${key}\\s*=`);
    const index = lines.findIndex(line => keyPattern.test(line));
    if (index >= 0) {
        lines[index] = `${key}=${newValue}`;
    } else {
        lines.push(`${key}=${newValue}`);
    }

    fs.writeFileSync(filePath, `${lines.join(os.EOL)}${os.EOL}`, 'utf8');
}
