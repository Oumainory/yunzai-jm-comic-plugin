import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fileToBase64Url, parseJmId } from '../apps/jm-utils.mjs';

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

/*
 * Do not replace the direct upload with e.reply(segment.file(path)) or a large
 * file segment: the OneBot adapter passes local paths to the separate QQ
 * container, and Bot.Buffer writes buffers over its default 10 MiB threshold
 * to its own local temp path. Both paths are inaccessible to that container.
 */
