import { isTauri } from "@tauri-apps/api/core";
import { api } from "../api";
import { CryptoClient } from "./client";
import type { SignedRoster } from "./types";

/** Words never enter an HTTP request; the core signs a public device roster. */
export async function enrollCurrentDevice(client: CryptoClient, currentPassword: string, phrase?: string): Promise<void> {
  const material = await api.recoveryMaterial();
  if (phrase) await client.execute({ operation: "recover_archive", phrase: phrase.trim().toLowerCase().split(/\s+/).join(" "), backup: material.backup });
  const own = await client.execute({ operation: "own_fingerprint" });
  if (own.result.public_key !== material.public_key) throw new Error("Ключ восстановления не соответствует аккаунту");
  let known = Number(own.result.known_revision);
  for (const previous of material.rosters.slice(0, -1)) {
    const revision = Number(JSON.parse(previous.payload).revision);
    if (revision > known) { await client.execute({ operation: "prepare_roster", previous }); known = revision; }
  }
  const latest = material.rosters.at(-1);
  if (latest && Number(JSON.parse(latest.payload).revision) === Number(own.result.known_revision)) {
    const identity = await client.execute({ operation: "identity" });
    const id = (identity.result.device as { device_id: string }).device_id;
    if (JSON.parse(latest.payload).devices.some((device: { device_id: string }) => device.device_id === id)) {
      await client.execute({ operation: "accept_roster", public_key: material.public_key, roster: latest, fingerprint: own.result.fingerprint as string });
      return;
    }
  }
  const prepared = await client.execute({ operation: "prepare_roster", previous: material.rosters.at(-1) ?? null });
  if (prepared.result.public_key !== material.public_key) throw new Error("Ключ восстановления не соответствует этому аккаунту");
  const roster = prepared.result.roster as SignedRoster;
  const payload = JSON.stringify({ operation: "enroll", roster, label: isTauri() ? "Приложение Когерента" : "Браузер", platform: isTauri() ? "windows" : "browser" });
  const challenge = await api.deviceChallenge("action");
  const signed = await client.execute({ operation: "sign_action", nonce: challenge.nonce, payload });
  await api.enrollDevice({ challenge_id: challenge.challenge_id, device: signed.result.device, proof: signed.result.proof, payload, current_password: currentPassword });
  const checked = await client.execute({ operation: "inspect_roster", public_key: material.public_key, roster });
  await client.execute({ operation: "accept_roster", public_key: material.public_key, roster, fingerprint: checked.result.fingerprint as string });
  window.dispatchEvent(new Event("coherent-security-changed"));
}
