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

PDF 默认发送上限为 **80 MB**，可在 `config/config.json` 修改 `max_pdf_mb`。`request_timeout_ms` 默认是 300000（5 分钟）；`auto_start` 控制载入插件时是否启动 API，`auto_check` 可开启自动巡检。

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
| `#jm定时检查` | 开启定时巡检，设置会保存并在插件载入时恢复 |
| `#jm安装依赖` | 在插件 `.venv` 中创建环境并安装 Python 依赖 |
| `#jm路径写入` | 写入资源目录、监听地址和端口等环境变量 |
| `#jm设置api地址 <地址>` | 热更新内部和外部 API 地址 |

## 🏗️ 技术原理 (Architecture)

本插件采用了 **Node.js (Yunzai)** 与 **Python (Flask)** 分离的架构设计：

1.  **交互层 (Node.js)**：Yunzai-Bot 接收用户指令（如 `#jm查`），通过 HTTP 请求调用本地运行的 Flask 服务。
2.  **核心层 (Python)**：Flask 服务接收请求后，调用 `jmcomic` 库处理复杂的爬虫逻辑（域名解析、加密解密、图片下载）。
3.  **交付层**：
    *   Python 后端将下载的图片或合成的 PDF 存储在本地。
    *   Node.js 前端将封面图片放入合并转发，并单独使用 `e.reply(segment.file('file://' + pdfPath, fileName))` 发送 PDF；大文件通过本地文件路径交给适配器处理。

## ⚠️ 免责声明

*   本项目仅供技术研究和学习交流使用，**严禁用于任何商业用途**。
*   使用者应对自己的行为负责，下载的内容请在 24 小时内删除。
*   开发者不承担因使用本项目而产生的任何法律责任。

## 🤝 致谢

*   特别感谢 [hect0x7](https://github.com/hect0x7) 大佬开源的 [JMComic-Crawler-Python](https://github.com/hect0x7/JMComic-Crawler-Python) 项目，为本插件提供了强大的核心支持。
*   感谢 [excellen114514](https://github.com/excellen114514) 开源的 [jmcomic-plugin](https://github.com/excellen114514/jmcomic-plugin) 项目提供了灵感与基础。
