import fs from 'node:fs/promises';

export const jmCommandPatterns = Object.freeze({
    album: /^#jm查(?!章)(.*)$/i,
    chapter: /^#jm查章(?:\s+(.*))?\s*$/i,
    search: /^#jm搜\s*(.*?)\s*$/,
    tag: /^#jm标签\s*(.*?)\s*$/,
    info: /^#jm资料(?:\s+(.*))?\s*$/i,
    comments: /^#jm评论\s*(.*?)\s*$/,
    favorite: /^#jm收藏(?:\s+(.*))?\s*$/i,
    unfavorite: /^#jm取消收藏(?:\s+(.*))?\s*$/i,
    favorites: /^#jm收藏夹(?:\s+(.*))?\s*$/i,
    likeStatus: /^#jm点赞状态(?:\s+(.*))?\s*$/i,
    zip: /^#jm压缩包(?:\s+(.*))?\s*$/i,
    longImage: /^#jm长图(?:\s+(.*))?\s*$/i,
    pages: /^#jm图页(?:\s+(.*))?\s*$/i
});

export function parseJmId(raw) {
    const normalized = String(raw ?? '').replace(/\s+/gu, '').replace(/^jm/i, '');
    if (!/^\d+$/.test(normalized)) return null;

    const jmId = Number(normalized);
    if (!Number.isSafeInteger(jmId) || jmId <= 0) return null;
    return String(jmId);
}

export function parsePositiveInteger(raw, fallback = null) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const text = String(raw).trim();
    if (!/^\d+$/.test(text)) return null;
    const value = Number(text);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function parseTermAndPage(raw) {
    const tokens = String(raw ?? '').trim().split(/\s+/u).filter(Boolean);
    if (!tokens.length) return { term: '', page: 1, valid: false };

    let page = 1;
    if (/^\d+$/.test(tokens.at(-1))) {
        page = parsePositiveInteger(tokens.pop());
        if (!page) return { term: tokens.join(' '), page: null, valid: false };
    }

    const term = tokens.join(' ').trim();
    return { term, page, valid: Boolean(term) };
}

export function parseJmIdAndPage(raw) {
    const match = String(raw ?? '').match(/^\s*(?:jm\s*)?(\d+)(?:\s+(\d+))?\s*$/i);
    if (!match) return { jmId: null, page: null, valid: false };
    const jmId = parseJmId(match[1]);
    const page = match[2] === undefined ? 1 : parsePositiveInteger(match[2]);
    return { jmId, page, valid: Boolean(jmId && page) };
}

export function parseJmChapterArgs(raw) {
    const match = String(raw ?? '').match(/^\s*(?:jm\s*)?(\d+)\s+(\d+)\s*$/i);
    if (!match) return { jmId: null, chapter: null, valid: false };
    const jmId = parseJmId(match[1]);
    const chapter = parsePositiveInteger(match[2]);
    return { jmId, chapter, valid: Boolean(jmId && chapter) };
}

export function parsePageOnly(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return { page: 1, valid: true };
    const page = parsePositiveInteger(text);
    return { page, valid: Boolean(page) };
}

export function formatListPage(items, { page = 1, pageCount = null, total = null, command = '' } = {}) {
    const totalLabel = Number.isInteger(total) ? `，共 ${total} 条` : '';
    const pageLabel = Number.isInteger(pageCount) && pageCount > 0 ? `第 ${page}/${pageCount} 页` : `第 ${page} 页`;
    const lines = [`${pageLabel}${totalLabel}`];

    for (const [index, item] of items.entries()) {
        const id = String(item.id ?? item.jm ?? '').trim();
        const title = trimText(item.title ?? item.name ?? '（无标题）', 220);
        lines.push(`${index + 1}. JM${id} ${title}`.trim());
        const tags = normalizeTags(item.tags);
        if (tags.length) lines.push(`   标签：${trimText(tags.join('、'), 180)}`);
    }

    if (!items.length) lines.push('本页没有结果。');
    if (Number.isInteger(pageCount) && page < pageCount && command) {
        lines.push(`下一页：${command.replace('{page}', String(page + 1))}`);
    }
    return lines.join('\n');
}

export function formatComments(comments, { page = 1, pageCount = null, total = null, jmId = '' } = {}) {
    const totalLabel = Number.isInteger(total) ? `，共 ${total} 条` : '';
    const pageLabel = Number.isInteger(pageCount) && pageCount > 0 ? `第 ${page}/${pageCount} 页` : `第 ${page} 页`;
    const lines = [`评论：${pageLabel}${totalLabel}`, '剧透内容默认折叠。'];
    let commentNumber = 0;

    const appendComment = (comment, depth, prefix = '') => {
        const indent = '  '.repeat(Math.min(depth, 4));
        const username = trimText(comment.username || '匿名', 60);
        const time = trimText(comment.time || '', 40);
        const likes = comment.likes === undefined || comment.likes === null ? '' : ` 赞 ${comment.likes}`;
        const metadata = [username, time].filter(Boolean).join(' · ');
        lines.push(`${indent}${prefix}${metadata}${likes}`.trimEnd());
        if (comment.spoiler) {
            lines.push(`${indent}【剧透】内容已折叠`);
        } else {
            lines.push(`${indent}${trimText(comment.content || '（无文字内容）', 180)}`);
        }

        const replies = Array.isArray(comment.replies) ? comment.replies : [];
        for (const reply of replies.slice(0, 5)) appendComment(reply, depth + 1, '↳ ');
        if (replies.length > 5) lines.push(`${indent}  另有 ${replies.length - 5} 条回复`);
    };

    for (const comment of comments) {
        commentNumber += 1;
        lines.push(`${commentNumber}.`);
        appendComment(comment, 0);
    }
    if (!comments.length) lines.push('本页没有评论。');
    if (Number.isInteger(pageCount) && page < pageCount) lines.push(`下一页：#jm评论 JM${jmId} ${page + 1}`);
    return lines.join('\n');
}

export function sanitizeSendError(value) {
    const message = String(value?.message || value || '').replace(/base64:\/\/\S+/gi, 'base64://[内容已隐藏]');
    if (/delivery was not confirmed|no message receipt/i.test(message)) {
        return 'QQ 未确认消息送达（未返回消息回执）';
    }
    if (/retcode\s*[:=]?\s*100/i.test(message)) return 'QQ 返回 retcode 100，未确认消息送达';
    if (/EACCES|permission denied/i.test(message)) return '本地文件访问被拒绝（EACCES）';
    return (message.trim() || '未知错误').slice(0, 300);
}

function hasMessageId(value, visited = new Set()) {
    if (!value || typeof value !== 'object' || visited.has(value)) return false;
    visited.add(value);
    if (Array.isArray(value)) return value.some(item => hasMessageId(item, visited));
    if (value.message_id !== undefined && value.message_id !== null && value.message_id !== '') {
        return Array.isArray(value.message_id) ? value.message_id.length > 0 : true;
    }
    return Object.values(value).some(item => hasMessageId(item, visited));
}

export function replyFailureReason(result) {
    if (result === false || result === null || result === undefined) return '平台未返回消息回执';
    if (typeof result === 'string') {
        if (/delivery was not confirmed|no message receipt|retcode\s*[:=]?\s*100/i.test(result)) {
            return sanitizeSendError(result);
        }
        if (/^\d+$/.test(result.trim())) return null;
        return '平台未返回 message_id，无法确认消息已送达';
    }
    if (typeof result === 'object') {
        const retcode = Number(result.retcode);
        if (Number.isFinite(retcode) && ![0, 1].includes(retcode)) {
            return sanitizeSendError(`retcode ${retcode}: ${result.msg || result.wording || ''}`);
        }
        if (result.ok === false || /^(failed|error)$/i.test(String(result.status || ''))) {
            return sanitizeSendError(result.error || result.msg || result.wording || result.status);
        }
        if (hasMessageId(result)) return null;
        const detail = result.error || result.msg || result.wording || result.message;
        if (detail && /delivery was not confirmed|no message receipt|retcode\s*[:=]?\s*100/i.test(String(detail))) {
            return sanitizeSendError(detail);
        }
    }
    return '平台未返回 message_id，无法确认消息已送达';
}

export function assertFileUploadSucceeded(result) {
    if (result === false || result === null || result === undefined) {
        throw new Error('OneBot 未返回文件上传结果');
    }
    if (typeof result === 'object') {
        const retcode = Number(result.retcode);
        if (Number.isFinite(retcode) && ![0, 1].includes(retcode)) {
            throw new Error(`retcode ${retcode}: ${result.msg || result.wording || ''}`);
        }
        if (result.ok === false || /^(failed|error)$/i.test(String(result.status || ''))) {
            throw new Error(result.error || result.msg || result.wording || 'OneBot 返回上传失败');
        }
    } else if (typeof result === 'string' && /failed|error|retcode\s*[:=]?\s*100/i.test(result)) {
        throw new Error(result);
    }
}

export async function fileToBase64Url(filePath) {
    const file = await fs.readFile(filePath);
    return `base64://${file.toString('base64')}`;
}

export async function uploadLocalFile(e, filePath, fileName) {
    const file = await fileToBase64Url(filePath);
    let action;
    let params;
    if (e.group_id) {
        action = 'upload_group_file';
        params = { group_id: e.group_id, file, name: fileName };
    } else if (e.user_id) {
        action = 'upload_private_file';
        params = { user_id: e.user_id, file, name: fileName };
    } else {
        throw new Error('无法识别当前群聊或私聊对象');
    }
    const result = await e.bot.sendApi(action, params);
    assertFileUploadSucceeded(result);
    return result;
}

function normalizeTags(tags) {
    if (Array.isArray(tags)) return tags.map(tag => String(tag).trim()).filter(Boolean);
    if (typeof tags === 'string') return tags.split(/[、,，]/u).map(tag => tag.trim()).filter(Boolean);
    return [];
}

function trimText(value, maxLength) {
    const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
