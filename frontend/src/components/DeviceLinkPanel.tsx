import { useEffect, useRef, useState } from "react";
import { MonitorSmartphone, ShieldCheck, X } from "lucide-react";
import { api } from "../lib/api";
import { CryptoClient } from "../lib/crypto/client";
import { beginLink, deliverLink, linksFor, linkStatus, linkStep, offerLink, receiveLink, type DeviceLink } from "../lib/crypto/deviceLink";
import type { DeviceBinding } from "../lib/crypto/types";
import "./device-link.css";

export function NewDeviceLink({client,onComplete}:{client:CryptoClient;onComplete:()=>void}) {
  const [link,setLink]=useState<DeviceLink|null>(null),[code,setCode]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const working=useRef(false);const complete=useRef(onComplete);complete.current=onComplete;
  useEffect(()=>{
    let active=true;
    void client.execute({operation:"identity"}).then(async identity=>{
      const list=await linksFor(identity.result.device as DeviceBinding);const own=list.find(item=>item.device.device_id===(identity.result.device as DeviceBinding).device_id);
      if(!own||!active)return;
      const local=await client.execute({operation:"link_info",id:own.id});
      if(active){setLink(own);setCode(local.result.code as string);}
    }).catch(()=>{});
    return()=>{active=false;};
  },[client]);
  useEffect(()=>{
    if(!link||["completed","expired","rejected","cancelled"].includes(link.status))return;
    let active=true;
    async function poll(){
      if(working.current||!link)return;working.current=true;
      try{
        const current=await linkStatus(link.id);
        if(Date.parse(current.expires_at)<Date.now()&&current.status!=="completed")current.status="expired";
        const next=await receiveLink(client,current);
        if(!active)return;setLink(next);
        if(next.status==="completed"){setCode("");complete.current();}
        if(["expired","rejected","cancelled"].includes(next.status)){setCode("");await client.execute({operation:"link_cancel",id:next.id}).catch(()=>{});}
      }catch(reason){if(active)setError(reason instanceof Error?reason.message:"Не удалось подтвердить устройство");}
      finally{working.current=false;}
    }
    void poll();const timer=window.setInterval(()=>void poll(),1800);
    return()=>{active=false;window.clearInterval(timer);};
  },[client,link?.id,link?.status]);
  async function start(){
    if(busy)return;setBusy(true);setError("");
    try{if(link){await linkStep(client,link,"cancel").catch(()=>{});await client.execute({operation:"link_cancel",id:link.id}).catch(()=>{});}const next=await beginLink(client);setLink(next.link);setCode(next.code);}
    catch(reason){setError(reason instanceof Error?reason.message:"Не удалось создать запрос");}finally{setBusy(false);}
  }
  const live=link&&["pending","offered","responded","delivered"].includes(link.status);
  return <div className="new-device-link"><h4><MonitorSmartphone size={18}/>Подтвердить с другого устройства</h4><p>Открой Когерент там, где уже выполнен вход. В появившемся запросе введи код с этого экрана и подтверди действие.</p>
    {live?<><div className="device-pairing-code" aria-label="Одноразовый код">{code?code.match(/.{1,3}/g)?.join(" "):"Подтверждаем…"}</div><p role="status">{link.status==="pending"?"Ждём подтверждения на доверенном устройстве. Код действует 5 минут.":"Устанавливаем защищённую связь и передаём доступ к истории…"}</p><button type="button" className="recovery-action" disabled={busy} onClick={()=>void start()}>Получить новый код</button></>:<button type="button" className="recovery-action" disabled={busy} onClick={()=>void start()}>{busy?"Создаём запрос…":"Показать одноразовый код"}</button>}
    {link?.status==="expired"&&<p>Срок кода истёк. Получи новый код.</p>}{link?.status==="rejected"&&<p>Запрос отклонён или код введён неверно. Можно создать новый запрос.</p>}{error&&<p className="profile-settings-error" role="alert">{error}</p>}
  </div>;
}

export default function DeviceApprovalPanel({accountId}:{accountId:string}) {
  const client=useRef<CryptoClient|null>(null),device=useRef<DeviceBinding|null>(null),password=useRef(""),working=useRef(false);
  const [links,setLinks]=useState<DeviceLink[]>([]),[selected,setSelected]=useState<string|null>(null),[code,setCode]=useState(""),[pwd,setPwd]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  useEffect(()=>{
    const local=new CryptoClient(accountId);client.current=local;let active=true;let polling=false;let pruned="?";
    async function refresh(){
      if(polling||working.current)return;polling=true;
      try{
        if(!device.current){const identity=await local.execute({operation:"identity"});device.current=identity.result.device as DeviceBinding;}
        const status=await api.securityStatus();
        if(!status.devices.some(item=>item.id===device.current!.device_id)){if(active)setLinks([]);return;}
        const pending=await linksFor(device.current!);
        const ids=pending.map(item=>item.id).sort();const key=ids.join();
        if(key!==pruned){await local.execute({operation:"link_prune",ids});pruned=key;}
        if(active)setLinks(pending.filter(item=>item.device.device_id!==device.current!.device_id));
      }catch{}finally{polling=false;}
    }
    void refresh();const timer=window.setInterval(()=>void refresh(),3500);const changed=()=>void refresh();
    const hidden=()=>{if(document.hidden){password.current="";setPwd("");}};
    window.addEventListener("coherent-device-link",changed);window.addEventListener("coherent-security-changed",changed);document.addEventListener("visibilitychange",hidden);
    return()=>{active=false;client.current=null;password.current="";local.close();window.clearInterval(timer);window.removeEventListener("coherent-device-link",changed);window.removeEventListener("coherent-security-changed",changed);document.removeEventListener("visibilitychange",hidden);};
  },[accountId]);
  const link=links.find(item=>item.id===selected);
  useEffect(()=>{
    if(!link||!client.current||link.approver?.device_id!==device.current?.device_id||link.status!=="responded"||!password.current||working.current)return;
    working.current=true;setBusy(true);const local=client.current;
    void deliverLink(local,link,password.current).then(next=>{setLinks(old=>old.map(item=>item.id===next.id?next:item));password.current="";setPwd("");setCode("");setSelected(null);}).catch(async reason=>{
      setError("Подтверждение не выполнено. Проверь код и текущий пароль. "+(reason instanceof Error?reason.message:""));password.current="";setPwd("");
      // A failed PAKE attempt gets a fresh code; it cannot be reused for online guesses.
      if(reason instanceof Error&&reason.message.includes("Одноразовый код не совпал")){await linkStep(local,link,"reject").catch(()=>{});await local.execute({operation:"link_cancel",id:link.id}).catch(()=>{});}
    }).finally(()=>{working.current=false;setBusy(false);});
  },[link?.id,link?.status,pwd]);
  async function approve(){
    const local=client.current;if(!local||!link||busy||!pwd)return;
    setError("");password.current=pwd;setBusy(true);working.current=true;
    try{
      if(link.status==="pending"){
        const next=await offerLink(local,link,code.replace(/\s/g,""));setLinks(old=>old.map(item=>item.id===next.id?next:item));
      } else if(link.status==="responded"){
        const next=await deliverLink(local,link,pwd);setLinks(old=>old.map(item=>item.id===next.id?next:item));setSelected(null);password.current="";setPwd("");setCode("");
      }
    }catch(reason){setError(reason instanceof Error?reason.message:"Не удалось отправить подтверждение");password.current="";}
    finally{working.current=false;setBusy(false);}
  }
  async function reject(item:DeviceLink){if(client.current)await linkStep(client.current,item,"reject").then(async ()=>{await client.current?.execute({operation:"link_cancel",id:item.id}).catch(()=>{});setLinks(old=>old.filter(x=>x.id!==item.id));setSelected(null);setPwd("");password.current="";}).catch(()=>setError("Не удалось отклонить запрос"));}
  const available=links.filter(item=>item.status!=="delivered"&&(!item.approver||item.approver.device_id===device.current?.device_id));
  if(!available.length)return null;
  return <><aside className="device-approval-banner" aria-label="Новый вход в аккаунт"><ShieldCheck size={21}/><div><strong>Запрос на подключение устройства</strong><span>{available[0].label}</span></div><button type="button" onClick={()=>{setSelected(available[0].id);setError("");setCode("");setPwd("");}}>Проверить</button></aside>
    {link&&<div className="device-approval-backdrop"><section className="device-approval-dialog" role="dialog" aria-modal="true" aria-label="Подтверждение входа"><header><h2>Подключить устройство?</h2><button type="button" aria-label="Закрыть подтверждение" onClick={()=>{setSelected(null);password.current="";setPwd("");}}><X size={20}/></button></header><p>{link.label}. Подтверди только вход, который начал сам.</p><label>Код с нового устройства<input value={code} onChange={event=>setCode(event.target.value.replace(/\D/g,"").slice(0,6))} inputMode="numeric" autoComplete="off" maxLength={6} placeholder="6 цифр" disabled={link.status!=="pending"}/></label><label>Текущий пароль<input type="password" value={pwd} onChange={event=>setPwd(event.target.value)} autoComplete="current-password" maxLength={128}/></label><p>История передаётся по защищённому соединению между устройствами. Recovery Key вводить не нужно.</p>{link.status==="offered"&&<p role="status">Ждём ответа нового устройства…</p>}{error&&<p role="alert" className="profile-settings-error">{error}</p>}<div className="device-approval-actions"><button type="button" disabled={busy} onClick={()=>void reject(link)}>Отклонить</button><button type="button" className="recovery-action" disabled={busy||!pwd||(link.status==="pending"&&code.length!==6)||link.status==="offered"} onClick={()=>void approve()}>{busy?"Подтверждаем…":"Подтвердить вход"}</button></div></section></div>}
  </>;
}
