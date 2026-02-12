import common from "../../../lib/common/common.js";
import plugin from '../../../lib/plugins/plugin.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import fetch from 'node-fetch';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '..');

// 默认配置
let CONFIG = {
    api_url: 'http://127.0.0.1:8000',
    public_api_url: 'http://127.0.0.1:8000' // 新增：用于发送给QQ适配器的地址
};

// 加载配置
const CONFIG_FILE = path.join(pluginRoot, 'config', 'config.json');
if (fs.existsSync(CONFIG_FILE)) {
    try {
        const userConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        CONFIG = { ...CONFIG, ...userConfig };
        // 如果用户只配了 api_url 没配 public_api_url，默认两者一致
        if (userConfig.api_url && !userConfig.public_api_url) {
            CONFIG.public_api_url = userConfig.api_url;
        }
    } catch (e) {
        console.error('加载配置文件失败:', e);
    }
} else {
    // 自动创建默认配置文件
    const configDir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 4));
}

const API_URL = CONFIG.api_url;
const PUBLIC_API_URL = CONFIG.public_api_url;

const jm = /^#jm查(.*)$/
const Apirun = /^#jm(启动|重启)api$/
const Apitimerestart = /^#jm定时检查$/
const Apirestart = /^#jm检查api$/
const SetApiUrl = /^#jm设置api地址(.*)$/

export class ejm extends plugin {
    constructor() {
        super({
            name: 'ejm',
            dsc: 'jmsearch',
            event: 'message',
            priority: 1,
            rule: [{
                    reg: jm,
                    fnc: "Jm"
                },{
                    reg: Apirun,
                    fnc: "apirun",
                    permission: "master"
                },{
                    reg: Apitimerestart,
                    fnc: "apitimerestart",
                    permission: "master"
                },{
                    reg: Apirestart,
                    fnc: "apirestart",
                },{
                    reg: SetApiUrl,
                    fnc: "setApiUrl",
                    permission: "master"
                }
            ]
        }
        )
    }

    async setApiUrl(e) {
        let url = e.msg.replace(/#jm设置api地址/g, "").trim();
        if (!url) {
            return e.reply(`当前配置:\n内部API: ${CONFIG.api_url}\n外部API: ${CONFIG.public_api_url}\n\n请发送: #jm设置api地址 http://IP:PORT`);
        }
        
        // 简单校验
        if (!url.startsWith('http')) {
            url = 'http://' + url;
        }
        
        // 更新配置
        CONFIG.api_url = url;
        CONFIG.public_api_url = url; // 默认同时修改两者
        
        try {
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 4));
            // 提示用户重启生效，或者这里其实已经是热更了（对于新请求）
            // 但是 API_URL 和 PUBLIC_API_URL 是 const，需要改成 let 或者直接使用 CONFIG.xxx
            // 由于上面用的是 const，这里实际上不会立即生效，除非重启插件
            // 所以我们修改代码结构，不再使用 const API_URL
            return e.reply(`API地址已更新为: ${url}\n请重启Bot或重载插件生效！`);
        } catch (err) {
            return e.reply(`保存配置失败: ${err}`);
        }
    }
      async Jm(e) {
        let tup = e.msg.replace(/#jm查/g, "").trim();
    
        // 构造请求URL
        let url = `${CONFIG.api_url}/jmd?jm=${encodeURIComponent(tup)}`;
    
        try {
            // 发起请求，触发 Python 下载
            // 使用 try-catch 忽略 fetch 错误，因为我们主要依赖本地文件
            let res;
            try {
                // 设置超时，避免请求卡住
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时
                res = await fetch(url, { signal: controller.signal });
                clearTimeout(timeoutId);
            } catch (err) {
                 logger.error(`[jm] 触发下载API失败: ${err}`);
            }

            // 查找本地图片文件
            // Python下载的目录结构: resources/long/{tup}/...
            // 找到第一张图片
            const albumPath = path.join(pluginRoot, 'resources', 'long', tup);
            let imagePath = null;
            
            // 循环检测文件是否存在，最多等待 15 秒
            // 这是为了等待 Python 后台下载完成
            let maxRetries = 15; 
            while (maxRetries > 0) {
                if (fs.existsSync(albumPath) && fs.lstatSync(albumPath).isDirectory()) {
                    const files = fs.readdirSync(albumPath).sort();
                    for (const file of files) {
                        if (file.match(/\.(png|jpg|jpeg|webp|gif)$/i)) {
                            imagePath = path.join(albumPath, file);
                            break;
                        }
                    }
                    if (imagePath) break; // 找到了，跳出循环
                }
                
                // 如果 API 返回了明确的错误（如 404），则不再等待
                if (res && !res.ok && res.status !== 503) { // 503可能是下载失败，可以再等等看有没有残留文件？或者直接退出
                     break; 
                }

                await new Promise(r => setTimeout(r, 1000)); // 等待 1 秒
                maxRetries--;
            }

            // 如果没找到图片
            if (!imagePath) {
                 if (res) {
                      if (res.status === 404) {
                          return await e.reply('未找到该资源 (404)，请检查车号是否正确，或该本子已被删除。');
                      } else if (res.status === 503) {
                          return await e.reply('下载失败 (503)，可能是网络连接问题或IP被封禁，请稍后重试。');
                      } else if (!res.ok) {
                          return await e.reply(`请求失败 (Code: ${res.status})，请检查车号或稍后重试！`);
                      }
                 }
                 // API 没响应或者响应成功但没文件
                 logger.warn(`[jm] 未找到本地图片: ${albumPath}`);
                 return await e.reply('资源下载超时或失败，请稍后重试。');
            }

            let msg = [segment.image(imagePath)];
            logger.info(`[jm] 找到本地图片: ${imagePath}`);

            const forward = [
              '爱护jm，不要爬这么多本子，jm压力大你bot压力也大，西门',
              `https://18comic.vip/photo/${tup}`
            ];
            forward.push(msg);
            
            // 尝试获取 PDF
            // 触发 PDF 下载/生成
            let pdfUrl = `${CONFIG.api_url}/jmdp?jm=${encodeURIComponent(tup)}`;
            try {
                 fetch(pdfUrl).catch(e => logger.error(`PDF触发失败: ${e}`));
            } catch (e) {}

            // 直接查找本地 PDF 文件: resources/pdf/{tup}.pdf
            const pdfPath = path.join(pluginRoot, 'resources', 'pdf', `${tup}.pdf`);
            let pdfToSend = null;
            
            // 等待 PDF 生成，最多等待 20 秒
            // 因为生成 PDF 比较耗时，特别是图片多的时候
            let pdfRetries = 20;
            while (pdfRetries > 0) {
                 if (fs.existsSync(pdfPath)) {
                      logger.info(`[jm] 找到本地PDF: ${pdfPath}`);
                      pdfToSend = pdfPath;
                      break;
                 }
                 await new Promise(r => setTimeout(r, 1000));
                 pdfRetries--;
            }

            if (!pdfToSend) {
                 logger.warn(`[jm] 未找到本地PDF (超时): ${pdfPath}`);
            }
            
            try {
                logger.info('正在尝试获取PDF文件...');
                // 直接发送文件，如果文件生成需要时间，用户可能需要等待
                // 云崽的 segment.file 会自动下载文件并发送
                forward.push("正在上传PDF文件，请稍候...");
                // 注意：这里我们不能直接把 segment.file 放入 forward 消息中，因为 forward 消息通常只支持文本/图片
                // 但为了满足用户"转发出来"的需求，我们尝试将 PDF 作为单独的文件发送，或者尝试放入 forward（取决于具体实现支持）
                // 通常 segment.file 是直接 reply 发送的
            } catch (err) {
                logger.error(`PDF获取失败: ${err}`);
            }

            const fmsg = await common.makeForwardMsg(e, forward, `album${tup}`);
            await e.reply(fmsg);
            
            // 单独发送 PDF 文件
            if (pdfToSend) {
                try {
                    await e.reply(segment.file(pdfToSend));
                } catch (err) {
                    logger.error(`发送PDF失败: ${err}`);
                    await e.reply(`PDF发送失败，请检查日志。`);
                }
            } else {
                 await e.reply(`PDF生成中或失败，请稍后重试。`);
            }
          
            
            // 不需要再返回 true，因为已经回复了
            // return true; // 返回 true，阻挡消息不再往下
            } catch (err) {
            logger.error(`[jm] 请求失败：${err}`);
            
            // 捕获 fetch 抛出的网络错误（如连接拒绝）
            if (err.code === 'ECONNREFUSED' || err.type === 'system') {
                logger.warn('检测到API连接拒绝，触发自动重启');
                await restartApi();
                return await e.reply('API服务未启动或已停止，正在为您重启，请约10秒后重试！');
            }
            
            return await e.reply('请求失败，请检查车号或稍后重试！');
        }
            }

      async apirun(e){
        await restartApi();
        await e.reply('api启动完成！检查日志吧')
        return true
        }
      async apitimerestart(e){
        // 立即执行一次，然后每分钟执行
        checkTask();
        setInterval(checkTask, 60000);
        return await e.reply('设定完成，重启后失效')
      }
      async apirestart(e){
        return await checkTask(e);
      }
        
      }
  
      async function restartApi() {
          const JM_PATH = pluginRoot;
          console.log(`获取工作路径:${JM_PATH}`);
          const ppp = path.join(JM_PATH, 'pyapi', 'app.py');
          const logFile = path.join(JM_PATH, 'pyapi', 'run.log');
          console.log(`Python脚本路径: ${ppp}`);
          console.log(`日志文件路径: ${logFile}`);

          const out = fs.openSync(logFile, 'a');
          const err = fs.openSync(logFile, 'a');

          // 在 Linux 下优先使用 /usr/bin/python3，Windows 下使用 python
          let pythonCommand = 'python';
          if (process.platform !== 'win32') {
              if (fs.existsSync('/usr/bin/python3')) {
                  pythonCommand = '/usr/bin/python3';
              } else {
                  pythonCommand = 'python3';
              }
          }
          
          const subprocess = spawn(pythonCommand, [ppp], {
              detached: true,
              stdio: [ 'ignore', out, err ]
          });

          subprocess.on('error', (err) => {
              console.error('启动 Python 失败:', err);
              // 如果启动失败，可能是依赖未安装
              if (err.code === 'ENOENT' && process.platform !== 'win32') {
                  console.log('尝试自动安装依赖...');
                  // 这里不直接自动安装，因为可能会有权限问题，而是提示用户
                  // 或者可以尝试在 run.log 中写入提示
                  fs.writeSync(out, `\n[Auto-Check] 启动失败，可能是环境问题。请尝试手动运行: pip3 install -r ${path.join(JM_PATH, 'pyapi', 'requirements.txt')}\n`);
              }
          });

          subprocess.unref();
          console.log('Python后端已尝试启动，日志已重定向到 run.log');
      }

      async function checkTask(e = null) {
        try {
          console.log('执行检查，时间:', new Date().toLocaleTimeString());
          let url = CONFIG.api_url;
          let res = await fetch(url);
          console.log(`当前状态：${res.status}`)
          if(e) e.reply(`当前状态：${res.status}`)
          return true
        } catch (error) {
          console.error('检查任务出错:', error);
          
          // 如果是连接被拒绝（服务挂了），则尝试重启
          if (error.code === 'ECONNREFUSED' || error.type === 'system') {
              console.warn('API连接失败，执行重启');
              if(e) e.reply('api未启动或意外关闭，正在尝试重启...')
              await restartApi();
          } else {
              if(e) e.reply(`检查失败: ${error.message}`);
          }
        }
      }

  
