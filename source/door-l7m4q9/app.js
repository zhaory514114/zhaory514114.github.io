import { checkHeader, derive, unpack, open, filterMessages, imageMime, UUID_PATTERN } from './core.js';

const $ = id => document.getElementById(id);
const text = (id, value) => { $(id).textContent = value; };
const PAGE_SIZE = 150;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_MEDIA_BYTES = 16 * 1024 * 1024 + 28;
const requests = new Set();
let envelope = null;
let data = null;
let key = null;
let epoch = 0;
let gateAttempt = 0;
let unlocking = false;
let selectedDay = '';
let visibleCount = PAGE_SIZE;
let lastActive = Date.now();
let imageAttempt = 0;
let imageRequest = null;
let pictureUrl = null;

function element(tag, className = '', content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
function isCurrent(generation) { return generation === epoch && Boolean(key); }
function showError(id, error) { text(id, error?.message || String(error)); }

async function limitedBytes(response, maximum) {
  const declared = Number(response.headers.get('Content-Length'));
  if (declared > maximum) throw new Error('文件过大，请在电脑上重新整理存档后上传。');
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maximum) throw new Error('文件超过当前阅读器的大小限制。');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw new Error('文件超过当前阅读器的大小限制。');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

async function readFile(path, maximum, controller) {
  requests.add(controller);
  try {
    const response = await fetch(path, {
      credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('文件暂时无法读取（' + response.status + '），请稍后重试。');
    return await limitedBytes(response, maximum);
  } finally { requests.delete(controller); }
}

async function loadGate() {
  const generation = epoch;
  const attempt = ++gateAttempt;
  const controller = new AbortController();
  envelope = null;
  $('unlockForm').hidden = true;
  $('unlock').disabled = true;
  $('retry').hidden = true;
  text('gateTitle', '你的私人存档');
  text('gateHint', '正在检查存档…');
  text('gateError', '');
  try {
    const bytes = await readFile('./vault.json', MAX_MANIFEST_BYTES, controller);
    if (generation !== epoch || attempt !== gateAttempt) return;
    if (!bytes) {
      text('gateTitle', '尚未导入聊天记录');
      text('gateHint', '阅读器已准备好。请先在本地将真实聊天打包成加密存档，再把存档文件放到这里。');
      return;
    }
    const candidate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    checkHeader(candidate);
    if (typeof candidate.ciphertext !== 'string') throw new Error('存档文件缺少加密内容。');
    envelope = candidate;
    $('unlockForm').hidden = false;
    $('unlock').disabled = false;
    text('gateHint', '输入密码，打开这份加密存档。');
  } catch (error) {
    if (generation !== epoch || attempt !== gateAttempt || error.name === 'AbortError') return;
    text('gateHint', '暂时无法读取存档，请检查文件或稍后重试。');
    showError('gateError', error instanceof SyntaxError ? new Error('存档文件不是有效的加密 JSON 文件。') : error);
  } finally {
    if (generation === epoch && attempt === gateAttempt) $('retry').hidden = false;
  }
}

function clearPicture() {
  imageAttempt++;
  imageRequest?.abort();
  imageRequest = null;
  $('picture').removeAttribute('src');
  $('picture').hidden = true;
  text('pictureStatus', '');
  if (pictureUrl) URL.revokeObjectURL(pictureUrl);
  pictureUrl = null;
}

function lock(reason = '') {
  epoch++;
  unlocking = false;
  for (const request of requests) request.abort();
  requests.clear();
  key = null;
  data = null;
  selectedDay = '';
  visibleCount = PAGE_SIZE;
  clearPicture();
  if ($('pictureDialog').open) $('pictureDialog').close();
  for (const id of ['password', 'search', 'from', 'to']) $(id).value = '';
  $('messages').replaceChildren();
  $('days').replaceChildren();
  $('accountFilter').replaceChildren(new Option('全部账号 · 合并时间线', ''));
  text('status', '');
  text('daysTotal', '聊天日期');
  text('viewTitle', '按日浏览');
  text('count', '0 条');
  text('gateError', '');
  text('gateTitle', '你的私人存档');
  text('gateHint', reason || '存档已锁定。再次输入密码即可查看。');
  $('unlock').disabled = !envelope;
  text('unlock', '解锁存档');
  $('unlockForm').hidden = !envelope;
  $('retry').hidden = false;
  $('more').hidden = true;
  $('empty').hidden = true;
  $('workspace').hidden = true;
  $('gate').hidden = false;
}

$('unlockForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!envelope || unlocking) return;
  const generation = ++epoch;
  const box = envelope;
  const password = $('password').value;
  $('password').value = '';
  $('unlock').disabled = true;
  $('retry').hidden = true;
  unlocking = true;
  text('unlock', '正在解锁…');
  text('gateError', '');
  try {
    const candidateKey = await derive(password, box);
    if (generation !== epoch || document.hidden) return;
    const candidateData = await unpack(box, candidateKey);
    if (generation !== epoch || document.hidden) return;
    key = candidateKey;
    data = candidateData;
    lastActive = Date.now();
    renderAccounts();
    render();
    $('gate').hidden = true;
    $('workspace').hidden = false;
  } catch (error) {
    if (generation !== epoch) return;
    key = null;
    data = null;
    showError('gateError', error.name === 'OperationError' ? new Error('密码不正确，或加密文件已损坏。') : error);
  } finally {
    if (generation === epoch) {
      unlocking = false;
      $('unlock').disabled = false;
      $('retry').hidden = false;
      text('unlock', '解锁存档');
    }
  }
});

function renderAccounts() {
  const accounts = [...new Set(data.messages.map(message => message.account))].sort();
  $('accountFilter').replaceChildren(
    new Option('全部账号 · 合并时间线', ''),
    ...accounts.map(account => new Option('账号 ' + account, account)),
  );
}

function render() {
  if (!data || !key) return;
  const query = $('search').value;
  const from = $('from').value;
  const to = $('to').value;
  const account = $('accountFilter').value;
  const invalidRange = Boolean(from && to && from > to);
  let rows = invalidRange ? [] : filterMessages(data.messages, { account, query, from, to });
  const days = new Map();
  for (const message of rows) {
    const day = message.time.slice(0, 10);
    days.set(day, (days.get(day) || 0) + 1);
  }
  if (selectedDay && !days.has(selectedDay)) selectedDay = '';
  const dayButtons = document.createDocumentFragment();
  function addDay(day, label, count) {
    const button = element('button', selectedDay === day ? 'active' : '', label);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(selectedDay === day));
    button.append(element('span', '', String(count)));
    button.addEventListener('click', () => {
      selectedDay = day;
      visibleCount = PAGE_SIZE;
      render();
      $('viewTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    dayButtons.append(button);
  }
  if (rows.length) addDay('', '全部日期', rows.length);
  for (const [day, count] of [...days].reverse()) addDay(day, day, count);
  $('days').replaceChildren(dayButtons);
  text('daysTotal', days.size + ' 个聊天日');
  if (selectedDay) rows = rows.filter(message => message.time.slice(0, 10) === selectedDay);
  text('viewTitle', selectedDay || '按日浏览');
  text('count', rows.length + ' 条');
  const missing = data.messages.reduce((sum, message) => sum + message.images.filter(image => !image.id).length, 0);
  text('status', invalidRange ? '开始日期不能晚于结束日期。' :
    data.messages.length ? '共保存 ' + data.messages.length + ' 条 · ' + missing + ' 张图片暂缺 · 日期按北京时间显示' : '尚未导入真实聊天记录。');
  $('empty').hidden = data.messages.length > 0;
  $('more').hidden = rows.length <= visibleCount;
  $('messages').replaceChildren();
  if (!rows.length && data.messages.length) {
    $('messages').append(element('p', 'empty', invalidRange ? '请调整开始日期和结束日期。' : '没有符合条件的记录。可以更换关键词、日期或来源账号。'));
    return;
  }
  const fragment = document.createDocumentFragment();
  let currentDay = '';
  let section = null;
  for (const message of rows.slice(0, visibleCount)) {
    const day = message.time.slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      section = element('section', 'day');
      section.append(element('h2', 'day-heading', day));
      fragment.append(section);
    }
    const mine = Boolean(message.account) && message.senderId === message.account;
    const article = element('article', 'message' + (mine ? ' me' : ''));
    article.append(element('div', 'avatar', mine ? '我' : Array.from(message.sender || '?')[0]));
    const content = element('div');
    const meta = element('div', 'message-meta');
    const time = element('time', '', message.time.slice(11));
    time.dateTime = message.time.replace(' ', 'T') + '+08:00';
    meta.append(element('span', 'sender', message.sender || '未知发送者'), time, element('span', '', '来源 ' + message.account));
    content.append(meta);
    if (message.text || !message.images.length) content.append(element('div', 'bubble', message.text || '（无文字内容）'));
    if (message.images.length) {
      const images = element('div', 'image-row');
      for (const image of message.images) {
        if (!image.id) { images.append(element('span', 'missing', '图片暂缺')); continue; }
        const button = element('button', '', '查看图片');
        button.type = 'button';
        button.addEventListener('click', () => showImage(image, button));
        images.append(button);
      }
      content.append(images);
    }
    article.append(content);
    section.append(article);
  }
  $('messages').append(fragment);
}

async function showImage(image, button) {
  if (!key || !UUID_PATTERN.test(image.id)) return;
  clearPicture();
  const attempt = imageAttempt;
  const generation = epoch;
  const currentKey = key;
  const currentHeader = envelope;
  const controller = new AbortController();
  imageRequest = controller;
  button.disabled = true;
  text('pictureStatus', '正在读取并解密图片…');
  if (!$('pictureDialog').open) $('pictureDialog').showModal();
  const valid = () => isCurrent(generation) && attempt === imageAttempt && !controller.signal.aborted;
  try {
    const encrypted = await readFile('./media/' + image.id + '.bin', MAX_MEDIA_BYTES, controller);
    if (!valid()) return;
    if (!encrypted) throw new Error('这张图片的加密文件暂未找到，文字记录不受影响。');
    const bytes = await open(encrypted, currentKey, currentHeader, 'media:' + image.id);
    if (!valid()) return;
    const mime = imageMime(bytes);
    if (!mime) throw new Error('图片格式暂不支持，或图片文件已损坏。');
    pictureUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
    $('picture').src = pictureUrl;
    $('picture').hidden = false;
    text('pictureStatus', '');
  } catch (error) {
    if (!valid() || error.name === 'AbortError') return;
    showError('pictureStatus', error.name === 'OperationError' ? new Error('这张图片未能通过完整性校验，无法打开。') : error);
  } finally {
    if (isCurrent(generation)) button.disabled = false;
    if (imageRequest === controller) imageRequest = null;
  }
}

$('picture').addEventListener('error', () => {
  if (!key || !pictureUrl) return;
  clearPicture();
  text('pictureStatus', '浏览器无法显示这张图片，文件可能已损坏。');
});
$('pictureClose').addEventListener('click', () => { clearPicture(); $('pictureDialog').close(); });
$('pictureDialog').addEventListener('cancel', clearPicture);
$('pictureDialog').addEventListener('close', clearPicture);
$('lock').addEventListener('click', () => lock());
$('retry').addEventListener('click', () => { lock(); loadGate(); });
$('more').addEventListener('click', () => { visibleCount += PAGE_SIZE; render(); });
for (const id of ['search', 'from', 'to', 'accountFilter']) {
  $(id).addEventListener('input', () => { selectedDay = ''; visibleCount = PAGE_SIZE; render(); });
}
$('clear').addEventListener('click', () => {
  for (const id of ['search', 'from', 'to', 'accountFilter']) $(id).value = '';
  selectedDay = '';
  visibleCount = PAGE_SIZE;
  render();
});
for (const type of ['pointerdown', 'keydown', 'touchstart', 'scroll']) {
  document.addEventListener(type, () => { lastActive = Date.now(); }, { passive: true });
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden && (key || unlocking)) lock('离开页面后，存档已自动锁定。');
});
window.addEventListener('pagehide', () => { if (key || unlocking) lock(); });
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  if (envelope) lock('存档已锁定，请重新输入密码。');
  else loadGate();
});
setInterval(() => {
  if (key && Date.now() - lastActive >= 5 * 60 * 1000) lock('闲置 5 分钟后，存档已自动锁定。');
}, 10000);

if (!globalThis.crypto?.subtle) {
  text('gateHint', '请通过 HTTPS 站点地址打开。');
  text('gateError', '当前环境不支持浏览器端安全解密。');
} else { loadGate(); }
