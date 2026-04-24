const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const rooms = {};

const FLOWERS = ["渔","樵","耕","读","琴","棋","书","画","梅","兰","竹","菊","春","夏","秋","冬"];

function createWall() {
  const tiles = [];
  for (const suit of ["万", "条", "筒"]) {
    for (let n = 1; n <= 9; n++) for (let i = 0; i < 4; i++) tiles.push({ id: uid(), name: `${n}${suit}` });
  }
  for (const h of ["东","南","西","北","中","发","白"]) for (let i = 0; i < 4; i++) tiles.push({ id: uid(), name: h });
  for (const f of FLOWERS) tiles.push({ id: uid(), name: f });
  return shuffle(tiles);
}
function uid(){ return Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4); }
function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }
function isFlower(tile){ return tile && FLOWERS.includes(tile.name); }
function emptyPlayer(name, socketId){ return { name, socketId, hand: [], flowers: [], melds: [], connected: true, newTileId: null }; }
function sortTiles(hand){
  const order = {"万":1,"条":2,"筒":3,"东":4,"南":5,"西":6,"北":7,"中":8,"发":9,"白":10};
  const info = (t)=>{ const name=t.name; if(name.includes('万')) return {s:'万',n:parseInt(name)}; if(name.includes('条')) return {s:'条',n:parseInt(name)}; if(name.includes('筒')) return {s:'筒',n:parseInt(name)}; return {s:name,n:0}; };
  return hand.slice().sort((a,b)=>{const A=info(a),B=info(b); return order[A.s]===order[B.s]?A.n-B.n:order[A.s]-order[B.s];});
}
function visibleMeldsForViewer(player, ownerIndex, viewerIndex) {
  return player.melds.map(m => {
    if (m.type === '暗杠' && ownerIndex !== viewerIndex) {
      return { type: '暗杠', concealed: true, tiles: m.tiles.map(() => ({ id: uid(), name: '暗' })) };
    }
    return { type: m.type, concealed: false, tiles: m.tiles };
  });
}
function publicState(room, viewerIndex){
  return {
    roomCode: room.code,
    maxPlayers: room.maxPlayers,
    started: room.started,
    gameOver: room.gameOver,
    currentTurn: room.currentTurn,
    mustDiscard: room.mustDiscard,
    wallCount: room.wall.length,
    lastDiscard: room.lastDiscard,
    lastDiscardFrom: room.lastDiscardFrom,
    scores: room.scores,
    players: room.players.map((p,i)=>({
      name:p.name,
      connected:p.connected,
      handCount:p.hand.length,
      flowers:p.flowers,
      melds:visibleMeldsForViewer(p, i, viewerIndex),
      newTileId:p.newTileId,
      hand:i === viewerIndex ? sortTiles(p.hand) : []
    })),
    discards: room.discards
  };
}
function sendState(room){
  room.players.forEach((p, i) => {
    if (p.socketId) io.to(p.socketId).emit('state', publicState(room, i));
  });
}
function roomOf(socket){ return socket.data.roomCode ? rooms[socket.data.roomCode] : null; }
function playerIndex(room, socket){ return room.players.findIndex(p=>p.socketId===socket.id); }

function drawInto(room, idx){
  if (!room.wall.length) return null;
  const tile = room.wall.pop();
  if (isFlower(tile)) { room.players[idx].flowers.push(tile); return drawInto(room, idx); }
  room.players[idx].hand.push(tile);
  room.players[idx].newTileId = tile.id;
  return tile;
}
function deal(room){
  room.wall = createWall(); room.discards=[]; room.lastDiscard=null; room.lastDiscardFrom=null; room.pending=null; room.gameOver=false;
  for(const p of room.players){ p.hand=[]; p.flowers=[]; p.melds=[]; p.newTileId=null; }
  for(let i=0;i<13;i++) for(let p=0;p<room.maxPlayers;p++) drawInto(room,p);
  drawInto(room,0); // dealer 14
  room.currentTurn=0; room.mustDiscard=true; room.started=true;
}
function nextTurnAutoDraw(room){
  room.currentTurn = (room.currentTurn + 1) % room.maxPlayers;
  drawInto(room, room.currentTurn);
  room.mustDiscard = true;
  // self win option after auto draw
  notifySelfActions(room, room.currentTurn);
}
function removeByName(hand, name, count){ let removed=[]; for(let i=hand.length-1;i>=0 && removed.length<count;i--){ if(hand[i].name===name){ removed.push(hand.splice(i,1)[0]); }} return removed; }
function countName(hand,name){ return hand.filter(t=>t.name===name).length; }
function tileNames(hand){ return hand.map(t=>t.name); }
function isWinningHand(hand){
  const names = tileNames(hand).filter(n=>!FLOWERS.includes(n));
  if(names.length % 3 !== 2) return false;
  const counts={}; names.forEach(n=>counts[n]=(counts[n]||0)+1);
  for(const pair in counts){ if(counts[pair]>=2){ const arr=names.slice(); removeName(arr,pair); removeName(arr,pair); if(canSets(arr)) return true; }}
  return false;
}
function removeName(arr,name){ const i=arr.indexOf(name); if(i>=0) arr.splice(i,1); }
function canSets(arr){
  if(arr.length===0) return true; arr.sort(tileSortName); const first=arr[0];
  if(arr.filter(x=>x===first).length>=3){ const c=arr.slice(); removeName(c,first); removeName(c,first); removeName(c,first); if(canSets(c)) return true; }
  const num=parseInt(first); const suit=first.replace(num,'');
  if(!isNaN(num) && ['万','条','筒'].includes(suit)){
    const a=`${num+1}${suit}`, b=`${num+2}${suit}`;
    if(arr.includes(a)&&arr.includes(b)){ const c=arr.slice(); removeName(c,first); removeName(c,a); removeName(c,b); if(canSets(c)) return true; }
  }
  return false;
}
function tileSortName(a,b){ const order={"万":1,"条":2,"筒":3,"东":4,"南":5,"西":6,"北":7,"中":8,"发":9,"白":10}; const inf=(n)=>{if(n.includes('万'))return{s:'万',n:parseInt(n)};if(n.includes('条'))return{s:'条',n:parseInt(n)};if(n.includes('筒'))return{s:'筒',n:parseInt(n)};return{s:n,n:0}}; const A=inf(a),B=inf(b); return order[A.s]===order[B.s]?A.n-B.n:order[A.s]-order[B.s]; }
function chiCombos(hand, discardName){
  const n=parseInt(discardName); const suit=discardName.replace(n,''); if(isNaN(n)||!['万','条','筒'].includes(suit)) return [];
  const patterns=[[n-2,n-1],[n-1,n+1],[n+1,n+2]]; const names=tileNames(hand); const combos=[];
  for(const p of patterns){ if(p[0]>=1&&p[1]<=9&&names.includes(`${p[0]}${suit}`)&&names.includes(`${p[1]}${suit}`)) combos.push([`${p[0]}${suit}`,`${p[1]}${suit}`]); }
  return combos;
}
function checkReactions(room){
  const d = room.lastDiscard; if(!d) return continueAfterNoClaim(room);
  room.pending = { discard:d, from:room.lastDiscardFrom, options:{}, responses:{} };
  for(let step=1; step<room.maxPlayers; step++){
    const idx=(room.lastDiscardFrom+step)%room.maxPlayers; const p=room.players[idx]; const cnt=countName(p.hand,d.name);
    const opts={ win:isWinningHand([...p.hand,d]), gang:cnt>=3, pong:cnt>=2, chi:false, chiCombos:[] };
    if(step===1){ opts.chiCombos=chiCombos(p.hand,d.name); opts.chi=opts.chiCombos.length>0; }
    if(opts.win||opts.gang||opts.pong||opts.chi){ room.pending.options[idx]=opts; io.to(p.socketId).emit('showActions',{...opts,lastDiscard:d}); }
  }
  if(Object.keys(room.pending.options).length===0) { room.pending=null; continueAfterNoClaim(room); }
  else sendState(room);
}
function continueAfterNoClaim(room){ nextTurnAutoDraw(room); sendState(room); }
function notifySelfActions(room, idx){
  const p=room.players[idx]; const concealed = Object.keys(p.hand.reduce((a,t)=>(a[t.name]=(a[t.name]||0)+1,a),{})).filter(n=>countName(p.hand,n)>=4);
  const canWin=isWinningHand(p.hand);
  if(canWin || concealed.length){ io.to(p.socketId).emit('showActions',{ win:canWin, gang:concealed.length>0, pong:false, chi:false, self:true, concealedGangs:concealed }); }
}
function resolveAction(room, idx, action, combo){
  if(room.gameOver) return;
  const pending=room.pending;
  if(action==='pass'){
    if(pending){ pending.responses[idx]='pass'; const optionPlayers=Object.keys(pending.options); const all = optionPlayers.every(k=>pending.responses[k]); if(all){ room.pending=null; continueAfterNoClaim(room); } else sendState(room); }
    return;
  }
  if(action==='selfWin'){ return endGame(room,idx,'self',null); }
  if(action==='concealedGang'){
    const name=combo; if(countName(room.players[idx].hand,name)>=4){ const tiles=removeByName(room.players[idx].hand,name,4); room.players[idx].melds.push({type:'暗杠', tiles}); drawInto(room,idx); room.currentTurn=idx; room.mustDiscard=true; notifySelfActions(room,idx); sendState(room); } return;
  }
  if(!pending) return;
  const opts=pending.options[idx]; if(!opts) return;
  const d=pending.discard;
  if(action==='win' && opts.win) return endGame(room,idx,'discard',pending.from);
  if(action==='gang' && opts.gang){ removeByName(room.players[idx].hand,d.name,3); room.players[idx].melds.push({type:'杠',tiles:[d,{name:d.name},{name:d.name},{name:d.name}]}); room.pending=null; room.currentTurn=idx; drawInto(room,idx); room.mustDiscard=true; notifySelfActions(room,idx); return sendState(room); }
  if(action==='pong' && opts.pong){ const tiles=removeByName(room.players[idx].hand,d.name,2); room.players[idx].melds.push({type:'碰',tiles:[d,...tiles]}); room.pending=null; room.currentTurn=idx; room.mustDiscard=true; return sendState(room); }
  if(action==='chi' && opts.chi){ const useCombo = Array.isArray(combo)?combo:opts.chiCombos[0]; if(!useCombo) return; const tiles=[]; for(const name of useCombo) tiles.push(...removeByName(room.players[idx].hand,name,1)); room.players[idx].melds.push({type:'吃',tiles:[d,...tiles]}); room.pending=null; room.currentTurn=idx; room.mustDiscard=true; return sendState(room); }
}
function endGame(room,winner,type,from){
  room.gameOver=true; room.pending=null;
  const changes=Array(room.maxPlayers).fill(0);
  if(type==='self'){ changes[winner]+=room.maxPlayers-1; for(let i=0;i<room.maxPlayers;i++) if(i!==winner) changes[i]-=1; }
  else { changes[winner]+=1; changes[from]-=1; }
  for(let i=0;i<room.maxPlayers;i++) room.scores[i]+=changes[i];
  io.to(room.code).emit('gameOver',{ winner, type, from, scores:room.scores, changes, players:room.players.map(p=>p.name) });
  sendState(room);
}
function resetRoom(room){ room.started=false; room.gameOver=false; room.pending=null; room.wall=[]; room.discards=[]; room.lastDiscard=null; room.lastDiscardFrom=null; room.currentTurn=0; room.mustDiscard=false; room.players.forEach(p=>{p.hand=[];p.flowers=[];p.melds=[];p.newTileId=null;}); }

io.on('connection', socket=>{
  socket.on('joinRoom', ({name, roomCode, playerCount})=>{
    roomCode = (roomCode||'ROOM').toUpperCase().trim();
    if(!rooms[roomCode]) rooms[roomCode] = { code:roomCode, maxPlayers:Number(playerCount)||4, players:[], scores:[], wall:[], discards:[], started:false, gameOver:false, currentTurn:0, mustDiscard:false, lastDiscard:null, lastDiscardFrom:null, pending:null };
    const room=rooms[roomCode];
    if(room.started){ socket.emit('errorMessage','Game already started. Please join after reset/new round.'); return; }
    if(room.players.length >= room.maxPlayers){ socket.emit('errorMessage','Room is full.'); return; }
    socket.join(roomCode); socket.data.roomCode=roomCode;
    room.players.push(emptyPlayer(name||`Player ${room.players.length+1}`, socket.id));
    while(room.scores.length<room.maxPlayers) room.scores.push(0);
    socket.emit('joined',{ playerIndex:room.players.length-1, roomCode });
    sendState(room);
  });
  socket.on('startGame', ()=>{ const room=roomOf(socket); if(!room) return; if(room.players.length<2){socket.emit('errorMessage','Need at least 2 players.'); return;} room.maxPlayers=room.players.length; room.scores=room.scores.slice(0,room.maxPlayers); deal(room); sendState(room); notifySelfActions(room,0); });
  socket.on('discard', ({tileId})=>{ const room=roomOf(socket); if(!room||room.gameOver||room.pending) return; const idx=playerIndex(room,socket); if(idx!==room.currentTurn||!room.mustDiscard) return; const p=room.players[idx]; const i=p.hand.findIndex(t=>t.id===tileId); if(i<0) return; const [tile]=p.hand.splice(i,1); p.newTileId=null; room.discards.push({tile, from:idx}); room.lastDiscard=tile; room.lastDiscardFrom=idx; room.mustDiscard=false; checkReactions(room); });
  socket.on('action', ({action, combo})=>{ const room=roomOf(socket); if(!room) return; const idx=playerIndex(room,socket); resolveAction(room,idx,action,combo); });
  socket.on('endGameManual', ()=>{ const room=roomOf(socket); if(!room) return; room.gameOver=true; io.to(room.code).emit('gameOver',{ manual:true, scores:room.scores, changes:Array(room.maxPlayers).fill(0), players:room.players.map(p=>p.name) }); sendState(room); });
  socket.on('newRound', ()=>{ const room=roomOf(socket); if(!room) return; deal(room); sendState(room); notifySelfActions(room,0); });
  socket.on('resetRoom', ()=>{ const room=roomOf(socket); if(!room) return; resetRoom(room); sendState(room); });
  socket.on('disconnect', ()=>{ const room=roomOf(socket); if(!room) return; const idx=playerIndex(room,socket); if(idx>=0) room.players[idx].connected=false; sendState(room); });
});
server.listen(PORT, ()=>console.log(`Server running on http://localhost:${PORT}`));
