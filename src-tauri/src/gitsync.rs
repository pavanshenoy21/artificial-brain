//! Backs the vault up with git when the app closes: `git add -A`, a commit if
//! anything changed, then `git push`. Linking the repository to a remote is
//! done once by hand (`git init`, `git remote add origin …`, first push);
//! this only commits and pushes.
//!
//! Uses the system `git`, so your SSH key / credential helper apply. It never
//! asks for anything (no terminal prompts, SSH in batch mode), so closing the
//! app can't hang on a password prompt, and every step has a timeout. The
//! outcome is kept in the app data dir (`git-backup.json`) and shown in
//! Settings, so a failed push (e.g. the remote has commits from another
//! device) doesn't go unnoticed.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// What happened on the last backup.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Backup {
    /// Unix seconds.
    pub at: u64,
    pub ok: bool,
    /// A new commit was made (false: nothing had changed).
    pub committed: bool,
    pub pushed: bool,
    /// Files in the new commit.
    pub files: usize,
    /// One line for the UI: what happened, or what went wrong and how to fix it.
    pub message: String,
}

/// The vault's git setup, for Settings.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct RepoInfo {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub remote: Option<String>,
    pub upstream: Option<String>,
}

struct Out {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

impl Out {
    fn ok(&self) -> bool {
        self.code == Some(0)
    }
    fn first_error_line(&self) -> String {
        let text = if self.stderr.trim().is_empty() { &self.stdout } else { &self.stderr };
        text.lines()
            .map(str::trim)
            .find(|l| !l.is_empty() && !l.starts_with("hint:"))
            .unwrap_or("git failed")
            .to_string()
    }
}

/// Runs `git <args>` in `dir` without any prompts, killing it after `timeout`.
fn git(dir: &Path, args: &[&str], timeout: Duration) -> Out {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("LC_ALL", "C");
    if std::env::var_os("GIT_SSH_COMMAND").is_none() {
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o ConnectTimeout=15");
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Out { code: None, stdout: String::new(), stderr: format!("couldn't run git: {e} (is git installed?)") },
    };
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                let mut stderr = String::new();
                if let Some(mut o) = child.stdout.take() {
                    let _ = o.read_to_string(&mut stdout);
                }
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_string(&mut stderr);
                }
                return Out { code: status.code(), stdout, stderr };
            }
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Out { code: None, stdout: String::new(), stderr: format!("git {} took longer than {}s", args.first().unwrap_or(&""), timeout.as_secs()) };
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Out { code: None, stdout: String::new(), stderr: e.to_string() },
        }
    }
}

const QUICK: Duration = Duration::from_secs(30);
const PUSH: Duration = Duration::from_secs(90);

fn trimmed(o: Out) -> Option<String> {
    o.ok().then(|| o.stdout.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn repo_info(vault: &Path) -> RepoInfo {
    if !git(vault, &["rev-parse", "--is-inside-work-tree"], QUICK).ok() {
        return RepoInfo::default();
    }
    let branch = trimmed(git(vault, &["symbolic-ref", "--short", "-q", "HEAD"], QUICK));
    let upstream = trimmed(git(vault, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], QUICK));
    let remote_name = upstream.as_deref().and_then(|u| u.split('/').next()).map(str::to_string).or_else(|| {
        let remotes = trimmed(git(vault, &["remote"], QUICK))?;
        let names: Vec<&str> = remotes.lines().collect();
        names.iter().find(|r| **r == "origin").or(names.first()).map(|s| s.to_string())
    });
    let remote = remote_name.and_then(|r| trimmed(git(vault, &["remote", "get-url", &r], QUICK)));
    RepoInfo { is_repo: true, branch, remote, upstream }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn host() -> String {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "this computer".into())
}

/// Commits everything in the vault and pushes. Safe to call when nothing changed.
pub fn backup(vault: &Path) -> Backup {
    let mut b = Backup { at: now(), ..Default::default() };
    // (b goes last so the message can still read it)
    let done = |ok: bool, msg: String, mut b: Backup| {
        b.ok = ok;
        b.message = msg;
        b
    };
    if !vault.is_dir() {
        return done(false, format!("vault folder {} is missing", vault.display()), b);
    }
    if !git(vault, &["rev-parse", "--is-inside-work-tree"], QUICK).ok() {
        return done(false, "the vault folder isn't a git repository (run `git init` there and add a remote)".into(), b);
    }
    // a merge or rebase left half-done: don't touch it
    let git_dir = trimmed(git(vault, &["rev-parse", "--git-dir"], QUICK)).unwrap_or_else(|| ".git".into());
    let git_dir = vault.join(git_dir);
    for busy in ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"] {
        if git_dir.join(busy).exists() {
            return done(false, "a git merge or rebase is in progress in the vault; finish it in a terminal".into(), b);
        }
    }

    // stage everything under the vault folder (it may be a subfolder of a bigger repo)
    let add = git(vault, &["add", "-A", "--", "."], QUICK);
    if !add.ok() {
        return done(false, format!("git add failed: {}", add.first_error_line()), b);
    }
    let staged = git(vault, &["diff", "--cached", "--name-only", "--", "."], QUICK);
    b.files = staged.stdout.lines().filter(|l| !l.trim().is_empty()).count();
    if b.files > 0 {
        let msg = format!("Vault backup from {}: {} file{} changed", host(), b.files, if b.files == 1 { "" } else { "s" });
        let commit = git(vault, &["commit", "-q", "-m", &msg, "--", "."], QUICK);
        if !commit.ok() {
            let why = commit.first_error_line();
            let hint = if why.contains("user.email") || why.contains("Please tell me who you are") || why.contains("identity") {
                " (set it once: git config --global user.name \"…\" and user.email \"…\")"
            } else {
                ""
            };
            return done(false, format!("git commit failed: {why}{hint}"), b);
        }
        b.committed = true;
    }

    // push: to the upstream if there is one, else set it up on the first remote
    let info = repo_info(vault);
    let Some(branch) = info.branch.clone() else {
        return done(false, format!("{} but not pushed: HEAD isn't on a branch", if b.committed { "committed" } else { "nothing to commit" }), b);
    };
    let push = if info.upstream.is_some() {
        let ahead = trimmed(git(vault, &["rev-list", "--count", "@{u}..HEAD"], QUICK)).and_then(|n| n.parse::<u64>().ok()).unwrap_or(1);
        if ahead == 0 {
            return done(true, if b.committed { "committed; already up to date".into() } else { "nothing changed".into() }, b);
        }
        git(vault, &["push", "-q"], PUSH)
    } else {
        let remotes = trimmed(git(vault, &["remote"], QUICK)).unwrap_or_default();
        let names: Vec<&str> = remotes.lines().collect();
        let Some(remote) = names.iter().find(|r| **r == "origin").or(names.first()).map(|s| s.to_string()) else {
            let what = if b.committed { format!("committed {} file{}", b.files, if b.files == 1 { "" } else { "s" }) } else { "nothing changed".into() };
            return done(false, format!("{what}, but there's no remote to push to (git remote add origin <url>)"), b);
        };
        git(vault, &["push", "-q", "-u", &remote, &branch], PUSH)
    };
    if !push.ok() {
        let why = push.first_error_line();
        let all = format!("{} {}", push.stderr, push.stdout);
        let hint = if all.contains("non-fast-forward") || all.contains("fetch first") || all.contains("rejected") {
            " The remote has changes this computer doesn't have (from another device?): run `git pull` in the vault, then it pushes again."
        } else if all.contains("Permission denied") || all.contains("Authentication failed") || all.contains("could not read Username") || all.contains("terminal prompts disabled") {
            " Check that git can push without asking for a password (SSH key loaded, or a credential helper)."
        } else if all.contains("Could not resolve host") || all.contains("timed out") || all.contains("took longer") {
            " No connection? It'll push next time."
        } else {
            ""
        };
        let what = if b.committed { "committed, but the push failed" } else { "the push failed" };
        return done(false, format!("{what}: {why}.{hint}"), b);
    }
    b.pushed = true;
    let what = if b.committed { format!("committed {} file{} and pushed", b.files, if b.files == 1 { "" } else { "s" }) } else { "pushed earlier commits".into() };
    done(true, what, b)
}

// ---------------------------------------------------------------- last result

pub fn load_last(file: &Path) -> Option<Backup> {
    std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok())
}

pub fn save_last(file: &Path, b: &Backup) {
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(b) {
        let _ = crate::vault::write_atomic(file, &text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("brain-git-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn run(dir: &Path, args: &[&str]) -> String {
        let o = git(dir, args, QUICK);
        assert!(o.ok(), "git {args:?}: {}", o.stderr);
        o.stdout
    }
    // a vault repo with an identity and a bare "GitHub" remote next to it
    fn setup(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = tmp(tag);
        let remote = root.join("remote.git");
        let vault = root.join("vault");
        fs::create_dir_all(&vault).unwrap();
        run(&root, &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
        run(&vault, &["init", "-q", "-b", "main"]);
        run(&vault, &["config", "user.name", "Test"]);
        run(&vault, &["config", "user.email", "test@example.com"]);
        run(&vault, &["config", "commit.gpgsign", "false"]);
        (root, vault, remote)
    }
    fn remote_files(remote: &Path) -> String {
        run(remote, &["ls-tree", "-r", "--name-only", "main"])
    }

    #[test]
    fn not_a_repo_is_reported_not_fatal() {
        let d = tmp("norepo");
        // keep git from finding a repo above the temp dir
        let b = git(&d, &["rev-parse", "--is-inside-work-tree"], QUICK);
        if b.ok() {
            return; // temp dir happens to be inside a repo on this machine
        }
        let r = backup(&d);
        assert!(!r.ok && r.message.contains("isn't a git repository"), "{r:?}");
        assert!(!repo_info(&d).is_repo);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn first_backup_sets_upstream_then_only_changes_are_committed() {
        let (root, vault, remote) = setup("push");
        run(&vault, &["remote", "add", "origin", remote.to_str().unwrap()]);
        fs::create_dir_all(vault.join("Coding Club")).unwrap();
        fs::write(vault.join("Coding Club/CTF.md"), "notes").unwrap();
        fs::write(vault.join("Welcome.md"), "hi").unwrap();

        let r = backup(&vault);
        assert!(r.ok && r.committed && r.pushed && r.files == 2, "{r:?}");
        assert_eq!(remote_files(&remote), "Coding Club/CTF.md\nWelcome.md\n");
        let info = repo_info(&vault);
        assert_eq!((info.branch.as_deref(), info.upstream.as_deref()), (Some("main"), Some("origin/main")));
        assert!(info.remote.unwrap().ends_with("remote.git"));

        // nothing changed: no commit, no push
        let r = backup(&vault);
        assert!(r.ok && !r.committed && !r.pushed, "{r:?}");
        assert_eq!(r.message, "nothing changed");

        // an edit and a delete
        fs::write(vault.join("Welcome.md"), "hi again").unwrap();
        fs::remove_file(vault.join("Coding Club/CTF.md")).unwrap();
        let r = backup(&vault);
        assert!(r.ok && r.committed && r.pushed && r.files == 2, "{r:?}");
        assert_eq!(remote_files(&remote), "Welcome.md\n");
        let log = run(&remote, &["log", "--format=%s", "main"]);
        assert!(log.lines().next().unwrap().starts_with("Vault backup from "), "{log}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn no_remote_commits_and_says_so() {
        let (root, vault, _) = setup("noremote");
        fs::write(vault.join("a.md"), "x").unwrap();
        let r = backup(&vault);
        assert!(!r.ok && r.committed && !r.pushed, "{r:?}");
        assert!(r.message.contains("no remote"), "{}", r.message);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn diverged_remote_is_explained_and_nothing_is_lost() {
        let (root, vault, remote) = setup("diverged");
        run(&vault, &["remote", "add", "origin", remote.to_str().unwrap()]);
        fs::write(vault.join("a.md"), "1").unwrap();
        assert!(backup(&vault).pushed);
        // another device pushes a commit
        let other = root.join("other");
        run(&root, &["clone", "-q", remote.to_str().unwrap(), other.to_str().unwrap()]);
        run(&other, &["config", "user.name", "Other"]);
        run(&other, &["config", "user.email", "o@example.com"]);
        fs::write(other.join("b.md"), "from laptop").unwrap();
        run(&other, &["add", "."]);
        run(&other, &["commit", "-q", "-m", "laptop"]);
        run(&other, &["push", "-q"]);
        // this device edits too: commit works, push is rejected with a clear hint
        fs::write(vault.join("a.md"), "2").unwrap();
        let r = backup(&vault);
        assert!(!r.ok && r.committed && !r.pushed, "{r:?}");
        assert!(r.message.contains("git pull"), "{}", r.message);
        // after the user pulls, the next backup pushes the waiting commit
        run(&vault, &["pull", "-q", "--no-rebase", "--no-edit"]);
        let r = backup(&vault);
        assert!(r.ok && r.pushed, "{r:?}");
        assert!(remote_files(&remote).contains("b.md"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn half_done_merge_is_left_alone() {
        let (root, vault, _) = setup("merge");
        fs::write(vault.join("a.md"), "x").unwrap();
        run(&vault, &["add", "."]);
        run(&vault, &["commit", "-q", "-m", "first"]);
        fs::write(vault.join(".git/MERGE_HEAD"), "0000000000000000000000000000000000000000\n").unwrap();
        fs::write(vault.join("a.md"), "changed").unwrap();
        let r = backup(&vault);
        assert!(!r.ok && !r.committed && r.message.contains("merge or rebase"), "{r:?}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn last_result_round_trips() {
        let d = tmp("last");
        let f = d.join("git-backup.json");
        assert!(load_last(&f).is_none());
        let b = Backup { at: 5, ok: true, committed: true, pushed: true, files: 3, message: "ok".into() };
        save_last(&f, &b);
        assert_eq!(load_last(&f), Some(b));
        let _ = fs::remove_dir_all(d);
    }
}
