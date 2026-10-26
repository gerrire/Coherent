/** Wire contract shared with crates/coherent-crypto. Secrets stay in the crypto
 * Worker/native core. Recovery phrases cross the boundary only for user input
 * or explicit reauthenticated display; never log or put them into an outbox. */
export interface Envelope { version: 1; nonce: string; ciphertext: string }
export interface DeviceBinding {
  version: 1;
  account_id: string;
  device_id: string;
  signature_key: string;
}
export interface MessageContext {
  conversation_id: string;
  message_id: string;
  sender_account_id: string;
  sender_device_id: string;
}
export interface SignedRoster { payload: string; signature: string }
export type CryptoCommand =
  | { operation: "link_prune"; ids: string[] }
  | { operation: "link_start" | "link_info" | "link_cancel"; id: string }
  | { operation: "link_offer"; id: string; device: DeviceBinding; code: string }
  | { operation: "link_respond"; id: string; device: DeviceBinding; request: string }
  | { operation: "link_send"; id: string; response: string; previous: SignedRoster }
  | { operation: "link_finish"; id: string; finalization: string; envelope: Envelope; public_key: string }
  | { operation: "identity" | "key_package" | "recovery_backup" | "own_fingerprint" | "export_contact_pins" }
  | { operation: "sign_device_proof"; purpose: "bootstrap" | "recovery_view" | "confirm_recovery"; nonce: string; backup: Envelope | null }
  | { operation: "pin_device"; device: DeviceBinding }
  | { operation: "authorize_conversation"; conversation_id: string; device_ids: string[] }
  | { operation: "create_group" | "members"; conversation_id: string }
  | { operation: "add_members"; conversation_id: string; key_packages: string[] }
  | { operation: "remove_members"; conversation_id: string; device_ids: string[] }
  | { operation: "acknowledge_commit"; conversation_id: string; commit: string }
  | { operation: "join"; conversation_id: string; welcome: string }
  | { operation: "send"; conversation_id: string; message_id: string; content: string; archive_accounts?: string[] }
  | { operation: "receive"; conversation_id: string; message_id: string | null; wire: string; body: Envelope | null }
  | { operation: "open_history"; context: MessageContext; body: Envelope; archive: Envelope }
  | { operation: "recover_archive"; phrase: string; backup: Envelope }
  | { operation: "import_contact_pins"; pins: ContactPin[] }
  | { operation: "prepare_roster"; previous: SignedRoster | null }
  | { operation: "inspect_roster"; public_key: string; roster: SignedRoster }
  | { operation: "accept_roster"; public_key: string; roster: SignedRoster; fingerprint: string | null }
  | { operation: "sign_action"; nonce: string; payload: string }
  | { operation: "verify_action"; device: DeviceBinding; nonce: string; payload: string; proof: string }
  | { operation: "stream_cursor"; stream: string }
  | { operation: "apply_event"; stream: string; sequence: number; command: CryptoCommand | null; expected_members?: string[] | null; group_id?: string | null }
  | { operation: "discard_commit"; conversation_id: string; commit: string }
  | { operation: "seal_chunk"; context: MessageContext; file_id: string; index: number; count: number; key: string | null; data: string }
  | { operation: "open_chunk"; context: MessageContext; file_id: string; index: number; count: number; key: string; envelope: Envelope }
  | { operation: "open_backup"; context: MessageContext; body: Envelope; backup: HistoryBackup };

export interface CryptoReply {
  result: Record<string, unknown>;
  delivery_id: string | null;
}
export interface DeliveryItem {
  id: string;
  operation: string;
  payload: Record<string, unknown>;
}
export type VaultRequest =
  | { type: "execute"; command: CryptoCommand; delivered_id?: string; transport?: Record<string, unknown> }
  | { type: "pending" }
  | { type: "delivered"; delivery_id: string };
export type RevealRequest = { type: "reveal_recovery"; current_password: string; csrf_token: string };

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function needsOutbox(operation: string): boolean {
  return ["send", "add_members", "remove_members", "key_package", "receive"].includes(operation);
}
export function deliveryPayload(operation: string, result: Record<string, unknown>): Record<string, unknown> | null {
  if (operation === "receive") return result.kind === "application" ? { context: result.context, archive: result.archive } : null;
  return needsOutbox(operation) ? result : null;
}

export interface HistoryBackup { version: 1; recipient: string; encapsulated: string; ciphertext: string }

export interface ContactPin { account_id: string; public_key: string; proof: string }

export type ApproveLinkRequest = { type: "approve_link"; current_password: string; csrf_token: string; command: Extract<CryptoCommand, { operation: "link_send" }> };
