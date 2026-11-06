import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

// Pinned upstream artwork; downloading is a maintainer task, never a runtime step.
const revision = '1ffb34c752ecf5d402f04cfb4b392c77f57c54bc';
const repository = 'https://github.com/microsoft/fluentui-emoji';
const destination = fileURLToPath(new URL('../assets/stickers/', import.meta.url));
const definitions = [
  { id: 'builtin-fluent-cats', name: '猫咪心情', description: '开心、贴贴、委屈和小傲娇，九种猫咪小情绪。', items: [
    ['Grinning cat', '猫猫开心', '张嘴微笑的橘猫。适合轻松打招呼、表示开心或回应好消息。', ['猫咪', '开心', '你好', '早安']],
    ['Grinning cat with smiling eyes', '猫猫眯眼笑', '眯着眼睛笑的橘猫。适合温暖地回应、表示满意或友善赞同。', ['猫咪', '微笑', '满意', '赞同']],
    ['Smiling cat with heart-eyes', '猫猫心动', '双眼变成爱心的橘猫。适合夸可爱、喜欢某件事或熟人间表达喜爱。', ['猫咪', '喜欢', '心动', '可爱']],
    ['Cat with tears of joy', '猫猫笑哭', '笑出眼泪的橘猫。适合接好笑的话题；不用于回应真实的难过。', ['猫咪', '哈哈', '笑哭', '好笑']],
    ['Cat with wry smile', '猫猫小得意', '嘴角上扬、带一点俏皮得意的橘猫。适合熟人间轻松开玩笑，不用于严肃批评。', ['猫咪', '得意', '俏皮', '嘿嘿']],
    ['Kissing cat', '猫猫亲亲', '闭着眼睛噘嘴亲亲的橘猫。适合关系亲近时表达感谢或温柔告别，避免对陌生人过分亲昵。', ['猫咪', '亲亲', '贴贴', '谢谢']],
    ['Weary cat', '猫猫震惊', '双爪贴脸、张大嘴的橘猫。适合意外、惊讶或轻松夸张的反应。', ['猫咪', '惊讶', '震惊', '哇']],
    ['Crying cat', '猫猫委屈', '眼角流泪的橘猫。适合表达小委屈、遗憾或轻声共情。', ['猫咪', '委屈', '难过', '遗憾']],
    ['Pouting cat', '猫猫小生气', '皱着眉头的橘猫。适合熟人间撒娇式的小不满，不用于攻击或嘲讽别人。', ['猫咪', '小生气', '哼', '不满']]
  ] },
  { id: 'builtin-fluent-animals', name: '软萌动物', description: '兔兔、熊猫、仓鼠和企鹅，十位软萌小伙伴。', items: [
    ['Rabbit face', '软萌兔兔', '白兔的可爱正脸与长耳朵。适合聊兔子、卖萌或温柔打招呼；图片本身没有文字。', ['动物', '兔兔', '可爱', '你好']],
    ['Panda', '软萌熊猫', '圆脸黑白熊猫。适合聊熊猫、表示可爱或轻松陪伴。', ['动物', '熊猫', '可爱', '陪伴']],
    ['Hamster', '小小仓鼠', '鼓着脸颊的小仓鼠。适合聊仓鼠、吃东西或软萌的小反应。', ['动物', '仓鼠', '吃饭', '可爱']],
    ['Bear', '小熊陪你', '圆耳朵棕色小熊的正脸。适合温暖问候、轻松陪伴或聊小熊。', ['动物', '小熊', '陪伴', '问候']],
    ['Polar bear', '白熊团子', '白色北极熊的圆脸。适合聊冬天、北极熊或软萌话题。', ['动物', '白熊', '冬天', '软萌']],
    ['Koala', '呆萌考拉', '圆耳朵、黑鼻子的灰色考拉。适合聊考拉或慵懒可爱的话题，不代表图片在睡觉。', ['动物', '考拉', '呆萌', '放松']],
    ['Dog face', '乖乖小狗', '吐着舌头的可爱小狗正脸。适合友好问候、聊狗狗或轻松应和。', ['动物', '小狗', '狗狗', '友好']],
    ['Fox', '机灵狐狸', '尖耳朵、橘色脸颊的小狐狸。适合聊狐狸或俏皮机灵的话题。', ['动物', '狐狸', '机灵', '俏皮']],
    ['Frog', '呆呆青蛙', '大眼睛的绿色青蛙正脸。适合聊青蛙或熟人间轻松卖萌。', ['动物', '青蛙', '呆萌', '可爱']],
    ['Penguin', '小企鹅报到', '黑白小企鹅，带橘色嘴巴和脚。适合打招呼、报到或聊企鹅和冬天。', ['动物', '企鹅', '报到', '你好']]
  ] },
  { id: 'builtin-fluent-moods', name: '元气心情', description: '抱抱、庆祝、晚安和星星眼，十一种日常回应。', items: [
    ['Smiling face with hearts', '暖暖喜欢', '周围飘着爱心的笑脸。适合温暖回应、喜欢与感谢，不替用户表达承诺。', ['心情', '喜欢', '温暖', '谢谢']],
    ['Hugging face', '给你抱抱', '张开双手的温暖笑脸。适合安慰、鼓励或表达欢迎。', ['心情', '抱抱', '安慰', '欢迎']],
    ['Partying face', '一起庆祝', '戴派对帽、吹派对哨的笑脸。适合祝贺、生日或庆祝好消息。', ['心情', '庆祝', '恭喜', '生日']],
    ['Smiling face with heart-eyes', '满眼喜欢', '双眼是爱心的笑脸。适合赞美作品、美食或可爱的东西。', ['心情', '喜欢', '心动', '好看']],
    ['Face blowing a kiss', '送你爱心', '眨眼并送出一颗爱心的亲吻表情。适合亲近关系中的感谢或告别，避免生硬套用亲昵称呼。', ['心情', '亲亲', '爱心', '感谢']],
    ['Face holding back tears', '感动得想哭', '含着泪但微笑的表情。适合感动、被温暖到或轻声感谢。', ['心情', '感动', '谢谢', '含泪']],
    ['Pleading face', '可怜巴巴', '大眼睛水汪汪的表情。适合轻声请求、撒娇或小委屈，不用于施压。', ['心情', '拜托', '委屈', '撒娇']],
    ['Sleeping face', '困困晚安', '闭眼睡觉、上方有睡眠符号的表情。适合说困了、休息或晚安。', ['心情', '晚安', '睡觉', '困了']],
    ['Star-struck', '星星眼', '眼睛变成星星的兴奋笑脸。适合夸赞、惊喜或表达佩服。', ['心情', '厉害', '佩服', '惊喜']],
    ['Face with tears of joy', '笑到流泪', '笑出眼泪的表情。适合接梗和好笑的话题，不用于嘲笑别人的遭遇。', ['心情', '哈哈', '笑哭', '好笑']],
    ['Thinking face', '让我想想', '手托下巴、正在思考的表情。适合轻松表达思考或疑惑。', ['心情', '思考', '疑惑', '想想']]
  ] }
];

function download(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--fail', '--silent', '--show-error', '--location', '--connect-timeout', '10', '--max-time', '30', '--retry', '2', url], { windowsHide: true });
    const chunks = []; let bytes = 0, failure = '';
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 10 * 1024 * 1024) { child.kill(); reject(new Error('Download exceeds 10 MiB')); } else chunks.push(chunk); });
    child.stderr.on('data', chunk => { failure = (failure + chunk).slice(-2000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`Download failed: ${url} (${code}) ${failure}`)));
  });
}

const packs = [], files = [];
for (const definition of definitions) {
  const items = [];
  for (let at = 0; at < definition.items.length; at += 4) {
    const batch = await Promise.all(definition.items.slice(at, at + 4).map(async ([upstreamName, name, description, tags]) => {
      const basename = upstreamName.toLowerCase().replaceAll(' ', '_') + '_3d.png';
      const upstreamPath = `assets/${upstreamName}/3D/${basename}`;
      const sourceUrl = `${repository}/blob/${revision}/${upstreamPath.split('/').map(encodeURIComponent).join('/')}`;
      const downloadUrl = `https://raw.githubusercontent.com/microsoft/fluentui-emoji/${revision}/${upstreamPath.split('/').map(encodeURIComponent).join('/')}`;
      const content = await download(downloadUrl);
      if (content.length < 33 || content.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error(`Invalid PNG: ${downloadUrl}`);
      const file = `${definition.id}/${basename}`;
      return { content, item: { id: createHash('sha256').update(content).digest('hex'), name, description, tags, file, sourceUrl, downloadUrl,
        bytes: content.length, width: content.readUInt32BE(16), height: content.readUInt32BE(20), mediaType: 'image/png', extension: 'png' } };
    }));
    for (const { content, item } of batch) { items.push(item); files.push({ file: item.file, content }); }
  }
  packs.push({ id: definition.id, name: definition.name, description: definition.description, items });
  console.log(`Downloaded ${definition.name}: ${items.length} PNG images`);
}
const license = await download(`https://raw.githubusercontent.com/microsoft/fluentui-emoji/${revision}/LICENSE`);
if (!license.toString('utf8').includes('Copyright (c) Microsoft Corporation.')) throw new Error('Unexpected upstream license');
for (const { file, content } of [...files, { file: 'LICENSE-Microsoft.txt', content: license }]) {
  const target = path.join(destination, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
}
fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({ version: 1, source: { name: 'Microsoft Fluent Emoji', author: 'Microsoft Corporation', url: repository,
  revision, license: 'MIT', licenseUrl: `${repository}/blob/${revision}/LICENSE`, licenseFile: 'LICENSE-Microsoft.txt' }, packs }, null, 2) + '\n');
console.log(`Saved ${files.length} original images, provenance and license to assets/stickers`);
