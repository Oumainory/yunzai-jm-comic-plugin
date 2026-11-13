# app.py
import sys
import subprocess
import os
import atexit

# 依赖检查与自动安装 (已禁用，避免Linux权限问题)
# 用户需手动运行 pip install -r requirements.txt
# required_packages = ['flask', 'psutil', 'python-dotenv', 'jmcomic', 'img2pdf']
# ... (removed auto install code) ...

# 检查核心依赖是否存在，如果不存在则友好提示
try:
    # 优先导入本地 jmcomic
    import sys
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    
    import jmcomic
    import img2pdf
    from flask import Flask, request, abort, send_file, jsonify
    import psutil
    from dotenv import load_dotenv
    from PIL import Image # 启用 PIL 以支持 WebP 转换
    from cover_preview import create_cover_preview
    from feature_api import FeatureApi, list_album_images, parse_feature_id
except ImportError as e:
    print(f"\n[Error] 缺少必要依赖: {e.name}")
    print("请手动运行安装命令:")
    print(f"pip install -r {os.path.join(os.path.dirname(os.path.abspath(__file__)), 'requirements.txt')}")
    if os.name != 'nt': # Linux/Mac
        print("注意: Linux环境下可能需要使用: pip3 install -r requirements.txt --break-system-packages")
    sys.exit(1)

from jmcomic.jm_config import JmModuleConfig
import shutil
import logging
import threading
import time
import gc
import psutil
import tracemalloc
from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

# 开启自动更新域名（确保全局生效，包括WSGI模式）
JmModuleConfig.FLAG_API_CLIENT_AUTO_UPDATE_DOMAIN = True

# Flask 初始化
app = Flask(__name__)

# 全局配置
# 获取当前脚本所在目录的绝对路径
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
# 默认使用当前目录的上级目录下的 resources 文件夹作为基础目录
DEFAULT_RESOURCES_DIR = os.path.abspath(os.path.join(CURRENT_DIR, '..', 'resources'))

JM_BASE_DIR = os.getenv('JM_BASE_DIR')

if not JM_BASE_DIR:
    # 如果环境变量不存在，则设置为默认的 resources 文件夹
    JM_BASE_DIR = DEFAULT_RESOURCES_DIR
    # 自动创建目录
    os.makedirs(JM_BASE_DIR, exist_ok=True)
    # 设置环境变量，以便 jmcomic 库或其他部分也能使用
    os.environ['JM_BASE_DIR'] = JM_BASE_DIR
    print(f"Environment variable 'JM_BASE_DIR' not set. Using default path: {JM_BASE_DIR}")
else:
    print(f"Using 'JM_BASE_DIR' from environment: {JM_BASE_DIR}")

# 确保目录存在（无论是环境变量指定的还是默认的）
if not os.path.exists(JM_BASE_DIR):
    try:
        os.makedirs(JM_BASE_DIR, exist_ok=True)
        print(f"Created directory: {JM_BASE_DIR}")
    except Exception as e:
        print(f"Error creating directory {JM_BASE_DIR}: {e}")

# 自动复制配置文件逻辑
target_option_path = os.path.join(JM_BASE_DIR, 'option.yml')
source_option_path = os.path.join(CURRENT_DIR, 'option.yml')

if not os.path.exists(target_option_path):
    if os.path.exists(source_option_path):
        try:
            shutil.copy(source_option_path, target_option_path)
            print(f"Successfully copied option.yml to {target_option_path}")
        except Exception as e:
            print(f"Error copying option.yml: {e}")
    else:
        print(f"Warning: option.yml not found in {CURRENT_DIR}, skipping copy.")

EXCLUDE_FOLDER = os.getenv('JM_EXCLUDE_FOLDER', 'long')
EXCLUDE_FOLDER_PDF = os.getenv('JM_EXCLUDE_FOLDER_PDF', 'pdf')
EXCLUDE_FOLDER_ZIP = 'zip'
FLASK_HOST = os.getenv('FLASK_HOST', '127.0.0.1')
FLASK_PORT = int(os.getenv('FLASK_PORT', '8000'))
JM_LOG_DIR = os.getenv('JM_LOG_DIR')
MEMORY_THRESHOLD = float(os.getenv('MEMORY_THRESHOLD', '80.0'))  # 内存使用百分比阈值

# 推导路径
IMAGE_FOLDER = os.path.join(JM_BASE_DIR, 'long')
PDF_FOLDER = os.path.join(JM_BASE_DIR, 'pdf')
ZIP_FOLDER = os.path.join(JM_BASE_DIR, 'zip')
OPTION_YML_PATH = os.path.join(JM_LOG_DIR if JM_LOG_DIR else JM_BASE_DIR, 'option.yml')

# 内存监控状态
memory_monitor_running = True
PID_FILE = os.path.join(CURRENT_DIR, 'app.pid')


def write_pid_file():
    with open(PID_FILE, 'w', encoding='utf-8') as pid_file:
        pid_file.write(f"{os.getpid()}\n")


def remove_pid_file():
    try:
        with open(PID_FILE, 'r', encoding='utf-8') as pid_file:
            recorded_pid = int(pid_file.read().strip())
        if recorded_pid == os.getpid():
            os.remove(PID_FILE)
    except (OSError, ValueError):
        pass


atexit.register(remove_pid_file)

# 全局 Option 对象
JM_OPTION = None

# 日志配置
def configure_logging():
    log_dir = JM_LOG_DIR if JM_LOG_DIR else JM_BASE_DIR
    os.makedirs(log_dir, exist_ok=True)
    log_file_path = os.path.join(log_dir, 'app.log')
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(message)s',
        handlers=[
            logging.FileHandler(log_file_path, encoding='utf-8'),
            logging.StreamHandler()
        ]
    )

# 初始化全局 Option
def get_jm_option(force_reload=False):
    global JM_OPTION
    if JM_OPTION is None or force_reload:
        try:
            logging.info(f"{'重新' if force_reload else '首次'}加载配置: {OPTION_YML_PATH}")
            JM_OPTION = jmcomic.create_option_by_file(OPTION_YML_PATH)
            
            # 强制覆盖下载路径和命名规则，确保 app.py 能找到文件
            if IMAGE_FOLDER:
                JM_OPTION.dir_rule.base_dir = IMAGE_FOLDER
                # 强制使用 ID 作为文件夹名，因为 app.py 的查找逻辑依赖于 ID
                JM_OPTION.dir_rule.rule = 'Bd_Aid' 
                logging.info(f"配置重写: base_dir -> {IMAGE_FOLDER}, rule -> Bd_Aid")
                
        except Exception as e:
            logging.error(f"加载配置失败: {str(e)}")
            raise e
    return JM_OPTION

# 文件夹清理函数
def cleanup_folders():
    """清理除指定文件夹外的所有目录"""
    if not os.path.exists(JM_BASE_DIR):
        logging.warning(f"目录不存在: {JM_BASE_DIR}")
        return

    for item in os.listdir(JM_BASE_DIR):
        item_path = os.path.join(JM_BASE_DIR, item)
        if os.path.isdir(item_path) and item not in [EXCLUDE_FOLDER, EXCLUDE_FOLDER_PDF, EXCLUDE_FOLDER_ZIP]:
            try:
                shutil.rmtree(item_path)
                logging.info(f"已删除: {item_path}")
            except Exception as e:
                logging.error(f"删除失败: {item_path} - {str(e)}")

# 下载函数
def download_album(jm_id):
    """下载专辑并返回是否成功"""
    try:
        # 尝试使用现有配置下载
        option = get_jm_option()
        jmcomic.download_album(jm_id, option)
        return True
    except Exception as e:
        logging.error(f"下载失败: {str(e)}")
        
        # 如果是配置相关问题导致失败，尝试重新加载配置并重试一次
        try:
            logging.info("尝试重新加载配置并重试下载...")
            option = get_jm_option(force_reload=True)
            jmcomic.download_album(jm_id, option)
            return True
        except Exception as retry_e:
            logging.error(f"重试下载失败: {str(retry_e)}")
            return False

# 手动合成 PDF 函数
def generate_pdf_from_images(images, pdf_output_path):
    """从明确给定的图片集合合成 PDF。"""
    import io
    try:
        if not images:
            logging.error("PDF合成失败: 图片列表为空")
            return False

        os.makedirs(os.path.dirname(os.path.abspath(pdf_output_path)), exist_ok=True)

        # 转换 WebP 或其他不兼容格式为 PDF 字节流
        # img2pdf 不直接支持 WebP，需要先转换
        converted_images = []
        
        try:
            for img_path in images:
                if img_path.lower().endswith(('.webp', '.gif')):
                    # 将 WebP 或 GIF 转换为 PDF 可用的 JPEG 字节流。
                    with Image.open(img_path) as img:
                        img.seek(0)
                        if img.mode != 'RGB':
                            img = img.convert('RGB')
                        
                        # 保存到内存 buffer
                        img_byte_arr = io.BytesIO()
                        img.save(img_byte_arr, format='JPEG')
                        converted_images.append(img_byte_arr.getvalue())
                else:
                    # 其他格式直接添加路径
                    converted_images.append(img_path)

            with open(pdf_output_path, "wb") as f:
                f.write(img2pdf.convert(converted_images))
        
            logging.info(f"手动合成 PDF 成功: {pdf_output_path}")
            return True
        except Exception as e:
            logging.error(f"PDF转换过程中出错: {str(e)}")
            return False
            
    except Exception as e:
        logging.error(f"手动合成 PDF 异常: {str(e)}")
        return False


def generate_pdf_manually(jm_id):
    """手动合成整本 PDF，忽略隔离保存的章节目录。"""
    album_dir = os.path.join(IMAGE_FOLDER, str(jm_id))
    if not os.path.isdir(album_dir):
        logging.error(f"PDF合成失败: 图片目录不存在 {album_dir}")
        return False
    images = album_images(album_dir)
    if not images:
        logging.error(f"PDF合成失败: 目录为空 {album_dir}")
        return False
    pdf_output_path = os.path.join(PDF_FOLDER, f"{jm_id}.pdf")
    return generate_pdf_from_images(images, pdf_output_path)

# 内存监控函数
def memory_monitor():
    """监控内存使用情况并在必要时触发垃圾回收"""
    global memory_monitor_running
    process = psutil.Process(os.getpid())
    
    # 启动内存跟踪
    tracemalloc.start()
    
    while memory_monitor_running:
        try:
            # 获取内存使用情况
            memory_info = process.memory_info()
            memory_percent = process.memory_percent()
            
            # 记录内存使用情况
            logging.info(f"内存使用: {memory_info.rss / 1024 / 1024:.2f} MB ({memory_percent:.2f}%)")
            
            # 如果内存使用超过阈值，触发垃圾回收
            if memory_percent > MEMORY_THRESHOLD:
                logging.warning(f"内存使用超过阈值 ({memory_percent:.2f}% > {MEMORY_THRESHOLD}%)，触发垃圾回收")
                gc.collect()
                
                # 显示内存分配跟踪
                snapshot = tracemalloc.take_snapshot()
                top_stats = snapshot.statistics('lineno')
                
                logging.info("内存分配前10:")
                for stat in top_stats[:10]:
                    logging.info(f"  {stat}")
                
            # 每30秒检查一次
            time.sleep(30)
        except Exception as e:
            logging.error(f"内存监控错误: {str(e)}")
            time.sleep(60)  # 出错后等待更长时间

def check_and_release_port(port):
    """只停止占用目标端口且确认为本插件 app.py 的旧进程。"""
    try:
        current_pid = os.getpid()
        app_script = os.path.realpath(os.path.abspath(__file__))
        pyapi_dir = os.path.realpath(CURRENT_DIR)

        for proc in psutil.process_iter(['pid', 'name', 'cmdline', 'cwd']):
            try:
                if proc.pid == current_pid:
                    continue
                command = proc.info.get('cmdline') or []
                if not command or 'python' not in os.path.basename(command[0]).lower():
                    continue
                try:
                    process_cwd = os.path.realpath(proc.info.get('cwd') or proc.cwd())
                except (psutil.AccessDenied, psutil.NoSuchProcess):
                    process_cwd = ''

                def points_to_plugin_app(arg):
                    if not arg.lower().endswith('app.py'):
                        return False
                    if os.path.isabs(arg):
                        script_path = arg
                    elif process_cwd:
                        script_path = os.path.join(process_cwd, arg)
                    else:
                        return False
                    return os.path.normcase(os.path.realpath(script_path)) == os.path.normcase(app_script)

                has_app_script = any(points_to_plugin_app(arg) for arg in command[1:])
                if not has_app_script:
                    continue

                listening = any(
                    connection.status == psutil.CONN_LISTEN
                    and connection.laddr
                    and connection.laddr.port == port
                    for connection in proc.net_connections(kind='inet')
                )
                if not listening:
                    continue

                logging.warning(f"检测到本插件旧 API 进程占用端口 {port}，PID={proc.pid}，准备停止")
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                    logging.info(f"本插件旧 API 进程 PID={proc.pid} 已停止")
                except psutil.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=3)
                    logging.info(f"本插件旧 API 进程 PID={proc.pid} 已强制停止")
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue
            except Exception as e:
                logging.warning(f"检查进程 PID={proc.pid} 失败: {e}")
    except Exception as e:
        logging.error(f"释放端口失败: {e}")

# 稳定 JSON 接口，供 Node 前端判断服务状态并等待整本处理完成。
@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'ok': True,
        'pid': os.getpid(),
        'status': 'running'
    })


def parse_album_id():
    return parse_feature_id(request.args.get('jm', ''))


def album_images(album_dir):
    return list_album_images(album_dir)


@app.route('/album', methods=['GET'])
def get_album():
    jm_id = parse_album_id()
    if jm_id is None:
        return jsonify({'ok': False, 'error': '参数 jm 必须为正整数', 'code': 400}), 400

    album_dir = os.path.abspath(os.path.join(IMAGE_FOLDER, str(jm_id)))
    pdf_path = os.path.abspath(os.path.join(PDF_FOLDER, f'{jm_id}.pdf'))
    try:
        images = album_images(album_dir)
        if not images:
            if not download_album(jm_id):
                return jsonify({'ok': False, 'error': '下载失败，请稍后重试', 'code': 503}), 503
            images = album_images(album_dir)

        if not images:
            return jsonify({'ok': False, 'error': '下载后仍未找到专辑图片', 'code': 404}), 404

        if not os.path.isfile(pdf_path) or os.path.getsize(pdf_path) <= 0:
            logging.info(f"PDF不存在，开始手动合成: {jm_id}")
            if not generate_pdf_manually(jm_id) or not os.path.isfile(pdf_path) or os.path.getsize(pdf_path) <= 0:
                return jsonify({'ok': False, 'error': '专辑图片已获取，但 PDF 合成失败', 'code': 500}), 500

        cover_preview_path = os.path.abspath(os.path.join(PDF_FOLDER, f'{jm_id}.cover-preview.jpg'))
        try:
            create_cover_preview(images[0], cover_preview_path)
        except Exception as preview_error:
            logging.warning(f"封面预览图生成失败 {jm_id}: {preview_error}")
            cover_preview_path = None

        return jsonify({
            'ok': True,
            'jm': jm_id,
            'page_count': len(images),
            'cover_path': images[0],
            'cover_preview_path': cover_preview_path,
            'pdf_path': pdf_path,
            'pdf_size': os.path.getsize(pdf_path),
            'album_dir': album_dir
        })
    except Exception as e:
        logging.exception(f"处理专辑 {jm_id} 失败")
        return jsonify({'ok': False, 'error': f'处理专辑时发生错误：{e}', 'code': 500}), 500


FEATURE_API = FeatureApi(
    app=app,
    get_option=get_jm_option,
    image_folder=IMAGE_FOLDER,
    pdf_folder=PDF_FOLDER,
    zip_folder=ZIP_FOLDER,
    download_album=download_album,
    pdf_builder=generate_pdf_from_images,
    auth_path=os.path.join(CURRENT_DIR, '..', 'config', 'jm-auth.json')
)
FEATURE_API.register_routes()


# 路由处理
@app.route('/jmd', methods=['GET'])
def get_image():
    jm_id = request.args.get('jm', type=int)
    # 增加健壮性校验
    if not isinstance(jm_id, int) or jm_id <= 0:
        abort(400, description="参数 jm 必须为正整数")

    # 定义支持的图片后缀
    SUPPORTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
    
    # 查找存在的图片文件
    image_path = None
    for ext in SUPPORTED_EXTENSIONS:
        temp_path = os.path.join(IMAGE_FOLDER, f"{jm_id}{ext}")
        if os.path.exists(temp_path):
            image_path = temp_path
            break
            
    # 如果没找到，尝试下载
    if not image_path:
        if not download_album(jm_id):
            abort(503, description="下载失败")
        
        # 下载后再次查找
        for ext in SUPPORTED_EXTENSIONS:
            temp_path = os.path.join(IMAGE_FOLDER, f"{jm_id}{ext}")
            if os.path.exists(temp_path):
                image_path = temp_path
                break
        
        # 特殊处理：如果是下载的是本子（album），图片可能在子文件夹里
        # jmcomic 下载本子默认会创建一个以 jm_id 命名的文件夹
        if not image_path:
            album_dir = os.path.join(IMAGE_FOLDER, str(jm_id))
            if os.path.exists(album_dir) and os.path.isdir(album_dir):
                # 获取第一张图片作为封面/预览
                for root, _, files in os.walk(album_dir):
                    files.sort() # 确保有序
                    for file in files:
                        if file.lower().endswith(tuple(SUPPORTED_EXTENSIONS)):
                            image_path = os.path.join(root, file)
                            break
                    if image_path:
                        break

        if not image_path:
            # 记录目录内容以便调试
            try:
                if os.path.exists(IMAGE_FOLDER):
                    files = os.listdir(IMAGE_FOLDER)
                    logging.error(f"Image not found for {jm_id}. Files in {IMAGE_FOLDER}: {files}")
                else:
                    logging.error(f"Image folder not found: {IMAGE_FOLDER}")
            except Exception as e:
                logging.error(f"Error listing files: {e}")
            abort(404, description="资源下载后仍未找到")

    # 根据文件扩展名确定 MIME 类型
    import mimetypes
    mimetype, _ = mimetypes.guess_type(image_path)
    if not mimetype:
        mimetype = 'image/png' # 默认值

    return send_file(image_path, mimetype=mimetype)

@app.route('/jmdp', methods=['GET'])
def get_pdf():
    jm_id = request.args.get('jm', type=int)
    # 增加健壮性校验
    if not isinstance(jm_id, int) or jm_id <= 0:
        abort(400, description="参数 jm 必须为正整数")

    pdf_path = os.path.join(PDF_FOLDER, f"{jm_id}.pdf")

    if not os.path.exists(pdf_path):
        logging.info(f"PDF不存在，开始下载: {jm_id}")
        if not download_album(jm_id):
            abort(503, description="下载失败")
        
        # 强制检查并生成 PDF
        if not os.path.exists(pdf_path):
            logging.info(f"插件未生成PDF，尝试手动合成: {jm_id}")
            if not generate_pdf_manually(jm_id):
                abort(500, description="PDF生成失败")
        
        if not os.path.exists(pdf_path):
            abort(404, description="资源下载后仍未找到")

    return send_file(pdf_path, mimetype='application/pdf')

@app.route('/cleanup', methods=['POST'])
def cleanup():
    """手动触发清理"""
    cleanup_folders()
    return '清理完成'

@app.route('/memory', methods=['GET'])
def memory_info():
    """获取当前内存使用信息"""
    process = psutil.Process(os.getpid())
    memory_info = process.memory_info()
    memory_percent = process.memory_percent()
    
    return {
        'rss_mb': memory_info.rss / 1024 / 1024,
        'vms_mb': memory_info.vms / 1024 / 1024,
        'percent': memory_percent
    }

@app.route('/gc', methods=['POST'])
def trigger_gc():
    """手动触发垃圾回收"""
    collected = gc.collect()
    return f'垃圾回收完成，释放了 {collected} 个对象'

@app.route('/version', methods=['GET'])
def version():
    """获取版本和域名信息"""
    return {
        'version': jmcomic.__version__,
        'domain_api_list': JmModuleConfig.DOMAIN_API_LIST,
        'domain_api_updated_list': JmModuleConfig.DOMAIN_API_UPDATED_LIST
    }

@app.route('/')
def return_status():
    return 'api running!'

# 主程序
if __name__ == '__main__':
    configure_logging()
    write_pid_file()
    
    # 尝试在启动时立即更新一次域名，确保拿到最新的可用域名
    try:
        logging.info("正在尝试自动更新 API 域名列表...")
        from jmcomic import JmApiClient
        # 临时创建一个 client 来触发更新
        # Fix: 使用 option 创建 client，而不是直接传入 option
        get_jm_option().new_jm_client(impl=JmApiClient)
        logging.info(f"域名更新完成。当前可用 API 域名: {JmModuleConfig.DOMAIN_API_LIST}")
    except Exception as e:
        logging.error(f"域名自动更新失败: {e}，将使用默认域名列表")

    FEATURE_API.initialize_auth()

    logging.info("服务启动，执行首次清理...")
    cleanup_folders()
    
    # 启动内存监控线程
    monitor_thread = threading.Thread(target=memory_monitor, daemon=True)
    monitor_thread.start()
    logging.info("内存监控线程已启动")
    
    # 检查端口占用
    check_and_release_port(FLASK_PORT)

    try:
        app.run(
            host=FLASK_HOST,
            port=FLASK_PORT,
            debug=False,
            use_reloader=False,
            threaded=True
        )
    except OSError as e:
        if e.errno == 98 or e.errno == 10048: # Address already in use (Linux / Windows)
             logging.error(f"端口 {FLASK_PORT} 已被占用，请检查是否有其他服务正在运行，或修改 FLASK_PORT 环境变量。")
        else:
             logging.error(f"启动服务失败: {e}")
    except KeyboardInterrupt:
        logging.info("接收到中断信号，停止服务...")
    finally:
        # 停止内存监控
        memory_monitor_running = False
        monitor_thread.join(timeout=5)
        remove_pid_file()
        logging.info("服务已停止")
