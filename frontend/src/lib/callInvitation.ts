type InvitationState = { status: string; participants: ReadonlyArray<{ user_id: string; state: string }> };
export function isCallInvitation(call: InvitationState, accountId: string): boolean {
  return (call.status === "ringing" || call.status === "active")
    && call.participants.some(participant => participant.user_id === accountId && participant.state === "invited");
}
