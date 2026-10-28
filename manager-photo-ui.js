/* Photos for Shopping and Maintenance items. The phone shrinks the picture
   before sending it (a small preview for the list, a larger copy opened on tap).
   window.mhPhoto.pick() asks for a picture (camera or library),
   window.mhPhoto.shrink(file) makes {thumb, photo}, window.mhPhoto.upload(kind, id, shrunk)
   saves it, window.mhPhoto.view(kind, id, opts) opens it. */
(() => {
const input=document.createElement('input');input.type='file';input.accept='image/*';input.hidden=true;input.id='mhPhotoInput';
document.body.append(input);
let resolvePick=null;
input.addEventListener('change',()=>{const f=input.files&&input.files[0];input.value='';const r=resolvePick;resolvePick=null;if(r)r(f||null);});
function pick(){return new Promise(res=>{resolvePick=res;input.click();});}

function loadImage(file){
 return new Promise((res,rej)=>{const url=URL.createObjectURL(file);const img=new Image();
  img.onload=()=>{URL.revokeObjectURL(url);res(img);};img.onerror=()=>{URL.revokeObjectURL(url);rej(new Error('This photo could not be opened. Try another one.'));};img.src=url;});
}
function draw(img,max,quality){
 const scale=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));
 const w=Math.max(1,Math.round(img.naturalWidth*scale)),h=Math.max(1,Math.round(img.naturalHeight*scale));
 const c=document.createElement('canvas');c.width=w;c.height=h;
 const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(img,0,0,w,h);
 return c.toDataURL('image/jpeg',quality);
}
async function shrink(file){
 if(!file||!/^image\//.test(file.type||'image/'))throw new Error('Choose a photo.');
 const img=await loadImage(file);
 let photo=draw(img,1280,0.72);
 if(photo.length>650000)photo=draw(img,1024,0.6);
 if(photo.length>650000)photo=draw(img,800,0.55);
 let thumb=draw(img,240,0.65);
 if(thumb.length>38000)thumb=draw(img,160,0.55);
 return {thumb,photo};
}
async function upload(kind,itemId,shrunk){
 return managerApi('manager_photo_set',{kind,item_id:itemId,thumb:shrunk.thumb,photo:shrunk.photo});
}

/* Viewer */
const dlg=document.createElement('dialog');dlg.id='mhPhotoViewer';dlg.className='mh-photo-viewer';
dlg.innerHTML=`<div class="mh-photo-box"><img id="mhPhotoImg" alt=""><p id="mhPhotoMsg" class="rm-data-note"></p>
<div class="mh-photo-actions"><button type="button" id="mhPhotoChange">Change photo</button><button type="button" id="mhPhotoRemove">Remove photo</button><button type="button" id="mhPhotoClose" class="mh-photo-close">Close</button></div></div>`;
document.body.append(dlg);
const $=id=>document.getElementById(id);
let current=null;
dlg.addEventListener('click',e=>{if(e.target===dlg)dlg.close();});
$('mhPhotoClose').onclick=()=>dlg.close();
dlg.addEventListener('close',()=>{$('mhPhotoImg').removeAttribute('src');current=null;});
async function view(kind,itemId,opts={}){
 current={kind,itemId,opts,removing:false};
 $('mhPhotoImg').src=opts.thumb||'';$('mhPhotoImg').alt=opts.title||'Photo';
 $('mhPhotoMsg').textContent='Loading…';$('mhPhotoRemove').textContent='Remove photo';
 $('mhPhotoChange').hidden=!opts.canChange;$('mhPhotoRemove').hidden=!opts.canChange;
 if(!dlg.open)dlg.showModal();
 const me=current;
 try{const d=await managerApi('manager_photo_get',{kind,item_id:itemId});if(current!==me)return;$('mhPhotoImg').src=d.photo;$('mhPhotoMsg').textContent='';}
 catch(e){if(current===me)$('mhPhotoMsg').textContent=e.message||'Unable to load the photo.';}
}
$('mhPhotoChange').onclick=async()=>{
 const me=current;if(!me)return;
 const f=await pick();if(!f||current!==me)return;
 $('mhPhotoMsg').textContent='Saving…';
 try{const s=await shrink(f);await upload(me.kind,me.itemId,s);$('mhPhotoImg').src=s.photo;$('mhPhotoMsg').textContent='Saved.';me.opts.onChange?.();}
 catch(e){$('mhPhotoMsg').textContent=e.message||'Unable to save the photo.';}
};
$('mhPhotoRemove').onclick=async()=>{
 const me=current;if(!me)return;
 if(!me.removing){me.removing=true;$('mhPhotoRemove').textContent='Tap again to remove';return;}
 try{await managerApi('manager_photo_remove',{kind:me.kind,item_id:me.itemId});dlg.close();me.opts.onChange?.();}
 catch(e){$('mhPhotoMsg').textContent=e.message||'Unable to remove the photo.';}
};
window.addEventListener('marinara:session-reset',()=>{if(dlg.open)dlg.close();});

window.mhPhoto={pick,shrink,upload,view};
})();
