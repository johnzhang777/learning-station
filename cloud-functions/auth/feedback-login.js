import {handleFeedbackLogin} from '../../server/node-feedback-login.js';
export function onRequest({request}){return handleFeedbackLogin(request,process.env);}
export default onRequest;
