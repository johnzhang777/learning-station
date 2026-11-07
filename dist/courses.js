export const AUTUMN = 'english-2026';
export const SPRING = 'english-2027-spring';
export const COURSE_INFO = [
  { id:AUTUMN, prefix:'autumn', label:'四年级上学期', period:'2026.09 - 2027.01', data:'data.json', audio:'audio-manifest.json' },
  { id:SPRING, prefix:'spring', label:'四年级下学期', period:'2027.03 - 2027.07', data:'spring-data.json', audio:'spring-audio-manifest.json' }
];
export function validWordId(id) { return /^(?:w\d{3}|s\d{3})$/.test(id) && Number(id.slice(1))>=1 && Number(id.slice(1))<=(id[0]==='w'?525:325); }
export function courseForPath(path, selected=AUTUMN) {
  if(path[0]==='spring')return SPRING;if(path[0]==='autumn')return AUTUMN;
  if(['english','day','review','practice'].includes(path[0]))return AUTUMN;
  if(path[0]==='word')return String(path[1]).startsWith('s')?SPRING:AUTUMN;
  return COURSE_INFO.some(c=>c.id===selected)?selected:AUTUMN;
}
export const positionField = course => course===SPRING?'springPosition':'position';
export function audioEntries(course) {
  return (course.stories||[]).flatMap(story=>[
    {id:story.id,word:story.titleEn,spoken:story.paragraphs.join(' '),kind:'story-audio',storyId:story.id,courseId:course.id},
    ...story.sentences.map(sentence=>({id:sentence.id,word:story.titleEn,spoken:sentence.text,kind:'story-audio',storyId:story.id,courseId:course.id}))
  ]);
}
