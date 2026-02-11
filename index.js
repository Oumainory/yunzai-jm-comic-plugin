//注册nodejs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

//输出载入消息
logger.info('尝试载入jmcomic')

// 获取当前文件所在目录的绝对路径
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appsPath = path.join(__dirname, 'apps');

//注册插件
const files = fs.readdirSync(appsPath).filter(file => file.endsWith('.js'))

let ret = []

files.forEach((file) => {
    ret.push(import(`./apps/${file}`))
})


ret = await Promise.allSettled(ret)

let apps = {}
for (let i in files) {
    let name = files[i].replace('.js', '')

    if (ret[i].status != 'fulfilled') {
        logger.error(`插件加载失败${logger.red(name)}`)
        logger.error(ret[i].reason)
        continue
    }
    apps[name] = ret[i].value[Object.keys(ret[i].value)[0]]
}


export { apps }

logger.info(logger.green('jmcomic！'))
logger.info(logger.green('载入完成！感谢支持！'))
