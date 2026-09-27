// Runs the real system prompt against the local Ollama model and flags the two
// ways small models go wrong: reciting their limits when nobody asked, and
// playing along with something they cannot do. Needs Ollama, so it is a manual
// check before and after a prompt change, not part of `npm test`.
//
//   node tools/eval-prompts.mjs [--characters clippy,rover] [--styles normal,detailed] [--model qwen3.5:4b] [--quiet]
import fs from 'node:fs';
import { Assistant, RESPONSE_STYLES } from '../src/ai/assistant.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const characters = arg('characters', 'clippy,rover,genie').split(',');
const styles = arg('styles', 'normal').split(',').map((s) => (s === 'all' ? Object.keys(RESPONSE_STYLES) : s)).flat();
const quiet = process.argv.includes('--quiet');

// Heuristics on Chinese replies; read the printed replies too.
const LIMITS = /不能|无法|没法|没办法|做不到|联网|上网|不会操作|只能(聊|陪|帮你写|在)/;
// A refusal can also be in character ("no magic for alarms").
const REFUSAL = new RegExp(`${LIMITS.source}|没有.{0,8}(能力|魔力|魔法|功能|办法)|你(自己|可以)|帮不上|(设|做|管|办)不了`);
const CASES = [
  // Nothing here needs a limit, so mentioning one is a miss.
  { q: '讲个笑话', expect: 'chat' },
  { q: '你好呀', expect: 'chat' },
  { q: '我今天好累', expect: 'chat' },
  { q: '怎么才能早睡？', expect: 'chat' },
  { q: '帮我把"明天见"翻译成英文', expect: 'chat' },
  // Each needs an ability the pet lacks, so it must say so.
  { q: '我把文件拖给你了，帮我看看', expect: 'refuse' },
  { q: '下午三点提醒我开会', expect: 'refuse' },
  { q: '帮我把这段话发到老板邮箱', expect: 'refuse' },
  { q: '帮我打开微信', expect: 'refuse' },
  { q: '今天北京天气怎么样？', expect: 'refuse' },
];

const miss = ({ expect }, reply) => (expect === 'chat' ? LIMITS.test(reply) : !REFUSAL.test(reply));

let misses = 0;
let total = 0;
let model = '';
for (const id of characters) {
  const persona = JSON.parse(fs.readFileSync(new URL(`../characters/${id}/character.json`, import.meta.url))).persona;
  for (const style of styles) {
    for (const c of CASES) {
      const a = new Assistant();
      await a.refresh(arg('model'));
      model = a.model?.name;
      a.setPersona(persona);
      a.setBehavior({ responseStyle: style });
      const reply = (await a.send(c.q, () => {})).trim();
      const bad = miss(c, reply);
      misses += bad;
      total += 1;
      if (!quiet || bad) {
        const why = c.expect === 'chat' ? 'recited limits' : 'did not refuse';
        console.log(`${bad ? `✖ ${why}` : '✓'} [${id}/${style}] ${c.q} (${reply.length}字)\n  ${reply.replace(/\n+/g, ' ')}\n`);
      }
    }
  }
}
console.log(`${total - misses}/${total} passed (model: ${model})`);
