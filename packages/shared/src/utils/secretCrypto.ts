import {
  bytesToArrayBuffer,
  base64ToBytes,
  bytesToBase64,
  bytesToUtf8,
  utf8ToBytes,
} from './encoding.js';

export const ENCRYPTED_SECRET_PREFIX = 'v1:';

export function isEncryptedSecretValue(value: string): boolean {
  return value.startsWith(ENCRYPTED_SECRET_PREFIX);
}

export async function encryptSecretValue(
  value: string,
  encryptionSecret: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesGcmKey(encryptionSecret);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    bytesToArrayBuffer(utf8ToBytes(value)),
  );
  return `${ENCRYPTED_SECRET_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(encrypted)}`;
}

export async function decryptSecretValue(
  value: string,
  encryptionSecret: string,
): Promise<string> {
  if (!isEncryptedSecretValue(value)) return value;

  const [, ivB64, dataB64, extra] = value.split(':');
  if (!ivB64 || !dataB64 || extra !== undefined) {
    throw new Error('Invalid encrypted secret format.');
  }

  const key = await aesGcmKey(encryptionSecret);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytesToArrayBuffer(base64ToBytes(ivB64)) },
    key,
    bytesToArrayBuffer(base64ToBytes(dataB64)),
  );
  return bytesToUtf8(plain);
}

async function aesGcmKey(encryptionSecret: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytesToArrayBuffer(utf8ToBytes(encryptionSecret)),
  );
  return crypto.subtle.importKey(
    'raw',
    digest,
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}
