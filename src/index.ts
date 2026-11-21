import { DurableObject } from 'cloudflare:workers';
import { handleMatchmakingApi } from './matchmaking-api.js';
import { ensureFriendProfile, handleSocialApi } from './social-api.js';

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  NIGHTPLAY_ROOM: DurableObjectNamespace<NightplayRoom>;
  NIGHTPLAY_TURN_URLS?: string;
  NIGHTPLAY_TURN_SHARED_SECRET?: string;
  NIGHTPLAY_TURN_TTL_SECONDS?: string;
}

type Role = 'controller' | 'receiver';
type Meta = {
  memberId: string; room: string; nickname: string; role: Role;
  bucket: number; bucketAt: number; lastTypingAt: number; watcher?: boolean;
};
type Attachment = { meta?: Meta };
type ClientMessage = Record<string, any> & { type: string };

const MAX_SEATS = 2, ONLINE_WINDOW_S = 45, SEAT_TTL_S = 300, ROOM_RETENTION_DAYS = 7, HISTORY_LIMIT = 60;
const CODE_RE = /^[A-Z0-9]{4,12}$/;
const ROLE_PREFS = new Set(['controller', 'receiver', 'any']);
const CHALLENGES = [
  '两位参与者各写一个故事线索，然后共同选出下一步。',
  '用三个词描述此刻故事的氛围，对方据此续写一句。',
  '为故事里的角色起一个新的代号，并说明原因。',
  '轮流提出一个“如果……会怎样”的假设，选一个推进剧情。',
  '各自给出一个想保留和一个想跳过的情节，互相尊重选择。',
  '设定一个双方都同意的暗号，任何一方说出即暂停。',
];
const SCENES = [
  '灯光渐暗，一封没有署名的信被推到门下。', '雨声停了，远处传来第二声敲门。',
  '地图上多出一个此前从未标注的地点。', '旧唱片机自己转了起来，播放着一首熟悉的曲子。',
  '窗外的霓虹拼出一个只有你们能看懂的词。',
];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const now = () => Date.now();
const uuid = () => crypto.randomUUID();
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const id = env.NIGHTPLAY_ROOM.idFromName('nightplay-global-room-hub-v1');
      return env.NIGHTPLAY_ROOM.get(id).fetch(request);
    }
    if (url.pathname.startsWith('/api/')) {
      const id = env.NIGHTPLAY_ROOM.idFromName('nightplay-global-room-hub-v1');
      return env.NIGHTPLAY_ROOM.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

export class NightplayRoom extends DurableObject<Env> {
  private chain: Promise<unknown> = Promise.resolve();
  private alarmInitialized = false;
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn, fn);
    this.chain = result.catch(() => undefined);
    return result;
  }
  private sockets() { return this.ctx.getWebSockets(); }
  private attachment(ws: WebSocket): Attachment { return (ws.deserializeAttachment() as Attachment | null) ?? {}; }
  private save(ws: WebSocket, a: Attachment) { ws.serializeAttachment(a); }
  private meta(ws: WebSocket) { return this.attachment(ws).meta; }
  private send(ws: WebSocket, data: unknown) { try { ws.send(JSON.stringify(data)); } catch {} }
  private broadcast(room: string, data: unknown, except?: WebSocket) {
    for (const ws of this.sockets()) if (ws !== except && this.meta(ws)?.room === room) this.send(ws, data);
  }
  private async presence(room: string) {
    const rows = await this.env.DB.prepare('SELECT id,nickname,role,last_seen_at FROM room_members WHERE room_code=? AND left_at IS NULL ORDER BY joined_at').bind(room).all<any>();
    const connected = new Set(this.sockets().map(ws => this.meta(ws)?.memberId).filter(Boolean));
    return rows.results.map((r: any) => ({ id:r.id, nickname:r.nickname, role:r.role, online:connected.has(r.id) || Number(r.last_seen_at) > now() - ONLINE_WINDOW_S*1000 }));
  }
  private async watcherCount(room: string) { return this.sockets().filter(ws => { const m=this.meta(ws); return m?.room===room && m.watcher===true; }).length; }
  private async pushPresence(room: string) { this.broadcast(room, { type:'presence', members:await this.presence(room), seats:MAX_SEATS, watchers:await this.watcherCount(room) }); }
  private async closeWatchers(room: string, message = '房间已关闭观战，旁观连接已结束。') {
    for (const peer of this.sockets()) { const m=this.meta(peer); if(m?.room===room && m.watcher){this.send(peer,{type:'watch_closed',message});this.detach(peer);} }
    this.broadcast(room,{type:'watch_count',count:0});
  }
  private async setWatchConsent(ws: WebSocket, m: Meta, open: boolean) {
    const active=await this.env.DB.prepare('SELECT id FROM room_members WHERE room_code=? AND left_at IS NULL AND last_seen_at>? ORDER BY joined_at').bind(m.room,now()-ONLINE_WINDOW_S*1000).all<any>();
    if(active.results.length!==2 || !active.results.some((x:any)=>x.id===m.memberId)) return this.send(ws,{type:'error',code:'watch_unavailable',message:'需要两位参与者都在房间内才能开启观战。'});
    const key='watch-consent:'+m.room, current=await this.ctx.storage.get<string[]>(key)??[];
    const next=open?[...new Set([...current,m.memberId])]:current.filter(id=>id!==m.memberId);
    await this.ctx.storage.put(key,next);
    const allowed=active.results.every((x:any)=>next.includes(x.id));
    const consented=next.filter(id=>active.results.some((x:any)=>x.id===id)).length;
    for(const peer of this.sockets()){const peerMeta=this.meta(peer);if(peerMeta?.room===m.room&&!peerMeta.watcher)this.send(peer,{type:'watch_state',allowed,consented,optedIn:next.includes(peerMeta.memberId)});}
    if(!allowed) await this.closeWatchers(m.room);
  }
  private async watchJoin(ws: WebSocket, msg: ClientMessage) {
    const existing=this.meta(ws);
    if(existing&&!existing.watcher)return this.send(ws,{type:'error',code:'watch_self',message:'请先退出当前参与者房间，再使用旁观功能。'});
    const room=String(msg.room??'').trim().toUpperCase(), nickname=String(msg.nickname??'').trim().replace(/\s+/g,' ').slice(0,24);
    const guestId=typeof msg.guestId==='string'&&/^[0-9a-f-]{36}$/i.test(msg.guestId)?msg.guestId:null;
    if(!CODE_RE.test(room)||!nickname) return this.send(ws,{type:'error',code:'bad_watch_request',message:'请检查房间代码和昵称。'});
    const roomRecord=await this.env.DB.prepare('SELECT expires_at FROM rooms WHERE code=?').bind(room).first<any>();
    if(!roomRecord||Number(roomRecord.expires_at)<=now())return this.send(ws,{type:'error',code:'room_expired',message:'该房间已不存在或已超过有效期。'});
    const active=await this.env.DB.prepare('SELECT id,nickname,role,guest_id FROM room_members WHERE room_code=? AND left_at IS NULL AND last_seen_at>? ORDER BY joined_at').bind(room,now()-ONLINE_WINDOW_S*1000).all<any>();
    const consents=await this.ctx.storage.get<string[]>('watch-consent:'+room)??[];
    if(active.results.length!==2||!active.results.every((x:any)=>consents.includes(x.id))) return this.send(ws,{type:'error',code:'watch_not_open',message:'双方尚未同时允许观战，暂时无法进入。'});
    if(guestId&&active.results.some((x:any)=>x.guest_id===guestId)) return this.send(ws,{type:'error',code:'watch_self',message:'正在参与对局的设备不能同时旁观。'});
    if(await this.watcherCount(room)>=12) return this.send(ws,{type:'error',code:'watch_full',message:'旁观人数已满，请稍后再试。'});
    const t=now(),id=uuid(),a=this.attachment(ws);
    a.meta={memberId:'watch-'+id,room,nickname,role:'receiver',bucket:8,bucketAt:t,lastTypingAt:0,watcher:true};this.save(ws,a);
    this.send(ws,{type:'watch_joined',room,watcherId:id,you:{nickname},members:await this.presence(room),seats:MAX_SEATS,watchers:await this.watcherCount(room)});
    const metro=await this.metro(room);if(metro)this.send(ws,{type:'metronome_state',...metro});
    this.broadcast(room,{type:'watch_count',count:await this.watcherCount(room)});
  }
  private async history(room: string, lastId = 0) {
    const rows = lastId > 0
      ? await this.env.DB.prepare('SELECT * FROM messages WHERE room_code=? AND id>? ORDER BY id LIMIT 200').bind(room,lastId).all<any>()
      : await this.env.DB.prepare('SELECT * FROM (SELECT * FROM messages WHERE room_code=? ORDER BY id DESC LIMIT ?) ORDER BY id').bind(room,HISTORY_LIMIT).all<any>();
    return rows.results.map((r: any) => ({ id:r.id, kind:r.kind, nickname:r.nickname, memberId:r.member_id, body:r.body, createdAt:r.created_at }));
  }
  private async saveGameHistory(room: string, memberId: string, endedAt = now()) {
    const member = await this.env.DB.prepare('SELECT guest_id,nickname,role,joined_at FROM room_members WHERE id=? AND room_code=?').bind(memberId,room).first<any>();
    if (!member?.guest_id) return;
    const opponent = await this.env.DB.prepare('SELECT guest_id,nickname FROM room_members WHERE room_code=? AND id<>? AND guest_id IS NOT NULL ORDER BY joined_at DESC LIMIT 1').bind(room,memberId).first<any>();
    const startedAt = Number(member.joined_at) || endedAt;
    await this.env.DB.prepare('INSERT OR IGNORE INTO game_history(guest_id,room_code,member_id,nickname,role,started_at,ended_at,duration_seconds,opponent_guest_id,opponent_nickname) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .bind(member.guest_id,room,memberId,member.nickname,member.role,startedAt,endedAt,Math.max(0,Math.floor((endedAt-startedAt)/1000)),opponent?.guest_id??null,opponent?.nickname??'').run();
  }
  private async addMessage(room: string, kind: string, body: string, member?: {id:string;nickname:string}) {
    const stamp = now();
    const result = await this.env.DB.prepare('INSERT INTO messages(room_code,member_id,nickname,kind,body,created_at) VALUES(?,?,?,?,?,?)').bind(room,member?.id ?? null,member?.nickname ?? '',kind,body,stamp).run();
    await this.env.DB.prepare('UPDATE rooms SET last_active_at=? WHERE code=?').bind(stamp,room).run();
    const message = { id:Number(result.meta.last_row_id), kind, nickname:member?.nickname ?? '', memberId:member?.id ?? null, body, createdAt:stamp };
    this.broadcast(room,{type:'message',message}); return message;
  }
  private detach(ws: WebSocket) { const a=this.attachment(ws); delete a.meta; this.save(ws,a); }
  private rateLimited(ws: WebSocket, m: Meta) {
    const t=now(); m.bucket=Math.min(8,m.bucket+((t-m.bucketAt)/1000)*0.8); m.bucketAt=t;
    const limited=m.bucket<1; if(!limited)m.bucket-=1;
    const a=this.attachment(ws); a.meta=m; this.save(ws,a); return limited;
  }
  private async touch(m: Meta) {
    const r=await this.env.DB.prepare('UPDATE room_members SET last_seen_at=? WHERE id=? AND left_at IS NULL').bind(now(),m.memberId).run();
    return r.meta.changes>0;
  }
  private seatLost(ws: WebSocket) { this.send(ws,{type:'error',code:'seat_lost',message:'你的座位已失效，请重新加入房间。'}); this.detach(ws); }
  private async metro(room: string) { return await this.ctx.storage.get<any>('metro:'+room); }
  private async setMetro(room: string, state: any) { await this.ctx.storage.put('metro:'+room,state); await this.scheduleNextAlarm(); }
  private async scheduleNextAlarm() {
    const expiry=await this.env.DB.prepare('SELECT MIN(expires_at) AS at FROM rooms WHERE expires_at>0').first<any>();
    let nextAt=Number(expiry?.at)||0;
    const entries=await this.ctx.storage.list<any>({prefix:'metro:'});
    for(const [,state] of entries)if(state?.running&&Number(state.endsAt)>0&&(!nextAt||Number(state.endsAt)<nextAt))nextAt=Number(state.endsAt);
    if(nextAt>0)await this.ctx.storage.setAlarm(Math.max(now()+1000,nextAt));
    else await this.ctx.storage.deleteAlarm();
  }
  private async ensureAlarmScheduled() {
    if(this.alarmInitialized)return;
    this.alarmInitialized=true;
    try { await this.scheduleNextAlarm(); }
    catch(error) { this.alarmInitialized=false; throw error; }
  }
  private async joinMatchedRoom(ws:WebSocket,msg:ClientMessage) {
    const clientId=typeof msg.matchClientId==='string'&&/^[0-9a-f-]{36}$/i.test(msg.matchClientId)?msg.matchClientId:'';
    const room=String(msg.room??'').trim().toUpperCase();
    if(!clientId||!CODE_RE.test(room))
      return this.send(ws,{type:'error',code:'match_invalid',message:'匹配信息无效，请重新开始匹配。'});
    const row=await this.env.DB.prepare("SELECT nickname,room_code,matched_role FROM matchmaking_queue WHERE client_id=? AND status='matched'").bind(clientId).first<any>();
    if(!row||row.room_code!==room||(row.matched_role!=='controller'&&row.matched_role!=='receiver'))
      return this.send(ws,{type:'error',code:'match_invalid',message:'匹配记录已失效，请重新开始匹配。'});
    const seat=await this.env.DB.prepare('SELECT id FROM room_members WHERE room_code=? AND role=? AND left_at IS NULL ORDER BY joined_at LIMIT 1').bind(room,row.matched_role).first<any>();
    return this.join(ws,{type:'join',room,nickname:row.nickname,role:row.matched_role,token:seat?.id||clientId,guestId:msg.guestId,lastId:msg.lastId});
  }

  private async join(ws:WebSocket,msg:ClientMessage) {
    const room=String(msg.room??'').trim().toUpperCase(),nickname=String(msg.nickname??'').trim().replace(/\s+/g,' ').slice(0,24);
    const token=typeof msg.token==='string'&&/^[0-9a-f-]{36}$/i.test(msg.token)?msg.token:null,requestedRole=String(msg.role??'any'),guestId=typeof msg.guestId==='string'&&/^[0-9a-f-]{36}$/i.test(msg.guestId)?msg.guestId:null;
    const publishRequested=msg.publish===true,roomName=String(msg.roomName??'').trim().replace(/\s+/g,' ').slice(0,20);
    const requestedLifetime=Number(msg.roomLifetimeMinutes),roomLifetime=Number.isFinite(requestedLifetime)?Math.max(5,Math.min(120,Math.round(requestedLifetime))):30;
    if(publishRequested&&!roomName)return this.send(ws,{type:'error',code:'bad_room_name',message:'请填写 1–20 个字的房间名称。'});
    if(!ROLE_PREFS.has(requestedRole))return this.send(ws,{type:'error',code:'bad_role',message:'请选择有效的挑战角色。'});
    if(!CODE_RE.test(room))return this.send(ws,{type:'error',code:'bad_room',message:'房间代码需为 4–12 位字母或数字。'});
    if(!nickname)return this.send(ws,{type:'error',code:'bad_nickname',message:'请先填写昵称。'});
    const t=now();
    const roomInsert=await this.env.DB.prepare('INSERT OR IGNORE INTO rooms(code,created_at,last_active_at,expires_at) VALUES(?,?,?,?)').bind(room,t,t,t+roomLifetime*60000).run();
    const roomCreated=Number(roomInsert.meta.changes)>0;
    if(publishRequested&&!roomCreated)return this.send(ws,{type:'error',code:'publish_room_exists',message:'房间代码已被占用，请重新生成后发布。'});
    const roomRecord=await this.env.DB.prepare('SELECT expires_at FROM rooms WHERE code=?').bind(room).first<any>();
    if(!roomRecord||Number(roomRecord.expires_at)<=t)return this.send(ws,{type:'error',code:'room_expired',message:'该房间已超过有效期，请重新创建房间。'});
    if(roomCreated)await this.scheduleNextAlarm();
    await this.env.DB.prepare('UPDATE room_members SET left_at=? WHERE room_code=? AND left_at IS NULL AND last_seen_at<?').bind(t,room,t-SEAT_TTL_S*1000).run();
    let member:any=null,isNew=true;
    if(token){member=await this.env.DB.prepare('SELECT * FROM room_members WHERE id=? AND room_code=? AND left_at IS NULL').bind(token,room).first<any>();if(member){await this.env.DB.prepare('UPDATE room_members SET last_seen_at=?,nickname=?,guest_id=COALESCE(?,guest_id) WHERE id=?').bind(t,nickname,guestId,token).run();member.nickname=nickname;member.last_seen_at=t;isNew=false;}}
    if(!member){
      const active=await this.env.DB.prepare('SELECT * FROM room_members WHERE room_code=? AND left_at IS NULL ORDER BY joined_at').bind(room).all<any>();
      if(active.results.length>=MAX_SEATS)return this.send(ws,{type:'error',code:'room_full',message:'该房间已有两位参与者，请换一个房间代码。'});
      const first=active.results[0];let assignedRole:Role;
      if(!first)assignedRole=requestedRole==='receiver'?'receiver':'controller';
      else{const wanted:Role=requestedRole==='any'?(first.role==='controller'?'receiver':'controller'):requestedRole as Role;if(wanted===first.role)return this.send(ws,{type:'error',code:'role_conflict',message:`该房间已有${first.role==='controller'?'控制方':'受控方'}，请选择另一角色或让对方更改选择。`});assignedRole=wanted;}
      let id=token??uuid();if(token){const prior=await this.env.DB.prepare('SELECT id FROM room_members WHERE id=? AND room_code=?').bind(token,room).first<any>();if(prior)id=uuid();}await this.env.DB.prepare('INSERT INTO room_members(id,room_code,nickname,role,joined_at,last_seen_at,guest_id) VALUES(?,?,?,?,?,?,?)').bind(id,room,nickname,assignedRole,t,t,guestId).run();
      member={id,room_code:room,nickname,role:assignedRole,joined_at:t,last_seen_at:t};
    }
    if(guestId){try{await ensureFriendProfile(this.env.DB,guestId,nickname)}catch(e){console.error('friend profile init failed',e)}}
    if(publishRequested)await this.env.DB.prepare('UPDATE rooms SET room_name=?,is_public=1,owner_member_id=? WHERE code=?').bind(roomName,member.id,room).run();
    await this.env.DB.prepare('UPDATE rooms SET last_active_at=? WHERE code=?').bind(t,room).run();
    const a=this.attachment(ws);a.meta={memberId:member.id,room,nickname:member.nickname,role:member.role,bucket:8,bucketAt:t,lastTypingAt:0};this.save(ws,a);
    const lastId=Number(msg.lastId)||0;
    const activeIds=(await this.env.DB.prepare('SELECT id FROM room_members WHERE room_code=? AND left_at IS NULL').bind(room).all<any>()).results.map((x:any)=>x.id);
    if(activeIds.length>=MAX_SEATS)await this.env.DB.prepare('UPDATE rooms SET is_public=0 WHERE code=?').bind(room).run();
    const roomInfo=await this.env.DB.prepare('SELECT room_name,is_public,expires_at FROM rooms WHERE code=?').bind(room).first<any>();
    const watchConsents=await this.ctx.storage.get<string[]>('watch-consent:'+room)??[];
    const watchAllowed=activeIds.length===2&&activeIds.every((id:string)=>watchConsents.includes(id));
    const opponentInfo=await this.env.DB.prepare('SELECT rm.nickname,gp.friend_code FROM room_members rm LEFT JOIN guest_profiles gp ON gp.guest_id=rm.guest_id WHERE rm.room_code=? AND rm.id<>? AND rm.left_at IS NULL ORDER BY rm.joined_at DESC LIMIT 1').bind(room,member.id).first<any>();
    this.send(ws,{type:'joined',room,roomName:roomInfo?.room_name||'',isPublic:Boolean(roomInfo?.is_public),expiresAt:Number(roomInfo?.expires_at)||0,token:member.id,you:{id:member.id,nickname:member.nickname,role:member.role},opponentFriendCode:opponentInfo?.friend_code||'',opponentNickname:opponentInfo?.nickname||'',resumed:!isNew,history:await this.history(room,isNew?0:lastId),members:await this.presence(room),seats:MAX_SEATS,watchAllowed,watchConsent:watchConsents.includes(member.id),watchers:await this.watcherCount(room)});
    if(isNew)await this.addMessage(room,'system',`${member.nickname} 加入了房间`);
    await this.pushPresence(room);
    const metro=await this.metro(room);if(metro)this.send(ws,{type:'metronome_state',...metro});
    const joiningProfile=guestId?await this.env.DB.prepare('SELECT friend_code FROM guest_profiles WHERE guest_id=?').bind(guestId).first<any>():null;
    for(const peer of this.sockets()){const pm=this.meta(peer);if(peer!==ws&&pm?.room===room){this.send(peer,{type:'voice_peer_ready',memberId:member.id,nickname:member.nickname});this.send(peer,{type:'opponent_info',friendCode:joiningProfile?.friend_code||'',nickname:member.nickname});}}
    await this.env.DB.prepare('DELETE FROM rooms WHERE last_active_at<?').bind(t-ROOM_RETENTION_DAYS*86400000).run();
  }
  private async handle(ws:WebSocket,msg:ClientMessage) {
    if(msg.type==='watch_join')return this.watchJoin(ws,msg);
    if(msg.type==='join'&&typeof msg.matchClientId==='string')return this.joinMatchedRoom(ws,msg);
    if(msg.type==='join')return this.join(ws,msg);
    const m=this.meta(ws);
    if(msg.type==='watch_consent'){
      if(!m||m.watcher)return this.send(ws,{type:'error',code:'not_a_player',message:'只有房间参与者可以设置观战权限。'});
      return this.setWatchConsent(ws,m,msg.open===true);
    }
    if(msg.type==='ping'){
      if(!m)return this.send(ws,{type:'pong'});
      if(m.watcher)return this.send(ws,{type:'pong',members:await this.presence(m.room),seats:MAX_SEATS,watchers:await this.watcherCount(m.room)});
      if(!(await this.touch(m)))return this.seatLost(ws);
      return this.send(ws,{type:'pong',missed:await this.history(m.room,Number(msg.lastId)||0),members:await this.presence(m.room),seats:MAX_SEATS});
    }
    if(!m)return this.send(ws,{type:'error',code:'not_joined',message:'请先加入房间。'});
    if(m.watcher){
      if(msg.type==='watch_leave'){this.detach(ws);this.send(ws,{type:'watch_left'});this.broadcast(m.room,{type:'watch_count',count:await this.watcherCount(m.room)});return;}
      return this.send(ws,{type:'error',code:'watch_read_only',message:'观战模式为只读，不能发送消息或控制节拍器。'});
    }
    if(msg.type==='metronome_emergency_stop'){
      if(!(await this.touch(m)))return this.seatLost(ws);
      const previous=await this.metro(m.room)??{bpm:80,intensity:3,running:false,started:false,durationMinutes:5,holdCount:0,elapsedMs:0};
      const durationMs=(Number(previous.durationMinutes)||5)*60000;
      const remaining=previous.running&&Number(previous.endsAt)>0?Math.max(0,Number(previous.endsAt)-now()):previous.started?Math.max(0,Number(previous.remainingMs)||0):durationMs;
      const elapsedMs=previous.started?Math.max(Number(previous.elapsedMs)||0,durationMs-remaining):0;
      const state={...previous,running:false,started:true,stopped:true,endsAt:0,remainingMs:0,elapsedMs,holdCount:Math.max(0,Number(previous.holdCount)||0),nickname:m.nickname};
      await this.setMetro(m.room,state);this.broadcast(m.room,{type:'metronome_state',...state},ws);this.send(ws,{type:'metronome_state',...state});return;
    }
    if(msg.type==='metronome_state'){
      if(m.role!=='controller')return this.send(ws,{type:'error',code:'role_forbidden',message:'只有控制方可以调整节拍参数和挑战进度。受控方可使用紧急停止。'});
      if(this.rateLimited(ws,m))return this.send(ws,{type:'error',code:'rate_limited',message:'操作太快了，请稍等片刻。'});
      if(!(await this.touch(m)))return this.seatLost(ws);
      const previous=await this.metro(m.room);const started=Boolean(msg.started||msg.running||msg.stopped||previous?.started);const durationMinutes=Math.max(1,Math.min(15,Math.round(Number(msg.durationMinutes)||previous?.durationMinutes||5)));const rawEndsAt=msg.endsAt===undefined?previous?.endsAt:msg.endsAt;const rawRemaining=msg.remainingMs===undefined?previous?.remainingMs:msg.remainingMs;const endsAt=Math.max(0,Math.min(now()+900000,Number(rawEndsAt)||0));const remainingMs=Math.max(0,Math.min(900000,Number(rawRemaining)||0));const state={bpm:Math.max(40,Math.min(220,Math.round(Number(msg.bpm)||80))),intensity:Math.max(1,Math.min(5,Math.round(Number(msg.intensity)||3))),running:msg.stopped?false:Boolean(msg.running),started,stopped:Boolean(msg.stopped),mode:msg.mode==='random'?'random':msg.mode==='steady'?'steady':(previous?.mode||'steady'),difficulty:['easy','normal','hard'].includes(msg.difficulty)?msg.difficulty:(previous?.difficulty||'normal'),durationMinutes,endsAt,remainingMs,holdCount:Math.max(0,Math.min(1000,Math.floor(Number(msg.holdCount??previous?.holdCount)||0))),elapsedMs:Math.max(0,Math.min(900000,Number(msg.elapsedMs??previous?.elapsedMs)||0)),endReason:String(msg.endReason??previous?.endReason??'').slice(0,120),nickname:m.nickname};await this.setMetro(m.room,state);this.broadcast(m.room,{type:'metronome_state',...state},ws);return;
    }
    if(msg.type==='chat'){
      const text=String(msg.text??'').trim().slice(0,500);if(!text)return;
      if(this.rateLimited(ws,m))return this.send(ws,{type:'error',code:'rate_limited',message:'发送太快了，请稍等片刻。'});
      if(!(await this.touch(m)))return this.seatLost(ws);
      return this.addMessage(m.room,'chat',text,{id:m.memberId,nickname:m.nickname});
    }
    if(msg.type==='action'){
      const actions:Record<string,(n:string)=>string>={next_scene:n=>`${n} 推进到下一幕：${pick(SCENES)}`,challenge:n=>`${n} 发起随机挑战：${pick(CHALLENGES)}`,pause:n=>`${n} 请求暂停。双方确认前请不要继续推进。`,resume:n=>`${n} 表示可以继续。`,stop:n=>`${n} 结束了本轮互动。`};
      const make=actions[msg.action];if(!make)return;if(this.rateLimited(ws,m))return this.send(ws,{type:'error',code:'rate_limited',message:'操作太快了，请稍等片刻。'});if(!(await this.touch(m)))return this.seatLost(ws);
      await this.addMessage(m.room,'action',make(m.nickname),{id:m.memberId,nickname:m.nickname});
      if(msg.action==='stop'){
        await this.ctx.storage.delete('metro:'+m.room);const ending=now();const active=await this.env.DB.prepare('SELECT id FROM room_members WHERE room_code=? AND left_at IS NULL').bind(m.room).all<any>();for(const member of active.results)await this.saveGameHistory(m.room,member.id,ending);await this.env.DB.prepare('UPDATE room_members SET left_at=? WHERE room_code=? AND left_at IS NULL').bind(ending,m.room).run();
        for(const peer of this.sockets())if(this.meta(peer)?.room===m.room){this.send(peer,{type:'room_ended',message:'本轮互动已结束，房间已自动关闭。'});this.detach(peer);}
      }return;
    }
    if(msg.type==='voice_signal'){
      const peer=this.sockets().find(p=>p!==ws&&this.meta(p)?.room===m.room&&this.meta(p)?.memberId!==m.memberId);
      if(!peer)return this.send(ws,{type:'voice_notice',message:'另一位参与者尚未在线，进入房间后即可接通语音。'});
      if(msg.kind==='description'){
        const d=msg.description;if(!d||!['offer','answer'].includes(d.type)||typeof d.sdp!=='string'||d.sdp.length>24000)return this.send(ws,{type:'error',code:'bad_voice_signal',message:'语音连接信息无效，请重试。'});
        return this.send(peer,{type:'voice_signal',kind:'description',from:m.memberId,nickname:m.nickname,description:{type:d.type,sdp:d.sdp}});
      }
      if(msg.kind==='candidate'){
        const c=msg.candidate;if(!c||typeof c.candidate!=='string'||c.candidate.length>4096)return;
        return this.send(peer,{type:'voice_signal',kind:'candidate',from:m.memberId,candidate:{candidate:c.candidate,sdpMid:typeof c.sdpMid==='string'?c.sdpMid.slice(0,128):null,sdpMLineIndex:Number.isInteger(c.sdpMLineIndex)?c.sdpMLineIndex:null,usernameFragment:typeof c.usernameFragment==='string'?c.usernameFragment.slice(0,256):undefined}});
      }
      if(msg.kind==='hangup')return this.send(peer,{type:'voice_signal',kind:'hangup',from:m.memberId,nickname:m.nickname});
    }
    if(msg.type==='typing'){
      const a=this.attachment(ws),current=a.meta!;const t=now();if(t-current.lastTypingAt<1500)return;current.lastTypingAt=t;this.save(ws,a);return this.broadcast(m.room,{type:'typing',memberId:m.memberId,nickname:m.nickname},ws);
    }
    if(msg.type==='leave'){
      const {room,memberId,nickname}=m;await this.saveGameHistory(room,memberId);const metro=await this.metro(room);if(metro?.running){const state={...metro,running:false,stopped:true,nickname};await this.setMetro(room,state);this.broadcast(room,{type:'metronome_state',...state},ws);}
      this.detach(ws);const r=await this.env.DB.prepare('UPDATE room_members SET left_at=? WHERE id=? AND left_at IS NULL').bind(now(),memberId).run();
      const consentKey='watch-consent:'+room,consents=await this.ctx.storage.get<string[]>(consentKey)??[];await this.ctx.storage.put(consentKey,consents.filter(id=>id!==memberId));
      await this.env.DB.prepare('UPDATE rooms SET is_public=0 WHERE code=? AND owner_member_id=?').bind(room,memberId).run();
      await this.closeWatchers(room);this.send(ws,{type:'left'});if(r.meta.changes)await this.addMessage(room,'system',`${nickname} 离开了房间`);return this.pushPresence(room);
    }
  }
  async alarm() {
    await this.queue(async()=>{
      const t=now();
      const metroEntries=await this.ctx.storage.list<any>({prefix:'metro:'});
      for(const [key,state] of metroEntries){
        if(state?.running&&Number(state.endsAt)>0&&Number(state.endsAt)<=t){
          const durationMs=Math.max(60000,Math.min(900000,(Number(state.durationMinutes)||5)*60000));
          const ended={...state,running:false,stopped:true,endsAt:0,remainingMs:0,elapsedMs:Math.max(Number(state.elapsedMs)||0,durationMs),endReason:'挑战时间已到，本轮自动结束。',nickname:'系统'};
          await this.ctx.storage.put(key,ended);
          const room=String(key).slice('metro:'.length);
          this.broadcast(room,{type:'metronome_state',...ended});
        }
      }
      const expired=await this.env.DB.prepare('SELECT code FROM rooms WHERE expires_at>0 AND expires_at<=?').bind(t).all<any>();
      for(const row of expired.results){
        const room=String(row.code);
        const active=await this.env.DB.prepare('SELECT id FROM room_members WHERE room_code=? AND left_at IS NULL').bind(room).all<any>();
        for(const member of active.results)await this.saveGameHistory(room,member.id,t);
        await this.env.DB.prepare('UPDATE room_members SET left_at=? WHERE room_code=? AND left_at IS NULL').bind(t,room).run();
        await this.env.DB.prepare('UPDATE rooms SET is_public=0,expires_at=0 WHERE code=?').bind(room).run();
        await this.closeWatchers(room,'房间有效期已到，观战连接已结束。');
        for(const peer of this.sockets()){
          const meta=this.meta(peer);
          if(meta?.room===room){this.send(peer,{type:'room_ended',message:'房间有效期已到，房间已自动关闭。'});this.detach(peer);}
        }
        await this.ctx.storage.delete('metro:'+room);
        await this.ctx.storage.delete('watch-consent:'+room);
      }
      await this.scheduleNextAlarm();
    });
  }
  async fetch(request:Request):Promise<Response> {
    // Room-expiry alarm setup must never block matchmaking, polling, or cancellation.
    this.ctx.waitUntil(this.ensureAlarmScheduled().catch(()=>{ this.alarmInitialized=false; }));
    const url=new URL(request.url);
    if(url.pathname==='/ws'&&request.headers.get('Upgrade')?.toLowerCase()==='websocket'){
      const pair=new WebSocketPair(),client=pair[0],server=pair[1];this.ctx.acceptWebSocket(server);this.save(server,{});
      return new Response(null,{status:101,webSocket:client});
    }
    if(request.method==='POST'&&url.pathname==='/api/matchmaking')return handleMatchmakingApi(request,this.env.DB,()=>this.ctx.waitUntil(this.scheduleNextAlarm().catch(()=>{})));
    const socialResponse=await handleSocialApi(request,this.env.DB);if(socialResponse)return socialResponse;
    if(request.method==='GET'&&url.pathname==='/api/public-rooms'){
      const cutoff=now()-ONLINE_WINDOW_S*1000;
      const result=await this.env.DB.prepare("SELECT r.code,r.room_name,r.created_at,m.nickname AS host_nickname,m.role AS host_role FROM rooms r JOIN room_members m ON m.id=r.owner_member_id AND m.room_code=r.code WHERE r.is_public=1 AND r.expires_at>? AND m.left_at IS NULL AND m.last_seen_at>? AND r.last_active_at>? AND (SELECT COUNT(*) FROM room_members p WHERE p.room_code=r.code AND p.left_at IS NULL AND p.last_seen_at>?)<2 ORDER BY r.created_at DESC LIMIT 50").bind(now(),cutoff,now()-ROOM_RETENTION_DAYS*86400000,cutoff).all<any>();
      return json({rooms:result.results.map((r:any)=>({room:r.code,name:r.room_name,hostNickname:r.host_nickname,hostRole:r.host_role,createdAt:r.created_at,seats:1}))});
    }
    const roomMatch=url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4,12})$/);
    if(request.method==='GET'&&roomMatch){const room=roomMatch[1].toUpperCase(),record=await this.env.DB.prepare('SELECT expires_at FROM rooms WHERE code=?').bind(room).first<any>();if(!record||Number(record.expires_at)<=now())return json({error:'room_expired'},410);const members=await this.presence(room);return json({room,seats:MAX_SEATS,taken:members.length,full:members.length>=MAX_SEATS,expiresAt:Number(record.expires_at)||0});}
    if(request.method==='POST'&&url.pathname==='/api/online/heartbeat'){
      let body:any;try{body=await request.json()}catch{return json({error:'bad_json'},400)}
      const visitorId=String(body?.visitorId??'');
      if(!/^[0-9a-f-]{36}$/i.test(visitorId))return json({error:'bad_visitor_id'},400);
      const timestamp=now(),key='site-online:'+visitorId;
      await this.ctx.storage.put(key,timestamp);
      const entries=await this.ctx.storage.list<number>({prefix:'site-online:'});
      let count=0;const expired:string[]=[];
      for(const [entryKey,lastSeen] of entries){
        if(Number(lastSeen)>timestamp-60000)count++;
        else expired.push(entryKey);
      }
      if(expired.length)await this.ctx.storage.delete(expired);
      return json({online:count,updatedAt:timestamp});
    }
    if(request.method==='GET'&&url.pathname==='/api/watchable'){
      const recent=await this.env.DB.prepare('SELECT code FROM rooms WHERE expires_at>? AND last_active_at>? ORDER BY last_active_at DESC LIMIT 60').bind(now(),now()-ROOM_RETENTION_DAYS*86400000).all<any>();
      const rooms:any[]=[];
      for(const item of recent.results){
        const members=await this.env.DB.prepare('SELECT id,nickname,role,last_seen_at FROM room_members WHERE room_code=? AND left_at IS NULL AND last_seen_at>? ORDER BY joined_at').bind(item.code,now()-ONLINE_WINDOW_S*1000).all<any>();
        if(members.results.length!==2)continue;
        const consents=await this.ctx.storage.get<string[]>('watch-consent:'+item.code)??[];
        if(!members.results.every((member:any)=>consents.includes(member.id)))continue;
        rooms.push({room:item.code,players:members.results.map((member:any)=>({nickname:member.nickname,role:member.role})),watchers:await this.watcherCount(item.code)});
      }
      return json({rooms});
    }
    if(request.method==='GET'&&url.pathname==='/api/rtc-config'){
      const room=String(url.searchParams.get('room')??'').trim().toUpperCase(),member=String(request.headers.get('authorization')??'').replace(/^Bearer\s+/i,'').trim();
      if(!CODE_RE.test(room)||!/^[0-9a-f-]{36}$/i.test(member))return json({error:'bad_request'},400);
      const found=await this.env.DB.prepare('SELECT id FROM room_members WHERE id=? AND room_code=? AND left_at IS NULL').bind(member,room).first();if(!found)return json({error:'not_a_room_member'},403);
      const iceServers:any[]=[{urls:'stun:stun.l.google.com:19302'}];const urls=String(this.env.NIGHTPLAY_TURN_URLS??'').split(',').map(s=>s.trim()).filter(Boolean),secret=this.env.NIGHTPLAY_TURN_SHARED_SECRET??'';let turnEnabled=false,expiresAt:number|null=null;
      if(urls.length&&secret){const requested=Number(this.env.NIGHTPLAY_TURN_TTL_SECONDS??3600),ttl=Math.min(86400,Math.max(300,Number.isFinite(requested)?requested:3600));expiresAt=Math.floor(now()/1000)+ttl;const username=`${expiresAt}:${member}`;const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-1'},false,['sign']);const sig=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(username));const credential=btoa(String.fromCharCode(...new Uint8Array(sig)));iceServers.push({urls,username,credential});turnEnabled=true;}
      return json({iceServers,turnEnabled,expiresAt});
    }
    if(url.pathname==='/api/health')return json({ok:true,platform:'cloudflare'});
    return json({error:'not_found'},404);
  }
  async webSocketMessage(ws:WebSocket,message:string|ArrayBuffer) {
    let msg:ClientMessage;
    try { msg=JSON.parse(typeof message==='string'?message:new TextDecoder().decode(message)); }
    catch { return this.send(ws,{type:'error',code:'bad_json',message:'无法解析的消息。'}); }
    if(!msg||typeof msg.type!=='string')return;
    try { await this.handle(ws,msg); }
    catch(e) { console.error('ws handler error',e);this.send(ws,{type:'error',code:'server_error',message:'服务器暂时出错，请稍后重试。'}); }
  }
  async webSocketClose(ws:WebSocket) {
    await this.queue(async()=>{
      const m=this.meta(ws);if(!m)return;this.detach(ws);
      if(m.watcher){this.broadcast(m.room,{type:'watch_count',count:await this.watcherCount(m.room)});return;}
      await this.closeWatchers(m.room,'参与者离线，观战已自动关闭。');
      const consentKey='watch-consent:'+m.room,consents=await this.ctx.storage.get<string[]>(consentKey)??[];await this.ctx.storage.put(consentKey,consents.filter(id=>id!==m.memberId));
      const metro=await this.metro(m.room);if(metro?.running){const state={...metro,running:false,stopped:true,nickname:m.nickname};await this.setMetro(m.room,state);this.broadcast(m.room,{type:'metronome_state',...state});}
      await this.env.DB.prepare('UPDATE room_members SET last_seen_at=? WHERE id=? AND left_at IS NULL').bind(now()-(ONLINE_WINDOW_S+1)*1000,m.memberId).run();await this.pushPresence(m.room);
    });
  }
  async webSocketError(ws:WebSocket) {
    await this.queue(async()=>{
      const m=this.meta(ws);if(!m)return;this.detach(ws);
      if(m.watcher){this.broadcast(m.room,{type:'watch_count',count:await this.watcherCount(m.room)});return;}
      await this.closeWatchers(m.room,'参与者连接异常，观战已自动关闭。');
      const key='watch-consent:'+m.room,consents=await this.ctx.storage.get<string[]>(key)??[];await this.ctx.storage.put(key,consents.filter(id=>id!==m.memberId));
    });
  }
}
