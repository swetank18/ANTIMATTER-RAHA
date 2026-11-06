// C08. Two kinds of string. Non-critical text may fall back to English. Critical safety and
// operational text is only ever shown in another language when a person has verified the
// translation in a glossary; otherwise the English stays, clearly labelled. Nothing is ever
// machine-translated at runtime.

export interface StringDef {
  en: string;
  critical?: boolean;
}

export const STRINGS: Record<string, StringDef> = {
  'app.name': { en: 'OmniStrand' },
  'nav.pass': { en: 'My pass' },
  'nav.why': { en: 'Why this seat' },
  'nav.settings': { en: 'Language' },
  'skip.main': { en: 'Skip to main content' },
  'checkin.title': { en: 'Tell us where you need to go' },
  'checkin.dest': { en: 'Destination' },
  'checkin.party': { en: 'People travelling together' },
  'checkin.need': { en: 'Do you need step-free access?' },
  'checkin.need.none': { en: 'No' },
  'checkin.need.assist': { en: 'I need help boarding' },
  'checkin.need.wheelchair': { en: 'I use a wheelchair' },
  'checkin.need.unknown': { en: 'Not sure yet' },
  'checkin.deadline': { en: 'Do you have a connection to catch?' },
  'checkin.deadline.none': { en: 'No' },
  'checkin.deadline.flight': { en: 'Flight' },
  'checkin.deadline.rail': { en: 'Train' },
  'checkin.deadline.shift': { en: 'Work shift' },
  'checkin.deadline.medical': { en: 'Medical appointment' },
  'checkin.deadline.in': { en: 'Minutes until it leaves' },
  'checkin.submit': { en: 'Find me a seat' },
  'checkin.privacy': { en: 'Your name and phone number stay on this phone. They are never sent.' },
  'pass.title': { en: 'Your boarding pass' },
  'pass.vehicle': { en: 'Vehicle' },
  'pass.bay': { en: 'Boarding bay' },
  'pass.departs': { en: 'Departs' },
  'pass.arrives': { en: 'Arrives' },
  'pass.party': { en: 'People' },
  'pass.show': { en: 'Show this code to the driver.', critical: true },
  'pass.seat.guaranteed': { en: 'Your seat is confirmed. Do not rush the doors.', critical: true },
  'pass.wheelchair.confirmed': { en: 'A wheelchair space is reserved for you.', critical: true },
  'pass.offline.valid': { en: 'This pass works without internet.', critical: true },
  'status.waiting.title': { en: 'You are on the waiting list', critical: true },
  'status.waiting.body': { en: 'Please wait in the staging area. Do not go to the boarding bays.', critical: true },
  'status.finding': { en: 'Finding your seat' },
  'status.info.title': { en: 'We need one answer before we can book you', critical: true },
  'status.boarded': { en: 'You have boarded. Have a safe journey.' },
  'offline.banner': { en: 'You are offline. Your pass still works. New requests will send when you reconnect.', critical: true },
  'offline.queued': { en: 'Waiting to send' },
  'offline.synced': { en: 'Sent' },
  'why.title': { en: 'Why you got this outcome' },
  'why.score': { en: 'Priority score' },
  'why.rule': { en: 'Priority group' },
  'why.proof.title': { en: 'Proof this decision was recorded' },
  'why.proof.verify': { en: 'Check the proof on this phone' },
  'why.proof.ok': { en: 'Checked. This decision is in the published record.' },
  'why.proof.bad': { en: 'This decision does not match the published record.' },
  'why.refused': { en: 'Why you could not be seated yet' },
  'alt.title': { en: 'What you can do instead' },
  'action.cancel': { en: 'Cancel my request' },
  'action.save': { en: 'Save answer' },
  'action.report': { en: 'Report a problem with this route' },
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
