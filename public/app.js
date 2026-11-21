const $=s=>document.querySelector(s);
const guestId=(()=>{const key="np_guest_id";let id=localStorage.getItem(key);if(!/^[0-9a-f-]{36}$/i.test(id||"")){id=crypto.randomUUID();localStorage.setItem(key,id)}return id})();
const onlineVisitorId=(()=>{const key="np_online_visitor_id";let id=localStorage.getItem(key);if(!/^[0-9a-f-]{36}$/i.test(id||"")){id=crypto.randomUUID();localStorage.setItem(key,id)}return id})();
async function refreshOnlineCount(){
 try{
  const response=await fetch("/api/online/heartbeat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({visitorId:onlineVisitorId}),cache:"no-store"});
  if(!response.ok)throw new Error("online heartbeat failed");
  const data=await response.json(),node=$("#onlineCount");
  if(node)node.textContent=String(Number(data.online)||0);
 }catch{const node=$("#onlineCount");if(node&&node.textContent==="--")node.textContent="暂不可用"}
}
refreshOnlineCount();setInterval(refreshOnlineCount,20000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)refreshOnlineCount()});

async function loadGameHistory(){
 const box=$("#historyList");if(!box)return;box.textContent="正在读取对局历史…";
 try{
  const response=await fetch("/api/history?guestId="+encodeURIComponent(guestId),{cache:"no-store"});
  if(!response.ok)throw new Error("history request failed");
  const data=await response.json(),items=Array.isArray(data.history)?data.history:[];
  if(!items.length){box.textContent="还没有对局记录。完成一次双人对局并主动离开或结束后，记录会显示在这里。";return}
  box.replaceChildren();
  items.forEach(item=>{
   const row=document.createElement("div");row.style.cssText="padding:9px 0;border-bottom:1px solid #ffffff18";
   const date=document.createElement("strong");date.textContent=new Date(item.endedAt).toLocaleString("zh-CN");row.appendChild(date);
   const detail=document.createElement("div");detail.style.cssText="color:#aaa6b4;font-size:11px;margin-top:4px";
   const mins=Math.floor((Number(item.durationSeconds)||0)/60),secs=(Number(item.durationSeconds)||0)%60;
   detail.textContent="房间 "+item.room+" · "+(item.role==="controller"?"控制方 S":"受控方 M")+" · "+item.nickname+" · "+mins+"分"+secs+"秒";
   row.appendChild(detail);
   if(item.opponentFriendCode){
    const add=document.createElement("button");add.type="button";add.className="ghost history-add-friend";add.textContent="添加 "+(item.opponentNickname||"对局对象")+" 为好友";
    add.addEventListener("click",()=>sendFriendRequest(item.opponentFriendCode));row.appendChild(add);
   }
   box.appendChild(row);
  });
 }catch(e){box.textContent="暂时无法读取记录，请稍后刷新。"}
}
const toast=(m)=>{const t=$("#toast");t.textContent=m;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2600)};

 // 首页弹窗：匹配与邀请共用昵称，避免重复表单。
 function setModalTab(tab){
  const panels={match:$("#matchPanel"),join:$("#joinPanel"),history:$("#historyPanel"),friends:$("#friendsPanel")};
  if(!panels[tab])tab="match";
  Object.entries(panels).forEach(([key,panel])=>panel.hidden=key!==tab);
  document.querySelectorAll("[data-modal-tab]").forEach(b=>b.classList.toggle("active",b.dataset.modalTab===tab));
  $("#modalTitle").textContent=tab==="match"?"按偏好寻找搭档":tab==="join"?"邀请 / 加入双人房间":tab==="friends"?"好友与私信":"我的对局历史";
  if(tab==="history")loadGameHistory();
  if(tab==="friends")loadFriends();

 }
 function openActionModal(tab){
  setModalTab(["match","history","friends"].includes(tab)?tab:"join");
  $("#actionModal").hidden=false;
  document.body.classList.add("modal-open");
 }
 function closeActionModal(){
  const modal=$("#actionModal");if(modal)modal.hidden=true;
  document.body.classList.remove("modal-open");
 }
 function formatMatchElapsed(ms){const total=Math.max(0,Math.floor(ms/1000)),minutes=Math.floor(total/60),seconds=total%60;return String(minutes).padStart(2,"0")+":"+String(seconds).padStart(2,"0")}
 function updateMatchElapsed(){const node=$("#matchingElapsed");if(node&&matchStartedAt)node.textContent=formatMatchElapsed(Date.now()-matchStartedAt)}
 function stopMatchClock(){if(matchClock){clearInterval(matchClock);matchClock=null}matchStartedAt=0}
 function showMatchingScreen(on){const screen=$("#matchingScreen");if(!screen)return;screen.hidden=!on;if(on){$("#actionModal").hidden=true;document.body.classList.remove("modal-open");updateMatchElapsed()}else if(!$("#roomView").hidden){document.body.classList.remove("modal-open")}}
 function renderMatchingPreferences(){
  const gender={male:"男性",female:"女性",other:"其他 / 不便透露"},preference={male:"男性",female:"女性",any:"不限"},role={controller:"控制方（S）",receiver:"受控方（M）",any:"不限（自动分配）"},voice={any:"不限",off:"双方不开麦",both:"双方都开麦",self:"我开麦，对方不开",peer:"对方开麦，我不开"};
  $("#matchingGender").textContent="你的性别："+(gender[els.matchGender.value]||"—");
  $("#matchingPreference").textContent="匹配对象："+(preference[els.matchPreference.value]||"—");
  $("#matchingRole").textContent="角色："+(role[els.matchRole.value]||"—");
  $("#matchingVoice").textContent="语音："+(voice[els.matchVoicePreference.value]||"—");
 }
 function returnToMatchSettings(message){
  matching=false;matchClientId=null;stopMatchClock();clearInterval(matchPoll);matchPoll=null;
  els.matchStart.disabled=false;els.matchCancel.disabled=true;els.connect.disabled=false;
  els.matchStatus.textContent=message||"已取消匹配";
  $("#matchingStatus").textContent=message||"已取消匹配";showMatchingScreen(false);openActionModal("match");
 }
 document.querySelectorAll("[data-open-modal]").forEach(b=>b.addEventListener("click",()=>openActionModal(b.dataset.openModal)));
 document.querySelectorAll("[data-modal-tab]").forEach(b=>b.addEventListener("click",()=>setModalTab(b.dataset.modalTab)));
 document.querySelectorAll("[data-close-modal]").forEach(b=>b.addEventListener("click",closeActionModal));
 $("#historyRefresh").addEventListener("click",loadGameHistory);
 // ===== 游客好友系统：好友码、申请、私信与对局邀请 =====
 let activeDmFriendCode="",activeDmFriendName="";
 async function friendApi(url,method="GET",data){
  const options={method,cache:"no-store",headers:{}};
  if(data){options.headers["content-type"]="application/json";options.body=JSON.stringify(data)}
  const response=await fetch(url,options);let result={};try{result=await response.json()}catch{}
  if(!response.ok){const messages={already_friends:"你们已经是好友了。",friend_not_found:"没有找到这个好友码。",not_friends:"你们还不是好友。",profile_not_found:"游客资料尚未初始化，请刷新好友页面。",request_not_found:"这条好友申请已失效。"};throw new Error(result.message||messages[result.error]||"请求失败，请稍后重试。")}
  return result;
 }
 async function friendPresence(){
  const nick=$("#nickname").value.trim()||localStorage.getItem("np_nick")||"访客";
  try{await friendApi("/api/friends/presence","POST",{guestId,nickname:nick})}catch{}
 }
 async function loadFriends(){
  const list=$("#friendsList");if(!list)return;
  list.textContent="正在读取好友…";
  await friendPresence();
  try{
   const data=await friendApi("/api/friends?guestId="+encodeURIComponent(guestId));
   $("#myFriendCode").textContent=data.profile.friendCode;
   $("#onlineVisibility").checked=!!data.profile.onlineVisible;
   renderFriendRequests(data.incoming||[],data.outgoing||[]);
   renderFriendsList(data.friends||[]);
  }catch(e){list.textContent="好友列表暂时无法加载："+e.message}
 }
 function renderFriendRequests(incoming,outgoing){
  const box=$("#incomingRequests");box.replaceChildren();$("#incomingCount").textContent=String(incoming.length);
  if(!incoming.length)box.textContent="暂无新的好友申请。";
  incoming.forEach(item=>{
   const row=document.createElement("div");row.className="friend-row";
   const info=document.createElement("span");info.textContent=item.nickname+" · "+item.friendCode;
   const accept=document.createElement("button");accept.type="button";accept.className="primary";accept.textContent="接受";
   accept.onclick=()=>respondFriendRequest(item.id,true);
   const reject=document.createElement("button");reject.type="button";reject.className="ghost";reject.textContent="拒绝";
   reject.onclick=()=>respondFriendRequest(item.id,false);
   row.append(info,accept,reject);box.append(row);
  });
  const out=$("#outgoingRequests");out.textContent=outgoing.length?"已发送申请："+outgoing.map(x=>x.nickname+"（"+x.friendCode+"）").join("、"):"没有待处理的发出申请。";
 }
 function renderFriendsList(friends){
  const box=$("#friendsList");box.replaceChildren();
  if(!friends.length){box.textContent="还没有好友。可以输入对方的好友码，或从对局历史中添加。";return}
  friends.forEach(item=>{
   const row=document.createElement("div");row.className="friend-row";
   const info=document.createElement("span");info.className="friend-name";
   const dot=document.createElement("i");dot.className="friend-dot"+(item.online?" online":"");
   const name=document.createElement("strong");name.textContent=item.nickname;
   const code=document.createElement("small");code.textContent=item.friendCode;
   const status=document.createElement("small");status.textContent=item.online?"在线":"离线";
   info.append(dot,name,code,status);
   const chat=document.createElement("button");chat.type="button";chat.className="primary";chat.textContent="私信";chat.onclick=()=>openDm(item.friendCode,item.nickname);
   const invite=document.createElement("button");invite.type="button";invite.className="ghost";invite.textContent="邀请";invite.onclick=()=>inviteFriend(item.friendCode,item.nickname);
   row.append(info,chat,invite);box.append(row);
  });
 }
 async function sendFriendRequest(friendCode){
  try{const result=await friendApi("/api/friends/request","POST",{guestId,friendCode});toast(result.message||"好友申请已发送");$("#friendCodeInput").value="";await loadFriends()}
  catch(e){toast(e.message)}
 }
 async function respondFriendRequest(requestId,accept){
  try{await friendApi("/api/friends/respond","POST",{guestId,requestId,accept});toast(accept?"已添加好友":"已拒绝申请");await loadFriends()}
  catch(e){toast(e.message)}
 }
 async function openDm(friendCode,nickname){
  activeDmFriendCode=friendCode;activeDmFriendName=nickname;$("#dmFriendName").textContent=nickname;$("#dmSection").hidden=false;
  await loadDm();$("#dmInput").focus();
 }
 async function loadDm(){
  if(!activeDmFriendCode)return;
  const box=$("#dmLog");box.textContent="正在加载私信…";
  try{
   const data=await friendApi("/api/dm?guestId="+encodeURIComponent(guestId)+"&friendCode="+encodeURIComponent(activeDmFriendCode));
   box.replaceChildren();
   if(!data.messages.length)box.textContent="还没有消息，向好友打个招呼吧。";
   data.messages.forEach(item=>{
    const row=document.createElement("div");row.className="dm-message"+(item.mine?" mine":"");
    const body=document.createElement("p");body.textContent=item.body;row.append(body);
    if(item.type==="invite"&&item.roomCode){
     const join=document.createElement("button");join.type="button";join.className="ghost";join.textContent="进入房间 "+item.roomCode;
     join.onclick=()=>{openActionModal("join");$("#roomCode").value=item.roomCode;$("#roomCode").dispatchEvent(new Event("input"))};
     row.append(join);
    }
    const time=document.createElement("small");time.textContent=new Date(item.createdAt).toLocaleString("zh-CN",{hour:"2-digit",minute:"2-digit"});row.append(time);box.append(row);
   });
   box.scrollTop=box.scrollHeight;
  }catch(e){box.textContent="私信暂时无法加载："+e.message}
 }
 async function inviteFriend(friendCode,nickname){
  const roomCode=crypto.randomUUID().replace(/-/g,"").slice(0,8).toUpperCase();
  try{
   await friendApi("/api/dm","POST",{guestId,friendCode,roomCode});
   toast("对局邀请已发送。请先进入房间，等待好友加入。");
   $("#roomCode").value=roomCode;openActionModal("join");
  }catch(e){toast(e.message)}
 }
 $("#addFriendBtn").addEventListener("click",()=>{const code=$("#friendCodeInput").value.trim().toUpperCase();if(!/^[A-F0-9]{8}$/.test(code)){toast("请输入 8 位好友码");return}sendFriendRequest(code)});
 $("#friendCodeInput").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();$("#addFriendBtn").click()}});
 $("#copyFriendCode").addEventListener("click",()=>{const code=$("#myFriendCode").textContent;if(!/^[A-F0-9]{8}$/.test(code))return;(navigator.clipboard?navigator.clipboard.writeText(code):Promise.reject()).then(()=>toast("好友码已复制"),()=>prompt("复制好友码：",code))});
 $("#onlineVisibility").addEventListener("change",async e=>{try{await friendApi("/api/friends/profile","PATCH",{guestId,onlineVisible:e.target.checked,nickname:$("#nickname").value.trim()});toast("在线状态设置已保存")}catch(err){toast(err.message);e.target.checked=!e.target.checked}});
 $("#friendsRefresh").addEventListener("click",loadFriends);
 $("#dmClose").addEventListener("click",()=>{$("#dmSection").hidden=true;activeDmFriendCode=""});
 $("#dmForm").addEventListener("submit",async e=>{
  e.preventDefault();const input=$("#dmInput"),value=input.value.trim();if(!value||!activeDmFriendCode)return;
  try{await friendApi("/api/dm","POST",{guestId,friendCode:activeDmFriendCode,text:value});input.value="";await loadDm()}
  catch(err){toast(err.message)}
 });
 $("#dmInvite").addEventListener("click",()=>{if(activeDmFriendCode)inviteFriend(activeDmFriendCode,activeDmFriendName)});
 friendPresence();setInterval(()=>{if(!document.hidden)friendPresence()},30000);
 setInterval(()=>{if(activeDmFriendCode&&!document.hidden)loadDm()},8000);

 document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!$("#actionModal").hidden)closeActionModal()});

 
 // ===== 双人房间：WebSocket + WebRTC 双人语音 =====
 const Room=(()=>{
  const els={lobby:$("#lobby"),view:$("#roomView"),state:$("#connState"),log:$("#chatLog"),members:$("#members"),seat:$("#seatLabel"),label:$("#roomLabel"),typing:$("#typing"),input:$("#chatInput"),nick:$("#nickname"),code:$("#roomCode"),connect:$("#connectBtn"),peek:$("#roomPeek"),voiceStatus:$("#voiceStatus"),voiceStart:$("#voiceStartBtn"),voiceMute:$("#voiceMuteBtn"),voiceHangup:$("#voiceHangupBtn"),voiceListen:$("#voiceListenBtn"),remoteAudio:$("#remoteAudio"),matchGender:$("#matchGender"),matchPreference:$("#matchPreference"),matchRole:$("#matchRole"),matchVoicePreference:$("#matchVoicePreference"),roomRole:$("#roomRole"),roleStatus:$("#roleStatus"),metroEmergency:$("#metroEmergency"),matchStart:$("#matchStartBtn"),matchCancel:$("#matchCancelBtn"),matchStatus:$("#matchStatus"),bpm:$("#bpmRange"),intensity:$("#intensityRange"),metroStart:$("#metroStart"),metroPause:$("#metroPause"),metroStop:$("#metroStop"),metroStatus:$("#metroStatus"),metroMode:$("#metroMode"),metroDifficulty:$("#metroDifficulty"),metroDuration:$("#metroDuration"),metroSlow:$("#metroSlow"),metroNormal:$("#metroNormal"),metroFast:$("#metroFast"),metroHold:$("#metroHold"),metroResume:$("#metroResume"),watchConsent:$("#watchConsentBtn"),watcherCount:$("#watcherCount"),watchStatus:$("#watchStatus")};
  let ws=null,room=null,me=null,myRole=null,matchedRole=null,currentOpponentFriendCode="",currentOpponentNickname="",want=false,watching=false,watchConsent=false,watchAllowed=false,lastId=0,seen=new Set(),retry=0,retryTimer=null,hb=null,typingTimer=null,joining=false,matching=false,matchClientId=null,matchPoll=null,joinRetry=null,matchStartedAt=0,matchClock=null,pendingPublish=false,pendingPublishName="";
  // WebRTC 状态：麦克风只会在用户主动点击后申请，不会自动开启。
  let pc=null,pcPromise=null,localStream=null,remoteStream=null,pendingCandidates=[];
  let voiceRecognition=null,voiceAudioContext=null,voiceSource=null,voiceDelay=null,voiceGate=null,voiceDestination=null;
  let voiceRecentText='',voiceRecentAt=0,contactMutedUntil=0,localSpeechReady=false;
  let makingOffer=false,ignoreOffer=false,settingRemoteAnswerPending=false,voiceGeneration=0,iceConfigCache=null;
  const seatKey=r=>"np_seat_"+r;
  // 节拍器由双方浏览器本地发声，房间服务端只同步参数和运行状态。
  let metroTimer=null,metroBeat=0,metroRunning=false,metroHasStarted=false,metroStopped=false,audioCtx=null,metroSyncGuard=false,roomHasPartner=false,metroChallengeTimer=null,metroRandomTimer=null,metroEndsAt=0,metroRemainingMs=300000,metroModeValue="steady",metroDifficultyValue="normal",metroDurationMinutes=5,metroHoldCount=0,metroElapsedMs=0,metroEndReason="";
  const metroIntensity=()=>Number(els.intensity.value);
  function updateMetroLabels(){const bpm=Number(els.bpm.value),level=metroIntensity();$("#bpmValue").textContent=bpm;$("#bpmLabel").textContent=bpm;$("#metroSummaryBpm").textContent=bpm;$("#intensityLabel").textContent=level;$("#intensityText").textContent="力度 "+level+" / 5";$("#beatPulse").style.setProperty("--pulse-scale",String(1+level*.035));}
  function stopMetroTimer(){if(metroTimer){clearInterval(metroTimer);metroTimer=null}}
  function playMetroTone(accent,level){try{audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)();if(audioCtx.state==="suspended"){audioCtx.resume().then(()=>{if(metroRunning)playMetroTone(accent,level)}).catch(e=>console.warn("节拍声音未获授权",e));return}const osc=audioCtx.createOscillator(),gain=audioCtx.createGain();osc.type="sine";osc.frequency.value=accent?1050:760;gain.gain.setValueAtTime(Math.min(.38,.055+level*.055),audioCtx.currentTime);gain.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+.11);osc.connect(gain);gain.connect(audioCtx.destination);osc.start();osc.stop(audioCtx.currentTime+.12)}catch(e){console.warn("节拍提示音不可用",e)}}
  function unlockMetroAudio(){try{audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)();if(audioCtx.state!=="running")audioCtx.resume().catch(e=>console.warn("节拍声音暂不可用",e));}catch(e){console.warn("节拍音频初始化失败",e)}}
  document.addEventListener("pointerdown",unlockMetroAudio,{once:true,passive:true});document.addEventListener("keydown",unlockMetroAudio,{once:true});
  function tick(){if(!metroRunning)return;metroBeat=(metroBeat%4)+1;const level=metroIntensity(),accent=metroBeat===1;const pulse=$("#beatPulse");pulse.classList.remove("active");void pulse.offsetWidth;pulse.classList.add("active");$("#beatNumber").textContent=String(metroBeat);setTimeout(()=>pulse.classList.remove("active"),180);playMetroTone(accent,level)}
  function renderMetroState(){updateMetroLabels();updateMetroCountdown();$("#metroHoldCountLive").textContent=String(metroHoldCount);$("#metroLivePanel").hidden=metroStopped;$("#metroEndScreen").hidden=!metroStopped;els.metroStatus.textContent=metroRunning?"挑战进行中":metroStopped?"挑战已结束":metroHasStarted?"已暂停":roomHasPartner?"准备就绪":"等待另一位参与者加入";const controller=myRole==="controller";els.bpm.disabled=!controller;els.intensity.disabled=!controller;els.metroMode.disabled=!controller;els.metroDifficulty.disabled=!controller;els.metroDuration.disabled=!controller;[els.metroSlow,els.metroNormal,els.metroFast,els.metroHold,els.metroResume].forEach(b=>b.disabled=!controller||!roomHasPartner);els.metroStart.disabled=!controller||metroRunning;$("#metroRestartBtn").disabled=!controller;els.metroPause.disabled=!controller||!metroRunning;els.metroStop.disabled=!controller||!metroHasStarted||metroStopped;els.metroEmergency.disabled=!me;els.roleStatus.textContent=!myRole?"进入房间后显示你的挑战角色。":controller?"你的角色：控制方（S）· 可调整节奏与挑战时长。":"你的角色：受控方（M）· 跟随节拍，可随时紧急停止或在聊天中表达感受。";}
  function clearMetroClocks(){if(metroChallengeTimer)clearInterval(metroChallengeTimer);if(metroRandomTimer)clearInterval(metroRandomTimer);metroChallengeTimer=metroRandomTimer=null}
  function metroPayload(running=metroRunning,stopped=metroStopped){return {type:"metronome_state",bpm:Number(els.bpm.value),intensity:metroIntensity(),running,started:metroHasStarted,stopped,mode:metroModeValue,difficulty:metroDifficultyValue,durationMinutes:metroDurationMinutes,endsAt:metroEndsAt,remainingMs:metroRemainingMs,holdCount:metroHoldCount,elapsedMs:metroElapsedMs,endReason:metroEndReason}}
  function updateMetroCountdown(){const left=metroRunning?Math.max(0,metroEndsAt-Date.now()):metroRemainingMs,sec=Math.ceil(left/1000);$("#metroCountdown").textContent=String(Math.floor(sec/60)).padStart(2,"0")+":"+String(sec%60).padStart(2,"0")}
  function startMetroClocks(){
   clearMetroClocks();
   metroChallengeTimer=setInterval(()=>{updateMetroCountdown();if(metroRunning&&metroEndsAt&&Date.now()>=metroEndsAt&&myRole==="controller")stopMetro(true)},500);
   if(metroModeValue==="random"&&myRole==="controller")metroRandomTimer=setInterval(()=>{if(!metroRunning)return;const choices=metroDifficultyValue==="easy"?[50,60,70,80]:metroDifficultyValue==="hard"?[75,95,120,145,165]:[55,70,85,100,115,130];els.bpm.value=String(choices[Math.floor(Math.random()*choices.length)]);updateMetroLabels();restartMetroInterval();if(!metroSyncGuard)out(metroPayload())},12000);
  }
  function startMetro(sync=true){
   if(metroRunning)return;if(!roomHasPartner){toast("请等待另一位参与者进入房间后再开始挑战");return}
   if(!metroHasStarted||metroStopped||metroRemainingMs<=0){metroRemainingMs=(Number(els.metroDuration.value)||5)*60000;metroHoldCount=0;metroElapsedMs=0;metroEndReason="";}
   metroModeValue=els.metroMode.value||metroModeValue;metroDifficultyValue=els.metroDifficulty.value||metroDifficultyValue;metroDurationMinutes=Number(els.metroDuration.value)||metroDurationMinutes;
   metroHasStarted=true;metroStopped=false;metroRunning=true;metroEndsAt=Date.now()+metroRemainingMs;metroBeat=0;stopMetroTimer();tick();metroTimer=setInterval(tick,60000/Number(els.bpm.value));startMetroClocks();renderMetroState();
   if(sync&&!metroSyncGuard)out(metroPayload());
  }
  function pauseMetro(sync=true){
   if(metroRunning&&metroEndsAt)metroRemainingMs=Math.max(0,metroEndsAt-Date.now());
   if(metroHasStarted)metroElapsedMs=Math.max(metroElapsedMs,metroDurationMinutes*60000-metroRemainingMs);
   metroHasStarted=metroHasStarted||metroRunning;metroStopped=false;metroRunning=false;stopMetroTimer();clearMetroClocks();$("#beatNumber").textContent="Ⅱ";updateMetroCountdown();renderMetroState();
   if(sync&&!metroSyncGuard)out(metroPayload(false,false));
  }
  function stopMetro(sync=true){
   const reachedTime=metroRunning&&metroEndsAt>0&&Date.now()>=metroEndsAt;
   if(!metroStopped){
    if(metroRunning&&metroEndsAt)metroRemainingMs=Math.max(0,metroEndsAt-Date.now());
    metroElapsedMs=Math.max(metroElapsedMs,metroDurationMinutes*60000-metroRemainingMs);
   }
   if(!metroEndReason)metroEndReason=reachedTime?"挑战时间已到，本轮自动结束。":"本轮共寸止 "+metroHoldCount+" 次。";
   metroHasStarted=true;metroStopped=true;metroRunning=false;metroRemainingMs=0;metroEndsAt=0;stopMetroTimer();clearMetroClocks();metroBeat=0;$("#beatNumber").textContent="—";updateMetroCountdown();renderMetroState();els.metroStatus.textContent="挑战已结束";
   $("#metroEndDuration").textContent=String(Math.floor(metroElapsedMs/60000)).padStart(2,"0")+":"+String(Math.floor(metroElapsedMs/1000)%60).padStart(2,"0");$("#metroEndHoldCount").textContent=String(metroHoldCount);$("#metroEndReason").textContent=metroEndReason;
   if(sync&&!metroSyncGuard)out(metroPayload(false,true));
  }
  function applyMetroRemote(m){
   metroSyncGuard=true;metroHasStarted=Boolean(m.started||m.running||m.stopped);metroStopped=Boolean(m.stopped);
   metroModeValue=m.mode==="random"?"random":"steady";metroDurationMinutes=Math.max(1,Math.min(15,Number(m.durationMinutes)||5));els.metroMode.value=metroModeValue;metroDifficultyValue=["easy","normal","hard"].includes(m.difficulty)?m.difficulty:"normal";els.metroDifficulty.value=metroDifficultyValue;els.metroDuration.value=String(metroDurationMinutes);
   metroEndsAt=Math.max(0,Number(m.endsAt)||0);metroRemainingMs=Math.max(0,Math.min(900000,Number(m.remainingMs)||0));metroHoldCount=Math.max(0,Math.min(1000,Number(m.holdCount)||0));metroElapsedMs=Math.max(0,Math.min(900000,Number(m.elapsedMs)||0));metroEndReason=typeof m.endReason==="string"?m.endReason.slice(0,120):"";
   els.bpm.value=String(Math.max(40,Math.min(220,Number(m.bpm)||80)));els.intensity.value=String(Math.max(1,Math.min(5,Number(m.intensity)||3)));updateMetroLabels();
   if(watching){
    metroRunning=Boolean(m.running);metroStopped=Boolean(m.stopped);metroHasStarted=Boolean(m.started||m.running||m.stopped);
    stopMetroTimer();clearMetroClocks();if(metroRunning)metroChallengeTimer=setInterval(updateMetroCountdown,500);
   }else if(m.stopped)stopMetro(false);else if(m.running){metroRunning=false;metroRemainingMs=metroEndsAt?Math.max(0,metroEndsAt-Date.now()):metroRemainingMs;startMetro(false)}else pauseMetro(false);
   renderMetroState();metroSyncGuard=false;
  }
  function restartMetroInterval(){if(!metroRunning)return;stopMetroTimer();metroTimer=setInterval(tick,60000/Number(els.bpm.value));}
  const setState=(cls,txt)=>{els.state.className="conn-state "+cls;els.state.textContent=txt};
  const setVoiceState=(cls,txt)=>{els.voiceStatus.className="voice-status"+(cls?" "+cls:"");els.voiceStatus.textContent=txt};
  const fmt=d=>{const t=new Date(d);return t.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})};
  function render(m){
   if(seen.has(m.id))return;seen.add(m.id);lastId=Math.max(lastId,m.id);
   const d=document.createElement("div");
   if(m.kind==="system"){d.className="chat-line system";d.textContent=m.body+" · "+fmt(m.createdAt)}
   else{
    d.className="chat-line "+(m.kind==="action"?"action ":"")+(me&&m.memberId===me.id?"mine":"");
    const meta=document.createElement("div");meta.className="meta";
    if(m.kind!=="action"){const b=document.createElement("b");b.textContent=m.nickname;meta.appendChild(b)}
    meta.appendChild(document.createTextNode(fmt(m.createdAt)));
    const bub=document.createElement("div");bub.className="bubble";bub.textContent=m.body;
    d.append(meta,bub);
   }
   const atBottom=els.log.scrollHeight-els.log.scrollTop-els.log.clientHeight<60;
   els.log.appendChild(d);
   if(atBottom||(me&&m.memberId===me.id))els.log.scrollTop=els.log.scrollHeight;
  }
  function note(t){const d=document.createElement("div");d.className="chat-line system";d.textContent=t;els.log.appendChild(d);els.log.scrollTop=els.log.scrollHeight}
  function renderMembers(list,seats){
   roomHasPartner=list.filter(p=>p.online).length>=2;renderWatchUI();
   els.members.innerHTML="";
   list.forEach(p=>{const s=document.createElement("span");s.className="member"+(p.online?" online":"")+(me&&p.id===me.id?" me":"");const i=document.createElement("i");const roleText=p.role==="controller"?"控制方":"受控方";s.append(i,document.createTextNode(p.nickname+" · "+roleText+(me&&p.id===me.id?"（你）":"")+(p.online?"":" · 离线")));els.members.appendChild(s)});
   for(let k=list.length;k<seats;k++){const s=document.createElement("span");s.className="member empty";s.textContent="等待另一位参与者…";els.members.appendChild(s)}
   els.seat.textContent=list.length+" / "+seats;
   renderMetroState();
  }
  const rolePhrases={
   controller:["这点节奏都跟不上？真让人失望。","嘴上逞强，结果这么快就乱了？","别自作聪明，乖乖按我的节奏来。","这么点考验就招架不住了？","刚才不是很能说吗？现在怎么安静了？","别找借口，你的表现我看得一清二楚。","想得到夸奖？先拿出点像样的表现。","记住，现在由我来掌控节奏。","回答我：继续、放慢，还是暂停？","不舒服就明确说停，我会立刻停止。"],
   receiver:["好舒服，我喜欢现在这个节奏。","真的很爽，想继续保持这样。","我快受不了了，请稍微慢一点。","这感觉太强烈了，我需要缓一缓。","我会乖乖听从你的安排。","我愿意配合，请告诉我接下来怎么做。","我想继续，请保持现在的节奏。","可以再强一点，但请留意我的反应。","我现在状态很好，愿意继续。","我需要暂停，请现在停下节拍。","我感到不舒服，我要结束这一轮。","请先确认我的意愿，再进行下一步。"]
  };
  function renderQuickPhrases(){
   if(!me)return;const controller=myRole==="controller";$("#quickPhraseRole").textContent=controller?"控制方 · S 快捷语":"受控方 · M 快捷语";
   const box=$("#quickPhrases");box.replaceChildren();
   (controller?rolePhrases.controller:rolePhrases.receiver).forEach(phrase=>{const button=document.createElement("button");button.type="button";button.className="qa";button.textContent=phrase;button.addEventListener("click",()=>showQuickPhrase(phrase));box.appendChild(button)});
  }
  function showQuickPhrase(value){
   const text=String(value||"").trim().slice(0,500);if(!text)return;
   if(!me){toast("尚未连接");return}
   const display=$("#quickPhraseDisplay");
   if(display)display.textContent=(me.nickname||"我")+"："+text;
  }
  function normalizeContactText(value){
   const raw=String(value||"").toLowerCase().normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g,"");
   const compact=raw.replace(/[\s·•,，。:：;；_\-—()（）[\]【】]/g,"");
   const digits={零:"0",〇:"0",洞:"0",幺:"1",两:"2",一:"1",二:"2",三:"3",四:"4",五:"5",六:"6",七:"7",八:"8",九:"9"};
   return compact.replace(/[零〇洞幺两一二三四五六七八九]/g,ch=>digits[ch]||ch);
  }
  function containsContactInfo(value){
   const text=normalizeContactText(value);if(!text)return false;
   return /(?:\+?86)?1[3-9]\d{9}/.test(text)
    ||/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text)
    ||/(?:https?\/{1,2}|www\.)|(?:t\.me|telegram\.me|wa\.me|instagram\.com|facebook\.com|line\.me|discord\.gg|discord\.com)/i.test(text)
    ||/(?:微信|wechat|vx|wx|v信|w信|微x|薇信|威信|qq|扣扣|企鹅号|telegram|电报|飞机号|whatsapp|wats?app|line|instagram|ins号|discord|邮箱|电子邮件)(?:(?:号|id|账号|帐号)?(?:是|为)?|:|：)?[a-z0-9_@.-]{3,}/i.test(text)
    ||(/\d{6,13}/.test(text)&&/(?:qq|扣扣|联系|加我|电话|手机|号码|号|vx|wx|微信|v信|w信)/i.test(text))
    ||/(?:加我|私我|联系我)(?:v|vx|wx)[a-z0-9_-]{3,}/i.test(text);
  }
  let recentChatText="",recentChatAt=0;
  function sendChat(value){
   const text=String(value||"").trim().slice(0,500);if(!text)return;if(!me){toast("尚未连接");return}
   if(contactMutedUntil>Date.now()){toast("你暂时无法发送消息，请等待限制结束。");return}
   const timestamp=Date.now(),previous=timestamp-recentChatAt<=12000?recentChatText:"";
   if(containsContactInfo(text)||containsContactInfo(previous+text)){
    recentChatText="";recentChatAt=0;out({type:"contact_text_violation"});toast("检测到疑似站外联系方式，消息已拦截。");return;
   }
   if(out({type:"chat",text})){recentChatText=text.slice(-120);recentChatAt=timestamp;els.input.value="";els.input.focus({preventScroll:true})}else toast("连接中断，正在重连…");
  }
  function renderWatchUI(){
   if(!els.watchConsent)return;
   els.watchConsent.hidden=watching;els.watchConsent.disabled=!me||!roomHasPartner;
   els.watchConsent.textContent=watchConsent?"关闭观战":"允许观战";
   els.watchStatus.textContent=watchAllowed?"双方已允许观战，其他人可通过房间码旁观。":(watchConsent?"你已允许，等待另一位参与者同意。":"双方都允许后，其他人才能旁观。");
  }
  function showRoom(on){els.lobby.hidden=on;els.view.hidden=!on;document.body.classList.toggle("room-active",on);document.body.classList.toggle("watch-mode",watching);if(on)closeActionModal();els.voiceStart.disabled=!on||!me}
  function socketUrl(){return (location.protocol==="https:"?"wss://":"ws://")+location.host+"/ws"}
  function open(){
   if(ws&&(ws.readyState===0||ws.readyState===1))return;
   setState("wait",retry?"重连中…":"连接中…");
   ws=new WebSocket(socketUrl());
   ws.onopen=()=>{retry=0;if(matchClientId&&room&&want)sendJoin(matchClientId);else if(watching&&room)sendWatchJoin();else if(want&&room)sendJoin()};
   ws.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch{return}handle(m)};
   ws.onclose=()=>{clearInterval(hb);hb=null;closeVoice(false,"语音已断开，请重新开启");els.voiceStart.disabled=true;if(!want){setState("off","未连接");return}
    setState("wait","重连中…");const delay=Math.min(15000,1000*2**retry)+Math.random()*500;retry++;clearTimeout(retryTimer);retryTimer=setTimeout(open,delay)};
   ws.onerror=()=>{};
  }
  const out=o=>{if(ws&&ws.readyState===1){ws.send(JSON.stringify(o));return true}return false};
  function sendJoin(matchId=null){
   joining=true;
   let token=matchId||localStorage.getItem(seatKey(room));
   if(!token)token=crypto.randomUUID();
   localStorage.setItem(seatKey(room),token);
   const lifetimeField=pendingPublish?$("#publicRoomLifetime"):$("#roomLifetime");
   const rawLifetime=Number(lifetimeField?.value)||30;
   const roomLifetimeMinutes=Math.max(5,Math.min(120,Math.round(rawLifetime)));
   const message={type:"join",room,nickname:els.nick.value.trim(),token,guestId,lastId,role:matchedRole||els.roomRole.value,publish:pendingPublish,roomName:pendingPublishName,roomLifetimeMinutes};
   if(matchId)message.matchClientId=matchId;
   out(message);
  }
  function sendWatchJoin(){out({type:"watch_join",room,nickname:els.nick.value.trim(),guestId})}
  function joinAsWatcher(codeValue){
   const nick=els.nick.value.trim(),code=String(codeValue||els.code.value).trim().toUpperCase();
   els.code.value=code;
   if(!nick){toast("请先填写昵称");els.nick.focus();return}
   if(!/^[A-Z0-9]{4,12}$/.test(code)){toast("请先填写有效的房间代码");els.code.focus();return}
   closeVoice(false);room=code;me=null;myRole=null;watching=true;want=true;lastId=0;seen=new Set();
   if(ws&&ws.readyState===1)sendWatchJoin();else open();
  }

  function updateMicControls(){
   const active=!!(localStream&&localStream.getAudioTracks().some(t=>t.readyState==="live"));
   const enabled=active&&localStream.getAudioTracks().some(t=>t.enabled);
   els.voiceStart.disabled=!me||active;
   els.voiceStart.textContent=active?"麦克风已开启":"🎙 开启麦克风";
   els.voiceMute.disabled=!active;
   els.voiceMute.textContent=enabled?"静音":"取消静音";
   els.voiceHangup.disabled=!pc&&!localStream;
  }
  async function getIceServers(){
   if(iceConfigCache)return iceConfigCache;
   const fallback=[{urls:"stun:stun.l.google.com:19302"}];
   try{
    const u="/api/rtc-config?room="+encodeURIComponent(room||"");
    const r=await fetch(u,{cache:"no-store",headers:{Authorization:"Bearer "+(me?.id||"")}});
    if(!r.ok)throw new Error("RTC 配置暂不可用");
    const data=await r.json();
    iceConfigCache=Array.isArray(data.iceServers)&&data.iceServers.length?data.iceServers:fallback;
    if(!data.turnEnabled)console.info("Nightplay: 未配置 TURN，部分网络环境可能无法建立语音连接。");
    return iceConfigCache;
   }catch(e){console.warn("获取 ICE 配置失败，先使用 STUN",e);iceConfigCache=fallback;return fallback}
  }
  async function ensurePeerConnection(){
   if(pc)return pc;
   if(pcPromise)return pcPromise;
   if(!window.RTCPeerConnection)throw new Error("当前浏览器不支持 WebRTC 语音");
   const generation=voiceGeneration;
   pcPromise=(async()=>{
    const iceServers=await getIceServers();
    if(generation!==voiceGeneration||!me)throw new Error("房间连接已结束");
    const connection=new RTCPeerConnection({iceServers});
    pc=connection;
    connection.onicecandidate=e=>{if(e.candidate)out({type:"voice_signal",kind:"candidate",candidate:e.candidate.toJSON?e.candidate.toJSON():e.candidate})};
    connection.ontrack=e=>{
     if(!remoteStream)remoteStream=new MediaStream();
     if(!remoteStream.getTracks().some(t=>t.id===e.track.id))remoteStream.addTrack(e.track);
     els.remoteAudio.srcObject=remoteStream;
     els.remoteAudio.play().then(()=>{els.voiceListen.hidden=true}).catch(()=>{
      els.voiceListen.hidden=false;setVoiceState("wait","收到对方声音 · 点击“播放对方声音”开始收听");
     });
    };
    connection.onconnectionstatechange=()=>{
     if(connection!==pc)return;
     if(connection.connectionState==="connected")setVoiceState("on","语音已连接 · 双向通话中");
     else if(connection.connectionState==="connecting")setVoiceState("wait","正在建立语音连接…");
     else if(connection.connectionState==="disconnected")setVoiceState("wait","语音暂时中断，正在尝试恢复…");
     else if(connection.connectionState==="failed")setVoiceState("error","连接失败 · 可检查网络或配置 TURN 服务");
    };
    connection.oniceconnectionstatechange=()=>{
     if(connection===pc&&connection.iceConnectionState==="failed")setVoiceState("error","网络穿透失败 · 建议配置 TURN 服务");
    };
    connection.onnegotiationneeded=async()=>{
     if(connection!==pc)return;
     try{
      makingOffer=true;
      await connection.setLocalDescription();
      out({type:"voice_signal",kind:"description",description:connection.localDescription});
     }catch(e){console.error("WebRTC 协商失败",e);setVoiceState("error","语音协商失败，请重新开启语音")}
     finally{makingOffer=false}
    };
    return connection;
   })();
   try{return await pcPromise}finally{pcPromise=null}
  }
  async function prepareLocalSpeechRecognition(){
   const Speech=window.SpeechRecognition||window.webkitSpeechRecognition;
   if(!Speech||typeof Speech.available!=="function"||typeof Speech.install!=="function")
    throw new Error("当前浏览器不支持中文设备端语音识别，已阻止开启麦克风。请更新浏览器后重试。");
   const options={langs:["zh-CN"],processLocally:true};
   let availability=await Speech.available(options);
   if(availability!=="available"){
    if(availability==="unavailable")throw new Error("此设备暂不支持中文设备端语音模型，已阻止开启麦克风。");
    setVoiceState("wait","正在准备设备端中文语音模型…");
    const installed=await Speech.install(options);
    if(!installed)throw new Error("中文设备端语音模型安装失败，请稍后重试。");
    availability=await Speech.available(options);
    if(availability!=="available")throw new Error("中文设备端语音模型尚未准备好，请稍后重试。");
   }
   localSpeechReady=true;
   return Speech;
  }
  function stopLocalRecognition(){
   const old=voiceRecognition;voiceRecognition=null;voiceRecentText="";voiceRecentAt=0;
   if(old){old.onresult=null;old.onerror=null;old.onend=null;try{old.abort()}catch{}}
  }
  function startLocalRecognition(Speech,generation){
   if(!localStream||!Speech||generation!==voiceGeneration)return;
   const recognition=new Speech();if(!("processLocally" in recognition))throw new Error("当前浏览器无法保证设备端语音识别，已阻止开启麦克风。");recognition.lang="zh-CN";recognition.continuous=true;recognition.interimResults=true;recognition.processLocally=true;
   voiceRecognition=recognition;
   recognition.onresult=event=>{
    if(voiceRecognition!==recognition||generation!==voiceGeneration)return;
    let chunk="";
    for(let i=event.resultIndex;i<event.results.length;i++)chunk+=event.results[i]?.[0]?.transcript||"";
    if(!chunk.trim())return;
    const timestamp=Date.now(),combined=(timestamp-voiceRecentAt<=12000?voiceRecentText:"")+chunk;
    if(containsContactInfo(chunk)||containsContactInfo(combined)){
     voiceRecentText="";voiceRecentAt=0;
     out({type:"contact_voice_violation"});
     closeVoice(true,"检测到疑似站外联系方式，语音已自动停止。");
     toast("检测到疑似站外联系方式，语音已自动停止。");
     return;
    }
    voiceRecentText=combined.slice(-120);voiceRecentAt=timestamp;
   };
   recognition.onerror=event=>{
    if(voiceRecognition!==recognition||generation!==voiceGeneration||event.error==="aborted"||event.error==="no-speech")return;
    closeVoice(false,"设备端语音识别中断，麦克风已关闭。");
    toast("设备端语音识别中断，已关闭麦克风以保护隐私。");
   };
   recognition.onend=()=>{
    if(voiceRecognition!==recognition||generation!==voiceGeneration||!localStream)return;
    const muted=localStream.getAudioTracks().every(track=>!track.enabled);
    if(!muted)setTimeout(()=>{if(voiceRecognition===recognition&&generation===voiceGeneration&&localStream){try{recognition.start()}catch{closeVoice(false,"设备端语音识别无法恢复，麦克风已关闭。");toast("设备端语音识别无法恢复，麦克风已关闭。")}}},300);
   };
   recognition.start();
  }
  async function startMic(){
   if(!me){toast("请先加入房间");return}
   if(!ws||ws.readyState!==1){toast("房间连接暂时中断，请等待重新连接");return}
   if(localStream){toast("麦克风已经开启");return}
   if(contactMutedUntil>Date.now()){toast("你暂时无法开启语音，请等待限制结束。");return}
   if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){toast("麦克风需要 HTTPS 安全连接，并使用支持的浏览器");setVoiceState("error","当前页面无法访问麦克风 · 请使用 HTTPS");return}
   const generation=voiceGeneration;
   els.voiceStart.disabled=true;setVoiceState("wait","正在检查设备端中文语音模型…");
   let stream=null;
   try{
    // 没有设备端中文模型时不降级到云端识别，也不会开启麦克风。
    const Speech=await prepareLocalSpeechRecognition();
    if(generation!==voiceGeneration||!me)return;
    // 只有点击此按钮才请求麦克风权限；绝不自动开麦。
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    if(generation!==voiceGeneration||!me){stream.getTracks().forEach(t=>t.stop());return}
    localStream=stream;
    const AudioContextClass=window.AudioContext||window.webkitAudioContext;
    if(!AudioContextClass)throw new Error("当前浏览器不支持受保护语音所需的 Web Audio。");
    voiceAudioContext=new AudioContextClass();
    await voiceAudioContext.resume();
    voiceSource=voiceAudioContext.createMediaStreamSource(stream);
    voiceDelay=voiceAudioContext.createDelay(2);
    voiceDelay.delayTime.value=1.6;
    voiceGate=voiceAudioContext.createGain();
    voiceGate.gain.value=1;
    voiceDestination=voiceAudioContext.createMediaStreamDestination();
    voiceSource.connect(voiceDelay);voiceDelay.connect(voiceGate);voiceGate.connect(voiceDestination);
    if(generation!==voiceGeneration||!me){closeVoice(false);return}
    const connection=await ensurePeerConnection();
    if(generation!==voiceGeneration||!me){closeVoice(false);return}
    const protectedTrack=voiceDestination.stream.getAudioTracks()[0];
    if(!protectedTrack)throw new Error("无法建立语音保护音轨。");
    connection.addTrack(protectedTrack,voiceDestination.stream);
    startLocalRecognition(Speech,generation);
    updateMicControls();
    setVoiceState("wait","设备端语音保护已开启 · 上行延迟约 1.6 秒 · 等待对方加入…");
    note("语音识别仅在本机处理，不上传录音或保存完整转写。为降低识别延迟带来的风险，语音上行增加约 1.6 秒缓冲。");
   }catch(e){
    if(stream&&localStream!==stream)stream.getTracks().forEach(t=>t.stop());
    if(generation!==voiceGeneration)return;
    const message=e?.message||"无法开启受保护语音";
    console.warn("受保护语音启动失败",e);
    closeVoice(false,message);
    toast(message);
   }
  }
  function closeVoice(notify=false,statusText="语音未开启 · 双方需分别授权"){
   if(notify)out({type:"voice_signal",kind:"hangup"});
   voiceGeneration++;
   stopLocalRecognition();
   if(voiceGate&&voiceAudioContext){try{voiceGate.gain.setValueAtTime(0,voiceAudioContext.currentTime)}catch{}}
   for(const node of [voiceSource,voiceDelay,voiceGate]){if(node){try{node.disconnect()}catch{}}}
   if(voiceDestination){voiceDestination.stream.getTracks().forEach(track=>track.stop());voiceDestination=null}
   voiceSource=null;voiceDelay=null;voiceGate=null;
   if(voiceAudioContext){const context=voiceAudioContext;voiceAudioContext=null;context.close().catch(()=>{})}
   const old=pc;pc=null;pcPromise=null;pendingCandidates=[];makingOffer=false;ignoreOffer=false;settingRemoteAnswerPending=false;
   if(old){old.ontrack=null;old.onicecandidate=null;old.onnegotiationneeded=null;try{old.close()}catch{}}
   if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}
   if(remoteStream){remoteStream.getTracks().forEach(t=>t.stop());remoteStream=null}
   els.remoteAudio.pause();els.remoteAudio.srcObject=null;els.voiceListen.hidden=true;
   updateMicControls();setVoiceState("",statusText);
   if(me){els.voiceStart.disabled=false;els.voiceHangup.disabled=true;els.voiceMute.disabled=true}
   else{els.voiceStart.disabled=true;els.voiceHangup.disabled=true;els.voiceMute.disabled=true}
  }
  async function handleVoiceSignal(m){
   if(!me||!m.from||m.from===me.id)return;
   if(m.kind==="hangup"){closeVoice(false,"对方已结束语音");note("对方结束了语音通话。");return}
   try{
    const connection=await ensurePeerConnection();
    if(m.kind==="candidate"){
     // 丢弃属于被忽略的碰撞 offer 的 ICE candidate。
     if(ignoreOffer||!m.candidate)return;
     if(!connection.remoteDescription)pendingCandidates.push(m.candidate);
     else{try{await connection.addIceCandidate(m.candidate)}catch(e){if(!ignoreOffer)throw e}}
     return;
    }
    if(m.kind==="description"&&m.description){
     const description=m.description;
     const polite=me.id.localeCompare(m.from)>0;
     const readyForOffer=!makingOffer&&(connection.signalingState==="stable"||settingRemoteAnswerPending);
     const offerCollision=description.type==="offer"&&!readyForOffer;
     ignoreOffer=!polite&&offerCollision;
     if(ignoreOffer){pendingCandidates=[];return;}
     settingRemoteAnswerPending=description.type==="answer";
     await connection.setRemoteDescription(description);
     settingRemoteAnswerPending=false;
     for(const candidate of pendingCandidates.splice(0)){
      try{await connection.addIceCandidate(candidate)}catch(e){if(!ignoreOffer)throw e}
     }
     if(description.type==="offer"){
      await connection.setLocalDescription();
      out({type:"voice_signal",kind:"description",description:connection.localDescription});
     }
     setVoiceState("wait","已收到语音邀请 · 正在连接…");
    }
   }catch(e){console.error("处理语音信令失败",e);setVoiceState("error","语音连接协商失败 · 请结束后重试")}
  }
  function handle(m){
   if(m.type==="room_ended"){
    reset(m.message||"本轮互动已结束，已自动退出房间");
   }else if(m.type==="watch_joined"){
    joining=false;watching=true;me=null;myRole=null;matchedRole=null;currentOpponentFriendCode="";currentOpponentNickname="";$("#metroAddFriendBtn").hidden=true;room=m.room;want=true;els.label.textContent=room;els.log.replaceChildren();seen=new Set();lastId=0;
    metroRunning=false;metroHasStarted=false;metroStopped=false;metroEndsAt=0;metroRemainingMs=(Number(els.metroDuration.value)||5)*60000;stopMetroTimer();clearMetroClocks();renderMetroState();
    showRoom(true);document.body.classList.add("watch-mode");setState("on","旁观中");els.roleStatus.textContent="观战模式：只读查看聊天与节拍状态，不能发送消息或控制挑战。";els.watchStatus.textContent="你正在旁观此房间；不会开启麦克风，也不能发送消息。";
    renderMembers(m.members,m.seats);els.watcherCount.textContent="旁观 "+(m.watchers||0);setVoiceState("","观战不包含语音旁听");
    const u=new URL(location.href);u.searchParams.set("room",room);u.hash="room";history.replaceState(null,"",u);
    clearInterval(hb);hb=setInterval(()=>out({type:"ping",lastId:0}),20000);
   }else if(m.type==="watch_state"){
    watchConsent=Boolean(m.optedIn);watchAllowed=Boolean(m.allowed);renderWatchUI();
   }else if(m.type==="watch_count"){
    els.watcherCount.textContent="旁观 "+(Number(m.count)||0);
   }else if(m.type==="watch_closed"){
    reset(m.message||"房间已关闭观战");
   }else if(m.type==="watch_left"){
    reset("已退出观战");
   }else if(m.type==="joined"){
    watching=false;document.body.classList.remove("watch-mode");watchConsent=Boolean(m.watchConsent);watchAllowed=Boolean(m.watchAllowed);joining=false;matching=false;stopMatchClock();showMatchingScreen(false);clearInterval(matchPoll);matchPoll=null;clearInterval(joinRetry);joinRetry=null;const fresh=!m.resumed||!me||me.id!==m.you.id;
    if(fresh){closeVoice(false);els.log.innerHTML="";seen=new Set();lastId=0;stopMetroTimer();clearMetroClocks();metroRunning=false;metroHasStarted=false;metroStopped=false;metroEndsAt=0;metroRemainingMs=(Number(els.metroDuration.value)||5)*60000;metroHoldCount=0;metroElapsedMs=0;metroEndReason="";$("#metroLivePanel").hidden=false;$("#metroEndScreen").hidden=true;metroBeat=0;$("#beatNumber").textContent="—";renderQuickPhrases()}
    me=m.you;myRole=m.you.role||"controller";matchedRole=null;matchClientId=null;currentOpponentFriendCode=String(m.opponentFriendCode||"");currentOpponentNickname=String(m.opponentNickname||"");$("#metroAddFriendBtn").hidden=!currentOpponentFriendCode;$("#metroAddFriendBtn").textContent=currentOpponentNickname?"添加 "+currentOpponentNickname+" 为好友":"添加对方为好友";renderQuickPhrases();room=m.room;iceConfigCache=null;localStorage.setItem(seatKey(room),m.token);localStorage.setItem("np_nick",me.nickname);
    const publishedNow=pendingPublish&&Boolean(m.isPublic);pendingPublish=false;pendingPublishName="";els.label.textContent=(m.roomName?m.roomName+" · ":"")+room;showRoom(true);if(publishedNow)toast("公开房间已发布，其他玩家现在可以加入");setState("on","已连接");setVoiceState("","语音未开启 · 双方需分别授权");renderWatchUI();els.watcherCount.textContent="旁观 "+(m.watchers||0);
    const u=new URL(location.href);u.searchParams.set("room",room);u.hash="room";history.replaceState(null,"",u);
    if(fresh&&!m.history.length)note("房间已就绪。把邀请链接发给另一位参与者吧。");
    m.history.forEach(render);renderMembers(m.members,m.seats);
    clearInterval(hb);hb=setInterval(()=>out({type:"ping",lastId}),20000);
    els.input.focus({preventScroll:true});
   }else if(m.type==="opponent_info"){currentOpponentFriendCode=String(m.friendCode||"");currentOpponentNickname=String(m.nickname||"");$("#metroAddFriendBtn").hidden=!currentOpponentFriendCode;$("#metroAddFriendBtn").textContent=currentOpponentNickname?"添加 "+currentOpponentNickname+" 为好友":"添加对方为好友";}
   else if(m.type==="message"){render(m.message)}
   
   else if(m.type==="presence"){renderMembers(m.members,m.seats)}
   else if(m.type==="metronome_state"){applyMetroRemote(m);note((m.nickname||"对方")+(m.stopped?"结束了寸止挑战":m.running?"开始/调整了寸止挑战":"暂停了寸止挑战"))}
   else if(m.type==="pong"){(m.missed||[]).forEach(render);if(m.members)renderMembers(m.members,m.seats)}
   else if(m.type==="typing"){els.typing.textContent=m.nickname+" 正在输入…";clearTimeout(typingTimer);typingTimer=setTimeout(()=>els.typing.textContent="",2500)}
   else if(m.type==="voice_signal"){handleVoiceSignal(m)}
   else if(m.type==="voice_peer_ready"){
    // 若本端先开麦、此前对方尚未上线，重发尚未送达的 offer。
    if(pc&&pc.signalingState==="have-local-offer"&&pc.localDescription?.type==="offer"){
     out({type:"voice_signal",kind:"description",description:pc.localDescription});
     setVoiceState("wait","对方已加入 · 正在连接语音…");
    }
   }
   else if(m.type==="voice_notice"){setVoiceState("wait",m.message||"等待另一位参与者上线");toast(m.message||"另一位参与者当前不在线")}
   else if(m.type==="contact_blocked"){
    contactMutedUntil=Math.max(contactMutedUntil,Number(m.mutedUntil)||0);
    if(m.source==="voice"||contactMutedUntil>Date.now())closeVoice(false,m.message||"语音/消息功能暂时受限。");
    toast(m.message||"检测到疑似站外联系方式，内容已拦截。");
   }
   else if(m.type==="left"){reset("已离开房间")}
   else if(m.type==="error"){
    if(m.code==="server_error"&&joining&&matchClientId&&want&&room){toast(m.message||"服务器暂时出错，正在重试进入房间…");return}
    clearInterval(joinRetry);joinRetry=null;joining=false;
    if(matchClientId){if(room)localStorage.removeItem(seatKey(room));reset(m.message||"自动进入房间失败，请重新匹配");return}
    if(["room_full","seat_lost","bad_room","bad_nickname","publish_room_exists","bad_room_name","room_expired"].includes(m.code)){
     if(m.code==="seat_lost"&&room)localStorage.removeItem(seatKey(room));
     if(m.code==="room_full"&&room)localStorage.removeItem(seatKey(room));
      if(m.code==="room_expired"&&room)localStorage.removeItem(seatKey(room));
     pendingPublish=false;pendingPublishName="";reset();
    }
    if(String(m.code||"").startsWith("watch_"))els.watchConsent.disabled=false;
    toast(m.message||"出错了");
   }
  }
  function reset(msg){matchClientId=null;clearInterval(joinRetry);joinRetry=null;stopMetro(false);closeVoice(false);currentOpponentFriendCode="";currentOpponentNickname="";$("#metroAddFriendBtn").hidden=true;watching=false;watchConsent=false;watchAllowed=false;document.body.classList.remove("watch-mode");showMatchingScreen(false);stopMatchClock();want=false;joining=false;matching=false;clearInterval(matchPoll);matchPoll=null;els.matchStart.disabled=false;els.matchCancel.disabled=true;els.connect.disabled=false;clearInterval(hb);hb=null;clearTimeout(retryTimer);me=null;myRole=null;matchedRole=null;showRoom(false);els.connect.disabled=false;if(ws){ws.onclose=null;try{ws.close()}catch{}ws=null}setState("off","未连接");if(msg)toast(msg);const u=new URL(location.href);u.searchParams.delete("room");history.replaceState(null,"",u)}
  let matchRequestBusy=false;
  async function matchmakingRequest(action,clientId,details={}){
   const response=await fetch("/api/matchmaking",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action,clientId,...details}),cache:"no-store",signal:AbortSignal.timeout(12000)});
   let data={};try{data=await response.json()}catch{}
   if(!response.ok)throw Object.assign(new Error(data.message||"匹配服务暂时不可用，请稍后重试。"),{status:response.status,code:data.code});
   return data;
  }
  function enterMatchedRoom(data,clientId){
   if(!matching||matchClientId!==clientId)return;
   if(!data?.room||!["controller","receiver"].includes(data.role)){
    returnToMatchSettings("匹配结果无效，请重新匹配");toast("匹配结果无效");return;
   }
   matching=false;stopMatchClock();clearInterval(matchPoll);matchPoll=null;matchRequestBusy=false;
   els.matchStart.disabled=false;els.matchCancel.disabled=true;$("#matchingCancelBtn").disabled=false;$("#matchingCancelBtn").textContent="正在进入房间…";els.matchStatus.textContent="匹配成功，正在进入房间…";$("#matchingStatus").textContent="匹配成功，正在进入房间…";
   room=String(data.room);els.code.value=room;matchedRole=data.role;lastId=0;seen=new Set();want=true;
   if(ws&&ws.readyState===1)sendJoin(clientId);else open();
   clearInterval(joinRetry);
   joinRetry=setInterval(()=>{if(joining&&want&&room){if(ws&&ws.readyState===1)sendJoin(clientId);else open()}else{clearInterval(joinRetry);joinRetry=null}},2500);
  }
  async function pollMatchmaking(clientId,initial=false){
   if(matchRequestBusy||!matching||matchClientId!==clientId)return;
   matchRequestBusy=true;
   try{
    const details=initial?{nickname:els.nick.value.trim(),gender:els.matchGender.value,preference:els.matchPreference.value,rolePreference:els.matchRole.value,voicePreference:els.matchVoicePreference.value,guestId}: {};
    const data=await matchmakingRequest(initial?"join":"poll",clientId,details);
    if(!matching||matchClientId!==clientId)return;
    if(data.state==="matched"){enterMatchedRoom(data,clientId);return}
    if(data.state==="missing"){returnToMatchSettings(data.message||"匹配请求已失效，请重新开始");return}
    if(data.state==="waiting"){
     els.matchStatus.textContent="正在寻找符合双方偏好的参与者…";$("#matchingStatus").textContent="正在寻找符合双方偏好的参与者…";
    }
   }catch(error){
    if(!matching||matchClientId!==clientId)return;
    if([400,403,404,409].includes(error.status)){returnToMatchSettings(error.message);toast(error.message)}
    else{$("#matchingStatus").textContent="匹配服务暂时连接不稳定，正在自动重试…";els.matchStatus.textContent="匹配服务暂时连接不稳定，正在自动重试…"}
   }finally{matchRequestBusy=false}
  }
  function startMatching(){
   watching=false;document.body.classList.remove("watch-mode");
   const nick=els.nick.value.trim();
   if(!nick){toast("请先填写昵称");els.nick.focus();return}
   matchClientId=crypto.randomUUID();matching=true;want=true;els.matchStart.disabled=true;els.matchCancel.disabled=false;els.connect.disabled=true;els.matchStatus.textContent="正在寻找性别、角色和语音偏好都符合的参与者…";
   stopMatchClock();matchStartedAt=Date.now();renderMatchingPreferences();$("#matchingStatus").textContent="正在连接匹配服务…";showMatchingScreen(true);updateMatchElapsed();matchClock=setInterval(updateMatchElapsed,1000);
   clearInterval(matchPoll);matchPoll=setInterval(()=>pollMatchmaking(matchClientId),2500);
   pollMatchmaking(matchClientId,true);
  }
  async function cancelMatching(){
   const clientId=matchClientId;
   if(!clientId){returnToMatchSettings("已取消匹配");return}
   els.matchCancel.disabled=true;$("#matchingCancelBtn").disabled=true;$("#matchingCancelBtn").textContent="正在取消匹配…";$("#matchingStatus").textContent="正在取消匹配…";els.matchStatus.textContent="正在取消匹配…";
   try{
    const data=await matchmakingRequest("cancel",clientId);
    if(data.state==="matched"){enterMatchedRoom(data,clientId);return}
    if(data.state==="cancelled"){matchClientId=null;matching=false;want=!!me;stopMatchClock();clearInterval(matchPoll);matchPoll=null;els.matchStart.disabled=false;els.matchCancel.disabled=true;$("#matchingCancelBtn").disabled=false;$("#matchingCancelBtn").textContent="取消匹配";els.matchStatus.textContent="已取消匹配";showMatchingScreen(false);openActionModal("match");return}
    throw new Error("无法确认取消状态，请重试。");
   }catch(error){
    els.matchCancel.disabled=false;$("#matchingCancelBtn").disabled=false;$("#matchingCancelBtn").textContent="取消匹配";$("#matchingStatus").textContent="取消请求失败，请再次点击取消。";toast(error.message);
   }
  }
  function join(){
   pendingPublish=false;pendingPublishName="";
   watching=false;document.body.classList.remove("watch-mode");
   const nick=els.nick.value.trim(),code=els.code.value.trim().toUpperCase();
   if(!nick){toast("请先填写昵称");els.nick.focus();return}
   if(!/^[A-Z0-9]{4,12}$/.test(code)){toast("房间代码需为 4–12 位字母或数字");els.code.focus();return}
   els.code.value=code;if(room!==code){closeVoice(false);lastId=0;seen=new Set();me=null}
   room=code;want=true;els.connect.disabled=true;setTimeout(()=>els.connect.disabled=false,1500);
   if(ws&&ws.readyState===1)sendJoin();else open();
  }
  function leave(){const leavingRoom=room;if(watching){want=false;clearTimeout(retryTimer);out({type:"watch_leave"});return}want=false;clearTimeout(retryTimer);if(metroRunning)stopMetro(true);closeVoice(true,"语音已结束");out({type:"leave"});if(leavingRoom)localStorage.removeItem(seatKey(leavingRoom));}
  function generateRoomCode(){const a="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";let s="";const r=crypto.getRandomValues(new Uint8Array(6));r.forEach(x=>s+=a[x%a.length]);return s}
  function randomCode(){els.code.value=generateRoomCode();peek()}
  function publishPublicRoom(){
   const publicNick=$("#publicRoomNickname").value.trim(),nick=publicNick||els.nick.value.trim(),name=$("#publicRoomName").value.trim().replace(/\s+/g," ").slice(0,20);
   if(!nick){toast("请先填写昵称");$("#publicRoomNickname").focus();return}
   els.nick.value=nick;localStorage.setItem("np_nick",nick);
   if(!name){toast("请先填写房间名称");$("#publicRoomName").focus();return}
   pendingPublish=true;pendingPublishName=name;matchedRole=null;els.roomRole.value=$("#publicRoomRole").value;els.code.value=generateRoomCode();
   closeVoice(false);lastId=0;seen=new Set();me=null;room=els.code.value;want=true;watching=false;joining=false;closeActionModal();
   if(ws&&ws.readyState===1)sendJoin();else open();
  }
  async function loadPublicRoomDirectory(){
   const list=$("#publicRoomList");if(!list)return;list.textContent="正在加载公开房间…";
   try{
    const response=await fetch("/api/public-rooms",{cache:"no-store"});if(!response.ok)throw new Error("request failed");
    const data=await response.json(),items=Array.isArray(data.rooms)?data.rooms:[];
    list.replaceChildren();
    if(!items.length){list.textContent="目前没有正在招募的公开房间。你可以发布一个房间等待其他玩家加入。";return}
    items.forEach(item=>{
     const card=document.createElement("article");card.className="public-room-card";
     const title=document.createElement("strong");title.textContent=item.name||"未命名房间";
     const host=document.createElement("p");host.textContent="房主："+(item.hostNickname||"访客")+" · "+(item.hostRole==="controller"?"控制方 S":"受控方 M");
     const meta=document.createElement("div");meta.className="room-card-meta";
     const code=document.createElement("span");code.textContent="房间 "+item.room;
     const status=document.createElement("span");status.textContent="等待加入 · 1 / 2";meta.append(code,status);
     const button=document.createElement("button");button.type="button";button.className="primary";button.textContent="加入房间";
     button.addEventListener("click",()=>{els.code.value=item.room;els.roomRole.value=item.hostRole==="controller"?"receiver":"controller";closeActionModal();join()});
     card.append(title,host,meta,button);list.appendChild(card);
    });
   }catch(e){list.textContent="公开房间暂时无法加载，请稍后重试。"}
  }
  let peekTimer;function peek(){clearTimeout(peekTimer);const c=els.code.value.trim().toUpperCase();if(!/^[A-Z0-9]{4,12}$/.test(c)){els.peek.textContent="";return}
   peekTimer=setTimeout(()=>fetch("/api/rooms/"+c).then(r=>r.ok?r.json():null).then(d=>{if(!d)return;els.peek.textContent=d.taken===0?"房间 "+c+" 空闲，加入后即创建。":d.full?"房间 "+c+" 已满（2/2）。如果你之前在这个房间，可直接重新加入。":"房间 "+c+" 有 1 位参与者在等你。"}).catch(()=>{}),350)}
  async function loadWatchDirectory(){
   const section=$("#watchDirectory"),list=$("#watchDirectoryList");section.hidden=false;list.textContent="正在查找开放观战的房间…";
   try{
    const response=await fetch("/api/watchable",{cache:"no-store"});if(!response.ok)throw new Error("请求失败");
    const data=await response.json(),rooms=Array.isArray(data.rooms)?data.rooms:[];
    list.replaceChildren();
    if(!rooms.length){list.textContent="目前没有双方都允许观战的在线房间。";return}
    rooms.forEach(item=>{
     const card=document.createElement("article");card.className="watch-room-card";
     const title=document.createElement("strong");title.textContent="房间 "+item.room;
     const players=document.createElement("p");players.textContent=(item.players||[]).map(p=>p.nickname+" · "+(p.role==="controller"?"控制方":"受控方")).join(" / ");
     const count=document.createElement("small");count.textContent="旁观人数 "+(Number(item.watchers)||0)+" / 12";
     const button=document.createElement("button");button.type="button";button.className="primary";button.textContent="进入旁观";button.addEventListener("click",()=>{els.code.value=item.room;openActionModal("join")});
     card.append(title,players,count,button);list.appendChild(card);
    });
   }catch(error){list.textContent="暂时无法加载观战列表，请稍后刷新。"}
  }
  // 绑定事件
  $("#watchDirectoryBtn").onclick=()=>{loadWatchDirectory();$("#watchDirectory").scrollIntoView({behavior:"smooth",block:"center"})};
  $("#watchRefreshBtn").onclick=loadWatchDirectory;
  loadWatchDirectory();
  $("#publicRoomPublishBtn").onclick=publishPublicRoom;
  $("#publicRoomRefreshBtn").onclick=loadPublicRoomDirectory;
  loadPublicRoomDirectory();
  $("#publicRoomNickname").value=localStorage.getItem("np_nick")||"";
  $("#publicRoomNickname").addEventListener("input",()=>{const value=$("#publicRoomNickname").value;els.nick.value=value;localStorage.setItem("np_nick",value)});
  $("#publicRoomNavBtn").onclick=()=>$("#publicPanel").scrollIntoView({behavior:"smooth",block:"start"});
  $("#joinForm").onsubmit=e=>{e.preventDefault();join()};
  els.matchStart.onclick=startMatching;
  els.matchCancel.onclick=cancelMatching;
  $("#matchingCancelBtn").onclick=cancelMatching;
  $("#randomCodeBtn").onclick=randomCode;
  $("#watchJoinBtn").onclick=joinAsWatcher;
  els.watchConsent.onclick=()=>{if(!me||!roomHasPartner)return;els.watchConsent.disabled=true;out({type:"watch_consent",open:!watchConsent})};
  els.code.oninput=peek;
  $("#disconnectBtn").addEventListener("click",()=>{try{leave()}catch(err){console.error("离开房间清理失败",err)}});
  $("#copyLinkBtn").onclick=()=>{const u=new URL(location.origin+location.pathname);u.searchParams.set("room",room);u.hash="room";const t=u.toString();(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(()=>toast("邀请链接已复制"),()=>{prompt("复制邀请链接：",t)})};
  $("#chatForm").onsubmit=e=>{e.preventDefault();sendChat(els.input.value)};
  els.input.oninput=()=>{if(me&&els.input.value)out({type:"typing"})};
  const syncMetroSettings=()=>{if(me&&myRole==="controller")out(metroPayload());};
  els.bpm.oninput=()=>{if(myRole!=="controller")return;updateMetroLabels();restartMetroInterval()};
  els.bpm.onchange=syncMetroSettings;
  els.intensity.oninput=()=>{if(myRole==="controller")updateMetroLabels()};
  els.intensity.onchange=syncMetroSettings;
  const setCueBpm=value=>{if(myRole!=="controller"||!me)return;els.bpm.value=String(value);updateMetroLabels();restartMetroInterval();syncMetroSettings()};
  els.metroSlow.onclick=()=>setCueBpm(55);els.metroNormal.onclick=()=>setCueBpm(75);els.metroFast.onclick=()=>setCueBpm(110);
  els.metroHold.onclick=()=>{if(myRole==="controller"&&metroRunning){metroHoldCount++;pauseMetro(true)}};
  els.metroResume.onclick=()=>{if(myRole==="controller")startMetro(true)};
  els.metroMode.onchange=()=>{metroModeValue=els.metroMode.value;syncMetroSettings();if(metroRunning)startMetroClocks()};
  els.metroDifficulty.onchange=()=>{metroDifficultyValue=els.metroDifficulty.value;syncMetroSettings();if(metroRunning)startMetroClocks()};
  els.metroDuration.onchange=()=>{metroDurationMinutes=Number(els.metroDuration.value)||5;if(!metroHasStarted)metroRemainingMs=metroDurationMinutes*60000;updateMetroCountdown();syncMetroSettings()};
  els.metroStart.onclick=()=>{if(!me){toast("请先进入双人房间");return}if(myRole!=="controller"){toast("只有控制方可以开始挑战");return}startMetro(true)};
  els.metroPause.onclick=()=>{if(myRole==="controller")pauseMetro(true)};
  els.metroStop.onclick=()=>{if(myRole==="controller")stopMetro(true)};
  els.metroEmergency.onclick=()=>{if(!me)return;if(metroRunning&&metroEndsAt)metroRemainingMs=Math.max(0,metroEndsAt-Date.now());metroElapsedMs=Math.max(metroElapsedMs,metroDurationMinutes*60000-metroRemainingMs);metroStopped=true;metroRunning=false;metroEndsAt=0;stopMetroTimer();clearMetroClocks();stopMetro(false);out({type:"metronome_emergency_stop"});};
  $("#metroAddFriendBtn").onclick=()=>{if(!currentOpponentFriendCode){toast("暂时无法获取对方的好友资料");return}sendFriendRequest(currentOpponentFriendCode)};
  $("#metroRestartBtn").onclick=()=>{metroStopped=false;metroHasStarted=false;metroRunning=false;metroHoldCount=0;metroElapsedMs=0;metroRemainingMs=(Number(els.metroDuration.value)||5)*60000;metroEndsAt=0;$("#metroLivePanel").hidden=false;$("#metroEndScreen").hidden=true;$("#beatNumber").textContent="—";renderMetroState()};
  $("#metroHomeBtn").addEventListener("click",()=>{try{leave()}catch(err){console.error("返回主页前清理失败",err)}});
  updateMetroLabels();renderMetroState();
  els.voiceStart.onclick=startMic;
  els.voiceMute.onclick=()=>{
   if(!localStream)return;
   const tracks=localStream.getAudioTracks(),next=tracks.some(t=>t.enabled);
   tracks.forEach(t=>t.enabled=!next);
   if(voiceGate&&voiceAudioContext)voiceGate.gain.setTargetAtTime(next?0:1,voiceAudioContext.currentTime,0.02);
   if(next)stopLocalRecognition();
   else if(localSpeechReady){try{startLocalRecognition(window.SpeechRecognition||window.webkitSpeechRecognition,voiceGeneration)}catch(e){closeVoice(false,"无法恢复设备端语音识别，麦克风已关闭。");toast("无法恢复设备端语音识别，麦克风已关闭。")}}
   updateMicControls();setVoiceState("on",next?"麦克风已静音":"麦克风已开启");
  };
  els.voiceHangup.onclick=()=>{closeVoice(true,"语音已结束")};
  els.voiceListen.onclick=()=>{els.remoteAudio.play().then(()=>{els.voiceListen.hidden=true}).catch(()=>toast("浏览器暂时无法播放对方声音"))};
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&want&&(!ws||ws.readyState>1)){retry=0;clearTimeout(retryTimer);open()}});
  window.addEventListener("online",()=>{if(want&&(!ws||ws.readyState>1)){retry=0;clearTimeout(retryTimer);open()}});
  // 初始化：昵称、邀请链接
  els.nick.value=localStorage.getItem("np_nick")||"";
  const q=new URLSearchParams(location.search).get("room");
  if(q&&/^[A-Za-z0-9]{4,12}$/.test(q)){els.code.value=q.toUpperCase();peek()}else randomCode();
  return {join,hasInvite:!!q,autoResume:()=>{const c=els.code.value;if(q&&els.nick.value&&localStorage.getItem(seatKey(c)))join()}};
 })();
document.querySelectorAll('a[href="#room"],a[href="#challenge"]').forEach(a=>a.addEventListener("click",e=>{if(!$("#roomView").hidden){return}if(a.getAttribute("href")==="#challenge"){e.preventDefault();$("#room").scrollIntoView({behavior:"smooth"})}}));
setTimeout(()=>Room.autoResume(),0);
