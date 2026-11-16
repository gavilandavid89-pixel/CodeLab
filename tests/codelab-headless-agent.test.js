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

const localLauncher=fs.readFileSync(path.join(process.cwd(),'headless-local/bin/codelab-local-headless.sh'),'utf8');
const localReadme=fs.readFileSync(path.join(process.cwd(),'headless-local/README.md'),'utf8');
const capabilities=JSON.parse(fs.readFileSync(path.join(process.cwd(),'headless-local/runtime/capabilities.json'),'utf8'));
test('local workbench and remote connector remain distinct runtimes',()=>{
 assert.match(localReadme,/Headless #1/);
 assert.match(localReadme,/headless-codelab/);
 assert.equal(capabilities.headlessId,'assistant-local-workbench');
 assert.equal(capabilities.includes.codelabApplication,true);
 assert.equal(capabilities.includes.nativePenpotEditor,true);
 assert.match(localLauncher,/Packaged CodeLab app source is missing/);
 assert.match(localLauncher,/CODELAB_LOCAL_ALLOW_DATABASE/);
});
test('remote connector is headless by default and blocks unrelated localhost services',()=>{
 assert.match(worker,/headed=args\.includes\('--headed'\)/);
 assert.match(worker,/localTarget&&localRequest/);
 assert.doesNotMatch(worker,/p\.hostname==='localhost'\|\|p\.hostname==='127\.0\.0\.1'/);
});
test('remote worker treats semantic ok:false as a failed command',()=>{
 assert.match(worker,/result&&result\.ok===false/);
 assert.match(worker,/requestFailures\.length===0/);
});
