use crate::engine::CryptoEngine;
use serde_json::{Value, json};

const ALICE: &str = "10000000-0000-4000-8000-000000000001";
const BOB: &str = "10000000-0000-4000-8000-000000000002";
const ROOM: &str = "20000000-0000-4000-8000-000000000001";
const NEXT_ROOM: &str = "20000000-0000-4000-8000-000000000002";
const CALL: &str = "40000000-0000-4000-8000-000000000001";

fn run(core: &mut CryptoEngine, command: Value) -> Value {
    serde_json::from_str(&core.execute_json(&command.to_string()).unwrap()).unwrap()
}

fn account(id: &str, device: &str) -> (CryptoEngine, Value, Value) {
    let mut core = CryptoEngine::new(id, device).unwrap();
    let backup = run(&mut core, json!({"operation":"recovery_backup"}));
    let roster = run(
        &mut core,
        json!({"operation":"prepare_roster","previous":null}),
    )["roster"]
        .clone();
    (core, backup, roster)
}

fn trust(core: &mut CryptoEngine, backup: &Value, roster: &Value) {
    let public = &backup["recovery_public_key"];
    let checked = run(
        core,
        json!({"operation":"inspect_roster","public_key":public,"roster":roster}),
    );
    run(
        core,
        json!({"operation":"accept_roster","public_key":public,"roster":roster,"fingerprint":checked["fingerprint"]}),
    );
}

fn group(a: &mut CryptoEngine, b: &mut CryptoEngine, room: &str) {
    let da = run(a, json!({"operation":"identity"}))["device"]["device_id"].clone();
    let db = run(b, json!({"operation":"identity"}))["device"]["device_id"].clone();
    for core in [&mut *a, &mut *b] {
        run(
            core,
            json!({"operation":"authorize_conversation","conversation_id":room,"device_ids":[da,db]}),
        );
    }
    run(
        a,
        json!({"operation":"create_group","conversation_id":room}),
    );
    let kp = run(b, json!({"operation":"key_package"}));
    let bundle = run(
        a,
        json!({"operation":"add_members","conversation_id":room,"key_packages":[kp["key_package"]]}),
    );
    run(
        a,
        json!({"operation":"acknowledge_commit","conversation_id":room,"commit":bundle["commit"]}),
    );
    run(
        b,
        json!({"operation":"join","conversation_id":room,"welcome":bundle["welcome"]}),
    );
}

#[test]
fn recovery_rotation_survives_restart_preserves_history_and_rejects_old_key() {
    let (mut a, ba, ra) = account(ALICE, "30000000-0000-4000-8000-000000000001");
    let (mut b, bb, rb) = account(BOB, "30000000-0000-4000-8000-000000000002");
    for core in [&mut a, &mut b] {
        trust(core, &ba, &ra);
        trust(core, &bb, &rb);
    }
    group(&mut a, &mut b, ROOM);
    let past = run(
        &mut a,
        json!({"operation":"send","conversation_id":ROOM,"message_id":"50000000-0000-4000-8000-000000000001","content":"old-history","archive_accounts":[ALICE,BOB]}),
    );
    let old_words = run(&mut a, json!({"operation":"show_recovery"}))["phrase"].clone();
    let prepared = run(
        &mut a,
        json!({"operation":"prepare_rotation","previous":ra}),
    );
    assert_eq!(
        run(&mut a, json!({"operation":"own_fingerprint"}))["public_key"],
        ba["recovery_public_key"]
    );
    assert!(prepared.get("phrase").is_none());
    // The unacknowledged change must survive browser/native process restart.
    let saved = a.snapshot_local().unwrap();
    let mut a = CryptoEngine::restore_local(&saved).unwrap();
    assert!(
        a.execute_json(
            &json!({"operation":"commit_rotation","public_key":bb["recovery_public_key"]})
                .to_string()
        )
        .is_err()
    );
    run(
        &mut a,
        json!({"operation":"commit_rotation","public_key":prepared["public_key"]}),
    );
    let new_words = run(&mut a, json!({"operation":"show_recovery"}))["phrase"].clone();
    assert_ne!(old_words, new_words);
    assert_eq!(new_words.as_str().unwrap().split_whitespace().count(), 12);
    assert_eq!(
        run(
            &mut a,
            json!({"operation":"open_backup","context":past["context"],"body":past["body"],"backup":past["backups"][ALICE]})
        )["content"],
        "old-history"
    );
    // The old recovery secret cannot unwrap the replacement backup.
    let mut old = CryptoEngine::new(ALICE, "30000000-0000-4000-8000-000000000004").unwrap();
    assert!(
        old.execute_json(
            &json!({"operation":"recover_archive","phrase":old_words,"backup":prepared["backup"]})
                .to_string()
        )
        .is_err()
    );
    let mut recovered = CryptoEngine::new(ALICE, "30000000-0000-4000-8000-000000000003").unwrap();
    run(
        &mut recovered,
        json!({"operation":"recover_archive","phrase":new_words,"backup":prepared["backup"]}),
    );
    let new_backup = json!({"recovery_public_key":prepared["public_key"]});
    trust(&mut recovered, &new_backup, &prepared["roster"]);
    run(
        &mut recovered,
        json!({"operation":"pin_history_roster","public_key":ba["recovery_public_key"],"roster":ra}),
    );
    assert_eq!(
        run(
            &mut recovered,
            json!({"operation":"open_backup","context":past["context"],"body":past["body"],"backup":past["backups"][ALICE]})
        )["content"],
        "old-history"
    );
    // A peer explicitly accepts the new fingerprint; old root remains history-only.
    let fp = run(
        &mut b,
        json!({"operation":"inspect_roster","public_key":prepared["public_key"],"roster":prepared["roster"]}),
    );
    assert_eq!(fp["changed"], true);
    run(
        &mut b,
        json!({"operation":"replace_account_trust","public_key":prepared["public_key"],"roster":prepared["roster"],"fingerprint":fp["fingerprint"]}),
    );
    group(&mut a, &mut b, NEXT_ROOM);
    let future = run(
        &mut a,
        json!({"operation":"send","conversation_id":NEXT_ROOM,"message_id":"50000000-0000-4000-8000-000000000002","content":"new-history","archive_accounts":[ALICE,BOB]}),
    );
    let mut stolen = CryptoEngine::restore_local(&saved).unwrap();
    assert!(stolen.execute_json(&json!({"operation":"open_backup","context":future["context"],"body":future["body"],"backup":future["backups"][ALICE]}).to_string()).is_err());
    assert_eq!(
        run(
            &mut recovered,
            json!({"operation":"open_backup","context":future["context"],"body":future["body"],"backup":future["backups"][ALICE]})
        )["content"],
        "new-history"
    );
}

#[test]
fn call_exporter_matches_members_and_changes_after_removal() {
    let (mut a, ba, ra) = account(ALICE, "30000000-0000-4000-8000-000000000011");
    let (mut b, bb, rb) = account(BOB, "30000000-0000-4000-8000-000000000012");
    for core in [&mut a, &mut b] {
        trust(core, &ba, &ra);
        trust(core, &bb, &rb);
    }
    group(&mut a, &mut b, ROOM);
    let ka = run(
        &mut a,
        json!({"operation":"media_key","conversation_id":ROOM,"call_id":CALL}),
    );
    let kb = run(
        &mut b,
        json!({"operation":"media_key","conversation_id":ROOM,"call_id":CALL}),
    );
    assert_eq!(ka, kb);
    let bid = run(&mut b, json!({"operation":"identity"}))["device"]["device_id"].clone();
    let bundle = run(
        &mut a,
        json!({"operation":"remove_members","conversation_id":ROOM,"device_ids":[bid]}),
    );
    assert!(bundle["welcome"].is_null());
    run(
        &mut a,
        json!({"operation":"acknowledge_commit","conversation_id":ROOM,"commit":bundle["commit"]}),
    );
    assert_ne!(
        run(
            &mut a,
            json!({"operation":"media_key","conversation_id":ROOM,"call_id":CALL})
        )["key"],
        kb["key"]
    );
    run(
        &mut b,
        json!({"operation":"receive","conversation_id":ROOM,"message_id":null,"wire":bundle["commit"],"body":null}),
    );
    assert!(
        b.execute_json(
            &json!({"operation":"media_key","conversation_id":ROOM,"call_id":CALL}).to_string()
        )
        .is_err()
    );
}

#[test]
fn a_solo_call_group_can_initialize_without_a_second_key_package() {
    let (mut a, ba, ra) = account(ALICE, "30000000-0000-4000-8000-000000000021");
    trust(&mut a, &ba, &ra);
    let id = run(&mut a, json!({"operation":"identity"}))["device"]["device_id"].clone();
    run(
        &mut a,
        json!({"operation":"authorize_conversation","conversation_id":ROOM,"device_ids":[id]}),
    );
    run(
        &mut a,
        json!({"operation":"create_group","conversation_id":ROOM}),
    );
    let commit = run(
        &mut a,
        json!({"operation":"add_members","conversation_id":ROOM,"key_packages":[]}),
    );
    run(
        &mut a,
        json!({"operation":"acknowledge_commit","conversation_id":ROOM,"commit":commit["commit"]}),
    );
    assert!(
        run(
            &mut a,
            json!({"operation":"media_key","conversation_id":ROOM,"call_id":CALL})
        )["key"]
            .is_string()
    );
}
