# yz-jmcomic-plugin

一个适用于 Yunzai-Bot 的 JMComic（禁漫天堂）漫画下载与查看插件。

本项目核心逻辑基于开源项目 [JMComic-Crawler-Python](https://github.com/hect0x7/JMComic-Crawler-Python) 进行二次开发和封装，采用 **Python 后端 + Node.js 前端** 的混合架构，旨在提供稳定、高速的漫画浏览体验。

## 📖 项目简介

在 Yunzai-Bot 上直接搜索、查看、下载 JM 本子，支持自动处理图片与 PDF 转换。

### 🌟 核心亮点

*   ✨ **自动域名更新**：内置域名自动捕获机制，告别手动更换域名的烦恼，插件会自动获取最新的可用线路。
*   🚀 **高性能后端**：基于 Flask 框架构建，采用全局单例模式与连接池复用技术。下载速度快，内存占用低，在大并发下依然保持流畅。
*   🛡️ **高稳定性**：内置智能重试机制和严格的参数校验，有效防止因网络波动或错误输入导致的插件崩溃。
*   📦 **智能转换**：支持图片模式查看，对于超大章节自动转换为 PDF 发送，避免消息发送失败。

## 💻 环境要求 (Requirements)

*   **Yunzai-Bot**: v3 版本
*   **Python**: 3.8 或更高版本
*   **Python 依赖**: 见 `pyapi/requirements.txt`

## 🛠️ 安装与部署 (Installation)

请严格按照以下步骤操作，以确保插件正常运行：

1.  **克隆插件**  
    将本项目克隆到 Yunzai-Bot 的 `plugins` 目录下：
    ```bash
    # Github源
    git clone https://github.com/Oumainory/yunzai-jm-comic-plugin.git ./plugins/yz-jmcomic-plugin
    
    # 或者 Gitee源 (国内推荐)
    git clone https://gitee.com/OumaInory_0/yunzai-jm-comic-plugin.git ./plugins/yz-jmcomic-plugin
    ```

2.  **创建虚拟环境并安装 Python 依赖**  
    在插件根目录创建 `.venv`，再使用虚拟环境内的 pip 安装依赖：
    ```bash
    cd plugins/yz-jmcomic-plugin
    python3 -m venv .venv
    .venv/bin/pip install -r pyapi/requirements.txt
    ```
    Windows 可使用 `py -m venv .venv`，然后运行 `.venv\Scripts\pip.exe install -r pyapi\requirements.txt`。

3.  **配置选项**  
    检查 `pyapi/option.yml` 配置文件。虽然插件支持开箱即用（免配置），但建议您确认下载路径等设置符合您的需求。

4.  **启动 Bot**  
    启动 Yunzai-Bot 后，插件会自动检查并拉起 Python 后端；已运行的后端不会重复启动。

PDF 和 ZIP 默认发送上限为 **80 MB**，可在 `config/config.json` 修改 `max_pdf_mb`。`request_timeout_ms` 默认是 300000（5 分钟）；`auto_start` 控制载入插件时是否启动 API，`auto_check` 可开启自动巡检。

## 🎮 食用方法 (Usage)

### 查询指令

带参数指令的指令名和参数之间可加空格，也可不加空格；例如 `#jm资料1257267` 与 `#jm资料 JM1257267` 等效。

| 指令 | 说明 | 示例 |
| :--- | :--- | :--- |
| `#jm帮助` / `#jmhelp` | 查看完整指令清单 | `#jm帮助` |
| `#jm查 <车号>` | 下载整本并上传 PDF | `#jm查 JM123456` |
| `#jm查章 <车号> <章节序号>` | 只下载指定章节并上传 PDF；序号见资料 | `#jm查章 JM123456 2` |
| `#jm搜 <关键词> [页码]` | 站内搜索，默认第 1 页 | `#jm搜 无修正 2` |
| `#jm标签 <标签> [页码]` | 按标签搜索 | `#jm标签 中文 3` |
| `#jm资料 <车号>` | 查看标题、作者、标签、章节和统计数据 | `#jm资料 123456` |
| `#jm评论 <车号> [页码]` | 查看评论和回评；剧透默认折叠 | `#jm评论 JM123456 2` |
| `#jm排行 [日\|周\|月] [分类] [页码]` | 查看排行；默认周榜、全部分类 | `#jm排行 周 同人 2` |
| `#jm分类 [分类] [排序] [时间] [页码]` | 按分类、排序和时间筛选 | `#jm分类 同人 最新 一周 2` |
| `#jm收藏夹 [页码]` | 查看登录账号的收藏夹 | `#jm收藏夹 2` |
| `#jm点赞状态 <车号>` | 查看是否已点赞、已收藏 | `#jm点赞状态 JM123456` |
| `#jm收藏 <车号>` | 加入收藏 | `#jm收藏 JM123456` |
| `#jm取消收藏 <车号>` | 取消收藏 | `#jm取消收藏 JM123456` |
| `#jm压缩包 <车号>` | 下载或读取整本页图并上传 ZIP | `#jm压缩包 123456` |
| `#jm长图 <车号>` | 生成压缩长图；过高或过大时请改用 PDF | `#jm长图 123456` |
| `#jm图页 <车号> [页数上限]` | 以合并转发分批发送压缩页图，默认前 20 页 | `#jm图页 JM123456 20` |

分类参数支持：全部、同人、单本、短篇、韩漫、美漫、英文、其他、3D、cosplay；排序支持：最新、观看、点赞、评分、图片、评论；时间支持：今天、一周、本月、全部。发送 `#jm分类 帮助` 或 `#jm排行 帮助` 可查看参数和示例。

### 登录与管理指令

账号与收藏相关命令均仅主人可用。`#jm登录` 必须在私聊发送，群聊中只会提示改为私聊。

| 指令 | 说明 | 示例 |
| :--- | :--- | :--- |
| `#jm登录 [账号 密码]` | 仅私聊登录并保存配置；无参数时查看状态 | `#jm登录 你的账号 你的密码` |
| `#jm启动api` | 手动启动 Python 后端服务 | `#jm启动api` |
| `#jm重启api` | 重启 Python 后端服务 | `#jm重启api` |
| `#jm检查api` | 检查后端服务状态 | `#jm检查api` |
| `#jm定时检查` | 开启定时巡检 | `#jm定时检查` |
| `#jm安装依赖` | 在插件 `.venv` 中创建环境并安装依赖 | `#jm安装依赖` |
| `#jm路径写入` | 写入资源目录、监听地址和端口等环境变量 | `#jm路径写入` |
| `#jm设置api地址 <地址>` | 热更新内部和外部 API 地址 | `#jm设置api地址 http://127.0.0.1:8000` |

登录信息保存在插件本地 `config/jm-auth.json`，文件会被 `.gitignore` 忽略并以受限权限写入。只在私聊发送账号和密码；不要把该文件或密码提交到 git。插件不会在回复中回显密码或 cookies。

## 🏗️ 技术原理 (Architecture)

本插件采用了 **Node.js (Yunzai)** 与 **Python (Flask)** 分离的架构设计：

1.  **交互层 (Node.js)**：Yunzai-Bot 接收用户指令（如 `#jm查`），通过 HTTP 请求调用本地运行的 Flask 服务。
2.  **核心层 (Python)**：Flask 服务接收请求后，调用 `jmcomic` 库处理复杂的爬虫逻辑（域名解析、加密解密、图片下载）。
3.  **交付层**：
    *   Python 后端将下载的图片、PDF、ZIP 和压缩预览图存储在本地。
    *   Node.js 前端把小尺寸 JPG 预览图放入合并转发；PDF 和 ZIP 会先编码为 `base64://`，再通过 OneBot 文件上传接口发送，避免把 TRSS_AllBot 的本地路径交给独立的 SnowLuma 容器。

## 离线测试

在插件目录运行：

```bash
node tests/jm-offline.test.mjs
node --check apps/apiget.js
node --check apps/features.js
node --check apps/jm-utils.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

这些测试不访问 JM 站点、不登录账号，也不向 QQ 发送消息。图像压缩测试需要安装项目依赖中的 Pillow。

## ⚠️ 免责声明

*   本项目仅供技术研究和学习交流使用，**严禁用于任何商业用途**。
*   使用者应对自己的行为负责，下载的内容请在 24 小时内删除。
*   开发者不承担因使用本项目而产生的任何法律责任。

## 🤝 致谢

*   特别感谢 [hect0x7](https://github.com/hect0x7) 大佬开源的 [JMComic-Crawler-Python](https://github.com/hect0x7/JMComic-Crawler-Python) 项目，为本插件提供了强大的核心支持。
*   感谢 [excellen114514](https://github.com/excellen114514) 开源的 [jmcomic-plugin](https://github.com/excellen114514/jmcomic-plugin) 项目提供了灵感与基础。
