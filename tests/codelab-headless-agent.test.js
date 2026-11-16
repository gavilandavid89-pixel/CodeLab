import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const agent=fs.readFileSync(path.join(process.cwd(),'public/codelab-headless-agent.js'),'utf8');
const worker=fs.readFileSync(path.join(process.cwd(),'headless-codelab/runtime/remote-agent.mjs'),'utf8');
test('CodeLab page exposes explicit semantic headless protocol',()=>{
 assert.match(agent,/window\\.__codelabEditorAgent/);
 assert.match(agent,/listCapabilities/);
 assert.match(agent,/inspectState/);
 assert.match(agent,/navigate/);
 assert.match(agent,/open-project/);
 assert.doesNotMatch(agent,/eval\\s*\\(/);
});
test('remote worker dispatches through semantic page bridge',()=>{
 assert.match(worker,/__codelabEditorAgentDispatch/);
 assert.match(worker,/page\\.evaluate/);
 assert.doesNotMatch(worker,/page\\.mouse\\.(click|wheel)/);
});
