// C08. Two kinds of string. Non-critical text may fall back to English. Critical safety and
// operational text is only ever shown in another language when a person has verified the
// translation in a glossary; otherwise the English stays, clearly labelled. Nothing is ever
// machine-translated at runtime.

export interface StringDef {
  en: string;
  critical?: boolean;
}

export const STRINGS: Record<string, StringDef> = {
  'app.name': { en: 'Koottu' },
  'nav.ride': { en: 'My ride' },
  'nav.why': { en: 'Why this group' },
  'nav.settings': { en: 'Language' },
  'skip.main': { en: 'Skip to main content' },
  'check.title': { en: 'Is this fare fair?' },
  'check.quote': { en: 'Fare shown in your app' },
  'check.app': { en: 'App' },
  'check.submit': { en: 'Check this fare' },
  'check.nodata': { en: 'Not enough recent fares here to compare yet.' },
  'request.title': { en: 'Find people going your way' },
  'request.pickup': { en: 'Pickup spot' },
  'request.dest': { en: 'Destination' },
  'request.party': { en: 'People travelling together' },
  'request.circle': { en: 'Who can you ride with?' },
  'request.share': { en: 'Who are you comfortable sharing with?' },
  'request.share.anyone': { en: 'Anyone in my circle' },
  'request.share.women': { en: 'Women only' },
  'request.detour': { en: 'Extra minutes you can accept' },
  'request.submit': { en: 'Find my group' },
  'request.privacy': { en: 'Your name and number stay on this phone. Others see your first name only.' },
  'pod.title': { en: 'Your group' },
  'pod.pickup': { en: 'Meet at' },
  'pod.leaves': { en: 'Leaves at' },
  'pod.share': { en: 'You pay' },
  'pod.solo': { en: 'Alone it would cost' },
  'pod.lead': { en: 'This phone books the cab' },
  'pod.quote.ask': { en: 'Open your ride apps and enter the fares you see.' },
  'pod.show': { en: 'Show this code to your group lead.', critical: true },
  'pod.meet.safe': { en: 'Meet only at the marked pickup spot. Do not get into a cab until your group is together.', critical: true },
  'pod.verify.driver': { en: 'Check the number plate before you get in.', critical: true },
  'pod.offline.valid': { en: 'This pass works without internet.', critical: true },
  'status.waiting.title': { en: 'No cab for your group yet', critical: true },
  'status.waiting.body': { en: 'Stay at the pickup spot. We will tell you when a cab is free.', critical: true },
  'status.finding': { en: 'Finding your group' },
  'status.info.title': { en: 'We need one answer before we can group you', critical: true },
  'status.riding': { en: 'You are on your way. Have a safe trip.' },
  'safety.check': { en: 'Your ride has stopped. Are you safe?', critical: true },
  'safety.yes': { en: 'I am safe', critical: true },
  'safety.no': { en: 'I need help', critical: true },
  'offline.banner': { en: 'You are offline. Your pass still works. New requests will send when you reconnect.', critical: true },
  'offline.queued': { en: 'Waiting to send' },
  'offline.synced': { en: 'Sent' },
  'split.title': { en: 'How your fare was split' },
  'split.rule': { en: 'You only join a group if you pay less than going alone.' },
  'why.proof.title': { en: 'Proof this decision was recorded' },
  'why.proof.verify': { en: 'Check the proof on this phone' },
  'why.proof.ok': { en: 'Checked. This decision is in the published record.' },
  'why.proof.bad': { en: 'This decision does not match the published record.' },
  'alt.title': { en: 'What you can do instead' },
  'action.cancel': { en: 'Leave this group' },
  'action.save': { en: 'Save answer' },
  'action.paid': { en: 'I have paid my share' },
  'error.generic': { en: 'That did not work. Check your connection and try again.' },
  'lang.fallback.note': { en: 'Shown in English: a verified translation is not available.' },
};

export type Glossary = Record<string, { text: string; verifiedBy: string }>;

export interface LanguagePack {
  code: string;
  name: string;
  dir?: 'ltr' | 'rtl';
  strings: Record<string, string>;
  glossary: Glossary;
}

export interface Translated {
  text: string;
  lang: string;
  fallback: boolean;
  criticalUnverified: boolean;
}

export function translate(key: string, pack: LanguagePack | null, vars?: Record<string, string | number>): Translated {
  const def = STRINGS[key];
  let text = def?.en ?? key;
  let lang = 'en';
  let fallback = false;
  let criticalUnverified = false;

  if (pack && pack.code !== 'en') {
    if (def?.critical) {
      const g = pack.glossary[key];
      if (g && g.verifiedBy) {
        text = g.text;
        lang = pack.code;
      } else {
        fallback = true;
        criticalUnverified = true;
      }
    } else if (pack.strings[key]) {
      text = pack.strings[key];
      lang = pack.code;
    } else {
      fallback = true;
    }
  }

  if (vars) for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
  return { text, lang, fallback, criticalUnverified };
}

export function coverage(pack: LanguagePack): {
  total: number; translated: number; critical: number; criticalVerified: number; missingCritical: string[]; missing: string[];
} {
  const keys = Object.keys(STRINGS);
  const crit = keys.filter((k) => STRINGS[k].critical);
  const missingCritical = crit.filter((k) => !pack.glossary[k]?.verifiedBy);
  const plain = keys.filter((k) => !STRINGS[k].critical);
  const missing = plain.filter((k) => !pack.strings[k]);
  return {
    total: keys.length,
    translated: plain.length - missing.length + crit.length - missingCritical.length,
    critical: crit.length,
    criticalVerified: crit.length - missingCritical.length,
    missingCritical,
    missing,
  };
}

/** Stretches every string by 40% so layouts can be tested for long translations. */
export function pseudoPack(): LanguagePack {
  const stretch = (s: string) => `[${s} ${'·'.repeat(Math.ceil(s.length * 0.4))}]`;
  const strings: Record<string, string> = {};
  const glossary: Glossary = {};
  for (const [k, d] of Object.entries(STRINGS)) {
    if (d.critical) glossary[k] = { text: stretch(d.en), verifiedBy: 'layout-test' };
    else strings[k] = stretch(d.en);
  }
  return { code: 'en-XA', name: 'Layout test (+40%)', strings, glossary };
}

export function validatePack(doc: unknown): { ok: true; pack: LanguagePack } | { ok: false; errors: string[] } {
  const d = doc as Partial<LanguagePack> | null;
  const errors: string[] = [];
  if (!d || typeof d !== 'object') return { ok: false, errors: ['Pack must be a JSON object'] };
  if (typeof d.code !== 'string' || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(d.code)) errors.push('code must be a language tag such as ta or hi');
  if (typeof d.name !== 'string' || !d.name.trim()) errors.push('name is required');
  if (d.strings !== undefined && (typeof d.strings !== 'object' || d.strings === null)) errors.push('strings must be an object');
  if (d.glossary !== undefined && (typeof d.glossary !== 'object' || d.glossary === null)) errors.push('glossary must be an object');
  if (errors.length) return { ok: false, errors };
  const strings: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.strings ?? {})) if (STRINGS[k] && typeof v === 'string' && v.length < 400) strings[k] = v;
  const glossary: Glossary = {};
  for (const [k, v] of Object.entries(d.glossary ?? {})) {
    if (STRINGS[k]?.critical && v && typeof v.text === 'string' && typeof v.verifiedBy === 'string' && v.verifiedBy.trim()) glossary[k] = { text: v.text, verifiedBy: v.verifiedBy };
  }
  return { ok: true, pack: { code: d.code!, name: d.name!, strings, glossary } };
}
