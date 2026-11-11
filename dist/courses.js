import {wordCourse} from './course-schema.js';
export {COURSE_LIMITS,validWordId,positionField} from './course-schema.js';
export const AUTUMN = 'english-2026';
export const SPRING = 'english-2027-spring';
export const GRADE5_AUTUMN = 'english-2027-grade5-autumn';
export const GRADE5_SPRING = 'english-2028-grade5-spring';
export const GRADE6_AUTUMN = 'english-2028-grade6-autumn';
export const GRADE6_SPRING = 'english-2029-grade6-spring';
export const COURSE_TITLE = '每日英语词汇';
export const COURSE_INFO = [
  { id:AUTUMN, prefix:'autumn', label:'四年级上学期', period:'2026.09 - 2027.01', description:'原21周手册，继续使用已有学习记录。', data:'data.json', audio:'audio-manifest.json', materials:[
    {label:'A4打印版',href:'materials/grade4-autumn/a4.pdf'},
    {label:'陪读版',href:'materials/grade4-autumn/companion.pdf'}
  ] },
  { id:SPRING, prefix:'spring', label:'四年级下学期', period:'2027.03 - 2027.07', description:'每日3教材词＋2适龄拓展词；7月词汇与短文复习。', reviewPeriod:'7月', data:'spring-data.json', audio:'spring-audio-manifest.json', materials:[
    {label:'A4打印版',href:'materials/grade4-spring/a4.pdf'},
    {label:'陪读版',href:'materials/grade4-spring/companion.pdf'}
  ] },
  { id:GRADE5_AUTUMN, prefix:'grade5-autumn', label:'五年级上学期', period:'2027.09.01 - 2028.01.15', description:'9月1日-12月15日积累；12月16日-1月15日复习。', reviewPeriod:'12月16日-1月15日', data:'grade5-autumn-data.json', audio:'grade5-autumn-audio-manifest.json', materials:[
    {label:'A4打印版',href:'materials/grade5-autumn/a4.pdf'},
    {label:'陪读版',href:'materials/grade5-autumn/companion.pdf'}
  ] },
  { id:GRADE5_SPRING, prefix:'grade5-spring', label:'五年级下学期', period:'2028.02.15 - 2028.07.31', description:'2月15日-6月30日积累；7月词汇与短文复习。', reviewPeriod:'7月', data:'grade5-spring-data.json', audio:'grade5-spring-audio-manifest.json', materials:[
    {label:'A4打印版',href:'materials/grade5-spring/a4.pdf'},
    {label:'陪读版',href:'materials/grade5-spring/companion.pdf'}
  ] },
  { id:GRADE6_AUTUMN, prefix:'grade6-autumn', label:'六年级上学期', period:'2028.09.01 - 2029.01.15', description:'新版人教PEP。积累至12月15日，12月16日起复习。', reviewPeriod:'12月16日-1月15日', data:'grade6-autumn-data.json', audio:'grade6-autumn-audio-manifest.json', materials:[
    {label:'A4打印版',href:'materials/grade6-autumn/a4.pdf'},
    {label:'陪读版',href:'materials/grade6-autumn/companion.pdf'}
  ] },
  { id:GRADE6_SPRING, prefix:'grade6-spring', label:'六年级下学期', period:'2029.02.15 - 2029.07.31', description:'人教PEP旧版过渡资料。积累至6月29日，7月复习。', reviewPeriod:'7月', data:'grade6-spring-data.json', audio:'grade6-spring-audio-manifest.json', materials:[
    {label:'A4打印版',href:'materials/grade6-spring/a4.pdf'},
    {label:'陪读版',href:'materials/grade6-spring/companion.pdf'}
  ] }
];
export function courseForPath(path, selected=AUTUMN) {
  const explicit=COURSE_INFO.find(c=>c.prefix===path[0]);if(explicit)return explicit.id;
  if(['english','day','review','practice'].includes(path[0]))return AUTUMN;
  if(path[0]==='word')return wordCourse(path[1])||AUTUMN;
  return COURSE_INFO.some(c=>c.id===selected)?selected:AUTUMN;
}
export const isCoursePrefix = prefix => COURSE_INFO.some(c=>c.prefix===prefix);
export function courseHref(route,course=AUTUMN){return '#/'+(course===AUTUMN?'':COURSE_INFO.find(c=>c.id===course).prefix+'/')+route;}
export function audioEntries(course) {
  return (course.stories||[]).flatMap(story=>[
    {id:story.id,word:story.titleEn,spoken:story.paragraphs.join(' '),kind:'story-audio',storyId:story.id,courseId:course.id},
    ...story.sentences.map(sentence=>({id:sentence.id,word:story.titleEn,spoken:sentence.text,kind:'story-audio',storyId:story.id,courseId:course.id}))
  ]);
}
