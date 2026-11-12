import fs from 'node:fs/promises';

export function parseJmId(raw) {
    const normalized = String(raw ?? '').replace(/\s+/gu, '').replace(/^jm/i, '');
    if (!/^\d+$/.test(normalized)) return null;

    const jmId = Number(normalized);
    if (!Number.isSafeInteger(jmId) || jmId <= 0) return null;
    return String(jmId);
}

export async function fileToBase64Url(filePath) {
    const file = await fs.readFile(filePath);
    return `base64://${file.toString('base64')}`;
}
