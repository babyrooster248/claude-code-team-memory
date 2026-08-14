// Did the merge move a tag from one fact to another?
//
// Every entry carries an id — `[k6]` — and the `knowledge-state` block keys contributor sets by that
// id. The id is therefore not decoration: it is the only thing tying "three people have hit this" to
// *which thing they hit*. It has to name the same fact for the life of the repository.
//
// A real run broke that. `[k6]` named "nothing checks item-id uniqueness" on the base; the merge
// returned a file where `[k6]` named a brand-new fact about external key spaces and the uniqueness
// entry had become `[k7]`. Nothing detected it. Both entries happened to have the same single
// contributor, so no count ended up on the wrong sentence — that was luck, not a mechanism. Reuse a
// tag that carried three contributors and the new, unverified fact inherits `(3 people)`: the file
// would claim verification that never happened, which is the one thing this whole design exists to
// prevent.
//
// The gate already refuses to auto-apply such a change, because it compares by tag and sees the text
// under `[k6]` change. So a person is looking. This exists to tell that person *what* they are
// looking at, because the diff on its own reads as an ordinary edit.
//
// Detection is deliberately not "did the text change" — the merge is allowed, and expected, to
// sharpen wording in place. What is not allowed is a sentence reappearing under a different id. So:
// for each id on the base, find where its sentence went. If it went somewhere else, say so.

const TAGGED = /^-\s+(.*?)\s*\[(k\d+)\]\s*$/;
const MARKER = /^\(\s*(?:unconfirmed\s*,\s*)?\d+\s*(?:person|people)\s*\)/i;

// Tag -> the sentence it names, markers and whitespace normalised away so a promotion from
// "(1 person)" to "(2 people)" is not mistaken for a different sentence.
function tagMap(text) {
  const m = new Map();
  let inComment = false;
  for (const raw of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (inComment) { if (line.includes('-->')) inComment = false; continue; }
    if (line.startsWith('<!--')) { if (!line.includes('-->')) inComment = true; continue; }
    const hit = line.match(TAGGED);
    if (hit) m.set(hit[2], hit[1].replace(MARKER, '').replace(/\s+/g, ' ').trim());
  }
  return m;
}

const words = s => new Set(String(s).toLowerCase().match(/[a-z0-9_.]+/g) || []);

// Jaccard overlap. Crude on purpose: the question is only "is this recognisably the same sentence",
// and a sharpened entry keeps most of its words while a different fact shares almost none.
function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / (A.size + B.size - hit);
}

// Returns [{ from, to, similarity }] — the base's tag, the tag its sentence now wears, and how
// confident that identification is. Empty when every tag still names its own fact.
function findReassigned(before, after, { threshold = 0.5 } = {}) {
  const a = tagMap(before);
  const b = tagMap(after);
  const moved = [];

  for (const [tag, sentence] of a) {
    let best = null;
    for (const [otherTag, otherSentence] of b) {
      const s = similarity(sentence, otherSentence);
      if (!best || s > best.s) best = { tag: otherTag, s };
    }
    if (!best || best.s < threshold) continue;      // the fact was dropped, or rewritten past recognition
    if (best.tag === tag) continue;                 // still itself, sharpened or not
    // It also has to be a better match than whatever now wears the original tag, or two entries that
    // merely resemble each other would report a swap that never happened.
    const stayed = b.has(tag) ? similarity(sentence, b.get(tag)) : 0;
    if (best.s > stayed) moved.push({ from: tag, to: best.tag, similarity: Number(best.s.toFixed(2)) });
  }
  return moved;
}

module.exports = { findReassigned, tagMap, similarity };
