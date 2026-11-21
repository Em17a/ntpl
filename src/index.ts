import { DurableObject } from 'cloudflare:workers';

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
  bucket: number; bucketAt: number; lastTypingAt: number;
  contactViolations: number; recentChatText: string; recentChatAt: number; contactMutedUntil: number;
};
type Attachment = { meta?: Meta; matchmakingClientId?: string };
type ClientMessage = Record<string, any> & { type: string };

const MAX_SEATS = 2, ONLINE_WINDOW_S = 45, SEAT_TTL_S = 300, ROOM_RETENTION_DAYS = 7, HISTORY_LIMIT = 60;
const CODE_RE = /^[A-Z0-9]{4,12}$/;
const MATCH_GENDERS = new Set(['male', 'female', 'other']);
const MATCH_PREFS = new Set(['male', 'female', 'any']);
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
const normalizeContactText = (value: string) => {
  const raw = value.toLowerCase().normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '');
  const compact = raw.replace(/[\s·•,，。:：;；_\-—()（）[\]【】]/g, '');
  return compact.replace(/[零〇洞幺两]/g, c => ({ 零:'0',〇:'0',洞:'0',幺:'1',两:'2' } as Record<string,string>)[c] ?? c)
    .replace(/[一二三四五六七八九]/g, c => ({ 一:'1',二:'2',三:'3',四:'4',五:'5',六:'6',七:'7',八:'8',九:'9' } as Record<string,string>)[c] ?? c);
};
function containsContactInfo(value: string) {
  const t = normalizeContactText(value); if (!t) return false;
  return /(?:\+?86)?1[3-9]\d{9}/.test(t) || /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(t) ||
    /(?:https?\/{1,2}|www\.)|(?:t\.me|telegram\.me|wa\.me|instagram\.com|facebook\.com|line\.me|discord\.gg|discord\.com)/i.test(t) ||
    /(?:微信|wechat|vx|wx|v信|w信|微x|薇信|威信|qq|扣扣|企鹅号|telegram|电报|飞机号|whatsapp|wats?app|line|instagram|ins号|discord|邮箱|电子邮件)(?:(?:号|id|账号|帐号)?(?:是|为)?|:|：)?[a-z0-9_@.-]{3,}/i.test(t) ||
    (/\d{6,13}/.test(t) && /(?:qq|扣扣|联系|加我|电话|手机|号码|号|vx|wx|微信|v信|w信)/i.test(t)) || /(?:加我|私我|联系我)(?:v|vx|wx)[a-z0-9_-]{3,}/i.test(t);
}

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
  private async pushPresence(room: string) { this.broadcast(room, { type:'presence', members:await this.presence(room), seats:MAX_SEATS }); }
  private async history(room: string, lastId = 0) {
    const rows = lastId > 0
      ? await this.env.DB.prepare('SELECT * FROM messages WHERE room_code=? AND id>? ORDER BY id LIMIT 200').bind(room,lastId).all<any>()
      : await this.env.DB.prepare('SELECT * FROM (SELECT * FROM messages WHERE room_code=? ORDER BY id DESC LIMIT ?) ORDER BY id').bind(room,HISTORY_LIMIT).all<any>();
    return rows.results.map((r: any) => ({ id:r.id, kind:r.kind, nickname:r.nickname, memberId:r.member_id, body:r.body, createdAt:r.created_at }));
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
  private async setMetro(room: string, state: any) { await this.ctx.storage.put('metro:'+room,state); }
  private applyContactViolation(ws: WebSocket, source: 'text'|'voice') {
    const a=this.attachment(ws),m=a.meta;if(!m)return;
    m.contactViolations=(m.contactViolations||0)+1;const count=m.contactViolations;
    const mutedForMs=count>=3?600000:count===2?60000:0;if(mutedForMs)m.contactMutedUntil=now()+mutedForMs;
    this.save(ws,a);
    this.send(ws,{type:'contact_blocked',source,count,mutedUntil:mutedForMs?now()+mutedForMs:0,message:mutedForMs?`检测到交换站外联系方式，已暂停发送${source==='voice'?'语音':'消息'}${count>=3?'10分钟':'1分钟'}。`:'检测到疑似站外联系方式，内容已拦截，请勿交换微信、QQ、手机号、邮箱或其他社交账号。'});
  }
  private compatible(a:any,b:any) {
    const genderOk=(a.preference==='any'||a.preference===b.gender)&&(b.preference==='any'||b.preference===a.gender);
    const roleOk=a.role_preference==='any'||b.role_preference==='any'||a.role_preference!==b.role_preference;
    return genderOk&&roleOk;
  }
  private async findOrCreateMatch(clientId:string) {
    const db=this.env.DB,t=now();
    await db.prepare("DELETE FROM matchmaking_queue WHERE status='waiting' AND last_seen_at<?").bind(t-45000).run();
    await db.prepare('DELETE FROM matchmaking_queue WHERE created_at<?').bind(t-86400000).run();
    const self=await db.prepare("SELECT * FROM matchmaking_queue WHERE client_id=? AND status='waiting'").bind(clientId).first<any>();
    if(!self){const existing=await db.prepare('SELECT * FROM matchmaking_queue WHERE client_id=?').bind(clientId).first<any>();return existing?.status==='matched'?{status:'matched',room:existing.room_code,role:existing.matched_role}:{status:'missing'};}
    const waiting=await db.prepare("SELECT * FROM matchmaking_queue WHERE status='waiting' AND client_id<>? ORDER BY created_at LIMIT 100").bind(clientId).all<any>();
    const partner=waiting.results.find((x:any)=>this.compatible(self,x));if(!partner)return {status:'waiting'};
    const room=crypto.randomUUID().replace(/-/g,'').slice(0,8).toUpperCase();
    let selfRole:Role,partnerRole:Role;
    if(self.role_preference==='any'&&partner.role_preference==='any'){selfRole='controller';partnerRole='receiver';}
    else if(self.role_preference==='any'){partnerRole=partner.role_preference;selfRole=partnerRole==='controller'?'receiver':'controller';}
    else if(partner.role_preference==='any'){selfRole=self.role_preference;partnerRole=selfRole==='controller'?'receiver':'controller';}
    else{selfRole=self.role_preference;partnerRole=partner.role_preference;}
    await db.batch([
      db.prepare('INSERT INTO rooms(code,created_at,last_active_at) VALUES(?,?,?)').bind(room,t,t),
      db.prepare("UPDATE matchmaking_queue SET status='matched',room_code=?,matched_role=? WHERE client_id=? AND status='waiting'").bind(room,selfRole,clientId),
      db.prepare("UPDATE matchmaking_queue SET status='matched',room_code=?,matched_role=? WHERE client_id=? AND status='waiting'").bind(room,partnerRole,partner.client_id),
    ]);
    return {status:'matched',room,role:selfRole};
  }
  private async matchmakingJoin(ws:WebSocket,msg:ClientMessage) {
    const clientId=typeof msg.clientId==='string'&&/^[0-9a-f-]{36}$/i.test(msg.clientId)?msg.clientId:'';
    const nickname=String(msg.nickname??'').trim().replace(/\s+/g,' ').slice(0,24),gender=String(msg.gender??''),preference=String(msg.preference??''),rolePreference=String(msg.rolePreference??'any');
    if(!clientId||!nickname||!MATCH_GENDERS.has(gender)||!MATCH_PREFS.has(preference)||!ROLE_PREFS.has(rolePreference))return this.send(ws,{type:'error',code:'bad_matchmaking',message:'请检查昵称和匹配偏好设置。'});
    const t=now();
    await this.env.DB.prepare("INSERT OR IGNORE INTO matchmaking_queue(client_id,nickname,gender,preference,role_preference,status,created_at,last_seen_at) VALUES(?,?,?,?,?,'waiting',?,?)").bind(clientId,nickname,gender,preference,rolePreference,t,t).run();
    await this.env.DB.prepare('UPDATE matchmaking_queue SET last_seen_at=? WHERE client_id=?').bind(t,clientId).run();
    const a=this.attachment(ws);a.matchmakingClientId=clientId;this.save(ws,a);
    const result=await this.findOrCreateMatch(clientId);
    if(result.status==='matched')this.send(ws,{type:'match_found',room:result.room,role:result.role});
    else this.send(ws,{type:'match_waiting',message:'正在寻找符合双方偏好的参与者…'});
  }
  private async pollMatchmaking(ws:WebSocket) {
    const id=this.attachment(ws).matchmakingClientId;if(!id)return;
    const r=await this.env.DB.prepare('UPDATE matchmaking_queue SET last_seen_at=? WHERE client_id=?').bind(now(),id).run();
    if(!r.meta.changes){const a=this.attachment(ws);delete a.matchmakingClientId;this.save(ws,a);this.send(ws,{type:'match_expired',message:'匹配等待已超时，请重新开始匹配。'});return;}
    const result=await this.findOrCreateMatch(id);if(result.status==='matched')this.send(ws,{type:'match_found',room:result.room,role:result.role});
  }
  private async join(ws:WebSocket,msg:ClientMessage) {
    const room=String(msg.room??'').trim().toUpperCase(),nickname=String(msg.nickname??'').trim().replace(/\s+/g,' ').slice(0,24);
    const token=typeof msg.token==='string'&&/^[0-9a-f-]{36}$/i.test(msg.token)?msg.token:null,requestedRole=String(msg.role??'any');
    if(!ROLE_PREFS.has(requestedRole))return this.send(ws,{type:'error',code:'bad_role',message:'请选择有效的挑战角色。'});
    if(!CODE_RE.test(room))return this.send(ws,{type:'error',code:'bad_room',message:'房间代码需为 4–12 位字母或数字。'});
    if(!nickname)return this.send(ws,{type:'error',code:'bad_nickname',message:'请先填写昵称。'});
    const t=now();
    await this.env.DB.prepare('INSERT OR IGNORE INTO rooms(code,created_at,last_active_at) VALUES(?,?,?)').bind(room,t,t).run();
    await this.env.DB.prepare('UPDATE room_members SET left_at=? WHERE room_code=? AND left_at IS NULL AND last_seen_at<?').bind(t,room,t-SEAT_TTL_S*1000).run();
    let member:any=null,isNew=true;
    if(token){member=await this.env.DB.prepare('SELECT * FROM room_members WHERE id=? AND room_code=? AND left_at IS NULL').bind(token,room).first<any>();if(member){await this.env.DB.prepare('UPDATE room_members SET last_seen_at=?,nickname=? WHERE id=?').bind(t,nickname,token).run();member.nickname=nickname;member.last_seen_at=t;isNew=false;}}
    if(!member){
      const active=await this.env.DB.prepare('SELECT * FROM room_members WHERE room_code=? AND left_at IS NULL ORDER BY joined_at').bind(room).all<any>();
      if(active.results.length>=MAX_SEATS)return this.send(ws,{type:'error',code:'room_full',message:'该房间已有两位参与者，请换一个房间代码。'});
      const first=active.results[0];let assignedRole:Role;
      if(!first)assignedRole=requestedRole==='receiver'?'receiver':'controller';
      else{const wanted:Role=requestedRole==='any'?(first.role==='controller'?'receiver':'controller'):requestedRole as Role;if(wanted===first.role)return this.send(ws,{type:'error',code:'role_conflict',message:`该房间已有${first.role==='controller'?'控制方':'受控方'}，请选择另一角色或让对方更改选择。`});assignedRole=wanted;}
      const id=uuid();await this.env.DB.prepare('INSERT INTO room_members(id,room_code,nickname,role,joined_at,last_seen_at) VALUES(?,?,?,?,?,?)').bind(id,room,nickname,assignedRole,t,t).run();
      member={id,room_code:room,nickname,role:assignedRole,joined_at:t,last_seen_at:t};
    }
    await this.env.DB.prepare('UPDATE rooms SET last_active_at=? WHERE code=?').bind(t,room).run();
    const a=this.attachment(ws);a.meta={memberId:member.id,room,nickname:member.nickname,role:member.role,bucket:8,bucketAt:t,lastTypingAt:0,contactViolations:0,recentChatText:'',recentChatAt:0,contactMutedUntil:0};this.save(ws,a);
    const lastId=Number(msg.lastId)||0;
    this.send(ws,{type:'joined',room,token:member.id,you:{id:member.id,nickname:member.nickname,role:member.role},resumed:!isNew,history:await this.history(room,isNew?0:lastId),members:await this.presence(room),seats:MAX_SEATS});
    if(isNew)await this.addMessage(room,'system',`${member.nickname} 加入了房间`);
    await this.pushPresence(room);
    const metro=await this.metro(room);if(metro)this.send(ws,{type:'metronome_state',...metro});
    for(const peer of this.sockets()){const pm=this.meta(peer);if(peer!==ws&&pm?.room===room)this.send(peer,{type:'voice_peer_ready',memberId:member.id,nickname:member.nickname});}
    await this.env.DB.prepare('DELETE FROM rooms WHERE last_active_at<?').bind(t-ROOM_RETENTION_DAYS*86400000).run();
  }
  private async handle(ws:WebSocket,msg:ClientMessage) {
    if(msg.type==='matchmaking_join')return this.matchmakingJoin(ws,msg);
    if(msg.type==='matchmaking_cancel'){
      const id=typeof msg.clientId==='string'?msg.clientId:'';
      if(id&&/^[0-9a-f-]{36}$/i.test(id)){
        const entry=await this.env.DB.prepare('SELECT * FROM matchmaking_queue WHERE client_id=?').bind(id).first<any>();
        if(entry?.status==='matched'&&entry.room_code)return this.send(ws,{type:'match_found',room:entry.room_code,role:entry.matched_role});
        await this.env.DB.prepare("DELETE FROM matchmaking_queue WHERE client_id=? AND status='waiting'").bind(id).run();
      }
      const a=this.attachment(ws);delete a.matchmakingClientId;this.save(ws,a);return this.send(ws,{type:'matchmaking_cancelled'});
    }
    if(msg.type==='join')return this.join(ws,msg);
    const m=this.meta(ws);
    if(msg.type==='ping'){
      if(!m){await this.pollMatchmaking(ws);return this.send(ws,{type:'pong'});}
      if(!(await this.touch(m)))return this.seatLost(ws);
      return this.send(ws,{type:'pong',missed:await this.history(m.room,Number(msg.lastId)||0),members:await this.presence(m.room),seats:MAX_SEATS});
    }
    if(!m)return this.send(ws,{type:'error',code:'not_joined',message:'请先加入房间。'});
    if(msg.type==='metronome_emergency_stop'){
      if(!(await this.touch(m)))return this.seatLost(ws);
      const previous=await this.metro(m.room)??{bpm:80,intensity:3,running:false,started:false};const state={...previous,running:false,started:true,stopped:true,nickname:m.nickname};await this.setMetro(m.room,state);this.broadcast(m.room,{type:'metronome_state',...state},ws);this.send(ws,{type:'metronome_state',...state});return;
    }
    if(msg.type==='metronome_state'){
      if(m.role!=='controller')return this.send(ws,{type:'error',code:'role_forbidden',message:'只有控制方可以调整节拍参数和挑战进度。受控方可使用紧急停止。'});
      if(this.rateLimited(ws,m))return this.send(ws,{type:'error',code:'rate_limited',message:'操作太快了，请稍等片刻。'});
      if(!(await this.touch(m)))return this.seatLost(ws);
      const previous=await this.metro(m.room);const started=Boolean(msg.started||msg.running||msg.stopped||previous?.started);const state={bpm:Math.max(40,Math.min(220,Math.round(Number(msg.bpm)||80))),intensity:Math.max(1,Math.min(5,Math.round(Number(msg.intensity)||3))),running:msg.stopped?false:Boolean(msg.running),started,stopped:Boolean(msg.stopped),nickname:m.nickname};await this.setMetro(m.room,state);this.broadcast(m.room,{type:'metronome_state',...state},ws);return;
    }
    if(msg.type==='chat'){
      const text=String(msg.text??'').trim().slice(0,500);if(!text)return;
      if(m.contactMutedUntil>now())return this.send(ws,{type:'contact_blocked',source:'text',count:m.contactViolations,mutedUntil:m.contactMutedUntil,message:'你暂时无法发送消息，请稍后再试。'});
      if(this.rateLimited(ws,m))return this.send(ws,{type:'error',code:'rate_limited',message:'发送太快了，请稍等片刻。'});
      if(!(await this.touch(m)))return this.seatLost(ws);
      const t=now(),combined=t-m.recentChatAt<=12000?m.recentChatText+text:text;
      if(containsContactInfo(text)||containsContactInfo(combined)){m.recentChatText='';m.recentChatAt=0;const a=this.attachment(ws);a.meta=m;this.save(ws,a);return this.applyContactViolation(ws,'text');}
      m.recentChatText=text.slice(-120);m.recentChatAt=t;const a=this.attachment(ws);a.meta=m;this.save(ws,a);return this.addMessage(m.room,'chat',text,{id:m.memberId,nickname:m.nickname});
    }
    if(msg.type==='contact_voice_violation')return this.applyContactViolation(ws,'voice');
    if(msg.type==='action'){
      const actions:Record<string,(n:string)=>string>={next_scene:n=>`${n} 推进到下一幕：${pick(SCENES)}`,challenge:n=>`${n} 发起随机挑战：${pick(CHALLENGES)}`,pause:n=>`${n} 请求暂停。双方确认前请不要继续推进。`,resume:n=>`${n} 表示可以继续。`,stop:n=>`${n} 结束了本轮互动。`};
      const make=actions[msg.action];if(!make)return;if(this.rateLimited(ws,m))return this.send(ws,{type:'error',code:'rate_limited',message:'操作太快了，请稍等片刻。'});if(!(await this.touch(m)))return this.seatLost(ws);
      await this.addMessage(m.room,'action',make(m.nickname),{id:m.memberId,nickname:m.nickname});
      if(msg.action==='stop'){
        await this.ctx.storage.delete('metro:'+m.room);await this.env.DB.prepare('UPDATE room_members SET left_at=? WHERE room_code=? AND left_at IS NULL').bind(now(),m.room).run();
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
      const {room,memberId,nickname}=m;const metro=await this.metro(room);if(metro?.running){const state={...metro,running:false,stopped:true,nickname};await this.setMetro(room,state);this.broadcast(room,{type:'metronome_state',...state},ws);}
      this.detach(ws);const r=await this.env.DB.prepare('UPDATE room_members SET left_at=? WHERE id=? AND left_at IS NULL').bind(now(),memberId).run();this.send(ws,{type:'left'});if(r.meta.changes)await this.addMessage(room,'system',`${nickname} 离开了房间`);return this.pushPresence(room);
    }
  }
  async fetch(request:Request):Promise<Response> {
    const url=new URL(request.url);
    if(url.pathname==='/ws'&&request.headers.get('Upgrade')?.toLowerCase()==='websocket'){
      const pair=new WebSocketPair(),client=pair[0],server=pair[1];this.ctx.acceptWebSocket(server);this.save(server,{});
      return new Response(null,{status:101,webSocket:client});
    }
    const roomMatch=url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4,12})$/);
    if(request.method==='GET'&&roomMatch){const room=roomMatch[1].toUpperCase(),members=await this.presence(room);return json({room,seats:MAX_SEATS,taken:members.length,full:members.length>=MAX_SEATS});}
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
    await this.queue(async()=>{
      let msg:ClientMessage;try{msg=JSON.parse(typeof message==='string'?message:new TextDecoder().decode(message))}catch{return this.send(ws,{type:'error',code:'bad_json',message:'无法解析的消息。'});}
      if(!msg||typeof msg.type!=='string')return;
      try{await this.handle(ws,msg);}catch(e){console.error('ws handler error',e);this.send(ws,{type:'error',code:'server_error',message:'服务器暂时出错，请稍后重试。'});}
    });
  }
  async webSocketClose(ws:WebSocket) {
    await this.queue(async()=>{
      const m=this.meta(ws);if(!m)return;this.detach(ws);
      const metro=await this.metro(m.room);if(metro?.running){const state={...metro,running:false,stopped:true,nickname:m.nickname};await this.setMetro(m.room,state);this.broadcast(m.room,{type:'metronome_state',...state});}
      await this.env.DB.prepare('UPDATE room_members SET last_seen_at=? WHERE id=? AND left_at IS NULL').bind(now()-(ONLINE_WINDOW_S+1)*1000,m.memberId).run();await this.pushPresence(m.room);
    });
  }
  async webSocketError(ws:WebSocket) { this.detach(ws); }
}
