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
                logger.error('[jm] 请求失败');
                // 如果是连接拒绝，尝试重启
                if (!res) {
                    await restartApi();
                    return await e.reply('API未响应，正在尝试自动重启，请稍后再试！');
                }
                return await e.reply('错误，请检查车号或稍后重试！');
            }
    
            // 从头部获取内容长度
            const contentLength = res.headers.get('content-length');
            const bytes = contentLength ? parseInt(contentLength, 10) : 0;
            console.log(`图片大小：${bytes}字节`);
  
            if (bytes >= 31457280) {
              // 图片过大，改为直接发送 PDF URL，让适配器自己去下载
              let pdfUrl = `${API_URL}/jmdp?jm=${encodeURIComponent(tup)}`;
              
              try {
                logger.warn('图片过大，尝试发送 PDF 链接');
                e.reply('文件拉取中，请耐心等待...');
                
                await e.reply(segment.file(pdfUrl));
                return true; 
              } catch (err) {
                 logger.error(err);
                 return await e.reply('错误，发送文件失败，请稍后重试！');
              }
                
            } else {
         
            let msg = [segment.image(res.url)]; // 返回的是图片
            const forward = [
              '爱护jm，不要爬这么多本子，jm压力大你bot压力也大，西门',
              `https://18comic.vip/photo/${tup}`
          ];
            forward.push(msg);
            const fmsg = await common.makeForwardMsg(e, forward, `album${tup}`);
            await e.reply(fmsg);
          
            
      }
            return true; // 返回 true，阻挡消息不再往下
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

  
