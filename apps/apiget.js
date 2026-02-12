import common from "../../../lib/common/common.js";
import plugin from '../../../lib/plugins/plugin.js';
import path from 'path';
import { fileURLToPath } from 'url';
import {exec} from 'child_process';
import fetch from 'node-fetch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '..');
const API_URL = 'http://127.0.0.1:5000';

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
              
              if (!e.group) { // 检测当前是否为群聊环境
                 await e.friend.sendFile(pdfUrl);
              } else {
                 await e.group.sendFile(pdfUrl);
              }
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
          console.log(ppp)
           exec(`python "${ppp}"`, (error) => {
            if (error) {
              console.error(`错误码: ${error.code}`);
              return false
            }
          });
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
          console.warn('执行重启');
          if(e) e.reply('api未启动或意外关闭，执行重启')
          await restartApi();
        }
      }

  
