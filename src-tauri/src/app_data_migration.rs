//! One-time import into the fork's independent data directory. Legacy data is
//! never deleted; a verified private snapshot is kept before publishing files.
use crate::error::AppError;
use rusqlite::{
    backup::{Backup, StepResult},
    Connection, OpenFlags,
};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const LEGACY_DIR: &str = ".cc-switch";
const LEGACY_DB: &str = "cc-switch.db";
const DATABASE: &str = "codex-switch.db";
const MARKER: &str = "brand-migration.json";

pub(crate) fn default_data_dir(home: &Path, preview: bool) -> PathBuf {
    if preview {
        home.to_path_buf()
    } else {
        home.join(".codex-switch")
    }
}

fn legacy_data_dir(home: &Path, preview: bool, historical_home: Option<&Path>) -> PathBuf {
    let source = home.join(LEGACY_DIR);
    // Older Windows builds could have written under a Git/MSYS HOME. This
    // location is only an import source, never a current runtime data root.
    if !preview && !source.join(LEGACY_DB).exists() {
        if let Some(historical_home) = historical_home.filter(|path| path.is_absolute()) {
            let historical = historical_home.join(LEGACY_DIR);
            if historical.join(LEGACY_DB).exists() {
                return historical;
            }
        }
    }
    source
}

fn private_dir(path: &Path) -> Result<(), AppError> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(AppError::Config(format!(
            "Migration destination is a symlink: {}",
            path.display()
        )));
    }
    if path.exists() {
        return Ok(());
    }
    fs::create_dir_all(path).map_err(|e| AppError::io(path, e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|e| AppError::io(path, e))?;
    }
    Ok(())
}

fn copy_file_new(source: &Path, destination: &Path) -> Result<(), AppError> {
    let parent = destination
        .parent()
        .ok_or_else(|| AppError::Config("Invalid migration destination".into()))?;
    private_dir(parent)?;
    let mut output =
        tempfile::NamedTempFile::new_in(parent).map_err(|e| AppError::io(parent, e))?;
    let mut input = fs::File::open(source).map_err(|e| AppError::io(source, e))?;
    std::io::copy(&mut input, output.as_file_mut()).map_err(|e| AppError::io(destination, e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = input
            .metadata()
            .map_err(|e| AppError::io(source, e))?
            .permissions()
            .mode();
        output
            .as_file()
            .set_permissions(fs::Permissions::from_mode((mode & 0o700) | 0o600))
            .map_err(|e| AppError::io(destination, e))?;
    }
    output
        .as_file_mut()
        .sync_all()
        .map_err(|e| AppError::io(destination, e))?;
    output
        .persist_noclobber(destination)
        .map_err(|e| AppError::io(destination, e.error))?;
    Ok(())
}

fn snapshot_database(source: &Path, destination: &Path) -> Result<(), AppError> {
    let input = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| AppError::Database(e.to_string()))?;
    input
        .busy_timeout(Duration::from_secs(2))
        .map_err(|e| AppError::Database(e.to_string()))?;
    let mut output =
        Connection::open(destination).map_err(|e| AppError::Database(e.to_string()))?;
    let backup = Backup::new(&input, &mut output).map_err(|e| AppError::Database(e.to_string()))?;
    let started = Instant::now();
    loop {
        match backup
            .step(256)
            .map_err(|e| AppError::Database(e.to_string()))?
        {
            StepResult::Done => break,
            StepResult::More => {}
            StepResult::Busy | StepResult::Locked => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                return Err(AppError::Database(
                    "Unexpected migration snapshot state".into(),
                ))
            }
        }
        if started.elapsed() > Duration::from_secs(10) {
            return Err(AppError::Database(
                "Migration snapshot timed out; legacy data was left intact".into(),
            ));
        }
    }
    drop(backup);
    let integrity: String = output
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| AppError::Database(e.to_string()))?;
    if integrity != "ok" {
        return Err(AppError::Database(
            "Migration snapshot integrity check failed".into(),
        ));
    }
    output
        .close()
        .map_err(|(_, e)| AppError::Database(e.to_string()))?;
    // Windows FlushFileBuffers requires a writable handle to the new snapshot.
    fs::OpenOptions::new()
        .write(true)
        .open(destination)
        .and_then(|file| file.sync_all())
        .map_err(|e| AppError::io(destination, e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(destination, fs::Permissions::from_mode(0o600))
            .map_err(|e| AppError::io(destination, e))?;
    }
    Ok(())
}

fn copy_symlink(
    source: &Path,
    destination: &Path,
    old_root: &Path,
    new_root: &Path,
) -> Result<(), AppError> {
    let original = fs::read_link(source).map_err(|e| AppError::io(source, e))?;
    let resolved = crate::config::normalize_path_lexically(&if original.is_absolute() {
        original.clone()
    } else {
        source.parent().unwrap().join(&original)
    });
    let target = resolved
        .strip_prefix(old_root)
        .map(|rel| {
            new_root.join(if rel == Path::new(LEGACY_DB) {
                Path::new(DATABASE)
            } else {
                rel
            })
        })
        .unwrap_or(original.clone());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, destination)
            .map_err(|e| AppError::io(destination, e))?;
    }
    #[cfg(windows)]
    {
        if source.is_dir() {
            std::os::windows::fs::symlink_dir(target, destination)
        } else {
            std::os::windows::fs::symlink_file(target, destination)
        }
        .map_err(|e| AppError::io(destination, e))?;
    }
    Ok(())
}

fn copy_snapshot(
    source: &Path,
    target: &Path,
    old_root: &Path,
    new_root: &Path,
) -> Result<(), AppError> {
    private_dir(target)?;
    for entry in fs::read_dir(source).map_err(|e| AppError::io(source, e))? {
        let entry = entry.map_err(|e| AppError::io(source, e))?;
        let path = entry.path();
        let name = entry.file_name();
        let name_text = name.to_string_lossy().into_owned();
        let root = source == old_root;
        if root
            && [
                "cc-switch.db-wal",
                "cc-switch.db-shm",
                "cc-switch.db-journal",
            ]
            .contains(&name_text.as_str())
        {
            continue;
        }
        let destination = target.join(if root && name_text == LEGACY_DB {
            DATABASE.into()
        } else {
            name
        });
        let kind = entry.file_type().map_err(|e| AppError::io(&path, e))?;
        if kind.is_symlink() {
            if root && name_text == LEGACY_DB {
                return Err(AppError::Config(
                    "Legacy database is a symlink; automatic import was skipped".into(),
                ));
            }
            copy_symlink(&path, &destination, old_root, new_root)?;
        } else if kind.is_dir() {
            copy_snapshot(&path, &destination, old_root, new_root)?;
        } else if kind.is_file() {
            if root && name_text == LEGACY_DB {
                snapshot_database(&path, &destination)?;
            } else {
                copy_file_new(&path, &destination)?;
            }
        } else {
            return Err(AppError::Config(format!(
                "Unsupported legacy data entry: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

fn enumerate_files(
    source: &Path,
    target: &Path,
    entries: &mut Vec<(PathBuf, PathBuf)>,
) -> Result<(), AppError> {
    for item in fs::read_dir(source).map_err(|e| AppError::io(source, e))? {
        let item = item.map_err(|e| AppError::io(source, e))?;
        let destination = target.join(item.file_name());
        if item
            .file_type()
            .map_err(|e| AppError::io(item.path(), e))?
            .is_dir()
        {
            enumerate_files(&item.path(), &destination, entries)?;
        } else {
            entries.push((item.path(), destination));
        }
    }
    Ok(())
}

fn stage_device_data(device: &Path, payload: &Path, target: &Path) -> Result<(), AppError> {
    if !device.exists() {
        return Ok(());
    }
    if fs::symlink_metadata(device).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(AppError::Config(
            "Legacy device directory is a symlink".into(),
        ));
    }
    let mut paths = vec![
        PathBuf::from("settings.json"),
        PathBuf::from("live-state.json"),
        PathBuf::from("codex-login-stash.json"),
        PathBuf::from("backups/live-first-write"),
        PathBuf::from("backups/proxy-live-backup"),
    ];
    let backups = device.join("backups");
    if fs::symlink_metadata(&backups).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(AppError::Config(
            "Legacy device backups directory is a symlink".into(),
        ));
    }
    if backups.is_dir() {
        for entry in fs::read_dir(&backups).map_err(|e| AppError::io(&backups, e))? {
            let entry = entry.map_err(|e| AppError::io(&backups, e))?;
            let name = entry.file_name();
            let text = name.to_string_lossy();
            if text.starts_with("env-backup-") && text.ends_with(".json") {
                paths.push(PathBuf::from("backups").join(name));
            }
        }
    }
    for relative in paths {
        let from = device.join(&relative);
        let kind = match fs::symlink_metadata(&from) {
            Ok(metadata) => metadata.file_type(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(AppError::io(&from, error)),
        };
        let to = payload.join(relative);
        if let Ok(metadata) = fs::symlink_metadata(&to) {
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                fs::remove_dir_all(&to).map_err(|e| AppError::io(&to, e))?;
            } else {
                fs::remove_file(&to).map_err(|e| AppError::io(&to, e))?;
            }
        }
        private_dir(to.parent().unwrap())?;
        if kind.is_symlink() {
            copy_symlink(&from, &to, device, target)?;
        } else if kind.is_dir() {
            copy_snapshot(&from, &to, device, target)?;
        } else if kind.is_file() {
            copy_file_new(&from, &to)?;
        } else {
            return Err(AppError::Config("Unsupported legacy device entry".into()));
        }
    }
    Ok(())
}

pub(crate) fn migrate_default_data(home: &Path, preview: bool) -> Result<bool, AppError> {
    #[cfg(windows)]
    let historical_home = if preview || std::env::var_os("CODEX_SWITCH_TEST_HOME").is_some() {
        None
    } else {
        std::env::var("HOME")
            .ok()
            .map(|value| PathBuf::from(value.trim()))
    };
    #[cfg(not(windows))]
    let historical_home: Option<PathBuf> = None;
    let source = legacy_data_dir(home, preview, historical_home.as_deref());
    migrate_data_from_source(home, preview, &source)
}

fn migrate_data_from_source(home: &Path, preview: bool, source: &Path) -> Result<bool, AppError> {
    let target = default_data_dir(home, preview);
    if fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(AppError::Config(
            "Application directory is a symlink; automatic import was skipped".into(),
        ));
    }
    if !source.exists() || target.join(MARKER).exists() || target.join(DATABASE).exists() {
        return Ok(false);
    }
    if fs::symlink_metadata(source)
        .map_err(|e| AppError::io(source, e))?
        .file_type()
        .is_symlink()
    {
        return Err(AppError::Config(
            "Legacy application directory is a symlink; automatic import was skipped".into(),
        ));
    }
    let parent = target
        .parent()
        .ok_or_else(|| AppError::Config("Invalid data directory".into()))?;
    private_dir(parent)?;
    let staging = tempfile::Builder::new()
        .prefix(".codex-switch-migration-")
        .tempdir_in(parent)
        .map_err(|e| AppError::io(parent, e))?;
    let payload = staging.path().join("data");
    copy_snapshot(source, &payload, source, &target)?;
    let device = home.join(LEGACY_DIR);
    if source != device {
        stage_device_data(&device, &payload, &target)?;
    }
    let mut entries = Vec::new();
    enumerate_files(&payload, &target, &mut entries)?;
    for (_, destination) in &entries {
        let mut parent = destination.parent();
        while let Some(path) = parent {
            if path == target.parent().unwrap() {
                break;
            }
            if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err(AppError::Config(format!(
                    "Migration destination contains a symlink: {}",
                    path.display()
                )));
            }
            parent = path.parent();
        }
        if fs::symlink_metadata(destination).is_ok() {
            return Err(AppError::Config(format!(
                "Migration will not overwrite existing data: {}",
                destination.display()
            )));
        }
    }
    private_dir(&target)?;
    let backup_parent = target.join("backups");
    private_dir(&backup_parent)?;
    let backup_holder = tempfile::Builder::new()
        .prefix("brand-migration-")
        .tempdir_in(&backup_parent)
        .map_err(|e| AppError::io(&backup_parent, e))?;
    let backup_dir = backup_holder.path().join("data");
    fs::rename(&payload, &backup_dir).map_err(|e| AppError::io(&backup_dir, e))?;
    entries.clear();
    enumerate_files(&backup_dir, &target, &mut entries)?;
    // Internal links in the recovery snapshot must keep referring to that
    // snapshot, even after the active data is edited or removed.
    for (from, _) in &entries {
        if fs::symlink_metadata(from)
            .map_err(|e| AppError::io(from, e))?
            .file_type()
            .is_symlink()
        {
            let link = fs::read_link(from).map_err(|e| AppError::io(from, e))?;
            if let Ok(relative) = link.strip_prefix(&target) {
                fs::remove_file(from).map_err(|e| AppError::io(from, e))?;
                #[cfg(unix)]
                std::os::unix::fs::symlink(backup_dir.join(relative), from)
                    .map_err(|e| AppError::io(from, e))?;
                #[cfg(windows)]
                {
                    let original = source.join(from.strip_prefix(&backup_dir).unwrap());
                    if original.is_dir() {
                        std::os::windows::fs::symlink_dir(backup_dir.join(relative), from)
                    } else {
                        std::os::windows::fs::symlink_file(backup_dir.join(relative), from)
                    }
                    .map_err(|e| AppError::io(from, e))?;
                }
            }
        }
    }
    let backup_path = backup_holder.keep();
    // The database is published last, after all its accompanying data.
    entries.sort_by_key(|(_, to)| to.file_name().is_some_and(|name| name == DATABASE));
    let mut published = Vec::new();
    let outcome: Result<(), AppError> = (|| {
        for (from, to) in &entries {
            private_dir(to.parent().unwrap())?;
            if fs::symlink_metadata(from)
                .map_err(|e| AppError::io(from, e))?
                .file_type()
                .is_symlink()
            {
                copy_symlink(from, to, &backup_dir, &target)?;
            } else {
                copy_file_new(from, to)?;
            }
            published.push(to.clone());
        }
        let record = serde_json::json!({"version":1,"source":source,"deviceSource":device,"backup":backup_path});
        let mut file =
            tempfile::NamedTempFile::new_in(&target).map_err(|e| AppError::io(&target, e))?;
        let record = serde_json::to_string_pretty(&record)
            .map_err(|e| AppError::Config(format!("Unable to record data migration: {e}")))?;
        file.write_all(record.as_bytes())
            .map_err(|e| AppError::io(&target, e))?;
        file.as_file_mut()
            .sync_all()
            .map_err(|e| AppError::io(&target, e))?;
        file.persist_noclobber(target.join(MARKER))
            .map_err(|e| AppError::io(target.join(MARKER), e.error))?;
        Ok(())
    })();
    if outcome.is_err() {
        for path in published.iter().rev() {
            let _ = fs::remove_file(path);
        }
    }
    outcome?;
    Ok(true)
}

/// User-selected directories retain their location; only the owned DB filename changes.
pub(crate) fn migrate_custom_database(directory: &Path) -> Result<bool, AppError> {
    let source = directory.join(LEGACY_DB);
    let target = directory.join(DATABASE);
    if !source.exists() || target.exists() {
        return Ok(false);
    }
    if fs::symlink_metadata(&source)
        .map_err(|e| AppError::io(&source, e))?
        .file_type()
        .is_symlink()
    {
        return Err(AppError::Config(
            "Legacy database is a symlink; automatic import was skipped".into(),
        ));
    }
    let temporary =
        tempfile::NamedTempFile::new_in(directory).map_err(|e| AppError::io(directory, e))?;
    snapshot_database(&source, temporary.path())?;
    let backup_dir = directory.join("backups");
    private_dir(&backup_dir)?;
    let mut backup = tempfile::Builder::new()
        .prefix("brand-migration-")
        .suffix(".db")
        .tempfile_in(&backup_dir)
        .map_err(|e| AppError::io(&backup_dir, e))?;
    let mut input =
        fs::File::open(temporary.path()).map_err(|e| AppError::io(temporary.path(), e))?;
    std::io::copy(&mut input, backup.as_file_mut()).map_err(|e| AppError::io(backup.path(), e))?;
    backup
        .as_file_mut()
        .sync_all()
        .map_err(|e| AppError::io(backup.path(), e))?;
    backup
        .keep()
        .map_err(|e| AppError::io(&backup_dir, e.error))?;
    temporary
        .persist_noclobber(&target)
        .map_err(|e| AppError::io(&target, e.error))?;
    Ok(true)
}

/// Keep only application-owned directory preferences, never webview/login storage.
pub(crate) fn migrate_platform_preferences(
    directory: &Path,
    preview: bool,
) -> Result<(), AppError> {
    if preview {
        return Ok(());
    }
    let Some(parent) = directory.parent() else {
        return Ok(());
    };
    let source = parent.join("com.ccswitch.desktop").join("app_paths.json");
    let target = directory.join("app_paths.json");
    if source.is_file() && !target.exists() {
        private_dir(directory)?;
        copy_file_new(&source, &target)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy(home: &Path) -> PathBuf {
        let path = home.join(LEGACY_DIR);
        fs::create_dir_all(path.join("codex-oauth")).unwrap();
        fs::write(
            path.join("model-pricing.json"),
            br#"{"overrides":{"test":{"input":1.25}}}"#,
        )
        .unwrap();
        fs::write(
            path.join("codex-oauth/account.json"),
            b"synthetic-account-only",
        )
        .unwrap();
        fs::write(path.join("settings.json"), br#"{"language":"zh"}"#).unwrap();
        path
    }

    fn database(path: &Path, wal: bool) -> Connection {
        let connection = Connection::open(path).unwrap();
        if wal {
            connection
                .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
                .unwrap();
        }
        connection.execute_batch("CREATE TABLE migration_evidence(value TEXT); INSERT INTO migration_evidence VALUES('preserved');").unwrap();
        connection
    }

    #[test]
    fn canonical_roots_keep_preview_flat_and_separate() {
        assert_eq!(
            default_data_dir(Path::new("/synthetic/home"), false),
            PathBuf::from("/synthetic/home/.codex-switch")
        );
        assert_eq!(
            default_data_dir(Path::new("/synthetic/preview"), true),
            PathBuf::from("/synthetic/preview")
        );
    }

    #[test]
    fn historical_windows_home_is_only_an_import_candidate() {
        let real = tempfile::tempdir().unwrap();
        let historical = tempfile::tempdir().unwrap();
        let source = legacy(historical.path());
        let _database = database(&source.join(LEGACY_DB), false);
        assert_eq!(
            legacy_data_dir(real.path(), false, Some(historical.path())),
            source
        );
        assert_eq!(
            legacy_data_dir(real.path(), true, Some(historical.path())),
            real.path().join(LEGACY_DIR)
        );
        let real_source = legacy(real.path());
        let _real_database = database(&real_source.join(LEGACY_DB), false);
        assert_eq!(
            legacy_data_dir(real.path(), false, Some(historical.path())),
            real_source
        );
        assert_eq!(
            default_data_dir(real.path(), false),
            real.path().join(".codex-switch")
        );
    }

    #[test]
    fn historical_database_import_keeps_real_home_device_state() {
        let real = tempfile::tempdir().unwrap();
        let historical = tempfile::tempdir().unwrap();
        let source = legacy(historical.path());
        let _database = database(&source.join(LEGACY_DB), false);
        let device = legacy(real.path());
        fs::write(device.join("settings.json"), b"real-device-settings").unwrap();
        fs::write(device.join("live-state.json"), b"real-device-state").unwrap();
        fs::write(device.join("codex-login-stash.json"), b"real-device-stash").unwrap();
        fs::create_dir_all(device.join("backups/live-first-write")).unwrap();
        fs::write(
            device.join("backups/live-first-write/config"),
            b"real-first-write",
        )
        .unwrap();
        fs::write(device.join("backups/env-backup-test.json"), b"real-env").unwrap();
        fs::write(
            device.join("model-pricing.json"),
            b"not-the-database-source",
        )
        .unwrap();
        migrate_data_from_source(real.path(), false, &source).unwrap();
        let target = default_data_dir(real.path(), false);
        assert_eq!(
            fs::read(target.join("settings.json")).unwrap(),
            b"real-device-settings"
        );
        assert_eq!(
            fs::read(target.join("live-state.json")).unwrap(),
            b"real-device-state"
        );
        assert_eq!(
            fs::read(target.join("codex-login-stash.json")).unwrap(),
            b"real-device-stash"
        );
        assert_eq!(
            fs::read(target.join("backups/live-first-write/config")).unwrap(),
            b"real-first-write"
        );
        assert_eq!(
            fs::read(target.join("backups/env-backup-test.json")).unwrap(),
            b"real-env"
        );
        assert_eq!(
            fs::read(target.join("model-pricing.json")).unwrap(),
            fs::read(source.join("model-pricing.json")).unwrap()
        );
        assert!(target.join(DATABASE).exists());
    }

    #[test]
    fn imports_regular_data_and_keeps_an_independent_private_backup() {
        let fixture = tempfile::tempdir().unwrap();
        let source = legacy(fixture.path());
        let _connection = database(&source.join(LEGACY_DB), false);
        assert!(migrate_default_data(fixture.path(), false).unwrap());
        let target = default_data_dir(fixture.path(), false);
        assert_eq!(
            fs::read(target.join("model-pricing.json")).unwrap(),
            fs::read(source.join("model-pricing.json")).unwrap()
        );
        assert_eq!(
            fs::read(target.join("codex-oauth/account.json")).unwrap(),
            b"synthetic-account-only"
        );
        let record: serde_json::Value =
            serde_json::from_slice(&fs::read(target.join(MARKER)).unwrap()).unwrap();
        let backup = PathBuf::from(record["backup"].as_str().unwrap()).join("data");
        let current = Connection::open(target.join(DATABASE)).unwrap();
        current
            .execute("UPDATE migration_evidence SET value='changed'", [])
            .unwrap();
        let saved = Connection::open(backup.join(DATABASE)).unwrap();
        assert_eq!(
            saved
                .query_row("SELECT value FROM migration_evidence", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "preserved"
        );
        assert!(source.join(LEGACY_DB).exists());
        assert!(!migrate_default_data(fixture.path(), false).unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(target.join(DATABASE))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(target.join("codex-oauth/account.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn copies_committed_wal_rows_without_copying_journal_files() {
        let fixture = tempfile::tempdir().unwrap();
        let source = legacy(fixture.path());
        let _open_writer = database(&source.join(LEGACY_DB), true);
        assert!(source.join("cc-switch.db-wal").exists());
        migrate_default_data(fixture.path(), false).unwrap();
        let target = default_data_dir(fixture.path(), false);
        let copy = Connection::open(target.join(DATABASE)).unwrap();
        assert_eq!(
            copy.query_row("SELECT value FROM migration_evidence", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "preserved"
        );
        assert!(!target.join("cc-switch.db-wal").exists());
        assert!(!target.join("cc-switch.db-shm").exists());
    }

    #[test]
    fn preview_import_never_reads_regular_home_and_keeps_client_files() {
        let fixture = tempfile::tempdir().unwrap();
        let preview = fixture.path().join(".codex-switch-preview");
        fs::create_dir_all(preview.join(".codex")).unwrap();
        fs::write(preview.join(".codex/auth.json"), b"synthetic-native-login").unwrap();
        let regular = legacy(fixture.path());
        fs::write(regular.join("model-pricing.json"), b"regular-pricing").unwrap();
        let source = legacy(&preview);
        migrate_default_data(&preview, true).unwrap();
        assert_eq!(
            fs::read(preview.join("model-pricing.json")).unwrap(),
            fs::read(source.join("model-pricing.json")).unwrap()
        );
        assert_eq!(
            fs::read(preview.join(".codex/auth.json")).unwrap(),
            b"synthetic-native-login"
        );
        assert!(source.exists());
        assert!(!preview.join(".codex-switch").exists());
    }

    #[test]
    fn established_new_database_wins_over_legacy_data() {
        let fixture = tempfile::tempdir().unwrap();
        legacy(fixture.path());
        let target = default_data_dir(fixture.path(), false);
        fs::create_dir(&target).unwrap();
        let _database = database(&target.join(DATABASE), false);
        assert!(!migrate_default_data(fixture.path(), false).unwrap());
        assert!(!target.join("model-pricing.json").exists());
    }

    #[test]
    fn existing_target_file_is_never_overwritten_or_partially_imported() {
        let fixture = tempfile::tempdir().unwrap();
        let source = legacy(fixture.path());
        let _database = database(&source.join(LEGACY_DB), false);
        let target = default_data_dir(fixture.path(), false);
        fs::create_dir(&target).unwrap();
        fs::write(target.join("model-pricing.json"), b"new-pricing").unwrap();
        assert!(migrate_default_data(fixture.path(), false).is_err());
        assert_eq!(
            fs::read(target.join("model-pricing.json")).unwrap(),
            b"new-pricing"
        );
        assert!(!target.join(DATABASE).exists());
        assert!(!target.join(MARKER).exists());
    }

    #[test]
    fn invalid_database_leaves_source_and_target_untouched() {
        let fixture = tempfile::tempdir().unwrap();
        let source = legacy(fixture.path());
        fs::write(source.join(LEGACY_DB), b"not SQLite").unwrap();
        assert!(migrate_default_data(fixture.path(), false).is_err());
        assert_eq!(fs::read(source.join(LEGACY_DB)).unwrap(), b"not SQLite");
        assert!(!default_data_dir(fixture.path(), false)
            .join(DATABASE)
            .exists());
    }

    #[test]
    fn custom_database_keeps_its_location_and_original_file() {
        let fixture = tempfile::tempdir().unwrap();
        let _source = database(&fixture.path().join(LEGACY_DB), true);
        assert!(migrate_custom_database(fixture.path()).unwrap());
        assert!(fixture.path().join(LEGACY_DB).exists());
        assert!(fixture.path().join(DATABASE).exists());
        assert!(!migrate_custom_database(fixture.path()).unwrap());
        assert_eq!(
            fs::read_dir(fixture.path().join("backups"))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn platform_preferences_preserve_custom_override_without_touching_preview() {
        let fixture = tempfile::tempdir().unwrap();
        let old = fixture.path().join("com.ccswitch.desktop");
        fs::create_dir(&old).unwrap();
        fs::write(
            old.join("app_paths.json"),
            br#"{"app_config_dir_override":"/synthetic/custom"}"#,
        )
        .unwrap();
        let new = fixture.path().join("com.codexswitch.desktop");
        migrate_platform_preferences(&new, false).unwrap();
        assert_eq!(
            fs::read(old.join("app_paths.json")).unwrap(),
            fs::read(new.join("app_paths.json")).unwrap()
        );
        let preview = fixture.path().join("com.codexswitch.preview");
        migrate_platform_preferences(&preview, true).unwrap();
        assert!(!preview.exists());
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_internal_links_stay_independent_from_active_data() {
        use std::os::unix::fs::symlink;
        let fixture = tempfile::tempdir().unwrap();
        let source = legacy(fixture.path());
        symlink(source.join("settings.json"), source.join("absolute-link")).unwrap();
        symlink("../.cc-switch/settings.json", source.join("relative-link")).unwrap();
        migrate_default_data(fixture.path(), false).unwrap();
        let target = default_data_dir(fixture.path(), false);
        let record: serde_json::Value =
            serde_json::from_slice(&fs::read(target.join(MARKER)).unwrap()).unwrap();
        let backup = PathBuf::from(record["backup"].as_str().unwrap()).join("data");
        let original = fs::read(source.join("settings.json")).unwrap();
        fs::write(target.join("settings.json"), b"updated-live-settings").unwrap();
        for name in ["absolute-link", "relative-link"] {
            assert_eq!(
                fs::read(target.join(name)).unwrap(),
                b"updated-live-settings"
            );
            assert_eq!(fs::read(backup.join(name)).unwrap(), original);
        }
    }

    #[cfg(unix)]
    #[test]
    fn database_symlinks_never_alias_an_external_database() {
        use std::os::unix::fs::symlink;
        let fixture = tempfile::tempdir().unwrap();
        let source = legacy(fixture.path());
        let external = tempfile::tempdir().unwrap();
        let external_db = external.path().join("private.db");
        let _database = database(&external_db, false);
        symlink(&external_db, source.join(LEGACY_DB)).unwrap();
        assert!(migrate_default_data(fixture.path(), false).is_err());
        assert!(!default_data_dir(fixture.path(), false)
            .join(DATABASE)
            .exists());
        assert!(migrate_custom_database(&source).is_err());
        assert!(!source.join(DATABASE).exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_followed_and_destination_escapes_are_rejected() {
        use std::os::unix::fs::symlink;
        let fixture = tempfile::tempdir().unwrap();
        let source = legacy(fixture.path());
        let external = tempfile::tempdir().unwrap();
        fs::write(external.path().join("private"), b"outside").unwrap();
        symlink(external.path(), source.join("linked")).unwrap();
        migrate_default_data(fixture.path(), false).unwrap();
        let target = default_data_dir(fixture.path(), false);
        assert!(fs::symlink_metadata(target.join("linked"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_link(target.join("linked")).unwrap(),
            external.path()
        );

        let another = tempfile::tempdir().unwrap();
        legacy(another.path());
        let target = default_data_dir(another.path(), false);
        fs::create_dir(&target).unwrap();
        symlink(external.path(), target.join("codex-oauth")).unwrap();
        assert!(migrate_default_data(another.path(), false).is_err());
        assert!(!external.path().join("account.json").exists());
    }
}
