import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { credentialRefSchema } from '../shared/models.js';
import { Store, HttpError } from './db.js';
import { runProcess } from './media.js';

// Secrets travel over stdin, never command arguments, receipts, or project documents.
export async function protectCredential(store: Store, value: string) {
  if (process.platform !== 'win32') throw new HttpError(400, '此平台请使用服务端环境变量凭据');
  if (!value.trim() || value.length > 16384) throw new HttpError(400, '密钥长度无效');
  const cipher = (
    await runProcess(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Add-Type -AssemblyName System.Security; $value=[Console]::In.ReadToEnd(); $bytes=[Text.Encoding]::UTF8.GetBytes($value); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))',
      ],
      { input: value },
    )
  ).trim();
  const id = randomUUID();
  store.db.prepare('INSERT INTO model_secrets VALUES(?,?,?)').run(id, cipher, Date.now());
  return { kind: 'dpapi' as const, key: id };
}
export async function resolveCredential(
  store: Store,
  raw: z.infer<typeof credentialRefSchema> | null,
) {
  if (!raw) return null;
  const ref = credentialRefSchema.parse(raw);
  if (ref.kind === 'env') {
    const value = process.env[ref.key];
    if (!value) throw new HttpError(409, '服务端凭据环境变量尚未配置：' + ref.key);
    return value;
  }
  if (process.platform !== 'win32')
    throw new HttpError(409, '本机加密凭据需要原 Windows 用户；请配置环境变量连接');
  const row = store.db.prepare('SELECT protected_value FROM model_secrets WHERE id=?').get(ref.key);
  if (!row) throw new HttpError(409, '固定连接的凭据不可用');
  try {
    return await runProcess(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Add-Type -AssemblyName System.Security; $value=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($value); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))',
      ],
      { input: String(row.protected_value) },
    );
  } catch {
    throw new HttpError(409, '无法读取本机加密凭据，请使用原 Windows 用户');
  }
}
