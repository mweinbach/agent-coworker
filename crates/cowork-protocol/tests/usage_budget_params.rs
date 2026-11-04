//! `cowork/session/usageBudget/set` must keep explicit `null` (clear) distinct from an omitted
//! field (unchanged); desktop `clearThreadUsageHardCap` sends `stopAtUsd: null`.

use cowork_protocol::schemas::SessionUsageBudgetSetParams;
use serde_json::json;

#[test]
fn explicit_null_clears_and_omitted_leaves_unchanged() {
    let cleared: SessionUsageBudgetSetParams =
        serde_json::from_value(json!({ "threadId": "t1", "stopAtUsd": null })).unwrap();
    assert_eq!(cleared.stop_at_usd, Some(None));
    assert_eq!(cleared.warn_at_usd, None);

    let both_null: SessionUsageBudgetSetParams =
        serde_json::from_value(json!({ "threadId": "t1", "warnAtUsd": null, "stopAtUsd": null }))
            .unwrap();
    assert_eq!(both_null.warn_at_usd, Some(None));
    assert_eq!(both_null.stop_at_usd, Some(None));

    let set: SessionUsageBudgetSetParams =
        serde_json::from_value(json!({ "threadId": "t1", "warnAtUsd": 1.5 })).unwrap();
    assert_eq!(set.warn_at_usd, Some(Some(1.5)));
    assert_eq!(set.stop_at_usd, None);

    assert!(
        serde_json::from_value::<SessionUsageBudgetSetParams>(
            json!({ "threadId": "t1", "stopAtUsd": "5" })
        )
        .is_err()
    );
}
