/**
 * Village dialogue + quest data.
 *
 * Each NPC has a `talk` function that receives the current quest state and returns the lines to show
 * (an array of pages) plus an optional side effect once the conversation ends.
 */
export type QuestId = 'shells' | 'bard' | 'granny';
export type QuestStage = 'hidden' | 'offered' | 'active' | 'done';

export interface QuestState {
  shells: QuestStage;   // Elder: defeat 5 soldiers
  bard: QuestStage;     // Bard: bring 10 rupees for a song (lore)
  granny: QuestStage;   // Granny: cut 6 bushes in the meadow
  kills: number;
  bushes: number;
  rupeesSpent: number;
  talked: Set<string>;
}

export const newQuestState = (): QuestState => ({ shells: 'hidden', bard: 'hidden', granny: 'hidden', kills: 0, bushes: 0, rupeesSpent: 0, talked: new Set() });

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
}

const KILL_GOAL = 5, BUSH_GOAL = 6, SONG_PRICE = 10;
export const QUEST_GOALS = { KILL_GOAL, BUSH_GOAL, SONG_PRICE };

type Talker = (q: QuestState, ctx: TalkCtx) => Conversation;

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
        'If you would go further... the Crown was carried east, over the great river. Speak with the bard. He knows the old songs.',
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
    const name = 'FINCH THE BARD', color = '#8fd6ff';
    if (q.bard === 'hidden') return {
      name, color,
      pages: ['La la laaa~ Oh! A listener! I\'m Finch. I know every song sung between here and the sea.', 'Most of them are about lost things. Sad trade, memory. Come back when you\'ve earned a story of your own.'],
    };
    if (q.bard === 'offered' || q.bard === 'active') {
      if (q.bard === 'offered') q.bard = 'active';
      if (ctx.rupees >= SONG_PRICE) return {
        name, color,
        pages: [
          'The Song of the Amber Crown? For ' + SONG_PRICE + ' rupees I\'ll sing it true. ...Deal? Splendid!',
          '~ Beneath the willow where the river bends, a bridge of oak the water tends... ~',
          '~ Across it marched the Queen\'s own gold, by hands of a knight whose heart grew cold... ~',
          '~ In a hollow of stone at the world\'s east edge, the Crown still burns on a mossy ledge... ~',
          'The east cliffs, past the second bridge. That\'s where the songs say the Crown was hidden. Nobody who went there came back to correct me.',
        ],
        onEnd: (qs, c) => { if (c.spendRupees(SONG_PRICE)) { qs.bard = 'done'; qs.rupeesSpent += SONG_PRICE; } },
      };
      return { name, color, pages: ['A story worth hearing is worth ' + SONG_PRICE + ' rupees. You\'ve ' + ctx.rupees + '. Bushes in the meadow hide a coin or two, they say.'] };
    }
    return { name, color, pages: ['~ On a mossy ledge the Crown still burns... ~', 'Bring it home, Aria, and I\'ll write a new verse with your name in it.'] };
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
  shopkeeper: (_q, ctx) => ({
    name: 'BRAM',
    color: '#ffd28a',
    pages: ctx.rupees >= 20
      ? ['Welcome to Bram\'s Sundries! Fresh apples, dried fish, and one very old shield polish.', 'A hearty meal for 20 rupees? It\'ll put the roses back in your cheeks.']
      : ['Welcome to Bram\'s Sundries! ...Ah. Your purse looks as light as mine.', 'Come back with 20 rupees and I\'ll fix you a meal that heals every bruise.'],
    onEnd: (_qs, c) => { if (c.rupees >= 20 && c.spendRupees(20)) { c.heal(); c.toast('HEALED!'); } },
  }),

  // ------------------------------------------------------------------ kid
  kid: (q) => ({
    name: 'PIP',
    color: '#ffb0a0',
    pages: q.shells === 'done'
      ? ['Aria! Aria! Is it true you beat FIVE knights? Teach me the spin thing! The whoosh one!']
      : ['Hold the sword button and let go - WHOOSH! That\'s the spin attack. Everyone knows that!', 'Don\'t tell Granny I went past the gate. There\'s a red rupee under one of the bushes near the pond!'],
  }),

  // ------------------------------------------------------------------ farmer
  farmer: () => ({
    name: 'HOLLIS',
    color: '#c8f0a0',
    pages: ['Turnips, turnips, turnips. The knights don\'t eat them, at least. They don\'t eat anything anymore.', 'The river east of here used to be shallow. Since the Crown went missing it runs high and the old ford drowned. Use the bridges.'],
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
