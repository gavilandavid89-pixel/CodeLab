import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import patchStore from '../pixelforge-patch-store.js';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(){
 const bytes=Buffer.alloc(32*32*4);bytes.set([1,2,3,255]);
 const cel={format:'pixelforge-tiled-cel',version:2,width:32,height:32,tileSize:32,tiles:[{x:0,y:0,width:32,height:32,sha256:hash(bytes),rgba:bytes.toString('base64')}]};
 return {format:'pixelforge-tiled-project',version:1,id:'p1',name:'Patch test',width:32,height:32,revision:1,saveVersion:1,serverRevision:4,activeLayerId:'l1',layers:[{id:'l1',name:'Layer',visible:true,opacity:1,locked:false,cel:structuredClone(cel)}],animation:{format:'pixelforge-tiled-animation',version:1,width:32,height:32,fps:12,layerIds:['l1'],activeFrameIndex:0,frames:[{id:'f1',durationMs:100,authoringMode:'pixel-art',cels:[{layerId:'l1',cel:structuredClone(cel),metadata:{authoringMode:'pixel-art'}}]}]}};
}
function patch(op='tile.put'){
 const rgba=Buffer.alloc(32*32*4);rgba.set([8,9,10,255]);
 return {format:'pixelforge-cel-patch',version:2,projectId:'p1',baseRevision:4,operationId:'op1',frameId:'f1',layerId:'l1',canvas:{width:32,height:32,tileSize:32},operations:[{type:op,x:0,y:0,width:32,height:32,sha256:hash(rgba),rgba:rgba.toString('base64')}]};
}
test('applies RGBA tile patch and advances project revision without changing base layer',()=>{
 const project=fixture(),next=patchStore.applyPixelForgeCelPatch(project,patch());
 assert.equal(next.revision,2);assert.deepEqual(next.animation.frames[0].cels[0].cel.tiles[0].rgba,patch().operations[0].rgba);
 assert.notDeepEqual(next.animation.frames[0].cels[0].cel.tiles[0].rgba,project.layers[0].cel.tiles[0].rgba);
 assert.equal(next.layers[0].cel.tiles[0].rgba, next.animation.frames[0].cels[0].cel.tiles[0].rgba, 'active raster layer must mirror the patched active animation cel');
 assert.equal(project.serverRevision,4);
});
test('patching a non-active frame does not replace the active raster layer',()=>{
 const project=fixture();
 project.animation.frames.push({...structuredClone(project.animation.frames[0]),id:'f2'});
 project.animation.activeFrameIndex=1;
 const activeCel=structuredClone(project.layers[0].cel);
 const next=patchStore.applyPixelForgeCelPatch(project,patch());
 assert.deepEqual(next.layers[0].cel,activeCel);
 assert.notDeepEqual(next.animation.frames[0].cels[0].cel.tiles[0].rgba,activeCel.tiles[0].rgba);
 assert.deepEqual(next.animation.frames[1].cels[0].cel,activeCel);
});
test('applies sparse ownership tiles and preserves style metadata',()=>{
 const project=fixture(),owners=Buffer.alloc(32*32);owners[0]=1;
 const p={...patch(),operations:[{type:'ownership.put',x:0,y:0,width:32,height:32,sha256:hash(owners),owners:owners.toString('base64')}]};
 const next=patchStore.applyPixelForgeCelPatch(project,p);
 assert.equal(next.animation.frames[0].cels[0].cel.ownershipTiles[0].owners,p.operations[0].owners);
 assert.equal(next.animation.frames[0].cels[0].metadata.authoringMode,'pixel-art');
});
test('rejects forged tile digest, foreign target, and duplicate operation coordinate',()=>{
 const project=fixture(),forged=patch();forged.operations[0].sha256='0'.repeat(64);
 assert.throws(()=>patchStore.applyPixelForgeCelPatch(project,forged),e=>e.code==='pixelforge_patch_integrity_failed');
 const foreign=patch();foreign.frameId='missing';
 assert.throws(()=>patchStore.applyPixelForgeCelPatch(project,foreign),e=>e.code==='pixelforge_patch_target_not_found');
 const duplicate=patch();duplicate.operations.push({...duplicate.operations[0]});
 assert.throws(()=>patchStore.applyPixelForgeCelPatch(project,duplicate),e=>e.code==='invalid_pixelforge_patch');
});
test('rejects invalid ownership values',()=>{
 const project=fixture(),owners=Buffer.alloc(32*32);owners[0]=3;
 const p={...patch(),operations:[{type:'ownership.put',x:0,y:0,width:32,height:32,sha256:hash(owners),owners:owners.toString('base64')}]};
 assert.throws(()=>patchStore.applyPixelForgeCelPatch(project,p),e=>e.code==='invalid_pixelforge_patch');
});
