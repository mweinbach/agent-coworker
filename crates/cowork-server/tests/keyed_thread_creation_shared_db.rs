//! Two server runtimes sharing one `sessions.db` (as two server processes on one Cowork home
//! would) agree on the thread a `clientThreadId` creates: exactly one of them creates it, the
//! other loads the committed thread, and it never writes a second empty thread over the
//! winner's saved work.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use cowork_server::{ServerOptions, start_server};
use tempfile::TempDir;

struct Iso {
    _root: TempDir,
    home: PathBuf,
    workspace: PathBuf,
}

impl Iso {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("cowork-keyed-thread-")
            .tempdir()
            .unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let workspace = base.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        Self {
            _root: root,
            home,
            workspace,
        }
    }

    fn options(&self) -> ServerOptions {
        let env = HashMap::from([
            ("HOME".to_owned(), self.home.to_string_lossy().into_owned()),
            (
                "COWORK_HOME_OVERRIDE".to_owned(),
                self.home.join(".cowork").to_string_lossy().into_owned(),
            ),
            ("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned()),
            ("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned()),
            ("COWORK_BOOTSTRAP_DEFAULT_SKILLS".to_owned(), "0".to_owned()),
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
        ]);
        ServerOptions {
            working_directory: self.workspace.clone(),
            host: "127.0.0.1".to_owned(),
            port: 0,
            yolo: false,
            mobile_h3: false,
            mobile_h3_host: "127.0.0.1".to_owned(),
            mobile_h3_port: 0,
            homedir: Some(self.home.clone()),
            built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
            env,
        }
    }
}

fn count(db: &std::path::Path, sql: &str, arg: &str) -> i64 {
    rusqlite::Connection::open(db)
        .unwrap()
        .query_row(sql, [arg], |r| r.get(0))
        .unwrap()
}

#[tokio::test]
async fn racing_runtimes_on_one_db_resolve_one_keyed_thread() {
    let iso = Iso::new();
    let server_a = start_server(iso.options()).await.unwrap();
    let server_b = start_server(iso.options()).await.unwrap();
    let (rt_a, rt_b) = (server_a.runtime(), server_b.runtime());
    let cwd = iso.workspace.to_string_lossy().into_owned();

    let (a, b) = tokio::join!(
        rt_a.start_or_get_thread(
            &iso.workspace,
            Some("shared-client-thread"),
            None,
            None,
            "a"
        ),
        rt_b.start_or_get_thread(
            &iso.workspace,
            Some("shared-client-thread"),
            None,
            None,
            "b"
        ),
    );
    let (thread_a, created_a) = a.unwrap();
    let (thread_b, created_b) = b.unwrap();
    assert_eq!(thread_a.id, thread_b.id);
    assert!(
        created_a ^ created_b,
        "exactly one runtime creates the thread"
    );

    let db = rt_a.session_db.db_path().to_path_buf();
    let sessions_in_workspace = "SELECT COUNT(*) FROM sessions WHERE working_directory = ?1";
    assert_eq!(count(&db, sessions_in_workspace, &cwd), 1);
    // Only the creator's initial row was written; the loser persisted nothing for the thread.
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM session_events WHERE session_id = ?1",
            &thread_a.id
        ),
        1
    );

    server_a.shutdown().await;
    server_b.shutdown().await;
}

#[tokio::test]
async fn a_second_runtime_loads_the_committed_keyed_thread_instead_of_overwriting_it() {
    let iso = Iso::new();
    let server_a = start_server(iso.options()).await.unwrap();
    let rt_a = server_a.runtime();
    let (thread, created) = rt_a
        .start_or_get_thread(&iso.workspace, Some("client-thread"), None, None, "a")
        .await
        .unwrap();
    assert!(created);
    rt_a.set_session_title(&thread.id, "Saved work")
        .await
        .unwrap();

    // A second runtime has no in-memory key cache and must resolve through `sessions.db`.
    let server_b = start_server(iso.options()).await.unwrap();
    let rt_b = server_b.runtime();
    let (joined, created) = rt_b
        .start_or_get_thread(&iso.workspace, Some("client-thread"), None, None, "b")
        .await
        .unwrap();
    assert!(!created);
    assert_eq!(joined.id, thread.id);
    assert_eq!(
        rt_b.session_db
            .get_session_record(&thread.id)
            .unwrap()
            .unwrap()
            .title,
        "Saved work"
    );
    assert_eq!(
        count(
            rt_b.session_db.db_path(),
            "SELECT COUNT(*) FROM sessions WHERE working_directory = ?1",
            &iso.workspace.to_string_lossy()
        ),
        1
    );

    server_a.shutdown().await;
    server_b.shutdown().await;
}
