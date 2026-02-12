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
    git clone https://github.com/Oumainory/yunzai-jm-comic-plugin.git ./plugins/yz-jmcomic-plugin
    ```

2.  **安装 Python 依赖 (手动安装)**  
    进入插件的 `pyapi` 目录，并安装所需的 Python 库。
    > **注意**：如果不运行此步骤，插件将无法启动。如果遇到权限问题，请在命令后加 `--break-system-packages` 或使用虚拟环境。
    ```bash
    cd plugins/yz-jmcomic-plugin/pyapi
    pip3 install -r requirements.txt
    ```
    *(如果报错缺少模块，请务必执行上述命令)*

3.  **配置选项**  
    检查 `pyapi/option.yml` 配置文件。虽然插件支持开箱即用（免配置），但建议您确认下载路径等设置符合您的需求。

4.  **启动 Bot**  
    启动 Yunzai-Bot，插件会自动唤醒 Python 后端服务，无需手动运行 Python 脚本。

## 🎮 食用方法 (Usage)

### 基础指令

| 指令 | 说明 | 示例 |
| :--- | :--- | :--- |
| `#jm查 <车号>` | 下载并查看指定 ID 的本子 | `#jm查 123456` |

### 管理指令 (仅管理员)

| 指令 | 说明 |
| :--- | :--- |
| `#jm启动api` | 手动启动 Python 后端服务 |
| `#jm重启api` | 重启 Python 后端服务 |
| `#jm检查api` | 检查后端服务运行状态 |
| `#jm定时检查` | 开启服务存活定时检测（每分钟） |
| `#jm安装依赖` | 尝试自动安装 Python 依赖 |
| `#jm路径写入` | 自动配置环境变量路径 |

## 🏗️ 技术原理 (Architecture)

本插件采用了 **Node.js (Yunzai)** 与 **Python (Flask)** 分离的架构设计：

1.  **交互层 (Node.js)**：Yunzai-Bot 接收用户指令（如 `#jm查`），通过 HTTP 请求调用本地运行的 Flask 服务。
2.  **核心层 (Python)**：Flask 服务接收请求后，调用 `jmcomic` 库处理复杂的爬虫逻辑（域名解析、加密解密、图片下载）。
3.  **交付层**：
    *   Python 后端将下载的图片或合成的 PDF 存储在本地。
    *   Node.js 前端使用 `e.reply(segment.file(url))` 方式发送文件。这种方式是 Yunzai 生态的标准写法，兼容性极佳，无论是私聊还是群聊，无论是本地文件还是网络 URL，都能被适配器正确识别和发送。

## ⚠️ 免责声明

*   本项目仅供技术研究和学习交流使用，**严禁用于任何商业用途**。
*   使用者应对自己的行为负责，下载的内容请在 24 小时内删除。
*   开发者不承担因使用本项目而产生的任何法律责任。

## 🤝 致谢

*   特别感谢 [hect0x7](https://github.com/hect0x7) 大佬开源的 [JMComic-Crawler-Python](https://github.com/hect0x7/JMComic-Crawler-Python) 项目，为本插件提供了强大的核心支持。
*   感谢 [excellen114514](https://github.com/excellen114514) 开源的 [jmcomic-plugin](https://github.com/excellen114514/jmcomic-plugin) 项目提供了灵感与基础。
