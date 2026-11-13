import common from '../../../lib/common/common.js';
import plugin from '../../../lib/plugins/plugin.js';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { jmApi } from './apiget.js';
import {
    CATEGORY_HELP,
    RANKING_HELP,
    buildJmHelpText,
    formatComments,
    formatListPage,
    jmCommandPatterns,
    parseCategoryArgs,
    parseJmChapterArgs,
    parseJmId,
    parseJmIdAndPage,
    parsePageOnly,
    parsePositiveInteger,
    parseRankingArgs,
    parseTermAndPage,
    replyFailureReason,
    sanitizeSendError,
    uploadLocalFile
} from './jm-utils.mjs';

const {
    apiBase,
    ensureApiRunning,
    fetchWithTimeout,
    maxPdfMb,
    requestTimeoutMs,
    safeReply
} = jmApi;

class ApiError extends Error {
    constructor(message, status = 500, extra = {}) {
        super(message);
        this.status = status;
        Object.assign(this, extra);
    }
}

function chunkText(text, maxLength = 2600) {
    const chunks = [];
    let current = '';
    for (const line of String(text).split('\n')) {
        const next = current ? `${current}\n${line}` : line;
        if (current && next.length > maxLength) {
            chunks.push(current);
            current = line;
        } else {
            current = next;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

async function sendForward(e, nodes, title) {
    try {
        const forward = await common.makeForwardMsg(e, nodes, title);
        const result = await e.reply(forward);
        const failure = replyFailureReason(result);
        return failure ? { ok: false, reason: failure } : { ok: true };
    } catch (error) {
        return { ok: false, reason: sanitizeSendError(error) };
    }
}

async function sendLongText(e, text, title, fallback) {
    if (text.length <= 3200) return safeReply(e, text);
    const result = await sendForward(e, chunkText(text), title);
    if (result.ok) return true;
    const preview = text.split('\n').slice(0, 7).join('\n');
    return safeReply(e, `${fallback}，合并转发未确认送达（${result.reason}）。\n${preview}`);
}

async function requestJson(e, route, { query = {}, method = 'GET', body = null, progress = '正在获取…' } = {}) {
    await safeReply(e, progress);
    try {
        await ensureApiRunning();
        const url = new URL(`${apiBase()}${route}`);
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        }
        const options = { method, headers: {} };
        if (body !== null) {
            options.headers['content-type'] = 'application/json';
            options.body = JSON.stringify(body);
        }
        const response = await fetchWithTimeout(url.toString(), requestTimeoutMs(), options);
        let result;
        try {
            result = await response.json();
        } catch (_) {
            throw new ApiError(`API 返回了无法识别的数据（HTTP ${response.status}）`, response.status);
        }
        if (!response.ok || result?.ok !== true) {
            throw new ApiError(result?.error || `请求失败（HTTP ${response.status}）`, response.status, result);
        }
        return result;
    } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error.name === 'AbortError') throw new ApiError('请求超时，请稍后重试', 408);
        throw new ApiError(sanitizeSendError(error), 503);
    }
}

function failureText(error) {
    if (error.status === 401) return '未登录，请私聊主人发送 #jm登录 账号 密码';
    return `获取失败：${sanitizeSendError(error)}`;
}

async function loadList(e, route, query, command, title) {
    const result = await requestJson(e, route, { query });
    const text = formatListPage(result.items || [], {
        page: result.page || query.page || 1,
        pageCount: result.page_count,
        total: result.total,
        command
    });
    await sendLongText(e, `${title}\n${text}`, title, `${title}结果较长`);
    return true;
}

function listUsage(prefix, command) {
    return `用法：#jm${prefix} <关键词> [页码]\n示例：${command}`;
}

async function sendFile(e, filePath, fileName, context, includeCover = false, pageCount = null, previewPathOverride = null) {
    let coverStatus = '';
    if (includeCover) {
        const previewPath = previewPathOverride || (filePath ? path.join(path.dirname(filePath), fileName.replace(/\.pdf$/i, '.cover-preview.jpg')) : '');
        if (previewPath && fs.existsSync(previewPath)) {
            const coverResult = await sendForward(e, [
                `${context}${pageCount ? `，共 ${pageCount} 页` : ''}`,
                [segment.image(pathToFileURL(path.resolve(previewPath)).href)]
            ], `${context}封面`);
            if (coverResult.ok) coverStatus = '封面已发送';
            else {
                const blocked = /消息回执|message_id|未确认|retcode 100/i.test(coverResult.reason);
                coverStatus = blocked ? '封面被拦截' : '封面发送失败';
                await safeReply(e, `${context}的${coverStatus}：${coverResult.reason}，继续上传文件。`);
            }
        } else {
            coverStatus = '封面预览不可用';
        }
    }

    try {
        if (!filePath || !fs.existsSync(filePath)) throw new Error('后端返回的文件不存在');
        const size = fs.statSync(filePath).size;
        const maxBytes = maxPdfMb() * 1024 * 1024;
        if (!Number.isFinite(size) || size <= 0) throw new Error('文件体积无效');
        if (size > maxBytes) {
            throw new Error(`文件为 ${(size / 1024 / 1024).toFixed(2)} MB，超过发送上限 ${maxPdfMb()} MB，未上传`);
        }
        await uploadLocalFile(e, filePath, fileName);
        await safeReply(e, `${context}${coverStatus ? `，${coverStatus}` : ''}，文件 ${fileName} 已上传。`);
    } catch (error) {
        const suffix = coverStatus ? `；${coverStatus}` : '';
        await safeReply(e, `${context}${suffix}，文件未能上传：${sanitizeSendError(error)}`);
    }
    return true;
}

export class ejmFeatures extends plugin {
    constructor() {
        const rules = [
            { reg: jmCommandPatterns.help, fnc: 'help' },
            { reg: jmCommandPatterns.chapter, fnc: 'chapter' },
            { reg: jmCommandPatterns.unfavorite, fnc: 'unfavorite', permission: 'master' },
            { reg: jmCommandPatterns.likeStatus, fnc: 'likeStatus', permission: 'master' },
            { reg: jmCommandPatterns.favorites, fnc: 'favorites', permission: 'master' },
            { reg: jmCommandPatterns.comments, fnc: 'comments' },
            { reg: jmCommandPatterns.ranking, fnc: 'ranking' },
            { reg: jmCommandPatterns.category, fnc: 'category' },
            { reg: jmCommandPatterns.longImage, fnc: 'longImage' },
            { reg: jmCommandPatterns.pages, fnc: 'pages' },
            { reg: jmCommandPatterns.search, fnc: 'search' },
            { reg: jmCommandPatterns.tag, fnc: 'tag' },
            { reg: jmCommandPatterns.info, fnc: 'info' },
            { reg: jmCommandPatterns.zip, fnc: 'zip' },
            { reg: jmCommandPatterns.favorite, fnc: 'favorite', permission: 'master' },
            { reg: jmCommandPatterns.login, fnc: 'login', permission: 'master' }
        ];
        rules.sort((left, right) => right.reg.source.length - left.reg.source.length);
        super({ name: 'ejmFeatures', dsc: 'JM 搜索与资料功能', event: 'message', priority: 1, rule: rules });
    }

    async help(e) {
        return safeReply(e, buildJmHelpText());
    }

    async search(e) {
        const args = parseTermAndPage(e.msg.match(jmCommandPatterns.search)?.[1] || '');
        if (!args.valid) return safeReply(e, listUsage('搜', '#jm搜 无修正 2'));
        try {
            await loadList(e, '/search', { q: args.term, page: args.page }, `#jm搜 ${args.term} {page}`, `搜索：${args.term}`);
        } catch (error) {
            await safeReply(e, failureText(error));
        }
        return true;
    }

    async tag(e) {
        const args = parseTermAndPage(e.msg.match(jmCommandPatterns.tag)?.[1] || '');
        if (!args.valid) return safeReply(e, listUsage('标签', '#jm标签 中文 3'));
        try {
            await loadList(e, '/tag', { tag: args.term, page: args.page }, `#jm标签 ${args.term} {page}`, `标签：${args.term}`);
        } catch (error) {
            await safeReply(e, failureText(error));
        }
        return true;
    }

    async info(e) {
        const jmId = parseJmId(e.msg.match(jmCommandPatterns.info)?.[1] || '');
        if (!jmId) return safeReply(e, '用法：#jm资料 <车号>\n示例：#jm资料 JM123');
        try {
            const result = await requestJson(e, '/album_info', { query: { jm: jmId } });
            const lines = [
                `车号：JM${result.jm}`,
                `标题：${result.title || '未知'}`,
                `作者：${(result.authors || []).join('、') || '未知'}`,
                `标签：${(result.tags || []).join('、') || '无'}`,
                `人物：${(result.actors || []).join('、') || '无'}`,
                `作品：${(result.works || []).join('、') || '无'}`,
                `页数：${result.page_count || '未知'}`,
                `观看：${result.views || '未知'}　点赞：${result.likes || '未知'}　评论：${result.comment_count ?? '未知'}`
            ];
            if (result.logged_in) lines.push(`已点赞：${result.liked ? '是' : '否'}　已收藏：${result.is_favorite ? '是' : '否'}`);
            if (result.episodes?.length) {
                lines.push(`章节（${result.episodes.length}）：`);
                for (const episode of result.episodes) {
                    lines.push(`第${episode.index}话 ${episode.title}（photo_id=${episode.photo_id}）`);
                }
            } else {
                lines.push('章节：无分话信息');
            }
            const description = String(result.description || '').trim();
            if (description) lines.push(`简介：${description.slice(0, 600)}${description.length > 600 ? '…' : ''}`);
            await sendLongText(e, lines.join('\n'), `JM${jmId}资料`, '资料较长');
        } catch (error) {
            await safeReply(e, failureText(error));
        }
        return true;
    }

    async ranking(e) {
        const args = parseRankingArgs(e.msg.match(jmCommandPatterns.ranking)?.[1] || '');
        if (args.help) return safeReply(e, RANKING_HELP);
        if (args.error) return safeReply(e, `${args.error}\n用法：#jm排行 [日|周|月] [分类] [页码]`);
        try {
            const command = `#jm排行 ${args.period} ${args.category} {page}`;
            await loadList(e, '/ranking', { period: args.period, category: args.category, page: args.page }, command, `${args.period}榜 · ${args.category}`);
        } catch (error) {
            await safeReply(e, failureText(error));
        }
        return true;
    }

    async category(e) {
        const args = parseCategoryArgs(e.msg.match(jmCommandPatterns.category)?.[1] || '');
        if (args.help) return safeReply(e, CATEGORY_HELP);
        if (args.error) return safeReply(e, `${args.error}\n用法：#jm分类 [分类] [排序] [时间] [页码]`);
        try {
            const command = `#jm分类 ${args.category} ${args.order} ${args.time} {page}`;
            await loadList(e, '/category', args, command, `分类：${args.category} · ${args.order} · ${args.time}`);
        } catch (error) {
            await safeReply(e, failureText(error));
        }
        return true;
    }

    async comments(e) {
        const args = parseJmIdAndPage(e.msg.match(jmCommandPatterns.comments)?.[1] || '');
        if (!args.valid) return safeReply(e, '用法：#jm评论 <车号> [页码]\n示例：#jm评论 JM123 2');
        try {
            const result = await requestJson(e, '/comments', { query: { jm: args.jmId, page: args.page } });
            const text = formatComments(result.comments || [], {
                page: result.page || args.page,
                pageCount: result.page_count,
                total: result.total,
                jmId: args.jmId
            });
            await sendLongText(e, text, `JM${args.jmId}评论`, '评论较长');
        } catch (error) {
            await safeReply(e, failureText(error));
        }
        return true;
    }

    async chapter(e) {
        const args = parseJmChapterArgs(e.msg.match(jmCommandPatterns.chapter)?.[1] || '');
        if (!args.valid) return safeReply(e, '用法：#jm查章 <车号> <章节序号>\n示例：#jm查章 JM123 2');
        try {
            const result = await requestJson(e, '/chapter', { query: { jm: args.jmId, chapter: args.chapter } });
            await sendFile(e, result.pdf_path, `${args.jmId}-第${args.chapter}话.pdf`, `车号 JM${args.jmId} 第${args.chapter}话`, true, result.page_count, result.cover_preview_path);
        } catch (error) {
            if (error.status === 404 && Array.isArray(error.chapters)) {
                const available = error.chapters.map(item => `第${item.index}话 ${item.title}（photo_id=${item.photo_id}）`);
                return sendLongText(e, `未找到第${args.chapter}话。可用章节：\n${available.join('\n')}`, `JM${args.jmId}章节`, '章节列表较长');
            }
            await safeReply(e, failureText(error));
        }
        return true;
    }

    async zip(e) {
        const jmId = parseJmId(e.msg.match(jmCommandPatterns.zip)?.[1] || '');
        if (!jmId) return safeReply(e, '用法：#jm压缩包 <车号>\n示例：#jm压缩包 JM123');
        try {
            const result = await requestJson(e, '/zip', { query: { jm: jmId } });
            await sendFile(e, result.zip_path, result.file_name || `${jmId}.zip`, `车号 JM${jmId} ZIP`);
        } catch (error) {
            await safeReply(e, failureText(error));
        }
        return true;
    }

    async longImage(e) {
        const jmId = parseJmId(e.msg.match(jmCommandPatterns.longImage)?.[1] || '');
        if (!jmId) return safeReply(e, '用法：#jm长图 <车号>\n示例：#jm长图 JM123');
        try {
            const result = await requestJson(e, '/longimg', { query: { jm: jmId } });
            if (!result.image_path || !fs.existsSync(result.image_path)) throw new Error('后端返回的长图不存在');
            let failure;
            try {
                const reply = await e.reply(segment.image(pathToFileURL(path.resolve(result.image_path)).href));
                failure = replyFailureReason(reply);
            } catch (error) {
                failure = sanitizeSendError(error);
            }
            if (failure) await safeReply(e, `长图被拦截或发送失败（${failure}），请改用 #jm查 JM${jmId} 获取 PDF。`);
        } catch (error) {
            await safeReply(e, failureText(error));
        }
        return true;
    }

    async pages(e) {
        const match = e.msg.match(jmCommandPatterns.pages);
        const pageArgs = String(match?.[1] || '').match(/^\s*(?:jm\s*)?(\d+)(?:\s+(\d+))?\s*$/i);
        const jmId = parseJmId(pageArgs?.[1] || '');
        const limit = pageArgs?.[2] ? parsePositiveInteger(pageArgs[2]) : 20;
        if (!jmId || !limit || limit > 100) return safeReply(e, '用法：#jm图页 <车号> [页数上限，1-100]\n示例：#jm图页 JM123 20');
        try {
            const result = await requestJson(e, '/pages', { query: { jm: jmId, limit } });
            const previews = result.previews || [];
            for (let offset = 0; offset < previews.length; offset += 10) {
                const batch = previews.slice(offset, offset + 10);
                const nodes = batch.map(item => [
                    `第 ${item.index} 页`,
                    [segment.image(pathToFileURL(path.resolve(item.path)).href)]
                ]);
                const sent = await sendForward(e, nodes, `JM${jmId}页图 ${offset + 1}-${offset + batch.length}`);
                if (!sent.ok) {
                    await safeReply(e, `页图被拦截或发送失败（${sent.reason}），请改用 #jm查 JM${jmId} 获取 PDF。`);
                    return true;
                }
            }
            if (result.truncated) {
                await safeReply(e, `已发送前 ${previews.length} 页，共 ${result.page_count} 页；其余请用 #jm查 JM${jmId} 获取 PDF。`);
            } else if (!previews.length) {
                await safeReply(e, '没有可发送的页图。');
            }
        } catch (error) {
            await safeReply(e, failureText(error));
        }
        return true;
    }

    async login(e) {
        if (e.group_id) return safeReply(e, '请私聊发送 #jm登录 账号 密码');
        const match = e.msg.match(jmCommandPatterns.login);
        const credentials = String(match?.[1] || '').trim().split(/\s+/u).filter(Boolean);
        if (!credentials.length) {
            try {
                const result = await requestJson(e, '/login/status', { progress: '正在获取登录状态…' });
                return safeReply(e, result.configured
                    ? '登录信息已保存，可用 #jm收藏夹 验证。'
                    : '尚未配置登录信息。用法：#jm登录 账号 密码（仅限私聊）');
            } catch (error) {
                return safeReply(e, failureText(error));
            }
        }

        if (credentials.length !== 2) return safeReply(e, '用法：#jm登录 账号 密码（仅限私聊）');
        const [username, password] = credentials;

        try {
            await requestJson(e, '/login', {
                method: 'POST',
                body: { username, password },
                progress: '正在登录并保存配置…'
            });
            return safeReply(e, '登录成功，登录信息已保存在插件本地配置。');
        } catch (error) {
            return safeReply(e, `登录失败：${sanitizeSendError(error)}`);
        }
    }

    async favorite(e) {
        const jmId = parseJmId(e.msg.match(jmCommandPatterns.favorite)?.[1]);
        if (!jmId) return safeReply(e, '用法：#jm收藏 <车号>\n示例：#jm收藏 JM123');
        try {
            const result = await requestJson(e, '/favorite', { method: 'POST', body: { jm: jmId } });
            await safeReply(e, result.changed ? `车号 JM${jmId} 已加入收藏。` : `车号 JM${jmId} 已在收藏夹中。`);
        } catch (error) {
            await safeReply(e, failureText(error));
        }
        return true;
    }

    async unfavorite(e) {
        const jmId = parseJmId(e.msg.match(jmCommandPatterns.unfavorite)?.[1]);
        if (!jmId) return safeReply(e, '用法：#jm取消收藏 <车号>\n示例：#jm取消收藏 JM123');
        try {
            const result = await requestJson(e, '/unfavorite', { method: 'POST', body: { jm: jmId } });
            await safeReply(e, result.changed ? `车号 JM${jmId} 已取消收藏。` : `车号 JM${jmId} 原本未收藏。`);
        } catch (error) {
            await safeReply(e, failureText(error));
        }
        return true;
    }

    async favorites(e) {
        const match = e.msg.match(jmCommandPatterns.favorites);
        const args = parsePageOnly(match?.[1]);
        if (!args.valid) return safeReply(e, '用法：#jm收藏夹 [页码]\n示例：#jm收藏夹 2');
        try {
            await loadList(e, '/favorites', { page: args.page }, '#jm收藏夹 {page}', '我的收藏夹');
        } catch (error) {
            await safeReply(e, failureText(error));
        }
        return true;
    }

    async likeStatus(e) {
        const jmId = parseJmId(e.msg.match(jmCommandPatterns.likeStatus)?.[1]);
        if (!jmId) return safeReply(e, '用法：#jm点赞状态 <车号>\n示例：#jm点赞状态 JM123');
        try {
            const result = await requestJson(e, '/like_status', { query: { jm: jmId } });
            await safeReply(e, `车号 JM${jmId}：${result.liked ? '已点赞' : '未点赞'}，${result.is_favorite ? '已收藏' : '未收藏'}。`);
        } catch (error) {
            await safeReply(e, failureText(error));
        }
        return true;
    }
}
