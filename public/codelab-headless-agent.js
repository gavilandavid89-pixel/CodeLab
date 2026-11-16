(() => {
'use strict';
const VERSION='2.0.0';
async function dispatch(action,args={}) {
  const agent=window.__codelabCommandAgent;
  if(!agent || typeof agent.dispatch!=='function') throw new Error('CodeLab native command agent is unavailable');
  return agent.dispatch(action,args);
}
const agent={
  version:VERSION,
  protocol:'codelab-headless-bridge/2',
  visualInteractionRequired:false,
  coordinateInteractionRequired:false,
  listCapabilities:()=>({
    protocol:'codelab-headless-bridge/2',
    version:VERSION,
    actions:window.__codelabCommandAgent?.listCapabilities?.().actions||[],
    visualInteractionRequired:false,
    coordinateInteractionRequired:false
  }),
  inspectState:()=>dispatch('inspect-state'),
  dispatch
};
window.__codelabEditorAgent=agent;
window.__codelabHeadless=agent;
window.__codelabEditorAgentDispatch=dispatch;
window.__codelabHeadlessDispatch=dispatch;
window.__codelabAgentDispatch=dispatch;
window.__codelabEditorAgentResolve=async request=>{
  if(!request||typeof request!=='object') throw new Error('Invalid headless request');
  return dispatch(request.action,request.args||{});
};
window.__codelabCommandAgentBridge=agent;
})();