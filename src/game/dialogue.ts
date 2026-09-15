/**
 * Village dialogue + quest data.
 *
 * Each NPC has a `talk` function that receives the current quest state and returns the lines to show
 * (an array of pages) plus an optional side effect once the conversation ends. The village's farm is
 * part of what they have to say: the farmer talks about the field he is standing in, and the state he
 * reports is the real one (see `village.ts`), so a conversation is a window onto the simulation rather
 * than a script read over it.
 */
import { CROPS, type CropId, type FarmerAct, type VillageState } from './village';

export type QuestId = 'shells' | 'bard' | 'granny' | 'seeds';
export type QuestStage = 'hidden' | 'offered' | 'active' | 'done';

export interface QuestState {
  shells: QuestStage;   // Elder: defeat 5 soldiers
  bard: QuestStage;     // Bard: bring 10 rupees for a song (lore)
  granny: QuestStage;   // Granny: cut 6 bushes in the meadow
  seeds: QuestStage;    // Farmer + shopkeeper: put a fallow field back into rotation
  kills: number;
  bushes: number;
  rupeesSpent: number;
  talked: Set<string>;
}

export const newQuestState = (): QuestState => ({
  shells: 'hidden', bard: 'hidden', granny: 'hidden', seeds: 'hidden',
  kills: 0, bushes: 0, rupeesSpent: 0, talked: new Set(),
});

export interface Conversation {
  name: string;
  color: string;           // name-tag colour
  pages: string[];
  /** applied when the last page is dismissed */
  onEnd?: (q: QuestState, ctx: TalkCtx) => void;
}

export interface TalkCtx {
  rupees: number;
  spendRupees(n: number): boolean;
  heal(): void;
  reward(rupees: number): void;
  toast(msg: string): void;
  /** the village farm, live: what the fields look like right now */
  village: VillageState;
  /** lift the farmer's basket off him (he would have walked it to the cart) */
  takeBasket(): { n: number; crop: CropId | null; value: number } | null;
  /** buy a sack of seed for the village; a `plot` id puts that field back into rotation */
  buySeeds(crop: CropId, price: number, plot?: number): boolean;
}

const KILL_GOAL = 5, BUSH_GOAL = 6, SONG_PRICE = 10;
/** a basket off the farmer's arm: cheaper than Bram's cooking, but only when the fields have given in */
export const PRODUCE_PRICE = 12;
/** the seed sack that takes Colts Meadow back into rotation */
export const SEED_SACK_PRICE = 40;
export const QUEST_GOALS = { KILL_GOAL, BUSH_GOAL, SONG_PRICE, PRODUCE_PRICE, SEED_SACK_PRICE };

type Talker = (q: QuestState, ctx: TalkCtx) => Conversation;
/**
 * What the farmer is doing, in his own mouth. The simulation says which action he is in the middle of;
 * these are the lines he'd give you if you walked up while it was happening.
 */
const ACT_LINE: Record<FarmerAct, string> = {
  walk: 'just walking the rows. Every tile on them wants something different.',
  till: 'breaking new ground - more of it than my back agrees with.',
  sow: 'putting seed in. Turnips don\'t plant themselves, whatever the boy says.',
  water: 'watering. Dry ground is dead ground and I won\'t have either.',
  harvest: 'picking. These are past sweet for the pot and better for the pan.',
  clear: 'clearing what I left too long. A ripe thing doesn\'t wait for a tired man.',
  fetch: 'off to the cart for water and seed. That\'s the work - a loop, and you walk it.',
  rest: 'a moment\'s breath. My grandmother\'s stone is smoother than my spine.',
  idle: 'nothing wanting me this minute. It never lasts.',
};


export const NPC_TALK: Record<string, Talker> = {
  // ------------------------------------------------------------------ elder
  elder: (q) => {
    const name = 'ELDER OSWIN', color = '#d8c8ff';
    if (q.shells === 'hidden') return {
      name, color,
      pages: [
        'Ah, Aria! Up before the rooster again. Come, let an old man talk.',
        'This is Thistledown, last free village of the meadow. Beyond the south gate the Fallen Knights roam.',
        'They were the Queen\'s guard once. When the Amber Crown was stolen, its light left them... and they kept marching.',
        'Now they harass travellers on the road. Will you thin their ranks? Defeat ' + KILL_GOAL + ' of them and return to me.',
      ],
      onEnd: (qs) => { qs.shells = 'active'; },
    };
    if (q.shells === 'active') return q.kills >= KILL_GOAL ? {
      name, color,
      pages: [
        'You truly did it! ' + q.kills + ' knights sent back to rest. The road will breathe easier.',
        'Take this for your trouble - it was meant for the Queen\'s tithe, but she has no more use for coin.',
        'If you would go further... the Crown was carried east, over the great river. Speak with Marigold, the singer by the well. She knows the old songs.',
      ],
      onEnd: (qs, ctx) => { qs.shells = 'done'; ctx.reward(30); ctx.heal(); if (qs.bard === 'hidden') qs.bard = 'offered'; },
    } : {
      name, color,
      pages: ['Knights defeated: ' + q.kills + ' of ' + KILL_GOAL + '.', 'Mind their archers. Raise your shield when you see them draw, and they can do nothing to you.'],
    };
    return { name, color, pages: ['The meadow owes you, Aria. Rest by the well whenever you need. Thistledown is always your home.'] };
  },

  // ------------------------------------------------------------------ bard
  bard: (q, ctx) => {
    const name = 'MARIGOLD', color = '#ffb0c8';
    if (q.bard === 'hidden') return {
      name, color,
      pages: ['La la laaa~ Oh! A listener! I\'m Marigold. I know every song sung between here and the sea.', 'Most of them are about lost things. Sad trade, memory. Come back when you\'ve earned a story of your own.'],
    };
    if (q.bard === 'offered' || q.bard === 'active') {
      if (q.bard === 'offered') q.bard = 'active';
      if (ctx.rupees >= SONG_PRICE) return {
        name, color,
        pages: [
          'The Ballad of the Amber Crown? For ' + SONG_PRICE + ' rupees I\'ll sing it true. ...Deal? Wonderful!',
          '~ Beneath the willow where the river bends, a bridge of oak the water tends... ~',
          '~ Across it marched the Queen\'s own gold, by hands of a knight whose heart grew cold... ~',
          '~ In a hollow of stone at the world\'s east edge, the Crown still burns on a mossy ledge... ~',
          'The east cliffs, past the second bridge. That\'s where the songs say the Crown was hidden. Nobody who went there came back to correct the words.',
        ],
        onEnd: (qs, c) => { if (c.spendRupees(SONG_PRICE)) { qs.bard = 'done'; qs.rupeesSpent += SONG_PRICE; } },
      };
      return { name, color, pages: ['A story worth hearing is worth ' + SONG_PRICE + ' rupees. You\'ve ' + ctx.rupees + '. Bushes in the meadow hide a coin or two, they say.'] };
    }
    return { name, color, pages: ['~ On a mossy ledge the Crown still burns... ~', 'Bring it home, Aria, and I\'ll write a new verse with your name in it. Promise.'] };
  },

  // ------------------------------------------------------------------ granny
  granny: (q) => {
    const name = 'GRANNY MAUD', color = '#b8f0c8';
    if (q.granny === 'hidden') return {
      name, color,
      pages: [
        'Oh, my knees. Sweeping this doorstep is a full day\'s work at my age.',
        'Aria dear, the bushes past the gate have grown wild. Their thorns snag my washing on the line.',
        'Would you cut ' + BUSH_GOAL + ' of them with that fine sword of yours? I\'ll have something warm for you after.',
      ],
      onEnd: (qs) => { qs.granny = 'active'; },
    };
    if (q.granny === 'active') return q.bushes >= BUSH_GOAL ? {
      name, color,
      pages: ['Bless you, child! The line is clear and my sheets smell of sun again.', 'Here - a heart-warming soup, and a few rupees I had tucked in the flour tin.'],
      onEnd: (qs, ctx) => { qs.granny = 'done'; ctx.heal(); ctx.reward(15); },
    } : { name, color, pages: ['Bushes cleared: ' + q.bushes + ' of ' + BUSH_GOAL + '. Swing at the leafy ones, dear, not the rocks.'] };
    return { name, color, pages: ['Come in for soup any time. Mind the knights, and mind the cold - both creep up on you.'] };
  },

  // ------------------------------------------------------------------ shopkeeper
  shopkeeper: (q, ctx) => {
    const v = ctx.village;
    const locked = v ? v.plots.findIndex((p) => p.locked && !p.unlocked) : -1;
    const meal = ctx.rupees >= 20
      ? ['Welcome to Bram\'s Sundries! Fresh apples, dried fish, and one very old shield polish.', 'A hearty meal for 20 rupees? It\'ll put the roses back in your cheeks.']
      : ['Welcome to Bram\'s Sundries! ...Ah. Your purse looks as light as mine.', 'Come back with 20 rupees and I\'ll fix you a meal that heals every bruise.'];
    // the seed sack: Bram sells the village its seed, and the player pays for it. A field comes with it.
    const seeds = locked >= 0 && q.seeds !== 'done'
      ? ['You\'ve heard Hollis at it, I\'d warrant. Colts Meadow\'s been fallow since the Crown went - too much ground for one man\'s back.', SEED_SACK_PRICE + ' rupees for a sack of pumpkin seed and I\'ll write the meadow into his plan for the spring.']
      : [];
    return {
      name: 'BRAM',
      color: '#ffd28a',
      pages: [...meal, ...seeds],
      onEnd: (_qs, c) => {
        if (c.rupees >= 20 && c.spendRupees(20)) { c.heal(); c.toast('HEALED!'); }
        if (locked >= 0 && q.seeds !== 'done' && c.buySeeds('pumpkin', SEED_SACK_PRICE, locked)) _qs.seeds = 'done';
      },
    };
  },

  // ------------------------------------------------------------------ kid
  kid: (q) => ({
    name: 'PIP',
    color: '#ffb0a0',
    pages: q.shells === 'done'
      ? ['Aria! Aria! Is it true you beat FIVE knights? Teach me the spin thing! The whoosh one!']
      : ['Hold the sword button and let go - WHOOSH! That\'s the spin attack. Everyone knows that!', 'Don\'t tell Granny I went past the gate. There\'s a red rupee under one of the bushes near the pond!'],
  }),

  // ------------------------------------------------------------------ farmer
  // Hollis talks about the only thing he thinks about, and the sim is what he is thinking about: every
  // number below is read off his fields at the moment he is asked. He also sells you what is in his
  // basket, if he has picked anything and you have the coin for it.
  farmer: (q, ctx) => {
    const name = 'HOLLIS', color = '#c8f0a0';
    const v = ctx.village;
    const pages: string[] = [];
    if (!v) return { name, color, pages: ['Turnips, turnips, turnips. The knights don\'t eat them, at least. They don\'t eat anything anymore.'] };
    pages.push('Mornin\', miss - ' + ACT_LINE[v.farmer.act]);
    const ready = v.readyCount(), thirsty = v.thirstyCount(), open = v.openCount(), fallow = v.fallowCount(), wilt = v.wiltedCount();
    const field: string[] = [];
    if (ready) field.push(ready + (ready === 1 ? ' row is' : ' rows are') + ' ripe and I\'ve ' + v.farmer.basketN + ' in the basket');
    if (thirsty) field.push(thirsty + ' more thirsting; I\'ll have them watered before they sulk');
    if (open) field.push(open + ' tiles broken bare, waiting on seed');
    if (fallow) field.push(fallow + ' still gone to thistle - a man only has so many days in him');
    if (wilt) field.push(wilt + ' I left too long, and I\'ll not speak of that to you');
    // his report goes on as many pages as it needs: a man with 31 rows of thistle in front of him does
    // not say it in one breath, and the dialogue box is only so wide
    if (!field.length) pages.push('Day ' + v.day + ' on this ground, and every row of it is where it wants to be. Odd enough to make me suspicious.');
    else {
      pages.push('Day ' + v.day + ' on this ground. ' + field.slice(0, 2).join(', ') + '.');
      if (field.length > 2) pages.push(field.slice(2).join(', ') + '.');
    }
    pages.push(v.farmer.basketN > 0
      ? PRODUCE_PRICE + ' rupees for whatever\'s in the basket and you\'ll eat better than at the inn. Say the word and it\'s yours.'
      : 'Nothing come up yet to sell you. A field doesn\'t hurry because a traveller\'s hungry - you know that better than most.');
    const locked = v.plots.findIndex((p) => p.locked && !p.unlocked);
    if (locked >= 0 && q.seeds === 'hidden') {
      pages.push('Colts Meadow west of the lane\'s gone to thistle. Forty rupees of pumpkin seed off Bram and we\'d have it in rows before the month\'s out. ...I\'m telling you, not asking you to lend me mine.');
    } else if (locked >= 0) {
      pages.push('Bram\'s got the seed if you\'ve the rupees. I\'d not dally on it - ground\'s only good while it\'s warm.');
    } else if (q.seeds === 'done') {
      pages.push('That pumpkin seed\'s in the ground and coming faster than I expected. A pumpkin on a sprawl, aye - it works, and it\'ll keep all winter.');
    }
    if (!q.talked.has('farmer')) pages.push('The river east of here used to be shallow. Since the Crown went missing it runs high and the old ford drowned. Use the bridges, and use my rows if you\'re tired - nothing in them will bite you.');
    return {
      name, color, pages,
      onEnd: (qs, c) => {
        qs.seeds = qs.seeds === 'hidden' ? 'offered' : qs.seeds;
        const vv = c.village;
        if (vv && vv.farmer.basketN > 0 && c.rupees >= PRODUCE_PRICE && c.spendRupees(PRODUCE_PRICE)) {
          const got = c.takeBasket();
          if (got) {
            c.heal();
            c.toast('FARMER\'S BASKET: ' + got.n + ' ' + (got.crop ? CROPS[got.crop].plural : 'CROPS'));
          }
        }
      },
    };
  },

  innkeeper: () => ({
    name: 'ROSAMUND', color: '#f0c890',
    pages: ['Welcome to the Thistle & Crown! Empty rooms, full kettle. Sit anywhere.', 'Travellers used to come up the east road from the great bridge. Now only the knights walk it. Mind yourself out there, dear.'],
  }),
  smith: () => ({
    name: 'GARRICK THE SMITH', color: '#c8c8d8',
    pages: ['Hmph. That blade of yours could take an edge. Come back when you\'ve dulled it on a few of those tin soldiers.', 'The knights\' armour is old Royal steel. Strike when they lift their arm - the plates gap under the shoulder.'],
  }),
  goodwife: (_q, ctx) => {
    const v = ctx.village;
    const pages = ['Turnips and cabbages, cabbages and turnips. Hollis won\'t grow anything else!'];
    if (v) {
      if (v.plots.some((p) => p.locked && p.unlocked)) pages.push('Now pumpkins. The man\'s taken over the whole meadow and nobody thought to ask me.');
      else if (v.readyCount() > 0) pages.push(v.readyCount() + ' rows ripe and a look on him like a crowned king. Buy some - he\'ll stand there telling you about it all day.');
      else if (v.thirstyCount() > 0) pages.push('He\'s watering again. You\'d think rain was a rumour he\'d heard once, as a boy.');
    }
    pages.push('My boy keeps sneaking down to the orchard. If you see him, tell him supper\'s on.');
    return { name: 'HILDA', color: '#f0b0d0', pages };
  },
  boy: () => ({
    name: 'WILL', color: '#a0d0f0',
    pages: ['Psst! The smith has a real forge! He let me hold the hammer once. Just once.', 'Don\'t tell Mum, but there\'s a knight who stands by the pond south of the gate every night. Just... standing.'],
  }),

  // ------------------------------------------------------------------ outposts
  woodcutter: () => ({
    name: 'BRAM THE WOODCUTTER', color: '#f0b090',
    pages: ['Willowmere\'s quiet, if you keep off the trail. The knights march it in twos.', 'North bridge is past the big oaks. Beyond the river the land climbs - the Amber Highland. Their archers hold every terrace up there.'],
  }),
  miller: () => ({
    name: 'ODA THE MILLER', color: '#f0e8d0',
    pages: ['Welcome to Millbrook, such as it is. Three houses and a wheel that hasn\'t turned since the brook rose.', 'South bridge takes you over to the Drowned Field. Don\'t. Whatever the Queen\'s army lost there, it\'s still standing guard.'],
  }),
  shepherd: () => ({
    name: 'PIP THE SHEPHERD', color: '#c8e0ff',
    pages: ['Lost the whole flock to the knights. They don\'t even eat them. They just... march them off.', 'If you ever cross the great river, there\'s a camp on the moor. Blue tents. That\'s where their captain sits.'],
  }),
  fisher: () => ({
    name: 'NELL THE FISHER', color: '#a0e0e8',
    pages: ['Mirror Lake. Flat as a plate, deep as a well. Nothing bites anymore.', 'The old hermit up the orchard hill says the lake used to glow amber at night. Before the Crown was taken. Old men say all sorts.'],
  }),
  hermit: () => ({
    name: 'THE HERMIT', color: '#d8d0b0',
    pages: ['Hm? Apples. Take one. Take two. The trees still give, even if no one comes.', 'You have the look of someone going east. There is a hollow at the very edge of the moor, ringed with old pillars. What burns there should be carried home, not worn.'],
  }),
  squire: () => ({
    name: 'TOBBIN THE SQUIRE', color: '#e0c8c8',
    pages: ['I was squire to Sir Aldous. Then the Crown went, and his eyes went grey, and he walked into the river without a word.', 'They came out the other side, all of them. That\'s the great bridge. I keep it. Someone should.'],
  }),

  // ------------------------------------------------------------------ dog
  dog: () => ({ name: 'BOWWOW', color: '#f0e0b0', pages: ['Woof! Woof woof! ...(He sniffs your boots and wags his tail furiously.)'] }),
};
