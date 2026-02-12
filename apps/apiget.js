import common from "../../../lib/common/common.js";
import plugin from '../../../lib/plugins/plugin.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import fetch from 'node-fetch';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '..');
const API_URL = 'http://127.0.0.1:8000';

const jm = /^#jm查(.*)$/
const Apirun = /^#jm(启动|重启)api$/
const Apitimerestart = /^#jm定时检查$/
const Apirestart = /^#jm检查api$/
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
          },
            ]
        }
        )
    }
      async Jm(e) {
        let tup = e.msg.replace(/#jm查/g, "").trim();
    
        // 构造请求URL
        let url = `${API_URL}/jmd?jm=${encodeURIComponent(tup)}`;
    
        try {
            // 发起请求，仅获取头部信息
            let res = await fetch(url);
    
            // 检查请求是否成功
        if (!res || !res.ok) {
            logger.error(`[jm] 请求失败，状态码: ${res ? res.status : '无响应'}`);
            // 如果是连接拒绝，尝试重启
            if (!res) {
                await restartApi();
                return await e.reply('API未响应，正在尝试自动重启，请稍后再试！');
            }
            
            // 细分错误提示
            if (res.status === 404) {
                return await e.reply('未找到该资源 (404)，请检查车号是否正确，或该本子已被删除。');
            } else if (res.status === 503) {
                return await e.reply('下载失败 (503)，可能是网络连接问题或IP被封禁，请稍后重试。');
            } else if (res.status === 500) {
                return await e.reply('服务器内部错误 (500)，请检查后台日志。');
            } else if (res.status === 400) {
                return await e.reply('参数错误 (400)，请输入正确的数字车号。');
            }
            
            return await e.reply(`请求失败 (Code: ${res.status})，请检查车号或稍后重试！`);
        }
    
            // 发送预览图
            let msg = [segment.image(res.url)]; // 返回的是图片
            const forward = [
              '爱护jm，不要爬这么多本子，jm压力大你bot压力也大，西门',
              `https://18comic.vip/photo/${tup}`
            ];
            forward.push(msg);
            
            // 尝试获取 PDF
            let pdfUrl = `${API_URL}/jmdp?jm=${encodeURIComponent(tup)}`;
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
            try {
                await e.reply(segment.file(pdfUrl));
            } catch (err) {
                logger.error(`发送PDF失败: ${err}`);
                await e.reply(`PDF发送失败，请检查日志。`);
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
          let url = API_URL;
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

  
