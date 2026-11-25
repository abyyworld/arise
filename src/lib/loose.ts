// Follow-through: loose ends in your own notes ("I'll email Eyal", "need to book the dentist"),
// found on the device with no AI, so Arise can ask later whether they got done. Each one names
// the note it came from; once answered (done, made a to-do, or not a thing) it's put away on
// every device (the `dismissed` list, as 'q:loose:<id>').

export interface Loose {
  id: string; // stable: the note's id and the words, hashed
  text: string; // what to do, tidied ("Email Eyal")
  from: string; // the note's id
  at: number; // when the note was written
}

// Words that mean "I mean to do this".
const LEAD = /\b(?:i'll|i will|i'm going to|im going to|i am going to|i need to|need to|i have to|have to|i must|must|i should|should|i've got to|gotta|i want to|i plan to|plan to|remind me to|don't forget to|dont forget to|remember to|todo:|to do:)\s+([^.!?\n;]{3,90})/gi;
// Not a plan: feelings and things that just happen.
const SKIP = /^(be |feel|go to (?:bed|sleep)|sleep|rest|relax|calm|think|stop |try harder|get better|be better|do better|keep |say |tell myself|admit|accept|know |see how|wait)/i;
const STOP = /\b(but|because|so that|if|when|although|though|and then)\b.*$/i;

const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

export function looseIn(note: { id: string; text: string; at: number }): Loose[] {
  const out: Loose[] = [];
  const seen = new Set<string>();
  for (const m of note.text.matchAll(LEAD)) {
    let what = m[1].replace(STOP, '').replace(/\s+/g, ' ').trim().replace(/[,:-]+$/, '');
    if (what.split(' ').length < 2 || SKIP.test(what)) continue;
    what = what.charAt(0).toUpperCase() + what.slice(1);
    const key = what.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: `${hash(note.id)}${hash(key)}`, text: what, from: note.id, at: note.at });
  }
  return out;
}

// Loose ends from recent notes, newest first, leaving out what's already a to-do (by its words)
// and what was put away.
export function looseEnds(notes: { id: string; text: string; at: number }[], todos: { title: string }[], dismissed: Record<string, unknown>, max = 20): Loose[] {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-zÀ-ɏ0-9']{3,}/g) || []);
  const todoWords = todos.map((t) => words(t.title));
  const covered = (l: Loose) => {
    const w = words(l.text);
    return todoWords.some((t) => {
      let same = 0;
      for (const x of w) if (t.has(x)) same++;
      return same >= Math.min(2, w.size);
    });
  };
  return notes
    .flatMap(looseIn)
    .filter((l) => dismissed[`q:loose:${l.id}`] == null && !covered(l))
    .sort((a, b) => b.at - a.at)
    .slice(0, max);
}
