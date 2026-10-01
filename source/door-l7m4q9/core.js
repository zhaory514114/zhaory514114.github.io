export const ITERATIONS = 600000;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const uid = () => crypto.randomUUID();
export function b64(bytes) {
  let value = '';
  for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
}
export function unb64(value) {
  if (typeof value !== 'string') throw new Error('存档格式不正确。');
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
export const newHeader = () => ({
  format: 'private-archive', version: 1, vault: uid(),
  salt: b64(crypto.getRandomValues(new Uint8Array(16))), iterations: ITERATIONS,
});
export function checkHeader(header) {
  if (header?.format !== 'private-archive' || header.version !== 1 || header.iterations !== ITERATIONS ||
      !UUID_PATTERN.test(header.vault) || unb64(header.salt).length !== 16) {
    throw new Error('存档格式不受支持或文件已损坏。');
  }
}
export async function derive(password, header) {
  checkHeader(header);
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: unb64(header.salt), iterations: ITERATIONS, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}
const aad = (header, id) => encoder.encode('private-archive|1|' + header.vault + '|' + id);
export async function seal(bytes, key, header, id) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(header, id), tagLength: 128 }, key, bytes,
  ));
  const result = new Uint8Array(iv.length + encrypted.length);
  result.set(iv); result.set(encrypted, iv.length);
  return result;
}
export async function open(bytes, key, header, id) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 28) throw new Error('密文文件不完整。');
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: aad(header, id), tagLength: 128 }, key, bytes.slice(12),
  ));
}
export async function pack(data, key, header) {
  return { ...header, ciphertext: b64(await seal(encoder.encode(JSON.stringify(data)), key, header, 'manifest')) };
}
export function validateManifest(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.messages)) throw new Error('存档内容格式错误。');
  const stringFields = ['account', 'sender', 'senderId', 'time', 'text'];
  for (const message of data.messages) {
    if (!message || !stringFields.every(field => typeof message[field] === 'string') ||
        !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(message.time) ||
        !Array.isArray(message.images)) throw new Error('存档中存在格式不正确的消息。');
    for (const image of message.images) {
      if (!image || (image.id != null && !UUID_PATTERN.test(image.id))) throw new Error('存档中存在格式不正确的图片引用。');
    }
  }
  return data;
}
export async function unpack(box, key) {
  checkHeader(box);
  return validateManifest(JSON.parse(decoder.decode(await open(unb64(box.ciphertext), key, box, 'manifest'))));
}
export function filterMessages(messages, { account = '', query = '', from = '', to = '' } = {}) {
  const keyword = query.trim().toLowerCase();
  return messages.filter(message =>
    (!account || message.account === account) &&
    (!from || message.time.slice(0, 10) >= from) &&
    (!to || message.time.slice(0, 10) <= to) &&
    (!keyword || (message.text + '\n' + message.sender).toLowerCase().includes(keyword)),
  ).sort((a, b) => a.time.localeCompare(b.time) || a.account.localeCompare(b.account));
}
export function imageMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) return 'image/png';
  const prefix = String.fromCharCode(...bytes.slice(0, 12));
  if (prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a')) return 'image/gif';
  if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}
