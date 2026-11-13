import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    fileToBase64Url,
    formatComments,
    formatListPage,
    jmCommandPatterns,
    parseJmChapterArgs,
    parseJmId,
    parseJmIdAndPage,
    parseTermAndPage,
    assertFileUploadSucceeded,
    replyFailureReason,
    sanitizeSendError,
    uploadLocalFile
} from '../apps/jm-utils.mjs';

test('parseJmId accepts numeric IDs with optional JM prefix and whitespace', () => {
    for (const input of [
        'JM1257267',
        'jm1257267',
        'jm 1257267',
        'JM 1257267',
        ' 1257267 ',
        '\tJM 12 57267\n'
    ]) {
        assert.equal(parseJmId(input), '1257267', input);
    }
});

test('parseJmId rejects empty, non-positive, non-integer and unsafe IDs', () => {
    for (const input of [
        '',
        '   ',
        'JM',
        '0',
        'JM 0',
        '-1',
        '1.5',
        '12a',
        'JM abc',
        '9007199254740992'
    ]) {
        assert.equal(parseJmId(input), null, input);
    }
});

test('parseTermAndPage accepts multiword terms and optional trailing page numbers', () => {
    assert.deepEqual(parseTermAndPage('无修正'), { term: '无修正', page: 1, valid: true });
    assert.deepEqual(parseTermAndPage('无 修 正 2'), { term: '无 修 正', page: 2, valid: true });
    assert.equal(parseTermAndPage('无修正 0').valid, false);
    assert.equal(parseTermAndPage('').valid, false);
});

test('parseJmIdAndPage supports a separated JM prefix and optional page', () => {
    assert.deepEqual(parseJmIdAndPage('JM 123'), { jmId: '123', page: 1, valid: true });
    assert.deepEqual(parseJmIdAndPage('jm123 2'), { jmId: '123', page: 2, valid: true });
    assert.equal(parseJmIdAndPage('JM 0 2').valid, false);
});

test('chapter parser and command patterns keep specific commands separate', () => {
    assert.deepEqual(parseJmChapterArgs('JM 123 4'), { jmId: '123', chapter: 4, valid: true });
    assert.equal(parseJmChapterArgs('123 0').valid, false);

    assert.equal(jmCommandPatterns.chapter.test('#jm查章 JM123 2'), true);
    assert.equal(jmCommandPatterns.album.test('#jm查章 JM123 2'), false);
    assert.equal(jmCommandPatterns.album.test('#jm查 JM 123'), true);
    assert.equal(jmCommandPatterns.favorites.test('#jm收藏夹 2'), true);
    assert.equal(jmCommandPatterns.favorite.test('#jm收藏夹 2'), false);
    assert.equal(jmCommandPatterns.favorite.test('#jm收藏 JM123'), true);
});

test('sanitizeSendError removes base64 file contents', () => {
    const secretPayload = 'base64://YWJjZGVmZ2hpamtsbW5vcA==';
    const message = sanitizeSendError(`upload rejected: ${secretPayload}`);
    assert.ok(message.includes('base64://[内容已隐藏]'));
    assert.ok(!message.includes('YWJjZGVm'));
});

test('reply receipt detection accepts message IDs and rejects missing receipts', () => {
    assert.equal(replyFailureReason({ data: { message_id: 123 } }), null);
    assert.equal(replyFailureReason('12345'), null);
    assert.match(replyFailureReason(undefined), /未返回消息回执/);
    assert.match(replyFailureReason({ retcode: 100, msg: 'blocked' }), /retcode 100/);
});

test('list formatter includes tags, page count and next-page command', () => {
    const message = formatListPage([
        { id: '123', title: '标题', tags: ['中文', '无修正'] }
    ], { page: 1, pageCount: 3, total: 42, command: '#jm搜 关键词 {page}' });
    assert.match(message, /JM123 标题/);
    assert.match(message, /标签：中文、无修正/);
    assert.match(message, /第 1\/3 页/);
    assert.match(message, /下一页：#jm搜 关键词 2/);
});

test('comment formatter folds spoilers, indents replies and bounds comment text', () => {
    const publicText = '普通评论 '.repeat(100);
    const spoilerText = '剧透机密内容';
    const message = formatComments([
        {
            username: '甲', time: '今天', content: publicText, spoiler: false,
            replies: [{ username: '乙', content: '回复内容', spoiler: false, replies: [] }]
        },
        { username: '丙', content: spoilerText, spoiler: true, replies: [] }
    ], { page: 1, pageCount: 2, total: 22, jmId: '123' });
    assert.match(message, /  ↳ 乙/);
    assert.match(message, /【剧透】内容已折叠/);
    assert.ok(!message.includes(spoilerText));
    assert.ok(message.length < publicText.length);
    assert.match(message, /下一页：#jm评论 JM123 2/);
});

test('fileToBase64Url preserves the exact file bytes', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jm-base64-test-'));
    const filePath = path.join(tempDir, 'small.pdf');
    const original = Buffer.from('%PDF-1.4\nsmall offline fixture\n%%EOF\n');

    try {
        await fs.writeFile(filePath, original);
        const base64Url = await fileToBase64Url(filePath);
        assert.ok(base64Url.startsWith('base64://'));
        assert.deepEqual(Buffer.from(base64Url.slice('base64://'.length), 'base64'), original);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test('uploadLocalFile sends base64 through the matching OneBot file API', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jm-upload-test-'));
    const filePath = path.join(tempDir, 'fixture.pdf');
    const bytes = Buffer.from('%PDF fixture');
    await fs.writeFile(filePath, bytes);

    try {
        for (const [event, expectedAction, expectedParams] of [
            [{ group_id: 123, bot: { sendApi: async () => ({ retcode: 0 }) } }, 'upload_group_file', { group_id: 123 }],
            [{ user_id: 456, bot: { sendApi: async () => ({ retcode: 0 }) } }, 'upload_private_file', { user_id: 456 }]
        ]) {
            let sent;
            event.bot.sendApi = async (action, params) => {
                sent = { action, params };
                return { retcode: 0 };
            };
            await uploadLocalFile(event, filePath, 'fixture.pdf');
            assert.equal(sent.action, expectedAction);
            assert.deepEqual(Buffer.from(sent.params.file.slice('base64://'.length), 'base64'), bytes);
            assert.deepEqual(Object.keys(sent.params).sort(), [...Object.keys(expectedParams), 'file', 'name'].sort());
            assert.equal(sent.params.name, 'fixture.pdf');
        }

        assert.throws(() => assertFileUploadSucceeded({ retcode: 100, msg: 'blocked' }), /retcode 100/);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

/*
 * Do not replace the direct upload with e.reply(segment.file(path)) or a large
 * file segment: the OneBot adapter passes local paths to the separate QQ
 * container, and Bot.Buffer writes buffers over its default 10 MiB threshold
 * to its own local temp path. Both paths are inaccessible to that container.
 */
