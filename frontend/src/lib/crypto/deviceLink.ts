import { isTauri } from "@tauri-apps/api/core";
import { api, apiRequest } from "../api";
import { enrollCurrentDevice } from "./access";
import { CryptoClient } from "./client";
import type { DeviceBinding, Envelope } from "./types";
export interface DeviceLink {
  id:string; device:DeviceBinding; label:string; platform:string; nonce:string;
  status:"pending"|"offered"|"responded"|"delivered"|"completed"|"expired"|"rejected"|"cancelled";
  expires_at:string; approver:DeviceBinding|null;
  request:string|null; response:string|null; finalization:string|null; envelope:Envelope|null;
}
export async function linksFor(device:DeviceBinding):Promise<DeviceLink[]> {
  return (await apiRequest<{links:DeviceLink[]}>(`/api/v1/security/device-links?device_id=${device.device_id}`)).links;
}
export async function linkStatus(id:string):Promise<DeviceLink>{return apiRequest(`/api/v1/security/device-links/${id}`);}
async function signed(client:CryptoClient,nonce:string,payload:Record<string,unknown>) {
  const text=JSON.stringify(payload);const result=await client.execute({operation:"sign_action",nonce,payload:text});
  return {device:result.result.device,payload:text,proof:result.result.proof};
}
export async function beginLink(client:CryptoClient):Promise<{link:DeviceLink;code:string}> {
  const id=crypto.randomUUID();const local=await client.execute({operation:"link_start",id});
  const nonce=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const os=/Android/i.test(navigator.userAgent)?"Android":/iPhone|iPad/i.test(navigator.userAgent)?"iOS":/Windows/i.test(navigator.userAgent)?"Windows":/Mac/i.test(navigator.userAgent)?"macOS":"Linux";
  try {
    const link=await apiRequest<DeviceLink>("/api/v1/security/device-links",{method:"POST",body:JSON.stringify(await signed(client,nonce,{operation:"link_start",id,nonce,label:isTauri()?`Когерент · ${os}`:`Браузер · ${os}`,platform:isTauri()?os.toLowerCase():"browser"}))});
    return {link,code:local.result.code as string};
  } catch(error){await client.execute({operation:"link_cancel",id}).catch(()=>{});throw error;}
}
export async function linkStep(client:CryptoClient,link:DeviceLink,operation:string,packet:string|null=null,envelope:Envelope|null=null):Promise<DeviceLink>{
  return apiRequest(`/api/v1/security/device-links/${link.id}`,{method:"POST",body:JSON.stringify(await signed(client,link.nonce,{operation,id:link.id,packet,envelope}))});
}
export async function receiveLink(client:CryptoClient,link:DeviceLink):Promise<DeviceLink> {
  if(link.status==="offered"&&link.request&&link.approver){
    const answer=await client.execute({operation:"link_respond",id:link.id,device:link.approver,request:link.request});
    return linkStep(client,link,"respond",answer.result.response as string);
  }
  if(link.status==="delivered"&&link.finalization&&link.envelope){
    const material=await api.recoveryMaterial();
    const current=await client.execute({operation:"own_fingerprint"}).catch(()=>null);
    if(current?.result.public_key!==material.public_key) await client.execute({operation:"link_finish",id:link.id,finalization:link.finalization,envelope:link.envelope,public_key:material.public_key});
    await enrollCurrentDevice(client,"",undefined,link.id);
    window.dispatchEvent(new Event("coherent-security-changed"));
    return {...link,status:"completed"};
  }
  return link;
}
export async function offerLink(client:CryptoClient,link:DeviceLink,code:string):Promise<DeviceLink>{
  const response=await client.execute({operation:"link_offer",id:link.id,device:link.device,code});
  return linkStep(client,link,"offer",response.result.request as string);
}
export async function deliverLink(client:CryptoClient,link:DeviceLink,password:string):Promise<DeviceLink>{
  await enrollCurrentDevice(client,"");
  const material=await api.recoveryMaterial();
  if(!link.response||!material.rosters.length)throw new Error("Устройство ещё не ответило");
  const sealed=await client.approveLink(password,{operation:"link_send",id:link.id,response:link.response,previous:material.rosters.at(-1)!});
  const result=await linkStep(client,link,"deliver",sealed.result.finalization as string,sealed.result.envelope as Envelope);
  await client.execute({operation:"link_cancel",id:link.id});return result;
}
