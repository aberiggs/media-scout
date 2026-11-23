import { describe, expect, it } from 'vitest';
import { openSearchStore } from '../src/search/store';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SearchRuntime } from '../src/search/runtime';
import { defaultSettings } from '../src/search/settings';

describe('search store persistence and ownership', () => {
  it('persists jobs, private candidates, events, settings, deadlines and observations across reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'search-restart-'));
    const path = join(directory, 'state.sqlite');
    let store = openSearchStore(path);
    store.createSearch({ searchId: 's1', prompt: 'find', status: 'queued', createdAt: 100 });
    store.addCandidate({ searchId: 's1', candidateId: 'c1', safe: { title: 'Release' }, privateData: { guid: 'secret' }, expiresAt: 900 });
    store.appendEvent('s1', { type: 'query', query: 'find', count: 1 });
    store.setSetting('preferences', { resolutions: ['1080p'] });
    store.setAutomationAttempt('target-1', { lastAttempt: 100, failCount: 0, deadline: 500, graceUntil: 0 });
    store.setProviderDeadline('indexer-2', 600);
    store.saveObservation('sonarr', { observedAt: 100, complete: false, payload: { items: [] } });
    store.close();
    store = openSearchStore(path);
    expect(store.getSearch('s1')?.status).toBe('queued');
    expect(store.getCandidate('s1', 'c1', 200)?.privateData).toEqual({ guid: 'secret' });
    expect(store.getEvents('s1')).toHaveLength(1);
    expect(store.getSetting('preferences')).toEqual({ resolutions: ['1080p'] });
    expect(store.getAutomationAttempt('target-1')?.deadline).toBe(500);
    expect(store.getProviderDeadline('indexer-2')).toBe(600);
    expect(store.getObservation('sonarr')).toMatchObject({ complete: false });
    expect(store.getCandidate('s1', 'c1', 901)).toBeNull();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  it('keeps a live lease exclusive until expiration', () => {
    const store = openSearchStore(':memory:');
    expect(store.acquireLease('target:t1', 'owner-a', 10, 100)).toBe(true);
    expect(store.acquireLease('target:t1', 'owner-b', 20, 100)).toBe(false);
    expect(store.acquireLease('target:t1', 'owner-b', 110, 100)).toBe(true);
    expect(store.ownsLease('target:t1', 'owner-a', 110)).toBe(false);
    expect(store.ownsLease('target:t1', 'owner-b', 110)).toBe(true);
    store.close();
  });
  it('excludes a running scheduled search from foreground capacity and yields scheduled claims to queued foreground work across connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'search-capacity-')), path = join(directory, 'state.sqlite');
    const first = openSearchStore(path), second = openSearchStore(path);
    try {
      first.setSetting('application-settings', {...defaultSettings,search:{...defaultSettings.search,concurrentSearches:1}});
      first.enqueueSearch({searchId:'auto-1',prompt:'scheduled',now:1,source:'automation'});
      expect(first.claimAutomationSearchById('auto-1','auto-owner',2,100)?.searchId).toBe('auto-1');
      first.enqueueSearch({searchId:'manual',prompt:'manual',now:3});
      first.enqueueSearch({searchId:'auto-2',prompt:'scheduled',now:4,source:'automation'});
      expect(second.claimAutomationSearchById('auto-2','auto-owner-2',5,100)).toBeNull();
      expect(second.claimNextSearch('manual-owner',5,100)?.searchId).toBe('manual');
      first.enqueueSearch({searchId:'next',prompt:'next',now:6});
      expect(first.claimNextSearch('next-owner',6,100)).toBeNull();
      expect(first.claimAutomationSearchById('auto-2','auto-owner-2',6,100)).toBeNull();
    } finally { first.close(); second.close(); rmSync(directory,{recursive:true,force:true}); }
  });
  it('uses the current saved cap for claims across independent connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'search-cap-setting-')), path = join(directory, 'state.sqlite');
    const first = openSearchStore(path), second = openSearchStore(path);
    try {
      first.setSetting('application-settings', {...defaultSettings,search:{...defaultSettings.search,concurrentSearches:1}});
      first.enqueueSearch({searchId:'one',prompt:'one',now:1});
      first.enqueueSearch({searchId:'two',prompt:'two',now:2});
      expect(first.claimNextSearch('one-owner',3,100)?.searchId).toBe('one');
      expect(second.claimNextSearch('two-owner',3,100)).toBeNull();
      first.setSetting('application-settings', {...defaultSettings,search:{...defaultSettings.search,concurrentSearches:2}});
      expect(second.claimNextSearch('two-owner',4,100)?.searchId).toBe('two');
    } finally { first.close(); second.close(); rmSync(directory,{recursive:true,force:true}); }
  });
  it('persists acquisition idempotency and interleaves acquisition FIFO with manual work',()=>{
    const directory=mkdtempSync(join(tmpdir(),'acquisition-queue-')),path=join(directory,'state.sqlite');
    let store=openSearchStore(path);
    store.enqueueSearch({searchId:'manual-1',prompt:'first',now:1});
    const snapshot=()=>({prompt:'acquire',clientId:7,sourceFingerprint:'source',dryRun:true});
    const first=store.acceptAcquisition({key:'key-1',hash:'hash-1',now:2,snapshot});
    expect(first).toMatchObject({status:'created',searchId:expect.any(String)});
    store.enqueueSearch({searchId:'manual-2',prompt:'third',now:3});
    const second=store.acceptAcquisition({key:'key-2',hash:'hash-2',now:4,snapshot:()=>({...snapshot(),prompt:'acquire next'})});
    expect(second.status).toBe('created');
    store.close();store=openSearchStore(path);
    expect(store.acceptAcquisition({key:'key-1',hash:'hash-1',now:4,snapshot:()=>{throw new Error('must not read current settings for replay');}})).toEqual({status:'replay',searchId:first.searchId});
    expect(store.acceptAcquisition({key:'key-1',hash:'different',now:4,snapshot:()=>{throw new Error('must not read current settings for conflict');}})).toEqual({status:'conflict',searchId:first.searchId});
    expect(store.claimNextSearch('owner-1',10,100)?.searchId).toBe('manual-1');
    expect(store.claimNextSearch('owner-2',10,100)?.searchId).toBe(first.searchId);
    expect(store.claimNextSearch('owner-3',10,100)?.searchId).toBe('manual-2');
    expect(store.activeForegroundSearchCount(10)).toBe(3);
    expect(store.claimNextSearch('owner-4',10,100)).toBeNull();
    store.finishOwnedSearch('manual-1','owner-1','failed',{},11);
    expect(store.claimNextSearch('owner-4',12,100)?.searchId).toBe(second.searchId);
    store.close();rmSync(directory,{recursive:true,force:true});
  });
  it('retains old matched acquisition while its handoff lease is live, then expires the tombstone after history',()=>{
    const store=openSearchStore(':memory:'),day=86_400_000;
    const accepted=store.acceptAcquisition({key:'old-key',hash:'hash',now:1,snapshot:()=>({prompt:'old prompt',clientId:7,sourceFingerprint:'source',dryRun:true})});
    const work=store.claimNextSearch('handoff-owner',2,100*day)!;
    expect(store.finishOwnedSearch(work.searchId,work.owner,'matched',{version:1,status:'matched'},3,true)).toBe(true);
    store.maintain(70*day);
    expect(store.getSearch(accepted.searchId)?.status).toBe('matched');
    expect(store.searchWorkLive(accepted.searchId,70*day)).toBe(true);
    expect(store.acquisition(accepted.searchId)).not.toBeNull();
    store.releaseSearch(accepted.searchId,'handoff-owner');
    store.maintain(70*day+1);
    expect(store.getSearch(accepted.searchId)).toBeNull();
    store.maintain(70*day+2);
    expect(store.acquisition(accepted.searchId)).toBeNull();
    store.close();
  });
  it('keeps the terminal outcome readable when an acquisition waited over 30 days in the queue', async () => {
    const store = openSearchStore(':memory:');
    const now = 31 * 86_400_000;
    const accepted = store.acceptAcquisition({key:'waited',hash:'request',now:1,snapshot:()=>({prompt:'Find the title',clientId:7,sourceFingerprint:'source',dryRun:true})});
    expect(store.claimNextSearch('worker',now,100)?.searchId).toBe(accepted.searchId);
    expect(store.finishOwnedSearch(accepted.searchId,'worker','no-match',{version:1},now+1)).toBe(true);
    const runtime = new SearchRuntime({store,now:()=>now+2});
    try {
      expect(await runtime.getSearch(accepted.searchId)).toMatchObject({status:'no-match',acquisition:{status:'not-attempted'}});
    } finally { await runtime.close(); }
  });
  it('keeps an acquisition outcome when the independent receipt cap evicts its journal', async () => {
    const directory = mkdtempSync(join(tmpdir(),'acquisition-receipt-cap-')), path = join(directory,'state.sqlite');
    const store = openSearchStore(path);
    const {searchId} = store.acceptAcquisition({key:'older',hash:'request',now:1,snapshot:()=>({prompt:'Find the title',clientId:7,sourceFingerprint:'source',dryRun:false})});
    expect(store.claimNextSearch('worker',2,100)?.searchId).toBe(searchId);
    expect(store.finishOwnedSearch(searchId,'worker','matched',{version:1},3)).toBe(true);
    expect(store.createExecution({id:'first',key:`!acquisition:${searchId}`,hash:'journal',searchId,planId:'plan',version:2,payload:{dryRun:false},children:[{candidateId:'one',physicalKey:'one',state:'prepared'}],owner:'executor',now:4,leaseUntil:100})).toBe('created');
    expect(store.updateExecutionChild('first','executor',5,0,'sending')).toBe(true);
    expect(store.updateExecutionChild('first','executor',6,0,'submitted')).toBe(true);
    expect(store.finishExecution('first','executor',6,'submitted',null)).toBe(true);
    const seed = new Database(path);
    seed.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
      INSERT INTO executions SELECT 'fixture-'||i,'fixture-key-'||i,'hash','other','submitted','owner',100,'[]','{}',7,7 FROM n`);
    seed.close();
    const runtime = new SearchRuntime({store,now:()=>8});
    try {
      expect(runtime.store.execution('first')).toBeNull();
      expect(await runtime.getSearch(searchId)).toMatchObject({status:'matched',acquisition:{status:'submitted'},receipts:[]});
    } finally { await runtime.close(); rmSync(directory,{recursive:true,force:true}); }
  });
  it('restarts queued acquisition, reports a matched pre-journal cut as interrupted, and never replays a sending journal child',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'acquisition-cuts-')),path=join(directory,'state.sqlite');
    const store=openSearchStore(path);
    const snapshot=()=>({prompt:'persisted',clientId:7,sourceFingerprint:'source',dryRun:false});
    const preJournal=store.acceptAcquisition({key:'pre-journal-key',hash:'pre-hash',now:1,snapshot});
    const preWork=store.claimNextSearch('pre-owner',3,10)!;
    expect(preWork.searchId).toBe(preJournal.searchId);
    store.finishOwnedSearch(preJournal.searchId,preWork.owner,'matched',{version:1,status:'matched'},4,true);
    const uncertain=store.acceptAcquisition({key:'uncertain-key',hash:'uncertain-hash',now:5,snapshot});
    const next=store.claimNextSearch('sending-search-owner',6,10)!;
    expect(next.searchId).toBe(uncertain.searchId);
    store.finishOwnedSearch(uncertain.searchId,next.owner,'matched',{version:1,status:'matched'},7,true);
    expect(store.createExecution({id:'execution-1',key:`!acquisition:${uncertain.searchId}`,hash:'execution-hash',searchId:uncertain.searchId,planId:'plan',version:2,payload:{dryRun:false,client:{id:7,name:'Client',protocol:'torrent'}},children:[{candidateId:'candidate',physicalKey:'physical',state:'prepared'}],owner:'execution-owner',now:8,leaseUntil:10})).toBe('created');
    expect(store.updateExecutionChild('execution-1','execution-owner',9,0,'sending')).toBe(true);
    expect(store.stopAcquisition(uncertain.searchId,'acquisition-preparation-failed',9)).toBe(false);
    expect(store.getEvents(uncertain.searchId).some((event:any)=>event.type==='acquisition-stopped')).toBe(false);
    const queued=store.acceptAcquisition({key:'queued-key',hash:'queued-hash',now:10,snapshot});
    store.close();
    let grabs=0;
    const runtime=new SearchRuntime({databasePath:path,initialSettings:defaultSettings,now:()=>20,clients:()=>({prowlarr:{getIndexers:async()=>[],getIndexerStatuses:async()=>[],search:async()=>[],getDownloadClients:async()=>[],grab:async()=>{grabs++;}}})});
    try{
      const queuedDetail=await runtime.getSearch(queued.searchId);
      expect(queuedDetail).toMatchObject({status:'queued',acquisition:{status:'queued'}});
      expect(runtime.store.claimNextSearch('after-restart',20,100)?.searchId).toBe(queued.searchId);
      expect(await runtime.getSearch(preJournal.searchId)).toMatchObject({status:'matched',acquisition:{status:'interrupted',downloadClientId:7},receipts:[]});
      expect(await runtime.getSearch(uncertain.searchId)).toMatchObject({status:'matched',acquisition:{status:'uncertain'},receipts:[{outcome:'uncertain',children:[{outcome:'uncertain'}]}]});
      expect(runtime.store.executionByKey(`!acquisition:${uncertain.searchId}`)?.children[0]?.state).toBe('uncertain');
      expect(runtime.store.searchWorkLive(uncertain.searchId,20)).toBe(false);
      expect(grabs).toBe(0);
    }finally{await runtime.close();rmSync(directory,{recursive:true,force:true});}
  });
});
