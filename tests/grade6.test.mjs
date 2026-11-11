import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {COURSE_INFO, GRADE6_AUTUMN, GRADE6_SPRING} from '../dist/courses.js';
import {COURSE_LIMITS} from '../dist/course-schema.js';

const read = path => readFile(new URL('../'+path, import.meta.url), 'utf8');
const readJson = async path => JSON.parse(await read(path));
const textbook = (await read('source/grade6/textbook.tsv')).split(/\r?\n/)
  .filter(line => line && !line.startsWith('#')).map(line => line.split('|'));
const phon = await readJson('source/grade6/pronunciations.json');
const expected = [
  {id:GRADE6_AUTUMN, term:'autumn', start:'2028-09-01', end:'2029-01-15', finalCore:'2028-12-15',
    review:'2028-12-16', days:137, learning:76, core:144, book:'1212001601265', storyWeeks:[2,3,2,3,1]},
  {id:GRADE6_SPRING, term:'spring', start:'2029-02-15', end:'2029-07-31', finalCore:'2029-06-29',
    review:'2029-07-01', days:167, learning:97, core:91, book:'1212001602145', storyWeeks:[2,3,2,3,2]}
];
const courses = await Promise.all(COURSE_INFO.map(async info => ({info, data:await readJson('dist/'+info.data)})));
const grade6 = courses.filter(({info}) => expected.some(plan => plan.id === info.id));

for (const plan of expected) {
  const {info,data} = grade6.find(({info}) => info.id === plan.id);
  const entries = new Map(data.entries.map(entry => [entry.id,entry]));
  const rule = COURSE_LIMITS[info.id];

  test(`grade 6 ${plan.term} covers the selected textbook before review with a 3+2 daily mix`, () => {
    assert.equal(data.days.length, plan.days);
    assert.equal(data.days[0].date, plan.start);
    assert.equal(data.days.at(-1).date, plan.end);
    assert.equal(data.reviewStart, plan.review);
    assert.equal(data.coreCompletionDate, plan.finalCore);
    assert.equal(rule.days, data.days.length);
    assert.equal(rule.words, entries.size);
    assert.equal(rule.index, Math.max(...data.days.filter(d => ['learn','recall'].includes(d.kind)).map(d => d.entryIds.length))-1);
    if (plan.term === 'spring') {
      assert.match(info.description, /旧版过渡/);
      assert.match(data.editionLabel, /旧版过渡/);
      assert.match(data.textbook, /2013年审定/);
    }
    const firstSeen = new Set();
    for (const [index,day] of data.days.entries()) {
      const date = new Date(Date.parse(plan.start)+index*86400000);
      assert.equal(day.date,date.toISOString().slice(0,10));
      assert.equal(day.weekday,(date.getUTCDay()+6)%7);
      const kind = day.weekday===6 ? 'rest' : day.weekday===5 ? 'review' : day.date<plan.review ? 'learn' : 'recall';
      assert.equal(day.kind,kind);
      assert.equal(new Set(day.entryIds).size,day.entryIds.length);
      assert.ok(day.entryIds.every(id => entries.has(id)));
      if (kind !== 'learn') continue;
      assert.deepEqual(day.entryIds.map(id => entries.get(id).category),['core','core','core','extension','extension']);
      assert.deepEqual(day.repeatedIds,day.entryIds.filter(id => firstSeen.has(id)));
      for (const id of day.entryIds) {
        if (!firstSeen.has(id)) assert.equal(entries.get(id).date,day.date);
        firstSeen.add(id);
      }
    }
    const learned = data.days.filter(day => day.kind === 'learn');
    assert.equal(learned.length, plan.learning);
    assert.equal(firstSeen.size, entries.size);
    assert.equal(entries.size, plan.core+plan.learning*2);
    const core = data.entries.filter(e => e.category === 'core');
    assert.equal(core.length, plan.core);
    const textbookKeys = textbook.filter(row => row[0] === plan.term).map(([,unit,page,word]) => [Number(unit),Number(page),word]);
    assert.deepEqual(core.map(e => [e.unit,e.source.textbookPage,e.word]),textbookKeys);
    assert.ok(core.every(e => e.source.reference === `https://book.pep.com.cn/${plan.book}/`));
    for (const e of entries.values()) {
      const p = phon[`${plan.term}:${e.word}`] || phon[e.word];
      assert.equal(e.ipaUK,p.uk);
      assert.equal(e.ipaUS,p.us);
      assert.match(p.reference,/^https:\/\//);
      assert.equal(e.examples.length,2);
      assert.notEqual(e.examples[0].en,e.examples[1].en);
      for (const example of e.examples) assert.ok(example.en && example.zh && example.scene);
    }
  });

  test(`grade 6 ${plan.term} reviews all semester words and uses studied words in the passages`, () => {
    const recall = data.days.filter(d => d.kind === 'recall').flatMap(d => d.entryIds);
    assert.equal(recall.length,entries.size);
    assert.deepEqual(new Set(recall),new Set(entries.keys()));
    assert.deepEqual(data.weeks.filter(w => w.storyIds.length).map(w => w.storyIds.length),plan.storyWeeks);
    for (const story of data.stories) {
      const day = data.days[story.day-1];
      assert.equal(day.storyId,story.id);
      assert.equal(day.kind,'recall');
      const passage = story.paragraphs.join(' ');
      assert.equal(story.sentences.map(s => s.text).join(' '),passage);
      assert.equal(story.wordCount,passage.match(/[A-Za-z]+(?:['-][A-Za-z]+)*/g).length);
      assert.ok(story.wordCount >= 80 && story.wordCount <= 120);
      assert.ok(story.focusIds.length >= 4);
      for (const id of story.focusIds) {
        const word = entries.get(id).word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        assert.match(passage,new RegExp(`\\b${word}\\b`,'i'));
      }
      assert.equal(story.questions.length,3);
      assert.equal(story.cloze.length,2);
      assert.equal(story.translation.length,story.paragraphs.length);
      assert.ok(story.oral && story.oralExample && story.retell.length);
    }
  });
}

test('grade 6 extensions are new and past-tense read has a separate recording', async () => {
  const earlier = courses.filter(course => !grade6.includes(course))
    .flatMap(({data}) => data.entries.map(e => e.word.toLowerCase()));
  const core = grade6.flatMap(({data}) => data.entries.filter(e => e.category === 'core').map(e => e.word.toLowerCase()));
  const blocked = new Set([...earlier,...core]);
  const ext = grade6.flatMap(({data}) => data.entries.filter(e => e.category === 'extension').map(e => e.word.toLowerCase()));
  assert.equal(ext.length,346);
  assert.equal(new Set(ext).size,ext.length);
  assert.ok(ext.every(word => !blocked.has(word)));
  const recordings = [];
  for (const {info,data} of grade6) {
    const readWord = data.entries.find(e => e.word === 'read');
    const manifest = await readJson('dist/'+info.audio);
    const past = info.id === GRADE6_SPRING;
    assert.equal(readWord.ipaUK,past ? '/red/' : '/riːd/');
    assert.equal(readWord.ipaUS,readWord.ipaUK);
    assert.ok(readWord.wordAudioContext);
    recordings.push(manifest.entries[readWord.id]);
  }
  for (const accent of ['uk','us']) assert.notEqual(recordings[0][accent].word.src,recordings[1][accent].word.src);
});
