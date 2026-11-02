//! Regression: skill discovery and skill reads must stay inside each skill root. A workspace
//! (`.cowork/skills`, `.agents/skills`, `.claude/skills`) must not be able to register an
//! arbitrary file as a skill by symlinking `SKILL.md` (or the whole skill directory) at a file
//! the server user can read, such as `~/.cowork/auth/connections.json`.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use cowork_tools::{
    discover_skills, read_skill_agent_interface_metadata, read_skill_md_confined,
    render_skill_body_for_model,
};

const SECRET: &str = "sk-skill-symlink-leak-secret";

struct Fixture {
    _root: tempfile::TempDir,
    home: PathBuf,
    cowork_home: PathBuf,
    workspace: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let cowork_home = home.join(".cowork");
        let workspace = base.join("workspace");
        fs::create_dir_all(cowork_home.join("auth")).unwrap();
        fs::create_dir_all(workspace.join(".cowork/skills")).unwrap();
        fs::write(
            cowork_home.join("auth/connections.json"),
            format!(r#"{{"openai":{{"apiKey":"{SECRET}"}}}}"#),
        )
        .unwrap();
        Self {
            _root: root,
            home,
            cowork_home,
            workspace,
        }
    }

    fn project_skills(&self) -> PathBuf {
        self.workspace.join(".cowork/skills")
    }

    fn secret_path(&self) -> PathBuf {
        self.cowork_home.join("auth/connections.json")
    }
}

fn write_skill(dir: &Path, name: &str, body: &str) {
    fs::create_dir_all(dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: Test skill {name}\n---\n{body}\n"),
    )
    .unwrap();
}

#[test]
fn symlinked_skill_md_to_outside_file_is_not_registered_or_read() {
    let fx = Fixture::new();
    let leak = fx.project_skills().join("leak");
    fs::create_dir_all(&leak).unwrap();
    symlink(fx.secret_path(), leak.join("SKILL.md")).unwrap();

    let skills = discover_skills(None, &fx.cowork_home, &fx.workspace);
    assert!(!skills.contains_key("leak"), "skills={:?}", skills.keys());
    for skill in skills.values() {
        assert!(!skill.description.contains(SECRET));
    }
    let err = read_skill_md_confined(&leak).unwrap_err();
    assert!(!err.to_string().contains(SECRET), "{err}");
}

#[test]
fn symlinked_skill_md_with_valid_frontmatter_target_is_refused() {
    // Even a target that parses as a skill is not followed: the link itself is refused.
    let fx = Fixture::new();
    let outside = fx.home.join("elsewhere");
    write_skill(&outside, "linked", SECRET);
    let linked = fx.project_skills().join("linked");
    fs::create_dir_all(&linked).unwrap();
    symlink(outside.join("SKILL.md"), linked.join("SKILL.md")).unwrap();

    let skills = discover_skills(None, &fx.cowork_home, &fx.workspace);
    assert!(!skills.contains_key("linked"), "skills={:?}", skills.keys());
    assert!(read_skill_md_confined(&linked).is_err());
}

#[test]
fn symlinked_skill_directory_escaping_the_root_is_not_registered() {
    let fx = Fixture::new();
    let outside = fx.home.join("outside-skill");
    write_skill(&outside, "escape", SECRET);
    symlink(&outside, fx.project_skills().join("escape")).unwrap();
    // Linking the skill directory at the secret's own directory is refused as well.
    symlink(
        fx.cowork_home.join("auth"),
        fx.project_skills().join("auth"),
    )
    .unwrap();

    let skills = discover_skills(None, &fx.cowork_home, &fx.workspace);
    assert!(!skills.contains_key("escape"), "skills={:?}", skills.keys());
    assert!(!skills.contains_key("auth"), "skills={:?}", skills.keys());
    assert!(read_skill_md_confined(&fx.project_skills().join("escape")).is_err());
}

#[test]
fn project_skill_without_valid_frontmatter_is_not_registered() {
    // TS catalog parsing required `name`/`description` frontmatter for project skills.
    let fx = Fixture::new();
    let plain = fx.project_skills().join("plain");
    fs::create_dir_all(&plain).unwrap();
    fs::write(plain.join("SKILL.md"), format!("no frontmatter {SECRET}\n")).unwrap();
    let mismatched = fx.project_skills().join("mismatched");
    write_skill(&mismatched, "other-name", "body");

    let skills = discover_skills(None, &fx.cowork_home, &fx.workspace);
    assert!(!skills.contains_key("plain"), "skills={:?}", skills.keys());
    assert!(!skills.contains_key("mismatched"));
    assert!(!skills.contains_key("other-name"));
}

#[test]
fn regular_project_skill_is_discovered_and_rendered() {
    let fx = Fixture::new();
    write_skill(
        &fx.project_skills().join("greeter"),
        "greeter",
        "Always greet warmly.",
    );

    let skills = discover_skills(None, &fx.cowork_home, &fx.workspace);
    let skill = skills.get("greeter").expect("greeter discovered");
    assert_eq!(skill.description, "Test skill greeter");
    let rendered = render_skill_body_for_model(skill).unwrap();
    assert!(rendered.contains("Always greet warmly."), "{rendered}");
}

#[test]
fn skill_swapped_for_a_symlink_after_discovery_is_not_read() {
    let fx = Fixture::new();
    let dir = fx.project_skills().join("swapped");
    write_skill(&dir, "swapped", "original body");
    let skills = discover_skills(None, &fx.cowork_home, &fx.workspace);
    let skill = skills.get("swapped").expect("discovered").clone();

    fs::remove_file(dir.join("SKILL.md")).unwrap();
    symlink(fx.secret_path(), dir.join("SKILL.md")).unwrap();
    let err = render_skill_body_for_model(&skill).unwrap_err();
    assert!(!err.to_string().contains(SECRET), "{err}");

    // Swapping the whole skill directory for a link outside the root is refused too.
    let outside = fx.home.join("swap-target");
    write_skill(&outside, "swapped", SECRET);
    fs::remove_dir_all(&dir).unwrap();
    symlink(&outside, &dir).unwrap();
    let err = render_skill_body_for_model(&skill).unwrap_err();
    assert!(!err.to_string().contains(SECRET), "{err}");
}

#[test]
fn interface_metadata_does_not_follow_links_out_of_the_skill() {
    let fx = Fixture::new();
    let dir = fx.project_skills().join("iface");
    write_skill(&dir, "iface", "body");
    let outside = fx.home.join("outside-agents");
    fs::create_dir_all(&outside).unwrap();
    fs::write(
        outside.join("openai.yaml"),
        format!("interface:\n  display_name: {SECRET}\n"),
    )
    .unwrap();
    fs::write(outside.join("icon.png"), b"\x89PNG secret").unwrap();

    // `agents/` linked outside the skill.
    symlink(&outside, dir.join("agents")).unwrap();
    assert!(read_skill_agent_interface_metadata(&dir).is_none());

    // A real `agents/` whose YAML file and icon are links outside the skill.
    fs::remove_file(dir.join("agents")).unwrap();
    fs::create_dir_all(dir.join("agents")).unwrap();
    symlink(outside.join("openai.yaml"), dir.join("agents/openai.yaml")).unwrap();
    assert!(read_skill_agent_interface_metadata(&dir).is_none());

    fs::remove_file(dir.join("agents/openai.yaml")).unwrap();
    symlink(outside.join("icon.png"), dir.join("icon.png")).unwrap();
    fs::write(
        dir.join("agents/openai.yaml"),
        "interface:\n  display_name: Iface\n  icon_small: ./icon.png\n",
    )
    .unwrap();
    let meta = read_skill_agent_interface_metadata(&dir).expect("interface");
    assert_eq!(meta.display_name.as_deref(), Some("Iface"));
    assert!(meta.icon_small.is_none(), "icon={:?}", meta.icon_small);
}
