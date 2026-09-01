/* Exercises the sentence splitter outside Chrome by evaluating content.js
   against a minimal DOM stub. */
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/content.js", import.meta.url), "utf8");

let api = null;
const sandbox = {
  console,
  Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
  WeakMap, Date, Math, RegExp, Set, Map, JSON, String, Number, Array, Object,
  window: { addEventListener() {}, getSelection: () => null, innerHeight: 800, scrollBy() {} },
  document: { title: "", getElementById: () => null, createElement: () => ({ setAttribute() {} }) },
  chrome: { runtime: { onMessage: { addListener() {} } } },
  __VOX_TEST_HOOK__: (exported) => { api = exported; },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

if (!api) { console.error("test hook never fired"); process.exit(1); }

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`); }
}

const texts = (input) => api.buildChunks(input).map((c) => c.text);

check("plain sentences",
  texts("The cat sat. The dog barked. Everyone left."),
  ["The cat sat.", "The dog barked.", "Everyone left."]);

check("honorifics stay attached",
  texts("Dr. Smith met Mrs. Jones at 5 p.m. They talked."),
  ["Dr. Smith met Mrs. Jones at 5 p.m. They talked."]);

check("decimals are not breaks",
  texts("Pi is 3.14159 and e is 2.718. That is all."),
  ["Pi is 3.14159 and e is 2.718.", "That is all."]);

check("initials stay attached",
  texts("J. R. R. Tolkien wrote it. Later."),
  ["J. R. R. Tolkien wrote it.", "Later."]);

check("questions and exclamations split",
  texts("Really? Yes! Absolutely."),
  ["Really?", "Yes!", "Absolutely."]);

check("list markers join their item",
  texts("The list begins here. 1. Another full sentence follows."),
  ["The list begins here.", "1. Another full sentence follows."]);

check("weekday abbreviations do not eat verbs",
  texts("The cat sat. The dog stood. Sat. 12 June was cold."),
  ["The cat sat.", "The dog stood.", "Sat. 12 June was cold."]);

check("dotted initialisms hold together",
  texts("The U.S. Senate met at 4 p.m. Monday to vote."),
  ["The U.S. Senate met at 4 p.m. Monday to vote."]);

check("sentence-final abbreviation still ends the text",
  texts("They shipped it to the U.S."),
  ["They shipped it to the U.S."]);

check("emails are not split",
  texts("Mail a.b@example.com today. Then wait."),
  ["Mail a.b@example.com today.", "Then wait."]);

check("etc. mid-sentence",
  texts("We sell apples, pears, etc. at the market on weekends."),
  ["We sell apples, pears, etc. at the market on weekends."]);

check("closing quotes ride along",
  texts('She said "go home." Then she left the room quietly.'),
  ['She said "go home."', "Then she left the room quietly."]);

check("newlines split paragraphs",
  texts("A heading here\nAnd the paragraph body follows on the next line."),
  ["A heading here", "And the paragraph body follows on the next line."]);

check("urls survive",
  texts("Visit https://example.com/a.b.c for details. Thanks very much."),
  ["Visit https://example.com/a.b.c for details.", "Thanks very much."]);

check("ellipsis is not a triple break",
  texts("He paused... then continued walking down the long road."),
  ["He paused... then continued walking down the long road."]);

const long = "This is a deliberately long sentence, packed with clauses and commas, "
  + "which keeps going well past the point where any text-to-speech context window "
  + "would be comfortable, and therefore must be divided at a natural pause rather "
  + "than chopped mid-word somewhere arbitrary.";
const parts = texts(long);
check("long sentences are subdivided", parts.length > 1, true);
check("subdivisions respect the chunk cap", parts.every((p) => p.length <= 240), true);
check("subdivisions lose nothing",
  parts.join(" ").replace(/\s+/g, " "), long.replace(/\s+/g, " "));

check("a sentence broken across lines is stitched back",
  texts("The quick brown\nfox jumped over\nthe lazy dog. Then it slept."),
  ["The quick brown fox jumped over the lazy dog.", "Then it slept."]);

check("one word per line does not become one utterance per word",
  texts("Every\nmorning\nthe\nkettle\nrefuses\nto\nboil. It hums."),
  ["Every morning the kettle refuses to boil.", "It hums."]);

check("headings still stand alone",
  texts("The Kettle Problem\nEvery morning the kettle refuses to boil."),
  ["The Kettle Problem", "Every morning the kettle refuses to boil."]);

check("list items stay separate",
  texts("Fill with vinegar.\nWait twenty minutes.\nRinse thoroughly."),
  ["Fill with vinegar.", "Wait twenty minutes.", "Rinse thoroughly."]);

check("markup-free noise is dropped", texts("....   \n  ---  \nReal text here now."), ["Real text here now."]);

// ---- dialogue casting -------------------------------------------------

const dialogue = [
  "Here's a typical interaction between a candidate and an interviewer.",
  "Candidate: Should we rank the results from most similar to least similar?",
  "Interviewer: Images that appear first in the list should be more similar to the query image.",
  "Candidate: Should the system support videos, too?",
  "Interviewer: Let's focus only on images.",
  "Candidate: Are the displayed images personalized to the user?",
  "Interviewer: For simplicity, let's not focus on personalization.",
].map((text, i) => ({ i, text }));

const detected = api.detectSpeakers(dialogue);
check("a two-speaker dialogue is detected",
  detected.speakers, ["Candidate", "Interviewer"]);
check("the narration line is not attributed to a speaker",
  detected.labels[0], null);
check("each turn is attributed", detected.labels.slice(1),
  ["Candidate", "Interviewer", "Candidate", "Interviewer", "Candidate", "Interviewer"]);

const prose = [
  "Note: this is a single aside in an otherwise ordinary article.",
  "The rest of the piece is plain prose with no speakers at all.",
  "It continues for several sentences without any labels.",
  "And it ends without ever becoming a conversation.",
].map((text, i) => ({ i, text }));
check("a lone label does not turn an article into a dialogue",
  api.detectSpeakers(prose).speakers, []);

const twoLabelsOnce = [
  "Warning: do not do this.",
  "Note: it is a bad idea.",
  "The article then carries on at length about something else entirely.",
  "It never returns to those labels again, so nothing here is a conversation.",
].map((text, i) => ({ i, text }));
check("labels that never recur are not speakers",
  api.detectSpeakers(twoLabelsOnce).speakers, []);

check("a speaker label needs text after the colon",
  api.speakerOf("Candidate:"), null);
check("a long sentence with a mid-clause colon is not a speaker",
  api.speakerOf("The point is this: everything must be cached."), null);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
