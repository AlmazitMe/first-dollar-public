'use strict';
/* Lambadina local-first transcript workspace.
   No network calls, no external code, no telemetry and no user data embedded.
   Exported ChatGPT content is loaded locally by the user, never fetched.
 */
(function () {
 const $ = id => document.getElementById(id);
 const DBNAME='LambadinaEncryptedWorkspace';
 const STORE='encrypted';
 const RECORD='local-editor';
 const MAX_JSON=85*1024*1024;
 let state={title:'Lambadina — מחקר חי',messages:[],versions:[],source:'manual'};
 let candidates=null;
 let encryptedBackup=null;
 let key=null, salt=null;
 let mode='full', timer=null, noticeTimer=null, currentSearch='';
 let saveQueue=Promise.resolve();
 const enc=new TextEncoder(), dec=new TextDecoder();
 function token(){return 'm'+Math.random().toString(36).slice(2,12)}
 function clone(obj){return JSON.parse(JSON.stringify(obj))}
 function tell(msg,error=false){
   const el=$('notice');el.textContent=msg;el.classList.remove('hidden');
   el.classList.toggle('error',error);clearTimeout(noticeTimer);
   noticeTimer=setTimeout(()=>el.classList.add('hidden'),6500);
 }
 function safeName(text){return (text||'Lambadina').replace(/[^\p{L}\p{N}_-]+/gu,'-').slice(0,64)||'Lambadina'}
 function download(name,text,mime){
   const url=URL.createObjectURL(new Blob([text],{type:mime||'text/plain;charset=utf-8'}));
   const a=document.createElement('a');a.href=url;a.download=name;a.style.display='none';
   document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),15000);
 }
 function allText(){return state.messages.map(m=>'⟦LMB|'+m.role+'|'+m.id+'⟧\n'+m.text).join('\n\n')}
 function decodeText(raw){
   const re=/^⟦LMB\|(user|assistant|note)\|([a-zA-Z0-9-]{2,60})⟧[ \t]*\r?$/gm;
   const marks=[...raw.matchAll(re)];
   if(!marks.length)return raw.trim()? [{role:'note',id:token(),text:raw}]:[];
   const out=[];
   if(marks[0].index>0&&raw.slice(0,marks[0].index).trim()){
     out.push({role:'note',id:token(),text:raw.slice(0,marks[0].index).trimEnd()});
   }
   const used=new Set();
   marks.forEach((match,i)=>{
     const start=match.index+match[0].length;
     const end=i+1<marks.length?marks[i+1].index:raw.length;
     let id=match[2];if(used.has(id))id=token();used.add(id);
     const content=raw.slice(start,end).replace(/^\r?\n/,'').replace(/\r?\n{2}$/,'');
     out.push({role:match[1],id,text:content});
   });
   return out;
 }
 function stats(){
   $('titleLabel').textContent=state.title;
   $('msgCount').textContent=String(state.messages.length);
   $('wordCount').textContent=String((state.messages.map(x=>x.text).join(' ').match(/\S+/gu)||[]).length);
   $('versionCount').textContent=String(state.versions.length);
   $('lockIndicator').textContent=key?'מוצפן · שמירה מקומית פעילה':'נעול · שינויים בזיכרון בלבד';
   $('dirty').textContent=key?'שמירה מוצפנת אוטומטית':'לא יישמר לאחר סגירת הדף — ייצא קובץ';
   const select=$('snapshots'),chosen=select.value;
   select.replaceChildren();
   if(!state.versions.length){const opt=new Option('אין גרסאות','');select.append(opt)}
   for(let i=state.versions.length-1;i>=0;i--){
     const v=state.versions[i],o=new Option(v.at.slice(0,19).replace('T',' ')+' — '+v.reason,String(i));
     select.append(o);
   }
   if([...select.options].some(o=>o.value===chosen))select.value=chosen;
 }
 function snapshot(reason='שמירה ידנית'){
   if(!state.messages.length){tell('לא קיים טקסט לשמירת גרסה');return}
   state.versions.push({at:new Date().toISOString(),reason,
                       messages:clone(state.messages),title:state.title});
   state.versions=state.versions.slice(-12);
   stats();scheduleSave();tell('הגרסה נשמרה בעותק העבודה'+(key?' המוצפן':' הזמני'));
 }
 function showFull(){
   $('fullEditor').value=allText();$('fullEditor').classList.remove('hidden');
   $('cards').classList.add('hidden');mode='full';
   $('view').textContent='תצוגת כרטיסים';stats();
 }
 function card(label,text,role){
   const wrapper=document.createElement('div');wrapper.className='card '+role;
   const h=document.createElement('div');h.className='cardhead';
   const title=document.createElement('span');title.textContent=label;
   const actions=document.createElement('div');actions.className='actions';
   const tx=document.createElement('textarea');tx.value=text;tx.dir='auto';
   return {wrapper,h,title,actions,tx};
 }
 function showCards(){
   const host=$('cards');host.replaceChildren();
   state.messages.forEach((m,index)=>{
     const ui=card('#'+(index+1)+' · '+(m.role==='user'?'משתמש':m.role==='assistant'?'מנהל':'הערה'),m.text,m.role);
     for(const [label,handler] of [
       ['↑',()=>move(index,-1)],['↓',()=>move(index,1)],['✕',()=>remove(index)]]) {
       const b=document.createElement('button');b.type='button';b.className='tiny';
       b.textContent=label;b.setAttribute('aria-label',label==='✕'?'מחיקה':label==='↑'?'העבר למעלה':'העבר למטה');
       b.addEventListener('click',handler);ui.actions.append(b);
     }
     ui.tx.addEventListener('input',()=>{m.text=ui.tx.value;stats();scheduleSave()});
     ui.h.append(ui.title,ui.actions);ui.wrapper.append(ui.h,ui.tx);host.append(ui.wrapper);
   });
   host.classList.remove('hidden');$('fullEditor').classList.add('hidden');
   $('view').textContent='עריכת כל הטקסט';mode='cards';stats();
 }
 function move(index,by){
   const other=index+by;if(other<0||other>=state.messages.length)return;
   [state.messages[index],state.messages[other]]=[state.messages[other],state.messages[index]];
   showCards();scheduleSave();
 }
 function remove(index){
   if(!confirm('למחוק הודעה מהעותק הערוך? ההודעה המקורית ב־ChatGPT לא תשתנה.'))return;
   state.messages.splice(index,1);showCards();scheduleSave();
 }
 function scheduleSave(){
   clearTimeout(timer);
   if(key)timer=setTimeout(()=>saveEncrypted().catch(e=>tell('כשל בשמירה המוצפנת: '+e.message,true)),1000);
 }
 function openDatabase(){
   return new Promise((resolve,reject)=>{
     if(!('indexedDB' in window)){reject(new Error('הדפדפן אינו תומך בשמירה מקומית'));return}
     const request=indexedDB.open(DBNAME,1);
     request.onupgradeneeded=()=>request.result.createObjectStore(STORE);
     request.onsuccess=()=>resolve(request.result);
     request.onerror=()=>reject(request.error);
   });
 }
 async function idbGet(recordKey=RECORD){
   const db=await openDatabase();
   return new Promise((resolve,reject)=>{
     const tx=db.transaction(STORE,'readonly');const req=tx.objectStore(STORE).get(recordKey);
     req.onsuccess=()=>resolve(req.result||null);
     req.onerror=()=>reject(req.error);
     tx.oncomplete=()=>db.close();
   });
 }
 async function idbPut(value,recordKey=RECORD){
   const db=await openDatabase();
   return new Promise((resolve,reject)=>{
     const tx=db.transaction(STORE,'readwrite');
     tx.objectStore(STORE).put(value,recordKey);
     tx.oncomplete=()=>{db.close();resolve()};
     tx.onerror=()=>reject(tx.error);
     tx.onabort=()=>reject(tx.error||new Error('storage aborted'));
   });
 }
 async function idbDelete(recordKey=RECORD){
   const db=await openDatabase();
   return new Promise((resolve,reject)=>{
     const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).delete(recordKey);
     tx.oncomplete=()=>{db.close();resolve()};
     tx.onerror=()=>reject(tx.error);
   });
 }
 const b64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=20000)s+=String.fromCharCode(...bytes.slice(i,i+20000));return btoa(s)};
 const from64=s=>Uint8Array.from(atob(s),x=>x.charCodeAt(0));
 async function derive(password,saltBytes){
   if(!crypto.subtle)throw new Error('נדרש דפדפן מאובטח התומך בהצפנת WebCrypto');
   const material=await crypto.subtle.importKey('raw',enc.encode(password),{name:'PBKDF2'},false,['deriveKey']);
   return crypto.subtle.deriveKey({name:'PBKDF2',salt:saltBytes,iterations:310000,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 }
 async function seal(document,keyMaterial,saltBytes){
   const iv=crypto.getRandomValues(new Uint8Array(12));
   const bytes=enc.encode(JSON.stringify(document));
   const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},keyMaterial,bytes));
   return {format:'LMB-ENCRYPTED-EDITOR-v1',algorithm:'PBKDF2-SHA256-310000/AES-256-GCM',
           salt:b64(saltBytes),iv:b64(iv),ciphertext:b64(cipher)};
 }
 async function openSeal(envelope,password){
   if(envelope.format!=='LMB-ENCRYPTED-EDITOR-v1'||typeof envelope.ciphertext!=='string')
     throw new Error('פורמט כספת לא נתמך');
   const s=from64(envelope.salt);
   const derived=await derive(password,s);
   const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:from64(envelope.iv)},
                                       derived,from64(envelope.ciphertext));
   const obj=JSON.parse(dec.decode(plain));
   if(!obj||!Array.isArray(obj.messages)||!Array.isArray(obj.versions))
     throw new Error('התוכן המוצפן אינו מסמך Lambadina תקין');
   return {obj,derived,s};
 }
 async function saveEncrypted(){
   if(!key||!salt)return;
   const snapshot=clone(state),activeKey=key,activeSalt=salt;
   const operation=saveQueue.then(async()=>{
     await idbPut(await seal(snapshot,activeKey,activeSalt));
     $('lockIndicator').textContent='מוצפן · נשמר במכשיר';
     $('lastSave').textContent=new Date().toLocaleTimeString('he-IL');
     $('dbStatus').textContent='נמצא עותק מוצפן';
   });
   saveQueue=operation.catch(()=>{});
   return operation;
 }
 async function decryptWithActiveKey(envelope){
   if(!key||!envelope)throw new Error('פתח את הכספת תחילה');
   if(envelope.format!=='LMB-ENCRYPTED-EDITOR-v1')throw new Error('פורמט נתונים לא תקין');
   const buf=await crypto.subtle.decrypt({name:'AES-GCM',iv:from64(envelope.iv)},key,from64(envelope.ciphertext));
   return JSON.parse(dec.decode(buf));
 }
 async function updateStorageInfo(){
   try{
     const envelope=await idbGet();
     $('dbStatus').textContent=envelope?'נמצא עותק מוצפן':'אין עדיין עותק';
     if(navigator.storage&&navigator.storage.estimate){
       const usage=await navigator.storage.estimate();
       $('storageUsage').textContent=Math.round((usage.usage||0)/1024)+' KB';
     }
     if(navigator.storage&&navigator.storage.persisted)
       $('storageStatus').textContent=(await navigator.storage.persisted())?'שמירה מועדפת אושרה':'אין התחייבות לשמירה';
     else $('storageStatus').textContent='הדפדפן אינו מדווח';
   }catch(e){
     $('dbStatus').textContent='שגיאת מסד נתונים: '+e.message;
   }
 }
 async function requestPersistence(){
   if(!navigator.storage||!navigator.storage.persist)throw new Error('הדפדפן לא תומך בבקשה לשמירה מועדפת');
   const ok=await navigator.storage.persist();
   await updateStorageInfo();
   tell(ok?'שמירה מועדפת אושרה. היא אינה מחליפה גיבוי.':'שמירה מועדפת לא אושרה. ייצא גיבוי מוצפן.',!ok);
 }
 async function verifyDb(){
   if(!key||!salt)throw new Error('פתח כספת מקומית לפני הבדיקה');
   if(mode==='full')state.messages=decodeText($('fullEditor').value);
   clearTimeout(timer);await saveEncrypted();await saveQueue;
   const found=await idbGet('db-canary');
   if(found){
     const canary=await decryptWithActiveKey(found);
     if(canary.test!=='LAMBADINA_REOPEN_V1'||!canary.nonce)
       throw new Error('רשומת הבדיקה אינה תקינה');
     const main=await decryptWithActiveKey(await idbGet());
     if(JSON.stringify(main.messages)!==JSON.stringify(state.messages))
       throw new Error('השחזור אינו תואם לעותק העבודה');
     await idbDelete('db-canary');
     $('dbStatus').textContent='✅ שחזור אחרי פתיחה מחדש עבר';
     tell('בדיקת שחזור עברה לאחר פתיחת הכספת. מומלץ גיבוי מוצפן מחוץ לטלפון.');
   }else{
     const payload={test:'LAMBADINA_REOPEN_V1',nonce:b64(crypto.getRandomValues(new Uint8Array(24)))};
     await idbPut(await seal(payload,key,salt),'db-canary');
     const verification=await decryptWithActiveKey(await idbGet('db-canary'));
     if(verification.nonce!==payload.nonce)throw new Error('בדיקת כתיבה/קריאה נכשלה');
     $('dbStatus').textContent='✅ קריאה וכתיבה עברו; נדרש רענון ושחזור';
     tell('שלב ראשון עבר. רענן את הדף, פתח כספת עם הסיסמה ולחץ שוב על בדיקת מסד הנתונים.');
   }
 }
 async function unlock(){
   const password=$('passphrase').value;
   if(password.length<12)throw new Error('יש להזין סיסמת הצפנה באורך 12 תווים לפחות');
   const existing=encryptedBackup||await idbGet();
   if(existing){
     if(state.messages.length&&!confirm('נמצאה כספת קיימת. פתיחתה תחליף את עותק העבודה שאינו שמור. להמשיך?'))return;
     const opened=await openSeal(existing,password);
     state=opened.obj;key=opened.derived;salt=opened.s;encryptedBackup=null;
   }else{
     salt=crypto.getRandomValues(new Uint8Array(16));key=await derive(password,salt);
     await saveEncrypted();
   }
   $('passphrase').value='';showFull();tell('הכספת המקומית מוצפנת ופתוחה במכשיר זה');
 }
 async function lock(){
   clearTimeout(timer);
   if(key)await saveEncrypted();
   await saveQueue;
   key=null;salt=null;
   state={title:'Lambadina — מחקר חי',messages:[],versions:[],source:'manual'};
   showFull();tell('העותק בזיכרון ננעל. כדי לפתוח, הזן את הסיסמה.');
 }
 function exportMarkdown(){
   const pre='# '+state.title+'\n\n'+'<!-- Lambadina edited transcript; original ChatGPT history unchanged -->\n\n';
   download(safeName(state.title)+'.md',pre+state.messages.map((m,i)=>'### '+(i+1)+'. '+m.role+'\n\n'+m.text).join('\n\n---\n\n'),'text/markdown;charset=utf-8');
   tell('עותק Markdown נשמר בתיקיית ההורדות');
 }
 function exportJSON(){
   download(safeName(state.title)+'.json',
            JSON.stringify({format:'LMB_WORKSPACE_v1',exported_at:new Date().toISOString(),state},null,2),
            'application/json;charset=utf-8');
   tell('עותק JSON עם גרסאות נשמר. קובץ זה אינו מוצפן — שמור אותו במקום בטוח.');
 }
 async function encryptedExport(){
   const password=$('passphrase').value;
   if(!key&&!password)throw new Error('תחילה הפעל כספת מוצפנת או הזן סיסמה');
   let envelope;
   if(key&&!password)envelope=await seal(state,key,salt);
   else if(password.length>=12){
     const randomSalt=crypto.getRandomValues(new Uint8Array(16));
     envelope=await seal(state,await derive(password,randomSalt),randomSalt);
   }else throw new Error('סיסמת הגיבוי חייבת להיות באורך 12 תווים לפחות');
   download(safeName(state.title)+'.lmb',JSON.stringify(envelope),'application/json;charset=utf-8');
   tell('גיבוי מוצפן נוצר. הוא ייפתח רק עם סיסמת ההצפנה שהגדרת.');
 }
 function showContext(){
   const all=state.messages.filter(m=>m.text.trim());
   let context='Lambadina — הקשר מחקרי שנערך ונבדק ידנית\n';
   context+='זהו עותק ערוך, לא היסטוריית ChatGPT המקורית. אין להתייחס לטענות כמאומתות ללא מקורות.\n\n';
   let size=context.length,added=0;
   for(let i=all.length-1;i>=0&&size<20000;i--){
      let chunk=(all[i].role==='user'?'משתמש':all[i].role==='assistant'?'מנהל':'הערה')+': '+all[i].text+'\n\n';
      if(chunk.length+size>20000)chunk=chunk.slice(0,20000-size);
      context=chunk+context;size+=chunk.length;added++;
   }
   context='להמשך מחקר Lambadina — קטע מתוך '+state.title+' ('+added+' הודעות נבחרו מסוף התמליל):\n\n'+context+
           '\nלפני שליחה: בדוק שאין כאן פרטים משפחתיים, לקוחות, סודות, תשלומים או מידע אישי.';
   $('contextBox').value=context;$('contextBox').classList.remove('hidden');
   $('copyContext').classList.remove('hidden');$('contextBox').scrollIntoView({behavior:'smooth',block:'center'});
   tell('הוכן טקסט. חובה לבדוק פרטיות ודיוק לפני הדבקה ב־ChatGPT.');
 }
 function auditManager(){
   if(mode==='full')state.messages=decodeText($('fullEditor').value);
   const manager=state.messages.filter(m=>m.role==='assistant').map(m=>m.text);
   const claims=manager.filter(s=>/(אומת|הוכח|בוצע|הצלחה|הכנסה|רווח|התחבר|הושלם)/.test(s));
   const evidence=manager.filter(s=>/(https:\/\/|מקור|ראיה|יומן הרצה|מסמך אימות|מספר עסקה)/.test(s));
   const limits=manager.filter(s=>/(טרם|לא אומת|לא הוכח|מגבלה|עדיין|נדרש לבדוק)/.test(s));
   const total=manager.length;
   $('contextBox').value=[
     'Lambadina — מבקר צמוד למנהל־העל (ניתוח טקסט תפעולי בלבד)',
     'הודעות מנהל שנותחו: '+total,
     'הודעות המכילות טענת הצלחה או כסף: '+claims.length,
     'הודעות המזכירות מקור או ראיה: '+evidence.length,
     'הודעות המכירות במגבלות ובאי־ודאות: '+limits.length,
     '',
     'טענות לביקורת אנושית ולאימות חיצוני:',
     ...claims.slice(0,6).map((s,i)=>(i+1)+'. '+s.slice(0,260)),
     '',
     'אין להסיק שמקור המוזכר בתשובה אכן מאמת אותה ללא בדיקה.',
     'המבקר אינו מודל פסיכולוגי, אינו לומד ממכירות, ואינו בודק נתוני תשלום.'
   ].join('\n');
   $('contextBox').classList.remove('hidden');$('copyContext').classList.remove('hidden');
   $('contextBox').scrollIntoView({behavior:'smooth',block:'center'});
   tell('נוצר דוח ביקורת מקומי על הודעות המנהל בלבד.');
 }
 function findReplace(){
   const search=$('search').value,replacement=$('replace').value;
   if(!search){tell('יש לכתוב מונח לחיפוש',true);return}
   const changes=state.messages.reduce((sum,m)=>sum+(m.text.split(search).length-1),0);
   if(!changes){tell('לא נמצאו התאמות');return}
   if(!confirm('להחליף '+changes+' מופעים בעותק המחקר הערוך?'))return;
   snapshot('לפני החלפה גורפת');
   state.messages.forEach(m=>{m.text=m.text.split(search).join(replacement)});
   mode==='cards'?showCards():showFull();scheduleSave();
   tell('הוחלפו '+changes+' מופעים. גרסת הגיבוי נשמרה.');
 }
 function restore(){
   const index=Number($('snapshots').value),snapshot=state.versions[index];
   if(!snapshot){tell('בחר גרסה');return}
   if(!confirm('לשחזר גרסה זו? השינויים מאז הגרסה יוחלפו.'))return;
   if(state.messages.length)state.versions.push({at:new Date().toISOString(),reason:'לפני שחזור',
                                title:state.title,messages:clone(state.messages)});
   state.messages=clone(snapshot.messages);state.title=snapshot.title;state.versions=state.versions.slice(-12);
   showFull();scheduleSave();tell('הגרסה שוחזרה מתוך עותק העבודה');
 }
 function compare(){
   const index=Number($('snapshots').value),snap=state.versions[index];
   if(!snap){tell('אין גרסה להשוואה',true);return}
   const previous=new Map(snap.messages.map(m=>[m.id,m]));
   let added=0,edited=0;const details=[];
   for(const m of state.messages){
     const old=previous.get(m.id);
     if(!old){added++;continue}
     if(old.text!==m.text||old.role!==m.role){
       edited++;
       details.push('הודעה '+m.id+': \nלפני: '+old.text.slice(0,180)+'\nאחרי: '+m.text.slice(0,180));
     }
   }
   const removed=snap.messages.filter(m=>!state.messages.some(n=>n.id===m.id)).length;
   $('contextBox').value='השוואת Lambadina · '+snap.at+'\nנוספו: '+added+
     ' | שונו: '+edited+' | הוסרו: '+removed+'\n\n'+details.slice(0,25).join('\n\n---\n\n');
   $('contextBox').classList.remove('hidden');$('copyContext').classList.remove('hidden');
   $('contextBox').scrollIntoView({behavior:'smooth',block:'nearest'});
 }
 function getText(message){
   const content=message&&message.content;
   if(!content)return '';
   if(typeof content==='string')return content;
   if(typeof content.text==='string')return content.text;
   if(Array.isArray(content.parts)){
     return content.parts.map(part=>{
       if(typeof part==='string')return part;
       if(part&&typeof part.text==='string')return part.text;
       return '';
     }).filter(Boolean).join('\n');
   }
   return '';
 }
 function conversationToMessages(conv){
   const nodes=conv.mapping||{},path=[];
   if(conv.current_node&&nodes[conv.current_node]){
     let node=conv.current_node,seen=new Set();
     while(node&&nodes[node]&&!seen.has(node)){
       seen.add(node);path.push(nodes[node]);node=nodes[node].parent;
       if(path.length>7000)break;
     }
     path.reverse();
   }else{
     path.push(...Object.values(nodes).sort((a,b)=>(a.message?.create_time||0)-(b.message?.create_time||0)));
   }
   const out=[];
   for(const n of path){
     const m=n.message;if(!m||!m.author)continue;
     const role=m.author.role;
     if(role!=='user'&&role!=='assistant')continue;
     if(m.recipient&&m.recipient!=='all')continue;
     if(m.metadata?.is_visually_hidden_from_conversation)continue;
     const ch=m.metadata?.message_type||m.metadata?.channel;
     if(ch==='analysis'||ch==='justify'||ch==='confidence')continue;
     const text=getText(m);if(!text.trim())continue;
     out.push({role,id:token(),text});
   }
   return out;
 }
 async function loadImported(parsed,title){
   if(parsed&&parsed.format==='LMB_WORKSPACE_v1'&&parsed.state){
      if(!Array.isArray(parsed.state.messages)||!Array.isArray(parsed.state.versions))
       throw new Error('קובץ גיבוי מחקר לא תקין');
      if(state.messages.length&&!confirm('להחליף את המסמך הנוכחי בקובץ המיובא?'))return;
      state=parsed.state;showFull();scheduleSave();tell('מסמך מחקר יובא בהצלחה');return;
   }
   const conversations=Array.isArray(parsed)?parsed:
                       Array.isArray(parsed.conversations)?parsed.conversations:null;
   if(conversations){
     const actual=conversations.filter(c=>c&&c.mapping);
     if(!actual.length)throw new Error('לא נמצאו שיחות עם טקסט בפורמט ChatGPT');
     candidates=actual;
     const selector=$('conversationSelect');selector.replaceChildren();
     actual.forEach((c,i)=>selector.add(new Option((c.title||'שיחה ללא כותרת').slice(0,110)+' · '+new Date((c.create_time||0)*1000).toLocaleDateString('he-IL'),String(i))));
     $('conversationPicker').classList.remove('hidden');
     tell('זוהו '+actual.length+' שיחות. בחר אחת; רק התוכן שלה יועתק לעבודה.');return;
   }
   if(parsed&&parsed.mapping){
     candidates=[parsed];$('conversationPicker').classList.remove('hidden');
     $('conversationSelect').replaceChildren(new Option(parsed.title||title,'0'));
     tell('השיחה מוכנה לטעינה');return;
   }
   throw new Error('פורמט לא מוכר — נדרש ChatGPT conversations.json או גיבוי Lambadina');
 }
 async function zipConversations(file){
   // Central directory parser; reads only JSON entries, never extracts any files to disk.
   const tlen=Math.min(file.size,66000);
   const tail=new DataView(await file.slice(file.size-tlen).arrayBuffer());
   let eocd=-1;
   for(let i=tlen-22;i>=0;i--){if(tail.getUint32(i,true)===0x06054b50){eocd=i;break}}
   if(eocd<0)throw new Error('קובץ ZIP אינו תקין או אינו נתמך');
   const entries=tail.getUint16(eocd+10,true),offset=tail.getUint32(eocd+16,true),
         size=tail.getUint32(eocd+12,true);
   if(entries>35000||size>15*1024*1024)throw new Error('ספריית ZIP גדולה מדי');
   const central=new DataView(await file.slice(offset,offset+size).arrayBuffer());
   let pos=0;const targets=[];
   for(let i=0;i<entries;i++){
     if(pos+46>central.byteLength||central.getUint32(pos,true)!==0x02014b50)throw new Error('ZIP directory invalid');
     const method=central.getUint16(pos+10,true),
           compressed=central.getUint32(pos+20,true),unpacked=central.getUint32(pos+24,true),
           namelen=central.getUint16(pos+28,true),extra=central.getUint16(pos+30,true),
           comment=central.getUint16(pos+32,true),local=central.getUint32(pos+42,true);
     const name=new TextDecoder().decode(new Uint8Array(central.buffer,central.byteOffset+pos+46,namelen));
     if(/(^|\/)conversations([_-]\d+)?\.json$/i.test(name))targets.push({name,method,compressed,unpacked,local});
     pos+=46+namelen+extra+comment;
   }
   if(!targets.length)throw new Error('לא נמצא conversations.json בתוך ZIP. ניתן גם לבחור את קובץ JSON לאחר חילוץ מקומי.');
   const collected=[];
   for(const entry of targets){
     if(entry.unpacked>MAX_JSON||entry.compressed>MAX_JSON)throw new Error('קובץ השיחות גדול מדי לעריכה בטלפון');
     const head=new DataView(await file.slice(entry.local,entry.local+30).arrayBuffer());
     if(head.getUint32(0,true)!==0x04034b50)throw new Error('Invalid ZIP local header');
     const start=entry.local+30+head.getUint16(26,true)+head.getUint16(28,true);
     const packed=await file.slice(start,start+entry.compressed).arrayBuffer();
     let out;
     if(entry.method===0)out=new Uint8Array(packed);
     else if(entry.method===8&&typeof DecompressionStream!=='undefined'){
       try{
         const stream=new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
         out=new Uint8Array(await new Response(stream).arrayBuffer());
       }catch(_){throw new Error('הדפדפן אינו תומך בחילוץ ZIP זה. חלץ conversations.json בעזרת מנהל הקבצים וייבא JSON.')}
     }else throw new Error('שיטת דחיסת ZIP אינה נתמכת בדפדפן. חלץ את JSON במכשיר.');
     if(out.length>MAX_JSON)throw new Error('קובץ השיחות גדול מדי');
     const parsed=JSON.parse(dec.decode(out));
     if(Array.isArray(parsed))collected.push(...parsed);
     else if(Array.isArray(parsed.conversations))collected.push(...parsed.conversations);
     else if(parsed.mapping)collected.push(parsed);
   }
   return collected;
 }
 async function handleFile(file){
   if(!file)return;
   if(file.size>1.5*1024*1024*1024)throw new Error('הארכיון גדול מדי לטעינה במכשיר');
   const name=file.name.toLowerCase();
   if(name.endsWith('.zip')){
     tell('קורא את תוכן הארכיון במכשיר — ללא העלאה לשרת');
     await loadImported(await zipConversations(file),file.name);
   }else{
     if(file.size>MAX_JSON)throw new Error('קובץ גדול מדי לייבוא ישיר');
     const text=await file.text();
     if(name.endsWith('.md')||name.endsWith('.txt')){
       if(state.messages.length&&!confirm('להחליף את המסמך הערוך בטקסט המיובא?'))return;
       state={title:file.name,messages:decodeText(text),versions:[],source:'text_import'};
       if(state.messages.length)snapshot('ייבוא טקסט');
       showFull();scheduleSave();tell('טקסט יובא בהצלחה');return;
     }
     const parsed=JSON.parse(text);
     if(parsed&&parsed.format==='LMB-ENCRYPTED-EDITOR-v1'){
       encryptedBackup=parsed;
       tell('גיבוי מוצפן נטען. הזן סיסמת פתיחה ולחץ על "הפעל / פתח".');return;
     }
     await loadImported(parsed,file.name);
   }
 }
 function bind(id,fn){
   $(id).addEventListener('click',()=>{
     Promise.resolve().then(fn).catch(e=>{console.error(e);tell(e.message||String(e),true)});
   });
 }
 function init(){
   $('fullEditor').addEventListener('input',()=>{
     clearTimeout(window._parseT);
     window._parseT=setTimeout(()=>{
       state.messages=decodeText($('fullEditor').value);
       stats();scheduleSave();
     },250);
   });
   bind('view',()=>{
     if(mode==='full'){state.messages=decodeText($('fullEditor').value);showCards()}
     else showFull();
   });
   bind('add',()=>{if(mode==='full')state.messages=decodeText($('fullEditor').value);
     state.messages.push({role:'note',id:token(),text:''});
     mode==='cards'?showCards():showFull();scheduleSave();
   });
   bind('demo',()=>{
     if(state.messages.length&&!confirm('לפתוח דוגמת טקסט במקום העותק הנוכחי?'))return;
     state={title:'Lambadina — דוגמת עריכה',source:'synthetic_demo',versions:[],messages:[
       {role:'user',id:token(),text:'מה נרצה להוכיח?'},
       {role:'assistant',id:token(),text:'נרצה להבחין בין ניסוי, ראיה ופעילות מסחרית מאומתת.'},
       {role:'note',id:token(),text:'כאן אפשר לשנות כל מילה, לשמור גרסה ולייצא מסמך.'}
     ]};
     showFull();snapshot('גרסה ראשונה — דוגמה סינתטית');
   });
   bind('snapshot',()=>{if(mode==='full')state.messages=decodeText($('fullEditor').value);snapshot()});
   bind('replaceAll',findReplace);bind('restore',restore);bind('compare',compare);
   bind('auditManager',auditManager);
   bind('unlock',unlock);bind('lock',lock);
   bind('verifyDb',verifyDb);bind('requestPersist',requestPersistence);
   bind('clear',async()=>{
     if(!confirm('למחוק את עותק הכספת המוצפן שמאוחסן בדפדפן זה? הפעולה לא מוחקת גיבויים שהורדת.'))return;
     await idbDelete();lock();tell('העותק המקומי המוצפן נמחק מהאחסון של הדפדפן.');
   });
   bind('exportMarkdown',()=>{if(mode==='full')state.messages=decodeText($('fullEditor').value);exportMarkdown()});
   bind('exportJSON',()=>{if(mode==='full')state.messages=decodeText($('fullEditor').value);exportJSON()});
   bind('encryptedExport',()=>{if(mode==='full')state.messages=decodeText($('fullEditor').value);return encryptedExport()});
   bind('context',()=>{if(mode==='full')state.messages=decodeText($('fullEditor').value);showContext()});
   bind('copyContext',async()=>{
     try{await navigator.clipboard.writeText($('contextBox').value);tell('הטקסט הועתק. בדוק פרטיות לפני הדבקה.')}
     catch(_){$('contextBox').select();tell('בחר העתק מתוך הטקסט המסומן.')}
   });
   bind('loadConversation',()=>{
     if(!candidates)return;
     const selected=candidates[Number($('conversationSelect').value)];
     if(!selected)return;
     if(state.messages.length&&!confirm('להחליף את עותק העבודה בשיחה המיובאת?'))return;
     const msgs=conversationToMessages(selected);
     if(!msgs.length)throw new Error('לא נמצא טקסט משתמש/עוזר בגרסה הנוכחית של השיחה');
     state={title:selected.title||'שיחה מיובאת',source:'chatgpt_export_local',
            messages:msgs,versions:[]};
     candidates=null;$('conversationPicker').classList.add('hidden');
     showFull();snapshot('ייבוא תמליל מהייצוא המקורי');
     tell('נטענו '+msgs.length+' הודעות טקסט לעריכה חופשית.');
   });
   $('importFile').addEventListener('change',async e=>{
     try{await handleFile(e.target.files[0])}
     catch(err){console.error(err);tell('שגיאת ייבוא: '+err.message,true)}
     finally{e.target.value=''}
   });
   $('search').addEventListener('input',()=>{
     currentSearch=$('search').value;
     if(!currentSearch){stats();return}
     const count=state.messages.reduce((s,m)=>s+(m.text.split(currentSearch).length-1),0);
     $('dirty').textContent=count+' התאמות בטקסט';
   });
   stats();showFull();updateStorageInfo();
   idbGet().then(record=>{
     if(record)tell('נמצאה כספת מוצפנת במכשיר. הזן סיסמה כדי לפתוח אותה.');
   }).catch(()=>tell('שמירה מוצפנת אינה זמינה בדפדפן זה. ייצא גיבוי לקובץ.',true));
 }
 document.addEventListener('DOMContentLoaded',init);
})();