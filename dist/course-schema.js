// Shared by the browser and progress API; existing IDs and fields stay stable.
export const COURSE_LIMITS = {
  'english-2026': {prefix:'w',words:525,days:147,index:4,position:'position'},
  'english-2027-spring': {prefix:'s',words:325,days:153,index:14,position:'springPosition'},
  'english-2027-grade5-autumn': {prefix:'f',words:272,days:137,index:12,position:'grade5AutumnPosition'},
  'english-2028-grade5-spring': {prefix:'g',words:333,days:168,index:15,position:'grade5SpringPosition'},
  'english-2028-grade6-autumn': {prefix:'h',words:296,days:137,index:14,position:'grade6AutumnPosition'},
  'english-2029-grade6-spring': {prefix:'j',words:285,days:167,index:12,position:'grade6SpringPosition'}
};
export const MAX_PROGRESS_FIELDS = Object.values(COURSE_LIMITS).reduce((n,c)=>n+c.words+1,0);
export function wordCourse(id) {
  if(typeof id!=='string'||!/^\w\d{3}$/.test(id))return null;
  return Object.entries(COURSE_LIMITS).find(([,c])=>id[0]===c.prefix&&Number(id.slice(1))>=1&&Number(id.slice(1))<=c.words)?.[0]||null;
}
export const validWordId = id => wordCourse(id)!==null;
export const positionField = course => COURSE_LIMITS[course]?.position || 'position';
export const positionRule = field => Object.values(COURSE_LIMITS).find(c=>c.position===field);
export const isProgressField = name => validWordId(name)||!!positionRule(name);
