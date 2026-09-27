// What the pet says when it can't chat (Ollama off in Settings, not running,
// or with no local model): a little something each time the balloon opens,
// never the same line twice in a row. Not about Ollama (Settings says that),
// just company. `{name}` is the character's name.

// Poked again and again: the pet reacts to the streak.
const STREAK = [
  { from: 8, gesture: 'acknowledge', lines: [
    'Okay, okay, you win. I surrender. 🏳️',
    "That's {n} pokes. Are you trying to set a record?",
    "I've decided this is a massage. Thank you.",
  ] },
  { from: 5, gesture: 'confused', lines: [
    'Whoa… the room is spinning…',
    'So many pokes! Are you keeping score?',
    'I see stars. And also three of you.',
  ] },
  { from: 3, gesture: 'getAttention', lines: [
    'Hey! That tickles.',
    "Poke me once more and I'm telling.",
    'Yes, yes, I\'m still here!',
    'Is this Morse code? Because I think you just said "snack".',
  ] },
];

// By the hour (local time): [first hour, last hour + 1, lines].
const HOURS = [
  [5, 11, [
    "Good morning! Coffee first, world domination later.",
    'Morning! Fresh day, nothing broken yet.',
    'Rise and shine! Well, rise, anyway.',
  ]],
  [11, 14, [
    "Is it lunch yet? Asking for a friend. The friend is me.",
    'Lunchtime thought: food tastes better away from the keyboard.',
  ]],
  [14, 18, [
    'Afternoon slump? Stand up, stretch, come back a new person.',
    'The 3 p.m. brain fog is real. A glass of water helps more than you\'d think.',
  ]],
  [18, 23, [
    'Evening already? Nice work today.',
    'Wrapping up soon? Tomorrow-you will appreciate a short to-do list.',
  ]],
  [23, 29, [ // past midnight wraps to 5
    "It's late… even the pixels are yawning.",
    "Burning the midnight oil? I'll keep you company.",
    'Sleep is a feature, not a bug.',
  ]],
];

const FUN = [
  // jokes
  'Why do programmers mix up Halloween and Christmas? Because Oct 31 = Dec 25.',
  'I tried to write a joke about UDP. Not sure if you got it.',
  "Why don't skeletons fight each other? They don't have the guts.",
  'I told my computer I needed a break. It said: "No problem, I\'ll go to sleep."',
  "Parallel lines have so much in common. It's a shame they'll never meet.",
  // riddles
  'Riddle: what has keys but opens no locks? …Your keyboard. Too easy?',
  'Riddle: the more you take, the more you leave behind. What are they? (Footsteps!)',
  'Riddle: what gets wetter the more it dries? A towel, of course.',
  // little games
  "I'm thinking of a number from 1 to 10… Got it? It was 7. It's always 7.",
  'Rock, paper, scissors! I pick… paper. Obviously.',
  'Staring contest. Starting now. …You blinked. I win.',
  'Quick, name three things you can see right now. Okay, that was a mindfulness trick. Gotcha.',
  // fortunes
  "Today's fortune: a bug you've been hunting will turn out to be a typo.",
  "Today's fortune: someone will say thank you. Might be me. Thank you!",
  "Today's fortune: your next idea is a good one. Write it down.",
  "Today's fortune: lucky number 42, lucky color, whatever your wallpaper is.",
  // fun facts
  'Fun fact: the first computer "bug" was a real moth, taped into a logbook in 1947.',
  'Fun fact: honey never spoils. Archaeologists found edible honey in Egyptian tombs.',
  'Fun fact: octopuses have three hearts. I have zero, but a lot of spirit.',
  'Fun fact: a day on Venus is longer than its year.',
  // about itself
  'I live on your desktop. The rent is very reasonable.',
  "{name}, at your service! Mostly decorative service, but still.",
  'Sometimes I just stand here and admire your wallpaper.',
  "I'd make you a coffee, but these hands are strictly decorative.",
  'Drag me somewhere with a better view. I trust your taste.',
  // nudges
  'Had some water lately? Go on, I\'ll wait.',
  'Roll your shoulders back. There, better.',
  'Look at something far away for 20 seconds. Your eyes will thank you.',
  'Right-click me for a focus timer. I make a great coach.',
  "You're doing better than you think.",
  'Small steps still count as steps.',
  'Close a few tabs. You know which ones.',
  'Breathe in… and out. That one was free.',
];

// The same in Chinese, for a system set to it (simplified or traditional
// readers alike get simplified).
const ZH = {
  streak: [
    ['好好好，你赢了，我投降。🏳️', '已经戳了 {n} 下了，你是在冲纪录吗？', '我决定把这当成按摩了，谢谢。'],
    ['哇……天旋地转……', '戳这么多下！你在计数吗？', '我眼冒金星了，还看见了三个你。'],
    ['哎！好痒。', '再戳一下我就要告状了。', '在呢在呢，我还在！', '这是摩斯电码吗？我怎么读出来是“零食”。'],
  ],
  hours: [
    ['早上好！先喝咖啡，再征服世界。', '早！新的一天，还什么都没搞砸。', '起床啦！起来就算赢。'],
    ['到饭点了吗？帮朋友问的，朋友就是我。', '午饭小建议：离开键盘吃，饭会更香。'],
    ['下午犯困？站起来伸个懒腰，回来就是新的你。', '三点钟的脑雾是真的。喝杯水，比你想的管用。'],
    ['已经晚上了？今天辛苦啦。', '快收工了吗？给明天的自己留个短短的待办清单吧。'],
    ['好晚了……连像素都在打哈欠。', '熬夜呢？我陪着你。', '睡觉是功能，不是 bug。'],
  ],
  fun: [
    '程序员为什么分不清万圣节和圣诞节？因为 Oct 31 = Dec 25。',
    '我想讲个 UDP 的笑话，但不确定你收到了没有。',
    '为什么骷髅从不打架？因为它们没有胆。',
    '我跟电脑说我需要休息，它说：“没问题，我去睡了。”',
    '平行线有那么多共同点，可惜永远不会相遇。',
    '谜语：什么东西有很多键却打不开一把锁？……你的键盘。太简单了？',
    '谜语：什么东西越擦越湿？毛巾呀。',
    '谜语：什么东西你越拿，留下的越多？脚印！',
    '我想好了一个 1 到 10 的数字……是 7。永远是 7。',
    '石头剪刀布！我出……布。这还用问。',
    '瞪眼比赛，现在开始。……你眨眼了，我赢了。',
    '快，说出你现在能看到的三样东西。好了，这是个正念小把戏，被我骗到了吧。',
    '今日运势：你找了半天的 bug，其实是个错别字。',
    '今日运势：会有人对你说谢谢。可能就是我。谢谢你！',
    '今日运势：你的下一个点子是个好点子，记下来。',
    '今日运势：幸运数字 42，幸运色是你的桌面壁纸。',
    '冷知识：第一个计算机“bug”是只真的飞蛾，1947 年被贴进了工作日志。',
    '冷知识：蜂蜜永远不会坏，考古学家在埃及古墓里找到过还能吃的蜂蜜。',
    '冷知识：章鱼有三颗心脏。我一颗都没有，但干劲十足。',
    '冷知识：金星上的一天比它的一年还长。',
    '我住在你的桌面上，房租非常划算。',
    '{name}为你效劳！虽然主要是装饰性效劳。',
    '有时候我就站在这儿，欣赏你的壁纸。',
    '我很想给你泡杯咖啡，可惜这双手纯属装饰。',
    '把我拖到风景好一点的地方吧，我相信你的品味。',
    '最近喝水了吗？去吧，我等你。',
    '肩膀往后转一转。嗯，好多了。',
    '看看远处 20 秒，眼睛会感谢你的。',
    '右键点我可以开番茄钟，我是个不错的教练。',
    '你做得比你以为的要好。',
    '小步子也是步子。',
    '关掉几个标签页吧，你知道是哪几个。',
    '吸气……呼气。这一口免费。',
  ],
};

const LINES = {
  en: { streak: STREAK.map((t) => t.lines), hours: HOURS.map((h) => h[2]), fun: FUN },
  zh: ZH,
};

const STREAK_GAP = 4000; // ms between clicks that still counts as one streak
const HOUR_CHANCE = 0.25;

// Keeps what makes the next line interesting: the last one said and how many
// times in a row the pet has been poked.
export class Pokes {
  // `lang`: the system's language (navigator.language), e.g. "zh-CN".
  constructor({ lang = 'en', now = Date.now, random = Math.random, hour = () => new Date().getHours() } = {}) {
    const lines = LINES[String(lang).toLowerCase().split('-')[0]] || LINES.en;
    Object.assign(this, { lines, now, random, hour, last: '', streak: 0, at: 0 });
  }

  // A line (and a gesture to play with it, if any) for a poke.
  next(name = 'I') {
    const t = this.now();
    this.streak = t - this.at < STREAK_GAP ? this.streak + 1 : 1;
    this.at = t;
    const i = STREAK.findIndex((s) => this.streak >= s.from);
    const tier = STREAK[i];
    let pool = this.lines.fun;
    if (tier) pool = this.lines.streak[i];
    else if (this.random() < HOUR_CHANCE) {
      const h = this.hour();
      pool = this.lines.hours[HOURS.findIndex(([from, to]) => (h >= from && h < to) || (h + 24 >= from && h + 24 < to))];
    }
    const fill = (line) => line.replaceAll('{name}', name).replaceAll('{n}', this.streak);
    const fresh = pool.map(fill).filter((l) => l !== this.last);
    this.last = fresh[Math.floor(this.random() * fresh.length)];
    return { text: this.last, gesture: tier?.gesture };
  }
}

// Why the pet can't chat, or null when it can.
export function offlineReason({ enabled, available, model }) {
  if (!enabled) return 'off';
  if (!available) return 'unavailable';
  return model ? null : 'noModel';
}
