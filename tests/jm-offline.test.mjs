import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    fileToBase64Url,
    buildJmHelpText,
    buildRequirementInstallReply,
    formatComments,
    formatListPage,
    jmCommandPatterns,
    parseCategoryArgs,
    parseJmChapterArgs,
    parseJmId,
    parseJmIdAndPage,
    parsePageOnly,
    parseRankingArgs,
    parseTermAndPage,
    assertFileUploadSucceeded,
    replyFailureReason,
    sanitizeSendError,
    summarizeJmError,
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
    assert.equal(jmCommandPatterns.chapter.test('#jm查章1257267 2'), true);
    assert.equal(jmCommandPatterns.chapter.test('#jm查章JM1257267 2'), true);
    assert.equal(jmCommandPatterns.chapter.test('#jm查章 JM1257267 2'), true);
    assert.equal(jmCommandPatterns.album.test('#jm查章 JM123 2'), false);
    assert.equal(jmCommandPatterns.album.test('#jm查章1257267 2'), false);
    assert.equal(jmCommandPatterns.album.test('#jm查 JM 123'), true);
    assert.equal(jmCommandPatterns.favorites.test('#jm收藏夹 2'), true);
    assert.equal(jmCommandPatterns.favorites.test('#jm收藏夹2'), true);
    assert.equal(jmCommandPatterns.favorites.test('#jm收藏夹'), true);
    assert.equal(jmCommandPatterns.favorite.test('#jm收藏夹'), false);
    assert.equal(jmCommandPatterns.favorite.test('#jm收藏夹 2'), false);
    assert.equal(jmCommandPatterns.favorite.test('#jm收藏夹2'), false);
    assert.equal(jmCommandPatterns.favorite.test('#jm收藏 JM123'), true);
    assert.equal(jmCommandPatterns.favorite.test('#jm收藏123'), true);
    assert.equal(jmCommandPatterns.unfavorite.test('#jm取消收藏123'), true);
    assert.equal(jmCommandPatterns.favorite.test('#jm取消收藏123'), false);
});

test('ID commands accept either separator and pass captured IDs to parsers', () => {
    for (const input of [
        '#jm资料1257267', '#jm资料 1257267', '#jm资料JM1257267', '#jm资料 JM1257267'
    ]) {
        const match = input.match(jmCommandPatterns.info);
        assert.ok(match, input);
        assert.equal(parseJmId(match[1]), '1257267', input);
    }

    for (const input of ['#jm查1257267', '#jm查 JM1257267']) {
        const match = input.match(jmCommandPatterns.album);
        assert.ok(match, input);
        assert.equal(parseJmId(match[1]), '1257267', input);
    }

    for (const input of ['#jm查章1257267 2', '#jm查章JM1257267 2', '#jm查章 JM1257267 2']) {
        const match = input.match(jmCommandPatterns.chapter);
        assert.ok(match, input);
        assert.deepEqual(parseJmChapterArgs(match[1]), { jmId: '1257267', chapter: 2, valid: true }, input);
    }

    for (const input of ['#jm评论1257267', '#jm评论JM1257267 2', '#jm评论 JM1257267 2']) {
        const match = input.match(jmCommandPatterns.comments);
        assert.ok(match, input);
        const args = parseJmIdAndPage(match[1]);
        assert.equal(args.jmId, '1257267', input);
        assert.equal(args.page, input.includes(' 2') ? 2 : 1, input);
        assert.equal(args.valid, true, input);
    }

    for (const input of ['#jm资料', '#jm查章']) {
        const pattern = input === '#jm资料' ? jmCommandPatterns.info : jmCommandPatterns.chapter;
        const match = input.match(pattern);
        assert.ok(match, input);
        assert.equal(input === '#jm资料' ? parseJmId(match[1]) : parseJmChapterArgs(match[1]).valid, input === '#jm资料' ? null : false);
    }
});

test('search and tag commands preserve complete terms with optional separators', () => {
    for (const [pattern, input, expected] of [
        [jmCommandPatterns.search, '#jm搜无修正 2', { term: '无修正', page: 2, valid: true }],
        [jmCommandPatterns.search, '#jm搜 无修正 2', { term: '无修正', page: 2, valid: true }],
        [jmCommandPatterns.tag, '#jm标签中文 3', { term: '中文', page: 3, valid: true }],
        [jmCommandPatterns.tag, '#jm标签 中文 3', { term: '中文', page: 3, valid: true }]
    ]) {
        const match = input.match(pattern);
        assert.ok(match, input);
        assert.deepEqual(parseTermAndPage(match[1]), expected, input);
    }
});

test('ranking and category patterns capture compact and spaced help arguments', () => {
    for (const [input, pattern, parser, expected] of [
        ['#jm排行周', jmCommandPatterns.ranking, parseRankingArgs, { period: '周', category: '全部', page: 1 }],
        ['#jm排行 周', jmCommandPatterns.ranking, parseRankingArgs, { period: '周', category: '全部', page: 1 }],
        ['#jm分类同人', jmCommandPatterns.category, parseCategoryArgs, { category: '同人', order: '最新', time: '全部', page: 1 }],
        ['#jm分类 同人', jmCommandPatterns.category, parseCategoryArgs, { category: '同人', order: '最新', time: '全部', page: 1 }],
        ['#jm排行帮助', jmCommandPatterns.ranking, parseRankingArgs, { help: true }],
        ['#jm排行 帮助', jmCommandPatterns.ranking, parseRankingArgs, { help: true }],
        ['#jm分类帮助', jmCommandPatterns.category, parseCategoryArgs, { help: true }],
        ['#jm分类 帮助', jmCommandPatterns.category, parseCategoryArgs, { help: true }]
    ]) {
        const match = input.match(pattern);
        assert.ok(match, input);
        assert.deepEqual(parser(match[1]), expected, input);
    }
});

test('file, page, login, and API URL commands capture compact arguments', () => {
    for (const input of ['#jm压缩包123456', '#jm长图123456']) {
        const pattern = input.startsWith('#jm压缩包') ? jmCommandPatterns.zip : jmCommandPatterns.longImage;
        const match = input.match(pattern);
        assert.ok(match, input);
        assert.equal(parseJmId(match[1]), '123456', input);
    }

    for (const input of ['#jm图页JM123456 20', '#jm图页 123456']) {
        const match = input.match(jmCommandPatterns.pages);
        assert.ok(match, input);
        const args = parseJmIdAndPage(match[1]);
        assert.equal(args.jmId, '123456', input);
        assert.equal(args.page, input.endsWith('20') ? 20 : 1, input);
    }

    for (const input of ['#jm登录user pass', '#jm登录 user pass']) {
        const match = input.match(jmCommandPatterns.login);
        assert.ok(match, input);
        assert.deepEqual(match[1].trim().split(/\s+/u), ['user', 'pass'], input);
    }

    for (const input of ['#jm收藏夹2', '#jm收藏夹 2']) {
        const match = input.match(jmCommandPatterns.favorites);
        assert.ok(match, input);
        assert.deepEqual(parsePageOnly(match[1]), { page: 2, valid: true }, input);
    }
    for (const input of ['#jm收藏123', '#jm收藏 JM123']) {
        const match = input.match(jmCommandPatterns.favorite);
        assert.ok(match, input);
        assert.equal(parseJmId(match[1]), '123', input);
    }
    for (const input of ['#jm取消收藏123', '#jm点赞状态123']) {
        const pattern = input.startsWith('#jm取消收藏') ? jmCommandPatterns.unfavorite : jmCommandPatterns.likeStatus;
        const match = input.match(pattern);
        assert.ok(match, input);
        assert.equal(parseJmId(match[1]), '123', input);
    }

    for (const input of ['#jm设置api地址http://127.0.0.1:8000', '#jm设置api地址 http://127.0.0.1:8000']) {
        const match = input.match(jmCommandPatterns.apiUrl);
        assert.ok(match, input);
        assert.equal(match[1], 'http://127.0.0.1:8000', input);
    }
});

test('help command pattern is case-insensitive and matches only the complete command', () => {
    for (const input of ['#jm帮助', '#jmhelp', '#JMHELP', '#jm帮助   ']) {
        assert.equal(jmCommandPatterns.help.test(input), true, input);
    }

    for (const input of [
        '#jm查',
        '#jm帮助参数',
        '#jmhelp 参数',
        '#jm查 JM123',
        '#jm查章 JM123 2',
        '#jm排行帮助',
        '#jm排行 帮助',
        '#jm分类帮助',
        '#jm分类 帮助',
        '#jm搜 无修正',
        '#jm资料 JM123',
        '#jm收藏夹 2'
    ]) {
        assert.equal(jmCommandPatterns.help.test(input), false, input);
    }
});

test('help text lists public and owner-only commands with access notes', () => {
    const message = buildJmHelpText();
    for (const command of [
        '#jm查', '#jm查章', '#jm搜', '#jm标签', '#jm资料', '#jm评论', '#jm排行', '#jm分类',
        '#jm压缩包', '#jm长图', '#jm图页', '#jm登录', '#jm收藏夹', '#jm收藏', '#jm取消收藏',
        '#jm点赞状态', '#jm启动api', '#jm重启api', '#jm检查api', '#jm定时检查', '#jm安装依赖',
        '#jm路径写入', '#jm设置api地址'
    ]) {
        assert.ok(message.includes(command), command);
    }
    assert.match(message, /主人指令（仅主人可用）/);
    assert.match(message, /#jm登录 \[账号 密码\].*仅私聊/);
    assert.match(message, /无参数时查看状态/);
    assert.match(message, /指令和参数之间可加空格，也可不加/);
    assert.doesNotMatch(message, /车号前需要空格/);
    assert.match(message, /#jm排行 帮助/);
    assert.match(message, /#jm分类 帮助/);
});

test('sanitizeSendError removes base64 file contents', () => {
    const secretPayload = 'base64://YWJjZGVmZ2hpamtsbW5vcA==';
    const message = sanitizeSendError(`upload rejected: ${secretPayload}`);
    assert.ok(message.includes('base64://[内容已隐藏]'));
    assert.ok(!message.includes('YWJjZGVm'));

    const credentials = sanitizeSendError('账号：secret-user 密码：secret-password');
    assert.ok(!credentials.includes('secret-user'));
    assert.ok(!credentials.includes('secret-password'));
});

test('dependency install replies never include process output', () => {
    const logs = [
        'Requirement already satisfied: requests',
        'Traceback (most recent call last):',
        'cookie: session=secret-cookie',
        'access_token=secret-token',
        'base64://YWJjZGVmZ2hpamtsbW5vcA=='
    ].join('\n');
    const successReply = buildRequirementInstallReply({ success: true, stdout: logs, stderr: logs });
    const failureReply = buildRequirementInstallReply({ success: false, code: 1, stdout: logs, stderr: logs, message: logs });

    assert.equal(successReply, '虚拟环境依赖安装成功。');
    assert.match(failureReply, /虚拟环境依赖安装失败.*退出码 1/);
    assert.match(failureReply, /服务器 Yunzai 日志/);
    for (const reply of [successReply, failureReply]) {
        assert.doesNotMatch(reply, /Requirement already satisfied|Traceback|secret-cookie|secret-token|YWJjZGVm/);
    }
});

test('error summaries redact credentials, cookies, tokens, base64 and traceback bodies', () => {
    const secretText = [
        'Traceback (most recent call last):',
        '  File "app.py", line 12, in request',
        'RuntimeError: account=secret-user password="secret password" cookie: session=secret-cookie token=secret-token base64://YWJjZGVm'
    ].join('\n');
    const summary = summarizeJmError(secretText);

    assert.ok(summary.startsWith('RuntimeError:'));
    for (const secret of ['secret-user', 'secret password', 'secret-cookie', 'secret-token', 'YWJjZGVm']) {
        assert.ok(!summary.includes(secret), secret);
    }
    assert.ok(summary.length <= 180);
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
